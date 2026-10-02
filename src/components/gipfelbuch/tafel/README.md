# Tafel: the peak-notebook hero, ledger and sheet index

The design and its decisions are in `reports/peak-notebook-plan.md`. Read §0, including the softer-sheet amendment, and §6–§7. The working prototype is in `reports/peak-notebook/prototype/` (`sheet.html`, `index.html`, `layers2.js`, `common.js`). Its look is the target, except that the softer-sheet amendment wins.

This folder is new. It must not edit `swiss/**`, `notebook/**`, `viz/**`, `ConceptPage.tsx`, the pages or the `gipfelbuch.*` routes. Session mt-image-44 holds those until it releases them; it reads them, not writes them. Integration into `ConceptPage` and the index route happens after that release.

## Files

| File | Owner lane | What |
| --- | --- | --- |
| `scripts/gipfelbuch/data-tafel.ts` | bake | Bakes `public/demo/gipfelbuch/tafel/demo-NN.{webp,json}` for the 12 photos. |
| `tafel/project.ts` | core | `projectAzEl(cam, w, h, az, el)`: the pinhole projector (roll sign −1), validated against `solvedRows`. |
| `tafel/useTafelBake.ts` | core | Fetches and caches the bake JSON (`TafelBake`). |
| `tafel/Tafel.tsx` | core | The full-bleed panorama-table hero. |
| `tafel/Ledger.tsx` | core | Two to four measured values. |
| `tafel/tafel.css` | core | Role aliases and Tafel styles (imported by `Tafel.tsx`). |
| `tafel/tafel.check.ts` | core | Projector against `solvedRows` for 12 photos, and bake JSON sanity. |
| `src/routes/dev.tafel.tsx` | core | Preview: `/dev/tafel?id=demo-NN&sheet=<id>`. |
| `tafel/chapters.ts` | sheets | The three chapters and their sheet order (data flow). |
| `tafel/sheets.tsx` | sheets | `SHEETS`: per sheet, its Tafel layer, its index band, its ledger and its index value. |
| `tafel/Blattuebersicht.tsx` | sheets | The index: photo picker, chapters, cards. |
| `tafel/sheets.check.ts` | sheets | All 19 sheets present, ledger paths resolve on all 12 photos, chapters cover every node exactly once. |
| `tafel/index.ts` | core (sheets appends) | Barrel. |

## Contracts

```ts
// project.ts
export type TafelCamera = { yaw: number; pitch: number; roll: number; f: number }; // f in working px
export function projectAzEl(cam: TafelCamera, w: number, h: number, az: number, el: number): [number, number];

// the bake JSON, public/demo/gipfelbuch/tafel/demo-NN.json
export interface TafelBake {
	id: GipfelbuchPhotoId;
	generated: string; // ISO date
	script: "scripts/gipfelbuch/data-tafel.ts";
	src: string; // "/demo/gipfelbuch/tafel/demo-NN.webp": white strokes, coverage in alpha, transparent elsewhere
	width: number; height: number; // webp px
	/** Where the full working-frame photo (800 × h) sits in the canvas, as fractions. */
	photo: { x: number; y: number; w: number; h: number };
	/** The camera the strokes were projected with (working px). */
	camera: TafelCamera & { source: "solved" | "app" };
	/** Suggested photo band, working rows [top, bottom] (skyline 10–90th pct, padded). */
	band: [number, number];
	/** Compass ruler: every 5°, label every 15°, cardinal where one exists. x is a canvas fraction. */
	ticks: { az: number; x: number; label?: string; cardinal?: boolean }[];
	/** Peaks outside the frame, placed by prominence with no overlaps (canvas fractions). */
	peaks: { name: string; ele: number; km: number; az: number; x: number; y: number }[];
	/** The faintest stroke's contrast against --gb-paper-deep after the alpha floor (≥ 3). */
	minContrast: number;
}

// Tafel.tsx
export type TafelCtx = { d: GipfelbuchPhotoData; /** CSS px per working px */ s: number };
export type TafelLayer = (ctx: TafelCtx) => ReactNode; // SVG children drawn in WORKING-FRAME px (800 wide)
export type TafelNote = { at: [col: number, row: number]; text: string; tone?: "route" | "measure" | "photo" };
export function Tafel(props: {
	photo: GipfelbuchPhotoId;
	layer?: TafelLayer;
	notes?: TafelNote[];
	maxPeaks?: number; // labelled peaks inside the frame, default 6 (3 below 720 px)
	caption?: ReactNode;
}): JSX.Element;

// Ledger.tsx
export type LedgerItem = { value: string; unit?: string; label: string; /** JSON path into GipfelbuchPhotoData, for the check */ path: string };
export function Ledger(props: { items: LedgerItem[]; note?: string }): JSX.Element;

// sheets.tsx
export type BandCtx = { d: GipfelbuchPhotoData; all: Record<GipfelbuchPhotoId, GipfelbuchPhotoData>; w: number; h: number };
export interface SheetFigures {
	tafel: TafelLayer | null; // null: the sheet's hero is not a photo Tafel (e.g. dem-source, step-inside)
	band: (ctx: BandCtx) => ReactNode; // SVG children for a w × h index band (400 × 150 viewBox)
	ledger: (d: GipfelbuchPhotoData) => LedgerItem[];
	value: (d: GipfelbuchPhotoData) => string; // one mono line for the index card
}
export const SHEETS: Record<string, SheetFigures>; // keyed by GipfelbuchNode id, all 19
```

