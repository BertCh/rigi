// Step Inside: back-to-front depth sort for Gaussian splats (reports/step-inside-design.md).
// Runs as a module worker (splat-sort.ts owns it); `sortSplatsByDepth` is also imported directly
// by splat-sort.ts as the synchronous fallback, so this file must stay free of top-level side
// effects outside a worker scope.

/** Row 2 of the modelView matrix: view-space z = a*x + b*y + c*z + d (three: camera looks down -z). */
export type DepthRow = readonly [number, number, number, number];

export type SortScratch = { keys: Uint32Array; counts: Uint32Array };

export const newSortScratch = (count: number): SortScratch => ({
	keys: new Uint32Array(count),
	counts: new Uint32Array(65536),
});

/**
 * 16-bit counting sort of splats by view depth, farthest first. Splats at or behind the camera
 * plane (view z >= -near) are dropped. Writes the order into `out` and returns how many were kept.
 */
export function sortSplatsByDepth(
	positions: Float32Array,
	count: number,
	row: DepthRow,
	out: Uint32Array,
	scratch: SortScratch = newSortScratch(count),
	near = 0,
): number {
	const [a, b, c, d] = row;
	const keys = scratch.keys;
	const counts = scratch.counts;
	// pass 1: depth (distance in front of the camera, positive) and range
	let minD = Number.POSITIVE_INFINITY;
	let maxD = Number.NEGATIVE_INFINITY;
	const depth = new Float32Array(keys.buffer, 0, count); // reuse the key buffer as float storage
	let kept = 0;
	for (let i = 0; i < count; i++) {
		const j = 3 * i;
		const dist = -(
			a * positions[j] +
			b * positions[j + 1] +
			c * positions[j + 2] +
			d
		);
		if (dist > near) {
			depth[i] = dist;
			if (dist < minD) minD = dist;
			if (dist > maxD) maxD = dist;
			kept++;
		} else depth[i] = -1;
	}
	if (kept === 0) return 0;
	// pass 2: 16-bit keys, larger key = nearer, so ascending key order is back to front
	counts.fill(0);
	const span = maxD - minD;
	const k = span > 0 ? 65535 / span : 0;
	for (let i = 0; i < count; i++) {
		const dist = depth[i];
		if (dist < 0) {
			keys[i] = 0xffffffff;
			continue;
		}
		const key = Math.min(65535, ((maxD - dist) * k) | 0);
		keys[i] = key;
		counts[key]++;
	}
	// prefix sums → start offsets
	let acc = 0;
	for (let i = 0; i < 65536; i++) {
		const n = counts[i];
		counts[i] = acc;
		acc += n;
	}
	for (let i = 0; i < count; i++) {
		const key = keys[i];
		if (key === 0xffffffff) continue;
		out[counts[key]++] = i;
	}
	return kept;
}

// ---- worker protocol ----
export type SortRequest =
	| { type: "init"; positions: Float32Array; count: number }
	| { type: "sort"; id: number; row: DepthRow; near: number; out: Uint32Array };
export type SortResponse = {
	type: "sorted";
	id: number;
	indices: Uint32Array;
	count: number;
	ms: number;
};

type WorkerScope = {
	onmessage: ((ev: MessageEvent<SortRequest>) => void) | null;
	postMessage(msg: SortResponse, transfer: Transferable[]): void;
};

const g = globalThis as unknown as {
	WorkerGlobalScope?: unknown;
	document?: unknown;
};
if (
	typeof g.WorkerGlobalScope !== "undefined" &&
	typeof g.document === "undefined"
) {
	const ctx = globalThis as unknown as WorkerScope;
	let positions: Float32Array = new Float32Array(0);
	let count = 0;
	let scratch = newSortScratch(0);
	ctx.onmessage = (ev) => {
		const m = ev.data;
		if (m.type === "init") {
			positions = m.positions;
			count = m.count;
			scratch = newSortScratch(count);
			return;
		}
		const t0 = performance.now();
		const out = m.out.length >= count ? m.out : new Uint32Array(count);
		const n = sortSplatsByDepth(positions, count, m.row, out, scratch, m.near);
		ctx.postMessage(
			{
				type: "sorted",
				id: m.id,
				indices: out,
				count: n,
				ms: performance.now() - t0,
			},
			[out.buffer],
		);
	};
}
