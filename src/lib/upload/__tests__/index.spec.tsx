// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegionData } from "../../photos";

// an in-memory stand-in for the IndexedDB store (no IndexedDB in happy-dom)
const db = vi.hoisted(() => ({
	photos: new Map<
		string,
		{ id: string; meta: Record<string, unknown>; blob: Blob; thumb?: Blob }
	>(),
	regions: new Map<string, Record<string, unknown>>(),
}));
vi.mock("../store", () => ({
	putPhoto: async (r: never) => void db.photos.set((r as { id: string }).id, r),
	getPhotoRecord: async (id: string) => db.photos.get(id) ?? null,
	deletePhotoRecord: async (id: string) => void db.photos.delete(id),
	allPhotoRecords: async () => [...db.photos.values()],
	putRegion: async (r: { id: string }) => void db.regions.set(r.id, r),
	getRegion: async (id: string) => db.regions.get(id) ?? null,
	deleteRegion: async (id: string) => void db.regions.delete(id),
	regionIds: async () => [...db.regions.keys()],
}));
vi.mock("../decode", async (orig) => ({
	...(await orig<typeof import("../decode")>()),
	contentHash: vi.fn(async () => "abc1234567"),
	decodeImage: vi.fn(async () => ({
		blob: new Blob(["jpeg"], { type: "image/jpeg" }),
		thumb: new Blob(["t"], { type: "image/jpeg" }),
		width: 1536,
		height: 2048,
		sourceWidth: 3024,
		sourceHeight: 4032,
		decoder: "native",
	})),
}));

import * as U from "../index";
import { attachPhotoToRegion } from "../region";

const region = (id: string, photos: string[] = []): RegionData => ({
	id,
	center: [47, 8],
	photos,
	peaks: [],
	trails: [],
	waterNames: [],
});
const file = (name = "a.jpg") =>
	new File([Uint8Array.from([1, 2, 3, 4])], name, {
		type: "image/jpeg",
		lastModified: Date.UTC(2021, 5, 6),
	});

let urlN = 0;
beforeEach(() => {
	db.photos.clear();
	db.regions.clear();
	urlN = 0;
	vi.stubGlobal(
		"URL",
		Object.assign(URL, {
			createObjectURL: () => `blob:u${urlN++}`,
			revokeObjectURL: vi.fn(),
		}),
	);
});

describe("ids", () => {
	it("local ids carry the local- prefix", () => {
		expect(U.LOCAL_PREFIX).toBe("local-");
		expect(U.isLocalPhotoId("local-abc")).toBe(true);
		expect(U.isLocalPhotoId("IMG_1")).toBe(false);
	});
	it("hasPosition needs finite lat and lon", () => {
		expect(U.hasPosition({ lat: 1, lon: 2 } as never)).toBe(true);
		expect(U.hasPosition({ lat: Number.NaN, lon: 2 } as never)).toBe(false);
		expect(
			U.hasPosition({ lat: 1, lon: Number.POSITIVE_INFINITY } as never),
		).toBe(false);
	});
});

describe("prepareUpload", () => {
	it("reports stages in order and derives the id from the content hash", async () => {
		const stages: string[] = [];
		const d = await U.prepareUpload(file(), (s) => stages.push(s));
		expect(stages).toEqual(["reading", "exif", "decoding", "done"]);
		expect(d.id).toBe("local-abc1234567");
		expect(d.meta.id).toBe(d.id);
	});
	it("uses caller-supplied bytes and id without re-hashing", async () => {
		const { contentHash } = await import("../decode");
		(contentHash as ReturnType<typeof vi.fn>).mockClear();
		const d = await U.prepareUpload(file(), undefined, {
			bytes: Uint8Array.of(9),
			id: "local-known",
		});
		expect(d.id).toBe("local-known");
		expect(contentHash).not.toHaveBeenCalled();
	});
	it("a file with no EXIF has no position and falls back to the file time", async () => {
		const d = await U.prepareUpload(file("x.jpg"));
		expect(U.hasPosition(d.meta)).toBe(false);
		expect(d.meta.takenAt).toBe("2021-06-06T00:00:00.000Z");
		expect(d.meta.local).toMatchObject({
			fileName: "x.jpg",
			fileType: "image/jpeg",
			fileBytes: 4,
			positionSource: "pin",
			timeSource: "file",
		});
		expect(d.diagnostics.hasExif).toBe(false);
		expect([d.meta.width, d.meta.height]).toEqual([1536, 2048]);
	});
});

