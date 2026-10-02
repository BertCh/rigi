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
		claim: "A photo is an image plus the phone's sensor readings.",
		lede: "Along with the image, the phone records its GPS position, compass heading, tilt and lens. Rigi starts every solve from these readings.",
		group: "capture",
		kind: "concept",
		status: "live",
		tagline: "One image plus what the phone recorded.",
		summary:
			"A photo is an image with its size, time, position, heading, tilt and lens. It optionally has a position, one camera prior and a region.",
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
		claim: "The phone's sensors give a first, rough guess of the camera.",
		lede: "GPS, compass, tilt and lens together give a rough camera position and direction. Rigi uses it as a starting point, but the compass is often off by several degrees.",
		group: "capture",
		kind: "concept",
		status: "live",
		tagline: "What the phone's sensors imply before any solving.",
		summary:
			"Compass heading, tilt, lens and GPS position form a first guess of the camera that every solve starts from.",
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
		claim: "Rigi finds the skyline in the photo.",
		lede: "Rigi finds the line where the mountains meet the sky. It traces the line one pixel column at a time and gives each column a confidence score.",
		group: "evidence",
		kind: "algorithm",
		status: "live",
		tagline: "Find the line where mountain meets sky, one column at a time.",
		summary:
			"A fitted sky-colour model and a best-path trace find the skyline column by column, with a weight per column (about 120 ms). Narrow spikes are removed. A learned sky mask is a second source, kept secondary after a false accept.",
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
		claim: "Rigi computes the skyline the terrain should show.",
		lede: "From the camera position, Rigi computes the highest terrain visible in every direction. The result accounts for the earth's curvature and for light bending in the atmosphere.",
		group: "evidence",
		kind: "algorithm",
		status: "live",
		tagline:
			"The 360-degree silhouette the terrain would draw, curvature and refraction included.",
		summary:
			"Rays in 7,200 directions find the highest ridge in each (about 3.5 s, off the main thread). Every skyline match fits against this curve.",
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
		claim: "Matching the two skylines gives the camera's direction.",
		lede: "Rigi shifts the terrain skyline left, right, up and down until it lines up with the photo's skyline. The best fit gives the camera's heading and tilt.",
		group: "solve",
		kind: "concept",
		status: "live",
		tagline:
			"Which way was the camera pointing? Slide the terrain's skyline onto the photo's.",
		summary:
			"Rigi matches the photo's skyline to the horizon the terrain predicts. A coarse grid from the sensor guess finds candidates, a robust fit refines them, and a confidence score gates the result, with a full-circle retry under a stricter bar. A rejected solve falls back to the sensors and to tapping peaks.",
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
		claim: "The solved camera: heading, tilt, lens and position.",
		lede: "The result of a solve: the camera's heading, tilt, field of view and position, plus a record of the evidence used.",
		group: "solve",
		kind: "concept",
		status: "live",
		tagline:
			"Where the camera stood and where it looked, plus how it is known.",
		summary:
			"The solved result: direction, tilt, roll, field of view and the camera position in local metres, with how it is known. Every solver reads and writes the same record.",
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
		claim: "Rigi only accepts a pose when the evidence agrees.",
		lede: "Rigi marks a pose as confirmed only when the skyline match is strong. Otherwise it shows the pose as unconfirmed, because a wrong answer is worse than none.",
		group: "product",
		kind: "concept",
		status: "live",
		tagline: "When unsure, say so.",
		summary:
			"Precision beats recall. A pose is marked certain only when it is explicitly accepted and confident enough; suggestions and user picks never auto-accept. About a dozen hand-set thresholds implement this.",
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
		claim: "You can tap peaks you recognise to fix the pose by hand.",
		lede: "If the automatic match is unsure, tap a peak in the photo and pick its name. One peak sets the direction; three also set the lens.",
		group: "solve",
		kind: "ui",
		status: "live",
		tagline:
			"Tap known peaks: one pin gives yaw and pitch, three give focal too.",
		summary:
			"Taps solve the pose: one sets direction and tilt, two add roll, three or more add focal length. A pinned pose is user-confirmed, never auto-accepted.",
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
		claim: "The full path from photo to camera pose.",
		lede: "All steps run in the browser: read the sensors, load the terrain, find the photo skyline, compute the terrain skyline, line them up, then accept or reject.",
		group: "solve",
		kind: "subsystem",
		status: "live",
		tagline: "From photo to pose, step by step.",
		summary:
			"Read the sensors, load the terrain, compute the horizon, detect the skyline, then solve: coarse grid, robust fit, confidence gate, full-circle retry. A rejection escalates to refinement, then to tapping peaks.",
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
		claim: "The terrain model is a grid of ground heights.",
		lede: "The terrain model is a set of map tiles that store ground height instead of colour. Higher-resolution tiles keep summits sharp, which improves matching.",
		group: "world",
		kind: "data",
		status: "live",
		tagline: "Height tiles, finer near the camera.",
		summary:
			"Mapterhorn (512 px tiles to zoom 17, swissALTI3D in Switzerland) is the default; Terrarium (256 px, zoom 15) smooths summits and is kept for comparison. On the test photos, 25 solved correctly on Mapterhorn against 14 on Terrarium.",
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
		claim: "One function returns the ground height at any point.",
		lede: "Every part of Rigi that needs a ground height gets it from this function, which reads the downloaded height tiles.",
		group: "world",
		kind: "subsystem",
		status: "live",
		tagline: "One function answers: how high is the ground here?",
		summary:
			"Tiles around the GPS fix load at several zooms; heights are interpolated, falling back to coarser tiles. Horizon, peak visibility and the solvers all ask it.",
		modules: [
			"src/lib/geo/terrain.ts",
			"src/lib/dem/load.ts",
			"src/lib/dem/height-from-tile.ts",
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
		claim: "Rigi keeps the camera above the ground.",
		lede: "GPS altitude is often too low and can put the camera underground. Rigi raises the camera to at least standing height above the terrain before computing anything.",
		group: "camera",
		kind: "algorithm",
		status: "live",
		tagline: "GPS height, but never below standing height.",
		summary:
			"Without a solve, the eye sits at the GPS altitude but at least standing height above the ground.",
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
		claim: "Rigi labels a peak only if it is visible from the camera.",
		lede: "Peaks are named summits from OpenStreetMap. Rigi moves each one to the highest terrain point nearby and labels it only if nothing blocks the view.",
		group: "world",
		kind: "concept",
		status: "live",
		tagline: "A named summit with its height.",
		summary:
			"A named OpenStreetMap summit with height and prominence, moved onto the highest nearby ground and labelled only when visible.",
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
		claim: "Rigi places everything on the terrain model.",
		lede: "GPS positions and map coordinates often disagree with the terrain. Rigi moves the camera, the summits and nearby depth onto the terrain model so they match the ground.",
		group: "world",
		kind: "concept",
		status: "live",
		tagline: "Eyes, summits and depth, each pinned to the ground.",
		summary:
			"Everything Rigi places is checked against the terrain: the eye sits at least standing height above ground and not below a still lake; peaks move to the highest ground nearby; near-field depth is scaled to terrain distances. Each is a snap, a bound or a prior.",
		modules: [
			"src/lib/dem/height-from-tile.ts",
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
		claim: "The terrain gives the depth estimate a real scale.",
		lede: "Depth estimated from a single photo has no scale. Rigi scales it against the terrain model so nearby rocks and trees sit at their real distances in metres.",
		group: "nearfield",
		kind: "algorithm",
		status: "live",
		tagline: "The terrain is the ruler: depth lands in metres.",
		summary:
			"Model depth is fitted to terrain distances with a monotone curve, cutting the median log error from 0.34 to 0.13. A poor fit (score below 0.15) hides the scene.",
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
		claim: "Rigi finds where a photo was taken and which way it points.",
		lede: "Take a photo of mountains. Rigi works out where the camera was and which way it pointed, labels the visible peaks, and lets you view the scene in 3D.",
		group: "product",
		kind: "concept",
		status: "live",
		tagline:
			"Georeference a mountain photo against real terrain, then look through it.",
		summary:
			"Rigi takes a photograph, solves where the camera stood and looked against the terrain, and renders overlays, camera rolls and a Step Inside view from that pose. Precision beats recall. Everything runs in the browser; optional services help with hard cases.",
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
		claim: "The main screen for working with one photo.",
		lede: "One photo with all its tools on one screen: the peak labels, alignment, peak pins, map styles and export.",
		group: "product",
		kind: "ui",
		status: "live",
		tagline: "The single-photo cockpit: overlay, align, pin, export.",
		summary:
			"One screen per photo: overlay, alignment, pins, looks, export and the eye suggestion. Every photo source loads the same way.",
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
		claim: "Rigi poses a set of photos and shows them on a map.",
		lede: "Rigi groups a set of photos by where they were taken, solves the pose of each one, and shows them together on a map and in 3D.",
		group: "roll",
		kind: "subsystem",
		status: "live",
		tagline: "Grouped, posed, mapped, stitched.",
		summary:
			"Photos within 15 km form a roll; within 250 m, a viewpoint. Each photo gets the best pose on hand without solving: saved, hand-fitted, else the sensors. Built on the fly, never stored.",
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
		claim: "A view of the photo in depth that you can move around in.",
		lede: "Move around inside your photo. The near ground is rebuilt from the image, the distant mountains come from the terrain model, and the two are aligned to the terrain.",
		group: "nearfield",
		kind: "subsystem",
		status: "live",
		tagline:
			"Step into your photo: true camera, true mountains, reconstructed foreground.",
		summary:
			"A learned near-field rebuild joins the terrain far field, anchored by the solved pose. The camera starts exactly at the photo's eye. Shown only for an accepted pose and a good anchor, and hidden when the service is down.",
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
