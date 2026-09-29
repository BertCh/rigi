// One-call cue extraction (WP-C): occluding contours matched to photo edges + water level/shore cues.
// CPU-only; the GeomBuffer comes from a GPU render readback or from raycast.ts buildGeomBuffer.
import type { CameraX, Cue } from "../core";
import { type ContourOpts, occludingContourCuesX } from "./contours";
import { type MatchOpts, matchEdgeCues } from "./edge-dt";
import type { EdgeCue, GeomBuffer, MatchedCue, PhotoEdges } from "./types";
import { type Lake, type WaterCue, type WaterOpts, waterCuesX } from "./water";

export type ExtractInput = {
	geom: GeomBuffer;
	cam: CameraX;
	edges: PhotoEdges;
	lakes?: Lake[];
	/** Soft photo water mask at GeomBuffer resolution (1 = water), or null ⇒ photo edges. */
	photoWater?: Float32Array | null;
};

export type ExtractOpts = {
	contour?: ContourOpts;
	match?: MatchOpts;
	water?: WaterOpts;
	/** Matched cues below this confidence are dropped. Default 0.25. */
	minConf?: number;
	/** Neighbour-consistency filter (null = off). */
	consistency?: ConsistencyOpts | null;
};

export type ConsistencyOpts = {
	/** Neighbour radius, px @1600. Default 32. */
	radiusPx?: number;
	/** Minimum consistent neighbours. Default 2. */
	minNb?: number;
	/** Max |residual − neighbour median|, px. Default 2. */
	tolPx?: number;
};

/**
 * Keep a matched cue only if ≥ minNb neighbours of the same kind (within radiusPx, normals within
 * ~45°, depth ratio < 1.5) exist and its residual is within tolPx of their median. Photo occluders
 * (people, trees, buildings) cross predicted contours at random offsets; true contours give a
 * smoothly varying offset along their length.
 */
export function consistencyFilter<T extends MatchedCue>(
	cues: T[],
	aspect: number,
	o: ConsistencyOpts = {},
): T[] {
	const R = o.radiusPx ?? 32;
	const minNb = o.minNb ?? 2;
	const tol = o.tolPx ?? 2;
	const W = aspect >= 1 ? 1600 : 1600 * aspect;
	const H = aspect >= 1 ? 1600 / aspect : 1600;
	const nrm = (c: MatchedCue) => (c.kind === "edge" ? [c.nu, c.nv] : [0, 1]);
	return cues.filter((c) => {
		const [a0, a1] = nrm(c);
		const rs: number[] = [];
		for (const q of cues) {
			if (q === c || q.kind !== c.kind) continue;
			if (Math.hypot((q.u - c.u) * W, (q.v - c.v) * H) > R) continue;
			const [b0, b1] = nrm(q);
			if (Math.abs(a0 * b0 + a1 * b1) < 0.7) continue;
			if (Math.abs(Math.log(q.depthM / c.depthM)) > Math.log(1.5)) continue;
			rs.push(q.residualPx);
		}
		if (rs.length < minNb) return false;
		rs.sort((x, y) => x - y);
		const m =
			rs.length % 2
				? rs[rs.length >> 1]
				: (rs[rs.length / 2 - 1] + rs[rs.length / 2]) / 2;
		return Math.abs(c.residualPx - m) <= tol;
	});
}

export type ExtractResult = {
	/** Matched cues, sigmaPx inflated by 1/conf: edge (contours), level and shore. */
	cues: MatchedCue[];
	/** All predicted contour cues (matched or not), for audits. */
	predicted: EdgeCue[];
	water: {
		predicted: { u: number; v: number; lake: number; d: number }[];
		polarity: number;
	};
	stats: {
		predicted: number;
		matched: number;
		confident: number;
		kept: number;
		water: number;
	};
};

const inflate = <T extends Cue & { conf: number }>(c: T): T => ({
	...c,
	sigmaPx: Math.hypot(c.sigmaPx, 1 / Math.max(c.conf, 0.1)),
});

export function extractCues(
	inp: ExtractInput,
	opts: ExtractOpts = {},
): ExtractResult {
	const minConf = opts.minConf ?? 0.25;
	const { cues: predicted } = occludingContourCuesX(
		inp.geom,
		inp.cam,
		opts.contour,
	);
	const matched = matchEdgeCues(predicted, inp.edges, {
		polarity: "auto",
		...opts.match,
	});
	const cons = opts.consistency === undefined ? {} : opts.consistency;
	const confident = matched.filter((c) => c.conf >= minConf);
	const kept = (
		cons ? consistencyFilter(confident, inp.cam.aspect, cons) : confident
	).map(inflate);
	let water: WaterCue[] = [];
	let wp: ExtractResult["water"] = { predicted: [], polarity: 0 };
	if (inp.lakes?.length) {
		const r = waterCuesX(inp.geom, inp.cam, inp.lakes, inp.photoWater ?? null, {
			edges: inp.edges,
			...opts.water,
		});
		const wc = r.cues.filter((c) => c.conf >= minConf);
		water = (cons ? consistencyFilter(wc, inp.cam.aspect, cons) : wc).map(
			inflate,
		);
		wp = { predicted: r.predicted, polarity: r.polarity };
	}
	return {
		cues: [...kept, ...water],
		predicted,
		water: wp,
		stats: {
			predicted: predicted.length,
			matched: matched.length,
			confident: confident.length,
			kept: kept.length,
			water: water.length,
		},
	};
}
