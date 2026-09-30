// Peak label layout for the 'panorama' and 'inline' label styles (ViewStyle.labels.layout): pure TS,
// no DOM (runs in node for look/__tests__/labels.check.ts). 'classic' is rank.ts + the DOM labels.
//
// Two styles:
// - 'panorama' (PeakFinder / Berann): a 1 px vertical leader rises from each summit to a label
//   band above the local skyline. Text is rotated (default 50°, rising to the right) or, with
//   `angle: 0`, horizontal in staggered rows. Parallel rotated labels only need clearance across
//   their common direction, so the collision test packs 1-D intervals on the across-text axis
//   (plus an along-text interval check). A label that doesn't fit on its row tries higher rows.
// - 'inline': horizontal labels next to the summit, trying N, NE, NW, E, W greedily by priority.
//
// Priority = log prominence + elevation − log distance + centre bias + screen isolation, visible
// peaks only. Hysteresis: with `prev`, labels already shown get a score bonus and try their
// previous row/slot first, so small pose changes don't make labels swap or flicker.

export type LabelCandidate = {
	id: string;
	name: string;
	ele: number | null;
	prominence: number | null;
	distKm: number;
	/** summit anchor, px */
	x: number;
	y: number;
	visible: boolean;
	/** skyline y (px) at this x, if known */
	skylineY?: number;
};

export type LayoutKind = "panorama" | "inline";

export type LayoutOptions = {
	width: number;
	height: number;
	/** base font size (tier 1 name), px */
	fontPx: number;
	/** text width in px for a CSS font string; defaults to an approximation for Manrope */
	measure?: (text: string, font: string) => number;
	maxLabels?: number;
	topMarginPx?: number;
	/** clearance between labels, px */
	minGapPx?: number;
	style: LayoutKind;
	/** panorama text angle in degrees above horizontal (default 50; 0 = horizontal rows) */
	angle?: number;
	/** per-column skyline as a fraction of height from the top (see skylineAt) */
	skyline?: Float32Array;
	/** font family used for measuring (default the app stack) */
	fontFamily?: string;
	/** max rows stacked above the band (panorama) */
	maxRows?: number;
	/** panorama band smoothing radius, px (default 3 × fontPx) */
	bandSmoothPx?: number;
};

export type PlacedLabel = LabelCandidate & {
	/** text anchor point (baseline), px */
	labelX: number;
	labelY: number;
	leader: [number, number, number, number] | null;
	/** degrees, SVG sense (negative = rising to the right) */
	rotation: number;
	opacity: number;
	tier: 0 | 1 | 2;
	/** panorama row (0 = lowest) or inline slot index */
	row: number;
	textAnchor: "start" | "middle" | "end";
	/** text box size in px (unrotated) */
	textW: number;
	textH: number;
	/** text box corners (px) for hit tests */
	quad: [number, number][];
	score: number;
	style: LayoutKind;
};

export const LABEL_FONT_FAMILY =
	"Manrope, ui-sans-serif, system-ui, sans-serif";

/** Typography per tier: name size/weight, elevation size/weight (px, relative to fontPx). */
export function tierFonts(
	tier: 0 | 1 | 2,
	fontPx: number,
	family = LABEL_FONT_FAMILY,
) {
	const k = tier === 0 ? 1.14 : tier === 1 ? 1 : 0.88;
	const size = fontPx * k;
	const eleSize = size * 0.8;
	const weight = tier === 0 ? 700 : tier === 1 ? 600 : 500;
	return {
		size,
		eleSize,
		weight,
		name: `${weight} ${size.toFixed(2)}px ${family}`,
		ele: `400 ${eleSize.toFixed(2)}px ${family}`,
		/** gap between name and elevation, px */
		gap: size * 0.3,
	};
}

export function formatEle(ele: number | null) {
	return ele == null ? "" : String(Math.round(ele));
}

/** Elevation text shown after the name ('' when unknown or when the name already is the number). */
export function eleSuffix(c: { name: string; ele: number | null }) {
	const e = formatEle(c.ele);
	return e && c.name.trim() !== e ? e : "";
}

