// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The learned back surface for src/lib/nearfield/complete/people.ts: ViTPose keypoints (./vitpose.ts, nn) + an Anny
// body (./anny.ts) fitted per person (./fit.ts), rasterised into the people grid as the mesh's far surface (./raster.ts).
//
// people.ts calls its BackDepthProvider synchronously per instance, so the work is split:
//   const boxes = boxesFromInstances(firstPass.instances, firstPass.gridWidth, firstPass.gridHeight);
//   const body = await prepareBodyBackDepth({ nn, image, boxes });   // async: weights, one ViTPose forward per box
//   completePeople(input, { backDepth: body.backDepth });            // sync: fit (CPU) + raster per instance
// The boxes can come from a first inflation-only completePeople pass (above) or from the people mask. Each instance
// takes the keypoints of the box it overlaps most (IoU ≥ 0.2); no match, too few keypoints or a failed fit → null
// (people.ts keeps the inflation). `body.fits` records what each call did (for overlays and evidence).
import type {
	BackDepthProvider,
	PersonGridInstance,
} from "#/lib/nearfield/complete/people";
import type { Nn } from "#/lib/nn";
import { type BodyModel, loadAnny } from "./anny";
import { type BodyFit, type BodyFitOptions, fitBody } from "./fit";
import { rasterDepthRange } from "./raster";
import {
	type PersonBox,
	type PersonKeypoints,
	type RgbaImage,
	VitPose,
} from "./vitpose";

export type BodyFitRecord = {
	/** index into `keypoints` of the person used, −1 when no box matched */
	person: number;
	fit: BodyFit | null;
	/** cells of the instance covered by the mesh, and nearby cells given its thickness */
	covered: number;
	filled: number;
	/** median (front z − mesh near z) over the instance, added to the back (m) */
	offsetM: number;
	ms: number;
};

export type BodyBackDepth = {
	backDepth: BackDepthProvider;
	keypoints: PersonKeypoints[];
	/** one record per provider call, in call order */
	fits: BodyFitRecord[];
};

export type BodyBackDepthOptions = BodyFitOptions & {
	/** Minimum IoU between an instance's grid bbox and a person box. Default 0.2. */
	minIoU?: number;
	/** Bound on the depth offset that aligns the mesh's front to the observed front (m). Default 0.1. */
	maxOffsetM?: number;
};

/** People-grid instance bboxes (inclusive cells) → photo-normalised person boxes. */
export function boxesFromInstances(
	instances: readonly { bbox: readonly [number, number, number, number] }[],
	gridWidth: number,
	gridHeight: number,
): PersonBox[] {
	return instances.map(({ bbox: [i0, j0, i1, j1] }) => ({
		x: i0 / gridWidth,
		y: j0 / gridHeight,
		w: (i1 - i0 + 1) / gridWidth,
		h: (j1 - j0 + 1) / gridHeight,
	}));
}

