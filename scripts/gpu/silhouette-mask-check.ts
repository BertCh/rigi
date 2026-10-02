// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check of the silhouette mask scheme (src/lib/deck/silhouette-mask.ts), no GPU:
// - a JS emulation of the mask shaders (deck/silhouette-gl.ts, deck-webgpu/silhouette-gpu.ts: f32
//   products via Math.fround, the same three-valued tests, the same 96-pixel packing) on synthetic
//   layered-ridge range renders, decoded with scoreFromMask, must equal the CPU scorer
//   (deck/engine.ts scoreSilhouette, copied below) with Object.is whenever the mask is accepted;
// - adversarial texels placed exactly on / next to the thresholds (ratio e^0.5, e^13, e^-0.5,
//   25000) must be either decided correctly or rejected (undecided → the caller's CPU fallback);
// - a mask whose headers carry another nonce (a dispatch that did not run) must be rejected, and so
//   must the mask of an all-zero texture under a valid nonce (the zero-texture guard).
// It checks the packing, the decoder's order and the bound logic; it cannot check a GPU's f32
// arithmetic.
//   npx tsx scripts/gpu/silhouette-mask-check.ts
import type { EdgeMap } from "../../src/lib/align";
import { logRange } from "../../src/lib/deck/geometry-source";
import {
	rangeIsBlank,
	redrawIfBlank,
	SIL_GROUP,
	scoreFromMask,
	silGroups,
	silhouetteThresholds,
	silMaskWords,
} from "../../src/lib/deck/silhouette-mask";

type Edge = Pick<EdgeMap, "w" | "h" | "coarse" | "fg">;

/** deck/engine.ts scoreSilhouette, verbatim (range: row 0 = top, Infinity = sky). */
function cpuScore(buf: Float32Array, W: number, H: number, edge: Edge) {
	const lr = (x: number, y: number) => logRange(buf[y * W + x]);
	let sum = 0;
	let n = 0;
	for (let y = 1; y < H - 1; y++)
		for (let x = 1; x < W - 1; x++) {
			const r = buf[y * W + x];
			if (!(r > 0) || r > 25000) continue;
			const c = lr(x, y);
			const up = lr(x, y - 1);
			const right = lr(x + 1, y);
			const left = lr(x - 1, y);
			const far = Math.max(
				up < 13 ? up : 0,
				right < 13 ? right : 0,
				left < 13 ? left : 0,
			);
			if (far - c < 0.5) continue;
			const u = x / W;
			const v = (y + 1) / H;
			const ex = Math.min(edge.w - 1, Math.floor(u * edge.w));
			const ey = Math.min(edge.h - 1, Math.floor(v * edge.h));
			const i = ey * edge.w + ex;
			if (edge.fg[i] > 0.3) continue;
			sum += edge.coarse[i];
			n++;
		}
	return n > 30 ? sum / n : 0;
}

const t = silhouetteThresholds();
const bits = new Uint32Array(1);
const asF32 = new Float32Array(bits.buffer);
/** The shaders' odd(): denormal, Inf or NaN f32 bits. */
const odd = (v: number) => {
	asF32[0] = v;
	const b = bits[0] & 0x7fffffff;
	return (b !== 0 && b < 0x00800000) || b >= 0x7f800000;
};
const f32 = Math.fround;
const [F, T, U] = [0, 1, 2];

/** The shaders' main(), in JS (raw = the texture: 0 = sky, row 0 = top). */
function emulate(raw: Float32Array, W: number, H: number, nonce: number) {
	const G = silGroups(W);
	const out = new Uint32Array(silMaskWords(W, H));
	const nb = (rn: number, rc: number, z: number) => {
		if (odd(rn)) return U;
		if (!(rn > 0)) return z;
		const lt = rn <= t.flo ? T : rn >= t.fhi ? F : U;
		const r = rn >= f32(rc * t.khi) ? T : rn <= f32(rc * t.klo) ? F : U;
		if (lt === T) return r;
		if (lt === F) return z;
		return r === z && r !== U ? r : U;
	};
	for (let y = 0; y < H; y++)
		for (let g = 0; g < G; g++) {
			const bits = [0, 0, 0];
			let und = 0;
			let pos = 0;
			for (let k = 0; k < SIL_GROUP; k++) {
				const x = g * SIL_GROUP + k;
				if (x >= W) break;
				const r = raw[y * W + x];
				if (!odd(r) && r > 0) pos++;
			}
			if (y >= 1 && y <= H - 2)
				for (let k = 0; k < SIL_GROUP; k++) {
					const x = g * SIL_GROUP + k;
					if (x < 1 || x > W - 2) continue;
					const rc = raw[y * W + x];
					if (odd(rc)) {
						und++;
						continue;
					}
					if (!(rc > 0) || rc > t.rmax) continue;
					const z = rc <= t.zlo ? T : rc >= t.zhi ? F : U;
					const a = nb(raw[(y - 1) * W + x], rc, z);
					const b = nb(raw[y * W + x + 1], rc, z);
					const c = nb(raw[y * W + x - 1], rc, z);
					if (a === T || b === T || c === T) bits[k >> 5] |= 1 << (k & 31);
					else if (a === U || b === U || c === U) und++;
				}
			const o = (y * G + g) * 4;
			out[o] = bits[0] >>> 0;
			out[o + 1] = bits[1] >>> 0;
			out[o + 2] = bits[2] >>> 0;
			out[o + 3] = ((nonce << 16) | (pos << 8) | Math.min(und, 255)) >>> 0;
		}
	return out;
}

