# Upstream packets for luma.gl (2026-10-02)

**Nothing here has been posted.** No PR, issue or comment exists on GitHub or with visgl for any of it; the owner decides what is sent, when and in what order (decision U in [../gpu-renderer.md](../gpu-renderer.md)). Every packet is local: a markdown file (problem, repro, patch, test plan, PR description in luma's `.github/pull_request_template.md` layout), the patch as a `git am` file in `patches/`, and one repro harness in `repro/`.

Base of every patch: luma master `00aab0f91` (2026-10-02, "fix(examples): refine architectural charcoal strokes (#3349)"). The patches apply cleanly to that commit one by one (see "Re-checking" below), and all together (c3 and c4 after a merge of open PR #3330) the luma node tier passes. luma master moves daily: re-run the check before sending.

luma's template asks for an issue first for features and bug fixes. The PR descriptions in the packets say "none filed"; the owner should file (or not) before posting.

## Ranking

Ranked by (value to every luma user) / (effort and risk to land), not by Rigi's own need.

| Rank | Packet | What | Size | Depends on | Vendored patch that disappears when merged | Rigi code that shrinks |
|---|---|---|---|---|---|---|
| 1 | [a](a-fft-bit-reversal.md) | Loop-free FFT bit reversal. **Correctness bug**: `GPUFFT1D` / `GPUFFT2D` / `GPUConvolution` silently wrong on Apple/Metal for lengths 16 to 2048 (relative error about 1.0 measured) | 2 files, +41/-7 | nothing | `luma-fft-bitreverse-bdbc371f.patch` (rigi.6 commit 9) | none (Rigi already relies on the vendored fix; the spot-check workaround went in d1be4be) |
| 2 | [b](b-fft1d-65536.md) | `GPUFFT1D` max length 65536 (was the shared 2048) | 4 files, +34/-15 | a (for correct results on Metal) | `luma-fft1d-65536-007951ae.patch` (rigi.6 commit 8) | none (four-step split and 512 retry already removed in d1be4be) |
| 3 | [d](d-export-set-dispatch-workgroups.md) | export `setGPUComputeDispatchWorkgroups` | 2 files, +25 | nothing | none | hand-written validation in `src/lib/gpu/core/graph.ts` |
| 4 | [h](h-quick-start-constructor-docs.md) | quick-start docs: `new GPUCommandGraph(device, props)` (3 pages); lists the other wrong snippets | 3 files, 3 lines | nothing | none | none |
| 5 | [c1](c-clearbuffer-submit-mapread-readtarget.md) | `CommandEncoder.clearBuffer` | 6 files, about +75 | nothing | `luma-clear-buffer-1998d244.patch` | (already adopted in `core/pool.ts`) |
| 6 | c2 (same file) | `Device.submit(buffer?, additionalBuffers?)` | 5 files, about +72/-10 | c1 (its spec) | `luma-device-submit-2f870ee8.patch` | (already adopted in `core/queue.ts`) |
| 7 | [g](g-error-scopes-without-debug.md) | `debugGPUErrorScopes` device prop | 4 files, about +70 | nothing | none | raw-handle scopes in `core/queue.ts` `openErrorScopes` |
| 8 | c3 (same file) | `mapAndReadAsync(..., {waitForSubmittedWork: false})` | 5 files, about +70 | open PR #3330 | `luma-map-read-no-wait-5727c7ca.patch` | (already adopted in `core/readback.ts`) |
| 9 | c4 (same file) | `readAsync(off, len, {target})` | 8 files, about +190 | c3, #3330 | `luma-read-into-target-96133134.patch` | (already adopted) |
| 10 | [f](f-readback-ring-growable-partial.md) | growable `GPUReadbackRing` + `readPartial` | 4 files, about +300 | nothing | none | slot growth in `core/readback.ts` (the rest stays) |
| 11 | [e](e-graph-clear-readback-nodes-lint.md) | clear / readback copy-node factories + preflight `uninitializedTransientReads` | 7 files, about +350 | c1 | none | `ComputeGraph.clearNode` body (lint and readNode stay) |

Order: a is a real bug with a tiny fix; b is a one-constant change in the same area; d and h are near-zero risk; c1 and c2 are small tested API additions Rigi already runs on; g follows the `debugGPUTime` precedent; c3 and c4 wait on open #3330; f and e add API surface luma may want to shape differently, so they come last.

## Vendored patches that would disappear if the whole set were merged and published

From `vendor/luma/patches/`: `luma-fft-bitreverse-bdbc371f.patch`, `luma-fft1d-65536-007951ae.patch`, `luma-clear-buffer-1998d244.patch`, `luma-device-submit-2f870ee8.patch`, `luma-map-read-no-wait-5727c7ca.patch`, `luma-read-into-target-96133134.patch`: six of the nine local `rigi/compute-api` commits.

Not covered by any packet and still vendored: `luma-render-bundle-msaa-4cf1099c.patch` (tiny, next batch), `luma-stream-read-2010d9f0.patch` (WebGL `STREAM_READ` hint), `luma-webgl-msaa-resolve-a6af71e5.patch` (575 lines), `luma-compute-hash-c80b7ce6.patch` (pipeline-cache hash), and every PR-head merge (#3302, #3287, #3328, #3333, #3334, #3330, #3345, #3340, #3338, #3332, #3326, #3331, #3286, #3288, #3346, #3132, #3337). Packets d, e, f, g, h remove no vendored patch; they shrink app code or fix docs. After c3 and c4 are upstream, #3330 still has to be merged for the same buffer code to be consistent.

## Verification (what was and was not run)

- Patch application: each patch applies to the base by `git apply --check` / `git am`; the full set applies in sequence (a, b, c1, c2, d, e, f, g, h, merge of #3330, c3, c4). Two patches needed hand merging when rebased from the rigi.6 tree to current master: c2 (`WebGLDevice.submit` uses `_executeCommands()` now) and the stacking of c3 / c4 on #3330.
- Node tier: `yarn vitest run --project node modules/core modules/webgpu modules/webgl modules/test-utils modules/gpgpu modules/engine` with everything applied: 158 files passed, 1 skipped; 1392 tests passed, 7 skipped. luma needed `yarn install` in the scratch clone; no build.
- Real GPU in node (Dawn over Metal, this Mac, macOS 14.1): the FFT harness for a and b only (before and after numbers in the packets). Nothing else was run on a GPU.
- Not run: any browser-tier spec (`*.spec.ts` without `.node`), WebGL legs, other GPUs / OSes, benchmarks. The packets say which test legs that leaves unrun.
- `biome check` on every touched `.ts`: 0 errors, 29 warnings (the same 29 on the base). Formatting follows luma's `biome.jsonc`.
- The Metal miscompile in a was reproduced end to end only; its root cause inside Dawn / Tint was not isolated (a reduced kernel did not reproduce it).

## Re-checking before sending

```sh
git clone https://github.com/visgl/luma.gl luma && cd luma     # full history (the shared scratch clone was shallow)
git checkout -b packets origin/master                          # or the base above
for p in a- b- c1- c2- d- e- f- g- h-; do git am --3way <repo>/reports/upstream-packets-2026-10-02/patches/$p*.patch; done
git fetch origin pull/3330/head:pr3330 && git merge --no-edit pr3330                      # only for c3 and c4
for p in c3- c4-; do git am --3way <repo>/reports/upstream-packets-2026-10-02/patches/$p*.patch; done
corepack yarn install && corepack yarn vitest run --project node modules/core modules/webgpu modules/webgl modules/test-utils modules/gpgpu modules/engine
```

To send one packet alone, apply only it (plus its dependency from the table) to a branch of current master. `git am` keeps the owner as author; each patch has a conventional-commit subject and a body.

## Repro harness

`repro/fft-dawn.node.spec.ts.txt`: `GPUFFT1D` forward against a float64 FFT on a real WebGPU device in node (Dawn). Used for the before and after numbers of a and b. Copy it into a luma checkout without the `.txt`; skips unless `DAWN_DIR` is set. It is a `.txt` here only so Rigi's `tsc` does not compile luma-only imports.
