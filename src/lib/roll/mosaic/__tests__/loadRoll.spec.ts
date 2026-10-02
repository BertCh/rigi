// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	listLocalPhotos: vi.fn(),
	ensureLocalPhotoRegistered: vi.fn(),
	deleteLocalPhoto: vi.fn(),
	loadDemoRoll: vi.fn(),
}));
vi.mock("#/lib/upload", () => ({
	listLocalPhotos: m.listLocalPhotos,
	ensureLocalPhotoRegistered: m.ensureLocalPhotoRegistered,
	deleteLocalPhoto: m.deleteLocalPhoto,
	isLocalPhotoId: (id: string) => id.startsWith("local-"),
}));
vi.mock("#/lib/demo", () => ({ loadDemoRoll: m.loadDemoRoll }));

import { storageKey } from "#/lib/ontology/core/storage";
import type { PhotoMeta } from "../../../photos";
import { loadProvenance, saveProvenance } from "../../import/provenance";
import { loadSolvedPose, saveSolvedPose, uploadRollId } from "../../roll";
import type { Roll } from "../../types";
import {
	deleteUploadRoll,
	isLocalRollId,
	LOCAL_ROLL_PREFIX,
	listUploadRolls,
	loadRoll,
} from "../loadRoll";

const T0 = Date.parse("2025-08-01T10:00:00Z");
const photo = (id: string, metres = 0, secs = 0): PhotoMeta =>
	({
		id,
		src: "",
		width: 4000,
		height: 3000,
		takenAt: new Date(T0 + secs * 1000).toISOString(),
		lat: 46.7 + metres / 111_000,
		lon: 7.7,
		alt: null,
		heading: 0,
		pitch: 0,
		roll: 0,
		vfov: 55,
		region: "x",
	}) as unknown as PhotoMeta;

const stored = (id: string, metres = 0, secs = 0, thumbUrl?: string) => ({
	id,
	meta: photo(id, metres, secs),
	thumbUrl,
});

let store: Map<string, string>;
beforeEach(() => {
	for (const f of Object.values(m)) f.mockReset();
	store = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
});

describe("isLocalRollId", () => {
	it("matches the local roll prefix only", () => {
		expect(LOCAL_ROLL_PREFIX).toBe("local-roll-");
		expect(isLocalRollId("local-roll-ab12")).toBe(true);
		expect(isLocalRollId("local-ab12")).toBe(false);
		expect(isLocalRollId("niederhorn")).toBe(false);
	});
});

describe("listUploadRolls", () => {
	it("groups uploads into rolls and maps photo ids to thumbnails", async () => {
		m.listLocalPhotos.mockResolvedValue([
			stored("local-a", 0, 0, "blob:a"),
			stored("local-b", 50, 60),
			stored("local-far", 500_000, 0, "blob:far"),
		]);
		const { rolls, thumbs } = await listUploadRolls();
		expect(rolls.map((r) => r.photos.length)).toEqual([2, 1]);
		expect(thumbs.get("local-a")).toBe("blob:a");
		expect(thumbs.has("local-b")).toBe(false);
		expect(thumbs.get("local-far")).toBe("blob:far");
		for (const r of rolls) expect(isLocalRollId(r.id)).toBe(true);
	});
	it("is empty with no uploads", async () => {
		m.listLocalPhotos.mockResolvedValue([]);
		expect(await listUploadRolls()).toEqual({ rolls: [], thumbs: new Map() });
	});
});

describe("loadRoll", () => {
	it("delegates the demo roll to the demo module", async () => {
		const demo = { id: "demo" } as Roll;
		m.loadDemoRoll.mockResolvedValue(demo);
		expect(await loadRoll("demo")).toBe(demo);
	});

	it("returns null for an unknown built-in id", async () => {
		expect(await loadRoll("no-such-region-roll")).toBeNull();
	});

	function uploads() {
		const list = [
			stored("local-a", 0, 0),
			stored("local-b", 50, 60),
			stored("local-far", 500_000, 0),
		];
		m.listLocalPhotos.mockResolvedValue(list);
		m.ensureLocalPhotoRegistered.mockImplementation(async (id: string) => ({
			...list.find((s) => s.id === id)?.meta,
			src: `blob:${id}`,
		}));
		return list;
	}

	it("restores uploads with their blob urls and finds a roll by its stable id", async () => {
		const list = uploads();
		const id = uploadRollId([list[0].meta, list[1].meta]);
		const r = await loadRoll(id);
		expect(r?.id).toBe(id);
		expect(r?.photos.map((p) => p.meta.src).sort()).toEqual([
			"blob:local-a",
			"blob:local-b",
		]);
	});

	it("falls back to the stored meta when a photo cannot be registered", async () => {
		const list = uploads();
		m.ensureLocalPhotoRegistered.mockResolvedValue(null);
		const id = uploadRollId([list[2].meta]);
		const r = await loadRoll(id);
		expect(r?.photos).toHaveLength(1);
		expect(r?.photos[0].meta.id).toBe("local-far");
	});

	it("finds the roll now holding a photo when the id was minted before an earlier photo joined", async () => {
		uploads();
		const r = await loadRoll("local-roll-b"); // `local-b` lives in the a+b roll
		expect(r?.photos.map((p) => p.meta.id)).toContain("local-b");
	});
});

describe("deleteUploadRoll", () => {
	it("removes each local photo's upload, solved pose, provenance and saved pose, leaving others", async () => {
		const solved = {
			pose: { yaw: 1, pitch: 0, roll: 0, vfov: 50 },
			confidence: 1,
			method: "cascade" as const,
			at: "x",
		};
		const prov = {
			method: "pin" as const,
			accuracyM: null,
			from: [],
			gapS: null,
			at: 1,
		};
		for (const id of ["local-a", "local-b", "bundled-1"]) {
			saveSolvedPose(id, solved);
			saveProvenance(id, prov);
			store.set(storageKey("savedPose", id), "{}");
		}
		const roll = {
			photos: ["local-a", "local-b", "bundled-1"].map((id) => ({
				meta: { id },
			})),
		} as unknown as Roll;
		await deleteUploadRoll(roll);
		expect(m.deleteLocalPhoto.mock.calls.map((c) => c[0])).toEqual([
			"local-a",
			"local-b",
		]);
		for (const id of ["local-a", "local-b"]) {
			expect(loadSolvedPose(id)).toBeNull();
			expect(loadProvenance(id)).toBeNull();
			expect(store.has(storageKey("savedPose", id))).toBe(false);
		}
		expect(loadSolvedPose("bundled-1")).not.toBeNull();
		expect(loadProvenance("bundled-1")).not.toBeNull();
		expect(store.has(storageKey("savedPose", "bundled-1"))).toBe(true);
	});
});
