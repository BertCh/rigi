// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The Rigi concept catalogue: every noun the product, the code and the docs use, with its definition,
// its words (UI / code / avoided), its parts, and the TypeScript types that realize it. Realization keys
// are "<path under src/>#<ExportName>"; checks/realizations.ts maps every key to the real type with
// `import type`, so tsc proves each one exists and the two lists stay equal.

import type { IdConcept } from "../core/ids";
import type { StorageId } from "../core/storage";

export const DOMAINS = {
	capture: "what the photographer brought: photos, their metadata, rolls",
	world: "the terrain and mapped features the photo shows",
	camera: "where the camera was and how it pointed",
	evidence: "what is observed in the photo and matched to the world",
	estimate: "solving, judging and choosing camera estimates",
	presentation: "how a solved photo is drawn: modes, looks, labels, layers",
	interchange: "files and formats that leave the app",
	system: "renderers, flags, settings, storage",
} as const;
export type Domain = keyof typeof DOMAINS;

export type Cardinality = "1" | "0..1" | "*" | "1..*";
export type Part = { readonly concept: string; readonly card: Cardinality };

export type ConceptDef = {
	readonly label: string;
	readonly domain: Domain;
	/** taxonomy parent (is-a) */
	readonly is?: string;
	readonly definition: string;
	/** words the UI shows for it */
	readonly ui?: readonly string[];
	/** identifiers the code uses for it */
	readonly code?: readonly string[];
	/** words to stop using (with the reason in the definition or note) */
	readonly avoid?: readonly string[];
	/** has-a parts, by role name */
	readonly has?: Readonly<Record<string, Part>>;
	/** "<path under src/>#<Export>"; the first is canonical unless `canonical` says otherwise */
	readonly realizedBy: readonly string[];
	readonly frame?: string;
	readonly ids?: IdConcept;
	readonly storage?: readonly StorageId[];
	readonly note?: string;
};

const one = (concept: string): Part => ({ concept, card: "1" });
const opt = (concept: string): Part => ({ concept, card: "0..1" });
const many = (concept: string): Part => ({ concept, card: "*" });

