// Glue between a live PhotoEngine and the pure export builders in this folder.
// Browser-only (Blob, fetch, canvas). Uses ONLY the engine's public API:
//   engine.photo, pose, frame, eye, demAtCamera, terrain (readiness), settings.protectPeople,
//   peaksInFrame(), sampleAt(u,v), isForeground(u,v), exportImage(withLabels), photoElement,
//   onRender(), setPose(). Nothing here changes engine state: exportImage() restores itself, and
//   refreshGeometry() re-sets the SAME pose only to force a fresh geometry-buffer readback.

import { attributionLine, fullAttribution } from "#/lib/licences/attribution";
import type { PhotoMeta } from "#/lib/photos";
import { unprojectDir } from "#/lib/pose";
import type { Renderer as PhotoEngine } from "#/lib/renderer";
import { composeAnnotatedPng } from "./annotate";
import { buildCameraModel, type CameraModel } from "./camera";
import { buildColmapZip } from "./colmap";
import { buildGeoJson, type PeakInput } from "./geojson";
import { buildKmz, kmzBlob } from "./kml";
import { buildPoseJson } from "./pose-json";
import { buildXmp } from "./xmp";

export type ExportKind = "png" | "kmz" | "geojson" | "pose" | "colmap" | "xmp";

export type ExportFormat = {
	kind: ExportKind;
	label: string;
	ext: string;
	mime: string;
	hint: string;
};

/** Menu order + file naming. File name = `${photo.id}${ext}`. */
export const EXPORT_FORMATS: ExportFormat[] = [
	{
		kind: "png",
		label: "Annotated image",
		ext: ".annotated.png",
		mime: "image/png",
		hint: "PNG · overlay, labels, credits",
	},
	{
		kind: "kmz",
		label: "Google Earth",
		ext: ".kmz",
		mime: "application/vnd.google-earth.kmz",
		hint: "KMZ · PhotoOverlay + photo",
	},
	{
		kind: "geojson",
		label: "GeoJSON",
		ext: ".geojson",
		mime: "application/geo+json",
		hint: "view wedge, peaks, footprint",
	},
	{
		kind: "pose",
		label: "Pose",
		ext: ".pose.json",
		mime: "application/json",
		hint: "JSON · K, R|t, lat/lon/alt",
	},
	{
		kind: "colmap",
		label: "COLMAP",
		ext: ".colmap.zip",
		mime: "application/zip",
		hint: "sparse/0 text model (ECEF)",
	},
	{
		kind: "xmp",
		label: "XMP sidecar",
		ext: ".xmp",
		mime: "application/rdf+xml",
		hint: "GPS + heading/pitch/roll",
	},
];

export type EngineExportOptions = {
	/** Draw peak labels into the annotated image (mirror the workspace's "Peak labels" toggle). Default true. */
	withLabels?: boolean;
	/** Geoid undulation N (m) for true ellipsoidal ECEF / GeoJSON z. Default: none (MSL heights). */
	geoidUndulation?: number;
	/** GeoJSON view-ray / wedge length (m). Default 30 000. */
	maxRange?: number;
};

export type ExportResult = { blob: Blob; filename: string; notes: string[] };

/**
 * NECESSARY, NOT SUFFICIENT. The engine sets `terrain` in init() before segmentation, horizon tracing
 * and the host's autoAlign(); for ~150-650 ms after this turns true, engine.pose is still the compass
 * prior (measured up to 10° off in yaw). Only the host knows when alignment is done, so it must also
 * gate exports (ExportMenu: `disabled={!!status}` in PhotoWorkspace, whose status stays set until
 * after setPose(autoAlign result)).
 */
export function engineReady(
	engine: PhotoEngine | null | undefined,
): engine is PhotoEngine {
	return !!engine?.terrain;
}

export function exportFilename(photo: Pick<PhotoMeta, "id">, kind: ExportKind) {
	const f = EXPORT_FORMATS.find((x) => x.kind === kind);
	return `${photo.id}${f?.ext ?? `.${kind}`}`;
}

export function engineCameraModel(
	engine: PhotoEngine,
	opts: EngineExportOptions = {},
): CameraModel {
	const p = engine.photo;
	return buildCameraModel({
		photoId: p.id,
		imageName: `${p.id}.jpg`,
		width: p.width,
		height: p.height,
		pose: { ...engine.pose },
		frame: { lat: engine.frame.lat, lon: engine.frame.lon, h: engine.frame.h },
		eye: [engine.eye.x, engine.eye.y, engine.eye.z],
		demAtCamera: engine.demAtCamera,
		takenAt: p.takenAtUtc ?? p.takenAt,
		geoidUndulation: opts.geoidUndulation,
	});
}

