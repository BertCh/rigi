// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Semantic findings: places where the code disagrees with itself, found by modelling it. Data, so the
// report lists them and ontology.check.ts pins the ones it can measure (e.g. concord drift).

export type Finding = {
	readonly kind: "drift" | "homonym" | "synonym" | "units" | "deferred";
	readonly summary: string;
	readonly where: readonly string[];
	readonly action: string;
};

export const FINDINGS = [
	{
		kind: "drift",
		summary:
			"FIXED in b9d29b1. Stale verdict (app bug): an eye move or a restored save re-creates the engine and sets alignState 'manual'/'saved', but a second opinion aborted by that teardown never clears `verify` (the catch skips setVerify(null) when aborted). A hand-moved pose can then show the 'Verified'/'Refined' badge, concord counts it HIGH, and exports stay locked if verify was 'pending'.",
		where: [
			"components/PhotoWorkspace.tsx:433-437 (manual/saved without setVerify(null))",
			"components/PhotoWorkspace.tsx:556 (aborted catch keeps verify)",
		],
		action:
			"Fixed: setVerify(null) in both branches (b9d29b1). Canonically a verdict on a person's pose is ignored (workspaceProvenance); staleVerifyStates() keeps the old states so the checks prove every gate would ignore them.",
	},
	{
		kind: "drift",
		summary:
			"Three 'accepted pose' gates. picker isAutoHigh (= canonical isTrustedAuto) and nearfield poseAccepted (= canonical endorsed-or-trusted) agree with the ontology on every reachable state. concordConfidence counts any corroborating verdict under any align state; that differed only on the stale-verdict states, unreachable since b9d29b1, so all three gates now agree on every reachable state.",
		where: [
			"lib/picker/candidates.ts isAutoHigh",
			"lib/nearfield/controller.ts poseAccepted",
			"lib/concord/app/useConcordDisplay.ts concordConfidence",
		],
		action:
			"Gates should call the canonical predicates (workspaceIsTrustedAuto / workspaceIsSettled) so the three rules can't drift apart again; ontology.check.ts proves agreement on every reachable state.",
	},
	{
		kind: "drift",
		summary:
			"Eye height without GPS altitude: the engine and roll ridgelines use DEM + 1.8 m, geo/pipeline (solver scene) uses DEM + 1.6 m.",
		where: [
			"lib/engine.ts:393",
			"lib/roll/mosaic/ridgelines.worker.ts:89",
			"lib/geo/pipeline.ts:45",
		],
		action: "Record as the eye-rule concept; unify in the engine owner's pass.",
	},
	{
		kind: "synonym",
		summary:
			"Position source is one fact under four vocabularies: upload 'exif'|'pin', matcher 'exif-gps'|'manual', import 'interpolated'|'nearest'|'pin', EyePrior 'gps+…'|'pin'. Worse, roll import stores TRACK-INTERPOLATED positions as positionSource 'pin', so 'pin'/'manual' really means 'not GPS'.",
		where: [
			"lib/upload/exif.ts",
			"lib/integration/unknown-pose.ts positionSource",
			"lib/roll/import/provenance.ts",
			"lib/concord/priors/altitude.ts",
		],
		action:
			"All crosswalk to the same ProvenanceClass rows (crosswalk/world.ts).",
	},
	{
		kind: "synonym",
		summary:
			"Prior unknowns have two polarities: app yawUnknown/pitchRollUnknown/focalUnknown, bench harness focalKnown.",
		where: ["lib/upload/exif.ts", "tools/bench/harness/cascade.ts"],
		action: "Concept prior-unknowns; new code uses the *Unknown polarity.",
	},
	{
		kind: "homonym",
		summary:
			"Same export name, different concept: PhotoMeta (app record vs raw EXIF), SolveResult (geo vs pose6dof), Params (pose6dof vs peakfix), PeakLabel ×3, PeakInput ×3, CompositeLook (style type vs look class), Confidence (refine vs ontology). RESOLVED 2026-10-01: ExifPhotoMeta, SkylineSolveResult / GcpSolveResult, FitParams / GcpParams, PeakLabelPx / BaselinePeakLabel (settings PeakLabel keeps the name), GeoJsonPeak / RidgelinePeakInput, CompositeLookStyle, RefineConfidence.",
		where: [
			"lib/photos.ts",
			"lib/geo/photo-meta.ts",
			"lib/geo/solve.ts",
			"lib/pose6dof/types.ts",
			"lib/settings.ts",
			"lib/geo/peaks.ts",
			"lib/deck/scene.ts",
		],
		action:
			"Done: each export now has a unique name; the concept words live in lib/ontology/domain.ts.",
	},
	{
		kind: "homonym",
		summary:
			"'pin' means a peak↔pixel tap (workspace), a map position pin (upload/import), and a pixel+name control point (data/control-points.json).",
		where: [
			"lib/align.ts Pin",
			"lib/upload/exif.ts positionSource",
			"data/control-points.json",
		],
		action: "Concepts pin vs method map-pin vs correspondence.",
	},
	{
		kind: "units",
		summary:
			"Five pixel bases (norm, working px, 1600 wide, 1600 long side, 1000 wide) and four bbox orders; lat/lon order differs (TerrainSampler.sample(lon, lat) vs Terrain.heightAt(lat, lon); inside ONE region record, center is [lat, lon] but trail coords are [lon, lat]).",
		where: [
			"lib/refine/confidence.ts rmsPx1600",
			"lib/geocam/core/state.ts focalPx1600",
			"lib/picker/candidates.ts tapResidualPx",
			"lib/upload/region.ts bboxAround",
		],
		action:
			"PixelBasis + Px<B>, BBox + WSEN/SWNE converters, LonLatPair/LatLonPair brands.",
	},
	{
		kind: "synonym",
		summary:
			"View mode words: code overlay/replace/world, UI Overlay/Blend/In map; the union was declared three times (settings, three-apply, deck-apply).",
		where: [
			"lib/settings.ts",
			"lib/style/three-apply.ts",
			"lib/style/deck-apply.ts",
		],
		action:
			"StyleMode and DeckStyleMode are aliases of ViewMode; UI words in VIEW_MODE.",
	},
	{
		kind: "units",
		summary:
			"Photo ids: the FNV fallback id (local-f + 9 hex) is not disjoint from SHA-256 ids that start with f, contrary to the decode.ts comment.",
		where: ["lib/upload/decode.ts contentHash"],
		action:
			"Low risk (needs a 36-bit collision); give the fallback its own prefix if it matters.",
	},
	{
		kind: "deferred",
		summary:
			"Vec3 copies inside files with in-flight patches (gpu/**, deck/**, deck-webgpu/**, look haze/relief) keep their local declaration for now.",
		where: ["lib/gpu", "lib/deck", "lib/deck-webgpu", "lib/look"],
		action: "Re-export the ontology Vec3 once those patches land.",
	},
	{
		kind: "deferred",
		summary:
			"Realizations in modules not yet committed: demo/index.ts DemoPose (pose-estimate) and peakfix/layered.ts LayeredHorizon (horizon).",
		where: ["lib/demo", "lib/peakfix"],
		action:
			"Add them to catalogue/concepts.ts realizedBy once those modules are in HEAD.",
	},
] as const satisfies readonly Finding[];
