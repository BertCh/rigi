// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The app's switches: one typed table, one reader. Every page-level option (?renderer=deck, ?gpu=off,
// ?tiles3d=swisstopo, …) is declared here and read with getFlag(); nothing else parses location.search
// for them. The router validates and carries these params across navigation (routes/__root.tsx), and
// the sidebar's "Experimental & dev" section sets them (components/panel).
//
// Sources, first hit wins:
//   1. globalThis.__RIGI_FLAGS__[name]: per-realm override for harnesses and benches (read live; works in
//      workers, which have no page URL).
//   2. the page URL (main thread only).
//   3. the default below.
// Values are canonical and lower-case. A bad value logs once and falls back to the default.
// Booleans are "on" | "off".

type EnumDef<V extends string = string> = {
	kind: "enum";
	values: readonly V[];
	def: V;
};
type SetDef<V extends string = string> = { kind: "set"; values: readonly V[] };
type NumberDef = { kind: "number" };
/** Free text, validated by its owner (?style= preset id, ?reveal= preset id or off). */
type TextDef = { kind: "text" };
type FlagDef = EnumDef | SetDef | NumberDef | TextDef;

const oneOf = <const V extends string>(values: readonly V[], def: V) =>
	({ kind: "enum", values, def }) as EnumDef<V>;
const onOff = (def: "on" | "off") => oneOf(["on", "off"], def);
const setOf = <const V extends string>(values: readonly V[]) =>
	({ kind: "set", values }) as SetDef<V>;
const num = { kind: "number" } as NumberDef;
const text = { kind: "text" } as TextDef;

