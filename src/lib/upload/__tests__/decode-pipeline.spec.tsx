// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeImage, HeicUnsupportedError } from "../decode";
import { MAX_PX } from "../exif";

// Fakes for the browser decode surface (createImageBitmap, canvas, ImageBitmap) so the pipeline's
// sizing, passthrough and error rules run in happy-dom, which has no real image codecs.
class FakeBitmap {
	closed = false;
	constructor(
		public width: number,
		public height: number,
	) {}
	close() {
		this.closed = true;
	}
}

type Canvas = {
	width: number;
	height: number;
	getContext: () => { drawImage: ReturnType<typeof vi.fn> } | null;
	toBlob: (cb: (b: Blob | null) => void, type: string, q: number) => void;
};
let canvases: Canvas[];
let noEncode = false;
let noContext = false;

const jpegBytes = () =>
	Uint8Array.from([
		0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	]);
const jpegFile = (name = "a.jpg") => {
	const f = new File([jpegBytes()], name, { type: "image/jpeg" });
	return f;
};

let createImageBitmapMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	canvases = [];
	noEncode = false;
	noContext = false;
	vi.stubGlobal("ImageBitmap", FakeBitmap);
	createImageBitmapMock = vi.fn(async () => new FakeBitmap(4000, 3000));
	vi.stubGlobal("createImageBitmap", createImageBitmapMock);
	const realCreate = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
		if (tag !== "canvas") return realCreate(tag);
		const c: Canvas = {
			width: 0,
			height: 0,
			getContext: () => (noContext ? null : { drawImage: vi.fn() }),
			toBlob: (cb, type) =>
				cb(noEncode ? null : new Blob([`${c.width}x${c.height}`], { type })),
		};
		canvases.push(c);
		return c as unknown as HTMLCanvasElement;
	}) as typeof document.createElement);
});

afterEach(() => vi.restoreAllMocks());

describe("decodeImage sizing", () => {
	it("caps the long side at MAX_PX, keeps the aspect, and reports the uncapped source size", async () => {
		const f = jpegFile();
		const d = await decodeImage(f, jpegBytes(), 1);
		expect(d.sourceWidth).toBe(4000);
		expect(d.sourceHeight).toBe(3000);
		expect(d.width).toBe(MAX_PX);
		expect(d.height).toBe(Math.round((3000 * MAX_PX) / 4000));
		expect(d.decoder).toBe("native");
		expect(d.blob.type).toBe("image/jpeg");
		// the thumbnail's long side is 360
		expect(Number((await d.thumb.text()).split("x")[0])).toBe(360);
	});

	it("never upscales a small image", async () => {
		createImageBitmapMock.mockResolvedValueOnce(new FakeBitmap(300, 200));
		const d = await decodeImage(jpegFile(), jpegBytes(), 1);
		expect([d.width, d.height]).toEqual([300, 200]);
		expect([d.sourceWidth, d.sourceHeight]).toEqual([300, 200]);
	});

	it("requests EXIF-upright decoding from the browser and closes the bitmap", async () => {
		const bmp = new FakeBitmap(100, 100);
		createImageBitmapMock.mockResolvedValueOnce(bmp);
		await decodeImage(jpegFile(), jpegBytes(), 1);
		expect(createImageBitmapMock.mock.calls[0][1]).toEqual({
			imageOrientation: "from-image",
		});
		expect(bmp.closed).toBe(true);
	});

	it("rejects a zero-sized decode", async () => {
		createImageBitmapMock.mockResolvedValueOnce(new FakeBitmap(0, 0));
		await expect(decodeImage(jpegFile(), jpegBytes(), 1)).rejects.toThrow(
			"decoded image is empty",
		);
	});
});