## Rules

These apply to every lane.

- **Data is exact.** Every number comes from `public/demo/gipfelbuch/*.json` or the bake. Strokes that carry data are at least 1.2 px. Furniture may use `Ink.tsx` pen helpers (import only) and may wobble; data never does.
- **Softer sheet.**
  - No grain, tape, tilt, margin rules, outlines or boxes. Space separates.
  - The Tafel plate is `var(--gb-paper-deep)`.
  - The Blatt number is plain red mono, with no hand circle.
  - Hand face (`--nb-hand` / `.nb-hand`): at most one note per figure. Words only, never digits.
- **Type.** Only `TYPE` roles from `swiss/type.ts`: 11/13/16/20/24/40/56, and `display` for the H1. No inline font names; use classes and `--gb-font-*` tokens. Numbers go in `gb-num` or mono.
- **Inks.** Use roles via the `--gb-*` tokens. If you add aliases (`--gb-terrain` → `--gb-contour`, `--gb-measure` → `--gb-water`, `--gb-route` → `--gb-red`, `--gb-peak` → `--gb-navy`, `--gb-result` → `--gb-forest`), declare them in `tafel.css` on `.gb-swiss` **and** on `.gb-swiss [data-theme="dark"]`, because aliases resolve where they are declared.
  - `fill="var(--x, #hex)"` attributes are fine.
  - Never write a resolved `color-mix(…)` string into an SVG attribute.
  - On-photo overlays use `#fff` with a soft shadow, plus `LAYER_STYLE` colours from `viz/real.tsx`.
- **Responsive.** The spill and spill labels show at 720 px and up. Below that, the photo band runs at full width with at most 3 labels, and the ruler labels every 30°. Scale ticks and strokes with the rendered width, with floors.
- **Motion.** Static is the design. Any draw-on sits behind `prefers-reduced-motion: no-preference` and is off under `navigator.webdriver`.
- **Perf.**
  - No live SVG filters.
  - The spill is one element with CSS `mask-image`.
  - `useMemo` paths.
  - Fetch the bake only when the Tafel is near the viewport, using `useInView` from `viz/hooks.ts`.
- **Code style.**
  - Every new file starts with the Rigi SPDX header (see `AGENTS.md`).
  - Run `npx biome check --write <your files>`.
  - `npx tsc --noEmit -p .` must show no errors in your files. Other sessions' files may have errors; ignore those.
- **Browser work goes through the render lock:** `node scripts/gpu/with-render-lock.mjs -- <cmd>`.
- **Shared machine.** Kill processes only by your own PID. Never use `pkill -f` or `killall`.
- **Shell gotcha.** The shell is zsh, which does not word-split `$var`. Use arrays, or `bash -c`.