export type GeometryState = "fresh" | "stale" | "empty";

/**
 * Is the engine's CPU geometry buffer (what sampleAt reads) consistent with the CURRENT pose?
 * The engine reads it back only 90 ms after the last pose change, so right after a nudge/drag it
 * describes the previous pose, and before the first readback it is all zeros. Tested directly: the
 * direction eye→sample.world of buffer hits on a grid must match the current pose's pixel ray.
 */
export function geometryBufferState(engine: PhotoEngine): {
	state: GeometryState;
	hits: number;
	medianErrDeg: number | null;
} {
	const N = 24;
	const errs: number[] = [];
	const e = engine.eye;
	for (let j = 0; j < N; j++)
		for (let i = 0; i < N; i++) {
			const u = (i + 0.5) / N;
			const v = (j + 0.5) / N;
			const s = engine.sampleAt(u, v);
			if (!s) continue;
			const dx = s.world[0] - e.x;
			const dy = s.world[1] - e.y;
			const dz = s.world[2] - e.z;
			const len = Math.hypot(dx, dy, dz);
			if (!(len > 0)) continue;
			// sampleAt reads the texel containing (u,v); half a 1024-px texel is ~0.03°, well under 0.15°
			const r = unprojectDir(engine.pose, engine.aspect, u, v);
			const c = Math.min(
				1,
				Math.max(-1, (dx * r.x + dy * r.y + dz * r.z) / len),
			);
			errs.push((Math.acos(c) * 180) / Math.PI);
		}
	if (!errs.length) return { state: "empty", hits: 0, medianErrDeg: null };
	errs.sort((a, b) => a - b);
	const med = errs[errs.length >> 1];
	return {
		state: med < 0.15 ? "fresh" : "stale",
		hits: errs.length,
		medianErrDeg: med,
	};
}

/**
 * Make sampleAt() describe the current pose: if the buffer is stale or empty, re-set the same pose
 * (marks the geometry dirty → render → readback after 90 ms) and wait until it is consistent.
 * Resolves with the final state; 'empty' after the timeout means all sky or no readback yet.
 */
export async function refreshGeometry(
	engine: PhotoEngine,
	timeoutMs = 1500,
): Promise<GeometryState> {
	let st = geometryBufferState(engine).state;
	if (st === "fresh") return st;
	engine.setPose({ ...engine.pose });
	const t0 = performance.now();
	while (performance.now() - t0 < timeoutMs) {
		await new Promise((r) => setTimeout(r, 40));
		st = geometryBufferState(engine).state;
		if (st === "fresh") return st;
	}
	return st;
}

/**
 * Every peak projected into the frame, with the same occlusion test engine.peakLabels() uses
 * (geometry-buffer range just below the summit) but WITHOUT its label decluttering, so the
 * GeoJSON gets all visible peaks, not only the ones that got an on-screen label.
 */
export function enginePeaks(
	engine: PhotoEngine,
	geometry: GeometryState = geometryBufferState(engine).state,
): PeakInput[] {
	const e = engine.eye;
	// without a buffer that matches the pose, the occlusion test is meaningless: flag as untested
	const tested = geometry === "fresh";
	return engine
		.peaksInFrame()
		.filter((l) => l.u >= 0 && l.u <= 1 && l.v >= 0 && l.v <= 1)
		.map((l) => {
			const [x, y, z] = l.world;
			const range = Math.hypot(x - e.x, y - e.y, z - e.z);
			let visible: boolean | null = null;
			if (tested) {
				visible = false;
				for (const dv of [0.004, 0.009]) {
					const s = engine.sampleAt(l.u, l.v + dv);
					if (!s || s.range > range * 0.97 - 50) visible = true;
				}
			}
			if (engine.settings.protectPeople && engine.isForeground(l.u, l.v))
				visible = false;
			const g = engine.frame.toGeo(x, y, z);
			return {
				name: l.name,
				ele: l.ele,
				lat: g.lat,
				lon: g.lon,
				u: l.u,
				v: l.v,
				visible,
				distKm: range / 1000,
			};
		});
}

const isJpeg = (b: Uint8Array) =>
	b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Original photo bytes if they are a JPEG, else the decoded photo re-encoded as JPEG. */
async function photoJpeg(
	engine: PhotoEngine,
	notes: string[],
): Promise<Uint8Array> {
	try {
		const res = await fetch(engine.photo.src);
		if (res.ok) {
			const bytes = new Uint8Array(await res.arrayBuffer());
			if (isJpeg(bytes)) return bytes;
		}
	} catch {
		/* fall through to re-encode */
	}
	const img = engine.photoElement;
	if (!img) throw new Error("photo not loaded");
	const c = document.createElement("canvas");
	c.width = img.naturalWidth;
	c.height = img.naturalHeight;
	(c.getContext("2d") as CanvasRenderingContext2D).drawImage(img, 0, 0);
	const blob = await new Promise<Blob | null>((r) =>
		c.toBlob(r, "image/jpeg", 0.92),
	);
	if (!blob) throw new Error("could not encode photo as JPEG");
	notes.push("photo re-encoded as JPEG (source was not a fetchable JPEG)");
	return new Uint8Array(await blob.arrayBuffer());
}

