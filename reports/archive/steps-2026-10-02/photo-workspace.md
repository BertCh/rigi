# Step ⑭ photo-workspace: review, research, plan (2026-10-02)

Step lead: Opus (step pod, coordinator mt-image-17). Node `photo-workspace` in `src/lib/gipfelbuch/graph.ts`
("Show a pose fast. Certify it later."), plus the platform side of the `rigi` hub (`src/lib/renderer.ts`,
`src/lib/renderer-select.ts`, the two engines). Code-level only: no browser was run (cook mode).
Line numbers refer to master `31752b8` unless a sha is given.

## 1. Current state

| piece | where | what it does |
|---|---|---|
| route | `src/routes/photo.$id.tsx:15-45` | loader resolves bundled, `demo-*` (with its bundled pose) and `local-*` (IndexedDB re-register) photos, else `notFound()`; `PhotoPage` keys the workspace on photo id + `flagsKey` so restart flags re-create the engine |
| engine choice | `src/lib/renderer-select.ts:47-111`, `PhotoWorkspace.tsx:127-170` | `?renderer`/`?backend`/`?webgpu` resolved against a cached WebGPU probe (features, limits, a granted device); the chosen chunk and the probe start at module evaluation |
| engine lifecycle | `PhotoWorkspace.tsx:486-863` | create → (WebGPU) `whenReady`, else fall back to WebGL deck on a fresh canvas; `onUnrecoverable` device loss carries pose + align state to WebGL deck |
| first pose | `PhotoWorkspace.tsx:578-720` | carried → eye move → saved/shared/bundled → unknown-sensor cascade (`resolveUnknownPose`) → `autoAlign` + `choosePreview` |
| first overlay | `PhotoWorkspace.tsx:723-736` | `settle()` (WebGPU) / `readback()` (WebGL), then the loading card clears and `[data-ready]` is set |
| certify later | `PhotoWorkspace.tsx:658-719` | full-metadata photos without a saved pose start `secondOpinion` after first paint; `[data-verify]="pending"` locks exports until it settles (20 s cascade timeout, matcher bounded at 150 s, `second-opinion.ts:19-22`) |
| hand controls | `PhotoWorkspace.tsx:949-1150, 2000-2123` | Inspect / Drag / Pin tools, Auto-align / Refine / EXIF, Heading / Pitch / Roll / FOV sliders |
| export | header Save image (`:1140-1150`), `ExportMenu` (`src/lib/export/ExportMenu.tsx`), Share (pod E) | all locked by `exportLocked = status ∥ error ∥ verify === "pending"` |
| controls kit | `src/components/controls.tsx` | Section / PanelBand / Slider / Segmented / Toggle / ColorSwatch / Button, spec `src/components/__tests__/controls.spec.tsx` |
| eye suggestion | `src/components/EyeSuggestion.tsx` | `?eyesearch=on|auto`, suggestion only, Apply/Revert from buttons only |
| renderer contract | `src/lib/renderer.ts`, `src/lib/renderer.check.ts` | structural `Renderer` interface, tsc-checked against both engines |

GPU island: none of its own (`src/lib/gpu/app-graph/manifest.ts` has no workspace entry); it drives the
engines' islands. Specs before this pass: `controls.spec.tsx`, `renderer-select.spec.ts`. No spec covered
any PhotoWorkspace logic.

## 2. Findings (ranked)

