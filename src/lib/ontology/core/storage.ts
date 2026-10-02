// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// L4: every place Rigi persists something on the user's device, in one table. The check
// (ontology.check.ts) scans src/ for key literals with Rigi's prefixes and fails on any key that is
// not registered here, so a new namespace can't appear unnoticed.

export type StorageMedium =
	| "localStorage"
	| "indexedDB"
	| "cacheStorage"
	| "url"
	| "file";

export type StorageEntry = {
	readonly medium: StorageMedium;
	/** literal key; `<x>` marks a variable part */
	readonly key: string;
	/** what is stored (a ConceptId where there is one) */
	readonly holds: string;
	/** schema version carried by the key or payload; null = unversioned */
	readonly version: number | null;
	readonly module: string;
	readonly note?: string;
};

export const STORAGE = {
	savedPose: {
		medium: "localStorage",
		key: "rigi.pose.<photoId>",
		holds: "pose (endorsed by the user)",
		version: null,
		module: "lib/photos.ts saveSavedPose/loadSavedPose",
	},
	solvedPose: {
		medium: "localStorage",
		key: "rigi.rollpose.<photoId>",
		holds: "SolvedPose (roll aligner or accepted suggestion)",
		version: null,
		module: "lib/roll/roll.ts",
	},
	importPosition: {
		medium: "localStorage",
		key: "rigi.import.pos.<photoId>",
		holds: "PositionProvenance",
		version: null,
		module: "lib/roll/import/provenance.ts",
	},
	propagate: {
		medium: "localStorage",
		key: "rigi.propagate.v1",
		holds: "StoredSuggestion map keyed anchor>target",
		version: 1,
		module: "lib/roll/propagate/store.ts",
	},
	rollBasemap: {
		medium: "localStorage",
		key: "rigi.roll.basemap",
		holds: "UI toggle",
		version: null,
		module: "lib/roll/map/RollMap.tsx",
	},
	panoTerrain: {
		medium: "localStorage",
		key: "rigi.roll.pano-terrain",
		holds: "UI toggle",
		version: null,
		module: "lib/roll/mosaic/PanoramaStrip.tsx",
	},
	panoHeight: {
		medium: "localStorage",
		key: "rigi.roll.pano-height",
		holds: "UI size (px)",
		version: null,
		module: "lib/roll/mosaic/PanoramaStrip.tsx",
	},
	viewStyle: {
		medium: "localStorage",
		key: "rigi.viewStyle.v1",
		holds: "StyleState {v, preset, overrides}",
		version: 1,
		module: "lib/style/store.ts",
	},
	lookLayer: {
		medium: "localStorage",
		key: "rigi.look.layer.<id>",
		holds: "UI toggle per look layer",
		version: null,
		module: "components/StylePanel.tsx",
	},
	lookLinesMore: {
		medium: "localStorage",
		key: "rigi.look.lines-more",
		holds: "UI toggle",
		version: null,
		module: "components/StylePanel.tsx",
	},
	reveal: {
		medium: "localStorage",
		key: "rigi.reveal.v1",
		holds: "RevealConfig",
		version: 1,
		module: "lib/reveal/config.ts",
	},
	theme: {
		medium: "localStorage",
		key: "rigi.theme",
		holds: "ThemeChoice (light | dark; absent = auto)",
		version: null,
		module: "lib/theme/index.ts",
	},
	pickerLog: {
		medium: "localStorage",
		key: "rigi.picker.log.v1",
		holds: "PickerLogEntry[]",
		version: 1,
		module: "lib/picker/log.ts",
	},
	panel: {
		medium: "localStorage",
		key: "rigi.panel.<id>",
		holds: "sidebar section open/closed",
		version: null,
		module: "components/controls.tsx",
	},
	gipfelbuchPhoto: {
		medium: "localStorage",
		key: "rigi.gipfelbuch.photo",
		holds: "demo photo id followed through the Gipfelbuch notebook",
		version: null,
		module: "components/gipfelbuch/notebook/useNotebookPhoto.ts",
	},
	topoSharp: {
		medium: "localStorage",
		key: "rigi.topoSharp",
		holds: "landing topo board sharp/soft toggle",
		version: null,
		module: "components/site/TopoBoard.tsx",
	},
	uploads: {
		medium: "indexedDB",
		key: "rigi-uploads",
		holds: "PhotoRecord (photos store) + LocalRegion (regions store)",
		version: 1,
		module: "lib/upload/store.ts",
	},
	tileCache: {
		medium: "cacheStorage",
		key: "rigi-tiles-v1",
		holds: "DEM / imagery tile bytes (IndexedDB fallback of the same name)",
		version: 1,
		module: "lib/cache/tile-cache.ts",
	},
	flags: {
		medium: "url",
		key: "?<flag>=<value>",
		holds: "Flags (lib/flags FLAG_SCHEMA)",
		version: null,
		module: "lib/flags",
	},
	poseJson: {
		medium: "file",
		key: "<photoId>.pose.json (schema rigi/pose)",
		holds: "PoseJson",
		version: 1,
		module: "lib/export/pose-json.ts",
	},
	xmp: {
		medium: "file",
		key: "<photoId>.xmp (ns https://rigi.app/ns/pose/1.0/)",
		holds: "XMP sidecar",
		version: 1,
		module: "lib/export/xmp.ts",
	},
} as const satisfies Record<string, StorageEntry>;
export type StorageId = keyof typeof STORAGE;

/** Key prefixes the storage lint scans for. */
export const STORAGE_PREFIXES = ["rigi.", "rigi-"];

/** RegExp matching concrete keys of an entry (`<x>` → one or more chars). */
export function storageKeyPattern(id: StorageId): RegExp {
	const k = STORAGE[id].key;
	const re = k
		.split(/<[^>]+>/)
		.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".+");
	return new RegExp(`^${re}$`);
}

/** The registered entry a concrete key belongs to, or null. */
export function storageEntryOf(key: string): StorageId | null {
	for (const id of Object.keys(STORAGE) as StorageId[])
		if (storageKeyPattern(id).test(key)) return id;
	return null;
}

type KeyParts<K extends string> = K extends `${string}<${string}>${infer R}`
	? [string, ...KeyParts<R>]
	: [];

/**
 * The concrete key of a registered entry: `storageKey("savedPose", id)` → "rigi.pose.<id>". The
 * argument count is checked against the `<x>` holes in the registered key.
 */
export function storageKey<I extends StorageId>(
	id: I,
	...parts: KeyParts<(typeof STORAGE)[I]["key"]>
): string {
	let i = 0;
	return STORAGE[id].key.replace(/<[^>]+>/g, () => String(parts[i++]));
}
