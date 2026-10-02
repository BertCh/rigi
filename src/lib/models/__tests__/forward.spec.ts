// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// forwardModelDownloads: throttled per file, state transitions immediate, trailing update flushed.
import { beforeEach, describe, expect, it } from "vitest";
import { forwardModelDownloads, receiveModelDownloads } from "../forward";
import {
	clearModelDownloads,
	type ModelDownload,
	modelDownloads,
	reportModelDownload,
} from "../progress";

function harness() {
	let t = 0;
	const timers: { at: number; fn: () => void; id: number }[] = [];
	const posts: ModelDownload[][] = [];
	const stop = forwardModelDownloads((e) => posts.push(e), {
		intervalMs: 100,
		now: () => t,
		setTimer: (fn, ms) => {
			const id = timers.length;
			timers.push({ at: t + ms, fn, id });
			return id;
		},
		clearTimer: (h) => {
			const i = timers.findIndex((x) => x.id === h);
			if (i >= 0) timers.splice(i, 1);
		},
	});
	const advance = (ms: number) => {
		t += ms;
		for (const x of timers.filter((x) => x.at <= t)) {
			timers.splice(timers.indexOf(x), 1);
			x.fn();
		}
	};
	return { posts, stop, advance, timers };
}
const dl = (loaded: number, state: ModelDownload["state"] = "downloading") => ({
	file: "a.bin",
	state,
	loaded,
	total: 1000,
});

beforeEach(() => clearModelDownloads());

describe("forwardModelDownloads", () => {
	it("posts the first update and state transitions at once", () => {
		const h = harness();
		reportModelDownload(dl(0));
		reportModelDownload(dl(500, "done"));
		expect(h.posts.map((p) => p[0].state)).toEqual(["downloading", "done"]);
	});

	it("throttles downloading updates per file and flushes the last one", () => {
		const h = harness();
		reportModelDownload(dl(0));
		for (let i = 1; i <= 5; i++) {
			h.advance(10);
			reportModelDownload(dl(i * 100));
		}
		expect(h.posts).toHaveLength(1);
		h.advance(100);
		expect(h.posts).toHaveLength(2);
		expect(h.posts[1][0].loaded).toBe(500);
		h.advance(500);
		expect(h.posts).toHaveLength(2);
	});

	it("lets a transition overtake a held update", () => {
		const h = harness();
		reportModelDownload(dl(0));
		h.advance(10);
		reportModelDownload(dl(300));
		reportModelDownload(dl(1000, "done"));
		h.advance(200);
		expect(h.posts.map((p) => p[0].state)).toEqual(["downloading", "done"]);
	});

	it("sends files that already exist when it starts, and stops cleanly", () => {
		reportModelDownload(dl(1000, "cached"));
		const h = harness();
		expect(h.posts[0][0].state).toBe("cached");
		h.stop();
		reportModelDownload(dl(5));
		expect(h.posts).toHaveLength(1);
	});
});

describe("receiveModelDownloads", () => {
	it("records forwarded entries in the local store", () => {
		receiveModelDownloads([dl(10)]);
		expect(modelDownloads()[0].loaded).toBe(10);
	});
});
