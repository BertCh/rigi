// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure pieces of the live Step Inside session: when depth / colour / refit run, how many splats fit a
// budget (the live LOD), and the pixel index math of the colour refresh from the video texture. The
// WGSL in ./kernels.ts repeats the tap math; `blockTapPixels` is its CPU twin.

export type LiveScheduleOptions = {
	/** A depth run every N frames (N ≥ 1). */
	depthEvery: number;
	/** Refit the anchor and the focal / shift every K depth runs (K ≥ 1; Infinity = never). */
	refitEvery: number;
};

export const LIVE_SCHEDULE_DEFAULTS: LiveScheduleOptions = {
	depthEvery: 4,
	refitEvery: 30,
};

export type FramePlan = {
	frame: number;
	/** Run depth → lift this frame (the net outputs must be ready). */
	runDepth: boolean;
	/** Index of the depth run (0-based) when `runDepth`, else the index of the last one (-1 before any). */
	depthRun: number;
	/** Refresh the splat colours from the video texture (every frame; a depth run does it as its last step). */
	refreshColour: boolean;
	/** Start an async refit of the anchor / focal / shift after this depth run (never on the frame path). */
	refit: boolean;
};

/**
 * Frame scheduler. `next({ depthReady })` is called once per rendered frame: a depth run is due on frames
 * 0, N, 2N, …; a due run whose net outputs are not ready yet (`depthReady` false) is deferred to the next
 * frame instead of skipped, and the cadence restarts from the frame it actually ran on. Refits are due on
 * every K-th depth run after the first (the first solve is the session's initial one).
 */
export class LiveSchedule {
	private opts: LiveScheduleOptions;
	private frame = 0;
	private lastDepthFrame = Number.NEGATIVE_INFINITY;
	private runs = 0;

	constructor(opts: Partial<LiveScheduleOptions> = {}) {
		this.opts = { ...LIVE_SCHEDULE_DEFAULTS, ...opts };
	}

	setOptions(opts: Partial<LiveScheduleOptions>) {
		this.opts = { ...this.opts, ...opts };
	}

	reset() {
		this.frame = 0;
		this.lastDepthFrame = Number.NEGATIVE_INFINITY;
		this.runs = 0;
	}

	get depthRuns(): number {
		return this.runs;
	}

	/** Whether the next frame is a depth frame (so the caller only fetches the net's outputs when needed). */
	isDepthDue(): boolean {
		const every = Math.max(1, Math.floor(this.opts.depthEvery));
		return this.frame - this.lastDepthFrame >= every;
	}

	next(state: { depthReady: boolean } = { depthReady: true }): FramePlan {
		const every = Math.max(1, Math.floor(this.opts.depthEvery));
		const frame = this.frame++;
		const due = frame - this.lastDepthFrame >= every;
		const runDepth = due && state.depthReady;
		let refit = false;
		if (runDepth) {
			this.lastDepthFrame = frame;
			const k = this.opts.refitEvery;
			refit =
				Number.isFinite(k) &&
				this.runs > 0 &&
				this.runs % Math.max(1, Math.floor(k)) === 0;
			this.runs++;
		}
		return {
			frame,
			runDepth,
			depthRun: this.runs - 1,
			refreshColour: true,
			refit,
		};
	}
}

export type LiveGrid = {
	stride: number;
	gw: number;
	gh: number;
	/** Splat capacity = gw · gh cells (one candidate per stride × stride cell). */
	capacity: number;
};

/**
 * The live LOD: the smallest stride ≥ `minStride` (default 2, the still-photo lift's) whose cell grid
 * stays within `maxSplats`. A larger stride shrinks both the lift and the sort.
 */
export function chooseLiveGrid(
	width: number,
	height: number,
	maxSplats: number,
	minStride = 2,
): LiveGrid {
	let stride = Math.max(1, Math.floor(minStride));
	const cap = Math.max(1, Math.floor(maxSplats));
	for (;;) {
		const gw = Math.floor(width / stride);
		const gh = Math.floor(height / stride);
		if (gw * gh <= cap || (gw <= 1 && gh <= 1)) {
			return { stride, gw, gh, capacity: Math.max(1, gw * gh) };
		}
		stride++;
	}
}

/** Taps per axis for one stride cell of the depth grid (width `gridSize`) on a texture `texSize` wide. */
export function tapsPerAxis(
	stride: number,
	gridSize: number,
	texSize: number,
): number {
	const px = (stride * texSize) / gridSize;
	return Math.min(4, Math.max(1, Math.ceil(px)));
}

/**
 * Texture pixel columns (or rows) averaged for cell `g` of a `gridSize` grid with `stride` on a texture
 * `texSize` wide: `taps` taps at the centres of equal sub-intervals of the cell's span, nearest pixel.
 * The kernel's textureLoad coordinates; at texSize == gridSize and stride 2 these are the cell's two pixels.
 */
export function blockTapPixels(
	g: number,
	stride: number,
	gridSize: number,
	texSize: number,
): number[] {
	const n = tapsPerAxis(stride, gridSize, texSize);
	const lo = (g * stride * texSize) / gridSize;
	const span = (stride * texSize) / gridSize;
	const out: number[] = [];
	for (let t = 0; t < n; t++) {
		const x = lo + ((t + 0.5) * span) / n;
		out.push(Math.min(texSize - 1, Math.max(0, Math.floor(x))));
	}
	return out;
}

/** Cell id (gj · gw + gi) → its grid coordinates and the centre pixel of the depth grid (the lift's). */
export function cellCentre(cell: number, gw: number, stride: number) {
	const gi = cell % gw;
	const gj = Math.floor(cell / gw);
	const half = stride >> 1;
	return { gi, gj, px: gi * stride + half, py: gj * stride + half };
}

/**
 * CPU twin of the colour refresh: the packed rgba (r | g<<8 | b<<16 | 255<<24) of cell (gi, gj), the
 * rounded mean of the tap texels of an RGBA8 image `rgba` (`texW` × `texH`, row 0 = top).
 */
export function refreshColourCpu(
	rgba: Uint8Array | Uint8ClampedArray,
	texW: number,
	texH: number,
	gi: number,
	gj: number,
	stride: number,
	gridW: number,
	gridH: number,
): number {
	const xs = blockTapPixels(gi, stride, gridW, texW);
	const ys = blockTapPixels(gj, stride, gridH, texH);
	let r = 0;
	let g = 0;
	let b = 0;
	for (const y of ys)
		for (const x of xs) {
			const k = 4 * (y * texW + x);
			r += rgba[k];
			g += rgba[k + 1];
			b += rgba[k + 2];
		}
	const n = xs.length * ys.length;
	return (
		(Math.round(r / n) |
			(Math.round(g / n) << 8) |
			(Math.round(b / n) << 16) |
			(255 << 24)) >>>
		0
	);
}
