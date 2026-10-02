// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";

const upload = vi.hoisted(() => ({
	listLocalPhotos: vi.fn(),
	regionFor: vi.fn(),
	saveUpload: vi.fn(),
	bundled: vi.fn(),
	contentHash: vi.fn(),
}));

vi.mock("#/lib/upload", () => ({
	LOCAL_PREFIX: "local-",
	hasPosition: (m: { lat: number; lon: number }) =>
		Number.isFinite(m.lat) && Number.isFinite(m.lon),
	withPosition: (d: { meta: object }, lat: number, lon: number) => ({
		...d.meta,
		lat,
		lon,
		placed: true,
	}),
	listLocalPhotos: upload.listLocalPhotos,
	regionFor: upload.regionFor,
	saveUpload: upload.saveUpload,
}));
vi.mock("#/lib/upload/exif", () => ({
	offsetFromLongitude: (lon: number) => {
		const h = Math.max(-12, Math.min(14, Math.round(lon / 15)));
		return `${h < 0 ? "-" : "+"}${String(Math.abs(h)).padStart(2, "0")}:00`;
	},
}));
vi.mock("#/lib/upload/region", () => ({ bundledRegionIdFor: upload.bundled }));
vi.mock("#/lib/upload/decode", () => ({ contentHash: upload.contentHash }));

import type { UploadDraft } from "#/lib/upload";
import type { LocalPhotoMeta } from "#/lib/upload/exif";
import {
	addToIndex,
	idForFile,
	isNameTimeDuplicate,
	placeBatch,
	placedMeta,
	provenanceOf,
	readFileId,
	representative,
	type SaveEntry,
	saveRoll,
	storedIndex,
} from "../index";

const NaN_ = Number.NaN;
function lm(
	id: string,
	o: {
		lat?: number;
		lon?: number;
		takenAt?: string;
		tz?: string | null;
		timeSource?: string;
		tzEstimated?: boolean;
		file?: string;
		acc?: number | null;
	} = {},
): LocalPhotoMeta {
	return {
		id,
		src: "",
		width: 100,
		height: 100,
		takenAt: o.takenAt ?? "2026-09-07T10:00:00.000Z",
		tzOffset: o.tz ?? null,
		lat: o.lat ?? 46.7,
		lon: o.lon ?? 7.7,
		hAccuracy: o.acc ?? null,
		local: {
			fileName: o.file ?? `${id}.HEIC`,
			timeSource: o.timeSource ?? "exif",
			tzEstimated: o.tzEstimated ?? false,
		},
	} as unknown as LocalPhotoMeta;
}

beforeEach(() => {
	upload.listLocalPhotos.mockReset();
	upload.regionFor.mockReset();
	upload.saveUpload.mockReset();
	upload.bundled.mockReset();
});

describe("duplicate index", () => {
	it("matches stored photos by file name (case-insensitive) and capture time", async () => {
		upload.listLocalPhotos.mockResolvedValue([
			{ id: "local-1", meta: lm("local-1", { file: "IMG_1.HEIC" }) },
			{ id: "legacy", meta: {} },
		]);
		const idx = await storedIndex();
		expect([...idx.ids]).toEqual(["local-1", "legacy"]);
		expect(isNameTimeDuplicate(idx, lm("x", { file: "img_1.heic" }))).toBe(
			true,
		);
		expect(isNameTimeDuplicate(idx, lm("x", { file: "img_2.heic" }))).toBe(
			false,
		);
		expect(
			isNameTimeDuplicate(
				idx,
				lm("x", { file: "IMG_1.HEIC", takenAt: "2026-09-07T10:00:01.000Z" }),
			),
		).toBe(false);
	});

	it("also keys the zone-less reading when the zone was guessed", () => {
		const idx = { ids: new Set<string>(), nameTime: new Set<string>() };
		addToIndex(
			idx,
			lm("a", { file: "A.JPG", tz: "+02:00", tzEstimated: true }),
		);
		expect(idx.ids.has("a")).toBe(true);
		expect(idx.nameTime.size).toBe(2);
		// a re-import that read the same wall clock as UTC
		expect(
			isNameTimeDuplicate(
				idx,
				lm("b", { file: "a.jpg", takenAt: "2026-09-07T12:00:00.000Z" }),
			),
		).toBe(true);
		const known = { ids: new Set<string>(), nameTime: new Set<string>() };
		addToIndex(known, lm("a", { file: "A.JPG", tz: "+02:00" }));
		expect(known.nameTime.size).toBe(1);
	});
});

