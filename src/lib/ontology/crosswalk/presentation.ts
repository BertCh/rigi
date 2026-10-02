// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Crosswalk: presentation and interchange vocabulary. The UI word for each code word lives here, so
// "replace" is always shown as "Blend" and "world" as "In map".

import type { ExportKind } from "#/lib/export/engine-export";
import type { SplatExportKind } from "#/lib/export/splat";
import type { BlendMethod, ViewMode } from "#/lib/settings";
import type { DeckStyleMode } from "#/lib/style/deck-apply";
import type { Assert, Equal } from "../core/assert";

export const VIEW_MODE = {
	overlay: {
		label: "Overlay",
		hint: "terrain lines and labels drawn on the photo",
	},
	replace: { label: "Blend", hint: "terrain replaces parts of the photo" },
	world: { label: "In map", hint: "the photo placed in the 3D world" },
} as const satisfies Record<ViewMode, { label: string; hint: string }>;

/** The style adapter's mode union must stay the view mode (an alias, not a new concept). */
export type _deckStyleModeIsViewMode = Assert<Equal<DeckStyleMode, ViewMode>>;

export const BLEND_METHOD = {
	lens: { label: "Lens" },
	swipe: { label: "Swipe" },
	range: { label: "Distance" },
	brush: { label: "Brush" },
} as const satisfies Record<BlendMethod, { label: string }>;

/** Every export the app can write, one row per kind. */
export const EXPORT_KIND = {
	png: { concept: "export-format", versioned: false },
	kmz: { concept: "export-format", versioned: false },
	geojson: { concept: "export-format", versioned: false },
	pose: { concept: "pose-file", versioned: true },
	colmap: { concept: "export-format", versioned: false },
	xmp: { concept: "export-format", versioned: true },
	"splat-ply": { concept: "export-format", versioned: false },
	"splat-v1": { concept: "export-format", versioned: true },
} as const satisfies Record<
	ExportKind | SplatExportKind,
	{ concept: string; versioned: boolean }
>;

/** One export format as shown in the export menu (engine exports and splat exports share it). */
export type FormatDescriptor<K extends string = string> = {
	kind: K;
	label: string;
	ext: string;
	mime: string;
	hint: string;
};
