# (a) GPUFFT1D bit-reversal miscompile on Metal: loop-free `reverseLowBits`

Status: **local packet, nothing posted** (owner decides). Rank 1 of 11 in [README.md](README.md). Base: luma master `00aab0f91` (2026-10-02, "fix(examples): refine architectural charcoal strokes (#3349)").

Kind: correctness bug fix. Size: 2 files, +41/-7. Depends on nothing.

## Title

`fix(gpgpu): loop-free FFT bit reversal (reverseBits >> (32 - n))`

## Problem

`reverseLowBits` in `modules/gpgpu/src/gpu-core/gpu-fft-utils.ts` (shared by `GPUFFT1D`, `GPUFFT2D` and `GPUConvolution` through `GPU_FFT_COMMON_SHADER_SOURCE`) reverses the low `bitCount` bits with a data-dependent loop (`for (var bitIndex = 0u; bitIndex < bitCount; bitIndex++)`). On this Mac (Dawn over Metal, macOS 14.1) it returns wrong indices for FFT lengths 16 to 2048, so every `GPUFFT1D` / `GPUFFT2D` / `GPUConvolution` result there is silently wrong: no validation error, a plausible-looking spectrum. Found by Rigi (coordinator E) with an FFT probe against a CPU reference.

Why upstream's tests did not see it: the only browser spec that compares `GPUFFT1D` with a CPU DFT (`gpu-fft1d.spec.ts`, "matches a CPU DFT for independent packed batches") uses length 8, and length 8 is correct on the affected device (relative error 5.7e-8 below). The length 16 and 32 cases compare strategies against each other. `runGPUFFT1DBenchmark` is "correctness-gated" with an impulse at element 0 of every transform; a bit-reversal permutation maps index 0 to itself and every other input element is zero, so by my reading a wrong permutation cannot change that oracle's expected flat spectrum (not tested).

