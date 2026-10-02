// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { CSSProperties, ReactNode } from "react";
import { publicUrl } from "#/lib/public-url";
import {
	Hachure,
	HandDot,
	PenCircle,
	PenLine,
	SketchPath,
	SketchRect,
} from "../notebook/Ink";
import { HandLabel } from "../viz/labels";
import {
	GIPFELBUCH_PHOTO_IDS,
	type GipfelbuchPeak,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	LAYER_STYLE,
} from "../viz/real";
import type { LedgerItem } from "./Ledger";
import type { TafelLayer } from "./Tafel";

// SHEETS: per Gipfelbuch sheet, its in-frame Tafel layer, its 400x150 index band, its ledger and its
// index value line. All numbers come from the measured JSON (public/demo/gipfelbuch/demo-NN.json).
// The band is one visual form per sheet (reports/peak-notebook-plan.md, D-PN4, prototype v5).

export type BandCtx = {
	d: GipfelbuchPhotoData;
	/** All 12 photos that have loaded; bands that need them (accept-rule, camera-roll) use what is there. */
	all: Partial<Record<GipfelbuchPhotoId, GipfelbuchPhotoData>>;
	w: number;
	h: number;
};

/**
 * KR2 (reports/gipfelbuch-best-of-both.md), one hero per sheet: sheets whose page opens with its own
 * real-photo hero drawn with `RealPhoto bleed` (the Tafel look carried by the figure). The shell Tafel
 * steps aside on these; every other sheet keeps the shell Tafel as its hero.
 */
export const PAGE_HERO: ReadonlySet<string> = new Set([
	"rigi",
	"photo",
	"viewport-inference",
	"skyline",
	"dem-horizon",
	"pose-estimate",
	"terrain-snapping",
	"tap-a-peak",
	"peak",
	"eye-rule",
	"dem-anchoring",
	"photo-workspace",
	"step-inside",
	// Shell Tafel kept: accept-rule (spec §2.1), and dem-source and camera-roll,
	// whose heroes are maps on a plate, so the Tafel is the sheet's one spilled photo.
]);

export interface SheetFigures {
	tafel: TafelLayer | null;
	band: (ctx: BandCtx) => ReactNode;
	ledger: (d: GipfelbuchPhotoData) => LedgerItem[];
	value: (d: GipfelbuchPhotoData) => string;
}

// ---------------------------------------------------------------- inks

const INK = "var(--gb-ink, #131313)";
const SECONDARY = "var(--gb-secondary, #4a545c)";
const TERRAIN = "var(--gb-contour, #95500c)";
const MEASURE = "var(--gb-water, #30626b)";
const ROUTE = "var(--gb-red, #bf2233)";
const RESULT = "var(--gb-forest, #575e4e)";
const PAPER = "var(--gb-paper, #f7f7f5)";
const PAPER_DEEP = "var(--gb-paper-deep, #ebebe6)";
const HAIRLINE = "var(--gb-relief, #919192)";
const SKYLINE_COLOR = LAYER_STYLE.skyline.color;
const PRIOR_COLOR = LAYER_STYLE.prior.color;
const SOLVED_COLOR = LAYER_STYLE.solved.color;
const SHADOW = { stroke: "#000", strokeOpacity: 0.55, strokeWidth: 3 } as const;

// ---------------------------------------------------------------- small helpers

const clamp = (v: number, lo: number, hi: number) =>
	Math.min(hi, Math.max(lo, v));
const f1 = (n: number) => n.toFixed(1);
const signed = (n: number, digits = 1) =>
	`${n > 0 ? "+" : ""}${n.toFixed(digits)}`;
const votedColumns = (d: GipfelbuchPhotoData) =>
	d.skyline.weight.filter((w) => w > 0).length;

/** Dotted-path read into the photo JSON (the Ledger contract's `path`). */
function at(d: unknown, path: string): number {
	let o: unknown = d;
	for (const k of path.split(".")) o = (o as Record<string, unknown>)?.[k];
	return o as number;
}

type StatOptions = {
	dec?: number;
	unit?: string;
	sign?: boolean;
	/** Unit scale override; default is % x100 and km /1000 (metres in, km out). */
	scale?: number;
};
const UNIT_SCALE: Record<string, number> = { "%": 100, km: 0.001 };
/** A ledger item whose formatted value is the JSON number at `path`, scaled by its unit (% x100, km /1000). */
function stat(
	d: GipfelbuchPhotoData,
	path: string,
	label: string,
	{ dec = 0, unit, sign, scale }: StatOptions = {},
): LedgerItem {
	const raw = at(d, path) * (scale ?? (unit ? (UNIT_SCALE[unit] ?? 1) : 1));
	const text = sign ? signed(raw, dec) : raw.toFixed(dec);
	return { value: text, unit, label, path };
}

type Geom = { k: number; ox: number; oy: number };

/** Photo placement for a w x h band: the median skyline row sits at 45% of the band height. */
function bandGeom(d: GipfelbuchPhotoData, w: number, h: number): Geom {
	const ys: number[] = [];
	d.skyline.rows.forEach((r, c) => {
		if (r != null && d.skyline.weight[c] > 0) ys.push(r);
	});
	ys.sort((a, b) => a - b);
	const mid = ys.length ? ys[ys.length >> 1] : d.photo.height * 0.4;
	const k = Math.max(w / d.photo.width, h / d.photo.height);
	const top = clamp(
		mid - (h / k) * 0.45,
		0,
		Math.max(0, d.photo.height - h / k),
	);
	return { k, ox: (w - d.photo.width * k) / 2, oy: -top * k };
}

function PhotoImage({ d, g }: { d: GipfelbuchPhotoData; g: Geom }) {
	return (
		<image
			href={d.photo.src}
			x={g.ox}
			y={g.oy}
			width={d.photo.width * g.k}
			height={d.photo.height * g.k}
			preserveAspectRatio="none"
		/>
	);
}

