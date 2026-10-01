// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Browser-side concordance display pass (WP-F DSM occluder), run by PhotoWorkspace once the pose is
// FINAL (after the second opinion) and only under ?concord=occl. Display-only: it never touches pose,
// confidence, pins, benchmarks or exports' measurements (it only calls Renderer.setOccluder). At LOW
// confidence it clears the occluder and computes nothing. (The WP-E display warp that also ran here was
// removed on 2026-09-30: reports/negative-results.md.)
//
// Geometry comes from the renderer's own geometry readback (sampleAt: world xyz + range per photo uv at
// the current pose and eye), so the occluder lives in the engine frame exactly (EnuFrame at the photo,
// h = 0; eye = renderer.eye).
import { hfovFromAspect } from "../../camera";
import type { Renderer } from "../../renderer";
import { type CameraX, IDENTITY_INTRINSICS, type Vec3 } from "../core";
import type { GeomBuffer } from "../cues";
import type { ConcordFlags } from "../flags";
import { loadNearDsm } from "../occl/ndsm";
import { occludedBy, occluderRange } from "../occl/occluder";
import { isLowConfidence, type PoseConfidence } from "./confidence";

type Host = Pick<
	Renderer,
	"photo" | "aspect" | "pose" | "eye" | "sampleAt" | "readback" | "setOccluder"
>;

export type ConcordDisplayReport = {
	occl: null | {
		applied: boolean;
		dimmedFrac: number;
		bytes?: number;
		reason?: string;
		ms: number;
	};
	refused?: string;
};

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

/**
 * Compute and apply the DSM occluder for the renderer's current (final) pose. Clears it when the
 * confidence is LOW. Abortable: a newer pose (signal aborted) discards the result before it is applied.
 */
export async function runConcordDisplay(
	host: Host,
	confidence: PoseConfidence | null,
	flags: Pick<ConcordFlags, "occl">,
	signal?: AbortSignal,
): Promise<ConcordDisplayReport> {
	const out: ConcordDisplayReport = { occl: null };
	if (!flags.occl) return out;
	if (isLowConfidence(confidence)) {
		host.setOccluder?.(null);
		out.refused = "pose confidence LOW";
		return out;
	}
	const ok = await host.readback();
	if (!ok || signal?.aborted) return out;
	const cam = camOf(host);

	if (flags.occl) {
		const t0 = performance.now();
		const hfov = hfovFromAspect(cam.pose.vfov, cam.aspect);
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
