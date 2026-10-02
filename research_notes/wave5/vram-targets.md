# F16: VRAM of the WebGPU render targets (rg11b10 / f16)

Status: opt-in `?colorTarget=rg11b10` landed, default unchanged (rgba16float), browser-unverified.

## What was studied

`src/lib/deck-webgpu/targets.ts` allocates, per view:

| target | format | samples | bytes/px | notes |
|---|---|---|---|---|
| colorMS | rgba16float | 4 | 32 | transient, RENDER only |
| depthMS | depth32float | 4 | 16 | transient |
| color (resolve) | rgba16float | 1 | 8 | linear, PREMULTIPLIED, read by the compositor, look kernels and readbacks |
| geometry (1024 long side) | rgba32float | 1 | 16 | xyz ENU + range |
| normal (1024 long side) | rgba16float | 1 | 8 | xyz normal, w = material class |

The colour pass (colorMS + resolve) is 40 B/px, depth another 16 B/px: at 2048x1365 that is 106.6 MiB + 42.7 MiB.

## Finding 1: the colour target needs destination alpha

`rg11b10ufloat` is RGB only (no alpha). The colour target is premultiplied and the compositor does
`photo * (1 - a) + rgb` with `a` read from `ColorTargets.color` (composite.ts, `layerTex: ctx.color.color`);
sky = (0,0,0,0) is how overlay mode lets the photo through, and the trail / glow / label blends
write `a` with `one, one-minus-src-alpha`. With rg11b10 alpha reads as 1, so in overlay / replace
views the layer would fully cover the photo. So the MSAA target can shrink to rg11b10 only
for views where the colour pass covers every pixel (the `world` view with the sky layer, i.e. no photo
beneath). MSAA and resolve must share a format, so the resolve changes too; it also loses STORAGE usage
(rg11b10ufloat is not a storage format), compute reads it only as a sampled texture.

This is why the flag is documented as experimental and is not a safe default or a safe blanket "VRAM
mode". I did not add an automatic per-view switch: a view-dependent format means pipeline variants per
format and a target realloc on view change, which cannot be judged without a browser.

## Finding 2: Dawn A/B (scripts/gpu/color-target-dawn.ts)

4x MSAA 256x192, opaque ground + translucent premultiplied HDR (up to 2.4) trail / glow triangles with
the engine's blend ("one, one-minus-src-alpha"), resolve, read back as f32:

- rgb max abs error 0.0176 (per channel 0.0098 / 0.0078 / 0.0176), mean abs 0.00197, max relative
  (denominator >= 0.05) 2.4 %. That is the 5/6 bit mantissa of rg11b10ufloat. Visible as slight banding
  in smooth HDR gradients (sky), not in edges (the MSAA resolve behaves normally).
- alpha: rg11b10 reads 1 everywhere (as predicted).

Analytic VRAM, colour pass (MSAA 4x + resolve), saving = half:

| size | rgba16float | rg11b10ufloat | saves |
|---|---|---|---|
| 1024x683 | 26.7 MiB | 13.3 MiB | 13.3 MiB |
| 2048x1365 | 106.6 MiB | 53.3 MiB | 53.3 MiB |

(`colorPassBytes()` in targets.ts.) Against the observed ~241 vs 175-188 MiB gap in the photo view this
covers the MSAA target only when the view is a full-cover world view; photo view cannot use it.

## Finding 3: other candidates, not done

- geometry normal + class (rgba16float, 8 B/px): at 1024 long side 5.3 MiB. Packing to rgb10a2unorm
  would save about 2.7 MiB and lose normal precision the look kernels use (and rg11b10 would drop the
  class). Not worth the risk.
- depthMS depth32float x4: 16 B/px. depth24plus saves 4 B/px x 4 samples but reversed-Z precision
  (depth.ts) is why depth32float is used. Not changed.
- shader-f16 in look kernels: the feature is requested but no kernel enables it. Haze radix select,
  relief and band stats depend on f32 sums and exact (certified) results; storage buffers are the
  VRAM-heavy part, not registers. f16 math would give ALU/bandwidth, not VRAM, and breaks the
  certified-f32 contract. Not done; a per-kernel decision for a later wave with the precision gate.

## What landed

- `src/lib/deck-webgpu/targets.ts`: `applyColorTargetFormat`, `getColorTargetFormat`, `colorPassBytes`;
  `TARGET_FORMATS.colorMS` / `.color` and `PASS_ATTACHMENTS.color.colorAttachmentFormats` are getters that
  follow the selected format (default rgba16float, byte-identical when off).
- `device.ts` `adoptForCompute` calls it once per device (the one hook both device paths pass).
  Falls back to rgba16float when the device lacks `rg11b10ufloat-renderable`.
- Flag `colorTarget=rgba16|rg11b10` (flags/index.ts) and panel row (panel/flags.ts, group render).
- `scripts/gpu/wgsl-compile-all.ts`: new group `colortarget` (8 colour-pass programs rebuilt with
  rg11b10ufloat; device now requests the feature); 250 variants compile on Dawn, 0 failed.
- `scripts/gpu/color-target-dawn.ts`: the A/B above.

## What the batch pass must eyeball

1. Default (`?renderer=webgpu`): nothing changes; confirm photo view / `deck-smoke` identical.
2. `?renderer=webgpu&colorTarget=rg11b10` on a world view (sky covering): compare against default
   for banding in the sky gradient and trail/glow colour; check VRAM (`scripts/gpu/vram-probe.mjs`).
3. Same flag in overlay / photo view: expect the photo to be covered (no alpha). Confirms the documented
   limitation; do not treat as a regression.
4. Look kernels reading `color.color` (harmonize stats readback at 256 px): the resolve is no longer a
   storage texture under the flag; verify the bind path still works (readTexture of rg11b10ufloat may
   need a conversion; unverified).