The WGSL builtin `reverseBits(value) >> (32u - bitCount)` is equivalent (exhaustively checked for 1 to 16 bits against a CPU twin in the patch's spec) and has no loop.

Root cause not isolated: a standalone kernel with just the old and new `reverseLowBits` (all 1 to 16 bit lengths, same device) returned correct results for both. The miscompile therefore depends on the surrounding FFT kernel, and the claim here is empirical: end-to-end `GPUFFT1D` error goes from about 1.0 to about 1e-7 with the patch. A Dawn / Tint bug report with a reduced kernel would need more work than this packet did.

## Minimal repro

`repro/fft-dawn.node.spec.ts.txt` (copy into a luma checkout as `modules/gpgpu/test/gpu-core/fft-dawn.node.spec.ts`, no luma code changes needed). It creates a real WebGPU device in node (Dawn: `mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0`), runs `GPUFFT1D` forward on a deterministic signal and compares it with a float64 recursive FFT:

```
DAWN_DIR=/tmp/dawn yarn vitest run --project node --disableConsoleIntercept modules/gpgpu/test/gpu-core/fft-dawn.node.spec.ts
```

Measured here (max error / max magnitude), same machine and harness, only the patch differs:

| length | luma master `00aab0f91` | with this patch |
|---|---|---|
| 8 | 5.7e-8 | 5.7e-8 |
| 16 | 1.00 | 8.8e-8 |
| 64 | 1.06 | 9.8e-8 |
| 256 | 1.00 | 1.8e-7 |
| 1024 | 1.07 | 3.0e-7 |
| 2048 | 0.97 | 2.0e-7 |
| 8192 | (above the 2048 limit; needs packet b) | 4.7e-7 (with b) |
| 65536 | (above the limit; needs b) | 3.1e-7 (with b) |

(Rigi's own run of the same check before and after, on the rigi.6 build: relative error about 1 at 2048 / 8192 / 65536 before, 1.9e-7 / 4.5e-7 / 3.3e-7 after.)

## Proposed patch

`patches/a-fft-bit-reversal.patch` (78 lines, `git am` format, authored as the owner).

`````diff
From b7be01b9838ebda30473fa2db72c13c9a76eebea Mon Sep 17 00:00:00 2001
From: Robert Christie <rgcgeog@gmail.com>
Date: Fri, 2 Oct 2026 14:43:30 -0400
Subject: [PATCH] fix(gpgpu): loop-free FFT bit reversal (reverseBits >> (32 -
 n))

The data-dependent loop in reverseLowBits gives wrong bit-reversal indices on Apple (Metal) devices for lengths 16 to 2048, so GPUFFT1D, GPUFFT2D and GPUConvolution silently return wrong results there. The WGSL builtin reverseBits shifted right by 32 - bitCount is equivalent and has no loop. A node spec checks the shader source and a CPU twin of the new expression.
---
 modules/gpgpu/src/gpu-core/gpu-fft-utils.ts   | 10 ++---
 .../test/gpu-core/gpu-fft-utils.node.spec.ts  | 38 +++++++++++++++++++
 2 files changed, 41 insertions(+), 7 deletions(-)
 create mode 100644 modules/gpgpu/test/gpu-core/gpu-fft-utils.node.spec.ts

diff --git a/modules/gpgpu/src/gpu-core/gpu-fft-utils.ts b/modules/gpgpu/src/gpu-core/gpu-fft-utils.ts
index 37596f61a..e5c43bead 100644
--- a/modules/gpgpu/src/gpu-core/gpu-fft-utils.ts
+++ b/modules/gpgpu/src/gpu-core/gpu-fft-utils.ts
@@ -21,13 +21,9 @@ export const GPU_FFT_COMMON_SHADER_SOURCE = /* wgsl */ `
 const GPU_FFT_PI: f32 = 3.14159265358979323846;
 
 fn reverseLowBits(value: u32, bitCount: u32) -> u32 {
-  var source = value;
-  var reversed = 0u;
-  for (var bitIndex = 0u; bitIndex < bitCount; bitIndex++) {
-    reversed = (reversed << 1u) | (source & 1u);
-    source = source >> 1u;
-  }
-  return reversed;
+  // Loop-free: the data-dependent loop this replaces miscompiled on Apple (Metal) devices,
+  // returning wrong indices for some lengths. bitCount is 1..32 for every FFT plan.
+  return select(0u, reverseBits(value) >> (32u - bitCount), bitCount > 0u);
 }
 
 fn multiplyComplex(left: vec2f, right: vec2f) -> vec2f {
diff --git a/modules/gpgpu/test/gpu-core/gpu-fft-utils.node.spec.ts b/modules/gpgpu/test/gpu-core/gpu-fft-utils.node.spec.ts
new file mode 100644
index 000000000..3fe7096ea
--- /dev/null
+++ b/modules/gpgpu/test/gpu-core/gpu-fft-utils.node.spec.ts
@@ -0,0 +1,38 @@
+// luma.gl
+// SPDX-License-Identifier: MIT
+// SPDX-FileCopyrightText: Copyright (c) vis.gl contributors
+
+import {expect, it} from 'vitest';
+import {GPU_FFT_COMMON_SHADER_SOURCE} from '../../src/gpu-core/gpu-fft-utils';
+
+/** CPU twin of the WGSL `reverseLowBits`: `reverseBits(value) >> (32 - bitCount)`. */
+function reverseLowBits(value: number, bitCount: number): number {
+  let reversed = 0;
+  for (let bit = 0; bit < 32; bit++) {
+    reversed = (reversed << 1) | ((value >>> bit) & 1);
+  }
+  return bitCount > 0 ? (reversed >>> 0) >>> (32 - bitCount) : 0;
+}
+
+it('FFT bit reversal is loop-free and reverses the low bits', () => {
+  const body = GPU_FFT_COMMON_SHADER_SOURCE.slice(
+    GPU_FFT_COMMON_SHADER_SOURCE.indexOf('fn reverseLowBits'),
+    GPU_FFT_COMMON_SHADER_SOURCE.indexOf('fn multiplyComplex')
+  );
+  expect(body).toContain('reverseBits(value) >> (32u - bitCount)');
+  expect(body.includes('for ('), 'no data-dependent loop (miscompiled on Metal)').toBe(false);
+  for (let bitCount = 1; bitCount <= 16; bitCount++) {
+    const length = 1 << bitCount;
+    const seen = new Set<number>();
+    for (let index = 0; index < length; index++) {
+      const reversed = reverseLowBits(index, bitCount);
+      let expected = 0;
+      for (let bit = 0; bit < bitCount; bit++) {
+        expected |= ((index >> bit) & 1) << (bitCount - 1 - bit);
+      }
+      expect(reversed).toBe(expected);
+      seen.add(reversed);
+    }
+    expect(seen.size).toBe(length);
+  }
+});
`````

## Test plan

- In the patch: `gpgpu/test/gpu-core/gpu-fft-utils.node.spec.ts` (node, no GPU): the shader source contains the loop-free expression and no `for (`, and a CPU twin of the expression reverses the low bits of every index for 1 to 16 bits (a permutation each time).
- Done here: the Dawn harness above, before and after; `yarn vitest run --project node modules/core modules/webgpu modules/webgl modules/test-utils modules/gpgpu modules/engine` passes (see Verification).
- Suggested for the PR, not in the patch because no browser was available to run it: extend `GPUFFT1D matches a CPU DFT ...` in `gpu-fft1d.spec.ts` to lengths 16, 256 and 2048 (the existing helper `makeCPUDFT1D` is O(n^2) but fine at 2048 with batch 1), so the browser tier covers the failing range on macOS CI.
- Also worth running on other GPUs (the report is from one Apple machine): the fix is expected to be neutral elsewhere.

## Verification run for this packet

With all packets applied together on the base (plus `#3330` merged for c3/c4): `yarn vitest run --project node modules/core modules/webgpu modules/webgl modules/test-utils modules/gpgpu modules/engine` gave 158 files passed, 1 skipped; 1392 tests passed, 7 skipped; `biome check` on every touched `.ts` file: 0 errors, 29 warnings (the same 29 on the unpatched base). Browser-tier specs (`*.spec.ts` without `.node`) were not run, no browser here. Root `tsc --noEmit` prints about 3,650 errors on the unpatched base (the luma workspace is not built here); none of the patches adds an error outside the spec mocks that already fail the same way.

## PR description (luma template)

```markdown
For # (open an issue first per the template; none filed)

#### Background

`GPUFFT1D`, `GPUFFT2D` and `GPUConvolution` share `reverseLowBits`, which reverses the low bits with a data-dependent WGSL loop. On Apple/Metal (Dawn over Metal, macOS 14.1) it returns wrong indices for FFT lengths 16 to 2048, so these operations silently return wrong results: forward `GPUFFT1D` differs from a float64 FFT by a relative error of about 1.0. Length 8 is unaffected, and that is the only length `gpu-fft1d.spec.ts` compares with a CPU DFT.

#### Rationale

WGSL `reverseBits` shifted right by `32 - bitCount` computes the same permutation without a loop. With it the same harness gives a relative error below 5e-7 at every length from 8 to 65536. The root cause inside the compiler was not isolated (a kernel containing only the two functions does not reproduce it), so this is a measured fix, not a compiler diagnosis.

#### Change List

- Replace the loop in `reverseLowBits` with `select(0u, reverseBits(value) >> (32u - bitCount), bitCount > 0u)`
- Add `gpu-fft-utils.node.spec.ts`: no loop in the shader source, and a CPU twin of the expression reverses the low bits for 1 to 16 bits
```

## Notes

- Vendored patch that disappears: `vendor/luma/patches/luma-fft-bitreverse-bdbc371f.patch` (rigi.6 commit 9).
- App code that can go once it is on npm: the four-step split and the spot-check workaround in `src/lib/refine/fft-gpu.ts` (audit section 6, move 6).
- Risk: low. `reverseBits` is a core WGSL builtin; `bitCount` is 1..32 for every FFT plan (the `select` keeps 0 well defined).
