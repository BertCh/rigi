// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import { unprojectDir } from "#/lib/pose";
import type { Renderer } from "#/lib/renderer";
import { geoidUndulation } from "#/lib/tiles3d/geoid";
import {
	EXPORT_FORMATS,
	engineCameraModel,
	enginePeaks,
	engineReady,
	exportFilename,
	exportFromEngine,
	geometryBufferState,
	resolveGeoidUndulation,
} from "../engine-export";
import { FIXTURE, parseXml, readZip } from "./fixtures";

type Opts = {
	terrain?: boolean;
	stale?: boolean;
	sky?: boolean;
	mode?: string;
	protect?: boolean;
};

/** A just-enough fake engine (the Renderer surface): sampleAt returns hits that agree with (or, if stale, not) the pose. */
function fakeEngine(o: Opts = {}) {
	const eye = { x: 0, y: 0, z: 1361.3 };
	const pose = { ...FIXTURE.pose };
	const aspect = FIXTURE.width / FIXTURE.height;
	const e = {
		photo: {
			id: "IMG_7131",
			src: "/photos/IMG_7131.jpg",
			width: FIXTURE.width,
			height: FIXTURE.height,
			takenAt: "2023-07-01T12:20:30+02:00",
			takenAtUtc: "2023-07-01T10:20:30Z",
		},
		pose,
		aspect,
		frame: {
			...FIXTURE.frame,
			toGeo: (x: number, y: number) => ({
				lat: 47 + y * 1e-5,
				lon: 8.7 + x * 1e-5,
			}),
		},
		eye,
		demAtCamera: 1350,
		terrain: o.terrain === false ? null : {},
		settings: { protectPeople: o.protect ?? false, mode: o.mode ?? "overlay" },
		setPose: vi.fn(),
		isForeground: vi.fn(() => false),
		sampleAt: vi.fn((u: number, v: number) => {
			if (o.sky) return null;
			const p = o.stale ? { ...pose, yaw: pose.yaw + 5 } : pose;
			const r = unprojectDir(p, aspect, u, v);
			const range = 800 + 500 * v;
			return {
				lat: 47 + (1 - v) * 0.01,
				lon: 8.6 + u * 0.01,
				h: 1000,
				range,
				world: [
					eye.x + r.x * range,
					eye.y + r.y * range,
					eye.z + r.z * range,
				] as [number, number, number],
			};
		}),
		peaksInFrame: vi.fn(() => [
			{
				name: "In",
				ele: 2100,
				u: 0.5,
				v: 0.4,
				world: [100, 3000, 2100] as [number, number, number],
			},
			{
				name: "Out",
				ele: 2000,
				u: 1.5,
				v: 0.4,
				world: [0, 0, 0] as [number, number, number],
			},
		]),
	};
	return e as unknown as Renderer & typeof e;
}

describe("EXPORT_FORMATS / exportFilename", () => {
	it("has a unique kind, an extension and a mime per entry", () => {
		const kinds = EXPORT_FORMATS.map((f) => f.kind);
		expect(new Set(kinds).size).toBe(kinds.length);
		expect(kinds).toEqual(["png", "kmz", "geojson", "pose", "colmap", "xmp"]);
		for (const f of EXPORT_FORMATS) {
			expect(f.ext.startsWith(".")).toBe(true);
			expect(f.mime).toMatch(/^[a-z]+\/[\w.+-]+$/);
		}
	});
	it("names files <id><ext>", () => {
		expect(exportFilename({ id: "IMG_1" }, "kmz")).toBe("IMG_1.kmz");
		expect(exportFilename({ id: "IMG_1" }, "pose")).toBe("IMG_1.pose.json");
		expect(exportFilename({ id: "IMG_1" }, "png")).toBe("IMG_1.annotated.png");
	});
});

