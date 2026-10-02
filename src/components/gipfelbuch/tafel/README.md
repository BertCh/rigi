# Tafel: the sheet hero, ledger, sheet index and Wegnetz

The Tafel is the panorama-table hero at the top of a sheet: the solved photo with its measured world (ridge strokes, compass ruler, summits beyond the frame) baked per photo. This folder also holds the ledger, the per-sheet `SHEETS` table, the Blattübersicht index and the Wegnetz trail map. Design rules and decisions (paper in both themes, Tafel on a `--gb-paper-deep` plate, H1 = name and claim = dek, picker-driven index): `reports/gipfelbuch.md`.

## Files

| File | Part | What |
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
| `tafel/sheets.check.ts` | sheets | All 16 sheets present, ledger paths resolve on all 12 photos, chapters cover every node exactly once. |
| `tafel/Wegnetz.tsx`, `tafel/wegnetz-layout.ts` | index | The concept graph as a hand-drawn trail map (the only node-link drawing allowed); `__tests__/wegnetz.spec.ts`. |
| `tafel/SheetColophon.tsx` | shell | The sheet's colophon: the developer facts (code, reports, provenance). |
| `tafel/index.ts` | core | Barrel. |

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
export const SHEETS: Record<string, SheetFigures>; // keyed by GipfelbuchNode id, all 16
```

## Rules

The general canon is in `reports/gipfelbuch.md`; these are the Tafel-specific ones.

- **Data is exact.** Every number comes from `public/demo/gipfelbuch/*.json` or the bake. Measured strokes are at least 1.2 px and use the pen kit's `data` mode (one pass within 0.5 px).
- **Sheet.** No grain, tape, tilt, margin rules, outlines or boxes; space separates. The Tafel plate is `var(--gb-paper-deep)`. The Blatt number is written in hand figures (`nb-num`). Every rule and frame in the index is a pen stroke.
- **One hero per sheet.** A page whose Fig. 1 is a spilled `RealPhoto` is listed in `PAGE_HERO` (`sheets.tsx`) and the shell skips its Tafel. The ledger has exactly three measured items (`sheets.check.ts`).
- **Inks.** Use the `--gb-*` roles. Aliases (`--gb-terrain` → `--gb-contour`, `--gb-measure` → `--gb-water`, `--gb-route` → `--gb-red`, `--gb-peak` → `--gb-navy`, `--gb-result` → `--gb-forest`) are declared in `tafel.css` on `.gb-swiss` **and** on `.gb-swiss [data-theme="dark"]`, because aliases resolve where they are declared. `fill="var(--x, #hex)"` attributes are fine; never write a resolved `color-mix(…)` into an SVG attribute. On-photo overlays use the `LAYER_STYLE` colours from `viz/real.tsx`.
- **Responsive.** The spill and its labels show from 720 px. Below that the photo band runs full width with at most 3 labels and the ruler labels every 30°. Scale ticks and strokes with the rendered width, with floors.
- **Motion.** Static is the design; any draw-on sits behind `prefers-reduced-motion: no-preference` and is off under `navigator.webdriver`.
- **Perf.** No live SVG filters; the spill is one element with a CSS `mask-image` (`.tafel-spill`); `useMemo` paths; fetch the bake only near the viewport (`useInView`).
