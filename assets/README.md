# Artwork

The [main README](../README.md) holds the project title and subtitle as text. `readme-header.svg` contains the animated logo, adapts to light and dark backgrounds, and stops under reduced motion. The SVG is its editable source. Run `python3 assets/build-header.py` to validate it, or add `--source <approved.svg>` to copy a replacement.

`header-mark.svg` and `header-motion.css` provide an inline web mark. It animates when `.cf-interactive` is hovered or focused, or when the host adds `.is-active`. `.cf-loop` supplies a continuous loop. `mark.svg` follows the system colour scheme; the fixed light and dark marks and lockups suit an explicitly chosen background. Lockups contain the outlined Literata wordmark; its subset and licence are in `fonts/`.

Toolbar icons are transparent SVG and PNG files at 16, 32, 48 and 128 pixels, with a dark variant at each size. The extension ships the light PNGs and the adaptive `favicon.svg`.

The committed exports need no design tools. To regenerate marks, icons and the local proof sheet, supply the speech-tank source SVG and an existing package that provides `sharp`:

```sh
export CROSSFEED_SOURCE_SVG=/path/to/source-mark.svg
export CROSSFEED_SHARP_PACKAGE=/path/to/package-with-sharp/package.json
python3 assets/build.py
node assets/build-icons.mjs
node assets/build-preview.mjs
```

Builders write inside `assets/`. Previews and `proofs/` are ignored. Copy regenerated light PNGs and `favicon.svg` into `extension/icons/`; update the favicon data URI in `src/oauth.ts` if its source changes.

`chat-tools.png` and `chat-worker.png` are conversation-only crops of real ChatGPT trials. They omit the sidebar, account controls and other chat titles.
