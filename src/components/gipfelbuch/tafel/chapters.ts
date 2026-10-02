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
			"The phone's compass is often off by a few degrees. These sheets measure the skyline in the photo, compute the skyline from the terrain model, and shift one to match the other.",
		ids: [
			"photo",
			"skyline",
			"dem-horizon",
			"viewport-inference",
			"pose-estimate",
			"accept-rule",
			"tap-a-peak",
		],
		fieldNote: (d) =>
			`compass ${d.sensor.heading.toFixed(1)}° · terrain ${d.solved.yaw.toFixed(1)}° · ${d.solved.accepted ? "accepted at" : "refused at"} ${d.solved.confidence.toFixed(2)}`,
	},
	{
		numeral: "II",
		title: "Where does the camera sit on the terrain?",
		intro:
			"GPS height and the terrain model often disagree. These sheets tie the camera height, the summits and the depth to the terrain model.",
		ids: [
			"dem-source",
			"eye-rule",
			"peak",
			"terrain-snapping",
			"dem-anchoring",
		],
		fieldNote: (d) => {
			const gap = d.gps.alt - d.gps.ground;
			return `GPS put the camera ${Math.abs(gap).toFixed(1)} m ${gap < 0 ? "below" : "above"} the terrain model's ground at ${d.gps.ground.toFixed(1)} m`;
		},
	},
	{
		numeral: "III",
		title: "What a known camera is used for",
		intro:
			"Once the camera is known, the photo can be overlaid on the map, placed in a camera roll, and explored as a 3D scene.",
		ids: ["rigi", "photo-workspace", "camera-roll", "step-inside"],
		fieldNote: (d) =>
			`one camera, three uses: overlay, roll, scene (compass off by ${signed(d.solved.delta.yaw)}°)`,
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
