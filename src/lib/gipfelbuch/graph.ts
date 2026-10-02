// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The Rigi Gipfelbuch: a deliberately tiny, curated graph of the core of Rigi (viewport inference, terrain
// snapping and what the app does with a pose). Hand-maintained; add a node only if it earns a deep page.
// The array is in reading (data-flow) order, so Blatt n is the n-th sheet: I infer the camera, II pin it
// to the terrain, III use the pose (reports/peak-notebook-plan.md §0).
import type { GipfelbuchNode } from "./types";

export const GIPFELBUCH_NODES: GipfelbuchNode[] = [
	{
		id: "photo",
		title: "Photo",
		claim: "A photo is pixels plus what the phone knew.",
		lede: "A photo is more than pixels: the phone also records where it was, which way it faced, how it was tilted, and the lens. That is where every solve starts.",
		group: "capture",
		kind: "concept",
		status: "live",
		tagline: "One image plus everything the device recorded about it.",
		summary:
			"A Photo is an image with size, time, position, heading, gravity and lens, whether bundled, uploaded, demo or benchmark. It optionally has a geo position, one camera prior and a region. Realized by PhotoMeta in lib/photos.ts and LocalPhotoMeta in upload/exif.ts.",
		modules: ["src/lib/photos.ts", "src/lib/upload/exif.ts"],
		reports: ["reports/ontology.md"],
		visual:
			"A photo that peels into layers: pixels, EXIF tags, derived prior cone and region footprint on a mini map.",
		ontologyId: "photo",
		related: [
			{
				id: "camera-prior",
				rel: "feeds",
			},
			{
				id: "skyline",
				rel: "feeds",
			},
		],
	},
	{
		id: "camera-prior",
		title: "Camera Prior",
		claim: "The sensors get close. The compass drifts.",
		lede: "Before any solving, the phone's sensors already give a rough guess of the camera. It is close enough to start from, and not good enough to trust.",
		group: "capture",
		kind: "concept",
		status: "live",
		tagline: "What the phone's sensors imply before any solving.",
		summary:
			"Compass yaw, gravity pitch/roll, EXIF focal and GPS position form a prior on the camera. It is a role fed into solves, not a source. Realized by pose6dof Priors and geocam PriorPhoto.",
		modules: [
			"src/lib/pose6dof/types.ts",
			"src/lib/geocam/priors/photo-priors.ts",
		],
		reports: ["reports/ontology.md", "reports/geometry-first-pose.md"],
		visual:
			"A pose cone rising from a map dot with a fuzzy yaw wedge that narrows as compass, gravity and focal evidence are toggled on.",
		ontologyId: "camera-prior",
		related: [
			{
				id: "pose-estimate",
				rel: "feeds",
			},
		],
	},
	{
		id: "skyline",
		title: "Skyline Detection",
		claim: "Where the mountain meets the sky.",
		lede: "The edge between mountain and sky is the one line a photo reliably shows. Rigi traces it column by column and says how sure it is of each part.",
		group: "evidence",
		kind: "algorithm",
		status: "live",
		tagline: "Find the line where mountain meets sky, one column at a time.",
		summary:
			"geo/skyline.ts fits a polynomial sky colour field by robust least squares and traces a Viterbi boundary per column with weights (about 120 ms at 800 px). refine/skyline-clean.ts rejects narrow spikes; sky/skyline.ts derives the same observation from an ML mask. A CPU ONNX mask gave a false accept so stays secondary.",
		modules: [
			"src/lib/geo/skyline.ts",
			"src/lib/refine/skyline-clean.ts",
			"src/lib/sky/skyline.ts",
		],
		reports: ["reports/leaderboard.md", "reports/negative-results.md"],
		visual:
			"A photo with a Viterbi trellis overlaid: candidate paths fan per column and the winner snaps into place while spikes are struck out.",
		ontologyId: "skyline",
		related: [
			{
				id: "baseline-pipeline",
				rel: "feeds",
			},
			{
				id: "dem-horizon",
				rel: "uses",
			},
		],
	},
	{
		id: "dem-horizon",
		title: "DEM Horizon",
		claim: "Far ridges are the fingerprint.",
		lede: "From where you stood, the terrain draws a silhouette against the sky. Rigi computes it in every direction, allowing for the earth's curve and the bending of light.",
		group: "evidence",
		kind: "algorithm",
		status: "live",
		tagline:
			"The 360-degree silhouette the terrain would draw, curvature and refraction included.",
		summary:
			"geo/horizon.ts ray-marches 7,200 azimuths over the DEM and returns the skyline elevation plus ridge crests (about 3.5 s, run in a Worker). It is the reference curve every skyline match fits against.",
		modules: ["src/lib/geo/horizon.ts", "src/lib/geo/terrain.ts"],
		reports: ["reports/Mountain photo georeferencing SoTA.md"],
		visual:
			"A top-down radar sweep over relief with a polar plot growing the horizon profile.",
		ontologyId: "horizon",
		related: [
			{
				id: "baseline-pipeline",
				rel: "feeds",
			},
		],
	},
	{
		id: "viewport-inference",
		title: "Viewport Inference",
		claim: "The compass guesses. The ridge does not.",
		lede: "The phone's compass is often wrong by many degrees. Rigi fixes it by sliding the skyline the terrain predicts until it sits on the skyline in the photo.",
		group: "solve",
		kind: "concept",
		status: "live",
		tagline:
			"Which way was the camera pointing? Slide the terrain's skyline onto the photo's.",
		summary:
			"Rigi infers yaw, pitch, roll and focal length by matching the skyline detected in the photo against the horizon the DEM predicts from the camera's position. The sensor prior seeds a coarse yaw × pitch grid, robust Levenberg–Marquardt refines the best minima, and a confidence product (inliers, coverage, ambiguity, relief, tilt) gates the result, with a full 360° retry under a stricter bar. A rejected solve falls back to the prior and to tapping peaks; it is never shown as certain.",
		modules: [
			"src/lib/geo/solve.ts",
			"src/lib/geo/skyline.ts",
			"src/lib/geo/horizon.ts",
			"src/lib/refine/index.ts",
		],
		reports: ["reports/status.md"],
		visual:
			"The DEM horizon sliding in yaw over the photo skyline, residual stems lighting up as inliers, above a yaw × pitch cost landscape with LM paths descending into the minimum.",
		related: [
			{
				id: "camera-prior",
				rel: "seeded-by",
			},
			{
				id: "skyline",
				rel: "observes",
			},
			{
				id: "dem-horizon",
				rel: "predicts-with",
			},
			{
				id: "baseline-pipeline",
				rel: "implemented-by",
			},
			{
				id: "accept-rule",
				rel: "gated-by",
			},
			{
				id: "pose-estimate",
				rel: "produces",
			},
			{
				id: "tap-a-peak",
				rel: "falls-back-to",
			},
		],
	},
	{
		id: "pose-estimate",
		title: "Pose Estimate",
		claim: "One small record is the whole camera.",
		lede: "The answer: which way the camera pointed, how it was tilted, how wide the lens was, where the eye was, and how we know.",
		group: "solve",
		kind: "concept",
		status: "live",
		tagline:
			"Where the camera stood and where it looked, plus how it is known.",
		summary:
			"The solved result of georeferencing: orientation (yaw, pitch, roll), vertical FOV and an eye in ENU, together with provenance. Every solver reads and writes this same convention. Realized by roll SolvedPose and second-opinion AppAlign.",
		modules: [
			"src/lib/pose.ts",
			"src/lib/geo/camera.ts",
			"src/lib/roll/types.ts",
			"src/lib/pose6dof/README.md",
		],
		reports: ["reports/status.md", "reports/ontology.md"],
		visual:
			"A 3D pose cone over a contour map with yaw/pitch/roll/focal sliders that redraw the projected skyline.",
		ontologyId: "pose-estimate",
		related: [
			{
				id: "photo-workspace",
				rel: "feeds",
			},
			{
				id: "camera-roll",
				rel: "feeds",
			},
		],
	},
	{
		id: "accept-rule",
		title: "Accept Rule (Precision First)",
		claim: "A wrong pose is worse than no pose.",
		lede: "A confidently wrong answer is worse than no answer. Rigi only shows a pose as certain when the evidence clearly agrees, and otherwise says so.",
		group: "product",
		kind: "concept",
		status: "live",
		tagline:
			"A wrong pose shown as certain is worse than no pose; fail closed.",
		summary:
			"Precision beats recall. Poses are HIGH only with explicit acceptance and enough confidence; the unknown-yaw cascade needs 0.75, matcher results need confidenceLevel HIGH, suggestions and user picks never become auto-accept. About a dozen hand-set gates implement it, none a likelihood.",
		modules: [
			"src/lib/picker/candidates.ts",
			"src/lib/concord/app/confidence.ts",
			"src/lib/refine/confidence.ts",
			"src/lib/integration/second-opinion.ts",
		],
		reports: [
			"reports/roadmap.md",
			"reports/bench-wild.md",
			"reports/test-addendum.md",
			"reports/fusion.md",
		],
		visual:
			"A precision-recall seesaw where a threshold slider pushes wrong accepts into HIGH and the fail-closed lock slams shut.",
		related: [
			{
				id: "pose-estimate",
				rel: "constrains",
			},
		],
	},
	{
		id: "tap-a-peak",
		title: "Tap-a-Peak Pins",
		claim: "A tap is a measurement with a name on it.",
		lede: "When the automatic match is unsure, you can fix it yourself. Tap one peak you recognise to set the direction; tap three to set the lens too.",
		group: "solve",
		kind: "ui",
		status: "live",
		tagline:
			"Tap known peaks: one pin gives yaw and pitch, three give focal too.",
		summary:
			"geo/control-points.ts and align.ts solve pose from user taps: 1 point gives yaw and pitch, 2 add roll, 3 or more add focal. Pins yield user-confirmed provenance, never an automatic HIGH.",
		modules: [
			"src/lib/geo/control-points.ts",
			"src/lib/align.ts",
			"src/lib/picker/PickerPanel.tsx",
		],
		reports: ["reports/roadmap.md", "reports/terrain-matching-research.md"],
		visual:
			"Peak chips on a photo; each tap locks a degree of freedom on a side panel and tightens the overlay.",
		ontologyId: "pin",
		methodIds: ["pin-solve"],
		related: [
			{
				id: "peak",
				rel: "uses",
			},
		],
	},
	{
		id: "baseline-pipeline",
		title: "Baseline Pipeline",
		claim: "Predict the skyline, find it, slide one onto the other.",
		lede: "The full path from photo to answer, running in your browser: read the sensors, load the terrain, find both skylines, line them up, then decide.",
		group: "solve",
		kind: "subsystem",
		status: "live",
		tagline:
			"Photo, DEM horizon, skyline match, accepted pose: the CPU path end to end.",
		summary:
			"The CPU-only pipeline in src/lib/geo: readPhotoMeta, cameraFromMeta, loadTerrain, computeHorizon, detectSkyline, then solvePose (coarse yaw/pitch grid, Cauchy LM, confidence gate, 360 degree retry). A rejection escalates to refinePose then manual tap-a-peak.",
		modules: [
			"src/lib/geo/pipeline.ts",
			"src/lib/geo/solve.ts",
			"src/lib/geo/photo-meta.ts",
			"src/lib/geo/README.md",
		],
		reports: [
			"reports/Mountain photo georeferencing SoTA.md",
			"reports/pipeline-ab.md",
			"reports/leaderboard.md",
		],
		visual:
			"A flow strip where a photo thumbnail slides through stages showing each artifact and a final green/red gate.",
		related: [
			{
				id: "skyline",
				rel: "uses",
			},
			{
				id: "dem-horizon",
				rel: "uses",
			},
			{
				id: "tap-a-peak",
				rel: "feeds",
			},
		],
	},
	{
		id: "dem-source",
		title: "DEM Source",
		claim: "Sharper tiles keep summits sharp.",
		lede: "The terrain model is a set of map tiles that store height instead of colour. Sharper tiles keep summits sharp, and sharp summits make better matches.",
		group: "world",
		kind: "data",
		status: "live",
		tagline:
			"Mapterhorn 512 px or Terrarium 256 px tiles, zoom chosen by distance.",
		summary:
			"dem/sources.ts defines DemSource records. MAPTERHORN (512 px WebP Terrarium tiles to z17, swissALTI3D in CH) is the approved default; TERRARIUM_AWS (256 px, z15) smooths summits and is kept as comparison. The cascade got 14 correct on Terrarium vs 25 on Mapterhorn.",
		modules: ["src/lib/dem/sources.ts", "src/lib/dem/index.ts"],
		reports: ["reports/licences.md", "reports/bench-wild.md"],
		visual:
			"Split-screen relief of one summit: blurred Terrarium vs razor-sharp Mapterhorn, with a draggable wipe.",
		ontologyId: "dem-source",
		related: [
			{
				id: "terrain-sampler",
				rel: "feeds",
			},
		],
	},
	{
		id: "terrain-sampler",
		title: "Terrain Sampler",
		claim: "One question: how high is the ground here?",
		lede: "Every part of Rigi asks one question: how high is the ground here? A single function answers it from the downloaded height tiles.",
		group: "world",
		kind: "subsystem",
		status: "live",
		tagline: "One function, heightAt(lat, lon), backed by a pile of tiles.",
		summary:
			"geo/terrain.ts loadTerrain downloads tiles around a GPS fix at several zoom levels and exposes bilinear sampling with fallback to coarser levels. It is the CPU ground truth that horizon, peak visibility and solvers query.",
		modules: [
			"src/lib/geo/terrain.ts",
			"src/lib/dem/load.ts",
			"src/lib/terrain.ts",
		],
		reports: ["reports/Mountain photo georeferencing SoTA.md"],
		visual:
			"A height probe over hillshade showing which tile level answered and the bilinear neighbourhood.",
		ontologyId: "terrain",
		methodIds: ["dem-sample"],
		related: [
			{
				id: "dem-horizon",
				rel: "feeds",
			},
			{
				id: "baseline-pipeline",
				rel: "feeds",
			},
			{
				id: "peak",
				rel: "feeds",
			},
		],
	},
	{
		id: "eye-rule",
		title: "Eye Rule",
		claim: "The camera never stands inside the mountain.",
		lede: "GPS altitude can put the camera inside the mountain. Rigi lifts the eye to at least standing height above the ground before drawing anything.",
		group: "camera",
		kind: "algorithm",
		status: "live",
		tagline: "max(GPS alt, DEM + 1.6 m), except where the engine says 1.8 m.",
		summary:
			"How eye height is set without a solve. A recorded drift: deck/scene.ts (eyeAltitude) and roll ridgelines use DEM+1.8 m while geo/pipeline uses DEM+1.6 m.",
		modules: [
			"src/lib/concord/priors/altitude.ts",
			"src/lib/deck/scene.ts",
			"src/lib/geo/pipeline.ts",
		],
		reports: ["reports/ontology.md"],
		visual:
			"Two stick figures on the same slope at 1.6 m and 1.8 m with horizon lines diverging by a few pixels.",
		ontologyId: "eye-rule",
		methodIds: ["eye-rule", "alt-contour"],
		related: [
			{
				id: "terrain-sampler",
				rel: "uses",
			},
			{
				id: "dem-horizon",
				rel: "feeds",
			},
		],
	},
	{
		id: "peak",
		title: "Peak",
		claim: "A summit becomes a label only if the eye can see it.",
		lede: "A peak is a named summit from OpenStreetMap. Rigi moves it onto the highest real ground nearby and only labels it if it can actually be seen.",
		group: "world",
		kind: "concept",
		status: "live",
		tagline: "A named summit with elevation and prominence.",
		summary:
			"An OSM natural=peak with elevation and prominence. Many shapes exist (Peak, RegionPeak, PoolPeak, PeakLabel x3), unified by the ontology catalogue.",
		modules: ["src/lib/geo/peaks.ts", "src/lib/photos.ts"],
		reports: ["reports/ontology.md"],
		visual:
			"A skyline silhouette where summits pop labels, and a card fans out the seven Peak types.",
		ontologyId: "peak",
		related: [
			{
				id: "photo-workspace",
				rel: "feeds",
			},
		],
	},
	{
		id: "terrain-snapping",
		title: "Terrain Snapping",
		claim: "The map is the referee for everything we place.",
		lede: "GPS and maps disagree with the ground. Rigi pins the camera, the summits and nearby depth to the real terrain model, so everything lands where it physically is.",
		group: "world",
		kind: "concept",
		status: "live",
		tagline:
			"Eyes, summits and depth, each pinned to the ground the DEM knows.",
		summary:
			"Everything Rigi places in the world is reconciled with the DEM. The eye is lifted to max(GPS altitude, ground + 1.6 m) and bounded below by a still lake's level; OSM peaks are moved to the highest DEM point within a radius that grows with distance; and monocular depth in Step Inside is anchored to DEM ray lengths with a scored fit. Each one is either a snap, a bound or a prior, chosen on purpose.",
		modules: [
			"src/lib/terrain.ts",
			"src/lib/deck/scene.ts",
			"src/lib/geocam/lakes/floor.ts",
			"src/lib/nearfield/anchor.ts",
		],
		reports: ["reports/status.md"],
		visual:
			"A terrain cross-section where a floating GPS fix drops onto the ground and its sightline grazes a ridge, an OSM peak pin jumping to the DEM summit inside a growing search ring, and depth rays snapping onto the DEM.",
		related: [
			{
				id: "dem-source",
				rel: "uses",
			},
			{
				id: "terrain-sampler",
				rel: "uses",
			},
			{
				id: "eye-rule",
				rel: "snaps",
			},
			{
				id: "peak",
				rel: "snaps",
			},
			{
				id: "dem-anchoring",
				rel: "snaps",
			},
			{
				id: "dem-horizon",
				rel: "feeds",
			},
		],
	},
	{
		id: "dem-anchoring",
		title: "DEM Anchoring",
		claim: "The map is a ruler the depth model never had.",
		lede: "A single photo's depth has no scale. Rigi uses the terrain as a ruler, so that nearby rocks and trees land at real distances in metres.",
		group: "nearfield",
		kind: "algorithm",
		status: "live",
		tagline:
			"The terrain is the ruler: fit a range curve so depth lands in metres.",
		summary:
			"anchor.ts calibrates model depth against DEM ray lengths on terrain pixels with a monotone piecewise-linear log-log curve, cutting median log error from 0.34 to 0.13. The residual becomes an anchor quality score: below 0.15 the scene is hidden. Not a good pose verifier (AUC 0.73).",
		modules: ["src/lib/nearfield/anchor.ts", "src/lib/nearfield/geom.ts"],
		reports: [
			"reports/step-inside-design.md",
			"reports/step-inside-results.md",
		],
		visual:
			"Scattered depth dots dragged by a rubber-band spline onto DEM range with a trust gauge settling.",
		related: [
			{
				id: "terrain-sampler",
				rel: "uses",
			},
		],
	},
	{
		id: "rigi",
		title: "Rigi in one sheet",
		claim: "The skyline tells us where the camera stood.",
		lede: "Point your phone at mountains and take a photo. Rigi works out exactly where the camera stood and looked, names every peak, and lets you step inside the view.",
		group: "product",
		kind: "concept",
		status: "live",
		tagline:
			"Georeference a mountain photo against real terrain, then look through it.",
		summary:
			"Rigi takes a photograph, solves where the camera stood and where it looked against a DEM, and renders overlays, camera rolls and a Step Inside near-field view from that pose. Precision beats recall: a wrong pose shown as certain is worse than none. Everything stays local-first in the browser, with optional Python services for escalation.",
		modules: [
			"src/lib/geo/pipeline.ts",
			"src/lib/renderer.ts",
			"src/components/PhotoWorkspace.tsx",
		],
		reports: ["reports/status.md", "reports/roadmap.md", "reports/README.md"],
		visual:
			"A rotating mountain panorama whose skyline traces light up as the camera zooms out into the whole constellation of subsystems.",
		related: [
			{
				id: "viewport-inference",
				rel: "uses",
			},
			{
				id: "terrain-snapping",
				rel: "uses",
			},
			{
				id: "baseline-pipeline",
				rel: "uses",
			},
			{
				id: "step-inside",
				rel: "uses",
			},
			{
				id: "camera-roll",
				rel: "uses",
			},
			{
				id: "photo-workspace",
				rel: "uses",
			},
			{
				id: "dem-source",
				rel: "uses",
			},
			{
				id: "accept-rule",
				rel: "constrains",
			},
		],
	},
	{
		id: "photo-workspace",
		title: "Photo Workspace",
		claim: "Show a pose fast. Certify it later.",
		lede: "One photo, with everything you can do to it: the peak overlay, alignment, pins, styles and export, all on one screen.",
		group: "product",
		kind: "ui",
		status: "live",
		tagline: "The single-photo cockpit: overlay, align, pin, export.",
		summary:
			"PhotoWorkspace (route /photo/$id) hosts one photo's engine view with overlay, alignment controls, concord display, ExportMenu, reveal and style panels, picker and eye suggestion. Bundled, demo and local photos load through the same code.",
		modules: [
			"src/components/PhotoWorkspace.tsx",
			"src/components/controls.tsx",
			"src/components/EyeSuggestion.tsx",
			"src/routes/photo.$id.tsx",
		],
		reports: ["reports/status.md"],
		visual:
			"An exploded view of photo, overlay, pins and controls as pullable translucent layers.",
		related: [
			{
				id: "tap-a-peak",
				rel: "uses",
			},
		],
	},
	{
		id: "camera-roll",
		title: "Camera Roll",
		claim: "A day of photos is a place, not a pile.",
		lede: "A day of photos becomes a place. Rigi groups them by where they were taken, poses each one, and shows them on a map and in 3D.",
		group: "roll",
		kind: "subsystem",
		status: "live",
		tagline:
			"A day's photos become a place: grouped, posed, mapped and stitched.",
		summary:
			"A Roll groups photos into areas (single-linkage, ROLL_LINK_M = 15 km) and viewpoints (VIEWPOINT_RADIUS_M = 250 m). Each photo gets the best pose available without running a solver: saved, hand-fitted ground truth, else the EXIF prior. Derived on the fly, never stored.",
		modules: [
			"src/lib/roll/roll.ts",
			"src/lib/roll/types.ts",
			"src/lib/roll/mosaic/loadRoll.ts",
			"src/routes/roll.$id.tsx",
			"src/routes/roll.index.tsx",
		],
		reports: ["reports/status.md", "reports/roadmap.md"],
		visual:
			"A hiking GPS track on dark topo where photo dots snap into 250 m viewpoint halos and link into one roll.",
		ontologyId: "roll",
		related: [
			{
				id: "step-inside",
				rel: "feeds",
			},
			{
				id: "photo-workspace",
				rel: "uses",
			},
		],
	},
	{
		id: "step-inside",
		title: "Step Inside",
		claim: "Far mountains are measured. Only near things are rebuilt.",
		lede: "Walk into your own photo. The near ground is rebuilt from the image, the far mountains come from the terrain model, and the terrain anchors the two together.",
		group: "nearfield",
		kind: "subsystem",
		status: "live",
		tagline:
			"Step into your photo: true camera, true mountains, reconstructed foreground.",
		summary:
			"Fuses a learned near-field reconstruction with the DEM far field, anchored by the solved metric pose. controller.ts orchestrates depth, anchoring, split and scene build; both engines render it with the camera starting exactly on the photo eye. Gated on an accepted pose and anchor quality; invisible when the service is down.",
		modules: [
			"src/lib/nearfield/controller.ts",
			"src/lib/nearfield/scene.ts",
			"src/components/nearfield/StepInsidePanel.tsx",
			"src/components/nearfield/useStepInside.ts",
		],
		reports: [
			"reports/step-inside-design.md",
			"reports/step-inside-results.md",
		],
		visual:
			"A photo peeling into depth layers with splats lifting toward the viewer while mountains stay pinned to a DEM wireframe.",
		ontologyId: "step-inside",
		related: [
			{
				id: "dem-anchoring",
				rel: "uses",
			},
			{
				id: "pose-estimate",
				rel: "uses",
			},
		],
	},
];