// Rough Manrope advance widths (em) when no measure function is given.
function approxMeasure(text: string, font: string) {
	const m = font.match(/([\d.]+)px/);
	const px = m ? Number(m[1]) : 14;
	const bold = /^\s*[6-9]\d\d/.test(font);
	let w = 0;
	for (const ch of text) {
		if (ch === " ") w += 0.26;
		else if (/[0-9]/.test(ch)) w += 0.6;
		else if (/[iljI.,'’:;!|]/.test(ch)) w += 0.28;
		else if (/[mwMW]/.test(ch)) w += 0.86;
		else if (/[A-Z]/.test(ch)) w += 0.68;
		else w += 0.55;
	}
	return w * px * (bold ? 1.04 : 1);
}

let measureCanvas: {
	ctx: CanvasRenderingContext2D;
	cache: Map<string, number>;
} | null = null;

// Web-font state. Manrope comes from Google Fonts (display=swap), so a label laid out before its
// face arrives is measured with the fallback font. Those widths used to be cached for good, and the
// layout was not redone when the face arrived: the final placement then depended on whether the
// font or the first label layout came first (the style-baseline peak-label flake, 2026-09-30).
// Now a width is cached only once its face is loaded (or its load has settled without one: blocked
// or offline, the fallback is final), the load is requested once per font + text, and a finished
// font load after any fallback measurement clears the cache and bumps labelFontEpoch() so the
// layouts can re-run (useLabelFontEpoch in useLabelFonts.ts). A layout's `prev` from an older
// epoch is ignored (prevIsCurrent), so the re-run places labels fresh instead of following spots
// chosen with fallback widths; within one epoch the hysteresis is unchanged.
let fontEpoch = 0;
const fontListeners = new Set<() => void>();
let fontWatch = false;
/** a width was measured with a face still loading since the last epoch bump */
let fallbackUsed = false;
/** font|text → its load has settled (true) or is in flight (false) */
const fontRequested = new Map<string, boolean>();
/** epoch each layout result was computed in (keyed by the returned array) */
const layoutEpochs = new WeakMap<object, number>();

/** Bumped when a font load finishes after a fallback measurement: a layout keyed on it re-runs. */
export const labelFontEpoch = () => fontEpoch;

/** Calls `cb` after each labelFontEpoch() bump; returns the unsubscribe. */
export function subscribeLabelFonts(cb: () => void) {
	fontListeners.add(cb);
	return () => {
		fontListeners.delete(cb);
	};
}

/** Records the font epoch a layout result was measured in (for prevIsCurrent). */
export function stampFontEpoch<T extends object>(placed: T): T {
	layoutEpochs.set(placed, fontEpoch);
	return placed;
}

/** False when `prev` was laid out before the last font change (its spots used stale widths). */
export function prevIsCurrent(prev: object | undefined) {
	if (!prev) return true;
	const e = layoutEpochs.get(prev);
	return e === undefined || e === fontEpoch;
}

/** True when `text` in `font` measures with its final face (no web font still to load for it). */
function fontSettled(font: string, text: string) {
	const fonts = typeof document !== "undefined" ? document.fonts : undefined;
	if (!fonts?.check) return true;
	if (!fontWatch) {
		fontWatch = true;
		fonts.addEventListener("loadingdone", () => {
			if (!fallbackUsed) return;
			fallbackUsed = false;
			measureCanvas?.cache.clear();
			fontEpoch++;
			for (const cb of fontListeners) cb();
		});
	}
	try {
		if (fonts.check(font, text)) return true;
	} catch {
		return true; // an unparsable font string: nothing to wait for
	}
	const key = `${font}|${text}`;
	const settled = fontRequested.get(key);
	if (settled) return true; // loaded nothing (blocked, offline, no such face): the fallback is final
	if (settled === undefined) {
		if (fontRequested.size > 4000) fontRequested.clear();
		fontRequested.set(key, false);
		fonts
			.load(font, text)
			.catch(() => {})
			.finally(() => fontRequested.set(key, true));
	}
	fallbackUsed = true;
	return false;
}

/** Canvas-based text measurement (browser only); falls back to the approximation elsewhere. */
export function canvasMeasure(text: string, font: string) {
	if (typeof document === "undefined") return approxMeasure(text, font);
	if (!measureCanvas) {
		const ctx = document.createElement("canvas").getContext("2d");
		if (!ctx) return approxMeasure(text, font);
		measureCanvas = { ctx, cache: new Map() };
	}
	const key = `${font}|${text}`;
	let w = measureCanvas.cache.get(key);
	if (w == null) {
		measureCanvas.ctx.font = font;
		w = measureCanvas.ctx.measureText(text).width;
		// a fallback-font width is used now but not kept: the loadingdone handler re-runs the layouts
		if (fontSettled(font, text)) {
			if (measureCanvas.cache.size > 4000) measureCanvas.cache.clear();
			measureCanvas.cache.set(key, w);
		}
	}
	return w;
}

/**
 * Skyline per geometry column: the topmost terrain row as a fraction of the height from the top
 * (1 = no terrain). Terrain is a finite range > 0 at `channel` of each `stride`-float texel: three's
 * geoBuf is RGBA with the range in a (row 0 = bottom), deck's range buffer r32 (row 0 = top, ∞ = sky).
 */
export function skylineAt(
	range: Float32Array,
	w: number,
	h: number,
	{ rowsTopDown = false, stride = 4, channel = 3 } = {},
) {
	const out = new Float32Array(w).fill(1);
	for (let c = 0; c < w; c++) {
		for (let t = 0; t < h; t++) {
			const v =
				range[((rowsTopDown ? t : h - 1 - t) * w + c) * stride + channel];
			if (v > 0 && v < Number.POSITIVE_INFINITY) {
				out[c] = t / h;
				break;
			}
		}
	}
	return out;
}

/** Engine peak labels (u, v normalised, v down) → layout candidates on a w × h px stage. */
export function candidatesFrom(
	peaks: {
		name: string;
		ele: number | null;
		prominence?: number | null;
		distKm: number;
		u: number;
		v: number;
		world: [number, number, number];
	}[],
	w: number,
	h: number,
	skyline?: Float32Array | null,
): LabelCandidate[] {
	return peaks.map((p) => ({
		id: `${p.name}|${p.world[0]}`,
		name: p.name,
		ele: p.ele,
		prominence: p.prominence ?? null,
		distKm: p.distKm,
		x: p.u * w,
		y: p.v * h,
		visible: true,
		skylineY: skyline?.length
			? skyline[
					Math.min(
						skyline.length - 1,
						Math.max(0, Math.floor(p.u * skyline.length)),
					)
				] * h
			: undefined,
	}));
}

// ---- geometry -------------------------------------------------------------------------------

type Pt = [number, number];

/** Separating-axis test for two convex polygons (either may be a 2-point segment). */
function polysOverlap(a: Pt[], b: Pt[], pad = 0) {
	return !(hasSeparatingAxis(a, b, pad) || hasSeparatingAxis(b, a, pad));
}

function hasSeparatingAxis(a: Pt[], b: Pt[], pad: number) {
	const n = a.length;
	const edges = n === 2 ? 1 : n;
	for (let i = 0; i < edges; i++) {
		const p = a[i];
		const q = a[(i + 1) % n];
		let ax = -(q[1] - p[1]);
		let ay = q[0] - p[0];
		const len = Math.hypot(ax, ay);
		if (len < 1e-9) continue;
		ax /= len;
		ay /= len;
		let amin = Number.POSITIVE_INFINITY;
		let amax = Number.NEGATIVE_INFINITY;
		for (const v of a) {
			const d = v[0] * ax + v[1] * ay;
			if (d < amin) amin = d;
			if (d > amax) amax = d;
		}
		let bmin = Number.POSITIVE_INFINITY;
		let bmax = Number.NEGATIVE_INFINITY;
		for (const v of b) {
			const d = v[0] * ax + v[1] * ay;
			if (d < bmin) bmin = d;
			if (d > bmax) bmax = d;
		}
		if (amax + pad <= bmin || bmax + pad <= amin) return true;
	}
	return false;
}

/** Text box corners: origin at the baseline anchor, rotated by `angleDeg` above horizontal. */
function textQuad(
	x: number,
	y: number,
	w: number,
	fontPx: number,
	angleDeg: number,
	anchor: "start" | "middle" | "end",
): Pt[] {
	const a = (angleDeg * Math.PI) / 180;
	const ux = Math.cos(a);
	const uy = -Math.sin(a);
	// "up" in text space
	const vx = -Math.sin(a);
	const vy = -Math.cos(a);
	const s0 = anchor === "start" ? 0 : anchor === "middle" ? -w / 2 : -w;
	const s1 = s0 + w;
	const t0 = -0.24 * fontPx;
	const t1 = 0.78 * fontPx;
	const at = (s: number, t: number): Pt => [
		x + ux * s + vx * t,
		y + uy * s + vy * t,
	];
	return [at(s0, t0), at(s1, t0), at(s1, t1), at(s0, t1)];
}

function quadBounds(q: Pt[]) {
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (const [x, y] of q) {
		if (x < x0) x0 = x;
		if (x > x1) x1 = x;
		if (y < y0) y0 = y;
		if (y > y1) y1 = y;
	}
	return { x0, y0, x1, y1 };
}

/** True if two placed labels' text boxes overlap (exported for tests). */
export function labelsOverlap(a: PlacedLabel, b: PlacedLabel, pad = 0) {
	return polysOverlap(a.quad, b.quad, pad);
}

// ---- scoring --------------------------------------------------------------------------------

type Scored = { c: LabelCandidate; score: number; prev?: PlacedLabel };

const HYSTERESIS = 1.1;
/** `row` values >= SLOT_ROW are inline slots (SLOT_ROW + index into N, NE, NW, E, W) */
export const SLOT_ROW = 100;

function scoreCandidates(
	cands: LabelCandidate[],
	width: number,
	prevById: Map<string, PlacedLabel>,
) {
	const vis = cands.filter(
		(c) => c.visible && Number.isFinite(c.x) && Number.isFinite(c.y),
	);
	const out: Scored[] = [];
	const isoR = Math.max(1, width * 0.12);
	for (const c of vis) {
		const prom =
			c.prominence ??
			(c.ele != null ? Math.min(250, Math.max(40, (c.ele - 1200) * 0.1)) : 60);
		const sProm = Math.log10(1 + Math.max(0, prom));
		const sEle = (c.ele ?? 1200) / 1000;
		const sDist = -Math.log10(Math.max(0.3, c.distKm));
		const centre = 1 - Math.min(1, Math.abs(c.x / width - 0.5) * 2);
		// screen isolation: distance to the nearest candidate that stands higher in the image
		let nearest = isoR;
		for (const o of vis) {
			if (o === c || o.y >= c.y - 0.5) continue;
			const d = Math.abs(o.x - c.x) + 0.5 * (c.y - o.y);
			if (d < nearest) nearest = d;
		}
		const iso = nearest / isoR;
		const prev = prevById.get(c.id);
		const score =
			1.1 * sProm +
			0.7 * sEle +
			1.3 * sDist +
			0.35 * centre +
			1.1 * iso +
			(prev ? HYSTERESIS : 0);
		out.push({ c, score, prev });
	}
	out.sort((a, b) => b.score - a.score);
	return out;
}

function tierFor(rank: number, maxLabels: number): 0 | 1 | 2 {
	const t0 = Math.max(2, Math.round(maxLabels * 0.14));
	const t1 = Math.max(t0 + 3, Math.round(maxLabels * 0.45));
	return rank < t0 ? 0 : rank < t1 ? 1 : 2;
}

function opacityFor(tier: 0 | 1 | 2, distKm: number) {
	const far = Math.min(1, Math.max(0, (distKm - 25) / 95));
	const base = tier === 0 ? 1 : tier === 1 ? 0.95 : 0.82;
	return Math.round((base - 0.28 * far * far * (3 - 2 * far)) * 100) / 100;
}

// ---- layout ---------------------------------------------------------------------------------

type Box = { x0: number; y0: number; x1: number; y1: number };
type Obstacle = { quad: Pt[]; b: Box };

function obstacle(quad: Pt[]): Obstacle {
	return { quad, b: quadBounds(quad) };
}

/** cheap AABB pre-test before the SAT */
function boxesNear(a: Box, b: Box, pad: number) {
	return (
		a.x0 < b.x1 + pad &&
		b.x0 < a.x1 + pad &&
		a.y0 < b.y1 + pad &&
		b.y0 < a.y1 + pad
	);
}

export function layoutLabels(
	cands: LabelCandidate[],
	opts: LayoutOptions,
	prev?: PlacedLabel[],
): PlacedLabel[] {
	const { width: W, height: H, fontPx, style } = opts;
	const measure = opts.measure ?? approxMeasure;
	const maxLabels = opts.maxLabels ?? 28;
	const topMargin = opts.topMarginPx ?? Math.round(fontPx * 0.6);
	const gap = opts.minGapPx ?? Math.round(fontPx * 0.35);
	const family = opts.fontFamily ?? LABEL_FONT_FAMILY;
	const angle =
		style === "panorama" ? Math.max(0, Math.min(75, opts.angle ?? 50)) : 0;
	const maxRows = opts.maxRows ?? (angle > 0 ? 3 : 4);
	const edge = Math.round(fontPx * 0.35);

	const prevById = new Map<string, PlacedLabel>();
	// a prev laid out before the last font change is stale (fallback-font widths): start fresh
	if (prev && prevIsCurrent(prev))
		for (const p of prev) if (p.style === style) prevById.set(p.id, p);
	const scored = scoreCandidates(cands, W, prevById);

	// label band: skyline smoothed by a running minimum over ±bandR px so neighbouring labels
	// share a baseline (tidier than following every notch of the ridge)
	const sky = opts.skyline;
	let band: Float32Array | null = null;
	if (sky?.length && style === "panorama") {
		const n = sky.length;
		const r = Math.max(
			0,
			Math.round(((opts.bandSmoothPx ?? fontPx * 3) / W) * n),
		);
		band = new Float32Array(n);
		// sliding-window minimum (monotonic deque), O(n)
		const dq = new Int32Array(n);
		let head = 0;
		let tail = 0;
		let next = 0;
		for (let i = 0; i < n; i++) {
			const hi = Math.min(n - 1, i + r);
			for (; next <= hi; next++) {
				while (tail > head && sky[dq[tail - 1]] >= sky[next]) tail--;
				dq[tail++] = next;
			}
			while (dq[head] < i - r) head++;
			band[i] = sky[dq[head]] * H;
		}
	}
	const bandAt = (x: number) => {
		if (!band) return Number.POSITIVE_INFINITY;
		const c = Math.min(
			band.length - 1,
			Math.max(0, Math.floor((x / W) * band.length)),
		);
		return band[c];
	};

	const placed: PlacedLabel[] = [];
	const texts: Obstacle[] = [];
	const leaders: Obstacle[] = [];
	const summits: Obstacle[] = [];
	const summitR = Math.max(3, fontPx * 0.3);

	// labels already on screen get a looser clearance (geometric hysteresis)
	const fits = (q: Pt[], lead: Pt[] | null, shown: boolean) => {
		const b = quadBounds(q);
		// inline labels sit side by side, so they need more air than parallel rotated ones
		const g = (shown ? 0.4 : 1) * (style === "inline" ? gap * 2.4 : gap);
		if (b.x0 < edge || b.x1 > W - edge || b.y0 < topMargin || b.y1 > H - edge)
			return false;
		for (const t of texts)
			if (boxesNear(b, t.b, g) && polysOverlap(q, t.quad, g)) return false;
		for (const l of leaders)
			if (boxesNear(b, l.b, g) && polysOverlap(q, l.quad, g * 0.5))
				return false;
		for (const s of summits)
			if (boxesNear(b, s.b, g * 0.6) && polysOverlap(q, s.quad, g * 0.6))
				return false;
		if (lead) {
			const lb = quadBounds(lead);
			for (const t of texts)
				if (boxesNear(lb, t.b, 1) && polysOverlap(lead, t.quad, 1))
					return false;
		}
		return true;
	};

	const tick = Math.max(3, fontPx * 0.25);
	const lineH = fontPx * 1.2;
	let rank = 0;
	// bound the work when most candidates can't be placed (hundreds of peaks in frame)
	const maxAttempts = Math.max(maxLabels * 6, 60);
	let attempts = 0;
	for (const s of scored) {
		if (placed.length >= maxLabels || attempts++ >= maxAttempts) break;
		const c = s.c;
		const rankTier = tierFor(rank, maxLabels);
		// keep the previous tier unless the rank moved by more than one tier (no size popping)
		const tier =
			s.prev && Math.abs(s.prev.tier - rankTier) < 2 ? s.prev.tier : rankTier;
		const f = tierFonts(tier, fontPx, family);
		const eleStr = eleSuffix(c);
		const textW =
			measure(c.name, f.name) + (eleStr ? f.gap + measure(eleStr, f.ele) : 0);
		const textH = f.size;
		const summitBox: Pt[] = [
			[c.x - summitR, c.y - summitR],
			[c.x + summitR, c.y - summitR],
			[c.x + summitR, c.y + summitR],
			[c.x - summitR, c.y + summitR],
		];
		// own summit must not be covered by already placed text
		const sb = quadBounds(summitBox);
		const sp = (style === "inline" ? gap * 2.4 : gap) * 0.6;
		if (
			texts.some(
				(t) => boxesNear(sb, t.b, sp) && polysOverlap(summitBox, t.quad, sp),
			)
		)
			continue;

		type Spot = {
			lx: number;
			ly: number;
			q: Pt[];
			lead: [number, number, number, number] | null;
			row: number;
			anchor: "start" | "middle" | "end";
			rot: number;
		};
		const shown = !!s.prev;

		// panorama rows: band baseline clears the skyline (and the summit) under the whole footprint
		let tryRow: (r: number) => Spot | null = () => null;
		let bandOffImage = style !== "panorama";
		if (style === "panorama") {
			const a = (angle * Math.PI) / 180;
			const tanA = Math.tan(a);
			const anchor: "start" | "middle" = angle > 0 ? "start" : "middle";
			const xa =
				anchor === "start" ? c.x - textH * Math.sin(a) : c.x - textW / 2;
			const xb =
				anchor === "start" ? c.x + textW * Math.cos(a) : c.x + textW / 2;
			let base = Math.min(
				c.y - fontPx * 1.8,
				c.skylineY != null
					? c.skylineY - fontPx * 0.9
					: Number.POSITIVE_INFINITY,
			);
			if (band) {
				const step = Math.max(1, W / band.length);
				for (let x = Math.max(0, xa); x <= Math.min(W - 1, xb); x += step) {
					// rotated text rises to the right, so terrain further right may be higher
					const rise = anchor === "start" ? Math.max(0, x - c.x) * tanA : 0;
					const yb = bandAt(x) + rise - fontPx * 0.9;
					if (yb < base) base = yb;
				}
			}
			const rowStep =
				angle > 0 ? (lineH + gap) / Math.cos(a) : lineH + gap * 0.5;
			bandOffImage =
				base - (angle > 0 ? textW * Math.sin(a) : textH) < topMargin;
			tryRow = (r) => {
				const ly = base - r * rowStep;
				const q = textQuad(c.x, ly, textW, textH, angle, anchor);
				const lead: [number, number, number, number] = [
					c.x,
					c.y - tick,
					c.x,
					ly + fontPx * 0.3,
				];
				const seg: Pt[] = [
					[lead[0], lead[1]],
					[lead[2], lead[3]],
				];
				return fits(q, seg, shown)
					? { lx: c.x, ly, q, lead, row: r, anchor, rot: -angle }
					: null;
			};
		}

		// inline slots (also the panorama fallback when the band is off-image): N, NE, NW, E, W
		const d = summitR + fontPx * 0.35;
		const slots: {
			dx: number;
			dy: number;
			anchor: "start" | "middle" | "end";
		}[] = [
			{ dx: 0, dy: -d - fontPx * 0.25, anchor: "middle" },
			{ dx: d * 0.8, dy: -d * 0.8, anchor: "start" },
			{ dx: -d * 0.8, dy: -d * 0.8, anchor: "end" },
			{ dx: d + 2, dy: fontPx * 0.3, anchor: "start" },
			{ dx: -d - 2, dy: fontPx * 0.3, anchor: "end" },
		];
		const trySlot = (i: number): Spot | null => {
			const sl = slots[i];
			const lx = c.x + sl.dx;
			const ly = c.y + sl.dy;
			const q = textQuad(lx, ly, textW, textH, 0, sl.anchor);
			return fits(q, null, shown)
				? {
						lx,
						ly,
						q,
						lead: null,
						row: SLOT_ROW + i,
						anchor: sl.anchor,
						rot: 0,
					}
				: null;
		};

		// attempt order: previous placement first (hysteresis), then rows bottom-up, then slots
		const order: number[] = [];
		if (
			s.prev &&
			((s.prev.row < maxRows && style === "panorama") ||
				(s.prev.row >= SLOT_ROW && bandOffImage))
		)
			order.push(s.prev.row);
		if (style === "panorama") for (let r = 0; r < maxRows; r++) order.push(r);
		if (bandOffImage)
			for (let i = 0; i < slots.length; i++) order.push(SLOT_ROW + i);
		let best: Spot | null = null;
		for (let k = 0; k < order.length && !best; k++) {
			const r = order[k];
			if (k > 0 && r === order[0]) continue;
			if (r >= SLOT_ROW) best = trySlot(r - SLOT_ROW);
			else if (style === "panorama") best = tryRow(r);
		}

		if (!best) continue;
		const p: PlacedLabel = {
			...c,
			labelX: best.lx,
			labelY: best.ly,
			leader: best.lead,
			rotation: best.rot,
			opacity: opacityFor(tier, c.distKm),
			tier,
			row: best.row,
			textAnchor: best.anchor,
			textW,
			textH,
			quad: best.q,
			score: s.score,
			style,
		};
		placed.push(p);
		texts.push(obstacle(best.q));
		if (best.lead) {
			leaders.push(
				obstacle([
					[best.lead[0], best.lead[1]],
					[best.lead[2], best.lead[3]],
				]),
			);
		}
		summits.push(obstacle(summitBox));
		rank++;
	}
	return stampFontEpoch(placed);
}
