#!/usr/bin/env python3
"""Local audio feature extraction — the offline half of the audio describer.

A hosted audio-LLM (Qwen) writes a fluent *perceptual* caption but is weak on
objective *musical* structure: in testing it called a clear C-major arpeggio a
"computer beep." This script supplies the structure the caption misses — tempo,
energy, brightness, and a rough key — with classic DSP (numpy + soundfile, no
librosa). It runs in well under a second on CPU, so it doubles as the fallback
when the hosted service is down.

Usage: python audio_features.py <audio-path>  ->  one line of JSON on stdout.

Output fields (all optional, omitted when not confidently estimable):
  tempoBpm, tempo (slow|medium|fast), energy (low|medium|high),
  brightness (dark|warm|bright), key (e.g. "C major"), durationSec.
"""

import json
import sys

import numpy as np
import soundfile as sf

FFT_SIZE = 2048
HOP = 512

# Pitch-class templates for major/minor key estimation (Krumhansl-Schmuckler).
MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)
PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def load_mono(path: str) -> tuple[np.ndarray, int]:
    audio, sr = sf.read(path, dtype="float64")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return audio, int(sr)


def stft_magnitudes(audio: np.ndarray) -> np.ndarray:
    window = np.hanning(FFT_SIZE)
    frames = []
    for start in range(0, max(1, len(audio) - FFT_SIZE), HOP):
        frame = audio[start : start + FFT_SIZE]
        if len(frame) < FFT_SIZE:
            break
        frames.append(np.abs(np.fft.rfft(frame * window)))
    if not frames:
        return np.zeros((0, FFT_SIZE // 2 + 1))
    return np.vstack(frames)


def estimate_tempo(mags: np.ndarray, sr: int) -> float:
    if mags.shape[0] < 4:
        return 0.0
    # Spectral-flux onset envelope, then autocorrelation peak in 50-200 BPM.
    flux = np.sum(np.maximum(0.0, np.diff(mags, axis=0)), axis=1)
    flux = flux - flux.mean()
    if not np.any(flux):
        return 0.0
    fps = sr / HOP
    autocorr = np.correlate(flux, flux, mode="full")[len(flux) - 1 :]
    lo = int(fps * 60 / 200)
    hi = int(fps * 60 / 50)
    if hi <= lo or hi >= len(autocorr):
        return 0.0
    lag = lo + int(np.argmax(autocorr[lo:hi]))
    return round(60 * fps / lag, 1) if lag else 0.0


def estimate_brightness(mags: np.ndarray, sr: int) -> float:
    if mags.shape[0] == 0:
        return 0.0
    freqs = np.fft.rfftfreq(FFT_SIZE, 1 / sr)
    weights = mags.sum(axis=0)
    total = weights.sum()
    return float((freqs * weights).sum() / total) if total else 0.0


def estimate_key(mags: np.ndarray, sr: int) -> str | None:
    if mags.shape[0] == 0:
        return None
    freqs = np.fft.rfftfreq(FFT_SIZE, 1 / sr)
    chroma = np.zeros(12)
    spectrum = mags.sum(axis=0)
    for freq, energy in zip(freqs, spectrum):
        if 55 <= freq <= 2000 and energy > 0:
            midi = 69 + 12 * np.log2(freq / 440.0)
            chroma[int(round(midi)) % 12] += energy
    if chroma.sum() == 0:
        return None
    chroma = chroma / chroma.sum()
    best_score = -np.inf
    best_key = None
    for shift in range(12):
        for profile, mode in ((MAJOR_PROFILE, "major"), (MINOR_PROFILE, "minor")):
            rotated = np.roll(profile, shift)
            score = float(np.corrcoef(chroma, rotated)[0, 1])
            if score > best_score:
                best_score = score
                best_key = f"{PITCH_CLASSES[shift]} {mode}"
    # Below this correlation the estimate is noise (e.g. a pure tone or noise).
    return best_key if best_score > 0.6 else None


def bucket_tempo(bpm: float) -> str | None:
    if bpm <= 0:
        return None
    if bpm < 90:
        return "slow"
    if bpm < 130:
        return "medium"
    return "fast"


def bucket_energy(rms: float) -> str:
    if rms < 0.05:
        return "low"
    if rms < 0.2:
        return "medium"
    return "high"


def bucket_brightness(centroid_hz: float) -> str | None:
    if centroid_hz <= 0:
        return None
    if centroid_hz < 500:
        return "dark"
    if centroid_hz < 2000:
        return "warm"
    return "bright"


def analyze(path: str) -> dict:
    audio, sr = load_mono(path)
    if len(audio) == 0:
        return {}
    mags = stft_magnitudes(audio)
    rms = float(np.sqrt(np.mean(audio**2)))
    bpm = estimate_tempo(mags, sr)
    centroid = estimate_brightness(mags, sr)

    result: dict = {"durationSec": round(len(audio) / sr, 2)}
    if bpm > 0:
        result["tempoBpm"] = bpm
    tempo = bucket_tempo(bpm)
    if tempo:
        result["tempo"] = tempo
    result["energy"] = bucket_energy(rms)
    brightness = bucket_brightness(centroid)
    if brightness:
        result["brightness"] = brightness
    key = estimate_key(mags, sr)
    if key:
        result["key"] = key
    return result


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: audio_features.py <audio-path>"}))
        return 2
    try:
        print(json.dumps(analyze(sys.argv[1])))
        return 0
    except Exception as error:  # noqa: BLE001 — surface any failure as JSON
        print(json.dumps({"error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
