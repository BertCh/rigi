<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Share-link beta and attribution: design spec (2026-10-02)

Pod E, roadmap L1 (share-link web beta) scaffolding and N2 (licences: attribution on every surface). Scaffolding only: every user-visible share path is behind `?share=on` (off by default) until N2 clears. All visual work below is **browser-unverified** (cook mode) and has rows in `reports/batch-ledger.md`.

## Design rules that bind every unit

- Separate by fill and spacing, never by an outline. A stroke only for state (focus ring, selected, input, toned warning). No decorative coloured glow or drop shadow.
- Colours from `--rigi-*` tokens (CSS) or `BRAND.*` (`src/brand/khipu.ts`, SVG/canvas). No new literal hexes. Both themes (`src/lib/theme`): stage surfaces (photo, map) are always-dark islands (`data-theme="dark"`); page chrome follows the theme and uses the `light:` variant for off-palette colours.
- Voice: short, plain, second person, specific. Say what to do, then why in one clause. No exclamation marks, no "oops", no hype on utility copy.

## 1. Share link (L1)

**What is shared:** a photo reference plus an endorsed pose. Only poses whose align state is `accepted`, `manual`, `pinned` or `saved` (status accepted or endorsed in `src/lib/ontology/crosswalk/pose.ts`) can be shared. `prior`, `unverified` and `near-compass` cannot: precision over recall, a wrong pose must not travel.

**Photo reference:** in the beta only bundled demo photos (`demo-NN`) are shareable, because uploaded photos live on the sender's device (IndexedDB) and nothing hosts them. For a `local-*` photo the share control is shown disabled with the line "Sharing your own photos needs hosting, which the beta does not have yet. Your photo stays on this device." Hosting is an open owner decision (below).

**Encoding** (`src/lib/share/`, pure, with specs): `encodeShare(payload) → string`, `decodeShare(string) → payload | null` (never throws). Payload `{ v: 1, photo: { kind: "demo", id }, pose: { yaw, pitch, roll, vfov }, state }`. Compact form: a version-prefixed string separated by `~` (`1~demo-09~<yaw>~<pitch>~<roll>~<vfov>~<state>`; `.` would clash with decimals), angles rounded to 0.01°, URL-safe without escaping. Decoding validates ranges (yaw wrapped to [0,360), pitch and roll in [-90,90], vfov in (1,170)), the photo id pattern and the state allow-list, and rejects unknown versions. `shareUrl(origin, payload)` builds `/s/<code>?share=on`.

**Route** `src/routes/s.$code.tsx` (then `npm run generate-routes`; keep peers' routes in `routeTree.gen.ts`). With `share` off: a quiet page "Share links are not public yet." plus a link to `/`. With it on: decode, load the demo photo like `/photo/$id`, render `PhotoWorkspace` with a `shared` prop. Shared mode: the shared pose wins over any local save, no auto-align, nothing persisted (`savePose` never called), a small "Shared view · <state label>" line, and the watermark.

**Watermark (display-only):** a `Watermark` overlay on the stage, bottom-left, "Rigi · shared view" in `--rigi-paper` at about 55% opacity on no fill, small caps, pointer-events none, never covering the credits (credits own bottom-right). Exports from a shared view (the Export menu; Save image is hidden there) burn the same mark into the PNG through a `watermark` option on `composeAnnotatedPng` (`src/lib/export/annotate.ts`). The mark is a label, not a security feature.

**Share control:** in the workspace header next to Export, behind `?share=on`: "Copy share link" (Link icon), disabled with a one-line reason when the pose is not endorsed or the photo is local. Copies to the clipboard and confirms inline ("Link copied") for 2 s.

## 2. Attribution (N2)

**Source of truth:** `src/lib/licences/attribution.ts` stays the one table. Add the 3D-tiles credits (Google Photorealistic 3D Tiles, swisstopo 3D Tiles) so `attributionFor` covers every source; the Google logo rule stays in `Tiles3DCredit`.

**Component** `src/lib/licences/MapAttribution.tsx`: one compact credit for map and render surfaces. Bottom-right, text 10px, `--rigi-paper` at 70% on an ink fill at 55% with backdrop blur, rounded, no border. On narrow embeds (`compact`) it collapses to an "i" button that expands on tap or focus (focus ring is the only stroke). Links open in a new tab. Text comes from `attributionLine`/`attributionFor`, never a literal.

**Surfaces:** photo workspace (existing `CreditLine`, unchanged), PNG export footer (add the 3D-tiles credit when tiles are drawn), `/roll/$id` map, landing `LiveRollMap` and `TopoBoard`, landing footer credit. Hard-coded credit strings on these surfaces are replaced by the component. Gipfelbuch, style and terroir surfaces are owned by peers and are not touched.

**Docs:** append-only rows in `NOTICE.md` and `reports/licences.md` (3-way merged over session c7's uncommitted font rows).

## 3. iOS location coaching (R7 target input)

The best input is an iPhone photo with GPS, compass heading and the gravity vector. A pure `coachLocation(diagnostics, { ios })` in `src/lib/upload/` returns a status (`complete`, `partial`, `none`) and ordered steps; specs cover each combination. The upload page shows one coaching card in place of the three separate GPS, heading and gravity warnings: a three-item sensor row (Position, Heading, Tilt; filled dot = present, hollow = missing, the hollow dot is the state stroke), then the steps for what is missing. Tone `--rigi-lesson` fill at low alpha; no border.

Copy (iOS): "Turn on Location for the Camera: Settings, Privacy & Security, Location Services, Camera, While Using, with Precise Location on." / "In the photo picker, tap Options and turn Location on, or choose the file from Files." / Heading: "Turn on Compass Calibration (Location Services, System Services) so the photo records which way you faced." Other devices get the generic version. The time-zone, lens and GPS-accuracy warnings stay as they are.

## 4. Design review

Read-only review of `/upload`, `/library`, `/roll` and the photo workspace chrome against the rules above. Clear violations in files no peer is editing are fixed; anything subjective goes to the list below.

## Open owner decisions

1. Hosting for shared uploaded photos (and its privacy terms), or demo-only sharing for the whole beta.
2. Whether `?attrib=full` (per-source DEM producers) becomes the default for the public beta; the classic line names Mapterhorn but not the national DEM producers that CC BY 4.0 asks to be named.
3. Watermark wording and whether exports outside share mode should carry it.

## Review findings for the user (subjective)

(filled in after the review unit)
