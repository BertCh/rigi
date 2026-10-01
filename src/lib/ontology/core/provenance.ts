// L3: how Rigi knows a value. Provenance has orthogonal axes, never merged into one string:
//
//   agent     WHO produced it         user · sensor · solver · reference · model · rule
//   method    WHICH procedure         a METHODS row (skyline-align, cascade-refine, matcher, pin-solve…)
//   evidence  WHAT it rests on        EvidenceFamily[] (gps, compass, skyline, point, …; ⊇ geocam CueFamily)
//   role      HOW it is used          prior · observation · estimate · oracle
//   status    WHERE in its judgement  candidate · pending · accepted · endorsed · rejected · failed · superseded
//   outcome   what a CHECK did        kept · replaced · timeout · unavailable   (verification processes only)
//   corroborated                      an independent method agreed (this is what "verified" means)
//
// Old single-axis words map onto tuples of these (see crosswalk/*). E.g. AlignState "pinned" =
// {agent:user, method:pin-solve, status:endorsed}; SecondOpinionVerdict "verified" = {outcome:kept,
// corroborated:true}. `Provenance` is a SIDECAR: it sits next to a value (pose + poseProv) and never
// wraps it, so adopting it changes no runtime shape.

import type { Confidence, ConfidenceLevel } from "./confidence";
import type { Ref } from "./ids";
import type { IsoTime } from "./quantity";

// ---- agent -------------------------------------------------------------------------------------

export const AGENTS = {
	user: "a person, in this app (pin, drag, save, accept, map pin)",
	sensor: "the capturing device: GPS, compass, gravity, clock, lens/EXIF",
	solver:
		"a Rigi algorithm fitting evidence (align, cascade, matcher, propagate, …)",
	reference:
		"curated external truth: ground-truth fits, OSM, swisstopo, the DEM, tables",
	model: "a learned model (sky segmentation, depth, splats, generation)",
	rule: "a fixed default or deterministic rule (eye = DEM + 1.6 m, f35 = 26 mm, interpolation)",
} as const;
export type Agent = keyof typeof AGENTS;

// ---- evidence ----------------------------------------------------------------------------------

/**
 * What a value rests on. The first block is exactly geocam's CueFamily (crosswalk/evidence.ts proves
 * equality both ways); the second block is evidence Rigi uses outside the MAP solver.
 */
export const EVIDENCE = {
	// geocam CueFamily
	gps: "GNSS horizontal fix",
	alt: "GNSS / barometric altitude",
	ground: "standing on the DEM surface",
	lakeFloor: "at or above a nearby lake's level",
	gravity: "accelerometer gravity vector (pitch, roll)",
	compass: "magnetometer heading",
	focal: "lens focal length (EXIF f35 / lens table)",
	skyline: "photo skyline vs DEM horizon",
	point: "a 2D↔3D point (pin, summit, control point)",
	edge: "image edge vs terrain occlusion edge",
	junction: "edge junction vs terrain junction",
	level: "a horizontal level (lake shore, waterline) at known height",
	shore: "lake shore outline",
	// beyond the MAP solver
	time: "capture time (track interpolation, sun position)",
	appearance: "rendered-vs-photo appearance matching (matcher)",
	rotation: "relative rotation from a neighbouring photo (propagation)",
	pixels: "raw image pixels (segmentation, depth)",
	terrain: "the DEM itself",
	map: "map data (OSM, swisstopo vectors)",
} as const;
export type EvidenceFamily = keyof typeof EVIDENCE;

// ---- role --------------------------------------------------------------------------------------

export const ROLES = {
	prior:
		"a starting belief fed INTO a solve (EXIF compass/gravity/lens, GPS position)",
	observation: "a measurement a solve fits TO (skyline, pins, cues)",
	estimate: "the OUTPUT of a solve or a user's choice",
	oracle:
		"truth withheld from the system and used only to score it (ground truth in evaluation)",
} as const;
export type Role = keyof typeof ROLES;

// ---- status ------------------------------------------------------------------------------------

/** The judgement state of one estimate. Flat: no ordering is implied beyond what a policy says. */
export const STATUSES = {
	candidate: "produced, not (yet) judged; may be shown as a best guess",
	pending: "a judgement is running (second opinion, matcher, user review)",
	accepted: "passed an automatic accept rule",
	endorsed: "a person set or confirmed it (save, pin, drag, accept suggestion)",
	rejected: "failed an accept rule or was dismissed by a person",
	failed: "the producing process errored or found nothing",
	superseded: "replaced by a better estimate; kept for history",
} as const;
export type Status = keyof typeof STATUSES;