| id | P | finding | where | status |
|---|---|---|---|---|
| F1 | P1 | **Heading slider pins at its window edge near north.** With a compass the slider spanned heading ±40° and took `pose.yaw` raw. A solver, saved or shared pose of 358° next to a 2° compass (or any yaw outside the window after a drag) sat clamped at the edge; the first touch jumped the pose by up to ~40° and saved it | `PhotoWorkspace.tsx:2082-2091` | fixed: 6345569 (camera-prior pod, prior-centred unwrap) + U1 (range widens to an out-of-window yaw) |
| F2 | P1 | **Error state has no way out.** The z-30 loading/error card covers the stage header (z-20), so the Library link cannot be clicked, and the card offered no retry | `:1392-1398, 1662-1680` | fixed, U2 |
| F3 | P1 | **Auto-align / Refine could leave "Aligning…" forever.** `autoAlign` returning null returned silently; a throw became an unhandled rejection; the unknown-pose branch swallowed errors with `.catch(() => {})` | `:1052-1099` | fixed, U1 |
| F4 | P1 (claim) | **"Show a pose fast" is only half true.** For a full-metadata photo with no saved pose, the blocking card stays up through `engine.init`, `autoAlign` and `settle`; only the second opinion is deferred. For unknown-sensor photos the whole cascade runs before the card clears (its matcher upgrade is deferred). Nothing measured time-to-first-overlay | `:604-736` | measured from now (U2 marks); progressive display planned (U5, needs the batch pass + user) |
| F5 | P2 | Pin tool keyboard: candidate chips reacted to `pointerdown` only, so Enter/Space did nothing; placing the pin on the photo still needs a pointer | `:1480-1486` | chip fixed (U2); placement open (U7) |
| F6 | P2 | `Toggle` had no switch role/state, `Segmented` no pressed state: screen readers could not tell what was on | `controls.tsx` Toggle, Segmented | fixed, U2 |
| F7 | P2 | Loading progress not announced; error not an alert | `:1662-1680` | fixed, U2 |
| F8 | P2 | Header Save image: a rejected `exportImage` was an unhandled rejection with no feedback | `:1140-1150` | fixed on master by 24799c2 (licences pod: `exportFromEngine`, error in the align note); U1 moves the message to a header notice |
| F9 | P2 | Camera › "Eye (DEM-snapped)" read `engineRef.current.eyeAlt` during render: "—" until an unrelated re-render | `:2141-2144` | fixed, U2 (state set at ready) |
| F10 | P2 | Mobile: header (Library, place · date · id, Save, Share, Export) has no truncation and overflows at 360 px; hover readout has no touch path; no pinch for FOV; panel capped at 45 dvh | `:1392-1430, 1685` | header truncation fixed (U2); rest open (U8) |
| F11 | P2 (precision) | An export of an `unverified` / `prior` pose carries no marker: the PNG/JSON looks as certain as a verified one | header export, `ExportMenu` | open, user decision D2 |
| F12 | P3 | `create()` reported "WebGL unavailable" for a WebGPU construction failure too | `:493` | fixed, U1 |
| F13 | P3 | `WEBGPU_REQUIRED_FEATURES` must equal `deck-webgpu/device.ts REQUIRED_FEATURES` (comment only) | `renderer-select.ts:27-29` | spec added, U3 |
| F14 | P3 | `PhotoWorkspace.tsx` is 2.2k lines in one component (engine lifecycle, label layout, pointer tools, panel); carried follow-up since `reports/cleanup-2026-10-01.md:119` | whole file | planned U6 |
| F15 | P3 | `renderer.ts` header says members were "grepped 2026-09-25"; `setOccludedLabels` / `setDrapeMask` are declared but no engine implements them (pod C's unconsumed hooks); `DeckEngine` has neither `settle` nor `sampleAtAsync` (the caller falls back to `readback` / `sampleAt`, correct) | `renderer.ts:12, 95-106` | doc only; no change while pod C owns the hooks |

Renderer parity (code level): both engines implement every required member and the matcher's offscreen
hooks (`renderer.check.ts`); `readback()` resolves false after dispose in both (`deck/engine.ts:2088-2099` +
waiters released in `dispose` `:1099`; `deck-webgpu/engine.ts:2753-2762`); `skyline()` returns a cached
array per geometry generation in both, which the workspace's identity check (`sky !== skylineRef.current`)
needs. The only intentional asymmetry the workspace sees is the WebGPU geometry diet (`settle`,
`sampleAtAsync`).

Semantic sweep (U9, Sonnet, read-only, iteration 2): no P0. Parity OK for `init` progress (both reach
frac 1: "Tracing horizon"), `autoAlign` (neither mutates `pose`; null before the horizon/photo prep and
after dispose; never throws), `dispose` (idempotent, every RAF/timer/idle callback guarded),
`exportImage` labels (same `drawExportLabels` call; deck waits on `readback`, WebGPU on `settle`),
`peakLabels({declutter})`, `peaksInFrame`, `solvePins`, `isFlying`/`flyToPhoto`/`flyOut`, `hasPeople`
(set before `init` resolves). Found:

| id | P | finding | status |
|---|---|---|---|
| F16 | P2 | `init` on an already-disposed engine (StrictMode double mount) still started a `TerrainStreamer` whose abort listener never fires (`loadAbort` already aborted): a leak, no hang | fixed, U11: disposed guard at the top of both `init`s |
| F17 | P3 | PhotoWorkspace's comment said a disposed engine's init "rejects with AbortError"; both engines resolve early instead (the superseded check handles it) | comment corrected, U11 |
| F18 | P3 | sweeper flagged deck `exportImage` world branch as unguarded; false positive, `exportWorld` awaits `deckReady` and checks `disposed` (`deck/engine.ts:3360-3362`) | no change |

## 3. Research

- **Comparable products.** PeakVisor's photo mode overlays the terrain model right away from the photo's
  metadata and lets the user drag a central cross (pan) and side rotators (roll) to fit the horizon;
  PeakFinder overlays the drawing on the camera image and the user drags it into place, using the sun or a
  prominent summit as reference. Both show a sensor pose immediately and leave correction to the user;
  neither labels how certain the pose is. Rigi already has the hand tools (Drag, Heading/Pitch/Roll/FOV,
  pins), so the gap is the first paint (F4) and the honesty markers (F11), not the tools.
  Sources: [PeakVisor tutorial](https://peakvisor.com/tutorial_en.html),
  [PeakVisor: identify mountains in photos](https://peakvisor.com/en/news/identify_mountains_in_photos.html),
  [PeakFinder app](https://www.peakfinder.com/mobile).
- **Progressive display.** The standard pattern is optimistic first paint plus a visible pending state.
  Rigi's precision rule forbids presenting an unconfirmed pose as certain, but it already has the needed
  vocabulary: `alignState` `prior` / `unverified`, the terroir uncertainty styling (dashed leaders,
  "≈" names), and the reveal hold. So U5 shows the prior under that styling with a "Solving…" chip, and
  the solved pose arrives through the existing reveal.
- **Accessibility.** The WAI-ARIA APG switch pattern (`role="switch"`, `aria-checked`, Space/Enter
  toggle) fits the panel toggles; toggle-button groups use `aria-pressed`. Sources:
  [APG switch pattern](https://w3.org/WAI/ARIA/apg/patterns/switch),
  [APG switch using HTML button](https://www.w3.org/WAI/ARIA/apg/example-index/switch/switch-button.html).
- **Measurement.** User Timing marks (`performance.mark` with `detail`) can be read from devtools and from
  Playwright (`performance.getEntriesByName`) without touching the engines, so the batch pass can report
  time-to-first-overlay per renderer.
- **Own records.** `reports/negative-results.md` has nothing on workspace UX. The relevant precision
  records are matching-v2 (eye suggestion only as a suggestion, kept as is) and
  `reports/bench-ablation.md` (autoAlign around a placeholder prior accepts wrong poses, which is why
  unknown-sensor photos never use it; U5 must not change that).

## 4. Plan

| unit | what | size | risk | gate | when |
|---|---|---|---|---|---|
| U1 | `workspace/poseControls.ts` (dragPose, wheelVfov) + specs; Heading window widening folded into `geocam/priors/heading.ts` headingControlWindow (6345569 landed the unwrap first; U1's duplicate headingSlider dropped on rebase); runAlign no-fit/failure notes; Save image failure as a header notice; renderer-neutral `create()` error | S | low | specs, tsc, fast tier | **now** |
| U2 | a11y + escape: Toggle `role=switch`, Segmented `aria-pressed`, pin chip keyboard, `<output aria-live>` progress, `role=alert` error with Try again / Library; eyeAlt state; header truncation; `workspace/timing.ts` User Timing marks + specs | S | low | specs, tsc, fast tier; browser batch row | **now** |
| U3 | spec: `WEBGPU_REQUIRED_FEATURES` equals `device.ts REQUIRED_FEATURES` | XS | none | spec | **now** |
| U4 | batch pass: read `photo-workspace:*` marks on demo-01..12, both renderers, cold and warm cache → TTFO / time-to-certified table | S | none | batch | next browser wave |
| U5 | `?firstOverlay=prior` (flag, off): clear the blocking card after `engine.init`, show the prior with the uncertain styling + "Solving…" chip, keep exports locked, let the solved pose arrive through the reveal; unknown-sensor photos show the prior only as "placeholder" | M | med (harnesses read `[data-ready]` as final labels: keep `[data-ready]` where it is and add `[data-first-overlay]`) | U4 numbers before and after, style-baseline unchanged with the flag off | after U4; default flip = user |
| U6 | split PhotoWorkspace into `useEngineLifecycle`, `useLabelLayout`, `usePointerTools` (pure moves, bit-identical behaviour) | L | med (hot file, peers) | tsc, specs for the hooks, batch visual | when no peer holds the file |
| U7 | keyboard pin placement: arrow keys move a crosshair over the stage, Enter drops the pin | M | low | spec of the reducer + batch | later |
| U8 | mobile: long-press hover readout, pinch FOV in the Drag tool, collapsible panel | M | low–med | batch on a phone viewport | later |
| U9 | Sonnet sweep: engine semantic parity (init progress, exportImage labels, autoAlign null cases, dispose idempotence) | S | none | report | **done** (see §2) |
| U11 | disposed guard at the top of both engine `init`s (F16) + comment fix (F17) | XS | low | tsc, fast tier; batch row | **now** |
| U10 | unverified-export marker (F11) | S | low | spec | user decision D2 |

## 5. Decisions for the user

- **D1** Progressive first paint (U5): show the sensor prior, styled as uncertain, while the solve runs?
  It makes the "show a pose fast" claim literally true at the cost of a visible pose change for most
  photos. Default off until U4 numbers exist.
- **D2** Mark exports of an `unverified` / `prior` pose (caption in PNG, `"state"` already in pose JSON)?
  The export layer is shared with pod E's share link, so it needs their sign-off too.

## 6. Gipfelbuch corrections (graph.ts is not edited by this pod)

- `photo-workspace.summary`: "One screen per photo: overlay, alignment, pins, looks, export and the eye
  suggestion. A pose shows as soon as the first solve settles; full-metadata photos are then checked in
  the background by a second opinion, and exports wait for it. Every photo source loads the same way."
- `photo-workspace.modules`: add `src/lib/integration/second-opinion.ts` (the "certify later" half of the
  claim), `src/components/workspace/poseControls.ts` and `src/lib/geocam/priors/heading.ts` (the Heading
  slider window).
- `rigi.modules`: add `src/lib/renderer-select.ts` (where the WebGPU/WebGL choice lives).

## 7. Landed

All browser-unverified; one batch-ledger row each (`reports/batch-ledger.md`).

| sha | unit | what |
|---|---|---|
| 8ee2a13 | U1 | Heading range widens to a yaw beyond prior ± 40 (folded into 6345569's `headingControlWindow`; U1's duplicate `headingSlider` dropped on rebase); Auto-align / Refine say "found no fit" / "failed" on top of a90cc8b's save and cancel rules; Save image failure as a header notice; `dragPose` / `wheelVfov` + specs; renderer-neutral create error |
| bce4db3 | U2, U3 | Toggle `role=switch`, Segmented `aria-pressed`, keyboard pin chips, announced progress, `role=alert` error with Try again / Library; eye altitude as state (passed to the eye-rule pod's `EyeHeightRow`); header truncation; User Timing marks; `WEBGPU_REQUIRED_FEATURES` spec |
| 327aada | U11 | both engines' `init` returns early when already disposed (F16); comment fix (F17); marks renamed `photo-workspace:*` (the ontology check rejects `rigi:*`) |
| b8a6e96 | W1 (pose-estimate pod) | ExportMenu gets `estimate = { provenance: workspaceProvenance(alignState, verify), label }`; `export-provenance.spec.ts` pins trusted ⇔ `poseAccepted` over every reachable state |

Rebase notes: 6345569 (camera-prior) had already fixed the Heading unwrap, centred on `priorHeading` (honours
`?geoDecl`), which is more correct than U1's raw `photo.heading` centre; its implementation was kept and U1
contributed only the widening, with a spec in `geocam/priors/__tests__/heading.spec.ts`. 36adadc / a90cc8b
(accept-rule) save and cancel semantics were kept verbatim; U1's messages sit on top, and the "aborted" mark
reads the existing `verifyAbort` signal (no second cancel path).

Fast tier on the final tree (before W1): 110 pass, 4 fail, none from this branch: `biome` (gipfelbuch
shell.spec), `ontology` (generated `domain.ts` stale after peer vocabulary edits), `unit` (upload specs:
`?url` import denied through the worktree's node_modules symlink; tools python specs). align-cert times
out at 120 s under load (load average ~56), as before this branch. tsc passed.
