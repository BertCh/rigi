Brush (https://github.com/ArthurBrussee/brush) - 3D Gaussian splat trainer, used by tools/nearfield/roll/brush_loo.py
for the roll-spot "optimised path" (Step Inside P2).

Licence: Apache-2.0. Verified 2026-09-28 from the LICENSE file shipped inside the release archive
(bin/brush-app-aarch64-apple-darwin/LICENSE: "Apache License, Version 2.0, January 2004"). Commercial use OK.

Binary: release v0.3.0 (2025-09-14), asset brush-app-aarch64-apple-darwin.tar.xz (41 MB),
sha256 65b2631398c839be3c1d4d7160fe2326389dec87830aac0710985e6690a1048c (matches the release .sha256).
bin/ is gitignored (tools/nearfield/brush/.gitignore). To reinstall:
  mkdir -p bin && cd bin && curl -sLO https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-aarch64-apple-darwin.tar.xz \
    && shasum -a 256 brush-app-aarch64-apple-darwin.tar.xz && tar xf brush-app-aarch64-apple-darwin.tar.xz && rm brush-app-aarch64-apple-darwin.tar.xz

Usage notes (read from the v0.3.0 source, crates/brush-dataset):
  - COLMAP text or bin (sparse/0/cameras.txt + images.txt); images are found by file name anywhere in the folder.
  - A single *.ply (or init.ply) in the dataset folder is used as the initial splats (full Gaussians), overriding points3D.
  - RGBA images are premultiplied and alpha is matched (transparent = no splats there); a masks/<stem> image instead
    makes alpha a loss mask.
  - Output ply: standard 3DGS fields (f_dc, opacity logit, log scales, rot wxyz, x y z in the COLMAP world frame);
    it reads back with src/lib/nearfield/splat-io.ts decodeGaussianPly and tools/nearfield/roll/splatrender.py.
  - 3000 steps on a 4-photo spot at 1024 px: ~2 min on the dev Mac (Metal).
