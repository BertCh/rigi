// CPU side of the terroir terrain shading (./terrain.ts): which TERROIR_* defines a style needs, the
// cover texture's ENU → UV mapping, the dated snowline, the Swiss index and the adaptive contour
// levels, packed as TER_BLOCK values. Engine-agnostic (deck terrain-layer.ts, three engine.ts).
import type { ViewStyle } from "#/lib/style/types";
import { CONTOUR_INK, COVER_CLASSES } from "../classes";
import type { CoverGrid } from "../pack";

export type TerroirDefine =
	| "TERROIR_CONTOUR_ADAPTIVE"
	| "TERROIR_CONTOUR_INK"
	| "TERROIR_COVER"
	| "TERROIR_SNOW";

/** Anything with EnuFrame.fromGeo (#/lib/geodesy). */
type Frame = {
	fromGeo(lat: number, lon: number, h: number): number[];
};

/**
 * ENU (x, y) → cover texture (u, v) as a quadratic, u = a + b·x + c·y + d·x·y + e·x² + f·y² (likewise
 * v), least-squares over an 11 × 11 lattice of the pack's bbox at `hRef` m. A plain affine map leaves
 * ~100 m at the edges of a 70 km pack (the parallels curve away from the tangent plane's x axis by
 * x²·tan φ / 2R, the meridians converge: the x² and x·y terms); the quadratic leaves < 1 m.
 * `errM`: worst lattice residual (m). Mesh vertices sit at their own height, which shifts their
 * tangent-plane (x, y) by ≈ (h − hRef)·d / R: under 10 m within 40 km of the eye at |h − hRef| <
 * 1500 m. Both are below the 25 m cell (and the shader's ±15 m edge warp).
 * The texture is padded to a multiple of 4 texels per row (WebGL's default unpack alignment), so u
 * of real data ends at `uMax` = width / texWidth.
 */
export type CoverFit = {
	/** coefficients of (1, x, y, x·y) */
	uvU: [number, number, number, number];
	uvV: [number, number, number, number];
	/** u's x², y², v's x², y² */
	uvQ: [number, number, number, number];
	uMax: number;
	texWidth: number;
	errM: number;
};

export function coverFit(grid: CoverGrid, frame: Frame, hRef = 1500): CoverFit {
	const [w, s, e, n] = grid.bbox;
	const texWidth = Math.ceil(grid.width / 4) * 4;
	const uMax = grid.width / texWidth;
	const N = 11;
	const K = 6;
	const rows: { b: number[]; u: number; v: number }[] = [];
	for (let i = 0; i < N; i++)
		for (let j = 0; j < N; j++) {
			const lon = w + ((e - w) * i) / (N - 1);
			const lat = s + ((n - s) * j) / (N - 1);
			const [x, y] = frame.fromGeo(lat, lon, hRef);
			rows.push({
				b: [1, x, y, x * y, x * x, y * y],
				u: ((lon - w) / (e - w)) * uMax,
				v: (n - lat) / (n - s),
			});
		}
	// normal equations in a scaled basis (x, y in units of 10 km keep them well conditioned)
	const S = [1, 1e-4, 1e-4, 1e-8, 1e-8, 1e-8];
	const solve = (key: "u" | "v") => {
		const A = Array.from({ length: K }, () => new Array<number>(K + 1).fill(0));
		for (const r of rows) {
			const b = r.b.map((x, k) => x * S[k]);
			for (let p = 0; p < K; p++) {
				for (let q = 0; q < K; q++) A[p][q] += b[p] * b[q];
				A[p][K] += b[p] * r[key];
			}
		}
		for (let c = 0; c < K; c++) {
			let m = c;
			for (let r = c + 1; r < K; r++)
				if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
			[A[c], A[m]] = [A[m], A[c]];
			for (let r = 0; r < K; r++) {
				if (r === c) continue;
				const f = A[r][c] / A[c][c];
				for (let k = c; k <= K; k++) A[r][k] -= f * A[c][k];
			}
		}
		return A.map((row, k) => (row[K] / row[k]) * S[k]);
	};
	const cu = solve("u");
	const cv = solve("v");
	const uvU = cu.slice(0, 4) as CoverFit["uvU"];
	const uvV = cv.slice(0, 4) as CoverFit["uvV"];
	const uvQ: CoverFit["uvQ"] = [cu[4], cu[5], cv[4], cv[5]];
	const mPerU = (grid.width * cellM(grid)[0]) / uMax;
	const mPerV = grid.height * cellM(grid)[1];
	let errM = 0;
	for (const r of rows) {
		const du = r.b.reduce((a, x, k) => a + x * cu[k], 0) - r.u;
		const dv = r.b.reduce((a, x, k) => a + x * cv[k], 0) - r.v;
		errM = Math.max(errM, Math.hypot(du * mPerU, dv * mPerV));
	}
	return { uvU, uvV, uvQ, uMax, texWidth, errM };
}

