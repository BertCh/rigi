// L4 identity: how every identifiable thing in Rigi is named. One table of id schemes, ordered most-
// specific first, so `classifyId` is unambiguous. (Prefix tests used to overlap: `local-region-…` also
// starts with `local-`, which is the photo prefix.) A reference to anything is `Ref<C>`, and its string
// form is the URN `rigi:<concept>/<id>`.

export type IdScheme = {
	/** the concept this id names (a ConceptId; kept as string here so core has no catalogue import) */
	readonly concept: string;
	/** kind within the concept, e.g. photo: bundled | local | demo | bench */
	readonly kind: string;
	readonly pattern: RegExp;
	readonly example: string;
	/** where ids of this kind are minted */
	readonly mintedBy: string;
	/** stable across sessions/devices? */
	readonly stable: boolean;
	readonly note?: string;
};

/** Most-specific first within a concept. */
export const ID_SCHEMES = [
	{
		concept: "photo",
		kind: "bundled",
		pattern: /^IMG_\d+$/,
		example: "IMG_6971",
		mintedBy: "scripts/ingest.mjs",
		stable: true,
	},
	{
		concept: "photo",
		kind: "demo",
		pattern: /^demo-\d+$/,
		example: "demo-03",
		mintedBy: "scripts/demo/unpack.mjs",
		stable: true,
	},
	{
		concept: "photo",
		kind: "local",
		pattern: /^local-(?!region-|roll-)[0-9a-f]{10}$/,
		example: "local-3fa9c1d2e4",
		mintedBy:
			"upload/index.ts idForFile (SHA-256 prefix, or f+9 hex FNV on insecure origins)",
		stable: true,
		note: "content hash: the same file is the same photo on every device",
	},
	{
		concept: "photo",
		kind: "bench",
		pattern: /^wc_\d+$/,
		example: "wc_0042",
		mintedBy: "tools/bench (wild benchmark)",
		stable: true,
	},
	{
		concept: "region",
		kind: "bundled",
		pattern: /^region-\d+$/,
		example: "region-3",
		mintedBy: "scripts/ingest.mjs",
		stable: true,
	},
	{
		concept: "region",
		kind: "local-empty",
		pattern: /^local-region-empty-.+$/,
		example: "local-region-empty-local-3fa9c1d2e4",
		mintedBy: "upload/index.ts (photo without a position)",
		stable: true,
	},
	{
		concept: "region",
		kind: "local",
		pattern: /^local-region--?\d+\.\d{2}_-?\d+\.\d{2}$/,
		example: "local-region-46.55_7.95",
		mintedBy: "upload/region.ts (0.05° grid cell)",
		stable: true,
	},
	{
		concept: "region",
		kind: "demo",
		pattern: /^demo-region$/,
		example: "demo-region",
		mintedBy: "public/demo/manifest.json",
		stable: true,
	},
	{
		concept: "roll",
		kind: "demo",
		pattern: /^demo$/,
		example: "demo",
		mintedBy: "demo/index.ts DEMO_ROLL_ID",
		stable: true,
	},
	{
		concept: "roll",
		kind: "local-legacy",
		pattern: /^local-roll-\d{1,4}$/,
		example: "local-roll-2",
		mintedBy: "roll/roll.ts (old cluster index ids, still resolved)",
		stable: false,
	},
	{
		concept: "roll",
		kind: "local",
		pattern: /^local-roll-[0-9a-f]{10}$/,
		example: "local-roll-3fa9c1d2e4",
		mintedBy: "roll/roll.ts uploadRollId (earliest photo's hash)",
		stable: false,
		note: "changes when an earlier photo joins the cluster",
	},
	{
		concept: "roll",
		kind: "bundled",
		pattern: /^region-\d+$/,
		example: "region-3",
		mintedBy: "roll/roll.ts (one roll per bundled region)",
		stable: true,
		note: "a bundled roll's id IS its region id",
	},
	{
		concept: "roll",
		kind: "preview",
		pattern: /^preview-\d+$/,
		example: "preview-0",
		mintedBy: "routes/roll.import.tsx (unsaved import preview)",
		stable: false,
	},
	{
		concept: "peak",
		kind: "osm",
		pattern: /^node\/\d+$/,
		example: "node/123456",
		mintedBy: "OpenStreetMap",
		stable: true,
	},
	{
		concept: "lake",
		kind: "osm",
		pattern: /^(way|relation)\/\d+$/,
		example: "way/4242",
		mintedBy: "OpenStreetMap",
		stable: true,
	},
	{
		concept: "dem-tile",
		kind: "slippy",
		pattern: /^\d{1,2}\/\d+\/\d+$/,
		example: "12/2138/1447",
		mintedBy: "dem/tiles.ts tileId",
		stable: true,
	},
] as const satisfies readonly IdScheme[];

export type IdConcept = (typeof ID_SCHEMES)[number]["concept"];
export type IdKind<C extends IdConcept = IdConcept> = Extract<
	(typeof ID_SCHEMES)[number],
	{ concept: C }
>["kind"];
export type PhotoKind = IdKind<"photo">;

/** The id scheme `id` follows within `concept`, or null if none matches. */
export function classifyId<C extends IdConcept>(
	concept: C,
	id: string,
): IdKind<C> | null {
	const hit = ID_SCHEMES.find(
		(s) => s.concept === concept && s.pattern.test(id),
	);
	return (hit?.kind ?? null) as IdKind<C> | null;
}

/**
 * Photo kind by prefix. Unlike classifyId this is lenient about the hash body, matching the app's
 * historical prefix tests, but it is never fooled by `local-region-` or `local-roll-`.
 */
export function photoKind(id: string): PhotoKind | null {
	if (id.startsWith("demo-") && id !== "demo-region") return "demo";
	if (
		id.startsWith("local-") &&
		!id.startsWith("local-region-") &&
		!id.startsWith("local-roll-")
	)
		return "local";
	if (/^IMG_\d+$/.test(id)) return "bundled";
	if (/^wc_\d+$/.test(id)) return "bench";
	return null;
}

/** A typed reference to an identified thing. */
export type Ref<C extends string = string> = {
	readonly concept: C;
	readonly id: string;
};
export const ref = <C extends string>(concept: C, id: string): Ref<C> => ({
	concept,
	id,
});

export const URN_PREFIX = "rigi:";
export const toUrn = (r: Ref) => `${URN_PREFIX}${r.concept}/${r.id}`;
/** Inverse of toUrn. The id may itself contain '/' (tiles, OSM ids). */
export function parseUrn(urn: string): Ref | null {
	if (!urn.startsWith(URN_PREFIX)) return null;
	const rest = urn.slice(URN_PREFIX.length);
	const i = rest.indexOf("/");
	if (i <= 0 || i === rest.length - 1) return null;
	return { concept: rest.slice(0, i), id: rest.slice(i + 1) };
}