let seed = 12345;
const rnd = () => {
	seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
	return seed / 2 ** 32;
};

function scene(trial: number, adversarial: boolean) {
	const W = 384;
	const H = [288, 216, 512][trial % 3];
	const raw = new Float32Array(W * H);
	const sky = Math.floor(H * (0.1 + 0.3 * rnd()));
	const bands = 2 + Math.floor(rnd() * 5);
	const bounds = Array.from({ length: bands }, () =>
		Math.floor(sky + (H - sky) * rnd()),
	).sort((a, b) => a - b);
	const base = Array.from({ length: bands + 1 }, () => Math.exp(5 + 8 * rnd()));
	const edgeVals = [
		Math.exp(13),
		Math.exp(-0.5),
		25000,
		Math.exp(13) * (1 + 3e-6),
	];
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const yy = y + Math.round(6 * Math.sin(x / (10 + (trial % 30)) + trial));
			if (yy < sky) continue;
			let b = 0;
			while (b < bands && yy >= bounds[b]) b++;
			let r = base[bands - b] * (1 + 0.02 * rnd()) * (1 - (yy - sky) / (4 * H));
			if (adversarial && rnd() < 0.002 && x > 0)
				r = f32(raw[y * W + x - 1] * Math.exp(0.5)) || r;
			if (adversarial && rnd() < 0.0005)
				r = edgeVals[Math.floor(rnd() * edgeVals.length)];
			raw[y * W + x] = r;
		}
	const range = raw.map((r) => (r > 0 ? r : Number.POSITIVE_INFINITY));
	const ew = 512;
	const eh = Math.round((512 * H) / W);
	const coarse = new Float32Array(ew * eh).map(() => rnd() ** 3 * 1.5);
	const fg = new Float32Array(ew * eh).map(() => (rnd() < 0.05 ? 0.5 : 0));
	return { W, H, raw, range, edge: { w: ew, h: eh, coarse, fg } };
}

let failures = 0;
const stats = { accepted: 0, rejected: 0, nonzero: 0, cleanRejected: 0 };
for (const adversarial of [false, true])
	for (let trial = 0; trial < 150; trial++) {
		const { W, H, raw, range, edge } = scene(trial, adversarial);
		const ref = cpuScore(range, W, H, edge);
		const nonce = 0x100 + trial;
		const mask = emulate(raw, W, H, nonce);
		const got = scoreFromMask(mask, 0, W, H, edge as EdgeMap, nonce);
		if (got === null) stats.rejected++;
		else {
			stats.accepted++;
			if (ref !== 0) stats.nonzero++;
			if (!Object.is(got, ref)) {
				failures++;
				console.log(`DIFF trial ${trial} adv ${adversarial}: ${got} vs ${ref}`);
			}
		}
		// a zero texture (destroyed / unwritten / wrong binding) under a valid nonce must fall back
		const zeros = emulate(new Float32Array(W * H), W, H, nonce);
		if (scoreFromMask(zeros, 0, W, H, edge as EdgeMap, nonce) !== null) {
			failures++;
			console.log(`all-zero texture accepted (trial ${trial})`);
		}
		if (scoreFromMask(mask, 0, W, H, edge as EdgeMap, nonce + 1) !== null) {
			failures++;
			console.log(`stale nonce accepted (trial ${trial})`);
		}
		// legitimate (a pixel inside a ~2e-5 band) but should be rare on clean scenes
		if (!adversarial && got === null) stats.cleanRejected++;
	}
// redrawIfBlank: a blank render (the draw did not happen) is drawn again once, anything else is kept
{
	const pose = { yaw: 10, pitch: 0, roll: 0, vfov: 20 };
	const fake = (blankDraws: number) => {
		let draws = 0;
		const src = {
			range: new Float32Array(16).fill(Number.POSITIVE_INFINITY),
			async render() {
				draws++;
				if (draws > blankDraws) src.range[5] = 1234;
			},
			get draws() {
				return draws;
			},
		};
		return src;
	};
	if (!rangeIsBlank(new Float32Array(4).fill(Number.POSITIVE_INFINITY)))
		failures++;
	if (!rangeIsBlank(new Float32Array(4))) failures++;
	if (rangeIsBlank(Float32Array.of(0, Number.POSITIVE_INFINITY, 3))) failures++;
	// first draw blank (render() before), the redraw sees terrain
	const a = fake(1);
	await a.render();
	if (
		!(await redrawIfBlank(a, pose)) ||
		a.draws !== 2 ||
		rangeIsBlank(a.range)
	) {
		failures++;
		console.log("redrawIfBlank did not redraw a blank first draw");
	}
	// not blank: no redraw
	if ((await redrawIfBlank(a, pose)) || a.draws !== 2) {
		failures++;
		console.log("redrawIfBlank redrew a non-blank render");
	}
	// a real all-sky view stays blank after its one redraw (no loop)
	const b = fake(99);
	await b.render();
	if (!(await redrawIfBlank(b, pose)) || b.draws !== 2) {
		failures++;
		console.log("redrawIfBlank: all-sky view not redrawn exactly once");
	}
}
console.log({ ...stats, failures });
process.exit(failures || stats.cleanRejected > 5 ? 1 : 0);