/** The result of a verification process run against an existing estimate. */
export const OUTCOMES = {
	kept: "the estimate stands",
	replaced: "a different estimate replaced it",
	timeout: "the check ran out of time",
	unavailable: "the checker could not run (service down, busy, unsupported)",
} as const;
export type Outcome = keyof typeof OUTCOMES;

// ---- methods -----------------------------------------------------------------------------------

export type MethodDef = {
	readonly agent: Agent;
	readonly label: string;
	readonly evidence: readonly EvidenceFamily[];
	/** module that implements it (repo-relative under src/ unless noted) */
	readonly module: string;
	/** what it estimates */
	readonly estimates: readonly (
		| "orientation"
		| "position"
		| "eye-height"
		| "focal"
		| "time"
		| "sky"
		| "depth"
		| "geometry"
	)[];
};

const m = (
	agent: Agent,
	label: string,
	evidence: readonly EvidenceFamily[],
	module: string,
	estimates: MethodDef["estimates"],
): MethodDef => ({ agent, label, evidence, module, estimates });

/** Every named procedure that produces a value in Rigi. */
export const METHODS = {
	// priors from the device
	"exif-prior": m(
		"sensor",
		"EXIF compass + gravity + lens",
		["compass", "gravity", "focal"],
		"lib/roll/roll.ts priorPose, lib/upload/exif.ts",
		["orientation", "focal"],
	),
	"gps-fix": m("sensor", "GPS position", ["gps", "alt"], "lib/upload/exif.ts", [
		"position",
		"eye-height",
	]),
	"exif-time": m(
		"sensor",
		"EXIF capture time",
		["time"],
		"lib/upload/exif.ts",
		["time"],
	),
	// automatic orientation
	"skyline-align": m(
		"solver",
		"Auto-align to skyline",
		["skyline", "compass", "gravity", "focal"],
		"lib/align.ts autoAlign",
		["orientation"],
	),
	"near-compass": m(
		"solver",
		"Skyline fit near the compass heading",
		["skyline", "compass"],
		"lib/integration/second-opinion.ts choosePreview",
		["orientation"],
	),
	cascade: m(
		"solver",
		"Unknown-pose cascade (solve, then refine on reject)",
		["skyline", "gravity", "focal", "gps", "alt"],
		"lib/integration/unknown-pose.ts",
		["orientation", "focal"],
	),
	"cascade-solve": m(
		"solver",
		"Unknown-pose cascade: global solve",
		["skyline", "gravity", "focal"],
		"lib/integration/unknown-pose.ts, lib/geo/pipeline.ts",
		["orientation", "focal"],
	),
	"cascade-refine": m(
		"solver",
		"Unknown-pose cascade: refine",
		["skyline", "gps", "alt"],
		"lib/refine",
		["orientation", "focal", "eye-height"],
	),
	matcher: m(
		"solver",
		"Render-and-match service",
		["appearance", "skyline"],
		"lib/matcher-client.ts, tools/matcher",
		["orientation"],
	),
	propagate: m(
		"solver",
		"Propagate from a neighbouring photo",
		["rotation"],
		"lib/roll/propagate",
		["orientation"],
	),
	"eye-refine": m(
		"solver",
		"Eye refinement on the skyline",
		["skyline", "ground"],
		"lib/pose6dof/eye.ts",
		["position", "eye-height"],
	),
	"geo-map": m(
		"solver",
		"Geometry-first MAP camera",
		[
			"gps",
			"alt",
			"ground",
			"lakeFloor",
			"gravity",
			"compass",
			"focal",
			"skyline",
			"point",
			"level",
			"shore",
		],
		"lib/geocam",
		["orientation", "position", "focal"],
	),
	concord: m(
		"solver",
		"Whole-image concordance",
		["point", "edge", "level", "shore"],
		"lib/concord",
		["orientation", "eye-height"],
	),
	// people
	"pin-solve": m(
		"user",
		"Solve from pinned peaks",
		["point"],
		"lib/align.ts solvePins",
		["orientation", "focal"],
	),
	"picker-tap": m(
		"user",
		"Pick a candidate / tap a peak",
		["point"],
		"lib/picker",
		["orientation"],
	),
	"manual-drag": m(
		"user",
		"Drag the overlay by hand",
		[],
		"components/PhotoWorkspace.tsx",
		["orientation"],
	),
	"map-pin": m(
		"user",
		"Place the photo on the map",
		[],
		"lib/upload, lib/roll/import",
		["position"],
	),
	// reference
	"ground-truth-fit": m(
		"reference",
		"Hand-fitted ground truth",
		["point"],
		"data/ground-truth.json",
		["orientation", "focal", "eye-height"],
	),
	"osm-data": m(
		"reference",
		"OpenStreetMap features",
		["map"],
		"lib/upload/region.ts, lib/osm",
		["geometry"],
	),
	"swisstopo-data": m(
		"reference",
		"swisstopo data",
		["map", "terrain"],
		"lib/tiles3d, lib/concord",
		["geometry"],
	),
	"dem-sample": m("reference", "DEM height sample", ["terrain"], "lib/dem", [
		"eye-height",
		"geometry",
	]),
	"level-table": m(
		"reference",
		"Lake level table",
		["map"],
		"lib/geocam/lakes/levels.ts",
		["eye-height"],
	),
	// rules
	"eye-rule": m(
		"rule",
		"Eye = max(GPS alt, DEM + 1.6 m) (DEM + 1.8 m without altitude in the engine)",
		["ground", "alt"],
		"lib/deck/scene.ts, lib/geo/pipeline.ts",
		["eye-height"],
	),
	"alt-contour": m(
		"rule",
		"Eye on the GPS-altitude iso-band",
		["gps", "alt", "ground"],
		"lib/concord/priors/altitude.ts",
		["position", "eye-height"],
	),
	"viewpoint-bias": m(
		"rule",
		"Shift a prior by the median yaw offset of the viewpoint's solved anchors",
		["compass", "rotation"],
		"lib/roll/align/viewpoint.ts",
		["orientation"],
	),
	"track-interpolate": m(
		"rule",
		"Interpolate position along the roll's GPS track",
		["time", "gps"],
		"lib/roll/import/interpolate.ts",
		["position"],
	),
	"track-nearest": m(
		"rule",
		"Nearest GPS'd photo in time",
		["time", "gps"],
		"lib/roll/import/interpolate.ts",
		["position"],
	),
	default: m(
		"rule",
		"Fixed default (f35 = 26 mm, level horizon, …)",
		[],
		"lib/upload/exif.ts",
		["focal", "orientation"],
	),
	"sky-fallback": m(
		"rule",
		"Colour-based sky fallback",
		["pixels"],
		"lib/sky",
		["sky"],
	),
	// models
	"sky-model": m("model", "Sky segmentation network", ["pixels"], "lib/sky", [
		"sky",
	]),
	"depth-model": m(
		"model",
		"Monocular depth (MoGe-2 / DA3)",
		["pixels"],
		"lib/nearfield",
		["depth"],
	),
	"splat-model": m(
		"model",
		"Gaussian splat lift (SHARP / lift)",
		["pixels"],
		"lib/nearfield",
		["geometry"],
	),
	"generative-model": m(
		"model",
		"Novel-view generation",
		["pixels"],
		"lib/nearfield/generate",
		["geometry"],
	),
} as const satisfies Record<string, MethodDef>;
export type MethodId = keyof typeof METHODS;

