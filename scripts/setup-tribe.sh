#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIBE_ROOT="$ROOT/vendor/tribev2"
VENV="$TRIBE_ROOT/.venv"

if [ ! -d "$TRIBE_ROOT/tribev2" ]; then
  echo "TRIBE source not found at $TRIBE_ROOT" >&2
  exit 1
fi

if [ -n "${PYTHON:-}" ]; then
  PYTHON_BIN="$PYTHON"
elif command -v python3.11 >/dev/null 2>&1; then
  PYTHON_BIN="python3.11"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
else
  echo "python3.11 or python3 is required." >&2
  exit 1
fi

"$PYTHON_BIN" -m venv "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install -e "$TRIBE_ROOT"
"$VENV/bin/python" -m pip install \
  exca==0.5.20 \
  transformers==4.57.6 \
  hf_transfer==0.1.9 \
  bitsandbytes==0.49.2 \
  accelerate==1.13.0

echo "TRIBE environment ready at $VENV"
