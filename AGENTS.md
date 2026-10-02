# AGENTS.md

Rigi is a Vite + React + TanStack Start app built on luma.gl 10 and deck.gl (WebGPU by default, WebGL2 fallback). This file follows the layout of luma.gl's `AGENTS.md`.

## Setup commands
- Node 22 (`@types/node` is `^22`; CI uses Node 22).
- Install deps: `npm install` (`npm ci` in CI). luma.gl and deck.gl come from tarballs in `vendor/`, see `vendor/luma/README.md` and `vendor/deck/README.md`.
- Dev server on :3100: `npm run dev` (`vite dev --port 3100`), or `node scripts/dev.mjs` (same, `--strictPort`; `node scripts/dev.mjs --be` or `npm run dev:all` also starts the matcher on :8765 and the near-field service on :8767 when their venvs exist). A server already on a port is reused.
- Regenerate routes after adding or removing a file in `src/routes`: `npm run generate-routes` (`src/routeTree.gen.ts` is generated; do not edit it).
- Production build: `npm run build` (`vite build`), `npm run preview`.
- Type check: `npx tsc --noEmit -p .`.

## Test and check commands
The regression gate is `scripts/ci/run.mjs`; the check registry is `scripts/ci/checks.mjs` and the table is in `scripts/ci/README.md`.
- Fast tier (no browser, about 30 s: tsc, biome ratchet, node/tsx unit checks): `node scripts/ci/run.mjs fast`
- Full tier (adds the browser checks style-baseline, deck-smoke, settle-submits, graph-plumbing-ab, eval-app, eval-app-deck): `node scripts/ci/run.mjs full`
- One or a few checks: `node scripts/ci/run.mjs fast --only labels,haze-fit`; `--skip a,b` drops some; `--list` prints every id, tier and command.
- Unit tests (Vitest, `vitest.config.ts`): `npm test` runs every `*.spec.ts` (node) and `*.spec.tsx` (happy-dom) in seconds; `npm run test:watch`, `npm run test:coverage` (→ `out/coverage`), `npx vitest run <dir>`. The gate runs them as the fast `unit` row. Specs live in `__tests__/` next to the module, are pure CPU and deterministic (no GPU, network or gitignored data), and use `src/test/helpers.ts`. Conventions and helpers: `src/test/README.md`. New code ships with specs.
- A single check script is a plain tsx script, for example `npx tsx src/lib/look/__tests__/labels.check.ts`. Every tracked `*.check.ts` must have a row in `scripts/ci/checks.mjs` (enforced by `scripts/ci/__tests__/checks.spec.ts`).
- Statuses PASS / FAIL / KNOWN / FIXED / SKIP: KNOWN failures are baselined in `scripts/ci/known-failures.json`; SKIP means a gitignored input (`data/`, `public/photos/`) is missing.
- **Testing policy: develop on Vite, test browser/GPU in batches.** Many sessions share one machine, and the render lock serializes every browser job, so per-change browser runs are the main bottleneck.
  - Per change: fast gates only (`npx tsc --noEmit -p .`, `npx biome check --write <files>`, the relevant `node scripts/ci/run.mjs fast --only …` checks, node/tsx evidence; luma's WebGPU device runs in node over Dawn for compute code). Check visuals by hand in the running `vite dev` server on :3100 (HMR), not with a harness.
  - Do not run browser harnesses, screenshots, benches or `run.mjs full` for an individual change, and do not take the render lock while implementing. Land the change marked **browser-unverified** and list it for the next batch.
  - Browser/GPU checks run as one consolidated pass per wave of work (a large chunk of landed commits), when the user asks for it or a coordinator owns it. A regression found there reverts the commit it bisects to. Runtime correctness guards still ship inside the patch.
  - Exceptions: a user who asks for a browser check now, or a change that cannot be judged any other way (then run one targeted step with `RENDER_LOCK_PRIORITY=1`).
- **When a batch does run, browser and GPU jobs go through the machine-wide render lock**: `node scripts/gpu/with-render-lock.mjs -- <cmd>`, for example `node scripts/gpu/with-render-lock.mjs -- node scripts/eval-app.mjs --renderer webgpu`. The lock is a FIFO queue shared by every session on the machine; never kill another job to free it, and never pause development for it. Take it per step, never around a script or `;`-chain of steps; use `RENDER_LOCK_EXCLUSIVE=1` only on steps whose timings you report. Launch lock-wrapped jobs in the background and keep coding. `scripts/ci/run.mjs full` wraps its browser checks in the lock itself.
- Every browser check pins its engine explicitly (`?renderer=` or `--renderer`), so a change of the default never silently changes what a gate measures.
- Optional pre-push hook for the fast tier: `node scripts/ci/install-hook.mjs`.
- Upstream drift (needs network and `gh`, not a CI check): `node scripts/upstream/luma-watch.mjs [--json]` reports npm dist-tags, luma master vs the vendor base, the vendored luma PR heads and the watch PRs.

## Examples
- `examples/` holds standalone luma.gl/deck.gl examples laid out like luma.gl's own (`README.md`, `app.ts` exporting a `create…Scene(parent, options)` factory with `ready`/`diagnostics`/`finalize`, `main.ts`, `index.html`, `mobile-support.ts`, `scripts/visual-smoke.mjs`). See `examples/README.md`.
- `node scripts/examples.mjs list`, `start <id>`, `check [id…]` (tsc), `build [id…]`, `smoke [id…]` (both backends, under the render lock).
- Examples import only public `@luma.gl/*` / `@deck.gl/*` API and never `src/`; anything that needs a private API or an unmerged upstream fix is listed under "Upstream notes" in the example's README.

## Before committing
- Lint and format: `npx biome check --write <files you changed>` (`npm run check` runs `biome check` on the whole configured tree; `npm run lint` and `npm run format` are the two halves). Always run it after making changes so Biome formatting is maintained.
- SPDX headers: `node scripts/ci/spdx.mjs` (see Code style).
- The CI ratchet fails only when a file has more Biome errors than its baseline in `known-failures.json`, so touching a file means leaving it clean.

## Pull requests
- Follow `.github/pull_request_template.md` (Background / Rationale / Change List / Verification). Write the description yourself; see the AI-assisted contributions section of `CONTRIBUTING.md`.
- When opening a PR, wait for review comments, address them and respond, then make sure CI is green.

## Merge preparation
- When asked to "get ready for merge", create a copyable Markdown description of the changes versus `master`.
- Start it with `Goals` and `Changes` sections, then `Verification`, and risks, follow-ups or other merge-relevant sections when useful.
- In `Verification`, explicitly call out which checks were run and which could not be run: `npx biome check` on the changed files, `npx tsc --noEmit -p .`, `node scripts/ci/run.mjs fast`, `node scripts/ci/spdx.mjs`, and, for rendering or GPU changes, whether the relevant full-tier checks have run in a batch pass (through `scripts/gpu/with-render-lock.mjs`) or the change is still browser-unverified.
- Run the fast tier after the final code and formatting changes and treat it as a required pre-merge gate. Do not rely on a single targeted check as a substitute for it.
- Say plainly when numbers or parity were not measured; do not report an unverified claim as verified.

## Code style
- App code (`src/`, `scripts/`, `tools/`): TypeScript, formatted by Biome per `biome.json`: tabs, double quotes, semicolons. Do not reformat by hand.
- `examples/`: luma.gl style, copied from the luma.gl examples (2-space indent, single quotes, semicolons, no bracket spacing, no trailing commas, 100 columns). The `examples/**` override in `biome.json` enforces this; keep example files consistent with their upstream neighbours.
- Every first-party source file with `SPDX-License-Identifier`, including tests and examples, must also declare each actual copyright holder using `SPDX-FileCopyrightText`. New Rigi files start with `// Rigi`, `// SPDX-License-Identifier: MIT`, `// SPDX-FileCopyrightText: Copyright (c) Rigi contributors` (a `/* */` block in CSS). `node scripts/ci/spdx.mjs` checks the first five lines of every first-party file; `--fix` adds the header.
- Preserve existing licence expressions and upstream attribution. Do not infer MIT licensing or ownership for generated, vendored or third-party files. Files that name another licence or are ported from elsewhere (for example the luma.gl `heightFog` and `precipitation` ports) keep their own notice and are listed in `NOTICE.md`.
- Shared example files `examples/example-infobox.css`, `examples/example-support.ts`, `examples/example-theme.ts` and `examples/deck/deck-example-device.ts` come from luma.gl (MIT, vis.gl contributors). Keep their headers.
- Prefer full descriptive names (camelCase for variables and functions, PascalCase for types, CAPITAL_CASE for constants) and verbNoun function names in new code. Existing code has its own abbreviations; do not rename it in unrelated changes.
- Keep shipped runtime validation minimal. When a runtime invariant needs an assertion, put the explanatory message in a comment next to it.

## Architecture pointers
- `src/lib/renderer.ts` is the engine interface the workspace and export layer use; `src/lib/renderer-select.ts` picks the backend; `src/lib/renderer.check.ts` (run by `tsc`) proves both engines satisfy it.
- `src/lib/deck-webgpu` is deck.gl on WebGPU (`WebGpuEngine`, WGSL layers); see its `README.md`. `src/lib/deck` is deck.gl on WebGL2 (`DeckEngine`, GLSL). Features are ported to both: a shader change usually means a GLSL and a WGSL edit, and `scripts/deck-engine-smoke.mjs` checks the two agree (|Δyaw| ≤ 0.5°, label overlap).
- `src/lib/gpu/core` (see its `README.md`) is the only GPU compute path: `ComputeGraph` over luma's `GPUCommandGraph`, with `defineKernel`/`kernelAsync`, a readback ring and a device pool. Under WebGPU the render device is also the compute device. Add GPU work as a graph, not as a standalone dispatch.
- `src/lib/flags` is the only reader of URL and harness flags (typed table, `getFlag`, per-realm override `globalThis.__RIGI_FLAGS__ = { gpu: "off" }`). Do not parse `location.search` elsewhere; declare a new flag there.
- `?theme=auto|light|dark` sets the colour theme (`<html data-theme>`; default `auto` = saved choice, then OS, then dark; harnesses under webdriver render dark unless they pass `?theme=light`). Mark an always-dark island with `data-theme="dark"`; use the `light:` variant for off-palette colours and `brandVar()` for SVG on the page ground (`src/lib/theme`, `src/styles.css`).
- `vendor/luma`, `vendor/deck`: vendored luma.gl `10.0.0-alpha.2-rigi.4` (luma master + open PRs + local compute API) and deck.gl `9.4.0-rigi.2` (deck master + the luma 10 bump PR #10752 + #10780 #10779 #10778 #10782 #10753 #10776). They are not first-party code; rebuild instructions are in their READMEs.

## Renderer selection
- `?renderer=auto|webgpu|deck`, default `auto`: deck.gl on WebGPU where `navigator.gpu` passes the probe (`float32-filterable`, required limits, a probe device), otherwise deck.gl on WebGL2. `?renderer=webgpu` and `?renderer=deck` pin an engine; `?webgpu=off` makes `auto` behave as if WebGPU were missing; `?gpu=off` is the compute kill switch.
- The workspace root reports the resolved engine as `data-renderer` and the reason as `data-renderer-reason`. Decision record: `reports/webgpu-default.md`.
- Harnesses take `--renderer webgpu|deck|auto` and fail when the pinned engine did not run.

## Documentation
- Status and plans live in `reports/status.md`, `reports/roadmap.md` and `reports/negative-results.md`; the index is `reports/README.md`.
- Licences of data, models and third-party code are recorded in `reports/licences.md` and summarised for readers in `NOTICE.md`.
- Keep `CHANGELOG.md` factual: user-visible and developer-visible changes under `## Unreleased`.
