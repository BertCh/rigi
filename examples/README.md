# Examples

Standalone examples in the style of the [luma.gl](https://github.com/visgl/luma.gl/tree/master/examples) and [deck.gl](https://github.com/visgl/deck.gl/tree/master/examples) example repositories. They exercise the same luma.gl 10 / deck.gl stack the Rigi app runs on, without the app around it.

| Example | Path | Backends | What it shows | Run |
|---|---|---|---|---|
| Summit view | [`deck/summit-view`](deck/summit-view) | WebGPU, WebGL2 | A deck.gl terrain view with custom layers and shaders (WGSL and GLSL) on a luma.gl 10 device, with a WebGL2 fallback | `node scripts/examples.mjs start deck/summit-view` |
| Photo drape | [`deck/photo-drape`](deck/photo-drape) | WebGPU, WebGL2 | Projective texturing of a photo onto deck.gl terrain with a shadow map rendered once per pose in a public deck `Effect`, an `OrbitView` with roll, and a view-state flight into the photo | `node scripts/examples.mjs start deck/photo-drape` |
| Horizon graph | [`gpgpu/horizon-graph`](gpgpu/horizon-graph) | WebGPU | A multi-pass compute pipeline on luma's `GPUCommandGraph` with GPU-resident intermediates: marching a terrain horizon on the GPU | `node scripts/examples.mjs start gpgpu/horizon-graph` |

Each folder has its own `package.json` like a luma.gl example, but packages resolve from the root install (one lockfile; luma.gl uses yarn workspaces instead), so do not `npm install` inside an example. `npm start` inside the folder also works, because npm puts the ancestor `node_modules/.bin` on the path. `node scripts/examples.mjs list | check | build | smoke [id…]` type-checks, builds (into `out/examples/`) or runs each example's `scripts/visual-smoke.mjs` on WebGPU and WebGL2 under the render lock. Deck examples take `?backend=webgpu|webgl`. `node scripts/examples.mjs site` builds every example plus a gallery page (`out/examples-site/index.html`, like luma.gl's website examples page) from each README's title and first paragraph, `mobile-support.ts` backends and `thumbnail.jpg` (a 480 px render of open map data; never a photo).

Check each example's own `README.md` for its exact run command and browser requirements (WebGPU needs a recent Chrome, Edge or Safari).

## Shared files and licences

`example-infobox.css`, `example-support.ts`, `example-theme.ts` and `deck/deck-example-device.ts` come from the luma.gl examples. They are MIT, Copyright (c) vis.gl contributors, and keep their original headers. The examples themselves are Rigi code (MIT, Copyright (c) Rigi contributors, see the repository `LICENSE`). Any photo or map data used by an example keeps its own terms; see `NOTICE.md`.

## Code style

`examples/**` follows luma.gl style (2 spaces, single quotes, no trailing commas, 100 columns), enforced by the override in `biome.json`: `npx biome check --write examples`. Every file carries the SPDX header (`node scripts/ci/spdx.mjs`).
