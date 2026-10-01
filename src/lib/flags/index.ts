// The app's switches: one typed table, one reader. Every page-level option (?renderer=three, ?gpu=off,
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
	 * else WebGL deck; webgpu = the same, asked for explicitly; deck = WebGL deck only; three = three.js.
	 */
	renderer: oneOf(["auto", "webgpu", "deck", "three"], "auto"),
	/** off: ?renderer=auto / webgpu act as if navigator.gpu were missing (proves the WebGL fallback) */
	webgpu: onOff("on"),
	/** deck only: one instanced grid per resolution, or one mesh per tile */
	terrain: oneOf(["batched", "tiles"], "batched"),
	// GPU compute sidecar (src/lib/gpu); the CPU path is always the reference
	/** master kill switch for every kernel below */
	gpu: onOff("on"),
	/** autoAlign's skyline march */
	gpuHorizon: onOff("on"),
	/** relief / haze look passes */
	lookgpu: onOff("on"),
	/** unknown-pose 360° horizon (off: 0-false-accept rule) */
	unknownGpu: onOff("off"),
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
	// /roll
	propagate: oneOf(["off", "on", "dev"], "off"),
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