describe("withPosition", () => {
	it("rebuilds the meta with the pinned position, keeping the file info", async () => {
		const d = await U.prepareUpload(file("pin.jpg"));
		const m = U.withPosition(d, 46.9, 8.2);
		expect([m.lat, m.lon]).toEqual([46.9, 8.2]);
		expect(m.local.positionSource).toBe("pin");
		expect(m.local.fileName).toBe("pin.jpg");
		expect(m.id).toBe(d.id);
		expect(m.alt).toBeNull();
	});
});

describe("regionFor", () => {
	it("rejects when the photo has no position yet", async () => {
		await expect(
			U.regionFor({ lat: Number.NaN, lon: 1 } as never),
		).rejects.toThrow("no position");
	});
});

describe("attachPhotoToRegion", () => {
	it("persists a local region with the photo id and merges ids already stored", async () => {
		await attachPhotoToRegion(region("local-region-1", ["p1"]), "p2");
		const r = await attachPhotoToRegion(region("local-region-1", []), "p3");
		expect(r.photos.sort()).toEqual(["p1", "p2", "p3"]);
		expect(db.regions.get("local-region-1")?.photos).toEqual(
			expect.arrayContaining(["p1", "p2", "p3"]),
		);
	});
	it("does not duplicate a photo id", async () => {
		await attachPhotoToRegion(region("local-region-1"), "p1");
		const r = await attachPhotoToRegion(region("local-region-1"), "p1");
		expect(r.photos).toEqual(["p1"]);
	});
	it("returns bundled regions untouched, stripping transient fields, without persisting", async () => {
		const r = await attachPhotoToRegion(
			{ ...region("region-3"), warnings: ["w"], partial: true } as never,
			"p1",
		);
		expect(r).not.toHaveProperty("warnings");
		expect(r).not.toHaveProperty("partial");
		expect(r.photos).toEqual([]);
		expect(db.regions.size).toBe(0);
	});
	it("serialises concurrent attaches so no photo id is lost", async () => {
		await Promise.all(
			["a", "b", "c", "d"].map((p) =>
				attachPhotoToRegion(region("local-region-9"), p),
			),
		);
		expect(
			(db.regions.get("local-region-9")?.photos as string[]).sort(),
		).toEqual(["a", "b", "c", "d"]);
	});
});

describe("saveUpload", () => {
	it("refuses a photo without a position", async () => {
		const d = await U.prepareUpload(file());
		await expect(U.saveUpload(d, d.meta, null)).rejects.toThrow(
			"place the photo on the map",
		);
	});
	it("stores the blob and meta, returns a blob: src and an empty region when Overpass failed", async () => {
		const d = await U.prepareUpload(file());
		const meta = U.withPosition(d, 46.9, 8.2);
		const r = await U.saveUpload(d, meta, null);
		expect(r.meta.src).toMatch(/^blob:/);
		expect(r.region.id).toBe(`local-region-empty-${d.id}`);
		const rec = db.photos.get(d.id);
		expect(rec?.meta.src).toBe("");
		expect(rec?.meta.region).toBe(r.region.id);
		expect(r.region.photos).toEqual([d.id]);
	});
	it("references a bundled region by id without copying it", async () => {
		const d = await U.prepareUpload(file());
		const r = await U.saveUpload(
			d,
			U.withPosition(d, 46.9, 8.2),
			region("region-1"),
		);
		expect(db.photos.get(d.id)?.meta.region).toBe("region-1");
		expect(db.regions.size).toBe(0);
		expect(r.region.id).toBe("region-1");
	});
	it("reuses one blob URL per photo", async () => {
		const d = await U.prepareUpload(file());
		const m = U.withPosition(d, 1, 2);
		const a = await U.saveUpload(d, m, region("local-region-1"));
		const b = await U.saveUpload(d, m, region("local-region-1"));
		expect(a.meta.src).toBe(b.meta.src);
	});
});

