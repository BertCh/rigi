// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { GipfelbuchPhotoData } from "../viz/real";

// The three chapters of the Blattuebersicht, in data-flow order (reports/peak-notebook-plan.md, D-PN4).
// Every GIPFELBUCH_NODES id appears in exactly one chapter; sheets.check.ts proves it.

export interface TafelChapter {
	/** "I", "II" or "III". */
	numeral: "I" | "II" | "III";
	title: string;
	/** One sentence under the title. */
	intro: string;
	/** Sheet ids in reading order. */
	ids: readonly string[];
	/** The chained-number line for the followed photo, in plain text. */
	fieldNote: (d: GipfelbuchPhotoData) => string;
}

const signed = (n: number, digits = 1) =>
	`${n > 0 ? "+" : ""}${n.toFixed(digits)}`;

export const CHAPTERS: readonly TafelChapter[] = [
	{
		numeral: "I",
		title: "Which way was it pointing?",
		intro:
			"The phone's compass is often wrong by degrees. These sheets read the photo, predict the terrain and slide one onto the other.",
		ids: [
			"photo",
			"camera-prior",
			"skyline",
			"dem-horizon",
			"viewport-inference",
			"pose-estimate",
			"accept-rule",
			"tap-a-peak",
			"baseline-pipeline",
		],
		fieldNote: (d) =>
			`compass said ${d.sensor.heading.toFixed(1)}°, terrain said ${d.solved.yaw.toFixed(1)}°, ${d.solved.accepted ? "shown at" : "refused at"} ${d.solved.confidence.toFixed(2)}`,
	},
	{
		numeral: "II",
		title: "Where is the ground, really?",
		intro:
			"GPS and maps disagree with the ground. These sheets pin the eye, the summits and the depth to the terrain model.",
		ids: [
			"dem-source",
			"terrain-sampler",
			"eye-rule",
			"peak",
			"terrain-snapping",
			"dem-anchoring",
		],
		fieldNote: (d) => {
			const gap = d.gps.alt - d.gps.ground;
			return `GPS put the eye ${Math.abs(gap).toFixed(1)} m ${gap < 0 ? "below" : "above"} the DEM ground at ${d.gps.ground.toFixed(1)} m`;
		},
	},
	{
		numeral: "III",
		title: "What the pose makes possible",
		intro:
			"With the camera known, the photo becomes a window onto the map, a place in a roll, a scene you can step into.",
		ids: ["rigi", "photo-workspace", "camera-roll", "step-inside"],
		fieldNote: (d) =>
			`one pose, three uses: the overlay, the roll, the scene (yaw ${signed(d.solved.delta.yaw)}° from the compass)`,
	},
];

/** Which chapter a sheet belongs to and its 1-based step inside it ("I.3"). */
export function stepOf(
	id: string,
): { chapter: TafelChapter; step: number; label: string } | null {
	for (const chapter of CHAPTERS) {
		const i = chapter.ids.indexOf(id);
		if (i >= 0)
			return { chapter, step: i + 1, label: `${chapter.numeral}.${i + 1}` };
	}
	return null;
}