/** Approximate cell size (m) east, north at the bbox centre. */
function cellM(grid: CoverGrid): [number, number] {
	const [w, s, e, n] = grid.bbox;
	const lat = ((s + n) / 2) * (Math.PI / 180);
	return [
		((e - w) * 111_320 * Math.cos(lat)) / grid.width,
		((n - s) * 110_574) / grid.height,
	];
}

const padded = new WeakMap<CoverGrid, Uint8Array>();
/** The class grid as r8 texel rows padded to `texWidth` (row 0 = north = v 0). */
export function coverTexels(grid: CoverGrid, texWidth: number): Uint8Array {
	let d = padded.get(grid);
	if (d && d.length === texWidth * grid.height) return d;
	if (texWidth === grid.width) d = grid.classes;
	else {
		d = new Uint8Array(texWidth * grid.height);
		for (let y = 0; y < grid.height; y++)
			d.set(
				grid.classes.subarray(y * grid.width, (y + 1) * grid.width),
				y * texWidth,
			);
	}
	padded.set(grid, d);
	return d;
}

/**
 * Engineering default, not a measurement: the transient snowline of the Northern Alps (Bernese
 * Oberland, north slope) by month (mid-month, m a.s.l.), a smooth reading of typical seasons:
 * ~1500 m in mid-winter, rising through the melt to ~3000–3200 m at the end of summer, back down
 * to ~2000 m in November. Any one year can be ±500 m off (and a fresh autumn storm far more); the
 * real answer is Copernicus HR Snow for the capture day (T2.5), which this stands in for.
 */
export const SNOWLINE_BY_MONTH = [
	1500, 1500, 1650, 1950, 2350, 2700, 3000, 3200, 3100, 2600, 2000, 1600,
];
/** Aspect offset (m): north faces this much lower, south faces higher (× cos aspect). */
export const SNOW_ASPECT_M = 125;
/** Snow sheds from slopes steeper than this band (deg). */
export const SNOW_SHED_DEG: [number, number] = [50, 60];

/** Snowline (m) for a capture time, interpolated between mid-months; null without a valid date. */
export function snowlineM(takenAt: string | null | undefined): number | null {
	if (!takenAt) return null;
	const t = new Date(takenAt);
	if (Number.isNaN(t.getTime())) return null;
	const m = t.getUTCMonth();
	const days = new Date(Date.UTC(t.getUTCFullYear(), m + 1, 0)).getUTCDate();
	const f = m + (t.getUTCDate() - 0.5) / days - 0.5; // 0 = mid-January
	const i = Math.floor(f);
	const a = SNOWLINE_BY_MONTH[(i + 12) % 12];
	const b = SNOWLINE_BY_MONTH[(i + 13) % 12];
	return a + (b - a) * (f - i);
}

/**
 * Swiss index contours on round heights: majorEvery for a contour interval (10→10, 20→5, 25→4,
 * 50→2, i.e. every 100 m; 100 and 200→5, i.e. 500 / 1000 m); null where none is round.
 */
export function swissMajorEvery(interval: number): number | null {
	if (!(interval > 0)) return null;
	if (interval >= 100) return 5;
	const k = 100 / interval;
	return Math.abs(k - Math.round(k)) < 1e-6 ? Math.round(k) : null;
}

/** Adaptive contours: minor-interval targets (m) beyond each range boundary (m). */
export const ADAPT_TARGETS_M = [100, 200, 1000] as const;
export const ADAPT_BOUNDS_M = [5000, 15000, 30000] as const;
/** transition half-width, as a fraction of the boundary */
export const ADAPT_BAND = 0.25;

/**
 * Nested contour levels for a base interval: level k's interval is the smallest multiple of level
 * k − 1's that reaches the target, so every coarser line is also a finer one (they nest and the
 * transition only fades lines out). 50 m → 100 / 200 / 1000 m. Majors likewise, from the Swiss
 * index rule (swissIndex) or the style's majorEvery.
 */
export function adaptiveLevels(
	interval: number,
	majorEvery: number,
	swissIndex: boolean,
): { minor: [number, number, number]; major: [number, number, number] } {
	let mi = interval;
	let ma = interval * majorEvery;
	const minor: number[] = [];
	const major: number[] = [];
	for (const T of ADAPT_TARGETS_M) {
		mi = Math.max(mi, Math.ceil(T / mi - 1e-9) * mi);
		const every = (swissIndex && swissMajorEvery(mi)) || majorEvery;
		ma = Math.max(ma, Math.ceil((mi * every) / ma - 1e-9) * ma);
		minor.push(mi);
		major.push(ma);
	}
	return {
		minor: minor as [number, number, number],
		major: major as [number, number, number],
	};
}

