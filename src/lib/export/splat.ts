// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Georeferenced Step Inside splat export: a NearFieldScene (ENU splats) + the renderer's ENU frame →
//   (1) .splat-v1 (Rigi wire format, WGS84 origin in the header; src/lib/nearfield/splat-io.ts), or
//   (2) a standard 3DGS binary_little_endian .ply (x,y,z ENU metres, f_dc_0..2, opacity logit,
//       scale_0..2 log, rot_0..3 w,x,y,z, plus nx,ny,nz = 0 and a trailing uchar `provenance`) whose
//       header comments carry the origin, frame, pose, anchor quality, model, licence and provenance counts.
// Every export goes through filterForExport: `generated` splats never reach a measurement export.
// Pure builders (no DOM) + a thin engine glue at the bottom. Check: npx tsx src/lib/nearfield/export-check.ts
//
// LV95 (EPSG:2056): the repo has no WGS84 → LV95 transform (grepped 2026-09-28: no lv95/2056/CH1903 code),
// so no LV95 coordinates are written. Inside Switzerland the header says so; a caller that has a transform
// can pass `toLv95` and the origin is written in LV95 as well (positions stay ENU).
import type { Pose } from "#/lib/camera";
import { ANCHOR_LOW_TRUST } from "#/lib/nearfield/anchor";
import { filterForExport, provenanceOf } from "#/lib/nearfield/provenance";
import { encodeSplatV1, type GeoOrigin } from "#/lib/nearfield/splat-io";
import {
	ANCHOR_MIN_QUALITY,
	type GaussianCloud,
	type NearFieldScene,
	PROVENANCE_CODE,
	type Provenance,
} from "#/lib/nearfield/types";
import type { FormatDescriptor } from "#/lib/ontology/crosswalk/presentation";
import type { Renderer } from "#/lib/renderer";
import { resolveGeoidUndulation } from "./engine-export";

export type SplatExportKind = "splat-ply" | "splat-v1";

export type SplatExportFormat = FormatDescriptor<SplatExportKind>;

/** Menu entries (ExportMenu shows them only when the renderer has a near-field scene). */
export const SPLAT_EXPORT_FORMATS: SplatExportFormat[] = [
	{
		kind: "splat-ply",
		label: "Splats (.ply)",
		ext: ".enu.ply",
		mime: "application/octet-stream",
		hint: "3DGS · ENU metres, WGS84 origin",
	},
	{
		kind: "splat-v1",
		label: "Splats (.splat)",
		ext: ".splat-v1",
		mime: "application/octet-stream",
		hint: "Rigi splat-v1 · ENU + origin",
	},
];

export type LV95 = { E: number; N: number; H: number };

export type SplatExportMeta = {
	/** Renderer.frame lat/lon/h (h in the DEM datum, ≈ EGM2008 MSL). */
	origin: GeoOrigin;
	photoId?: string;
	/** Solved pose (deg). */
	pose?: Pose;
	/** Camera position in the ENU frame (m). */
	eye?: readonly [number, number, number];
	/** Model that produced the splats (e.g. "lift/moge-2-vitl-normal", "sharp-…"). Default: scene.model if present. */
	model?: string;
	/** Geoid undulation N (m): h_ellipsoid = h + N. Default 0 (MSL heights treated as ellipsoidal). */
	geoidUndulation?: number;
	/** WGS84 → LV95 transform, if the caller has one (the repo has none). Only the origin is converted. */
	toLv95?: (lat: number, lon: number, h: number) => LV95;
	/** ISO timestamp for the header (default now). */
	createdAt?: string;
};

export type SplatExportStats = {
	/** Splats in the scene. */
	total: number;
	/** Splats written. */
	kept: number;
	/** Written, per provenance. */
	counts: Record<Provenance, number>;
	/** Dropped `generated` splats. */
	droppedGenerated: number;
	/** Dropped splats with an unknown provenance code. */
	droppedUnknown: number;
};

export type SplatLicence = {
	/** false = research-only / non-commercial weights (SHARP): the file must not be used commercially. */
	commercial: boolean | null;
	note: string;
};

/** Licence posture of the model that made the splats (research_notes/step_inside_models_2026-09.md). */
export function splatLicence(model: string | undefined | null): SplatLicence {
	const m = (model ?? "").toLowerCase();
	if (m.includes("sharp"))
		return {
			commercial: false,
			note: "RESEARCH-ONLY: Apple SHARP weights (Apple ML Research Model License) - non-commercial research use only, not for any product or service",
		};
	if (m.includes("moge"))
		return {
			commercial: true,
			note: "MoGe-2 depth-lift: MIT (code + weights), DINOv2 backbone Apache-2.0",
		};
	if (/da3[-_]?(base|small)|depth-anything-3/.test(m))
		return {
			commercial: true,
			note: "Depth-Anything-3 Base/Small depth-lift: Apache-2.0",
		};
	if (m.includes("lift"))
		return {
			commercial: null,
			note: "depth-lift: licence follows the depth model named above",
		};
	return {
		commercial: null,
		note: "unknown model licence - verify before commercial use",
	};
}

