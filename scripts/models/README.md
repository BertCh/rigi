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
| `skyseg-u2netp.873ea284.onnx` | MIT | source of `skyseg-u2netp-nn.*` only (read by `u2netp.py`; also the onnxruntime-web reference of the `u2netp-parity` check and the offline Landeskarte bake, not loaded by the app). Producer `skyseg.mjs` converts the pinned ncnn weights with `src/lib/sky/tools/ncnn2onnx.py` (needs `onnx` + `numpy`). |
| `skyseg-u2netp-nn.884ee489.safetensors` | MIT | sky mask (`src/lib/sky`, on `src/lib/nn`). Producer `u2netp.py` (fp16, the exported graph in `__metadata__.program`). |
| `selfie_multiclass_256x256.c6748b12.tflite` | Apache-2.0 | source of `selfie-multiclass-nn.*` only (read by `mediapipe-seg.py`, not loaded at runtime) |
| `deeplab_v3.ff36e24d.tflite` | Apache-2.0 | source of `deeplab-v3-nn.*` only (read by `mediapipe-seg.py`, not loaded at runtime) |
| `selfie-multiclass-nn.c64d6152.safetensors`, `deeplab-v3-nn.70580c5b.safetensors` | Apache-2.0 | people mask (`src/lib/segment`, on `src/lib/nn`). Producer `mediapipe-seg.py` converts the two .tflite files (fp16 convs + the TFLite op list; needs `tflite` + `ai-edge-litert` in the venv for the parity reference). |
| `aliked-n16.dc5fb7d3.safetensors` | BSD-3-Clause | ALIKED-n16 keypoints (`src/lib/features`, `src/lib/nn`). Producer `aliked-lightglue.py` (BN folded, fp16); it also writes the parity fixtures (`fixtures`). |
| `lightglue-aliked.f35aee62.safetensors` | Apache-2.0 | LightGlue matcher for ALIKED (`src/lib/features`). Same producer (Wqkv regrouped, fp16). |
| `moge2-vits-normal.6d404d23.safetensors` | MIT AND Apache-2.0 | Step Inside depth (`src/lib/nearfield/local`), fp16 reference (`?nearfieldWeights=fp16`, parity checks). Producer `moge2-vits.py`. |
| `moge2-vits-q8.65924691.safetensors`, `moge2-vits-q8lite.7a9fc5f9.safetensors` | MIT AND Apache-2.0 | Step Inside depth downloads (default q8, 36 MB; q8lite without the normal head, 33 MB). Producer `quantize.ts` from the fp16 file. |
| `vitpose-b.71b52d25.safetensors` | Apache-2.0 | People completion keypoints (`src/lib/body`, `?peopleBody=on`). Producer `vitpose.py`. |
| `anny-lod10.7f7971fa.safetensors` | Apache-2.0 AND CC0-1.0 | People completion body fit (`src/lib/body`). Producer `anny.py`. |

## Quantized files

`npx tsx scripts/models/quantize.ts --preset <name> [--manifest]` writes an int8 (or int4) copy of an fp16
safetensors in the `src/lib/nn/quant.ts` format: `<name>.qweight` (U8) + `<name>.qscale` (F16) pairs
listed in `__metadata__.quant`. `nn.loadWeights` expands them to f16 on the GPU at load (f32 / CPU
elsewhere), so only the download changes. Presets name what stays fp16 (norms, biases, embeddings)
and what is dropped; `--manifest` replaces the preset's row. The output is byte-reproducible. Measure a
new preset against its fp16 source before shipping it (`reports/step-inside-download.md` has the
MoGe numbers: int8 fine, int4 not).

## Runtime (src/lib/models)

- `modelUrl(file)`: `<BASE_URL>models/<file>`.
- `fetchModel(file, { signal, onProgress })`: Cache Storage (`rigi-models-v1`) first, then a streamed
  download into one preallocated buffer (sized from Content-Length or the manifest, so 100+ MB files are
  not held twice), sha256-verified, then cached. Concurrent calls share one download. Progress also goes
  to a small store (`modelDownloads`, `subscribeModelDownloads`, `describeModelDownload` → "downloading
  model 34 MB (12%)") for any UI. In node (scripts, checks) it reads `public/models/<file>` from the cwd
  or `$RIGI_MODELS_DIR`.
- New networks run on the luma compute graph through `src/lib/nn` and load `.safetensors` through
  `fetchModel`; the app ships no ONNX Runtime.
