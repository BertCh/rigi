// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createRandom, type Point } from "../notebook/sketch";
import { seedOf } from "../notebook/sketchify";

/** A closed polygon with each corner nudged by up to `amount` px: a painted or inked shape, never a clean one. */
export function paintPolygon(
	points: Point[],
	seed: string,
	amount = 0.5,
): string {
	const random = createRandom(seedOf(seed));
	const body = points
		.map(([x, y], index) => {
			const dx = (random() - 0.5) * 2 * amount;
			const dy = (random() - 0.5) * 2 * amount;
			return `${index ? "L" : "M"}${(x + dx).toFixed(2)} ${(y + dy).toFixed(2)}`;
		})
		.join("");
	return `${body}Z`;
}