export const FLAG_SCHEMA = {
	// render
	/**
	 * The /photo engine (src/lib/renderer-select.ts): auto (the default) = WebGPU deck where the browser passes the probe,
	 * else WebGL deck; webgpu = the same, asked for explicitly; deck = WebGL deck only.
	 */
	renderer: oneOf(["auto", "webgpu", "deck"], "auto"),
	/** off: ?renderer=auto / webgpu act as if navigator.gpu were missing (proves the WebGL fallback) */
	webgpu: onOff("on"),
	/**
	 * WebGPU colour-pass format (src/lib/deck-webgpu/targets.ts): rgba16 (default). rg11b10 is accepted but
	 * downgraded to rgba16 with a console warning: rg11b10ufloat has NO destination alpha, which breaks the photo
	 * overlay and the world sky (atm-sky blends under with one-minus-dst-alpha). rg11b10-unsafe forces it (half the
	 * colour VRAM) for experiments; needs the rg11b10ufloat-renderable feature, else rgba16.
	 */
	colorTarget: oneOf(["rgba16", "rg11b10", "rg11b10-unsafe"], "rgba16"),
	// GPU compute sidecar (src/lib/gpu); the CPU path is always the reference
	/** master kill switch for every kernel below */
	gpu: onOff("on"),
	/**
	 * skyline detector (geo/skyline.ts detectSkylineAsync): the per-pixel feature, prior and sky-model
	 * images on the GPU (src/lib/gpu/skyline), the sky-model fits and Viterbi on the CPU. off = the CPU
	 * detectSkyline (also under ?gpu=off).
	 */
	skylineGpu: onOff("off"),
	/**
	 * unknown-pose cascade (integration/unknown-pose-core.ts isAmbiguousFocal): on = the focal `ambiguous`
	 * test ignores a non-best focal seed that accepted only through refinePose after a solve stage under
	 * SEED_REFINE_MIN_SOLVE_CONFIDENCE (chaotic at 1e-4 px row noise; research_notes/wave5/skyline-gpu-flip.md).
	 * It only removes vetoes, so it can only add accepts: GT-12 CPU 60/60 decisions unchanged, wild set not
	 * measured. Off by default until the batch unknown-pose A/B (roadmap G2).
	 */
	focalSeedGate: onOff("off"),
	/**
	 * peak snapping (geo/peaks.ts localMaxOf, both engines): on = a DEM maximum on the search grid's
	 * outer ring is treated as a flank, not a summit, and the peak keeps its OSM node position (22 % of
	 * catalogue peaks in the 2026-10-02 dev study, reports/steps-2026-10-02/peak.md). Moves labels, so
	 * off until a label batch pass compares both. Read once per snap; snaps are cached per terrain,
	 * so a runtime override applies to peaks not yet snapped (URL flags are fixed per load).
	 */
	peakSnapInterior: onOff("off"),
	/**
	 * WebGPU engine: per-render-pass GPU timings (deck-webgpu/frame-timings.ts, deck.gl PR #10778's idea
	 * for Rigi's own geometry / colour / screen passes). on = timestamp writes on those passes and a
	 * FrameTimings sample per frame (engine.onFrameTimings, /dev/graph); needs the device feature
	 * 'timestamp-query'. Also wires deck.gl's `_onFrameTimings` on both engines: deck's layers pass
	 * GPU time ("deck-layers") and deck CPU time. Off (default) = no query sets, descriptors unchanged.
	 */
	gpuFrameTimings: onOff("off"),
	/**
	 * deck.gl `debug` prop (deck PR #10782, vendored rigi.2+): on = Deck({debug: true}) on both engines'
	 * Deck instances (deck-webgpu/device.ts createWebgpuDeck, deck/engine.ts createDeck): deck's debug
	 * checks and luma device creation with `debug: true` (luma validation / error logging; on WebGL the
	 * optional `@luma.gl/webgl/debug` tools are not loaded by Rigi). Slow; for diagnosing only.
	 * off (default) = deck's default.
	 */
	deckDebug: onOff("off"),
	/**
	 * WebGPU batched terrain: replay the GPU-culled terrain draws (geometry + colour passes) from
	 * recorded render bundles instead of re-encoding them every frame (CPU encode cost only; pixels
	 * identical, scripts/gpu/render-bundle-dawn.ts). Re-records on any bound-resource, pipeline or
	 * target change; separate bundles for the MSAA and interactive 1x colour passes. Opt-in until
	 * the batch pass measures a CPU gain (research_notes/wave5/render-bundles.md); off = the
	 * existing per-frame encode.
	 */
	renderBundles: onOff("off"),
	/**
	 * Step Inside splats on WebGPU (deck-webgpu/layers/splats.ts): luma = luma.gl's splat stack
	 * (@luma.gl/splats, luma PR #3340: an LoD tree over the cloud, progressive RAD selection, luma's
	 * paged projection + global GPU sort, drawn by layers/splats-luma.ts into the colour pass);
	 * rigi = the Rigi EWA shader with gpu/splat-sort (the pre-rigi.6 path, also the automatic
	 * fallback when the luma stack fails to build or prepare, and always used with the geometry-pass
	 * contribution). The WebGL engine always uses nearfield/deck-splat-layer.ts.
	 */
	splatRenderer: oneOf(["luma", "rigi"], "luma"),
	// Step Inside 3D Tiles (src/lib/tiles3d)
	tiles3d: oneOf(["off", "buildings", "swisstopo", "google", "all"], "off"),
	tiles3dBlend: oneOf(["fill", "over"], "fill"),
	tiles3dBias: num,
	tiles3dDebug: onOff("off"),
	/** T2: swisstopo tiles + nDSM promote Far/Terrain cells to Object in the Step Inside split (nearfield/object-prior). */
	tiles3dObjects: onOff("off"),
	// Step Inside near field (auto: probe the service, never under automation). complete = on + the P0
	// completion heuristics (src/lib/nearfield/complete: slab reclassification, edge snap; display-only).
	nearfield: oneOf(["auto", "on", "sharp", "complete", "off"], "auto"),
	/** Step Inside anchor: exclude cliff-lip DEM range discontinuities from the fit (nearfield/cliff-lip.ts). */
	anchorCliff: onOff("off"),
	// alignment aids
	picker: oneOf(["off", "on", "always"], "off"),
	/** tap-a-peak pin solve (src/lib/pins/seed.ts): seeded = closed-form start + lens bound, kept only when it fits the taps better */
	pinSolve: oneOf(["plain", "seeded"], "plain"),
	eyesearch: oneOf(["off", "on", "auto"], "off"),
	concord: setOf(["eye", "occl", "labels", "drape"]),
	// geometry-first camera (src/lib/geocam, GEO phase A); all off = the pre-GEO app
	/** magnetic declination (WMM2025) on EXIF headings with GPSImgDirectionRef M */
	geoDecl: onOff("off"),
	/** eye ≥ the level of a lake the GPS fix stands next to (engine init) */
	geoLakeFloor: onOff("off"),
	/** keep compact lake polygons with newly fetched upload regions */
	geoLakes: onOff("off"),
	// data & licences (src/lib/licences; VITE_* env vars apply when unset)
	imagery: oneOf(["default", "esri", "swisstopo", "custom"], "default"),
	attrib: oneOf(["classic", "full"], "classic"),
	osmextract: onOff("off"),
	/** share-link beta (/s/$code, src/lib/share): off until the N2 licence review clears */
	share: onOff("off"),
	// /roll
	propagate: oneOf(["off", "on", "dev"], "off"),
	/** Align roll: compass-bias anchor window, s (roll/align/viewpoint.ts; unset = BIAS_WINDOW_S, 45 min) */
	rollBiasWindow: num,
	// appearance: applies live (not a RESTART_FLAG); precedence and the boot script are in ./theme-boot.ts
	theme: oneOf(["auto", "light", "dark"], "auto"),
	// owned by their stores
	style: text,
	reveal: text,
} as const satisfies Record<string, FlagDef>;

