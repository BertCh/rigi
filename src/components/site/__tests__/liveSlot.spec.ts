// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { type EmbedState, shouldEvict } from "../liveSlot";

const map = (o: Record<string, EmbedState>) => new Map(Object.entries(o));

describe("shouldEvict", () => {
	it("evicts a live off-screen embed once another live embed is on screen", () => {
		const all = map({
			map: { live: true, onScreen: false, seen: true },
			step: { live: true, onScreen: true, seen: true },
		});
		expect(shouldEvict("map", all)).toBe(true);
		expect(shouldEvict("step", all)).toBe(false);
	});

	it("keeps an off-screen embed while no other live embed is on screen", () => {
		const all = map({
			map: { live: true, onScreen: false, seen: true },
			step: { live: false, onScreen: true, seen: false },
			pano: { live: true, onScreen: false, seen: true },
		});
		expect(shouldEvict("map", all)).toBe(false);
		expect(shouldEvict("pano", all)).toBe(false);
	});

	it("does not evict an embed preloading below the fold (never seen)", () => {
		const all = map({
			map: { live: true, onScreen: true, seen: true },
			step: { live: true, onScreen: false, seen: false },
		});
		expect(shouldEvict("step", all)).toBe(false);
	});

	it("never evicts an embed that is on screen or not live", () => {
		const all = map({
			map: { live: true, onScreen: true, seen: true },
			step: { live: true, onScreen: true, seen: true },
			pano: { live: false, onScreen: false, seen: false },
		});
		expect(shouldEvict("map", all)).toBe(false);
		expect(shouldEvict("pano", all)).toBe(false);
		expect(shouldEvict("missing", all)).toBe(false);
	});
});
