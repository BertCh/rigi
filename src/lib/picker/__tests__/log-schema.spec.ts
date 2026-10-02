// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildPickerLogFile,
	clearPickerLog,
	countPickerLog,
	logPickerEvent,
	PICKER_LOG_KEY,
	PICKER_LOG_MAX,
	PICKER_LOG_SCHEMA,
	type PickerLogEntry,
	parsePickerLog,
	parsePickerLogText,
	readPickerLog,
	subscribePickerLog,
} from "../log";

const pose = { yaw: 1, pitch: 2, roll: 0, vfov: 40 };
const env = (n: number) => ({
	t: `2026-10-02T00:00:${String(n % 60).padStart(2, "0")}Z`,
	photoId: `p${n}`,
	renderer: "deck" as const,
	alignState: null,
	verify: null,
	session: "s",
});
const dismiss = (n: number): PickerLogEntry => ({ kind: "dismiss", ...env(n) });
const pick = (n: number): PickerLogEntry => ({
	kind: "pick",
	rank: 1,
	source: "shown",
	before: pose,
	after: pose,
	...env(n),
});

const store = new Map<string, string>();
const stubStorage = (broken = false) =>
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => {
			if (broken) throw new Error("denied");
			return store.get(k) ?? null;
		},
		setItem: (k: string, v: string) => {
			if (broken) throw new Error("denied");
			store.set(k, v);
		},
		removeItem: (k: string) => {
			if (broken) throw new Error("denied");
			store.delete(k);
		},
	});

beforeEach(() => {
	store.clear();
	clearPickerLog(); // module memory is shared across specs in this file
	stubStorage();
});

describe("picker log parse", () => {
	it("round-trips through the exported file", () => {
		logPickerEvent(pick(1));
		logPickerEvent(dismiss(2));
		const file = buildPickerLogFile(
			readPickerLog(),
			new Date("2026-10-02T12:00:00Z"),
		);
		expect(file.schema).toBe(PICKER_LOG_SCHEMA);
		expect(file.version).toBe(1);
		expect(file.count).toBe(2);
		expect(file.exportedAt).toBe("2026-10-02T12:00:00.000Z");
		const back = parsePickerLogText(JSON.stringify(file));
		expect(back?.dropped).toBe(0);
		expect(back?.entries).toEqual(readPickerLog());
	});

	it("accepts a bare array and drops corrupt or unknown entries", () => {
		const raw = [
			pick(1),
			{ kind: "pick", photoId: "x" },
			null,
			42,
			{ ...dismiss(2), kind: "future-kind" },
			{ ...dismiss(3), renderer: "ie6" },
			dismiss(4),
		];
		const r = parsePickerLog(raw);
		expect(r.entries.map((e) => e.photoId)).toEqual(["p1", "p4"]);
		expect(r.dropped).toBe(5);
	});

	it("drops a whole file from another version, and non-JSON text gives null", () => {
		expect(parsePickerLog({ version: 2, events: [dismiss(1)] })).toEqual({
			entries: [],
			dropped: 1,
		});
		expect(parsePickerLog("garbage")).toEqual({ entries: [], dropped: 0 });
		expect(parsePickerLogText("{nope")).toBeNull();
	});
});

describe("picker log storage", () => {
	it("ignores corrupt entries already in storage instead of crashing", () => {
		store.set(PICKER_LOG_KEY, JSON.stringify([dismiss(1), { bad: true }]));
		expect(readPickerLog()).toHaveLength(1);
		logPickerEvent(dismiss(2));
		expect(JSON.parse(store.get(PICKER_LOG_KEY) as string)).toHaveLength(2);
	});

	it("falls back to memory when storage is unreadable JSON", () => {
		logPickerEvent(dismiss(1));
		store.set(PICKER_LOG_KEY, "{broken");
		expect(readPickerLog().map((e) => e.photoId)).toEqual(["p1"]);
	});

	it("keeps working in memory when storage throws everywhere", () => {
		stubStorage(true);
		expect(() => logPickerEvent(dismiss(1))).not.toThrow();
		logPickerEvent(dismiss(2));
		expect(readPickerLog().map((e) => e.photoId)).toEqual(["p1", "p2"]);
		expect(() => clearPickerLog()).not.toThrow();
		expect(countPickerLog()).toBe(0);
	});

	it("bounds the ring to PICKER_LOG_MAX, newest kept", () => {
		store.set(
			PICKER_LOG_KEY,
			JSON.stringify(
				Array.from({ length: PICKER_LOG_MAX }, (_, i) => dismiss(i)),
			),
		);
		logPickerEvent(dismiss(9000));
		const all = readPickerLog();
		expect(all).toHaveLength(PICKER_LOG_MAX);
		expect(all[0].photoId).toBe("p1");
		expect(all.at(-1)?.photoId).toBe("p9000");
	});

	it("clear empties storage and notifies subscribers", () => {
		const seen = vi.fn();
		const off = subscribePickerLog(seen);
		logPickerEvent(dismiss(1));
		expect(countPickerLog()).toBe(1);
		clearPickerLog();
		expect(countPickerLog()).toBe(0);
		expect(store.has(PICKER_LOG_KEY)).toBe(false);
		expect(seen).toHaveBeenCalledTimes(2);
		off();
		logPickerEvent(dismiss(2));
		expect(seen).toHaveBeenCalledTimes(2);
	});
});
