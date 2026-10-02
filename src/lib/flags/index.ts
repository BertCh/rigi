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
	 * else WebGL deck; webgpu = the same, asked for explicitly; deck = WebGL deck only. The retired value three
	 * (the three.js PhotoEngine, removed 2026-10-01) falls back to auto with a warning (RETIRED below).
	 */
	renderer: oneOf(["auto", "webgpu", "deck"], "auto"),
	/**
	 * luma.gl/deck.gl example convention (?backend=webgpu|webgl, as in luma's examples/deck/*): an alias that
	 * overrides ?renderer when set. webgpu = renderer webgpu; webgl = renderer deck (deck.gl on WebGL2).
	 */
	backend: oneOf(["auto", "webgpu", "webgl"], "auto"),
	/** off: ?renderer=auto / webgpu act as if navigator.gpu were missing (proves the WebGL fallback) */
	webgpu: onOff("on"),
	/** deck only: one instanced grid per resolution, or one mesh per tile */
	terrain: oneOf(["batched", "tiles"], "batched"),
	// GPU compute sidecar (src/lib/gpu); the CPU path is always the reference
	/** master kill switch for every kernel below */
	gpu: onOff("on"),
	/** autoAlign's skyline march */
	gpuHorizon: onOff("on"),
	/**
	 * the skyline's tan → degrees and ENU stages: certified f32 on the GPU (default since 2026-10-01; the
	 * precision gate found no quality difference: GT-12 12/12 identical, webgpu accepts identical) or f64
	 * on the CPU (?horizonPrecision=f64)
	 */
	horizonPrecision: oneOf(["f64", "certified-f32"], "certified-f32"),
	/** relief / haze look passes */
	lookgpu: onOff("on"),
	/**
	 * sky worker: the segmentation input (resample + normalise) prepared on the GPU from an ImageBitmap
	 * (src/lib/gpu/sky/prep.ts), bit-identical to the CPU prep; the first 3 photos per device are compared
	 * in full with the CPU chain. Default on since 2026-10-01 (browser A/B: 69/69 masks identical, ~10 ms
	 * faster; its ComputeGraph port bit-identical on Dawn, sky-prep-dawn.ts --graph); off = getImageData + the
	 * CPU prep. ?gpu=off and WASM ORT always prep on the CPU.
	 */
	skyGpuPrep: onOff("on"),
	/**
	 * unknown-pose 360° horizon on the GPU march (gpu/horizon/scene-profile.ts, fused with the coarse solve).
	 * Default on since 2026-10-01: node gate on Dawn (scripts/gpu/unknown-gpu-node.ts), GT-12 × 5 conditions
	 * and the 17 wild dev photos without heading: 0 new false or unverified accepts; the one changed decision
	 * (IMG_6971 noheading, the CPU's 0.895 accept at the 0.75 bar) also rejects with the CPU horizon jittered
	 * by ±3e-4° (3/3 seeds) and in the browser's CPU run. off = the CPU sceneHorizon (also under ?gpu=off).
	 */
	unknownGpu: onOff("on"),
	/**
	 * band colour stats (LOOK_HARMONIZE, src/lib/gpu/look/color-stats-fold.ts): gpu (default since
	 * 2026-10-01) = the per-workgroup partials are folded and finalized on the GPU (luma GPUProgramSpMV +
	 * a finalize node, f32) and only the ColorStats (256 B) is read back; f64 = the partials (6.6 KB) come
	 * back and the CPU folds them in float64. Same composite in the measured photos (see the README).
	 */
	statsFold: oneOf(["f64", "gpu"], "gpu"),
	/**
	 * band colour stats: the per-workgroup reduction by subgroupAdd where the device has subgroups
	 * (BAND_STATS_SG, with its layout check and plain fallback); off = the shared-memory tree
	 */
	statsSubgroups: onOff("on"),
	/**
	 * WebGPU engine: per-render-pass GPU timings (deck-webgpu/frame-timings.ts, deck.gl PR #10778's idea
	 * for Rigi's own geometry / colour / screen passes). on = timestamp writes on those passes and a
	 * FrameTimings sample per frame (engine.onFrameTimings, /dev/graph); needs the device feature
	 * 'timestamp-query'. Off (default) = no query sets, render pass descriptors unchanged.
	 */
	gpuFrameTimings: onOff("off"),
	/**
	 * WebGPU batched terrain: GPU frustum cull + indirect draws (WAG W1.5; byte-identical frames to the
	 * CPU cull, scripts/deck-webgpu/terrain-indirect-check.mjs); off = the CPU cull. Default on since
	 * 2026-10-01 (GPU-graph first; no CPU saving at ~350–390 tiles, but no loss). WebGL and ?gpu=off
	 * always cull on the CPU.
	 */
	terrainGpuCull: onOff("on"),
	/**
	 * WebGPU splat sort: luma's gpgpu GPUSort (stable radix, 17 key bits) replaces the in-house
	 * tile/scan/scatter passes after the depth and key kernels (LF5; identical order, measured in
	 * scripts/gpu/splat-sort-gpgpu-dawn.ts). off = the in-house radix passes.
	 */
	splatSortGpgpu: onOff("on"),
	/**
	 * WebGPU terrain stream: Terrarium tiles decode on the GPU straight into the height atlas (WAG W2.3,
	 * deck-webgpu/terrain-gpu-decode.ts) and CPU heights are produced only when a CPU consumer asks
	 * (W2.4 getCpuHeights). Same heights bit for bit (texel bytes == canvas bytes, measured); off = the
	 * CPU decode. Default on since 2026-10-01: the hot heightAt callers gather from the atlas (no main-thread
	 * decodes); the atlas uploads ~3.5–4× the bytes of the CPU path. WebGL and ?gpu=off always decode
	 * on the CPU.
	 */
	terrainGpuDecode: onOff("on"),
	/**
	 * autoAlign's refine precision (WAG P1, src/lib/gpu/align/cert-refine.ts): f64 = exact CPU
	 * scores decide every move; certified-f32 (default since 2026-10-01) = GPU-driven loop with certified f32
	 * compares, the CPU deciding only what the bound cannot. Precision gate: no quality difference found
	 */
	alignPrecision: oneOf(["f64", "certified-f32"], "certified-f32"),
	/**
	 * The fitted haze's airlight band on the GPU (WAG haze-graph, src/lib/gpu/look/haze-band.ts): on
	 * (default since 2026-10-01) = the WebGPU texture path's fit runs compaction, band and gathers as
	 * one submit and reads no range / P(sky) planes back (integer work, same fit bit for bit,
	 * spot-checked per call); off = the CPU band between two submits. WebGL, ?gpu=off and a device or
	 * spot-check fault use the CPU band.
	 */
	hazeBandGpu: onOff("on"),
	/**
	 * The haze grid's arg-min on the GPU (WAG haze-graph, src/lib/gpu/look/haze-argmin.ts, a luma
	 * GPUProgram with a GPU-gated selection): on (default since 2026-10-01) = only the grid minimum and
	 * at most 256 candidate cells come back, the CPU re-applies its exact test (same fit bit for bit,
	 * checked per call); off = the whole 5 550-cell grid is read back. A compile fault or failed check
	 * turns it off for the device.
	 */
	hazeArgminGpu: onOff("on"),
	// Step Inside 3D Tiles (src/lib/tiles3d)
	tiles3d: oneOf(["off", "buildings", "swisstopo", "google", "all"], "off"),
	tiles3dBlend: oneOf(["fill", "over"], "fill"),
	tiles3dGeoid: num,
	tiles3dBias: num,
	tiles3dDebug: onOff("off"),
	// Step Inside near field (auto: probe the service, never under automation)
	nearfield: oneOf(["auto", "on", "sharp", "off"], "auto"),
	cammodes: onOff("off"),
	// alignment aids
	picker: oneOf(["off", "on", "always"], "off"),
	eyesearch: oneOf(["off", "on", "auto"], "off"),
	concord: setOf(["eye", "occl"]),
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
	/** swisstopo COG reader for ?concord=occl (src/lib/concord/occl/swiss-cog.ts): loaders.gl or the own parser */
	cogReader: oneOf(["loaders", "own"], "own"),
	// /roll
	propagate: oneOf(["off", "on", "dev"], "off"),
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

/** Values that used to be valid: the warning says why they now fall back to the default. */
const RETIRED: Partial<Record<string, Record<string, string>>> = {
	renderer: {
		three:
			"the three.js renderer was removed (2026-10-01); using the default (deck.gl: WebGPU where available, else WebGL)",
	},
};

const warned = new Set<string>();
function bad(name: string, raw: string) {
	const k = `${name}=${raw}`;
	if (warned.has(k)) return;
	warned.add(k);
	const why = RETIRED[name]?.[raw.toLowerCase()];
	console.warn(
		why
			? `[flags] ?${k}: ${why}`
			: `[flags] ?${k} is not a valid value; using the default`,
	);
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
	if (memo?.search !== search) memo = { search, flags: parseFlags(search) };
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
	"backend",
	"webgpu",
	"terrain",
	"gpu",
	"unknownGpu",
	"tiles3d",
	"tiles3dBlend",
	"tiles3dGeoid",
	"tiles3dBias",
	"tiles3dDebug",
	"nearfield",
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