describe("restoreLocalPhoto", () => {
	it("is null for an unknown id", async () => {
		expect(await U.restoreLocalPhoto("local-nope")).toBeNull();
	});
	it("returns the meta with a blob URL and the stored local region", async () => {
		const d = await U.prepareUpload(file());
		await U.saveUpload(
			d,
			U.withPosition(d, 46.9, 8.2),
			region("local-region-1", ["x"]),
		);
		const r = await U.restoreLocalPhoto(d.id);
		expect(r?.meta.src).toBe(r?.blobUrl);
		expect(r?.region.id).toBe("local-region-1");
		expect(r?.region.photos).toEqual(expect.arrayContaining(["x", d.id]));
	});
	it("falls back to an empty region when the stored one is gone", async () => {
		const d = await U.prepareUpload(file());
		await U.saveUpload(
			d,
			U.withPosition(d, 46.9, 8.2),
			region("local-region-1"),
		);
		db.regions.clear();
		const r = await U.restoreLocalPhoto(d.id);
		expect(r?.region).toMatchObject({
			id: "local-region-1",
			peaks: [],
			trails: [],
			photos: [],
		});
	});
	it("falls back to an empty region when a bundled one cannot be loaded", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("no", { status: 404 })),
		);
		const d = await U.prepareUpload(file());
		await U.saveUpload(d, U.withPosition(d, 46.9, 8.2), region("region-77"));
		const r = await U.restoreLocalPhoto(d.id);
		expect(r?.region).toMatchObject({ id: "region-77", peaks: [] });
	});
});

describe("listLocalPhotos / deleteLocalPhoto / gcRegions", () => {
	const put = (id: string, addedAt: number, regionId: string, thumb = true) =>
		db.photos.set(id, {
			id,
			meta: { id, region: regionId, local: { addedAt } },
			blob: new Blob(["x"]),
			thumb: thumb ? new Blob(["t"]) : undefined,
		});
	it("lists newest first with thumbnail URLs when present", async () => {
		put("old", 1, "r", false);
		put("new", 9, "r");
		put("mid", 5, "r");
		const l = await U.listLocalPhotos();
		expect(l.map((x) => x.id)).toEqual(["new", "mid", "old"]);
		expect(l[0].thumbUrl).toMatch(/^blob:/);
		expect(l[2].thumbUrl).toBeNull();
	});
	it("gcRegions drops unreferenced local regions and any stored bundled copies", async () => {
		put("p", 1, "local-region-keep");
		for (const id of ["local-region-keep", "local-region-orphan", "region-2"])
			db.regions.set(id, { id });
		expect((await U.gcRegions()).sort()).toEqual([
			"local-region-orphan",
			"region-2",
		]);
		expect([...db.regions.keys()]).toEqual(["local-region-keep"]);
	});
	it("deleteLocalPhoto removes the record, garbage-collects its region and revokes blob URLs", async () => {
		const d = await U.prepareUpload(file());
		const saved = await U.saveUpload(
			d,
			U.withPosition(d, 46.9, 8.2),
			region("local-region-1"),
		);
		await U.listLocalPhotos();
		await U.deleteLocalPhoto(d.id);
		expect(db.photos.has(d.id)).toBe(false);
		expect(db.regions.has("local-region-1")).toBe(false);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith(saved.meta.src);
	});
});

describe("workspace registration", () => {
	it("registerHook finds registerLocalPhoto in photos.ts", () => {
		expect(typeof U.registerHook()).toBe("function");
	});
	it("registerWithWorkspace makes the photo resolvable, seeding only matching local regions", async () => {
		const photos = await import("../../photos");
		const meta = {
			id: "local-reg1",
			region: "local-region-1",
			lat: 1,
			lon: 2,
		} as never;
		expect(U.registerWithWorkspace(meta, region("local-region-1"))).toBe(true);
		expect(photos.getPhoto("local-reg1")).toBeTruthy();
		expect(await photos.loadRegion("local-region-1")).toMatchObject({
			id: "local-region-1",
		});
	});
	it("does not seed a bundled or mismatched region (loadRegion must fetch)", async () => {
		const photos = await import("../../photos");
		const f = vi.fn(
			async () =>
				new Response(JSON.stringify(region("region-5")), { status: 200 }),
		);
		vi.stubGlobal("fetch", f);
		U.registerWithWorkspace(
			{ id: "local-b", region: "region-5" } as never,
			region("region-5"),
		);
		await photos.loadRegion("region-5");
		expect(f).toHaveBeenCalled();
	});
	it("ensureLocalPhotoRegistered ignores non-local ids and restores local ones", async () => {
		expect(await U.ensureLocalPhotoRegistered("IMG_1")).toBeNull();
		const d = await U.prepareUpload(file());
		await U.saveUpload(
			d,
			U.withPosition(d, 46.9, 8.2),
			region("local-region-1"),
		);
		const m = await U.ensureLocalPhotoRegistered(d.id);
		expect(m?.id).toBe(d.id);
		expect((await import("../../photos")).getPhoto(d.id)).toBeTruthy();
		expect(await U.ensureLocalPhotoRegistered("local-missing")).toBeNull();
	});
});
