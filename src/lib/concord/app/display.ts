// Browser-side concordance display pass (integration of WP-C cues → WP-E warp, and WP-F occluder), run
// by PhotoWorkspace once the pose is FINAL (after the second opinion) and only under ?concord=warp and/or
// ?concord=occl. Display-only: it never touches pose, confidence, pins, benchmarks or exports' measurements
// (it only calls Renderer.setWarp / setOccluder). At LOW confidence it clears both and computes nothing.
//
// Geometry comes from the renderer's own geometry readback (sampleAt: world xyz + range per photo uv at
// the current pose and eye), so cues and the occluder live in the engine frame exactly (EnuFrame at the
// photo, h = 0; eye = renderer.eye). Photo edges are computed from the shown photo (WP-C
// photoEdgesFromRGBA, people suppressed with maskEdges). No lakes: water cues need OSM water polygons,
// which the app does not load (WP-C used cached Overpass results); contour cues only.
import type { Renderer } from "../../renderer";
import { type CameraX, IDENTITY_INTRINSICS, type Vec3 } from "../core";
import {
	extractCues,
	type GeomBuffer,
	type MatchedCue,
	maskEdges,
	photoEdgesFromRGBA,
} from "../cues";
import {
	displayField,
	type FieldCue,
	isLowConfidence,
	type PoseConfidence,
} from "../field";
import type { ConcordFlags } from "../flags";
import { loadNearDsm } from "../occl/ndsm";
import { occludedBy, occluderRange } from "../occl/occluder";

type Host = Pick<
	Renderer,
	| "photo"
	| "aspect"
	| "pose"
	| "eye"
	| "photoElement"
	| "sampleAt"
	| "isForeground"
	| "readback"
	| "setWarp"
	| "setOccluder"
>;

export type ConcordDisplayReport = {
	warp: null | {
		applied: boolean;
		cues: number;
		predicted: number;
		maxAbsPx: number;
		looGainPx: number | null;
		reason?: string;
		ms: number;
	};
	occl: null | {
		applied: boolean;
		dimmedFrac: number;
		bytes?: number;
		reason?: string;
		ms: number;
	};
	refused?: string;
};

const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 0));

const camOf = (h: Host): CameraX => ({
	pose: { ...h.pose },
	eye: [h.eye.x, h.eye.y, h.eye.z] as Vec3,
	aspect: h.aspect,
	intr: { ...IDENTITY_INTRINSICS },
});

/** Photo-uv grid (row 0 = top, cell-centred) of the renderer's geometry readback, in WP-C's shape. */
function geomFromRenderer(h: Host, w: number, hh: number): GeomBuffer {
	const n = w * hh;
	const xyz = new Float32Array(3 * n).fill(Number.NaN);
	const range = new Float32Array(n).fill(Number.POSITIVE_INFINITY);
	const sky = new Uint8Array(n).fill(1);
	for (let j = 0; j < hh; j++)
		for (let i = 0; i < w; i++) {
			const s = h.sampleAt((i + 0.5) / w, (j + 0.5) / hh);
			if (!s) continue;
			const k = j * w + i;
			xyz[3 * k] = s.world[0];
			xyz[3 * k + 1] = s.world[1];
			xyz[3 * k + 2] = s.world[2];
			range[k] = s.range;
			sky[k] = 0;
		}
	const eye: Vec3 = [h.eye.x, h.eye.y, h.eye.z];
	return {
		w,
		h: hh,
		xyz,
		range,
		sky,
		eye,
		cast: (u, v) => {
			const s = h.sampleAt(u, v);
			if (!s) return null;
			return {
				d: Math.hypot(s.world[0] - eye[0], s.world[1] - eye[1]),
				range: s.range,
				world: s.world,
			};
		},
	};
}

function peopleGrid(h: Host, w: number, hh: number): Uint8Array {
	const m = new Uint8Array(w * hh);
	for (let j = 0; j < hh; j++)
		for (let i = 0; i < w; i++)
			if (h.isForeground((i + 0.5) / w, (j + 0.5) / hh)) m[j * w + i] = 255;
	return m;
}

function photoRGBA(img: HTMLImageElement, w: number, hh: number) {
	const c =
		typeof OffscreenCanvas !== "undefined"
			? new OffscreenCanvas(w, hh)
			: Object.assign(document.createElement("canvas"), {
					width: w,
					height: hh,
				});
	const ctx = c.getContext("2d") as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D
		| null;
	if (!ctx) return null;
	ctx.drawImage(img, 0, 0, w, hh);
	return ctx.getImageData(0, 0, w, hh).data;
}

/**
 * WP-C edge cues carry the PREDICTED photo position; WP-E's field wants the cue at the OBSERVED position
 * (residual = predicted − observed, px @1600 along the normal). Level / shore cues are already observed.
 */