describe("decodeImage passthrough", () => {
	it("returns an upright small JPEG byte-for-byte (same size, image/jpeg)", async () => {
		createImageBitmapMock.mockResolvedValueOnce(new FakeBitmap(1200, 800));
		const f = jpegFile();
		const d = await decodeImage(f, jpegBytes(), 1);
		expect(d.decoder).toBe("passthrough");
		expect(d.blob.size).toBe(f.size);
		expect(d.blob.type).toBe("image/jpeg");
	});

	it("re-encodes when EXIF orientation is not 1, even for a small JPEG", async () => {
		for (const o of [3, 6, 8]) {
			createImageBitmapMock.mockResolvedValueOnce(new FakeBitmap(1200, 800));
			const d = await decodeImage(jpegFile(), jpegBytes(), o);
			expect(d.decoder).toBe("native");
		}
	});

	it("re-encodes a non-JPEG even when small and upright", async () => {
		createImageBitmapMock.mockResolvedValueOnce(new FakeBitmap(100, 100));
		const png = Uint8Array.from([
			0x89,
			0x50,
			0x4e,
			0x47,
			...new Array(20).fill(0),
		]);
		const d = await decodeImage(
			new File([png], "a.png", { type: "image/png" }),
			png,
			1,
		);
		expect(d.decoder).toBe("native");
		expect(d.blob.type).toBe("image/jpeg");
	});
});

describe("decodeImage failures", () => {
	it("names RAW and TIFF files with an export hint", async () => {
		for (const name of [
			"IMG_1.DNG",
			"x.cr2",
			"x.CR3",
			"x.nef",
			"x.tiff",
			"x.ARW",
		]) {
			createImageBitmapMock.mockRejectedValueOnce(new Error("no"));
			vi.stubGlobal(
				"Image",
				class {
					set src(_: string) {}
					decode() {
						return Promise.reject(new Error("undecodable"));
					}
				},
			);
			await expect(
				decodeImage(jpegFile(name), new Uint8Array(32), 1),
			).rejects.toThrow(/RAW and TIFF/);
		}
	});

	it("reports the underlying reason and the supported formats for other undecodable files", async () => {
		createImageBitmapMock.mockRejectedValueOnce(new Error("bad data"));
		vi.stubGlobal(
			"Image",
			class {
				set src(_: string) {}
				decode() {
					return Promise.reject(new Error("bad data"));
				}
			},
		);
		const err = (await decodeImage(
			jpegFile("x.bin"),
			new Uint8Array(32),
			1,
		).catch((e) => e)) as Error;
		expect(err.message).toContain("bad data");
		expect(err.message).toContain("JPEG, HEIC, PNG, WebP, AVIF");
		expect(err).not.toBeInstanceOf(HeicUnsupportedError);
	});

	it("falls back to <img> decoding when createImageBitmap rejects, and revokes the object URL", async () => {
		createImageBitmapMock.mockRejectedValueOnce(new Error("no bitmap"));
		class FakeImg {
			naturalWidth = 640;
			naturalHeight = 480;
			src = "";
			decode() {
				return Promise.resolve();
			}
		}
		vi.stubGlobal("HTMLImageElement", FakeImg);
		vi.stubGlobal("Image", FakeImg);
		const create = vi.fn(() => "blob:fake");
		const revoke = vi.fn();
		vi.stubGlobal(
			"URL",
			Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }),
		);
		const d = await decodeImage(jpegFile(), jpegBytes(), 1);
		expect([d.sourceWidth, d.sourceHeight]).toEqual([640, 480]);
		expect(revoke).toHaveBeenCalledWith("blob:fake");
	});

	it("surfaces a HEIF container that neither the browser nor libheif can decode as HeicUnsupportedError", async () => {
		createImageBitmapMock.mockRejectedValueOnce(new Error("no heic"));
		vi.stubGlobal(
			"Image",
			class {
				set src(_: string) {}
				decode() {
					return Promise.reject(new Error("no heic"));
				}
			},
		);
		const heic = new Uint8Array(32);
		new DataView(heic.buffer).setUint32(0, 24);
		heic.set(new TextEncoder().encode("ftypheic"), 4);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(
			decodeImage(new File([heic], "a.heic", { type: "image/heic" }), heic, 1),
		).rejects.toBeInstanceOf(HeicUnsupportedError);
	});

	it("fails clearly when a 2D canvas or the JPEG encoder is unavailable", async () => {
		noContext = true;
		await expect(decodeImage(jpegFile(), jpegBytes(), 1)).rejects.toThrow(
			"2D canvas unavailable",
		);
		noContext = false;
		noEncode = true;
		await expect(decodeImage(jpegFile(), jpegBytes(), 1)).rejects.toThrow(
			"JPEG encode failed",
		);
	});
});