export const CONCEPTS = {
	// ---- capture ---------------------------------------------------------------------------------
	photo: {
		label: "Photo",
		domain: "capture",
		definition:
			"One image plus what the phone recorded with it: time, position, heading, tilt and lens.",
		ui: ["Photo"],
		code: ["PhotoMeta", "photo", "meta"],
		has: {
			position: opt("geo-position"),
			prior: one("camera-prior"),
			region: opt("region"),
		},
		realizedBy: [
			"lib/photos.ts#PhotoMeta",
			"lib/upload/exif.ts#LocalPhotoMeta",
			"lib/upload/store.ts#PhotoRecord",
			"lib/geo/photo-meta.ts#ExifPhotoMeta",
		],
		ids: "photo",
		storage: ["uploads"],
		note: "geo/photo-meta.ts#PhotoMeta is the RAW EXIF record (optional fields, `altitude`, `focal35`); lib/photos.ts#PhotoMeta is the app record. Same name, different concepts: raw-exif vs photo.",
	},
	"raw-exif": {
		label: "Raw EXIF",
		domain: "capture",
		definition:
			"Tags as read from the file before Rigi interprets them (optional everything, magnetic or true heading, 35 mm focal).",
		code: ["ExifTags", "ExifPhotoMeta"],
		realizedBy: [
			"lib/upload/exif.ts#ExifTags",
			"lib/geo/photo-meta.ts#ExifPhotoMeta",
		],
	},
	"camera-prior": {
		label: "Prior",
		domain: "capture",
		is: "camera",
		definition:
			"The camera the phone's sensors imply before any solving: compass heading, tilt, lens and GPS position.",
		ui: ["compass + gravity", "phone sensors"],
		code: ["prior", "priorPose", "Priors", "PriorPhoto", "Unknowns"],
		has: { orientation: one("orientation"), unknowns: one("prior-unknowns") },
		realizedBy: [
			"lib/pose6dof/types.ts#Priors",
			"lib/geocam/priors/photo-priors.ts#PriorPhoto",
		],
	},
	"prior-unknowns": {
		label: "Unknown priors",
		domain: "capture",
		definition:
			"Which priors are placeholders, not measurements: yaw (no compass), gravity (no pitch/roll), focal (no lens data).",
		code: ["Unknowns", "yawUnknown", "pitchRollUnknown", "focalUnknown"],
		realizedBy: [
			"lib/integration/unknown-pose.ts#Unknowns",
			"lib/upload/exif.ts#LocalPhotoExtras",
		],
		note: "tools/bench uses the inverse polarity `focalKnown`.",
	},
	roll: {
		label: "Roll",
		domain: "capture",
		definition:
			"Photos of one area, shown as a mosaic, on the map and as a panorama. Grouped on the fly, never stored.",
		ui: ["Roll", "camera roll", "sample trip"],
		code: ["Roll"],
		has: {
			photos: { concept: "photo", card: "1..*" },
			viewpoints: many("viewpoint"),
			region: opt("region"),
		},
		realizedBy: ["lib/roll/types.ts#Roll", "lib/roll/types.ts#RollPhoto"],
		ids: "roll",
	},
	viewpoint: {
		label: "Viewpoint",
		domain: "capture",
		definition:
			"Photos taken from (almost) the same spot (250 m); their poses stitch into one panorama.",
		ui: ["Viewpoint", "spot"],
		code: ["Viewpoint", "VIEWPOINT_RADIUS_M"],
		has: { photos: { concept: "photo", card: "1..*" } },
		realizedBy: ["lib/roll/types.ts#Viewpoint"],
		note: "lib/roll/align/viewpoint.ts uses 'viewpoint' for a compass-bias ANCHOR: that is the viewpoint-bias method, not this concept.",
	},
	library: {
		label: "Library",
		domain: "capture",
		definition:
			"Everything on this device: bundled samples, the demo trip, and uploads in IndexedDB.",
		ui: ["My library"],
		has: { photos: many("photo"), rolls: many("roll") },
		realizedBy: ["lib/upload/index.ts#LocalPhotoSummary"],
		storage: ["uploads"],
	},

	// ---- world -----------------------------------------------------------------------------------
	region: {
		label: "Region",
		domain: "world",
		definition:
			"A ~20 km neighbourhood of mapped features (peaks, trails, water names, lakes) around one or more photos.",
		code: ["RegionData", "LocalRegion"],
		has: { peaks: many("peak"), trails: many("trail"), lakes: many("lake") },
		realizedBy: [
			"lib/photos.ts#RegionData",
			"lib/upload/region.ts#LocalRegion",
		],
		ids: "region",
		storage: ["uploads"],
	},
	feature: {
		label: "Mapped feature",
		domain: "world",
		definition: "Something named on the map that can appear in a photo.",
		realizedBy: ["lib/overpass.ts#OsmElement"],
	},
	peak: {
		label: "Peak",
		domain: "world",
		is: "feature",
		definition:
			"A named summit from OpenStreetMap, with its height and, where known, prominence.",
		ui: ["Peak", "summit"],
		code: ["Peak", "RegionPeak", "PoolPeak", "PeakInput", "PeakPoint"],
		realizedBy: [
			"lib/geo/peaks.ts#Peak",
			"lib/photos.ts#RegionPeak",
			"lib/picker/candidates.ts#PoolPeak",
			"lib/export/geojson.ts#GeoJsonPeak",
		],
		ids: "peak",
		frame: "wgs84; ele in metres MSL",
		note: "`ele` is `number|undefined` in Peak/PeakInput but `number|null` in RegionPeak/PoolPeak; RegionPeak has no id (keyed by name).",
	},
	lake: {
		label: "Lake",
		domain: "world",
		is: "feature",
		definition:
			"A water body whose level is a horizontal reference (shore cues, eye floor).",
		code: ["LakeGeo", "SceneLake", "LakeLevel"],
		realizedBy: [
			"lib/geocam/lakes/compact.ts#LakeGeo",
			"lib/geocam/lakes/levels.ts#LakeLevel",
		],
		ids: "lake",
	},
	trail: {
		label: "Trail",
		domain: "world",
		is: "feature",
		definition:
			"A mapped path with an SAC difficulty class, drawn on the terrain.",
		code: ["RegionTrail"],
		realizedBy: ["lib/photos.ts#RegionTrail"],
		frame:
			"coords are [lon, lat] pairs (LonLatPair), unlike RegionData.center [lat, lon]",
	},
	terrain: {
		label: "Terrain",
		domain: "world",
		definition:
			"The ground surface: heights above sea level, read from tiles that get coarser with distance.",
		code: ["Terrain", "TerrainSampler", "HeightFn"],
		has: { source: one("dem-source"), tiles: many("dem-tile") },
		realizedBy: ["lib/geo/terrain.ts#TerrainSampler"],
		frame: "heights MSL (≈ EGM2008)",
	},
	"dem-source": {
		label: "DEM source",
		domain: "world",
		definition:
			"A tiled height dataset, Mapterhorn or Terrarium; nearer ground gets finer tiles.",
		code: ["DemSource", "TerrainLevel"],
		realizedBy: ["lib/dem/sources.ts#DemSource"],
	},
	"dem-tile": {
		label: "DEM tile",
		domain: "world",
		definition:
			"One z/x/y height raster (row 0 = north), possibly an ancestor stand-in.",
		code: ["TileKey", "DemRaster"],
		realizedBy: ["lib/dem/tiles.ts#TileKey", "lib/dem/load.ts#DemRaster"],
		ids: "dem-tile",
		frame: "web-mercator slippy tile",
	},
	"tiles3d-source": {
		label: "3D Tiles source",
		domain: "world",
		definition:
			"Photogrammetry / building tiles drawn in Step Inside (swisstopo MSL, Google ellipsoidal; Google is display-only).",
		code: ["Tiles3DSource", "Tiles3DSourceId"],
		realizedBy: ["lib/tiles3d/config.ts#Tiles3DSource"],
	},

	// ---- camera ----------------------------------------------------------------------------------
	camera: {
		label: "Camera",
		domain: "camera",
		definition:
			"Everything needed to project the world into the photo: orientation, eye position and intrinsics, on an image size.",
		code: ["CameraX", "Camera", "CameraModel", "GeoState"],
		has: {
			orientation: one("orientation"),
			eye: one("eye"),
			intrinsics: one("intrinsics"),
		},
		realizedBy: [
			"lib/concord/core/types.ts#CameraX",
			"lib/geo/camera.ts#Camera",
			"lib/export/camera.ts#CameraModel",
			"lib/export/camera.ts#CameraInput",
			"lib/deck-webgpu/camera.ts#CameraState",
		],
		note: "Canonical decomposition is CameraX {pose, eye, aspect, intr}. geo Camera is the solvers' pixel form (f in px, axes vectors); bridge with poseToCamera/cameraToPose.",
	},
	orientation: {
		label: "Pose",
		domain: "camera",
		definition:
			"Where the camera pointed: yaw (true heading, clockwise from north), pitch (up +), roll (right side down +), and vertical field of view. Degrees. Carries NO position.",
		ui: ["Pose", "alignment"],
		code: ["Pose", "yaw", "pitch", "roll", "vfov"],
		avoid: ["pose (meaning position+orientation)"],
		realizedBy: ["lib/camera/index.ts#Pose", "lib/geo/camera.ts#CameraParams"],
		frame: "enu-eye; degrees",
		storage: ["savedPose", "solvedPose"],
	},
	intrinsics: {
		label: "Intrinsics",
		domain: "camera",
		definition:
			"The lens model beyond vfov: focal scale, k1 radial distortion, principal point (normalised). Default: square pixels, centred, no distortion.",
		code: ["Intrinsics", "f35", "focal", "fScale"],
		realizedBy: [
			"lib/concord/core/types.ts#Intrinsics",
			"lib/nearfield/geom.ts#IntrinsicsNorm",
		],
		note: "Four shapes, one lens: Intrinsics is a DEVIATION from the pinhole that pose.vfov implies (fScale × focal, k1, normalised centre offset); IntrinsicsNorm is absolute (fx/W, fy/H, cx/W, cy/H; fy = 0.5/tan(vfov/2), fx = fy/aspect); geo Camera f/cx/cy and export CameraModel.K are display-frame pixels (after EXIF orientation).",
	},
	eye: {
		label: "Eye",
		domain: "camera",
		definition:
			"The camera centre: lat/lon plus height (MSL). Usually GPS horizontally; vertically the eye rule unless solved.",
		ui: ["camera position"],
		code: ["eye", "eyeAlt", "EnuFrame", "Eye"],
		avoid: ["eyeOffset (pose6dof: it is absolute, not an offset)"],
		has: { position: one("geo-position"), rule: opt("eye-rule") },
		realizedBy: ["lib/geodesy.ts#EnuFrame"],
		frame: "wgs84 + MSL; engine ENU origin (lat, lon, h=0)",
	},
	"geo-position": {
		label: "Position",
		domain: "camera",
		definition: "A WGS84 point with an explicit height datum.",
		code: ["LatLon", "GeoPoint"],
		realizedBy: [
			"lib/geodesy.ts#LatLon",
			"lib/ontology/core/geometry.ts#GeoPoint",
		],
		storage: ["importPosition"],
	},
	"eye-rule": {
		label: "Eye rule",
		domain: "camera",
		definition:
			"How high the camera sits without a solve: the GPS altitude, but at least standing height above the ground.",
		code: ["EYE_ABOVE_GROUND", "eyeAlt"],
		realizedBy: ["lib/concord/priors/altitude.ts#EyePrior"],
		note: "Known drift: engine.ts:393 and roll ridgelines.worker.ts use 1.8 m when alt is null; geo/pipeline.ts:45 uses 1.6 m.",
	},

	// ---- evidence --------------------------------------------------------------------------------
	horizon: {
		label: "Horizon",
		domain: "evidence",
		definition:
			"The skyline the terrain predicts: the highest visible ridge in every direction.",
		code: [
			"HorizonProfile",
			"FastHorizonProfile",
			"EyeHorizon",
			"LayeredHorizon",
		],
		avoid: ["skyline (for the modelled curve)"],
		realizedBy: [
			"lib/geo/horizon.ts#HorizonProfile",
			"lib/pose6dof/eye.ts#EyeHorizon",
			"lib/horizon-fast/march.ts#FastHorizonProfile",
			"lib/peakfix/layered.ts#LayeredHorizon",
		],
		frame: "azel; elevation degrees at azimuth i·step",
	},
	skyline: {
		label: "Skyline",
		domain: "evidence",
		definition: "The line between sky and terrain as seen in the photo.",
		code: [
			"SkylineObservation",
			"SkylineRows",
			"SkylineInput",
			"SkylineSample",
		],
		has: { sky: opt("sky-mask") },
		realizedBy: [
			"lib/geo/skyline.ts#SkylineObservation",
			"lib/pose6dof/eye.ts#SkylineSample",
		],
		frame: "image; rows in working px (v down)",
	},
	"sky-mask": {
		label: "Sky mask",
		domain: "evidence",
		definition:
			"Per-pixel P(sky)·255, row 0 = top, from the segmentation model or a colour fallback.",
		code: ["SkyMask", "SkyMaskLike"],
		realizedBy: [
			"lib/sky/index.ts#SkyMask",
			"lib/ontology/core/geometry.ts#ByteMask",
		],
	},
	"foreground-mask": {
		label: "Foreground mask",
		domain: "evidence",
		definition:
			"Per-pixel person/foreground mask (255 = person), row 0 = top: protected from terrain blending and excluded from skyline evidence.",
		code: ["ForegroundMask", "protectPeople"],
		realizedBy: ["lib/segment.ts#ForegroundMask"],
		note: "renderer.ts FgMask is a generic 8-bit mask shape reused for foreground, P(sky) and the occluder, not this concept.",
	},
	correspondence: {
		label: "Correspondence",
		domain: "evidence",
		definition:
			"An image point tied to the world: a 3D point, a direction, a level or an azimuth. The input to pin solves and MAP.",
		code: [
			"Correspondence",
			"PointCorr",
			"DirCorr",
			"LevelCorr",
			"AzimuthCorr",
			"Corr2D3D",
		],
		realizedBy: [
			"lib/pose6dof/types.ts#Correspondence",
			"lib/geocam/map/factors.ts#Corr2D3D",
			"lib/geo/control-points.ts#ControlPoint",
		],
		frame: "image norm (u, v) ↔ ENU or azel",
	},
	pin: {
		label: "Pin",
		domain: "evidence",
		is: "correspondence",
		definition:
			"A tap that ties a named peak to a point in the photo. One pin sets direction, two add tilt, three add the lens.",
		ui: ["Pin"],
		code: ["Pin", "TapPin"],
		avoid: ["pin (meaning a map position pin: call that map-pin / place)"],
		realizedBy: ["lib/align.ts#Pin"],
		note: "session state only; the solved pose is saved, the pins are not.",
	},
	cue: {
		label: "Cue",
		domain: "evidence",
		is: "correspondence",
		definition:
			"An automatically found or curated correspondence of one evidence family (point, edge, level, shore), with residual and confidence.",
		code: ["Cue", "InteriorPin", "MatchedCue", "JointCue"],
		realizedBy: [
			"lib/concord/core/types.ts#Cue",
			"lib/concord/core/types.ts#InteriorPin",
		],
	},

	// ---- estimate --------------------------------------------------------------------------------
	"pose-estimate": {
		label: "Pose estimate",
		domain: "estimate",
		definition:
			"Where the camera pointed (sometimes where it stood), plus who found it, from what, and how sure.",
		code: [
			"SolvedPose",
			"AppAlign",
			"UnknownPoseOutcome",
			"SecondOpinion",
			"DemoPose",
		],
		has: { orientation: one("orientation"), provenance: one("provenance") },
		realizedBy: [
			"lib/roll/types.ts#SolvedPose",
			"lib/integration/second-opinion.ts#AppAlign",
			"lib/integration/unknown-pose.ts#UnknownPoseOutcome",
			"lib/integration/second-opinion.ts#SecondOpinion",
			"lib/demo/index.ts#DemoPose",
		],
		storage: ["solvedPose"],
	},
	candidate: {
		label: "Candidate",
		domain: "estimate",
		is: "pose-estimate",
		definition:
			"One of several alternative pose estimates offered for choice (picker, cascade seeds, autoAlign alternatives).",
		code: ["Candidate", "alternatives", "candidates", "RefineMode"],
		realizedBy: [
			"lib/picker/candidates.ts#Candidate",
			"lib/refine/index.ts#RefineMode",
		],
	},
	"solve-result": {
		label: "Solve result",
		domain: "estimate",
		definition:
			"A solver's full output: the estimate plus residuals, inliers, uncertainty and diagnostics.",
		code: [
			"SolveResult",
			"AlignResult",
			"RefineResult",
			"MapResult",
			"MatchResult",
			"UnknownPoseResult",
		],
		realizedBy: [
			"lib/align.ts#AlignResult",
			"lib/geo/solve.ts#SkylineSolveResult",
			"lib/pose6dof/types.ts#GcpSolveResult",
			"lib/refine/index.ts#RefineResult",
			"lib/geocam/core/types.ts#MapResult",
			"lib/matcher-client.ts#MatchResult",
			"lib/integration/unknown-pose.ts#UnknownPoseResult",
		],
		note: "Two exports are both named SolveResult (geo/solve.ts, pose6dof/types.ts).",
	},
	provenance: {
		label: "Provenance",
		domain: "estimate",
		definition:
			"How a value is known, on orthogonal axes: agent, method, evidence, role, status, outcome, corroboration, confidence.",
		code: ["PoseSource", "AlignState", "positionSource", "source", "method"],
		realizedBy: [
			"lib/ontology/core/provenance.ts#Provenance",
			"lib/roll/types.ts#PoseSource",
		],
	},
	confidence: {
		label: "Confidence",
		domain: "estimate",
		definition:
			"A producer's score on its own scale, read as a comparable level (high/medium/low/unknown).",
		code: ["confidence", "Confidence", "PoseConfidence", "confidenceLevel"],
		realizedBy: [
			"lib/ontology/core/confidence.ts#Confidence",
			"lib/refine/confidence.ts#RefineConfidence",
			"lib/concord/app/confidence.ts#PoseConfidence",
		],
	},
	"ground-truth": {
		label: "Ground truth",
		domain: "estimate",
		definition:
			"Hand-fitted poses for bundled photos (data/ground-truth.json, quality good/approx/none). Shown as 'fitted'; an oracle in evaluation.",
		ui: ["fitted"],
		code: ["GT", "GtEntry", "ground-truth"],
		realizedBy: ["lib/roll/roll.ts#GtEntry"],
	},
	suggestion: {
		label: "Suggestion",
		domain: "estimate",
		is: "pose-estimate",
		definition:
			"A propagated pose offered for a person to accept or dismiss; never HIGH, never an anchor.",
		code: ["StoredSuggestion", "Proposal"],
		realizedBy: ["lib/roll/propagate/store.ts#StoredSuggestion"],
		storage: ["propagate"],
	},

	// ---- presentation ----------------------------------------------------------------------------
	"view-mode": {
		label: "View mode",
		domain: "presentation",
		definition:
			"How terrain and photo combine: Overlay (lines on the photo), Blend (terrain replaces parts of it), In map (3D world).",
		ui: ["Overlay", "Blend", "In map"],
		code: ["ViewMode", "overlay", "replace", "world", "DeckStyleMode"],
		avoid: ["replace (UI: Blend)", "world (UI: In map)"],
		realizedBy: [
			"lib/settings.ts#ViewMode",
			"lib/style/deck-apply.ts#DeckStyleMode",
		],
	},
	"blend-method": {
		label: "Blend method",
		domain: "presentation",
		definition:
			"How Blend chooses where terrain shows: lens, swipe, distance range, brush.",
		ui: ["Lens", "Swipe", "Distance", "Brush"],
		code: ["BlendMethod", "range"],
		realizedBy: ["lib/settings.ts#BlendMethod"],
	},
	look: {
		label: "Look",
		domain: "presentation",
		definition:
			"The whole visual style of a view (terrain lighting, overlay lines, bands, labels): a preset plus overrides.",
		ui: ["Look", "Style"],
		code: ["ViewStyle", "StyleState", "PresetId"],
		has: { preset: one("look-preset") },
		realizedBy: [
			"lib/style/types.ts#ViewStyle",
			"lib/style/types.ts#StyleState",
		],
		storage: ["viewStyle"],
	},
	"look-preset": {
		label: "Look preset",
		domain: "presentation",
		definition:
			"A named patch over CLASSIC (classic, minimal, topo-map, night, …).",
		code: ["PresetId", "PRESETS"],
		realizedBy: ["lib/style/types.ts#PresetId"],
	},
	"peak-label": {
		label: "Label",
		domain: "presentation",
		definition:
			"A peak projected into the photo, ranked, occlusion-tested and laid out.",
		ui: ["labels"],
		code: ["PeakLabel", "LabelCandidate", "PlacedLabel"],
		has: { peak: one("peak") },
		realizedBy: [
			"lib/settings.ts#PeakLabel",
			"lib/geo/peaks.ts#PeakLabelPx",
			"lib/look/labels/layout.ts#LabelCandidate",
		],
		note: "Three exports named PeakLabel (settings.ts, deck/scene.ts, geo/peaks.ts).",
	},
	reveal: {
		label: "Reveal",
		domain: "presentation",
		definition:
			"The overlay's bloom-in animation on load (presets, duration, glow).",
		code: ["RevealConfig", "RevealPresetId"],
		realizedBy: ["lib/reveal/config.ts#RevealConfig"],
		storage: ["reveal"],
	},
	"step-inside": {
		label: "Step Inside",
		domain: "presentation",
		definition:
			"The near ground rebuilt in 3D on the terrain; view it from the photo, orbiting, flying or from above.",
		ui: ["Step Inside", "Photo", "Orbit", "Fly", "Top-down"],
		code: ["NearFieldScene", "StepMode", "GaussianCloud"],
		realizedBy: [
			"lib/nearfield/types.ts#NearFieldScene",
			"lib/nearfield/types.ts#GaussianCloud",
		],
	},

	// ---- interchange -----------------------------------------------------------------------------
	"export-format": {
		label: "Export format",
		domain: "interchange",
		definition:
			"A file Rigi writes for a solved photo (annotated PNG, KMZ, GeoJSON, pose JSON, COLMAP, XMP, splats).",
		code: ["ExportKind", "ExportFormat", "SplatExportKind"],
		realizedBy: [
			"lib/export/engine-export.ts#ExportFormat",
			"lib/export/splat.ts#SplatExportFormat",
		],
		storage: ["poseJson", "xmp"],
	},
	"pose-file": {
		label: "Pose file",
		domain: "interchange",
		is: "export-format",
		definition:
			"Self-describing pose JSON (schema rigi/pose v1): position with both datums, orientation, K, R|t.",
		realizedBy: ["lib/export/pose-json.ts#PoseJson"],
		storage: ["poseJson"],
	},

	// ---- system ----------------------------------------------------------------------------------
	renderer: {
		label: "Renderer",
		domain: "system",
		definition:
			"An engine that draws terrain behind/over the photo: deck.gl on WebGPU (default where available) or on WebGL (fallback).",
		code: ["Renderer", "WebGpuEngine", "DeckEngine"],
		realizedBy: ["lib/renderer.ts#Renderer"],
	},
	flag: {
		label: "Flag",
		domain: "system",
		definition:
			"A typed page-level switch (?name=value), read only through lib/flags.",
		code: ["FLAG_SCHEMA", "Flags", "FlagName"],
		realizedBy: ["lib/flags/index.ts#Flags"],
		storage: ["flags"],
	},
	settings: {
		label: "View settings",
		domain: "system",
		definition:
			"The workspace's per-view knobs (mode, blend method, overlay/replace/world layer choice, opacity, toggles).",
		code: ["Settings"],
		has: { mode: one("view-mode"), blend: one("blend-method") },
		realizedBy: ["lib/settings.ts#Settings"],
	},
} as const satisfies Record<string, ConceptDef>;

export type ConceptId = keyof typeof CONCEPTS;
/** Every realization key in the catalogue (checks/realizations.ts must map exactly these). */
export type RealizationKey = (typeof CONCEPTS)[ConceptId]["realizedBy"][number];