/** The terroir shading of one engine frame: null when no switch needs the terrain shaders. */
export type TerroirShader = {
	defines: TerroirDefine[];
	/** index contours on round 100 m (a uniform override, no define) */
	swissIndex: boolean;
	/** the cover grid (TERROIR_COVER / _INK) and its mapping, else null */
	grid: CoverGrid | null;
	fit: CoverFit | null;
	snowline: number | null;
};

/**
 * Which terroir shading a style needs. The cover-based parts (cover albedo, snow, contour ink) need
 * the pack's grid: without one they are off (define absent), like every terroir layer outside a pack.
 */
export function terroirShader(
	style: ViewStyle,
	grid: CoverGrid | null,
	frame: Frame | null,
	takenAt: string | null | undefined,
): TerroirShader | null {
	const t = style.terroir;
	const g = grid && frame ? grid : null;
	const snowline =
		t.cover.on && t.cover.snow === "date" ? snowlineM(takenAt) : null;
	const d: TerroirDefine[] = [];
	if (t.contours.adaptive) d.push("TERROIR_CONTOUR_ADAPTIVE");
	if (t.contours.inkByCover && g) d.push("TERROIR_CONTOUR_INK");
	if (t.cover.on && g) d.push("TERROIR_COVER");
	if (g && snowline != null) d.push("TERROIR_SNOW");
	if (!d.length && !t.contours.swissIndex) return null;
	const needGrid = d.some((x) => x !== "TERROIR_CONTOUR_ADAPTIVE");
	return {
		defines: d.sort(),
		swissIndex: t.contours.swissIndex,
		grid: needGrid ? g : null,
		fit: needGrid && g && frame ? coverFit(g, frame) : null,
		snowline,
	};
}

/** majorEvery for the contour pass: the Swiss index when on (and round), else the style's. */
export function terroirMajorEvery(
	t: TerroirShader | null,
	interval: number,
	majorEvery: number,
): number {
	return (t?.swissIndex && swissMajorEvery(interval)) || majorEvery;
}

const lin = (hex: string) => {
	const v = Number.parseInt(hex.slice(1), 16);
	return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map(
		(c) => (c / 255) ** 2.2,
	) as [number, number, number];
};
const INK_INDEX = { soil: 0, rock: 1, ice: 2 } as const;
/** Natural colours, linear (the shaders' toLinear convention), a = ink index; 16 slots. */
const PALETTE: number[] = (() => {
	const out = new Array<number>(64).fill(0);
	for (const c of COVER_CLASSES) {
		const [r, g, b] = lin(c.color);
		out.splice(c.id * 4, 4, r, g, b, INK_INDEX[c.ink]);
	}
	return out;
})();

/** Cover strength, texture strength, imagery steep-face cross-fade. */
export const COVER_MIX = { strength: 1, texture: 1, steep: 0.85 };
export const SNOW_ALBEDO = "#f2f5fa";

/** TER_BLOCK values for a frame (`interval` / `majorEvery`: the contour pass's base, before swissIndex). */
export function terroirBlockValues(
	t: TerroirShader,
	interval: number,
	majorEvery: number,
) {
	const f = t.fit;
	const lv = adaptiveLevels(
		interval,
		terroirMajorEvery(t, interval, majorEvery),
		t.swissIndex,
	);
	return {
		uvU: f?.uvU ?? [0, 0, 0, 0],
		uvV: f?.uvV ?? [0, 0, 0, 0],
		uvQ: f?.uvQ ?? [0, 0, 0, 0],
		pal0: PALETTE.slice(0, 16),
		pal1: PALETTE.slice(16, 32),
		pal2: PALETTE.slice(32, 48),
		pal3: PALETTE.slice(48, 64),
		inkSoil: lin(CONTOUR_INK.soil),
		inkRock: lin(CONTOUR_INK.rock),
		inkIce: lin(CONTOUR_INK.ice),
		snowCol: [...lin(SNOW_ALBEDO), t.snowline != null ? 1 : 0],
		snow: [t.snowline ?? 99999, SNOW_ASPECT_M, ...SNOW_SHED_DEG],
		minorLv: [...lv.minor, 0],
		majorLv: [...lv.major, 0],
		adapt: [...ADAPT_BOUNDS_M, ADAPT_BAND],
		cover: [
			COVER_MIX.strength,
			COVER_MIX.texture,
			COVER_MIX.steep,
			f?.uMax ?? 0,
		],
	};
}
