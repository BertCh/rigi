// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AlignmentStory,
	AlignmentStoryProvider,
	poseAt,
	useAlignmentStory,
} from "../viz/story";

afterEach(cleanup);

function Probe({ seen }: { seen: AlignmentStory[] }) {
	const story = useAlignmentStory();
	if (story) seen.push(story);
	return null;
}

describe("alignment story", () => {
	it("keeps one setT across moves, clamps t and records instant writes", () => {
		const seen: AlignmentStory[] = [];
		render(
			<AlignmentStoryProvider initial={0.25}>
				<Probe seen={seen} />
			</AlignmentStoryProvider>,
		);
		const first = seen.at(-1) as AlignmentStory;
		expect(first.t).toBe(0.25);
		expect(first.instant).toBe(false);
		act(() => first.setT(0.6, { instant: true }));
		let now = seen.at(-1) as AlignmentStory;
		expect(now.t).toBe(0.6);
		expect(now.instant).toBe(true);
		expect(now.setT).toBe(first.setT);
		act(() => now.setT(2));
		now = seen.at(-1) as AlignmentStory;
		expect(now.t).toBe(1);
		expect(now.instant).toBe(false);
		expect(now.setT).toBe(first.setT);
	});

	it("turns the short way round between the two poses", () => {
		const cam = { pitch: 0, roll: 0, f: 500, hfov: 60 };
		const d = {
			prior: { ...cam, yaw: 350 },
			solved: { ...cam, yaw: 10 },
		};
		expect(poseAt(d, 0.5).yaw).toBeCloseTo(360, 9);
		expect(poseAt(d, 1).yaw).toBeCloseTo(370, 9);
	});
});
