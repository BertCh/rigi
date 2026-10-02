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
	{ id: "step", label: "Step Inside", blurb: "Near-field splats service." },
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
		name: "terrain",
		label: "Terrain path",
		help: "Batched: one instanced grid per resolution (default). Per tile: one mesh per tile.",
		group: "render",
		options: { batched: "Batched", tiles: "Per tile" },
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
		help: "Fill: tiles only outside the photo frame (the photo stays the truth). Over: tiles everywhere (alignment check).",
		group: "tiles",
		options: { fill: "Fill", over: "Over" },
	},
	{
		name: "nearfield",
		label: "Near field",
		help: "Auto: probes the splat service (never under automation). On: also under automation. SHARP: Apple SHARP splats (research-only weights). Complete: On plus the completion heuristics (display-only).",
		group: "step",
		options: {
			auto: "Auto",
			on: "On",
			sharp: "SHARP",
			complete: "Complete",
			off: "Off",
		},
	},
	{
		name: "cammodes",
		label: "Camera-mode bar without the service",
		help: "Shows the photo / orbit / fly / top-down bar even when Step Inside is unavailable.",
		group: "step",
		options: ONOFF,
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
		name: "gpuHorizon",
		label: "Skyline march",
		help: "Auto-align's horizon profile on the GPU (matches the CPU to ~1e-4°).",
		group: "compute",
		options: ONOFF,
	},
	{
		name: "mosaicGpu",
		label: "Mosaic mips on GPU",
		help: "Builds the skyline march's max-mip pyramid on the GPU (same bytes as the CPU), skipping the CPU build and upload.",
		group: "compute",
		options: ONOFF,
	},
	{
		name: "horizonPrecision",
		label: "Skyline precision",
		help: "Certified f32: the skyline's angle stages on the GPU with an exact certificate and CPU f64 ties (same output).",
		group: "compute",
		options: { f64: "f64 (CPU)", "certified-f32": "Certified f32" },
	},
	{
		name: "lookgpu",
		label: "Look passes",
		help: "Relief / haze on the GPU (~2× faster, ≤ 1 byte parity).",
		group: "compute",
		options: ONOFF,
	},
	{
		name: "skyGpuPrep",
		label: "Sky input prep",
		help: "The sky model's input resampled and normalised on the GPU from the photo bitmap (same bytes as the CPU prep).",
		group: "compute",
		options: ONOFF,
	},
	{
		name: "statsFold",
		label: "Band stats fold",
		help: "gpu: the colour-harmonise band stats are folded and finalized on the GPU (f32, luma GPUProgram) and only 256 B come back; f64: the partial sums are folded on the CPU.",
		group: "compute",
		options: { gpu: "GPU (default)", f64: "f64 (CPU)" },
	},
	{
		name: "statsSubgroups",
		label: "Band stats subgroups",
		help: "Reduce the band stats per workgroup with subgroupAdd where the device has subgroups (layout-checked, plain fallback).",
		group: "compute",
		options: ONOFF,
	},
	{
		name: "unknownGpu",
		label: "Unknown-pose 360° horizon",
		help: "GPU 360° horizon for photos without a compass heading or gravity (off: the CPU march). Same accept decisions within the CPU horizon's own noise.",
		group: "compute",
		options: ONOFF,
	},
	{
		name: "skylineGpu",
		label: "Skyline cost images",
		help: "Photo skyline detector: the per-pixel feature and sky-probability images on the GPU (Viterbi and sky-model fits stay on the CPU). Rows match the CPU to 1e-4 px.",
		group: "compute",
		options: ONOFF,
	},
	{
		name: "terrainGpuCull",
		label: "Terrain GPU cull",
		help: "WebGPU: cull the batched terrain's tiles on the GPU and draw them indirectly (no CPU cull per frame).",
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
		name: "terrainGpuDecode",
		label: "Terrain GPU decode",
		help: "WebGPU: decode the DEM tiles on the GPU straight into the terrain's height arrays; CPU heights only where labels, trails or queries ask (same heights bit for bit). Opt-in until its gates pass.",
		group: "compute",
		options: ONOFF,
	},
	{
		name: "alignPrecision",
		label: "Align refine precision",
		help: "certified-f32: the auto-align refine runs as a GPU loop with certified f32 compares (same result as f64; the CPU decides only ties). Opt-in until its wild-set gate passes.",
		group: "compute",
		options: { f64: "f64 (default)", "certified-f32": "Certified f32" },
	},
	{
		name: "hazeBandGpu",
		label: "Haze band on GPU",
		help: "WebGPU: the fitted haze's airlight band runs on the GPU (one submit, no range planes read back; same fit bit for bit, spot-checked). Off = the CPU band.",
		group: "compute",
		options: ONOFF,
	},
	{
		name: "hazeArgminGpu",
		label: "Haze grid arg-min on GPU",
		help: "The fitted haze's grid minimum and candidate cells are picked on the GPU (a luma GPUProgram); only the candidates are read back. Same fit bit for bit, checked per call. Off = read the whole grid.",
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
		name: "cogReader",
		label: "swisstopo COG reader",
		help: "Surface-model reads for DSM occluders: loaders.gl (GeoTIFFSourceLoader, tile-cached ranges) or the built-in parser.",
		group: "data",
		options: { loaders: "loaders.gl", own: "Built-in" },
	},
	{
		name: "tiles3dGeoid",
		label: "3D Tiles geoid N (m)",
		help: "Overrides the geoid undulation applied to ellipsoidal tilesets.",
		group: "debug",
		placeholder: "auto",
		step: 0.1,
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
