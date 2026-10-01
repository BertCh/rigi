// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Crosswalk: position, time, evidence and world-data provenance words → canonical axes.

import type { InteriorPin } from "#/lib/concord/core/types";
import type { EyePrior } from "#/lib/concord/priors/altitude";
import type { CueFamily } from "#/lib/geocam/core/types";
import type { LakeLevel } from "#/lib/geocam/lakes/levels";
import type { positionSource } from "#/lib/integration/unknown-pose";
import type { SpotDepthSource } from "#/lib/nearfield/roll/roll-spot";
import type { Provenance as SplatProvenance } from "#/lib/nearfield/types";
import type { Placement } from "#/lib/roll/import";
import type { PositionProvenance } from "#/lib/roll/import/provenance";
import type { SkyMask } from "#/lib/sky";
import type { LocalPhotoExtras } from "#/lib/upload/exif";
import type { Assert, Equal } from "../core/assert";
import type { EvidenceFamily, ProvenanceClass } from "../core/provenance";

// ---- position --------------------------------------------------------------------------------------

/** A person placing the photo on the map. */
export const USER_MAP_PIN = {
	agent: "user",
	method: "map-pin",
	status: "endorsed",
} as const satisfies ProvenanceClass;
/** The device's GPS fix. */
export const GPS_FIX = {
	agent: "sensor",
	method: "gps-fix",
	role: "prior",
} as const satisfies ProvenanceClass;
/**
 * "Not from GPS": a user pin OR a track estimate. roll/import stores interpolated positions through
 * withPosition, which writes positionSource "pin", so the stored word can't tell them apart
 * (FINDINGS); roll/import/provenance.ts keeps the real method.
 */
export const NOT_GPS = { role: "prior" } as const satisfies ProvenanceClass;

/** LocalPhotoMeta.local.positionSource (upload / import). */
export const UPLOAD_POSITION_SOURCE = {
	exif: GPS_FIX,
	pin: NOT_GPS,
} as const satisfies Record<
	LocalPhotoExtras["positionSource"],
	ProvenanceClass
>;

/**
 * integration/unknown-pose positionSource(): the SAME fact under different words, sent to the matcher
 * (which special-cases anything but "exif-gps"). Each word maps to the identical class.
 */
export const MATCHER_POSITION_SOURCE = {
	"exif-gps": UPLOAD_POSITION_SOURCE.exif,
	manual: UPLOAD_POSITION_SOURCE.pin,
} as const satisfies Record<ReturnType<typeof positionSource>, ProvenanceClass>;

export const IMPORT_POSITION_METHOD = {
	interpolated: { agent: "rule", method: "track-interpolate" },
	nearest: { agent: "rule", method: "track-nearest" },
	pin: USER_MAP_PIN,
} as const satisfies Record<PositionProvenance["method"], ProvenanceClass>;

export const PLACEMENT = {
	gps: GPS_FIX,
	estimate: { agent: "rule", method: "track-interpolate", status: "candidate" },
	pin: USER_MAP_PIN,
	none: { status: "failed" },
} as const satisfies Record<Placement["kind"], ProvenanceClass>;

/** concord eye prior: "pin" = the DEM-floor rule applied at a non-GPS position. */
export const EYE_PRIOR_SOURCE = {
	"gps+alt-contour": { agent: "rule", method: "alt-contour", role: "prior" },
	"gps+dem-floor": { agent: "rule", method: "eye-rule", role: "prior" },
	pin: { agent: "rule", method: "eye-rule", role: "prior" },
} as const satisfies Record<EyePrior["source"], ProvenanceClass>;

export const TIME_SOURCE = {
	gps: { agent: "sensor", method: "exif-time" },
	exif: { agent: "sensor", method: "exif-time" },
	"exif-local": { agent: "sensor", method: "exif-time", level: "low" },
	file: { agent: "rule", method: "default", level: "low" },
} as const satisfies Record<LocalPhotoExtras["timeSource"], ProvenanceClass>;

// ---- evidence ----------------------------------------------------------------------------------------

/** geocam's CueFamily is exactly the MAP block of EVIDENCE (both directions). */
export type _cueFamilyIsEvidence = Assert<
	Equal<
		CueFamily,
		Exclude<
			EvidenceFamily,
			"time" | "appearance" | "rotation" | "pixels" | "terrain" | "map"
		>
	>
>;

// ---- world data --------------------------------------------------------------------------------------

export const LAKE_LEVEL_SOURCE = {
	osm: { agent: "reference", method: "osm-data" },
	table: { agent: "reference", method: "level-table" },
	dem: { agent: "reference", method: "dem-sample", level: "low" },
} as const satisfies Record<LakeLevel["source"], ProvenanceClass>;

export const INTERIOR_PIN_SOURCE = {
	osm: { agent: "reference", method: "osm-data" },
	swisstopo: { agent: "reference", method: "swisstopo-data" },
	manual: { agent: "user", status: "endorsed" },
} as const satisfies Record<InteriorPin["source"], ProvenanceClass>;

/** Step Inside per-splat provenance (also a shader code: nearfield PROVENANCE_CODE). */
export const SPLAT_PROVENANCE = {
	observed: { agent: "model", method: "depth-model", role: "observation" },
	reconstructed: { agent: "model", method: "splat-model" },
	dem: { agent: "reference", method: "dem-sample" },
	generated: { agent: "model", method: "generative-model", level: "low" },
} as const satisfies Record<SplatProvenance, ProvenanceClass>;

/** Step Inside depth for a roll viewpoint (nearfield/roll/roll-spot.ts SpotDepthSource). */
export const SPOT_DEPTH_SOURCE = {
	multiview: { agent: "model", method: "depth-multiview" },
	"multiview-joint": { agent: "model", method: "depth-multiview" },
	moge2: { agent: "model", method: "depth-model" },
	da3: { agent: "model", method: "depth-model" },
} as const satisfies Record<SpotDepthSource, ProvenanceClass>;

export const SKY_SOURCE = {
	model: { agent: "model", method: "sky-model" },
	fallback: { agent: "rule", method: "sky-fallback", level: "low" },
} as const satisfies Record<NonNullable<SkyMask["source"]>, ProvenanceClass>;