describe("file ids", () => {
	it("prefixes the content hash and returns the bytes", async () => {
		upload.contentHash.mockResolvedValue("abc123");
		const file = new File([new Uint8Array([1, 2, 3])], "a.jpg");
		const r = await readFileId(file);
		expect(r.id).toBe("local-abc123");
		expect(Array.from(r.bytes)).toEqual([1, 2, 3]);
		expect(await idForFile(file)).toBe("local-abc123");
	});
});

describe("placeBatch", () => {
	it("prefers a pin, then GPS, then an interpolated estimate, else none", () => {
		const a = lm("a", {
			takenAt: "2026-09-07T10:00:00.000Z",
			lat: 46.7,
			lon: 7.7,
			tz: "+02:00",
		});
		const b = lm("b", {
			takenAt: "2026-09-07T10:10:00.000Z",
			lat: 46.72,
			lon: 7.72,
			tz: "+02:00",
		});
		const mid = lm("mid", {
			takenAt: "2026-09-07T10:05:00.000Z",
			lat: NaN_,
			lon: NaN_,
			timeSource: "exif",
		});
		const lost = lm("lost", {
			takenAt: "2026-09-07T20:00:00.000Z",
			lat: NaN_,
			lon: NaN_,
		});
		const pinned = lm("pinned", {
			takenAt: "2026-09-07T21:00:00.000Z",
			lat: NaN_,
			lon: NaN_,
		});
		const out = placeBatch(
			[a, b, mid, lost, pinned],
			new Map([["pinned", { lat: 46.0, lon: 7.0 }]]),
		);
		expect(out.get("a")).toEqual({ kind: "gps" });
		expect(out.get("pinned")).toEqual({ kind: "pin", lat: 46.0, lon: 7.0 });
		const m = out.get("mid");
		expect(m?.kind).toBe("estimate");
		if (m?.kind === "estimate") {
			expect(m.est.method).toBe("interpolated");
			expect(m.est.lat).toBeGreaterThan(46.7);
			expect(m.est.lat).toBeLessThan(46.72);
		}
		expect(out.get("lost")).toEqual({ kind: "none" });
	});

	it("never interpolates from the file date", () => {
		const a = lm("a", { takenAt: "2026-09-07T10:00:00.000Z", tz: "+02:00" });
		const f = lm("f", {
			takenAt: "2026-09-07T10:01:00.000Z",
			lat: NaN_,
			lon: NaN_,
			timeSource: "file",
		});
		expect(placeBatch([a, f], new Map()).get("f")).toEqual({ kind: "none" });
	});

	it("shifts a zone-less EXIF time by the batch's GPS zone before interpolating", () => {
		// the GPS'd photos are in +02:00; the GPS-less one carries the same wall clock read as UTC
		const a = lm("a", { takenAt: "2026-09-07T08:00:00.000Z", tz: "+02:00" });
		const b = lm("b", {
			takenAt: "2026-09-07T08:10:00.000Z",
			tz: "+02:00",
			lat: 46.72,
			lon: 7.72,
		});
		const wall = lm("w", {
			takenAt: "2026-09-07T10:05:00.000Z", // 10:05 local = 08:05 UTC
			lat: NaN_,
			lon: NaN_,
			timeSource: "exif-local",
			tzEstimated: true,
		});
		const p = placeBatch([a, b, wall], new Map()).get("w");
		expect(p?.kind).toBe("estimate");
	});
});

describe("placedMeta and provenanceOf", () => {
	const draft = { meta: lm("d") } as unknown as UploadDraft;
	it("returns the draft meta for GPS, a placed copy for pins and estimates, null for none", () => {
		expect(placedMeta(draft, { kind: "gps" })).toBe(draft.meta);
		expect(placedMeta(draft, { kind: "none" })).toBeNull();
		const pin = placedMeta(draft, { kind: "pin", lat: 1, lon: 2 });
		expect(pin).toMatchObject({ lat: 1, lon: 2, placed: true });
		const est = placedMeta(draft, {
			kind: "estimate",
			est: {
				lat: 3,
				lon: 4,
				method: "interpolated",
				accuracyM: 55,
				from: ["a"],
				gapS: 3,
			},
		});
		expect(est).toMatchObject({ lat: 3, lon: 4, hAccuracy: 55 });
	});
	it("derives provenance from the placement kind", () => {
		expect(provenanceOf({ kind: "gps" })).toBeNull();
		expect(provenanceOf({ kind: "none" })).toBeNull();
		expect(provenanceOf({ kind: "pin", lat: 1, lon: 2 })).toMatchObject({
			method: "pin",
			accuracyM: null,
			from: [],
			gapS: null,
		});
		expect(
			provenanceOf({
				kind: "estimate",
				est: {
					lat: 3,
					lon: 4,
					method: "nearest",
					accuracyM: 30,
					from: ["k"],
					gapS: 9,
				},
			}),
		).toMatchObject({ method: "nearest", accuracyM: 30, from: ["k"], gapS: 9 });
	});
});