function iou(a: PersonBox, b: PersonBox): number {
	const x0 = Math.max(a.x, b.x);
	const y0 = Math.max(a.y, b.y);
	const x1 = Math.min(a.x + a.w, b.x + b.w);
	const y1 = Math.min(a.y + a.h, b.y + b.h);
	const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
	return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

/**
 * Back z per grid cell of one instance from a fitted body: the mesh's far surface where it covers a cell. Instance
 * cells the mesh misses (hair, loose clothing, mask slop) within `fillRadiusCells` of a covered cell take that cell's
 * thickness (far − observed front), capped by their own inflation thickness, so the two back surfaces meet without a
 * step; further out they stay NaN (people.ts keeps the inflation).
 */
export function backDepthFromFit(
	fit: BodyFit,
	model: BodyModel,
	instance: PersonGridInstance,
	maxOffsetM = 0.1,
	fillRadiusCells = 6,
): { back: Float32Array; covered: number; filled: number; offsetM: number } {
	const { gridWidth: GW, gridHeight: GH } = instance;
	const range = rasterDepthRange(fit.vertices, model.faces, instance.K, GW, GH);
	const diffs: number[] = [];
	for (const k of instance.cells) {
		const zf = instance.frontZ[k];
		if (Number.isFinite(zf) && Number.isFinite(range.near[k]))
			diffs.push(zf - range.near[k]);
	}
	diffs.sort((a, b) => a - b);
	const offsetM = diffs.length
		? Math.max(-maxOffsetM, Math.min(maxOffsetM, diffs[diffs.length >> 1]))
		: 0;
	const back = new Float32Array(GW * GH).fill(Number.NaN);
	let covered = 0;
	// thickness of covered cells, then a breadth-first spread into the uncovered instance cells
	const thick = new Float32Array(GW * GH).fill(Number.NaN);
	const dist = new Int32Array(GW * GH).fill(-1);
	const inside = new Uint8Array(GW * GH);
	for (const k of instance.cells) inside[k] = 1;
	let queue: number[] = [];
	for (const k of instance.cells) {
		const z = range.far[k];
		if (!Number.isFinite(z)) continue;
		back[k] = z + offsetM;
		covered++;
		const zf = instance.frontZ[k];
		if (Number.isFinite(zf)) {
			thick[k] = Math.max(0.02, back[k] - zf);
			dist[k] = 0;
			queue.push(k);
		}
	}
	let filled = 0;
	for (let d = 1; d <= fillRadiusCells && queue.length; d++) {
		const next: number[] = [];
		for (const q of queue) {
			const i = q % GW;
			const j = (q - i) / GW;
			for (const [di, dj] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			]) {
				const ii = i + di;
				const jj = j + dj;
				if (ii < 0 || jj < 0 || ii >= GW || jj >= GH) continue;
				const k = jj * GW + ii;
				if (!inside[k] || dist[k] >= 0) continue;
				dist[k] = d;
				thick[k] = thick[q];
				next.push(k);
				const zf = instance.frontZ[k];
				if (!Number.isFinite(zf)) continue;
				const infl = instance.inflatedBackZ[k];
				const t = Number.isFinite(infl)
					? Math.min(thick[k], Math.max(0.02, infl - zf))
					: thick[k];
				back[k] = zf + t;
				filled++;
			}
		}
		queue = next;
	}
	return { back, covered, filled, offsetM };
}

/** The synchronous provider over keypoints already computed (see the file comment). */
export function createBodyBackDepth(
	model: BodyModel,
	keypoints: PersonKeypoints[],
	options: BodyBackDepthOptions = {},
): BodyBackDepth {
	const fits: BodyFitRecord[] = [];
	const minIoU = options.minIoU ?? 0.2;
	const backDepth: BackDepthProvider = (instance) => {
		const t0 = performance.now();
		const { gridWidth: GW, gridHeight: GH } = instance;
		let i0 = GW;
		let j0 = GH;
		let i1 = 0;
		let j1 = 0;
		for (const k of instance.cells) {
			const i = k % GW;
			const j = (k - i) / GW;
			i0 = Math.min(i0, i);
			i1 = Math.max(i1, i);
			j0 = Math.min(j0, j);
			j1 = Math.max(j1, j);
		}
		const [box] = boxesFromInstances([{ bbox: [i0, j0, i1, j1] }], GW, GH);
		let person = -1;
		let bestIoU = minIoU;
		keypoints.forEach((p, i) => {
			const s = iou(box, p.box);
			if (s >= bestIoU) {
				bestIoU = s;
				person = i;
			}
		});
		const record: BodyFitRecord = {
			person,
			fit: null,
			covered: 0,
			filled: 0,
			offsetM: 0,
			ms: 0,
		};
		fits.push(record);
		if (person < 0) return null;
		const fit = fitBody(
			model,
			instance.K,
			keypoints[person],
			{
				gridWidth: GW,
				gridHeight: GH,
				cells: instance.cells,
				frontZ: instance.frontZ,
			},
			options,
		);
		record.fit = fit;
		if (!fit) {
			record.ms = performance.now() - t0;
			return null;
		}
		const r = backDepthFromFit(fit, model, instance, options.maxOffsetM);
		record.covered = r.covered;
		record.filled = r.filled;
		record.offsetM = r.offsetM;
		record.ms = performance.now() - t0;
		return r.covered ? r.back : null;
	};
	return { backDepth, keypoints, fits };
}

/** Load the nets (unless given), run ViTPose once per box, and return the synchronous provider. */
export async function prepareBodyBackDepth(args: {
	nn: Nn;
	image: RgbaImage;
	boxes: readonly PersonBox[];
	model?: BodyModel;
	vitpose?: VitPose;
	options?: BodyBackDepthOptions;
}): Promise<BodyBackDepth> {
	const model = args.model ?? (await loadAnny());
	const net = args.vitpose ?? (await VitPose.load(args.nn));
	try {
		const keypoints = await net.run(args.image, args.boxes);
		return createBodyBackDepth(model, keypoints, args.options);
	} finally {
		if (!args.vitpose) net.dispose();
	}
}
