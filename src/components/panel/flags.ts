// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// How the sidebar's "Experimental & dev" section presents the app's flags: labels, help and grouping.
// The flags themselves (values, defaults, parsing) live in src/lib/flags; this file is presentation
// only. A flag missing here still works from the URL, but the panel won't show it.
import type { FlagName } from "#/lib/flags";

export type FlagGroup =
	| "render"
	| "tiles"
	| "step"
	| "assist"
	| "compute"
	| "data"
	| "debug";

export const FLAG_GROUPS: { id: FlagGroup; label: string; blurb: string }[] = [
	{ id: "render", label: "Renderer", blurb: "Which engine draws the terrain." },
	{
		id: "tiles",
		label: "3D Tiles",
		blurb: "Buildings / trees around the eye in Step Inside.",
	},
	{
		id: "step",
		label: "Step Inside",
		blurb: "Near-field splats (in-browser depth, WebGPU).",
	},
	{
		id: "assist",
		label: "Alignment aids",
		blurb: "Experimental helpers; all off by default.",
	},
	{
		id: "compute",
		label: "GPU compute",
		blurb: "WebGPU sidecar; the CPU path is the reference.",
	},
	{ id: "data", label: "Data & credits", blurb: "Sources and attribution." },
	{ id: "debug", label: "Debug", blurb: "Tuning overrides for development." },
];

export type FlagUI = {
	name: FlagName;
	label: string;
	help: string;
	group: FlagGroup;
	/** Display labels / tooltips per value (enum and set flags); unlisted values show as-is. */
	options?: Record<string, string | { label: string; title: string }>;
	/** Number flags. */
	placeholder?: string;
	step?: number;
};

const ONOFF = { on: "On", off: "Off" };

export const FLAG_UI: FlagUI[] = [
	{
		name: "renderer",
		label: "Engine",
		help: "Auto (default): deck.gl on WebGPU where the browser supports it, else deck.gl on WebGL. WebGL pins deck.gl on WebGL (each loads on demand).",
		group: "render",
		options: {
			auto: { label: "Auto", title: "WebGPU when available, else WebGL" },
			webgpu: {
				label: "WebGPU",
				title: "deck.gl on WebGPU (WebGL if unavailable)",
			},
			deck: { label: "WebGL", title: "deck.gl on WebGL2" },
		},
	},
	{
		name: "webgpu",
		label: "WebGPU",
		help: "Off: Auto / WebGPU behave as if this browser had no WebGPU (tests the WebGL fallback).",
		group: "render",
		options: ONOFF,
	},
	{
		name: "tiles3d",
		label: "Sources",
		help: "Shown around the eye while stepping inside. Google needs VITE_GOOGLE_TILES_KEY and is display-only.",
		group: "tiles",
		options: {
			off: "Off",
			buildings: { label: "Bldgs", title: "swisstopo buildings only" },
			swisstopo: {
				label: "swisstopo",
				title: "swisstopo buildings + vegetation",
			},
			google: "Google",
			all: "All",
		},
	},
	{
		name: "tiles3dBlend",
		label: "Blend",
		help: "Fill: tiles only outside the photo frame (the photo itself is not changed). Over: tiles everywhere (alignment check).",
		group: "tiles",
		options: { fill: "Fill", over: "Over" },
	},
	{
		name: "nearfield",
		label: "Near field",
		help: "Auto: runs the depth model in the browser on WebGPU when it is available (never under automation). On: also under automation. Complete: On plus the completion heuristics (display-only).",
		group: "step",
		options: {
			auto: "Auto",
			on: "On",
			complete: "Complete",
			off: "Off",
		},
	},
	{
		name: "picker",
		label: "Peak picker",
		help: "Top-3 pose candidates + tap-a-peak. Always: opens expanded even on HIGH-confidence results.",
		group: "assist",
		options: { off: "Off", on: "On", always: "Always open" },
	},
	{
		name: "eyesearch",
		label: "Eye search",
		help: "The “Check camera position” suggestion (Camera section). Auto also runs it once in the background.",
		group: "assist",
		options: { off: "Off", on: "Button", auto: "Auto" },
	},
	{
		name: "concord",
		label: "Concordance",
		help: "Whole-image concordance passes (display-only on the accepted pose).",
		group: "assist",
		options: {
			occl: { label: "occl", title: "DSM occluders" },
		},
	},
	{
		name: "geoDecl",
		label: "Magnetic declination",
		help: "GEO: apply WMM2025 declination to compass headings recorded as magnetic (uploads only).",
		group: "assist",
		options: ONOFF,
	},
	{
		name: "geoLakeFloor",
		label: "Eye above lake level",
		help: "GEO: raise the eye to the level of a lake the GPS fix stands next to (fetches lake outlines).",
		group: "assist",
		options: ONOFF,
	},
	{
		name: "geoLakes",
		label: "Store lake outlines",
		help: "GEO: keep compact lake polygons with newly fetched upload regions.",
		group: "assist",
		options: ONOFF,
	},
	{
		name: "colorTarget",
		label: "Colour target",
		help: "WebGPU colour pass format. rg11b10 is downgraded to RGBA16F (no alpha breaks the photo overlay and the world sky); rg11b10-unsafe forces the half-VRAM format for experiments.",
		group: "render",
		options: {
			rgba16: "RGBA16F (default)",
			rg11b10: "RG11B10 (downgraded)",
			"rg11b10-unsafe": "RG11B10 (no alpha, forced)",
		},
	},
	{
		name: "gpu",
		label: "WebGPU (master)",
		help: "Kill switch for every GPU kernel below. Off runs everything on the CPU.",
		group: "compute",
		options: ONOFF,
	},
	{
		name: "skylineGpu",
		label: "Skyline cost images",
		help: "Photo skyline detector: the per-pixel feature and sky-probability images on the GPU. Default on; off runs the CPU detector.",
		group: "compute",
		options: ONOFF,
	},
	{
		name: "renderBundles",
		label: "Terrain render bundles",
		help: "WebGPU: replay the GPU-culled terrain draws from recorded render bundles (less CPU encode per frame, same pixels). Opt-in until the batch pass measures it.",
		group: "compute",
		options: ONOFF,
	},
	{
		name: "imagery",
		label: "Imagery provider",
		help: "Default: swisstopo in CH, Esri elsewhere. swisstopo: licence-clean, CH only. Custom needs VITE_IMAGERY_URL.",
		group: "data",
		options: {
			default: "Default",
			esri: "Esri",
			swisstopo: "swisstopo",
			custom: "Custom",
		},
	},
	{
		name: "attrib",
		label: "Attribution",
		help: "Full: per-source credits in the UI and the PNG export footer.",
		group: "data",
		options: { classic: "Classic", full: "Full" },
	},
	{
		name: "osmextract",
		label: "Local OSM extracts",
		help: "Answer covered peak queries from public/osm instead of Overpass.",
		group: "data",
		options: ONOFF,
	},
	{
		name: "share",
		label: "Share links (beta)",
		help: "Copy a read-only link to an accepted pose of a sample photo. Off until the licence review clears.",
		group: "data",
		options: ONOFF,
	},
	{
		name: "tiles3dBias",
		label: "3D Tiles depth bias",
		help: "Log-depth w scale toward the camera (per-source default ~0.97–0.998).",
		group: "debug",
		placeholder: "per source",
		step: 0.001,
	},
	{
		name: "tiles3dDebug",
		label: "3D Tiles debug",
		help: "TILES3D_DEBUG shader define in the deck tiles layer.",
		group: "debug",
		options: ONOFF,
	},
];
