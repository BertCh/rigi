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
			"Stale verdict (fixed b9d29b1): an eye move or restored save kept an aborted second opinion, so a hand-moved pose could show 'Verified' and count as HIGH.",
		where: [
			"components/PhotoWorkspace.tsx:433-437 (manual/saved without setVerify(null))",
			"components/PhotoWorkspace.tsx:556 (aborted catch keeps verify)",
		],
		action:
			"setVerify(null) in both branches; staleVerifyStates() keeps the old states under test.",
	},
	{
		kind: "drift",
		summary:
			"Three 'accepted pose' gates (picker, near-field, concord) are written separately; they agree on every reachable state.",
		where: [
			"lib/picker/candidates.ts isAutoHigh",
			"lib/nearfield/controller.ts poseAccepted",
			"lib/concord/app/useConcordDisplay.ts concordConfidence",
		],
		action:
			"Call workspaceIsTrustedAuto / workspaceIsSettled; ontology.check.ts proves agreement.",
	},
	{
		kind: "drift",
		summary:
			"Eye height without GPS altitude: DEM + 1.8 m in the engine and roll, DEM + 1.6 m in the solver.",
		where: [
			"lib/engine.ts:393",
			"lib/roll/mosaic/ridgelines.worker.ts:89",
			"lib/geo/pipeline.ts:45",
		],
		action: "Unify under the eye-rule concept.",
	},
	{
		kind: "synonym",
		summary:
			"Position source has four vocabularies (upload, matcher, import, eye prior); roll import stores track-interpolated positions as 'pin', so 'pin' means 'not GPS'.",
		where: [
			"lib/upload/exif.ts",
			"lib/integration/unknown-pose.ts positionSource",
			"lib/roll/import/provenance.ts",
			"lib/concord/priors/altitude.ts",
		],
		action: "All map to ProvenanceClass (crosswalk/world.ts).",
	},
	{
		kind: "synonym",
		summary:
			"Prior unknowns: app says focalUnknown, the bench says focalKnown.",
		where: ["lib/upload/exif.ts", "tools/bench/harness/cascade.ts"],
		action: "New code uses *Unknown.",
	},
	{
		kind: "homonym",
		summary:
			"Seven export names meant two or three things each (PhotoMeta, SolveResult, Params, PeakLabel, PeakInput, CompositeLook, Confidence).",
		where: [
			"lib/photos.ts",
			"lib/geo/photo-meta.ts",
			"lib/geo/solve.ts",
			"lib/pose6dof/types.ts",
			"lib/settings.ts",
			"lib/geo/peaks.ts",
			"lib/deck/scene.ts",
		],
		action: "Renamed (resolved); concept words live in lib/ontology/domain.ts.",
	},
	{
		kind: "homonym",
		summary: "'pin' means a peak tap, a map position, or a control point.",
		where: [
			"lib/align.ts Pin",
			"lib/upload/exif.ts positionSource",
			"data/control-points.json",
		],
		action: "Separate concepts: pin, map-pin, correspondence.",
	},
	{
		kind: "units",
		summary:
			"Five pixel bases, four bbox orders and mixed lat/lon order, even inside one region record.",
		where: [
			"lib/refine/confidence.ts rmsPx1600",
			"lib/geocam/core/state.ts focalPx1600",
			"lib/picker/candidates.ts tapResidualPx",
			"lib/upload/region.ts bboxAround",
		],
		action: "Branded types: Px<B>, WSEN/SWNE, LonLatPair/LatLonPair.",
	},
	{
		kind: "synonym",
		summary:
			"View mode: code says overlay/replace/world, UI says Overlay/Blend/In map.",
		where: [
			"lib/settings.ts",
			"lib/style/three-apply.ts",
			"lib/style/deck-apply.ts",
		],
		action: "One ViewMode; UI words in VIEW_MODE.",
	},
	{
		kind: "units",
		summary:
			"Fallback photo ids (local-f…) can collide with SHA-256 ids starting with f.",
		where: ["lib/upload/decode.ts contentHash"],
		action: "Low risk; give the fallback its own prefix if needed.",
	},
	{
		kind: "deferred",
		summary: "Local Vec3 copies remain in gpu, deck, deck-webgpu and look.",
		where: ["lib/gpu", "lib/deck", "lib/deck-webgpu", "lib/look"],
		action: "Re-export the ontology Vec3.",
	},
	{
		kind: "deferred",
		summary: "DemoPose and LayeredHorizon are not yet listed as realizations.",
		where: ["lib/demo", "lib/peakfix"],
		action: "Add them to realizedBy in catalogue/concepts.ts.",
	},
] as const satisfies readonly Finding[];
