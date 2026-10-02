# Live depth tier (unit depth-live), 2026-10-02

Code: `src/lib/nearfield/local/depth-net.ts` (`run(..., opts)`, `DEPTH_LIVE_PRESETS`), bench `scripts/nearfield/depth-live.bench.ts`, spec `local/__tests__/depth-heads.spec.ts`. All numbers are measured over Dawn in node on an M3 Pro shared with other sessions (load average 5 to 7), so treat times as noisy (medians of 7, min to max spread often 10 to 100%). Quality is against the 1200-token q8 model on 24 photos (12 demo, 12 `public/photos`, 1024 px long side), not ground truth. No browser run.

## Options (all default to the still-photo path, which is unchanged)
- `batchedHeads`: points, mask and normal heads as one stack with group = 3 (first layer concatenated along Cout, later layers grouped, the 1-channel mask output zero-padded to 3). Fused weights are built once, outside the forward.
- `headStopLevel: 3`: level 4 is computed at 8x instead of 16x (level 3's resampler skips its 2x upsample, so its 3x3 conv runs at the low resolution; the neck does the same, and the uv input for level 4 is the 8x plane). This is an approximation: it skips the 16x resolution of layers that have weights.
- `normals: false`: skips the normal head even with fp16/q8 weights.
- A caller that keeps image shapes fixed hits the cached graph and the cached grid constants/fused weights; the per-frame path is one `run` and one small read. The persistent API of unit `runtime` was not on this branch.

## Parity (batched vs separate, q8, measured)
Bit-identical on z, mask, normal, points64 (max rel diff 0) at 256 tokens, 1200 tokens and with headStop 3. Vitest also checks the grouped stack against three separate stacks on synthetic weights. `depth-net.check.ts` (fp16 vs PyTorch) and `scripts/nn/parity.check.ts` (101/101) pass.

## Forward time, ms, median (min..max), 1024x768 output, includes one mask64 read
| config | separate | batched | batched + h8x |
|---|---|---|---|
| q8 1200 tok, +normals | 689 | 651 | |
| q8 1200 tok, no normals | 529 | 493 | 419 |
| q8 256 tok | 140 | 127 | 118 |
| q8 384 tok | 193 | 201 (noisy) | 185 |
| q8 512 tok | 241 | 240 | 250 (noisy) |
| q8lite 256 | | 129 | 117 |
| q8lite 384 | | 196 | 168 |
| q8lite 512 | | 249 | 212 |
| q8lite 128 | | | 86 |
| q8lite 32 (floor) | | | 56 |

Batching saves about 5 to 8% at 1200 and 256 tokens and is within noise at 384 and 512: the grouped conv kernel (runtime, not edited here) is not faster per FLOP than three separate convs, so the win is fewer launches only. It is not the 150 to 200 ms the investigation estimated. The 56 ms floor at 32 tokens, independent of output size, shows a large fixed cost per forward (about 300 graph nodes, submission, readback latency under a shared GPU). Output size had no effect on time.

## Quality vs 1200-token q8 (24 photos, scale-aligned depth, median of per-photo values)
| config | depth med | depth p90 | worst p90 | mask IoU med / min | focal med / worst |
|---|---|---|---|---|---|
| 1200 batched | 0 | 0 | 0 | 1 / 1 | 0 / 0 |
| 1200 h8x | 0.5% | 2.6% | 12% | 0.999 / 0.993 | 0.08% / 0.2% |
| 512 | 7.7% | 25% | 66% | 0.996 / 0.970 | 11% / 26% |
| 512 h8x | 7.8% | 25% | 70% | 0.995 / 0.966 | 11% / 26% |
| 384 | 8.4% | 29% | 79% | 0.994 / 0.936 | 13% / 42% |
| 384 h8x | 8.6% | 31% | 79% | 0.994 / 0.932 | 13% / 42% |
| 256 | 12.5% | 44% | 159% | 0.992 / 0.965 | 26% / 47% |
| 256 h8x | 12.2% | 46% | 159% | 0.991 / 0.968 | 26% / 47% |
| 128 h8x | 26% | 83% | 251% | 0.987 / 0.902 | 53% / 81% |
| 32 h8x | 65% | 158% | 806% | 0.951 / 0.530 | 90% / 169% |

- Stopping the head at 8x is nearly free in quality (about +0.2 point median; 1200 tokens: 0.5%) and saves 10 to 15% of time. The token count is what costs quality: at 256 tokens the focal error is 26% median, which breaks metric lifting unless the focal comes from the photo's EXIF or a fixed camera.

## Presets (`DEPTH_LIVE_PRESETS`)
- `live`: q8lite, 384 tokens, h8x, batched, no normals: about 165 ms (measured, noisy), depth 8.6% median after scale alignment.
- `liveFast`: q8lite, 256 tokens, h8x, batched, no normals: about 117 ms, depth 12% median, focal 26%: use with a known focal.
- The 100 ms target is not met with real quality. 128 tokens reaches 86 ms but 26% depth error; 1200-token quality is about 420 ms.

## Not done / next
- Batched is not the default: bit-identical and a few percent faster, but it duplicates the head weights on the GPU (concatenated copies); flip it for the still path if that memory is acceptable.
- Real gains need the runtime side (lower fixed cost per graph, faster grouped conv, f16 activations) or a smaller model; depth every N frames with warped splats remains the route to 20+ fps.
- Browser-unverified.

## Known focal at liveFast (unit live-step, measured over Dawn, 24 photos, 1024 px)
`depth-live.bench.ts --only focal`: liveFast outputs composed with the net's own focal vs the camera's EXIF vfov (`composeDepth` `knownFocal`, only the shift is solved), against the 1200-token q8 model (not ground truth). The 1200-token focal itself differs from EXIF by 11.6% median (worst 41%), so depth ratios to it cannot show the focal gain; the 3D position error (back-projected with each cloud's own intrinsics, median-scale aligned, relative to range) can.

| focal | depth med (aligned) | depth p90 (aligned) | 3D position med | focal vs EXIF med |
|---|---|---|---|---|
| net | 12.2% | 45.8% | 15.1% | 31% |
| EXIF | 12.2% | 47.6% | 12.3% | 0 |
| EXIF +5% / -5% | 12.8% / 12.9% | 47.9% / 47.3% | 15.4% / 14.8% | 5% |
| 1200-token focal (oracle) | 11.3% | 44.2% | 11.3% | 12% |

A known focal removes the 31% focal error and recovers most of the lateral (3D) error; a 5% focal error already costs it. The z-depth error is the token count's, not the focal's.
