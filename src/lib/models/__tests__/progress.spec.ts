// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it } from "vitest";
import {
	clearModelDownloads,
	describeModelDownload,
	formatBytes,
	modelDownloads,
	reportModelDownload,
	subscribeModelDownloads,
} from "../progress";

beforeEach(() => clearModelDownloads());

describe("model download store", () => {
	it("keeps one entry per file, a new snapshot per change, and notifies", () => {
		let calls = 0;
		const off = subscribeModelDownloads(() => calls++);
		const s0 = modelDownloads();
		reportModelDownload({
			file: "a",
			state: "downloading",
			loaded: 1,
			total: 10,
		});
		const s1 = modelDownloads();
		expect(s1).not.toBe(s0);
		expect(modelDownloads()).toBe(s1);
		reportModelDownload({ file: "a", state: "done", loaded: 10, total: 10 });
		expect(modelDownloads()).toHaveLength(1);
		expect(modelDownloads()[0].state).toBe("done");
		off();
		reportModelDownload({ file: "b", state: "cached", loaded: 1, total: 1 });
		expect(calls).toBe(2);
	});
});

describe("text", () => {
	it("formats sizes and states", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(820_000)).toBe("820 kB");
		expect(formatBytes(4_540_720)).toBe("4.5 MB");
		expect(formatBytes(34_000_000)).toBe("34 MB");
		expect(
			describeModelDownload({
				file: "m",
				state: "downloading",
				loaded: 4_080_000,
				total: 34_000_000,
			}),
		).toBe("downloading model 34 MB (12%)");
		expect(
			describeModelDownload({
				file: "m",
				state: "error",
				loaded: 0,
				total: 0,
				error: "HTTP 404",
			}),
		).toBe("model download failed: HTTP 404");
	});
});
