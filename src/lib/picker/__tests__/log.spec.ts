// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "#/lib/ontology/core/storage";
import {
	clearPickerLog,
	downloadPickerLog,
	logPickerEvent,
	PICKER_LOG_KEY,
	PICKER_LOG_MAX,
	type PickerLogEntry,
	readPickerLog,
} from "../log";

const store = new Map<string, string>();
const entry = (n: number): PickerLogEntry => ({
	kind: "dismiss",
	t: `2026-10-01T00:00:${String(n % 60).padStart(2, "0")}Z`,
	photoId: `p${n}`,
	renderer: "webgpu",
	alignState: null,
	verify: "unverified" as PickerLogEntry["verify"],
	session: "s",
});

beforeEach(() => {
	store.clear();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
	});
	vi.stubGlobal("window", globalThis);
	clearPickerLog(); // the in-memory fallback is module state shared by the tests
});

describe("picker correction log", () => {
	it("appends events in order and reads them back", () => {
		expect(readPickerLog()).toEqual([]);
		logPickerEvent(entry(1));
		logPickerEvent(entry(2));
		expect(readPickerLog().map((e) => e.photoId)).toEqual(["p1", "p2"]);
		expect(JSON.parse(store.get(PICKER_LOG_KEY) as string)).toHaveLength(2);
	});

	it("keeps only the newest PICKER_LOG_MAX events", () => {
		store.set(
			PICKER_LOG_KEY,
			JSON.stringify(
				Array.from({ length: PICKER_LOG_MAX }, (_, i) => entry(i)),
			),
		);
		logPickerEvent(entry(5000));
		const all = readPickerLog();
		expect(all).toHaveLength(PICKER_LOG_MAX);
		expect(all[0].photoId).toBe("p1");
		expect(all[all.length - 1].photoId).toBe("p5000");
	});

	it("survives corrupt storage (falls back to the memory copy) and ignores non-array JSON", () => {
		store.set(PICKER_LOG_KEY, "{not json");
		expect(() => logPickerEvent(entry(1))).not.toThrow();
		// the corrupt value was replaced by a valid log ending in the new event
		expect(
			readPickerLog()
				.map((e) => e.photoId)
				.pop(),
		).toBe("p1");
		store.set(PICKER_LOG_KEY, JSON.stringify({ a: 1 }));
		expect(readPickerLog()).toEqual([]);
	});

	it("falls back to the in-memory ring when storage rejects writes", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("quota");
			},
		});
		logPickerEvent(entry(1));
		logPickerEvent(entry(2));
		expect(
			readPickerLog()
				.map((e) => e.photoId)
				.slice(-2),
		).toEqual(["p1", "p2"]);
	});
});

describe("downloadPickerLog", () => {
	it("saves a schema-tagged JSON file named by date", async () => {
		logPickerEvent(entry(1));
		const click = vi.fn();
		const a: Record<string, unknown> = { click };
		vi.stubGlobal("document", { createElement: () => a });
		let blob: Blob | undefined;
		vi.stubGlobal("URL", {
			createObjectURL: (b: Blob) => {
				blob = b;
				return "blob:log";
			},
			revokeObjectURL: vi.fn(),
		});
		vi.useFakeTimers();
		downloadPickerLog();
		vi.runAllTimers();
		vi.useRealTimers();
		expect(click).toHaveBeenCalledTimes(1);
		expect(a.href).toBe("blob:log");
		expect(a.download).toMatch(/^rigi-picker-log-\d{4}-\d{2}-\d{2}\.json$/);
		const parsed = JSON.parse(await (blob as Blob).text());
		expect(parsed.schema).toBe(storageKey("pickerLog"));
		expect(parsed.events).toHaveLength(1);
	});
});