export function toFieldCues(cues: MatchedCue[], aspect: number): FieldCue[] {
	const W = aspect >= 1 ? 1600 : 1600 * aspect;
	const H = aspect >= 1 ? 1600 / aspect : 1600;
	return cues.map((c) =>
		c.kind === "edge"
			? {
					...c,
					u: c.u - (c.residualPx * c.nu) / W,
					v: c.v - (c.residualPx * c.nv) / H,
				}
			: c,
	);
}

/**
 * Compute and apply the display warp / occluder for the renderer's current (final) pose. Clears both when
 * the confidence is LOW. Abortable: a newer pose (signal aborted) discards the result before it is applied.
 */
export async function runConcordDisplay(
	host: Host,
	confidence: PoseConfidence | null,
	flags: Pick<ConcordFlags, "warp" | "occl">,
	signal?: AbortSignal,
): Promise<ConcordDisplayReport> {
	const out: ConcordDisplayReport = { warp: null, occl: null };
	if (!flags.warp && !flags.occl) return out;
	if (isLowConfidence(confidence)) {
		host.setWarp?.(null);
		host.setOccluder?.(null);
		out.refused = "pose confidence LOW";
		return out;
	}
	const ok = await host.readback();
	if (!ok || signal?.aborted) return out;
	const cam = camOf(host);

	if (flags.warp) {
		const t0 = performance.now();
		const long = 640;
		const gw = cam.aspect >= 1 ? long : Math.round(long * cam.aspect);
		const gh = Math.round(gw / cam.aspect);
		const geom = geomFromRenderer(host, gw, gh);
		const people = peopleGrid(host, gw, gh);
		await yieldFrame();
		const img = host.photoElement;
		const ew = cam.aspect >= 1 ? 1600 : Math.round(1600 * cam.aspect);
		const eh = Math.round(ew / cam.aspect);
		const rgba = img ? photoRGBA(img, ew, eh) : null;
		if (signal?.aborted) return out;
		if (!rgba) {
			out.warp = {
				applied: false,
				cues: 0,
				predicted: 0,
				maxAbsPx: 0,
				looGainPx: null,
				reason: "no photo pixels",
				ms: performance.now() - t0,
			};
		} else {
			const edges = maskEdges(
				photoEdgesFromRGBA(rgba, ew, eh),
				{
					width: gw,
					height: gh,
					data: people,
				},
				255,
			);
			await yieldFrame();
			if (signal?.aborted) return out;
			const r = extractCues({ geom, cam, edges });
			await yieldFrame();
			if (signal?.aborted) return out;
			const field = displayField(
				confidence,
				toFieldCues(r.cues, cam.aspect),
				{ w: gw, h: gh, rangeM: geom.range, people },
				cam,
			);
			if (signal?.aborted) return out;
			host.setWarp?.(field);
			out.warp = {
				applied: !!field,
				cues: r.cues.length,
				predicted: r.stats.predicted,
				maxAbsPx: field?.maxAbsPx ?? 0,
				looGainPx: field?.provenance.looGainPx ?? null,
				reason: field ? undefined : "no field (no cues or zero)",
				ms: performance.now() - t0,
			};
		}
	}

	if (flags.occl) {
		const t0 = performance.now();
		const hfov =
			(2 *
				Math.atan(Math.tan((cam.pose.vfov * Math.PI) / 360) * cam.aspect) *
				180) /
			Math.PI;
		let reason: string | undefined;
		const dsm = await loadNearDsm(host.photo.lat, host.photo.lon, 2000, 2, {
			wedge: { yawDeg: cam.pose.yaw, halfDeg: hfov / 2 + 10 },
			signal,
		}).catch((e) => {
			reason = `surface model load failed: ${(e as Error)?.message ?? e}`;
			return null;
		});
		if (signal?.aborted) return out;
		if (!dsm) {
			host.setOccluder?.(null);
			out.occl = {
				applied: false,
				dimmedFrac: 0,
				reason: reason ?? "no surface model here (Switzerland only)",
				ms: performance.now() - t0,
			};
		} else {
			// 160×120 on the main thread (WP-F: 40–55 ms); the mask is photo-space, row 0 = top
			const ow = cam.aspect >= 1 ? 160 : Math.round(160 * cam.aspect);
			const oh = Math.round(ow / cam.aspect);
			const g = geomFromRenderer(host, ow, oh);
			const o = occluderRange(g, cam, dsm);
			const data = new Uint8Array(ow * oh);
			let dim = 0;
			let terrain = 0;
			for (let k = 0; k < data.length; k++) {
				if (g.sky[k]) continue;
				terrain++;
				if (occludedBy(g.range[k], o[k])) {
					data[k] = 255;
					dim++;
				}
			}
			if (signal?.aborted) return out;
			host.setOccluder?.(dim ? { width: ow, height: oh, data } : null);
			out.occl = {
				applied: dim > 0,
				dimmedFrac: terrain ? dim / terrain : 0,
				bytes: dsm.stats.bytes,
				ms: performance.now() - t0,
			};
		}
	}
	return out;
}