/** Rough Swiss bounding box (LV95 domain), WGS84 degrees. A box, not the border: it also covers e.g. Chamonix. */
const inSwitzerland = (lat: number, lon: number) =>
	lat >= 45.8 && lat <= 47.9 && lon >= 5.9 && lon <= 10.6;

const emptyCounts = (): Record<Provenance, number> => ({
	observed: 0,
	reconstructed: 0,
	dem: 0,
	generated: 0,
});

/**
 * The cloud that may be exported: ENU only, `generated` / unknown codes removed (filterForExport), with
 * per-provenance counts. Throws for a camera-frame cloud (not georeferenced).
 */
export function exportableCloud(scene: NearFieldScene): {
	cloud: GaussianCloud;
	stats: SplatExportStats;
} {
	const src = scene.splats;
	if (src.frame !== "enu")
		throw new Error("splat export: scene splats are not in the ENU frame");
	let droppedGenerated = 0;
	let droppedUnknown = 0;
	for (let i = 0; i < src.count; i++) {
		const p = provenanceOf(src.provenance[i]);
		if (p === null) droppedUnknown++;
		else if (p === "generated") droppedGenerated++;
	}
	const cloud = filterForExport(src);
	const counts = emptyCounts();
	for (let i = 0; i < cloud.count; i++) {
		const p = provenanceOf(cloud.provenance[i]);
		if (p) counts[p]++;
	}
	return {
		cloud,
		stats: {
			total: src.count,
			kept: cloud.count,
			counts,
			droppedGenerated,
			droppedUnknown,
		},
	};
}

const f = (x: number, d: number) =>
	Number.isFinite(x) ? x.toFixed(d) : String(x);
/** PLY headers are ASCII lines: strip newlines and non-ASCII. */
const ascii = (s: string) =>
	s
		.replace(/[\r\n]+/g, " ")
		.replace(/[–—]/g, "-")
		.replace(/[^\x20-\x7e]/g, "?");

function sceneModel(scene: NearFieldScene, meta: SplatExportMeta) {
	return (
		meta.model ??
		(scene as NearFieldScene & { model?: string }).model ??
		"unknown"
	);
}

