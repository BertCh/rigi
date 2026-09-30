// Whole-image concordance feature flags: ?concord=<csv> (eye, occl), read
// through src/lib/flags. Everything is off by default, and off outside a browser (node pipeline,
// workers).
import { flagFrom, getFlag } from "#/lib/flags";

export const CONCORD_FLAGS = ["eye", "occl"] as const;
export type ConcordFlag = (typeof CONCORD_FLAGS)[number];
export type ConcordFlags = Readonly<Record<ConcordFlag, boolean>>;

const toRecord = (on: readonly string[]): ConcordFlags =>
	Object.freeze(
		Object.fromEntries(CONCORD_FLAGS.map((f) => [f, on.includes(f)])),
	) as ConcordFlags;

/** Parse a location.search string ("?concord=eye,occl&…"). */
export const parseConcordFlags = (search: string): ConcordFlags =>
	toRecord(flagFrom(search, "concord"));

/** The current page's flags (all false outside a browser). */
export const concordFlags = (): ConcordFlags => toRecord(getFlag("concord"));

export const concordOn = (f: ConcordFlag): boolean =>
	getFlag("concord").includes(f);
