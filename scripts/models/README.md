# Model weights

Every weight file the app loads at runtime lives in `public/models/` (gitignored) and has one row in
`manifest.json`. The app reads them through `src/lib/models` (`fetchModel`, `modelUrl`), never from a
third-party host.

```sh
node scripts/models/fetch.mjs              # fetch or produce every missing / wrong file
node scripts/models/fetch.mjs --check      # verify sha256 + size only (exit 1 if any is missing or wrong)
node scripts/models/fetch.mjs --only skyseg,deeplab   # rows whose file starts with these
node scripts/models/fetch.mjs --force      # re-fetch even files that verify
node scripts/models/fetch.mjs --dir /tmp/m # another target directory
```

## Manifest rows

```json
{ "file": "name.<sha8>.<ext>", "sha256": "<64 hex>", "bytes": 123, "licence": "SPDX id",
  "source": "upstream project, version / commit, what was done to it", "producer": "<URL or script>" }
```

- `file`: the served filename. It carries the first 8 hex digits of its sha256, so it can be cached
  forever (HTTP and Cache Storage) and a new version is a new name. Any format works: `.onnx`,
  `.tflite`, `.safetensors`, `.bin`.
- `sha256`, `bytes`: of the served file. `fetch.mjs` and the browser (`fetchModel`, before caching)
  verify them.
- `licence`: SPDX identifier of the weights. Never add research-only or non-commercial weights as a
  default model.
- `producer`: either an `https://` URL of a pinned upstream file (downloaded as is), or a repo-relative
  script that writes the file to the path given as its one argument: `.mjs` runs with node, `.py` with
  `$MODELS_PYTHON`, else `tools/matcher/.venv/bin/python`, else `python3`. The output must be
  reproducible (same sha256) or the row must be updated with the new file.

To add a model: write its producer under `scripts/models/<name>.(mjs|py)` (export from PyTorch, e.g. a
safetensors dump of the state_dict with BN folded, fp16 storage), run it, rename the output to
`<name>.<sha8>.<ext>`, append a row, and run `fetch.mjs --check`. Rows are appended at the end of the
array (one row per model version; remove a row when nothing loads that file any more).

## Current models

| file | licence | used by |
|---|---|---|
| `skyseg-u2netp.873ea284.onnx` | MIT | sky mask (`src/lib/sky`, ONNX Runtime). Producer `skyseg.mjs` converts the pinned ncnn weights with `src/lib/sky/tools/ncnn2onnx.py` (needs `onnx` + `numpy`). |
| `selfie_multiclass_256x256.c6748b12.tflite` | Apache-2.0 | people mask (`src/lib/segment.ts`, MediaPipe) |
| `deeplab_v3.ff36e24d.tflite` | Apache-2.0 | people mask, `deeplab` / `combined` mode (`src/lib/segment.ts`) |
| `aliked-n16.dc5fb7d3.safetensors` | BSD-3-Clause | ALIKED-n16 keypoints (`src/lib/features`, `src/lib/nn`). Producer `aliked-lightglue.py` (BN folded, fp16); it also writes the parity fixtures (`fixtures`). |
| `lightglue-aliked.f35aee62.safetensors` | Apache-2.0 | LightGlue matcher for ALIKED (`src/lib/features`). Same producer (Wqkv regrouped, fp16). |

## Runtime (src/lib/models)

- `modelUrl(file)`: `<BASE_URL>models/<file>`.
- `fetchModel(file, { signal, onProgress })`: Cache Storage (`rigi-models-v1`) first, then a streamed
  download into one preallocated buffer (sized from Content-Length or the manifest, so 100+ MB files are
  not held twice), sha256-verified, then cached. Concurrent calls share one download. Progress also goes
  to a small store (`modelDownloads`, `subscribeModelDownloads`, `describeModelDownload` → "downloading
  model 34 MB (12%)") for any UI. In node (scripts, checks) it reads `public/models/<file>` from the cwd
  or `$RIGI_MODELS_DIR`.
- `createOrtSession(file, { device, preferWebGpu, signal })`: ONNX Runtime on the app's WebGPU device
  (WASM fallback), the sky model's pattern. New networks do not use ONNX: they run on the luma compute
  graph through `src/lib/nn` and load `.safetensors` through `fetchModel`.