type Rows = (number | null)[];
/** SVG path through a row-per-column array in a (k, ox, oy) frame; breaks at nulls, zero weight and jumps. */
function linePath(
	rows: Rows,
	g: Geom,
	weight?: number[],
	maxJump = 12,
): string {
	let out = "";
	let prev: number | null = null;
	for (let c = 0; c < rows.length; c++) {
		const r = rows[c];
		if (r == null || !Number.isFinite(r) || (weight && weight[c] <= 0)) {
			prev = null;
			continue;
		}
		const x = g.ox + (c + 0.5) * g.k;
		const y = g.oy + r * g.k;
		out += `${prev == null || Math.abs(r - prev) > maxJump ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
		prev = r;
	}
	return out;
}

/** A measured line on a photo: a soft dark halo under a coloured stroke. */
function Stroke({
	d,
	color,
	width,
	dash,
	seed,
}: {
	d: string;
	color: string;
	width: number;
	dash?: string;
	seed?: string;
}) {
	return (
		<g fill="none" strokeLinejoin="round" strokeLinecap="round">
			<path
				d={d}
				stroke="#000"
				strokeOpacity={0.35}
				strokeWidth={width + 2.2}
			/>
			<SketchPath
				d={d}
				data
				seed={seed ?? `stroke-${d.length}-${d.slice(0, 40)}`}
				color={color}
				width={width}
				dash={dash}
			/>
		</g>
	);
}

type TextKind = "micro" | "name" | "stat";
const TEXT_CLASS: Record<TextKind, string> = {
	micro: "nb-hand-small",
	name: "nb-label",
	stat: "nb-hand-small",
};
const TEXT_SIZE: Record<TextKind, number> = { micro: 12, name: 14, stat: 26 };
function Txt({
	x,
	y,
	children,
	fill = INK,
	anchor = "start",
	kind = "micro",
	onPhoto = false,
}: {
	x: number;
	y: number;
	children: ReactNode;
	fill?: string;
	anchor?: "start" | "middle" | "end";
	kind?: TextKind;
	onPhoto?: boolean;
}) {
	const style: CSSProperties = {
		paintOrder: "stroke",
		fill: onPhoto ? "#fff" : fill,
		fontVariantNumeric: "tabular-nums",
	};
	return (
		<text
			x={x}
			y={y}
			className={TEXT_CLASS[kind]}
			fontSize={TEXT_SIZE[kind]}
			textAnchor={anchor}
			style={style}
			strokeLinejoin="round"
			{...(onPhoto ? SHADOW : {})}
		>
			{children}
		</text>
	);
}

/** Width of a mono 11 px string, for clamping labels inside the band. */
const monoWidth = (s: string) => s.length * 7.4;
const nameWidth = (s: string) => s.length * 8;

function Ground({
	w,
	h,
	fill = PAPER,
}: {
	w: number;
	h: number;
	fill?: string;
}) {
	return <rect width={w} height={h} fill={fill} />;
}

/** Push label rows apart so none is closer than `gap`; keeps order, clamps to [lo, hi]. */
function spread(ys: number[], gap: number, lo: number, hi: number): number[] {
	const order = ys.map((y, i) => [y, i] as const).sort((a, b) => a[0] - b[0]);
	const out = new Array<number>(ys.length);
	let prev = lo - gap;
	for (const [y, i] of order) {
		const v = Math.max(y, prev + gap);
		out[i] = v;
		prev = v;
	}
	// If the bottom overflowed, pull the stack back up.
	let limit = hi;
	for (let n = order.length - 1; n >= 0; n--) {
		const i = order[n][1];
		out[i] = Math.min(out[i], limit);
		limit = out[i] - gap;
	}
	return out;
}

// ---------------------------------------------------------------- peaks in frame

function framePeaks(
	d: GipfelbuchPhotoData,
	opts: { labelledOnly?: boolean; margin?: number } = {},
): (GipfelbuchPeak & { solved: [number, number] })[] {
	const m = opts.margin ?? 0;
	return d.peaks.filter(
		(p): p is GipfelbuchPeak & { solved: [number, number] } =>
			!!p.solved &&
			(!opts.labelledOnly || p.labelled) &&
			p.solved[0] > m &&
			p.solved[0] < d.photo.width - m &&
			p.solved[1] > m &&
			p.solved[1] < d.photo.height - m,
	);
}

/** Index in d.peaks of the highest labelled summit; falls back to any peak. */
function highestPeakIndex(d: GipfelbuchPhotoData): number {
	let best = -1;
	d.peaks.forEach((p, i) => {
		if (!p.labelled) return;
		if (best < 0 || p.dem > d.peaks[best].dem) best = i;
	});
	if (best >= 0) return best;
	d.peaks.forEach((p, i) => {
		if (best < 0 || p.dem > d.peaks[best].dem) best = i;
	});
	return Math.max(best, 0);
}

/** Indices of the nearest and the farthest labelled peak. */
function labelledExtremes(d: GipfelbuchPhotoData): [number, number] {
	let near = -1;
	let far = -1;
	d.peaks.forEach((p, i) => {
		if (!p.labelled) return;
		if (near < 0 || p.distance < d.peaks[near].distance) near = i;
		if (far < 0 || p.distance > d.peaks[far].distance) far = i;
	});
	const fallback = highestPeakIndex(d);
	return [near < 0 ? fallback : near, far < 0 ? fallback : far];
}

// ---------------------------------------------------------------- Tafel layers (working-frame px)

/** CSS-px stroke width as working px, never thinner than 1.2 css px. */
const wpx = (s: number, cssPx: number) => Math.max(1.2, cssPx) / s;
const WORKING_GEOM: Geom = { k: 1, ox: 0, oy: 0 };

function votedRowsPath(d: GipfelbuchPhotoData) {
	return linePath(d.skyline.rows, WORKING_GEOM, d.skyline.weight);
}

/** Vertical ticks hanging from the skyline, length by column confidence. */
function weightTicks(d: GipfelbuchPhotoData, len: number, step = 2): string {
	let out = "";
	for (let c = 0; c < d.skyline.rows.length; c += step) {
		const r = d.skyline.rows[c];
		const w = d.skyline.weight[c];
		if (r == null || w <= 0) continue;
		out += `M${(c + 0.5).toFixed(1)} ${(r + len * 0.2).toFixed(1)}v${(w * len).toFixed(1)}`;
	}
	return out;
}

const tafelSkyline: TafelLayer = ({ d, s }) => (
	<g>
		<SketchPath
			d={weightTicks(d, 14 / s)}
			data
			seed={`tafel-skyline-ticks-${d.id}`}
			color={SKYLINE_COLOR}
			width={wpx(s, 1.2)}
		/>
		<Stroke
			d={votedRowsPath(d)}
			seed={`tafel-skyline-${d.id}`}
			color={SKYLINE_COLOR}
			width={wpx(s, 2)}
		/>
	</g>
);

/** The column where prior and solved skylines differ most, for the delta arrow. */
function widestGap(d: GipfelbuchPhotoData): number {
	let best = 0;
	let gap = -1;
	for (let c = 40; c < d.priorRows.length - 40; c++) {
		const a = d.priorRows[c];
		const b = d.solvedRows[c];
		if (a == null || b == null || d.skyline.weight[c] <= 0) continue;
		const g = Math.abs(a - b);
		if (g > gap) {
			gap = g;
			best = c;
		}
	}
	return best;
}

function priorVsSolved(
	d: GipfelbuchPhotoData,
	s: number,
	arrow: boolean,
): ReactNode {
	const c = widestGap(d);
	const y1 = d.priorRows[c];
	const y2 = d.solvedRows[c];
	const head = 6 / s;
	return (
		<g>
			<Stroke
				d={linePath(d.priorRows, WORKING_GEOM)}
				color={PRIOR_COLOR}
				width={wpx(s, 2)}
				dash={`${6 / s} ${4 / s}`}
			/>
			<Stroke
				d={linePath(d.solvedRows, WORKING_GEOM)}
				color={SOLVED_COLOR}
				width={wpx(s, 2)}
			/>
			{arrow && y1 != null && y2 != null && Math.abs(y2 - y1) > 4 / s && (
				<SketchPath
					d={`M${c} ${y1}L${c} ${y2}M${c - head * 0.6} ${y2 - Math.sign(y2 - y1) * head}L${c} ${y2}L${c + head * 0.6} ${y2 - Math.sign(y2 - y1) * head}`}
					data
					seed={`tafel-delta-arrow-${d.id}`}
					color="#fff"
					width={wpx(s, 1.6)}
				/>
			)}
		</g>
	);
}

const tafelPose: TafelLayer = ({ d, s }) => {
	let ticks = "";
	for (let c = 0; c < d.skyline.rows.length; c += 4) {
		const a = d.skyline.rows[c];
		const b = d.solvedRows[c];
		if (a == null || b == null || d.skyline.weight[c] <= 0) continue;
		ticks += `M${c + 0.5} ${a.toFixed(1)}L${c + 0.5} ${b.toFixed(1)}`;
	}
	return (
		<g>
			<Stroke
				d={linePath(d.solvedRows, WORKING_GEOM)}
				color={SOLVED_COLOR}
				width={wpx(s, 2)}
			/>
			<SketchPath
				d={ticks}
				data
				seed={`tafel-pose-ticks-${d.id}`}
				color="#fff"
				width={wpx(s, 1.2)}
			/>
		</g>
	);
};

const INLIER_PX = 5;
const tafelAccept: TafelLayer = ({ d, s }) => {
	let inlier = "";
	let outlier = "";
	const half = 6 / s;
	for (let c = 0; c < d.skyline.rows.length; c += 2) {
		const a = d.skyline.rows[c];
		const b = d.solvedRows[c];
		if (a == null || b == null || d.skyline.weight[c] <= 0) continue;
		const seg = `M${c + 0.5} ${(b - half).toFixed(1)}v${(half * 2).toFixed(1)}`;
		if (Math.abs(a - b) < INLIER_PX) inlier += seg;
		else outlier += seg;
	}
	return (
		<g>
			<Stroke
				d={linePath(d.solvedRows, WORKING_GEOM)}
				color={d.solved.accepted ? SOLVED_COLOR : PRIOR_COLOR}
				width={wpx(s, 1.6)}
				dash={d.solved.accepted ? undefined : `${4 / s} ${4 / s}`}
			/>
			<SketchPath
				d={inlier}
				data
				seed={`tafel-accept-in-${d.id}`}
				color="#fff"
				width={wpx(s, 1.2)}
			/>
			<SketchPath
				d={outlier}
				data
				seed={`tafel-accept-out-${d.id}`}
				color={PRIOR_COLOR}
				width={wpx(s, 1.6)}
			/>
		</g>
	);
};

const tafelPeak: TafelLayer = ({ d, s }) => {
	const m = 24 / s;
	const peaks = framePeaks(d, { labelledOnly: true, margin: m });
	const top = highestPeakIndex(d);
	return (
		<g>
			{peaks.map((p) => {
				const [x, y] = p.solved;
				const isTop = d.peaks[top] === p;
				return (
					<g key={`${p.name}-${p.az}`}>
						<HandDot
							x={x}
							y={y}
							r={4 / s}
							data
							seed={`tafel-peak-dot-${p.name}-${p.az}`}
							color="#fff"
							opacity={1}
						/>
						{isTop && y > 60 / s && (
							<g>
								<PenLine
									from={[x, y - 34 / s]}
									to={[x, y - 5 / s]}
									data
									seed={`tafel-peak-leader-${p.name}-${p.az}`}
									color="#fff"
									width={wpx(s, 1)}
								/>
								<HandLabel
									x={x}
									y={y - 50 / s}
									anchor="middle"
									size={13 / s}
									caps
									color="#fff"
									halo={3 / s}
									haloColor="rgba(0,0,0,0.55)"
								>
									{p.name}
								</HandLabel>
								<HandLabel
									x={x}
									y={y - 38 / s}
									anchor="middle"
									size={11 / s}
									italic
									color="#fff"
									halo={3 / s}
									haloColor="rgba(0,0,0,0.55)"
								>
									{`${Math.round(p.dem)} m · ${(p.distance / 1000).toFixed(0)} km`}
								</HandLabel>
							</g>
						)}
					</g>
				);
			})}
		</g>
	);
};

const tafelTap: TafelLayer = ({ d, s }) => {
	const m = 28 / s;
	const pins = framePeaks(d, { labelledOnly: true, margin: m })
		.sort((a, b) => b.dem - a.dem)
		.slice(0, 5);
	return (
		<g>
			{pins.map((p, i) => (
				<g key={`${p.name}-${p.az}`}>
					<PenCircle
						center={[p.solved[0], p.solved[1]]}
						radiusX={11 / s}
						data
						seed={`tafel-tap-ring-${p.name}-${p.az}`}
						color="#fff"
						width={wpx(s, 1.8)}
					/>
					<HandDot
						x={p.solved[0]}
						y={p.solved[1]}
						r={2.4 / s}
						data
						seed={`tafel-tap-dot-${p.name}-${p.az}`}
						color="#fff"
						opacity={1}
					/>
					<HandLabel
						x={p.solved[0] + 15 / s}
						y={p.solved[1] - 9 / s}
						size={11 / s}
						color="#fff"
						halo={3 / s}
						haloColor="rgba(0,0,0,0.55)"
					>
						{String(i + 1)}
					</HandLabel>
				</g>
			))}
		</g>
	);
};

const tafelSolvedOnly: TafelLayer = ({ d, s }) => (
	<Stroke
		d={linePath(d.solvedRows, WORKING_GEOM)}
		color={SOLVED_COLOR}
		width={wpx(s, 2)}
	/>
);

// ---------------------------------------------------------------- bands (400 x 150)

const bandSkyline = ({ d, w, h }: BandCtx) => {
	const g = bandGeom(d, w, h);
	let ticks = "";
	for (let c = 0; c < 800; c += 3) {
		const r = d.skyline.rows[c];
		if (r == null || d.skyline.weight[c] <= 0) continue;
		const x = g.ox + (c + 0.5) * g.k;
		ticks += `M${x.toFixed(1)} ${(g.oy + r * g.k + 2).toFixed(1)}v${(d.skyline.weight[c] * 9).toFixed(1)}`;
	}
	return (
		<>
			<PhotoImage d={d} g={g} />
			<SketchPath
				d={ticks}
				data
				seed={`band-skyline-ticks-${d.id}`}
				color={SKYLINE_COLOR}
				width={1.2}
			/>
			<Stroke
				d={linePath(d.skyline.rows, g, d.skyline.weight)}
				color={SKYLINE_COLOR}
				width={2}
			/>
		</>
	);
};

const bandPhoto = ({ d, w, h }: BandCtx) => {
	const g = bandGeom(d, w, h);
	const lines = [
		`${d.photo.fullWidth}×${d.photo.fullHeight}`,
		`${d.gps.lat.toFixed(4)}, ${d.gps.lon.toFixed(4)}`,
		`alt ${Math.round(d.gps.alt)} m ±${Math.round(d.gps.hAccuracy)} m`,
		`compass ${f1(d.sensor.heading)}°`,
	];
	return (
		<>
			<PhotoImage d={d} g={g} />
			{lines.map((t, i) => (
				<Txt key={t} x={10} y={20 + i * 15} onPhoto>
					{t}
				</Txt>
			))}
		</>
	);
};

const bandDemHorizon = ({ d, w, h }: BandCtx) => {
	const yaw = d.solved.yaw;
	const rel = (az: number) => ((az - yaw + 540) % 360) - 180;
	const pts = d.horizon.profile
		.map((p) => [rel(p.az), p.el] as const)
		.sort((a, b) => a[0] - b[0]);
	const u0 = pts[0][0];
	const u1 = pts[pts.length - 1][0];
	const X = (u: number) => ((u - u0) / (u1 - u0)) * w;
	const els = pts.map((p) => p[1]);
	const lo = Math.min(...els) - 1;
	const hi = Math.max(...els) + 0.5;
	const Y = (e: number) => h - 22 - ((e - lo) / (hi - lo)) * (h - 44);
	const hf = d.solved.hfov / 2;
	const line = pts
		.map(([u, e], i) => `${i ? "L" : "M"}${X(u).toFixed(1)} ${Y(e).toFixed(1)}`)
		.join("");
	const fx0 = clamp(X(-hf), 0, w);
	const fx1 = clamp(X(hf), 0, w);
	return (
		<>
			<Ground w={w} h={h} />
			<rect x={fx0} y={0} width={fx1 - fx0} height={h} fill={PAPER_DEEP} />
			<Hachure
				d={`${line}L${w} ${h}L0 ${h}Z`}
				seed={`band-hz-fill-${d.id}`}
				color={TERRAIN}
				width={1}
				opacity={0.5}
				angle={-45}
				gap={6}
			/>
			<SketchPath
				d={line}
				data
				seed={`band-hz-line-${d.id}`}
				color={INK}
				width={1.6}
			/>
			<Txt x={(fx0 + fx1) / 2} y={14} anchor="middle" fill={SECONDARY}>
				photo frame
			</Txt>
		</>
	);
};

const bandViewport = ({ d, w, h }: BandCtx) => {
	const g = bandGeom(d, w, h);
	const c = widestGap(d);
	const y1 = d.priorRows[c];
	const y2 = d.solvedRows[c];
	const x = g.ox + (c + 0.5) * g.k;
	return (
		<>
			<PhotoImage d={d} g={g} />
			<Stroke
				d={linePath(d.priorRows, g)}
				color={PRIOR_COLOR}
				width={2}
				dash="6 4"
			/>
			<Stroke d={linePath(d.solvedRows, g)} color={SOLVED_COLOR} width={2} />
			{y1 != null && y2 != null && Math.abs(y2 - y1) * g.k > 5 && (
				<SketchPath
					d={`M${x} ${g.oy + y1 * g.k}L${x} ${g.oy + y2 * g.k}M${x - 3.5} ${g.oy + y2 * g.k - Math.sign(y2 - y1) * 6}L${x} ${g.oy + y2 * g.k}L${x + 3.5} ${g.oy + y2 * g.k - Math.sign(y2 - y1) * 6}`}
					data
					seed={`band-vp-arrow-${d.id}`}
					color="#fff"
					width={1.6}
				/>
			)}
		</>
	);
};

const bandPose = ({ d, w, h }: BandCtx) => {
	const bars = 200;
	const bw = w / bars;
	const base = h - 24;
	const out: ReactNode[] = [];
	let inlierEdges = "";
	let outlierEdges = "";
	for (let i = 0; i < bars; i++) {
		const c = i * 4;
		const a = d.skyline.rows[c];
		const b = d.solvedRows[c];
		if (a == null || b == null || d.skyline.weight[c] <= 0) continue;
		const r = Math.abs(a - b);
		const bh = Math.min(h - 44, r * 6);
		out.push(
			<rect
				key={i}
				x={i * bw}
				y={base - bh}
				width={bw * 0.7}
				height={bh}
				fill={r < INLIER_PX ? RESULT : ROUTE}
			/>,
		);
		const edge = `M${(i * bw).toFixed(2)} ${base}V${(base - bh).toFixed(2)}h${(bw * 0.7).toFixed(2)}V${base}`;
		if (r < INLIER_PX) inlierEdges += edge;
		else outlierEdges += edge;
	}
	return (
		<>
			<Ground w={w} h={h} />
			{out}
			{inlierEdges && (
				<SketchPath
					d={inlierEdges}
					data
					seed={`band-pose-in-${d.id}`}
					color={RESULT}
					width={1.2}
				/>
			)}
			{outlierEdges && (
				<SketchPath
					d={outlierEdges}
					data
					seed={`band-pose-out-${d.id}`}
					color={ROUTE}
					width={1.2}
				/>
			)}
			<PenLine
				from={[0, base - INLIER_PX * 6]}
				to={[w, base - INLIER_PX * 6]}
				data
				seed="band-pose-threshold"
				color={SECONDARY}
				width={1}
				dash="3 3"
			/>
			<Txt x={w} y={base - INLIER_PX * 6 - 4} anchor="end" fill={SECONDARY}>
				5 px
			</Txt>
			<Txt x={0} y={h - 8} fill={SECONDARY}>
				miss per column after solving
			</Txt>
		</>
	);
};

function Mark({ x, y, ok }: { x: number; y: number; ok: boolean }) {
	return (
		<SketchPath
			d={
				ok ? `M${x} ${y}l3 3l6 -7` : `M${x} ${y - 6}l7 7M${x + 7} ${y - 6}l-7 7`
			}
			seed={`band-mark-${ok ? "ok" : "no"}`}
			color={ok ? RESULT : ROUTE}
			width={1.8}
		/>
	);
}

const bandAccept = ({ d, all, w, h }: BandCtx) => {
	const x0 = 28;
	const x1 = w - 28;
	const rail = 112;
	const X = (v: number) => x0 + clamp(v, 0, 1) * (x1 - x0);
	const photos = GIPFELBUCH_PHOTO_IDS.map(
		(id) => all[id] ?? (id === d.id ? d : undefined),
	).filter((p): p is GipfelbuchPhotoData => !!p);
	const placed: { x: number; y: number; r: number; p: GipfelbuchPhotoData }[] =
		[];
	for (const p of [...photos].sort(
		(a, b) => a.solved.confidence - b.solved.confidence,
	)) {
		const r = p.id === d.id ? 6 : 3.5;
		const x = X(p.solved.confidence);
		let level = 0;
		for (;;) {
			const y = rail - 12 - level * 11;
			if (!placed.some((q) => Math.hypot(q.x - x, q.y - y) < q.r + r + 2)) {
				placed.push({ x, y, r, p });
				break;
			}
			level++;
		}
	}
	const me = placed.find((q) => q.p.id === d.id);
	const v = d.solved.confidence;
	const label = `${d.solved.accepted ? "accepted" : "refused"} ${v.toFixed(2)}`;
	const half = (monoWidth(label) + 14) / 2;
	const lx = clamp(X(v), 8 + half, w - 8 - half);
	return (
		<>
			<Ground w={w} h={h} />
			<PenLine
				from={[x0, rail]}
				to={[x1, rail]}
				seed="band-accept-rail"
				color={HAIRLINE}
				width={1}
			/>
			{[0, 0.5, 1].map((t) => (
				<g key={t}>
					<PenLine
						from={[X(t), rail]}
						to={[X(t), rail + 4]}
						seed={`band-accept-tick-${t}`}
						color={HAIRLINE}
						width={1}
					/>
					<Txt x={X(t)} y={rail + 17} anchor="middle" fill={SECONDARY}>
						{t.toFixed(1)}
					</Txt>
				</g>
			))}
			{placed.map((q) => (
				<g key={q.p.id}>
					<HandDot
						x={q.x}
						y={q.y}
						r={q.r}
						data
						seed={`band-accept-dot-${q.p.id}`}
						color={q.p.solved.accepted ? RESULT : ROUTE}
						opacity={1}
					/>
					{q.p.id === d.id && (
						<PenCircle
							center={[q.x, q.y]}
							radiusX={q.r}
							data
							seed={`band-accept-me-${q.p.id}`}
							color={INK}
							width={1.5}
						/>
					)}
				</g>
			))}
			{me && (
				<PenLine
					from={[me.x, 34]}
					to={[me.x, me.y - me.r - 2]}
					seed="band-accept-lead"
					color={HAIRLINE}
					width={1}
				/>
			)}
			<Mark x={lx - half} y={28} ok={d.solved.accepted} />
			<Txt x={lx - half + 14} y={28} fill={d.solved.accepted ? RESULT : ROUTE}>
				{label}
			</Txt>
		</>
	);
};

const bandTap = ({ d, w, h }: BandCtx) => {
	const g = bandGeom(d, w, h);
	const R = 11;
	const m = R + 12;
	const spots = framePeaks(d, { labelledOnly: true })
		.map((p) => ({
			p,
			x: g.ox + p.solved[0] * g.k,
			y: g.oy + p.solved[1] * g.k,
		}))
		.filter((o) => o.x > m && o.x < w - m - 12 && o.y > m && o.y < h - m)
		.sort((a, b) => b.p.dem - a.p.dem);
	const picked: typeof spots = [];
	for (const o of spots) {
		if (picked.length === 3) break;
		if (picked.every((q) => Math.hypot(q.x - o.x, q.y - o.y) > 3 * R))
			picked.push(o);
	}
	return (
		<>
			<PhotoImage d={d} g={g} />
			{picked.map((o, i) => (
				<g key={`${o.p.name}-${o.p.az}`}>
					<PenCircle
						center={[o.x, o.y]}
						radiusX={R}
						data
						seed={`band-tap-ring-${o.p.name}-${o.p.az}`}
						color="#fff"
						width={1.8}
					/>
					<HandDot
						x={o.x}
						y={o.y}
						r={2.4}
						data
						seed={`band-tap-dot-${o.p.name}-${o.p.az}`}
						color="#fff"
						opacity={1}
					/>
					<Txt x={o.x + R + 4} y={o.y - R + 2} onPhoto>
						{String(i + 1)}
					</Txt>
				</g>
			))}
		</>
	);
};

/** Square hillshade patch, north up, camera at the centre. */
function DemPatchImage({
	d,
	w,
	h,
}: {
	d: GipfelbuchPhotoData;
	w: number;
	h: number;
}) {
	return (
		<image
			href={d.demPatch.src}
			x={0}
			y={(h - w) / 2}
			width={w}
			height={w}
			preserveAspectRatio="none"
		/>
	);
}

const bandDemSource = ({ d, w, h }: BandCtx) => {
	const cx = w / 2;
	const cy = h / 2;
	const pxPerKm = w / (2 * d.demPatch.halfKm);
	return (
		<>
			<DemPatchImage d={d} w={w} h={h} />
			{[
				[2, -45],
				[5, 0],
				[10, -30],
			].map(([km, deg]) => {
				const r = km * pxPerKm;
				const a = (deg * Math.PI) / 180;
				return (
					<g key={km}>
						<PenCircle
							center={[cx, cy]}
							radiusX={r}
							data
							seed={`band-dems-ring-${km}`}
							color="#fff"
							opacity={0.85}
							width={1.2}
							dash="3 3"
						/>
						<Txt
							x={cx + Math.cos(a) * r + 4}
							y={cy + Math.sin(a) * r + 4}
							onPhoto
						>
							{`${km} km`}
						</Txt>
					</g>
				);
			})}
			<HandDot
				x={cx}
				y={cy}
				r={2.4}
				data
				seed="band-dems-centre"
				color="#fff"
				opacity={1}
			/>
		</>
	);
};

const bandEye = ({ d, w, h }: BandCtx) => {
	const g = d.gps.ground;
	const a = d.gps.alt;
	const eye = d.gps.eye;
	const up = clamp(Math.max(eye - g, 1.6), 1.6, 60);
	const lo = g - 6;
	const hi = g + up + 6;
	const top = 14;
	const bottom = h - 10;
	const Y = (e: number) =>
		bottom - ((clamp(e, lo, hi) - lo) / (hi - lo)) * (bottom - top);
	const off = (e: number) => (e < lo ? " ↓" : e > hi ? " ↑" : "");
	const xs = 80;
	const xe = w - 112;
	const labelX = w - 104;
	const rows = [
		{ y: Y(g), text: `ground ${f1(g)} m`, color: TERRAIN },
		{ y: Y(g + 1.6), text: "ground +1.6 m (eye)", color: SECONDARY },
		{ y: Y(a), text: `GPS ${f1(a)} m${off(a)}`, color: MEASURE },
	];
	const ly = spread(
		rows.map((r) => r.y + 4),
		14,
		12,
		h - 4,
	);
	const stemX = 24;
	const mid = (Y(g) + Y(eye)) / 2;
	return (
		<>
			<Ground w={w} h={h} />
			<rect x={0} y={Y(g)} width={w} height={h - Y(g)} fill={PAPER_DEEP} />
			<PenLine
				from={[0, Y(g)]}
				to={[xe, Y(g)]}
				data
				seed="band-eye-ground"
				color={TERRAIN}
				width={1.6}
			/>
			<PenLine
				from={[xs, Y(g + 1.6)]}
				to={[xe, Y(g + 1.6)]}
				data
				seed="band-eye-plus"
				color={SECONDARY}
				width={1.2}
				dash="3 3"
			/>
			<PenLine
				from={[xs, Y(a)]}
				to={[xe, Y(a)]}
				data
				seed="band-eye-gps"
				color={MEASURE}
				width={1.2}
				dash="6 3"
			/>
			<PenLine
				from={[stemX, Y(g)]}
				to={[stemX, Y(eye)]}
				data
				seed="band-eye-stem"
				color={ROUTE}
				width={2}
			/>
			<HandDot
				x={stemX}
				y={Y(eye)}
				r={4.5}
				data
				seed="band-eye-dot"
				color={ROUTE}
				opacity={1}
			/>
			<Txt x={stemX + 10} y={mid + 4} fill={ROUTE}>
				camera
			</Txt>
			{rows.map((r, i) => (
				<Txt key={r.text} x={labelX} y={ly[i]} fill={r.color}>
					{r.text}
				</Txt>
			))}
		</>
	);
};

const bandPeak = ({ d, w, h }: BandCtx) => {
	const g = bandGeom(d, w, h);
	const all = framePeaks(d, { labelledOnly: true })
		.map((p) => ({
			p,
			x: g.ox + p.solved[0] * g.k,
			y: g.oy + p.solved[1] * g.k,
		}))
		.filter((o) => o.x > 24 && o.x < w - 24 && o.y > 14 && o.y < h - 14);
	const roomy = all.filter((o) => o.y >= 68).sort((a, b) => b.p.dem - a.p.dem);
	const c = roomy[0] ?? all.sort((a, b) => b.y - a.y)[0];
	if (!c) return <PhotoImage d={d} g={g} />;
	// Label above the summit when there is room, otherwise below it; always inside the band.
	const below = c.y < 68;
	const name = c.p.name;
	const sub = `${Math.round(c.p.dem)} m · ${(c.p.distance / 1000).toFixed(0)} km`;
	const half = Math.max(nameWidth(name), monoWidth(sub)) / 2 + 6;
	const tx = clamp(c.x, half, w - half);
	const nameY = below ? c.y + 46 : c.y - 47;
	const subY = below ? c.y + 59 : c.y - 34;
	return (
		<>
			<PhotoImage d={d} g={g} />
			<PenLine
				from={[c.x, c.y + (below ? 4 : -4)]}
				to={[c.x, below ? nameY - 12 : subY + 4]}
				seed={`band-peak-leader-${name}`}
				color="#fff"
				width={1.2}
			/>
			<HandDot
				x={c.x}
				y={c.y}
				r={3}
				data
				seed={`band-peak-dot-${name}`}
				color="#fff"
				opacity={1}
			/>
			<Txt x={tx} y={nameY} anchor="middle" kind="name" onPhoto>
				{name}
			</Txt>
			<Txt x={tx} y={subY} anchor="middle" onPhoto>
				{sub}
			</Txt>
		</>
	);
};

const bandSnapping = ({ d, w, h }: BandCtx) => {
	const cx = w / 2;
	const cy = h / 2;
	const R = 150;
	const yaw = (d.solved.yaw * Math.PI) / 180;
	const hf = ((d.solved.hfov / 2) * Math.PI) / 180;
	const p = (a: number) =>
		[cx + Math.sin(a) * R, cy - Math.cos(a) * R] as const;
	const [x1, y1] = p(yaw - hf);
	const [x2, y2] = p(yaw + hf);
	return (
		<>
			<DemPatchImage d={d} w={w} h={h} />
			<path
				d={`M${cx} ${cy}L${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}Z`}
				fill={ROUTE}
				fillOpacity={0.28}
			/>
			<SketchPath
				d={`M${cx} ${cy}L${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}Z`}
				data
				seed={`band-snap-cone-${d.id}`}
				color="#fff"
				width={1.4}
			/>
			<HandDot
				x={cx}
				y={cy}
				r={3.5}
				data
				seed="band-snap-centre"
				color={ROUTE}
				opacity={1}
			/>
			<PenCircle
				center={[cx, cy]}
				radiusX={3.5}
				data
				seed="band-snap-centre-ring"
				color="#fff"
				width={1.2}
			/>
			<Txt x={10} y={h - 10} onPhoto>
				{`${d.solved.hfov.toFixed(0)}° wide, facing ${d.solved.yaw.toFixed(0)}°`}
			</Txt>
		</>
	);
};

const bandAnchoring = ({ d, w, h }: BandCtx) => {
	const pts = d.terrainProfile.points.filter((p) => p[0] > 30);
	const dmax = pts[pts.length - 1][0];
	const left = 16;
	const right = w - 22;
	const xs = (m: number) =>
		left + (Math.log(m / 30) / Math.log(dmax / 30)) * (right - left);
	const lo = Math.min(...pts.map((p) => p[1]));
	const hi = Math.max(...pts.map((p) => p[1]));
	const axis = h - 28;
	const ys = (e: number) =>
		axis - 8 - ((e - lo) / (hi - lo || 1)) * (axis - 8 - 28);
	const line = pts
		.map(
			(p, i) => `${i ? "L" : "M"}${xs(p[0]).toFixed(1)} ${ys(p[1]).toFixed(1)}`,
		)
		.join("");
	return (
		<>
			<Ground w={w} h={h} />
			<Txt x={left} y={14} fill={SECONDARY}>
				ground along the view (log scale)
			</Txt>
			<PenLine
				from={[left, axis]}
				to={[right, axis]}
				seed="band-anchor-axis"
				color={HAIRLINE}
				width={1}
			/>
			<SketchPath
				d={line}
				data
				seed={`band-anchor-line-${d.id}`}
				color={TERRAIN}
				width={1.6}
			/>
			{[100, 1000, 10000].map((m) =>
				m > dmax ? null : (
					<g key={m}>
						<PenLine
							from={[xs(m), axis]}
							to={[xs(m), axis + 5]}
							seed={`band-anchor-tick-${m}`}
							color={HAIRLINE}
							width={1}
						/>
						<Txt x={xs(m)} y={axis + 18} anchor="middle" fill={SECONDARY}>
							{m >= 1000 ? `${m / 1000} km` : `${m} m`}
						</Txt>
					</g>
				),
			)}
		</>
	);
};

const bandRigi = ({ w, h }: BandCtx) => (
	<image
		href={publicUrl("/demo/shots/demo-01-overlay.jpg")}
		width={w}
		height={h}
		preserveAspectRatio="xMidYMid slice"
	/>
);

const bandWorkspace = ({ d, w, h }: BandCtx) => {
	const g = bandGeom(d, w, h);
	const split = w * 0.52;
	const id = `gb-ix-pw-${d.id}`;
	return (
		<>
			<PhotoImage d={d} g={g} />
			<clipPath id={id}>
				<rect x={split} y={0} width={w - split} height={h} />
			</clipPath>
			<g clipPath={`url(#${id})`}>
				<PhotoImage d={d} g={g} />
				<Stroke d={linePath(d.solvedRows, g)} color={SOLVED_COLOR} width={2} />
				{framePeaks(d, { labelledOnly: true })
					.slice(0, 6)
					.map((p) => (
						<HandDot
							key={`${p.name}-${p.az}`}
							x={g.ox + p.solved[0] * g.k}
							y={g.oy + p.solved[1] * g.k}
							r={2.4}
							data
							seed={`band-ws-dot-${p.name}-${p.az}`}
							color="#fff"
							opacity={1}
						/>
					))}
			</g>
			<PenLine
				from={[split, 0]}
				to={[split, h]}
				seed={`band-ws-split-${d.id}`}
				color="#fff"
				width={2}
			/>
		</>
	);
};

const bandRoll = ({ d, all, w, h }: BandCtx) => {
	const photos = GIPFELBUCH_PHOTO_IDS.map(
		(id) => all[id] ?? (id === d.id ? d : undefined),
	)
		.filter((p): p is GipfelbuchPhotoData => !!p)
		.sort((a, b) => a.solved.yaw - b.solved.yaw);
	const yaws = photos.map((p) => p.solved.yaw);
	const tw = 36;
	const lo = Math.floor((Math.min(...yaws) - 8) / 10) * 10;
	const hi = Math.ceil((Math.max(...yaws) + 8) / 10) * 10;
	const left = 14 + tw / 2;
	const right = w - 14 - tw / 2;
	const X = (yaw: number) =>
		left + ((yaw - lo) / (hi - lo || 1)) * (right - left);
	const rule = 22;
	const ticks: ReactNode[] = [];
	for (let v = Math.ceil(lo / 10) * 10; v <= hi; v += 10) {
		const card = ((v % 360) + 360) % 360;
		const name = (
			{ 0: "N", 90: "E", 180: "S", 270: "W" } as Record<number, string>
		)[card];
		ticks.push(
			<g key={v}>
				<PenLine
					from={[X(v), rule]}
					to={[X(v), rule + (name ? 6 : 3)]}
					seed={`band-roll-tick-${v}`}
					color={HAIRLINE}
					width={1}
				/>
				{name && (
					<Txt x={X(v)} y={rule - 6} anchor="middle" fill={ROUTE}>
						{name}
					</Txt>
				)}
			</g>,
		);
	}
	const rowEnd: number[] = [];
	const rowPitch = 33;
	return (
		<>
			<Ground w={w} h={h} />
			<PenLine
				from={[left, rule]}
				to={[right, rule]}
				seed="band-roll-rule"
				color={HAIRLINE}
				width={1}
			/>
			{ticks}
			{photos.map((p) => {
				const x = X(p.solved.yaw);
				let row = rowEnd.findIndex((e) => e < x - tw / 2 - 2);
				if (row < 0) row = rowEnd.length < 3 ? rowEnd.length : 0;
				rowEnd[row] = x + tw / 2;
				const y = 34 + row * rowPitch;
				const th = (tw * p.photo.height) / p.photo.width;
				return (
					<g key={p.id} opacity={p.solved.accepted ? 1 : 0.5}>
						<PenLine
							from={[x, rule]}
							to={[x, y]}
							seed={`band-roll-stem-${p.id}`}
							color={HAIRLINE}
							width={0.8}
						/>
						<image
							href={p.photo.thumb}
							x={x - tw / 2}
							y={y}
							width={tw}
							height={th}
							preserveAspectRatio="xMidYMid slice"
						/>
						{p.id === d.id && (
							<SketchRect
								x={x - tw / 2 - 2}
								y={y - 2}
								width={tw + 4}
								height={th + 4}
								seed={`band-roll-me-${p.id}`}
								color={ROUTE}
								penWidth={1.5}
							/>
						)}
					</g>
				);
			})}
		</>
	);
};

const bandStepInside = ({ w, h }: BandCtx) => (
	<>
		<rect width={w} height={h} fill="#131313" />
		<image
			href={publicUrl("/demo/shots/drape.jpg")}
			width={w}
			height={h}
			preserveAspectRatio="xMidYMid slice"
		/>
	</>
);

// ---------------------------------------------------------------- the registry

const nullLayer: TafelLayer = () => null;

export const SHEETS: Record<string, SheetFigures> = {
	photo: {
		tafel: nullLayer,
		band: bandPhoto,
		ledger: (d) => [
			stat(d, "sensor.heading", "compass heading", {
				dec: 1,
				unit: "°",
			}),
			stat(d, "solved.delta.yaw", "compass error", {
				dec: 1,
				unit: "°",
				sign: true,
			}),
			stat(d, "gps.hAccuracy", "GPS accuracy", { unit: "m" }),
		],
		value: (d) =>
			`${d.gps.lat.toFixed(3)}, ${d.gps.lon.toFixed(3)} · ±${Math.round(d.gps.hAccuracy)} m`,
	},
	skyline: {
		tafel: tafelSkyline,
		band: bandSkyline,
		ledger: (d) => [
			stat(d, "residual.solved.n", "columns with a skyline, of 800"),
			stat(d, "residual.solved.median", "median miss vs terrain", {
				dec: 1,
				unit: "px",
			}),
			stat(d, "ms.skyline", "detection time", { unit: "ms" }),
		],
		value: (d) => `${votedColumns(d)}/800 columns · ${d.ms.skyline} ms`,
	},
	"dem-horizon": {
		tafel: tafelSolvedOnly,
		band: bandDemHorizon,
		ledger: (d) => [
			stat(d, "horizon.profile.length", "azimuths sampled"),
			stat(d, "residual.solved.within5", "columns within 5 px", {
				unit: "%",
			}),
			stat(d, "ms.horizon", "horizon time", { unit: "ms" }),
		],
		value: (d) => `${d.horizon.profile.length} azimuths · ${d.ms.horizon} ms`,
	},
	"viewport-inference": {
		tafel: ({ d, s }) => priorVsSolved(d, s, true),
		band: bandViewport,
		ledger: (d) => [
			stat(d, "solved.delta.yaw", "heading corrected by", {
				dec: 1,
				unit: "°",
				sign: true,
			}),
			stat(d, "residual.prior.median", "median miss before solving", {
				dec: 1,
				unit: "px",
			}),
			stat(d, "solved.confidence", "confidence", { dec: 2 }),
		],
		value: (d) =>
			`heading ${signed(d.solved.delta.yaw)}° · miss ${f1(d.residual.prior.median)} → ${f1(d.residual.solved.median)} px`,
	},
	"pose-estimate": {
		tafel: tafelPose,
		band: bandPose,
		ledger: (d) => [
			stat(d, "solved.residualPx", "miss after solving", {
				dec: 1,
				unit: "px",
			}),
			stat(d, "solved.inlierFraction", "columns that agree", { unit: "%" }),
			stat(d, "ms.solve", "to solve", { unit: "ms" }),
		],
		value: (d) =>
			`miss ${f1(d.solved.residualPx)} px · ${Math.round(d.solved.inlierFraction * 100)}% agree`,
	},
	"accept-rule": {
		tafel: tafelAccept,
		band: bandAccept,
		ledger: (d) => [
			stat(d, "solved.confidence", "confidence", { dec: 2 }),
			stat(d, "solved.inlierFraction", "columns that agree", { unit: "%" }),
			stat(d, "solved.ambiguity", "ambiguity (0 = clear winner)", { dec: 2 }),
		],
		value: (d) =>
			`confidence ${d.solved.confidence.toFixed(2)} · ${d.solved.accepted ? "accepted" : "refused"}`,
	},
	"tap-a-peak": {
		tafel: tafelTap,
		band: bandTap,
		ledger: (d) => {
			const [near, far] = labelledExtremes(d);
			return [
				stat(d, "peaks.length", "named summits in view"),
				stat(d, `peaks.${near}.distance`, `nearest: ${d.peaks[near]?.name}`, {
					dec: 1,
					unit: "km",
				}),
				stat(d, `peaks.${far}.distance`, `farthest: ${d.peaks[far]?.name}`, {
					dec: 1,
					unit: "km",
				}),
			];
		},
		value: (d) =>
			`${d.peaks.filter((p) => p.labelled).length} named summits in view`,
	},
	"dem-source": {
		tafel: null,
		band: bandDemSource,
		ledger: (d) => [
			stat(d, "gps.ground", "ground height under the camera", {
				dec: 1,
				unit: "m",
			}),
			stat(d, "demPatch.min", "lowest point", { unit: "m" }),
			stat(d, "demPatch.max", "highest point", { unit: "m" }),
		],
		value: (d) =>
			`±${d.demPatch.halfKm} km · ${d.demPatch.min}–${d.demPatch.max} m`,
	},
	"eye-rule": {
		tafel: null,
		band: bandEye,
		ledger: (d) => [
			stat(d, "gps.ground", "terrain-model ground", { dec: 1, unit: "m" }),
			stat(d, "gps.alt", "GPS altitude", { dec: 1, unit: "m" }),
			stat(d, "gps.eye", "camera height used", { dec: 1, unit: "m" }),
		],
		value: (d) => `camera ${f1(d.gps.eye)} m · ground ${f1(d.gps.ground)} m`,
	},
	peak: {
		tafel: tafelPeak,
		band: bandPeak,
		ledger: (d) => {
			const i = highestPeakIndex(d);
			return [
				stat(
					d,
					`peaks.${i}.dem`,
					`${d.peaks[i]?.name ?? "highest named"}, height`,
					{ unit: "m" },
				),
				stat(d, `peaks.${i}.distance`, "distance", { dec: 1, unit: "km" }),
				stat(d, `peaks.${i}.el`, "angle above horizon", {
					dec: 1,
					unit: "°",
				}),
			];
		},
		value: (d) => `${d.peaks.filter((p) => p.visible).length} visible summits`,
	},
	"terrain-snapping": {
		tafel: null,
		band: bandSnapping,
		ledger: (d) => [
			stat(d, "solved.hfov", "field of view", { unit: "°" }),
			stat(d, "solved.yaw", "heading", { dec: 1, unit: "°" }),
			stat(d, "demPatch.halfKm", "patch half-width", { unit: "km", scale: 1 }),
		],
		value: (d) =>
			`${d.solved.hfov.toFixed(0)}° wide, facing ${d.solved.yaw.toFixed(0)}°`,
	},
	"dem-anchoring": {
		tafel: null,
		band: bandAnchoring,
		ledger: (d) => {
			const n = d.terrainProfile.points.length;
			return [
				stat(d, `terrainProfile.points.${n - 1}.0`, "depth", {
					unit: "km",
				}),
				stat(d, "terrainProfile.points.length", "ground samples"),
				stat(d, "terrainProfile.azimuth", "direction", { dec: 1, unit: "°" }),
			];
		},
		value: (d) => {
			const n = d.terrainProfile.points.length;
			return `depth to ${(d.terrainProfile.points[n - 1][0] / 1000).toFixed(0)} km along the view`;
		},
	},
	rigi: {
		tafel: tafelSolvedOnly,
		band: bandRigi,
		ledger: (d) => [
			stat(d, "solved.residualPx", "alignment error", { dec: 1, unit: "px" }),
			stat(d, "solved.confidence", "confidence", { dec: 2 }),
			stat(d, "solved.yaw", "heading", { dec: 1, unit: "°" }),
		],
		value: (d) =>
			`miss ${f1(d.solved.residualPx)} px · confidence ${d.solved.confidence.toFixed(2)}`,
	},
	"photo-workspace": {
		tafel: tafelSolvedOnly,
		band: bandWorkspace,
		ledger: (d) => [
			stat(d, "solved.pitch", "pitch", { dec: 1, unit: "°" }),
			stat(d, "solved.roll", "roll", { dec: 1, unit: "°" }),
			stat(d, "solved.f", "focal length", { unit: "px" }),
		],
		value: () => "overlay · align · pin · export",
	},
	"camera-roll": {
		tafel: nullLayer,
		band: bandRoll,
		ledger: (d) => [
			stat(d, "solved.yaw", "heading", { dec: 1, unit: "°" }),
			stat(d, "gps.hAccuracy", "GPS accuracy", { unit: "m" }),
			stat(d, "solved.confidence", "confidence", { dec: 2 }),
		],
		value: (d) => `12 photos · one spot · this one faces ${f1(d.solved.yaw)}°`,
	},
	"step-inside": {
		tafel: null,
		band: bandStepInside,
		ledger: (d) => [
			stat(d, "gps.eye", "camera height above sea level", {
				dec: 1,
				unit: "m",
			}),
			stat(d, "solved.hfov", "field of view", { dec: 1, unit: "°" }),
			stat(d, "solved.f", "focal length", { unit: "px" }),
		],
		value: () => "splats on the terrain",
	},
};