/** Build one export from the live engine. Throws if the engine is not ready. */
export async function exportFromEngine(
	engine: PhotoEngine,
	kind: ExportKind,
	opts: EngineExportOptions = {},
): Promise<ExportResult> {
	if (!engineReady(engine))
		throw new Error("Terrain still loading: the pose is not final yet");
	const fmt = EXPORT_FORMATS.find((f) => f.kind === kind);
	if (!fmt) throw new Error(`unknown export kind ${kind}`);
	const filename = exportFilename(engine.photo, kind);
	const notes: string[] = [];
	const text = (s: string) => new Blob([s], { type: fmt.mime });

	switch (kind) {
		case "pose":
			return {
				blob: text(
					JSON.stringify(
						buildPoseJson(engineCameraModel(engine, opts)),
						null,
						2,
					),
				),
				filename,
				notes,
			};
		case "xmp":
			return {
				blob: text(buildXmp(engineCameraModel(engine, opts))),
				filename,
				notes,
			};
		case "colmap":
			return {
				blob: new Blob(
					[buildColmapZip(engineCameraModel(engine, opts)) as BlobPart],
					{ type: fmt.mime },
				),
				filename,
				notes,
			};
		case "kmz": {
			const jpeg = await photoJpeg(engine, notes);
			return {
				blob: kmzBlob(buildKmz(engineCameraModel(engine, opts), jpeg)),
				filename,
				notes,
			};
		}
		case "geojson": {
			const geometry = await refreshGeometry(engine);
			const fresh = geometry === "fresh";
			// untested visibility would mean every candidate in frame (hundreds), so peaks are left out
			const peaks = fresh ? enginePeaks(engine, geometry) : [];
			let hits = 0;
			const fc = buildGeoJson(engineCameraModel(engine, opts), {
				maxRange: opts.maxRange ?? 30000,
				peaks,
				// monoplotting through the geometry buffer; people pixels are not ground
				pixelToLatLon: (u, v) => {
					if (!fresh) return null;
					if (engine.settings.protectPeople && engine.isForeground(u, v))
						return null;
					const s = engine.sampleAt(u, v);
					if (s) hits++;
					return s;
				},
			});
			if (!fresh)
				notes.push(
					geometry === "stale"
						? "geometry buffer did not settle (pose still changing): footprint and peaks omitted"
						: "no terrain in the geometry buffer (all sky or not read back): footprint and peaks omitted",
				);
			else if (!fc.features.some((f) => f.properties.kind === "footprint"))
				notes.push(`footprint omitted (only ${hits} ground samples)`);
			if (engine.settings.mode === "world")
				notes.push("footprint sampled while in world view");
			return { blob: text(JSON.stringify(fc)), filename, notes };
		}
		case "png": {
			const rendered = await engine.exportImage(opts.withLabels ?? true);
			if (!rendered) throw new Error("render failed");
			if (engine.settings.mode === "world")
				notes.push("world view: exported the 3D map view, not the photo");
			const bmp = await createImageBitmap(rendered);
			try {
				const title = `${engine.photo.id} · heading ${(((engine.pose.yaw % 360) + 360) % 360).toFixed(1)}° · Rigi`;
				return {
					blob: await composeAnnotatedPng(bmp, [], {
						title,
						// opt-in (?attrib=full): per-source credits instead of DEFAULT_ATTRIBUTION
						...(fullAttribution()
							? { attribution: engineAttribution(engine) }
							: {}),
					}),
					filename,
					notes,
				};
			} finally {
				bmp.close();
			}
		}
	}
}

/** Compact per-source credit line for the engine's current view (src/lib/licences). */
function engineAttribution(engine: PhotoEngine) {
	const s = engine.settings;
	const imagery =
		s.mode === "replace" &&
		(s.mapStyle === "satellite" || s.mapStyle === "topo")
			? s.mapStyle
			: s.mode === "world" && s.worldStyle !== "hillshade"
				? s.worldStyle
				: "satellite";
	return attributionLine(
		{ lat: engine.photo.lat, lon: engine.photo.lon, imagery },
		{ compact: true },
	);
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob: Blob, filename: string) {
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = filename;
	a.rel = "noopener";
	a.style.display = "none";
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