/** The header comment lines (without the "comment " prefix) for a scene export. */
function splatHeaderLines(
	scene: NearFieldScene,
	meta: SplatExportMeta,
	stats: SplatExportStats,
): string[] {
	const o = meta.origin;
	const N = meta.geoidUndulation ?? 0;
	const a = scene.anchor;
	const model = sceneModel(scene, meta);
	const lic = splatLicence(model);
	const L: string[] = [
		"Rigi Step Inside georeferenced Gaussian splats",
		`created ${meta.createdAt ?? new Date().toISOString()}`,
		`photo ${meta.photoId ?? scene.photoId}`,
		"frame ENU local tangent plane: x east, y north, z up, metres, float32, relative to origin",
		"origin_crs EPSG:4979 (WGS84 geographic 3D; lat/lon deg)",
		`origin_lat ${f(o.lat, 9)}`,
		`origin_lon ${f(o.lon, 9)}`,
		`origin_h_msl ${f(o.h, 3)} (DEM datum, Mapterhorn, orthometric ~ EGM2008)`,
		`geoid_undulation ${f(N, 3)}`,
		`origin_h_ellipsoid ${f(o.h + N, 3)}${N === 0 ? " (N=0: MSL height used as ellipsoidal, ~50 m low in the Alps)" : ""}`,
		"enu_z_note z includes the app's refraction/curvature term k=0.13 (EnuFrame.fromGeo); < 1 cm within 1 km",
	];
	if (meta.toLv95) {
		const c = meta.toLv95(o.lat, o.lon, o.h);
		L.push(
			"origin_lv95_crs EPSG:2056 (CH1903+/LV95) + LN02 height",
			`origin_lv95_E ${f(c.E, 3)}`,
			`origin_lv95_N ${f(c.N, 3)}`,
			`origin_lv95_H ${f(c.H, 3)}`,
			"lv95_note positions stay ENU; ENU north differs from LV95 grid north by the meridian convergence",
		);
	} else if (inSwitzerland(o.lat, o.lon))
		L.push(
			"lv95 not provided (origin in the Swiss LV95 box): no WGS84->LV95 (EPSG:2056) transform in this build; convert the origin with swisstopo REFRAME",
		);
	if (meta.pose)
		L.push(
			`pose_deg yaw ${f(meta.pose.yaw, 4)} pitch ${f(meta.pose.pitch, 4)} roll ${f(meta.pose.roll, 4)} vfov ${f(meta.pose.vfov, 4)}`,
		);
	if (meta.eye)
		L.push(
			`eye_enu ${f(meta.eye[0], 3)} ${f(meta.eye[1], 3)} ${f(meta.eye[2], 3)}`,
		);
	L.push(
		`anchor scale ${f(a.scale, 6)} shift ${f(a.shift, 3)} residualLog ${f(a.residualLog, 4)} inlierFrac ${f(a.inlierFrac, 3)} n ${a.n} maxRange ${f(a.maxRange, 1)}`,
		`anchor_quality ${f(a.quality, 3)} (${a.quality < ANCHOR_MIN_QUALITY ? `BELOW ${ANCHOR_MIN_QUALITY}: placement untrusted` : a.quality < ANCHOR_LOW_TRUST ? `low trust (below ${ANCHOR_LOW_TRUST})` : "ok"})`,
		"anchor_note depth scale fitted to the DEM; monocular depth compresses range, so placement is least reliable beyond ~150 m",
		`confidence_radius_m ${f(scene.confidenceRadius, 1)}`,
		`model ${model}`,
		`licence ${lic.note}`,
		`commercial_use ${lic.commercial === null ? "unverified" : lic.commercial ? "allowed" : "NOT ALLOWED (research-only weights)"}`,
		`provenance_counts observed ${stats.counts.observed} reconstructed ${stats.counts.reconstructed} dem ${stats.counts.dem} generated ${stats.counts.generated}`,
		`provenance_dropped generated ${stats.droppedGenerated} unknown ${stats.droppedUnknown} (generated content never enters measurement exports)`,
		`provenance_codes ${Object.entries(PROVENANCE_CODE)
			.map(([k, v]) => `${v}=${k}`)
			.join(" ")} (vertex property 'provenance')`,
		"colour SH degree 0: f_dc = (rgb/255 - 0.5) / 0.28209479; opacity = logit(alpha); scale = ln(metres); rot = w,x,y,z",
	);
	return L.map(ascii);
}

const SH_C0 = 0.28209479177387814;
const PLY_PROPS = [
	"x",
	"y",
	"z",
	"nx",
	"ny",
	"nz",
	"f_dc_0",
	"f_dc_1",
	"f_dc_2",
	"opacity",
	"scale_0",
	"scale_1",
	"scale_2",
	"rot_0",
	"rot_1",
	"rot_2",
	"rot_3",
];
const PLY_STRIDE = PLY_PROPS.length * 4 + 1; // + uchar provenance

/**
 * Standard 3DGS binary .ply of a cloud (positions as stored, i.e. ENU metres for an ENU cloud).
 * `comments` become `comment …` header lines. Readable by decodeGaussianPly and common 3DGS viewers.
 */
export function encodeGaussianPly(
	cloud: GaussianCloud,
	comments: string[] = [],
): ArrayBuffer {
	const n = cloud.count;
	const head = [
		"ply",
		"format binary_little_endian 1.0",
		...comments.map((c) => `comment ${ascii(c)}`),
		`element vertex ${n}`,
		...PLY_PROPS.map((p) => `property float ${p}`),
		"property uchar provenance",
		"end_header",
		"",
	].join("\n");
	const hb = new TextEncoder().encode(head);
	const buf = new ArrayBuffer(hb.length + n * PLY_STRIDE);
	new Uint8Array(buf).set(hb);
	const dv = new DataView(buf);
	let o = hb.length;
	const put = (x: number) => {
		dv.setFloat32(o, x, true);
		o += 4;
	};
	const P = cloud.positions;
	const S = cloud.scales;
	const R = cloud.rotations;
	const C = cloud.colors;
	for (let i = 0; i < n; i++) {
		put(P[3 * i]);
		put(P[3 * i + 1]);
		put(P[3 * i + 2]);
		put(0);
		put(0);
		put(0);
		for (let k = 0; k < 3; k++) put((C[4 * i + k] / 255 - 0.5) / SH_C0);
		const a = Math.min(1 - 1e-6, Math.max(1e-6, C[4 * i + 3] / 255));
		put(Math.log(a / (1 - a)));
		for (let k = 0; k < 3; k++) {
			const s = S[3 * i + k];
			put(Math.log(s > 1e-9 && Number.isFinite(s) ? s : 1e-9));
		}
		let w = R[4 * i];
		let x = R[4 * i + 1];
		let y = R[4 * i + 2];
		let z = R[4 * i + 3];
		const q = Math.hypot(w, x, y, z);
		if (q > 0 && Number.isFinite(q)) {
			w /= q;
			x /= q;
			y /= q;
			z /= q;
		} else {
			w = 1;
			x = y = z = 0;
		}
		put(w);
		put(x);
		put(y);
		put(z);
		dv.setUint8(o, cloud.provenance[i]);
		o += 1;
	}
	return buf;
}

