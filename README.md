# Felt-1

We’re introducing Felt-1, the world’s first Isoneural Converter.

The Felt-1 self-improving multi-agentic system is capable of converting between any two formats while triggering the same fMRI neural response.

From creating captions for images that allow the viewer to experience the same feeling as seeing the image itself to creating a UI interface that evokes the vibes as a song that you listened to weeks ago, Felt-1 has applications across numerous disciplines including product design, accessibility, and more

## Commands

```bash
bun install
bun run setup:tribe
bun run check
bun run smoke
bun run smoke:tribe
```

`bun run smoke` currently verifies the scaffold entrypoint. `bun run smoke:tribe`
will need to be rewired after the new renderer pipeline is implemented. The
vendored TRIBE environment lives at `vendor/tribev2/.venv/bin/python`; first
real TRIBE runs download model weights into the ignored `vendor/tribev2/cache`
directory.