describe("representative", () => {
	it("is the photo nearest the centroid", () => {
		const ms = [
			lm("w", { lat: 46.7, lon: 7.69 }),
			lm("c", { lat: 46.7, lon: 7.7 }),
			lm("e", { lat: 46.7, lon: 7.71 }),
		];
		expect(representative(ms).id).toBe("c");
	});
	it("prefers photos a bundled region covers", () => {
		upload.bundled.mockImplementation((_lat: number, lon: number) =>
			lon > 7.705 ? "niederhorn" : null,
		);
		const ms = [
			lm("w", { lat: 46.7, lon: 7.69 }),
			lm("c", { lat: 46.7, lon: 7.7 }),
			lm("e", { lat: 46.7, lon: 7.71 }),
		];
		expect(representative(ms).id).toBe("e");
	});
});

describe("saveRoll", () => {
	const entry = (id: string): SaveEntry => ({
		draft: { id } as unknown as UploadDraft,
		meta: lm(id),
		provenance: null,
	});
	it("does nothing for an empty roll", async () => {
		expect(await saveRoll([])).toEqual({ saved: [], regionError: null });
		expect(upload.regionFor).not.toHaveBeenCalled();
	});

	it("fetches the region once and threads it through every save", async () => {
		upload.regionFor.mockResolvedValue({ id: "r0", photos: [] });
		upload.saveUpload.mockImplementation(async (_d, _m, region) => ({
			region: { ...region, photos: [...region.photos, "x"] },
		}));
		const saved: string[] = [];
		const out = await saveRoll([entry("a"), entry("b"), entry("c")], {
			onSaved: (id) => saved.push(id),
		});
		expect(upload.regionFor).toHaveBeenCalledTimes(1);
		expect(out).toEqual({ saved: ["a", "b", "c"], regionError: null });
		expect(saved).toEqual(["a", "b", "c"]);
		expect(upload.saveUpload.mock.calls[2][2].photos).toHaveLength(2);
	});

	it("still saves photos when the region fetch fails, reporting the error", async () => {
		upload.regionFor.mockRejectedValue(new Error("overpass down"));
		upload.saveUpload.mockResolvedValue({ region: null });
		const out = await saveRoll([entry("a")]);
		expect(out).toEqual({ saved: ["a"], regionError: "overpass down" });
		expect(upload.saveUpload.mock.calls[0][2]).toBeNull();
	});

	it("reports a failed save and carries on", async () => {
		upload.regionFor.mockResolvedValue({ id: "r", photos: [] });
		upload.saveUpload
			.mockRejectedValueOnce(new Error("quota"))
			.mockResolvedValueOnce({ region: { id: "r", photos: [] } });
		const events: [string, string | undefined][] = [];
		const out = await saveRoll([entry("a"), entry("b")], {
			onSaved: (id, err) => events.push([id, err]),
		});
		expect(out.saved).toEqual(["b"]);
		expect(events).toEqual([
			["a", "quota"],
			["b", undefined],
		]);
	});

	it("stops when aborted", async () => {
		upload.regionFor.mockResolvedValue({ id: "r", photos: [] });
		upload.saveUpload.mockResolvedValue({ region: { id: "r", photos: [] } });
		const ac = new AbortController();
		const out = await saveRoll([entry("a"), entry("b")], {
			signal: ac.signal,
			onSaved: () => ac.abort(),
		});
		expect(out.saved).toEqual(["a"]);
	});

	it("forwards region progress with its detail", async () => {
		upload.regionFor.mockImplementation(async (_m, o) => {
			o.onProgress("trails", "3/5");
			o.onProgress("peaks");
			return { id: "r", photos: [] };
		});
		upload.saveUpload.mockResolvedValue({ region: { id: "r", photos: [] } });
		const stages: string[] = [];
		await saveRoll([entry("a")], { onRegion: (s) => stages.push(s) });
		expect(stages).toEqual(["trails (3/5)", "peaks"]);
	});
});