// ---- the sidecar -------------------------------------------------------------------------------

/** How a value is known. Every field is optional: record what you know, never invent the rest. */
export type Provenance = {
	agent?: Agent;
	method?: MethodId;
	evidence?: readonly EvidenceFamily[];
	role?: Role;
	status?: Status;
	/** set only on the result of a verification process */
	outcome?: Outcome;
	/** an independent method agreed with it ("verified") */
	corroborated?: boolean;
	confidence?: Confidence;
	/** level without a score (a strict accept rule, a level-only producer) */
	level?: ConfidenceLevel;
	at?: IsoTime;
	/** the things it was derived from (anchor photo, GT entry, …) */
	from?: readonly Ref[];
};

/** Per-field provenance for composite values (yaw from the compass, pitch/roll from gravity, …). */
export type FieldProvenance<T> = Partial<Record<keyof T, Provenance>>;

/** A partial provenance used as a crosswalk target (no time, refs or confidence: those are per instance). */
export type ProvenanceClass = Pick<
	Provenance,
	"agent" | "method" | "role" | "status" | "outcome" | "corroborated" | "level"
>;

/**
 * An AUTOMATIC estimate trustworthy enough to act on without asking (picker stays closed, concord
 * draws, exports unlock): accepted by a solver AND either corroborated by an independent method or
 * accepted by a strict (HIGH) rule. A person's own pose is trusted by definition, but is not "auto".
 */
export const isTrustedAuto = (p: ProvenanceClass): boolean =>
	agentOf(p) !== "user" &&
	p.status === "accepted" &&
	(p.corroborated === true || p.level === "high");

/** Agent implied by a provenance: explicit, else the method's. */
export const agentOf = (p: ProvenanceClass): Agent | undefined =>
	p.agent ?? (p.method ? METHODS[p.method].agent : undefined);

/** Evidence implied by a provenance: explicit, else the method's. */
export const evidenceOf = (p: Provenance): readonly EvidenceFamily[] =>
	p.evidence ?? (p.method ? METHODS[p.method].evidence : []);
