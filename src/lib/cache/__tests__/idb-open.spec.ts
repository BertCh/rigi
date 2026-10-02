// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore } from "../store";

// Minimal fake IndexedDB: open() returns a request whose onsuccess the test fires.
type FakeDb = {
	close: ReturnType<typeof vi.fn>;
	objectStoreNames: { contains: () => boolean };
	createObjectStore: () => void;
	onversionchange: (() => void) | null;
	transaction: () => never;
};

function makeDb(): FakeDb {
	return {
		close: vi.fn(),
		objectStoreNames: { contains: () => true },
		createObjectStore: () => {},
		onversionchange: null,
		transaction: () => {
			throw new Error("InvalidStateError");
		},
	};
}

interface FakeReq {
	result: FakeDb;
	error: null;
	onsuccess: (() => void) | null;
	onerror: (() => void) | null;
	onupgradeneeded: (() => void) | null;
}

let lastReq: FakeReq;
const db = makeDb();

function fireSuccess() {
	lastReq.result = db;
	lastReq.onsuccess?.();
}

beforeEach(() => {
	vi.useFakeTimers();
	db.close.mockClear();
	(globalThis as Record<string, unknown>).indexedDB = {
		open: () => {
			lastReq = {
				result: db,
				error: null,
				onsuccess: null,
				onerror: null,
				onupgradeneeded: null,
			};
			return lastReq;
		},
	};
});

afterEach(() => {
	vi.useRealTimers();
	delete (globalThis as Record<string, unknown>).indexedDB;
});

describe("IdbStore.open timeout", () => {
	it("keeps a connection that opened in time open after the timeout window", async () => {
		const p = openStore("t", "idb");
		fireSuccess();
		const store = await p;
		expect(store.kind).toBe("idb");
		await vi.advanceTimersByTimeAsync(5000);
		expect(db.close).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("falls back to memory and closes the connection when the open resolves late", async () => {
		const p = openStore("t", "idb");
		await vi.advanceTimersByTimeAsync(4000);
		const store = await p;
		expect(store.kind).toBe("memory");
		expect(db.close).not.toHaveBeenCalled();
		fireSuccess();
		await vi.advanceTimersByTimeAsync(0);
		expect(db.close).toHaveBeenCalledTimes(1);
	});
});
