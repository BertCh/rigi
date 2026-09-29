// WP-G client: render → re-match loop service (tools/concord/rematch/server.py, default :8768).
// Separate from src/lib/matcher-client.ts (the :8765 escalation service), which is not edited.
//
// Frames: `cam.eye` and every returned `world` are in the ENU frame anchored at `frameOrigin`
// (src/lib/geodesy.ts EnuFrame convention). Without `frameOrigin` it is the engine's frame for the
// photo (photo lat/lon, h = 0), so an engine-side caller passes the engine eye as-is.
import type { CameraX, Cue, Vec3 } from "../core";

export type RematchRequest = {
	photo: Blob;
	cam: CameraX;
	lat: number;
	lon: number;
	tiles?: 4 | 6;
	iterations?: 1 | 2 | 3;
	mask?: boolean;
	/** Additive: bundled photo id (required by service v0.1; ad-hoc photos are not supported yet). */
	photoId?: string;
	/** Additive: origin of the frame of cam.eye / world (default: engine frame, photo lat/lon, h 0). */
	frameOrigin?: { lat: number; lon: number; alt: number };
	/** Additive: "drop" (default; classed keypoints removed) or "lift" (buildings/forest raised by their height, glacier dropped; worse on dev, see tools/concord/rematch/RESULT.txt). */
	maskMode?: "lift" | "drop";
	/** Additive: nearest lifted terrain (m, default 100). */
	minRangeM?: number;
	/** Additive: keypoints per image (default 2048). */
	maxKp?: number;
	/** Additive: service base URL (default VITE_CONCORD_REMATCH_URL or http://localhost:8768). */
	url?: string;
	signal?: AbortSignal;
};

export type RematchInlier = {
	u: number;
	v: number;
	ur: number;
	vr: number;
	world: Vec3;
	/** Residual (px @1600) under the returned refined camera (eye fixed at cam.eye). */
	resPx: number;
	cls?: string;
	/** Additive: horizontal distance from cam.eye (m). */
	depthM?: number;
	/** Additive: object height the mask applies (or would apply) at this point (m; 0 = bare ground). */
	liftM?: number;
	iter?: number;
	view?: string;
};

export type RematchIteration = {
	n: number;
	medPx: number;
	coverage: { quadrants: number; bands: number };
	/** Additive fields. */
	nMatches?: number;
	nLower?: number;
	views?: number;
	perView?: Record<string, number>;
	changePx?: number;
	ms?: number;
	mask?: Record<string, unknown>;
};

export type RematchResult = {
	iterations: RematchIteration[];
	inliers: RematchInlier[];
	/** Additive: refined camera (rotation only; eye and intrinsics as given). */
	cam?: CameraX;
	renderEye?: Vec3;
	timingMs?: Record<string, number>;
	notes?: string[];
	version?: string;
};

const DEFAULT_URL: string =
	(import.meta as { env?: Record<string, string | undefined> }).env
		?.VITE_CONCORD_REMATCH_URL ?? "http://localhost:8768";

export async function rematch(req: RematchRequest): Promise<RematchResult> {
	const { photo, url, signal, ...rest } = req;
	const body = new FormData();
	body.append("photo", photo, "photo.jpg");
	body.append(
		"request",
		JSON.stringify({
			...rest,
			tiles: rest.tiles ?? 6,
			iterations: rest.iterations ?? 2,
			mask: rest.mask ?? false,
		}),
	);
	const res = await fetch(`${url ?? DEFAULT_URL}/rematch`, {
		method: "POST",
		body,
		signal,
	});
	const j = (await res.json()) as
		| (RematchResult & { ok: true })
		| { ok: false; error: { code: string; message: string } };
	if (!res.ok || !j.ok) {
		const e = (j as { error?: { code: string; message: string } }).error;
		throw new Error(
			`rematch ${res.status}: ${e?.code ?? "error"} ${e?.message ?? ""}`,
		);
	}
	return j;
}

/**
 * Inliers → "point" cues. σ = sigmaPx (default 2 px @1600, the render-match localisation noise at
 * 1024-px renders) inflated by the inlier's own residual spread is left to the solver; objects lifted
 * by the mask get σ × 2 (height uncertain).
 */
export function inliersToCues(r: RematchResult, sigmaPx = 2): Cue[] {
	return r.inliers.map((p) => ({
		kind: "point" as const,
		u: p.u,
		v: p.v,
		world: p.world,
		depthM: p.depthM ?? Math.hypot(p.world[0], p.world[1]),
		sigmaPx: p.liftM ? sigmaPx * 2 : sigmaPx,
		source: `rematch${p.cls ? `:${p.cls}` : ""}`,
	}));
}