type Schema = typeof FLAG_SCHEMA;
export type FlagName = keyof Schema;
type ValueOf<D> =
	D extends EnumDef<infer V>
		? V
		: D extends SetDef<infer V>
			? readonly V[]
			: D extends NumberDef
				? number | undefined
				: string | undefined;
export type Flags = { [K in FlagName]: ValueOf<Schema[K]> };

export const FLAG_NAMES = Object.keys(FLAG_SCHEMA) as FlagName[];

// ---- parsing ---------------------------------------------------------------------------------------

const warned = new Set<string>();
function bad(name: string, raw: string) {
	const k = `${name}=${raw}`;
	if (warned.has(k)) return;
	warned.add(k);
	console.warn(`[flags] ?${k} is not a valid value; using the default`);
}

/** One raw value (string from the URL, or whatever an override holds) → its typed value. */
function parseValue<K extends FlagName>(name: K, raw: unknown): Flags[K] {
	const d: FlagDef = FLAG_SCHEMA[name];
	const s = raw == null ? "" : String(raw).trim();
	switch (d.kind) {
		case "enum": {
			const v = s.toLowerCase();
			if ((d.values as readonly string[]).includes(v)) return v as Flags[K];
			if (raw != null) bad(name, s);
			return d.def as Flags[K];
		}
		case "set": {
			const want = new Set(
				s
					.toLowerCase()
					.split(",")
					.map((x) => x.trim())
					.filter(Boolean),
			);
			for (const w of want) if (!d.values.includes(w)) bad(name, w);
			return d.values.filter((v) => want.has(v)) as unknown as Flags[K];
		}
		case "number": {
			if (s === "") return undefined as Flags[K];
			const n = Number(s);
			if (Number.isFinite(n)) return n as Flags[K];
			bad(name, s);
			return undefined as Flags[K];
		}
		case "text":
			return (s === "" ? undefined : s) as Flags[K];
	}
}

/** The flags present in a search string (unset ones omitted). Pure: for checks and the router. */
export function parseFlags(search: string): Partial<Flags> {
	const q = new URLSearchParams(search);
	const out: Partial<Record<FlagName, unknown>> = {};
	for (const k of FLAG_NAMES) if (q.has(k)) out[k] = parseValue(k, q.get(k));
	return out as Partial<Flags>;
}

/** One flag from a search string, defaulted. */
export function flagFrom<K extends FlagName>(
	search: string,
	name: K,
): Flags[K] {
	const q = new URLSearchParams(search);
	return parseValue(name, q.has(name) ? q.get(name) : null);
}

// ---- the live reader ---------------------------------------------------------------------------------

type Overrides = Partial<Record<FlagName, unknown>>;
const overrides = () =>
	(globalThis as { __RIGI_FLAGS__?: Overrides }).__RIGI_FLAGS__;

/** The page's query, or "" off the main thread (a worker's location is its script URL). */
function pageSearch(): string {
	if (typeof document === "undefined") return "";
	try {
		return globalThis.location?.search ?? "";
	} catch {
		return "";
	}
}

