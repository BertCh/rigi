// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { GipfelbuchGroup } from "#/lib/gipfelbuch/types";

// The order of the field notebook: three entries (pages), each a numbered run of steps. Every
// Gipfelbuch concept appears exactly once, either as an entry's hub or as a step. Numbers run across
// the whole book so a margin note can say "needs ⑪" unambiguously. The data-flow edges that cross
// entries become margin notes (`needs`) instead of drawn graph edges.

export interface NotebookStep {
	/** Gipfelbuch node id; the step links to /gipfelbuch/<id>. */
	id: string;
	/** Short handwritten name (node titles can be long). */
	label: string;
	/** Taken only when the step before it refuses (drawn as a branch). */
	fallback?: boolean;
	/** Earlier or later steps this one consumes, with what flows along the edge. */
	needs?: { id: string; what: string }[];
}

export interface NotebookEntry {
	key: "infer" | "terrain" | "app";
	/** Node the entry title links to. */
	hub: string;
	title: string;
	/** The question the entry answers, written in the margin hand. */
	question: string;
	/** Gipfelbuch groups whose `#group-<id>` anchors land on this entry. */
	groups: GipfelbuchGroup[];
	steps: NotebookStep[];
}

export const NOTEBOOK_ENTRIES: NotebookEntry[] = [
	{
		key: "infer",
		hub: "viewport-inference",
		title: "Viewport inference",
		question: "Which way was the camera pointing?",
		groups: ["solve", "capture", "evidence"],
		steps: [
			{ id: "photo", label: "Photo" },
			{ id: "camera-prior", label: "Sensor prior" },
			{ id: "skyline", label: "Photo skyline" },
			{
				id: "baseline-pipeline",
				label: "Horizon match",
				needs: [
					{ id: "dem-horizon", what: "the predicted horizon" },
					{ id: "camera-prior", what: "the seed" },
				],
			},
			{ id: "accept-rule", label: "Accept gate" },
			{ id: "pose-estimate", label: "Pose" },
			{ id: "tap-a-peak", label: "Tap-a-peak", fallback: true },
		],
	},
	{
		key: "terrain",
		hub: "terrain-snapping",
		title: "Terrain snapping",
		question: "Where is the ground, really?",
		groups: ["world", "camera", "nearfield"],
		steps: [
			{ id: "dem-source", label: "DEM tiles" },
			{ id: "terrain-sampler", label: "Height sampler" },
			{ id: "eye-rule", label: "Eye on the ground" },
			{
				id: "dem-horizon",
				label: "DEM horizon",
				needs: [{ id: "eye-rule", what: "the ray origin" }],
			},
			{ id: "peak", label: "Peak on its summit" },
			{ id: "dem-anchoring", label: "Depth on the DEM" },
		],
	},
	{
		key: "app",
		hub: "rigi",
		title: "What the pose is for",
		question: "Now that we know, what can we do?",
		groups: ["product", "roll"],
		steps: [
			{
				id: "photo-workspace",
				label: "Overlay",
				needs: [
					{ id: "pose-estimate", what: "the pose" },
					{ id: "peak", what: "the labels" },
				],
			},
			{ id: "camera-roll", label: "Camera roll" },
			{
				id: "step-inside",
				label: "Step Inside",
				needs: [{ id: "dem-anchoring", what: "metric depth" }],
			},
		],
	},
];

/** Global step number (1-based) for every step id. */
export const STEP_NUMBER: ReadonlyMap<string, number> = new Map(
	NOTEBOOK_ENTRIES.flatMap((entry) => entry.steps).map((step, index) => [
		step.id,
		index + 1,
	]),
);

/** Which entry a step lives on. */
export const STEP_ENTRY: ReadonlyMap<string, NotebookEntry["key"]> = new Map(
	NOTEBOOK_ENTRIES.flatMap((entry) =>
		entry.steps.map((step) => [step.id, entry.key] as const),
	),
);

/** Every node id the notebook mentions (hubs and steps). */
export const NOTEBOOK_NODE_IDS: readonly string[] = NOTEBOOK_ENTRIES.flatMap(
	(entry) => [entry.hub, ...entry.steps.map((step) => step.id)],
);

export const stepAnchor = (id: string) => `nb-step-${id}`;