describe("engineReady / resolveGeoidUndulation", () => {
	it("is ready only with terrain", () => {
		expect(engineReady(null)).toBe(false);
		expect(engineReady(undefined)).toBe(false);
		expect(engineReady(fakeEngine({ terrain: false }))).toBe(false);
		expect(engineReady(fakeEngine())).toBe(true);
	});
	it("prefers an explicit N, else the EGM2008 grid at the frame origin", () => {
		const e = fakeEngine();
		expect(resolveGeoidUndulation(e, 12.5)).toBe(12.5);
		expect(resolveGeoidUndulation(e, 0)).toBe(0);
		const n = resolveGeoidUndulation(e);
		expect(n).toBe(geoidUndulation(FIXTURE.frame.lat, FIXTURE.frame.lon));
		expect(n).toBeGreaterThan(44);
		expect(n).toBeLessThan(56);
	});
});

describe("engineCameraModel", () => {
	it("copies pose, eye and frame and prefers the UTC capture time", () => {
		const m = engineCameraModel(fakeEngine(), { geoidUndulation: 49 });
		expect(m.input.photoId).toBe("IMG_7131");
		expect(m.input.takenAt).toBe("2023-07-01T10:20:30Z");
		expect(m.altEllipsoid).toBeCloseTo(m.altMsl + 49, 6);
		expect(m.eyeOffset).toBeCloseTo(11.3, 4);
	});
	it("does not alias the engine pose", () => {
		const e = fakeEngine();
		const m = engineCameraModel(e);
		e.pose.yaw = 99;
		expect(m.input.pose.yaw).toBe(20.84);
	});
});

describe("geometryBufferState", () => {
	it("is fresh when the buffer agrees with the pose", () => {
		const s = geometryBufferState(fakeEngine());
		expect(s.state).toBe("fresh");
		expect(s.hits).toBe(24 * 24);
		expect(s.medianErrDeg).toBeLessThan(1e-6);
	});
	it("is stale when the pose moved since the readback", () => {
		const s = geometryBufferState(fakeEngine({ stale: true }));
		expect(s.state).toBe("stale");
		expect(s.medianErrDeg).toBeGreaterThan(0.15);
	});
	it("is empty over sky", () => {
		expect(geometryBufferState(fakeEngine({ sky: true }))).toEqual({
			state: "empty",
			hits: 0,
			medianErrDeg: null,
		});
	});
});

describe("enginePeaks", () => {
	it("drops peaks outside the frame and flags untested ones when the buffer is not fresh", () => {
		const ps = enginePeaks(fakeEngine(), "stale");
		expect(ps.map((p) => p.name)).toEqual(["In"]);
		expect(ps[0].visible).toBeNull();
		expect(ps[0].distKm).toBeGreaterThan(1);
	});
	it("tests occlusion against the buffer when fresh", () => {
		// buffer range ~1000 m, peak range ~3 km: terrain in front of the summit
		const ps = enginePeaks(fakeEngine(), "fresh");
		expect(ps[0].visible).toBe(false);
	});
	it("hides people-covered peaks", () => {
		const e = fakeEngine({ protect: true });
		(e.isForeground as ReturnType<typeof vi.fn>).mockReturnValue(true);
		expect(enginePeaks(e, "stale")[0].visible).toBe(false);
	});
});