let memo: { search: string; flags: Partial<Flags> } | null = null;
function fromPage(): Partial<Flags> {
	const search = pageSearch();
	if (memo?.search !== search) {
		memo = { search, flags: parseFlags(search) };
	}
	return memo.flags;
}

/** Whether the flag is set explicitly (override or URL) rather than defaulted. */
export function flagSet(name: FlagName): boolean {
	const o = overrides();
	if (o && o[name] !== undefined) return true;
	return name in fromPage();
}

export function getFlag<K extends FlagName>(name: K): Flags[K] {
	const o = overrides();
	if (o && o[name] !== undefined) return parseValue(name, o[name]);
	const p = fromPage();
	return name in p ? (p[name] as Flags[K]) : parseValue(name, null);
}

/** For harness code running in this realm: set (value undefined: clear) an override. */
export function setFlagOverride<K extends FlagName>(
	name: K,
	value: string | undefined,
) {
	const g = globalThis as { __RIGI_FLAGS__?: Overrides };
	g.__RIGI_FLAGS__ ??= {};
	if (value === undefined) delete g.__RIGI_FLAGS__[name];
	else g.__RIGI_FLAGS__[name] = value;
}

// ---- router ------------------------------------------------------------------------------------------
// The root route validates the flag params (keeping them as the router parsed them) and retains them
// across navigation. Values stay primitive: getFlag re-parses from the URL.

/** A flag as the router holds it: its default parser JSON-parses numbers ("0.998" → 0.998). */
export type FlagSearch = Partial<Record<FlagName, string | number | boolean>>;

/** Root validateSearch: the known flag params, as parsed; anything else is left to the child routes. */
export function flagSearch(s: Record<string, unknown>): FlagSearch {
	const out: FlagSearch = {};
	for (const k of FLAG_NAMES) {
		const v = s[k];
		if (
			typeof v === "string" ||
			typeof v === "number" ||
			typeof v === "boolean"
		)
			out[k] = v;
	}
	return out;
}

/**
 * The search value for a flag the UI sets (undefined removes the param, which means the default).
 * Number flags go in as numbers: the router's stringifier would quote a numeric string (%220.998%22).
 */
export function flagSearchValue(
	name: FlagName,
	value: string | readonly string[] | number | undefined,
): string | number | undefined {
	const d: FlagDef = FLAG_SCHEMA[name];
	if (value === undefined) return undefined;
	switch (d.kind) {
		case "enum":
			return value === d.def ? undefined : String(value);
		case "set": {
			const v = Array.isArray(value) ? value.join(",") : String(value);
			return v === "" ? undefined : v;
		}
		case "number": {
			const n = typeof value === "number" ? value : Number(value);
			return value === "" || !Number.isFinite(n) ? undefined : n;
		}
		case "text":
			return value === "" ? undefined : String(value);
	}
}

/** The schema entry (the panel builds its controls from it). */
export const flagDef = (name: FlagName): FlagDef => FLAG_SCHEMA[name];
export type { FlagDef };

/**
 * The flags read once, when the engine (or something it owns) is built: changing one needs a fresh
 * engine. Every other flag is read at use and applies live (UI readers subscribe with useFlag,
 * ./react.ts); ?style / ?reveal are owned by their stores.
 */
export const RESTART_FLAGS: readonly FlagName[] = [
	"renderer",
	"webgpu",
	"gpu",
	"tiles3d",
	"tiles3dBlend",
	"tiles3dBias",
	"tiles3dDebug",
	"tiles3dObjects",
	"nearfield",
	"anchorCliff",
	"concord",
	"imagery",
	"geoDecl",
	"geoLakeFloor",
];

/** A key that changes only when a RESTART_FLAGS flag changes (the photo route remounts the workspace on it). */
export function flagsKey(search: string): string {
	const f = parseFlags(search) as Record<string, unknown>;
	return RESTART_FLAGS.filter((k) => k in f)
		.map((k) => `${k}=${f[k]}`)
		.join("&");
}

/** The override set for a flag in this realm, if any (harnesses save and restore it). */
export function flagOverride(name: FlagName): string | undefined {
	const v = overrides()?.[name];
	return v === undefined ? undefined : String(v);
}
