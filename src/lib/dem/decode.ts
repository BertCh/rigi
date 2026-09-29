// Terrarium decoding and the 256 m R-channel repair; environment-free.

/** Height written for pixels with no data; never visible in the march. */
export const NO_DATA = -32768;
/** Samples below this are treated as missing. */
export const MIN_VALID = -1000;

/**
 * RGBA pixels → heights (h = R·256 + G + B/256 − 32768), with the sea as its surface: AWS Terrarium
 * carries bathymetry (−3.6 km off La Palma), which a camera sees as sea level. Negatives down to the
 * deepest ocean clamp to 0; encoding-floor values (R ≈ 0, no data) stay below MIN_VALID for validateTile.
 */
export function decodeTerrarium(rgba: Uint8ClampedArray | Uint8Array) {
	const out = new Float32Array(rgba.length / 4);
	for (let i = 0; i < out.length; i++) {
		const o = i * 4;
		const h = rgba[o] * 256 + rgba[o + 1] + rgba[o + 2] / 256 - 32768;
		out[i] = h < 0 && h > -12000 ? 0 : h;
	}
	return out;
}

export interface TileValidation {
	/** Neighbour pairs differing by more than `jump` metres. */
	jumps: number;
	/** Pixels corrected by a multiple of 256 m (R-channel error). */
	repaired: number;
	/** Out-of-range pixels replaced from neighbours. */
	filled: number;
	/** Jumps remaining after repair. */
	remaining: number;
}

function countJumps(h: Float32Array, size: number, jump: number) {
	let n = 0;
	for (let y = 0; y < size; y++) {
		const row = y * size;
		for (let x = 0; x < size; x++) {
			const v = h[row + x];
			if (x + 1 < size && Math.abs(h[row + x + 1] - v) > jump) n++;
			if (y + 1 < size && Math.abs(h[row + size + x] - v) > jump) n++;
		}
	}
	return n;
}

function neighbourMedian(h: Float32Array, size: number, x: number, y: number) {
	const vals: number[] = [];
	for (let dy = -1; dy <= 1; dy++)
		for (let dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			const xx = x + dx;
			const yy = y + dy;
			if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
			const v = h[yy * size + xx];
			if (v > MIN_VALID && v < 9000) vals.push(v);
		}
	if (!vals.length) return Number.NaN;
	vals.sort((a, b) => a - b);
	const m = vals.length >> 1;
	return vals.length & 1 ? vals[m] : 0.5 * (vals[m - 1] + vals[m]);
}

/**
 * Flags neighbour jumps > `jump` m (a ±1 error in Terrarium R is ±256 m, a
 * known worker/canvas decode failure) and repairs them: pixels are split
 * into 4-connected components across edges with |Δ| ≤ jump; any component
 * other than the largest whose border seams agree (≥ 80 %) on a jump of
 * 256·k ± tol (k ≠ 0) is shifted by −256·k. Real cliffs (jumps that are
 * not a consistent multiple of 256 m, or that do not enclose a region) are
 * left alone. Out-of-range pixels are filled with the neighbour median.
 * In place.
 */
export function validateTile(
	h: Float32Array,
	size: number,
	jump = 200,
	tol = 40,
): TileValidation {
	const res: TileValidation = {
		jumps: 0,
		repaired: 0,
		filled: 0,
		remaining: 0,
	};
	for (let i = 0; i < h.length; i++) {
		const v = h[i];
		if (!(v > MIN_VALID && v < 9000)) {
			const m = neighbourMedian(h, size, i % size, (i / size) | 0);
			h[i] = Number.isNaN(m) ? NO_DATA : m;
			res.filled++;
		}
	}
	res.jumps = countJumps(h, size, jump);
	if (!res.jumps) return res;
	// Label components (BFS over edges with |Δ| ≤ jump).
	const N = h.length;
	const label = new Int32Array(N).fill(-1);
	const sizes: number[] = [];
	const stack = new Int32Array(N);
	for (let s0 = 0; s0 < N; s0++) {
		if (label[s0] >= 0) continue;
		const id = sizes.length;
		let top = 0;
		let count = 0;
		stack[top++] = s0;
		label[s0] = id;
		while (top) {
			const i = stack[--top];
			count++;
			const x = i % size;
			const v = h[i];
			if (x + 1 < size && label[i + 1] < 0 && Math.abs(h[i + 1] - v) <= jump) {
				label[i + 1] = id;
				stack[top++] = i + 1;
			}
			if (x > 0 && label[i - 1] < 0 && Math.abs(h[i - 1] - v) <= jump) {
				label[i - 1] = id;
				stack[top++] = i - 1;
			}
			if (
				i + size < N &&
				label[i + size] < 0 &&
				Math.abs(h[i + size] - v) <= jump
			) {
				label[i + size] = id;
				stack[top++] = i + size;
			}
			if (
				i >= size &&
				label[i - size] < 0 &&
				Math.abs(h[i - size] - v) <= jump
			) {
				label[i - size] = id;
				stack[top++] = i - size;
			}
		}
		sizes.push(count);
	}
	if (sizes.length < 2) return { ...res, remaining: res.jumps };
	let main = 0;
	for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[main]) main = c;
	// Seam votes per component: k = round(Δ/256) when Δ ≈ 256·k.
	const votes = new Map<number, Map<number, number>>();
	const seams = new Int32Array(sizes.length);
	const vote = (a: number, b: number) => {
		const ca = label[a];
		if (ca === label[b]) return;
		seams[ca]++;
		const dlt = h[a] - h[b];
		const k = Math.round(dlt / 256);
		if (k === 0 || !(Math.abs(dlt - 256 * k) < tol)) return;
		let m = votes.get(ca);
		if (!m) {
			m = new Map();
			votes.set(ca, m);
		}
		m.set(k, (m.get(k) ?? 0) + 1);
	};
	for (let i = 0; i < N; i++) {
		const x = i % size;
		if (x + 1 < size) {
			vote(i, i + 1);
			vote(i + 1, i);
		}
		if (i + size < N) {
			vote(i, i + size);
			vote(i + size, i);
		}
	}
	const shift = new Float32Array(sizes.length);
	for (const [c, m] of votes) {
		if (c === main || sizes[c] > N / 4) continue;
		let bestK = 0;
		let bestN = 0;
		for (const [k, n] of m)
			if (n > bestN) {
				bestK = k;
				bestN = n;
			}
		if (bestN >= 0.8 * seams[c]) shift[c] = 256 * bestK;
	}
	for (let i = 0; i < N; i++) {
		const sft = shift[label[i]];
		if (sft) {
			h[i] -= sft;
			res.repaired++;
		}
	}
	res.remaining = res.repaired ? countJumps(h, size, jump) : res.jumps;
	return res;
}