describe("exportFromEngine", () => {
	it("refuses before terrain has loaded", async () => {
		await expect(
			exportFromEngine(fakeEngine({ terrain: false }), "pose"),
		).rejects.toThrow(/Terrain still loading/);
	});
	it("rejects an unknown kind", async () => {
		await expect(
			exportFromEngine(fakeEngine(), "nope" as never),
		).rejects.toThrow(/unknown export kind/);
	});
	it("pose: JSON blob with the right name and mime", async () => {
		const r = await exportFromEngine(fakeEngine(), "pose", {
			geoidUndulation: 49,
		});
		expect(r.filename).toBe("IMG_7131.pose.json");
		expect(r.blob.type).toBe("application/json");
		const j = JSON.parse(await r.blob.text());
		expect(j.schema).toBe("rigi/pose");
		expect(j.position.geoidUndulation).toBe(49);
		expect(j.photo.takenAt).toBe("2023-07-01T10:20:30Z");
	});
	it("pose: carries the host's estimate and notes an unverified pose", async () => {
		const estimate = {
			provenance: {
				agent: "sensor",
				method: "exif-prior",
				status: "candidate",
			},
			label: "Phone sensors",
		} as const;
		const r = await exportFromEngine(fakeEngine(), "pose", { estimate });
		const j = JSON.parse(await r.blob.text());
		expect(j.estimate.trusted).toBe(false);
		expect(j.estimate.method).toBe("exif-prior");
		expect(r.notes.join(" ")).toMatch(/Pose not verified \(Phone sensors\)/);
		const trusted = await exportFromEngine(fakeEngine(), "pose", {
			estimate: { provenance: { status: "endorsed" } },
		});
		expect(trusted.notes.join(" ")).not.toMatch(/not verified/);
		const none = await exportFromEngine(fakeEngine(), "pose");
		expect(JSON.parse(await none.blob.text()).estimate).toBeNull();
		expect(none.notes.join(" ")).not.toMatch(/not verified/);
	});
	it("xmp: well-formed XML", async () => {
		const r = await exportFromEngine(fakeEngine(), "xmp");
		expect(r.filename).toBe("IMG_7131.xmp");
		expect(parseXml(await r.blob.text()).root).toBe("x:xmpmeta");
	});
	it("colmap: a three-file zip", async () => {
		const r = await exportFromEngine(fakeEngine(), "colmap");
		const z = readZip(new Uint8Array(await r.blob.arrayBuffer()));
		expect(z.map((f) => f.name)).toEqual([
			"sparse/0/cameras.txt",
			"sparse/0/images.txt",
			"sparse/0/points3D.txt",
		]);
	});
	it("kmz: packages the fetched JPEG unchanged", async () => {
		const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
		const fetchMock = vi.fn(async () => new Response(jpeg, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const r = await exportFromEngine(fakeEngine(), "kmz");
		expect(fetchMock).toHaveBeenCalledWith("/photos/IMG_7131.jpg");
		const z = readZip(new Uint8Array(await r.blob.arrayBuffer()));
		expect(z[0].name).toBe("doc.kml");
		expect(Array.from(z[1].data)).toEqual(Array.from(jpeg));
		expect(r.notes).toEqual([]);
	});
	it("kmz: errors when the photo is not fetchable as JPEG and there is no decoded element", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 404 })),
		);
		await expect(exportFromEngine(fakeEngine(), "kmz")).rejects.toThrow(
			/photo not loaded/,
		);
	});
	it("geojson: fresh buffer gives a footprint and visible peaks", async () => {
		const r = await exportFromEngine(fakeEngine(), "geojson");
		const fc = JSON.parse(await r.blob.text());
		const kinds = fc.features.map(
			(f: { properties: { kind: string } }) => f.properties.kind,
		);
		expect(kinds).toContain("footprint");
		expect(kinds).toContain("camera");
		expect(r.filename).toBe("IMG_7131.geojson");
		expect(r.blob.type).toBe("application/geo+json");
	});
	it("geojson: a stale buffer that never settles omits footprint and peaks with a note", async () => {
		const e = fakeEngine({ stale: true });
		vi.useFakeTimers();
		const pending = exportFromEngine(e, "geojson");
		await vi.advanceTimersByTimeAsync(2000);
		const r = await pending;
		vi.useRealTimers();
		const fc = JSON.parse(await r.blob.text());
		expect(
			fc.features.map(
				(f: { properties: { kind: string } }) => f.properties.kind,
			),
		).toEqual(["camera", "view-direction", "fov-wedge"]);
		expect(r.notes[0]).toMatch(/did not settle/);
		expect(e.setPose).toHaveBeenCalled();
	});
	it("geojson: all-sky reports no terrain", async () => {
		vi.useFakeTimers();
		const pending = exportFromEngine(fakeEngine({ sky: true }), "geojson");
		await vi.advanceTimersByTimeAsync(2000);
		const r = await pending;
		vi.useRealTimers();
		expect(r.notes[0]).toMatch(/no terrain in the geometry buffer/);
	});
	it("geojson: notes when sampled in world view", async () => {
		const r = await exportFromEngine(fakeEngine({ mode: "world" }), "geojson");
		expect(r.notes).toContain("footprint sampled while in world view");
	});
});