export type SplatExportBuild = {
	bytes: ArrayBuffer;
	ext: string;
	mime: string;
	stats: SplatExportStats;
	notes: string[];
	/** The header comment lines (the .ply carries them; for .splat-v1 they are informational). */
	header: string[];
};

/** Build a georeferenced export of a scene. Always filtered through filterForExport. */
export function buildSplatExport(
	scene: NearFieldScene,
	kind: SplatExportKind,
	meta: SplatExportMeta,
): SplatExportBuild {
	const { cloud, stats } = exportableCloud(scene);
	const header = splatHeaderLines(scene, meta, stats);
	const fmt = SPLAT_EXPORT_FORMATS.find((x) => x.kind === kind);
	if (!fmt) throw new Error(`splat export: unknown kind ${kind}`);
	const notes: string[] = [`${stats.kept} splats`];
	if (stats.droppedGenerated)
		notes.push(`${stats.droppedGenerated} generated splats left out`);
	if (stats.droppedUnknown)
		notes.push(`${stats.droppedUnknown} unknown-provenance splats left out`);
	if (scene.anchor.quality < ANCHOR_MIN_QUALITY)
		notes.push(
			`anchor quality ${scene.anchor.quality.toFixed(2)}: placement untrusted`,
		);
	const lic = splatLicence(sceneModel(scene, meta));
	if (lic.commercial === false)
		notes.push("research-only model: no commercial use");
	if (!meta.toLv95 && inSwitzerland(meta.origin.lat, meta.origin.lon))
		notes.push("no LV95 (not available in this build)");
	if (kind === "splat-v1")
		notes.push("origin h is the DEM (MSL) height; splat-v1 has no datum field");
	const bytes =
		kind === "splat-ply"
			? encodeGaussianPly(cloud, header)
			: encodeSplatV1(cloud, meta.origin);
	return { bytes, ext: fmt.ext, mime: fmt.mime, stats, notes, header };
}

// ---- engine glue ----

type NearFieldSceneSource =
	| NearFieldScene
	| null
	| undefined
	| (() => NearFieldScene | null | undefined);

/**
 * The renderer's current near-field scene, if Step Inside built one. Reads an optional `nearFieldScene`
 * (property or getter function) or `getNearFieldScene()` on the engine; null when the feature is off.
 */
export function engineNearFieldScene(
	engine: Renderer | null | undefined,
): NearFieldScene | null {
	if (!engine) return null;
	const e = engine as unknown as {
		nearFieldScene?: NearFieldSceneSource;
		getNearFieldScene?: () => NearFieldScene | null | undefined;
	};
	let s: NearFieldSceneSource;
	try {
		s =
			typeof e.getNearFieldScene === "function"
				? e.getNearFieldScene()
				: e.nearFieldScene;
		if (typeof s === "function") s = s();
	} catch {
		return null;
	}
	return s?.splats && s.splats.count > 0 ? s : null;
}

/** Export the engine's near-field scene. Throws when there is none or it belongs to another photo. */
export function exportSplatsFromEngine(
	engine: Renderer,
	kind: SplatExportKind,
	opts: Pick<SplatExportMeta, "geoidUndulation" | "model" | "toLv95"> & {
		scene?: NearFieldScene | null;
	} = {},
): { blob: Blob; filename: string; notes: string[] } {
	const scene = opts.scene ?? engineNearFieldScene(engine);
	if (!scene) throw new Error("no near-field scene (Step Inside is off)");
	if (scene.photoId && engine.photo?.id && scene.photoId !== engine.photo.id)
		throw new Error("near-field scene belongs to another photo");
	const r = buildSplatExport(scene, kind, {
		origin: { lat: engine.frame.lat, lon: engine.frame.lon, h: engine.frame.h },
		photoId: engine.photo?.id ?? scene.photoId,
		pose: { ...engine.pose },
		eye: [engine.eye.x, engine.eye.y, engine.eye.z],
		model: opts.model,
		geoidUndulation: resolveGeoidUndulation(engine, opts.geoidUndulation),
		toLv95: opts.toLv95,
	});
	return {
		blob: new Blob([r.bytes], { type: r.mime }),
		filename: `${engine.photo?.id ?? scene.photoId}${r.ext}`,
		notes: r.notes,
	};
}
