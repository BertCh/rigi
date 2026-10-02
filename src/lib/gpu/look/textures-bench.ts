// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Parity / speed bench of the texture-input look passes (textures.ts) against the array path, on
// real inputs captured from a live deck engine (capture.ts). Run in the page by
// scripts/gpu/textures-bench.mjs. The engine's targets are re-created as textures on the compute
// device (the geometry buffer as rgba32float in GL row order, flipY: true; the photo at each pass's size; the masks as r8unorm) and each pass runs:
// - masks: guidedFiltersGpu(capture's I / coverage / people) vs masksTex → q planes (f32) and the
//   RGBA8 masks (vs Math.round of the array path's planes, and read back from the output texture);
//   a flipped upload (geometry row 0 = top, photo row 0 = bottom + flipY) must give the same bits;
// - stats: bandStatsGpu(capture's stats) vs bandStatsTex → every ColorStats field;
// - haze: hazePrepArrays(fitHazeGpu's CPU-built inputs) vs hazePrepTex → range, P(sky), lin, bins,
//   counts, order statistics.
// "exact" = bit-identical. Times: median of `reps` after one warm-up. "array" = the CPU input build
// from the (already read back) geometry buffer + upload + GPU + readback; "tex" = the texture graph,
// GPU-resident (until queue idle); "tex+read" = with the readback. The geometry readback the array
// path also needs (readRenderTargetPixels, a GPU stall) is not included.
import { Buffer, type Device, luma, Texture } from "@luma.gl/core";
import { webgpuAdapter } from "@luma.gl/webgpu";
import type { ColorStats } from "#/lib/look/color-stats";
import { photoPixels } from "#/lib/look/composite";
import { guidedFilter } from "#/lib/look/guided-filter";
import type { SkyMask } from "#/lib/look/haze-fit";
import { submittedWorkDone } from "../core/queue";
import { readBack } from "../core/readback";
import { adoptRenderDevice, getComputeDevice } from "../device";
import { captureLookInputs } from "./capture";
import { bandStatsGpu } from "./color-stats";
import { guidedFiltersGpu } from "./guided-filter";
import {
	bandStatsTex,
	type HazePrep,
	hazePrepArrays,
	hazePrepTex,
	masksTex,
	warmTextureKernels,
} from "./textures";

type Engine = {
	geoBuf: Float32Array;
	geoRT: { width: number; height: number };
	photoImg?: HTMLImageElement;
	fgMask: SkyMask | null;
	haze: { sky: SkyMask | null };
};

type Diff = { n: number; diff: number; max: number };

/** How many values differ (bitwise for floats: NaN = NaN) and the max |a − b|. */
function diff(
	a: ArrayLike<number>,
	b: ArrayLike<number>,
	n = Math.min(a.length, b.length),
): Diff {
	let d = 0;
	let max = 0;
	for (let i = 0; i < n; i++) {
		const x = a[i];
		const y = b[i];
		if (x === y || (Number.isNaN(x) && Number.isNaN(y))) continue;
		d++;
		const e = Math.abs(x - y);
		if (e > max || Number.isNaN(e)) max = e;
	}
	return { n, diff: d + Math.abs(a.length - b.length), max };
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
const idle = (device: Device) => submittedWorkDone(device);

async function time(
	reps: number,
	f: () => Promise<unknown>,
): Promise<{ cold: number; ms: number }> {
	let t = performance.now();
	await f();
	const cold = performance.now() - t;
	const ts: number[] = [];
	for (let i = 0; i < reps; i++) {
		t = performance.now();
		await f();
		ts.push(performance.now() - t);
	}
	return { cold: +cold.toFixed(2), ms: +median(ts).toFixed(2) };
}

function texture(
	device: Device,
	format: "rgba32float" | "rgba8unorm" | "rgba8unorm-srgb" | "r8unorm",
	width: number,
	height: number,
	data: ArrayBufferView,
): Texture {
	const t = device.createTexture({
		format,
		width,
		height,
		usage: Texture.SAMPLE | Texture.COPY_DST | Texture.COPY_SRC,
	});
	t.writeData(data);
	return t;
}

/** Rows reversed (row 0 ↔ row h − 1) of a w × h image with `c` values per texel. */
function flipRows<T extends Float32Array | Uint8Array>(
	a: T,
	w: number,
	h: number,
	c: number,
): T {
	const o = new (a.constructor as { new (n: number): T })(a.length);
	for (let y = 0; y < h; y++)
		o.set(a.subarray((h - 1 - y) * w * c, (h - y) * w * c), y * w * c);
	return o;
}

/** A texture's texels (tight rows), via a padded copy. */
async function readTexture(device: Device, t: Texture, bpt: number) {
	const row = Math.ceil((t.width * bpt) / 256) * 256;
	const b = device.createBuffer({
		usage: Buffer.COPY_DST | Buffer.COPY_SRC,
		byteLength: row * t.height,
	});
	try {
		const [data] = await readBack(
			device,
			(enc) =>
				enc.copyTextureToBuffer({
					sourceTexture: t,
					destinationBuffer: b,
					bytesPerRow: row,
					width: t.width,
					height: t.height,
				}),
			[{ buffer: b, size: row * t.height }],
		);
		const out = new Uint8Array(t.width * t.height * bpt);
		for (let y = 0; y < t.height; y++)
			out.set(new Uint8Array(data, y * row, t.width * bpt), y * t.width * bpt);
		return out;
	} finally {
		b.destroy();
	}
}

/** composite.ts updateMasks' input loop (as capture.ts), for the array path's timing. */
function masksInputsCpu(
	geo: Float32Array,
	gw: number,
	gh: number,
	px: Uint8ClampedArray,
	w: number,
	h: number,
	sky: SkyMask | null,
	fgm: SkyMask | null,
) {
	const maskAt = (m: SkyMask, u: number, v: number) =>
		m.data[
			Math.min(m.height - 1, Math.floor(v * m.height)) * m.width +
				Math.min(m.width - 1, Math.floor(u * m.width))
		] / 255;
	const at = (x: number, y: number) => geo[((gh - 1 - y) * gw + x) * 4 + 3];
	const n = w * h;
	const I = new Float32Array(n);
	const cov = new Float32Array(n);
	const fg = fgm ? new Float32Array(n) : null;
	const sx = gw / w;
	const sy = gh / h;
	const ss = Math.max(1, Math.round(sx));
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			I[i] =
				(0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) /
				255;
			let t = 0;
			for (let dy = 0; dy < ss; dy++)
				for (let dx = 0; dx < ss; dx++) {
					const r = at(
						Math.min(gw - 1, Math.floor(x * sx) + dx),
						Math.min(gh - 1, Math.floor(y * sy) + dy),
					);
					t += r > 0 && Number.isFinite(r) ? 1 : 0;
				}
			const u = (x + 0.5) / w;
			const v = (y + 0.5) / h;
			cov[i] = (t / (ss * ss)) * (sky ? 1 - maskAt(sky, u, v) : 1);
			if (fg && fgm) fg[i] = maskAt(fgm, u, v);
		}
	return { I, cov, fg };
}

/** fitHazeGpu's CPU-built prep inputs (keep in sync with haze.ts). */
function hazeInputsCpu(
	small: Float32Array,
	W: number,
	H: number,
	sky: SkyMask | null,
	fg: SkyMask | null,
) {
	const N = W * H;
	const range = new Float32Array(N);
	const pSky = new Float32Array(N);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			range[y * W + x] = small[((H - 1 - y) * W + x) * 4 + 3];
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			if (sky) {
				const mx = Math.min(
					sky.width - 1,
					Math.floor(((x + 0.5) * sky.width) / W),
				);
				const my = Math.min(
					sky.height - 1,
					Math.floor(((y + 0.5) * sky.height) / H),
				);
				pSky[i] = sky.data[my * sky.width + mx] / 255;
			} else pSky[i] = range[i] > 0 ? 0 : 1;
		}
	const fgBits = new Uint32Array(Math.ceil(N / 32));
	if (fg)
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const mx = Math.min(
					fg.width - 1,
					Math.floor(((x + 0.5) * fg.width) / W),
				);
				const my = Math.min(
					fg.height - 1,
					Math.floor(((y + 0.5) * fg.height) / H),
				);
				if (fg.data[my * fg.width + mx] > 64) {
					const i = y * W + x;
					fgBits[i >> 5] |= 1 << (i & 31);
				}
			}
	return { range, pSky, fgBits };
}

function statsDiff(a: ColorStats, b: ColorStats) {
	const keys = ["photoMean", "photoStd", "layerMean", "layerStd"] as const;
	const out: Record<string, Diff | boolean> = {
		count: diff(a.count, b.count).diff === 0,
		valid: a.valid === b.valid,
	};
	for (const k of keys) out[k] = diff(a[k], b[k]);
	const exact =
		out.count === true &&
		out.valid === true &&
		keys.every((k) => (out[k] as Diff).diff === 0);
	return { exact, ...out };
}

function hazeDiff(a: HazePrep, b: HazePrep) {
	const d = {
		range: diff(a.range, b.range),
		pSky: diff(a.pSky, b.pSky),
		lin: diff(a.lin, b.lin),
		bins: diff(a.bins, b.bins),
		counts: diff(a.counts, b.counts),
		stat: diff(a.stat, b.stat),
	};
	return { exact: Object.values(d).every((x) => x.diff === 0), ...d };
}

export async function runTexturesBench(
	engine: unknown,
	opts: { reps?: number; label?: string } = {},
) {
	const reps = opts.reps ?? 5;
	const device = await getComputeDevice();
	if (!device) throw new Error("no WebGPU compute device");
	const e = engine as Engine;
	const inputs = captureLookInputs(engine, opts.label);
	const img = e.photoImg;
	if (!img) throw new Error("no photo");
	const gw = e.geoRT.width;
	const gh = e.geoRT.height;
	const geoBuf = e.geoBuf.slice();
	const sky = e.haze.sky;
	const fgMask = e.fgMask;
	const made: Texture[] = [];
	const tex = (...a: Parameters<typeof texture>) => {
		const t = texture(...a);
		made.push(t);
		return t;
	};
	const failedWarm = warmTextureKernels(device);
	const geoTex = tex(device, "rgba32float", gw, gh, geoBuf);
	const geometry = { texture: geoTex, flipY: true };
	const skyTex = sky
		? tex(device, "r8unorm", sky.width, sky.height, Uint8Array.from(sky.data))
		: null;
	const fgTex = fgMask
		? tex(
				device,
				"r8unorm",
				fgMask.width,
				fgMask.height,
				Uint8Array.from(fgMask.data),
			)
		: null;
	const out: Record<string, unknown> = {
		source: inputs.source,
		geo: [gw, gh],
		sky: sky ? [sky.width, sky.height] : null,
		fg: fgMask ? [fgMask.width, fgMask.height] : null,
		failedWarm,
	};
	try {
		// ── masks
		const m = inputs.masks;
		if (m) {
			const { w, h } = m;
			const n = w * h;
			const px = photoPixels(img, w, h).data;
			const photoTex = tex(
				device,
				"rgba8unorm",
				w,
				h,
				new Uint8Array(px.buffer),
			);
			const jobs = [
				{ p: m.cov, r: Math.max(2, Math.round(w * 0.008)), eps: 4e-4 },
			];
			if (m.fg)
				jobs.push({
					p: m.fg,
					r: Math.max(3, Math.round(w * 0.012)),
					eps: 1e-3,
				});
			const arr = await guidedFiltersGpu(device, m.I, w, h, jobs);
			const input = {
				geometry,
				photo: photoTex,
				sky: skyTex,
				fg: fgTex,
			};
			const t = await masksTex(device, input, {
				texture: "rgba8unorm",
				read: true,
			});
			const data = t.data as { q: Float32Array[]; masks: Uint8Array };
			const q = data.q.map((qt, j) => diff(arr[j], qt));
			// CompositeLook's packing of the array path's planes
			const bytes = new Uint8Array(n * 4);
			for (let i = 0; i < n; i++) {
				bytes[i * 4] = Math.round(arr[0][i] * 255);
				bytes[i * 4 + 2] = m.fg ? Math.round(arr[1][i] * 255) : 0;
				bytes[i * 4 + 3] = 255;
			}
			const texBytes = await readTexture(device, t.texture as Texture, 4);
			// flipped uploads: geometry row 0 = top, photo row 0 = bottom (+ flipY)
			const geoTop = tex(
				device,
				"rgba32float",
				gw,
				gh,
				flipRows(geoBuf, gw, gh, 4),
			);
			const photoBottom = tex(
				device,
				"rgba8unorm",
				w,
				h,
				flipRows(new Uint8Array(px.buffer), w, h, 4),
			);
			const tf = await masksTex(
				device,
				{
					...input,
					geometry: geoTop,
					photo: { texture: photoBottom, flipY: true },
				},
				{ read: true },
			);
			const qf = (tf.data as { q: Float32Array[] }).q;
			// the WebGPU renderer's photo format: the same bytes as rgba8unorm-srgb, plus a synthetic
			// photo cycling every byte value through each channel (the sRGB re-encode round trip)
			const photoSrgb = tex(
				device,
				"rgba8unorm-srgb",
				w,
				h,
				new Uint8Array(px.buffer),
			);
			const ts = await masksTex(
				device,
				{ ...input, photo: photoSrgb },
				{ read: true },
			);
			const qs = (ts.data as { q: Float32Array[] }).q;
			const ramp = Uint8Array.from({ length: n * 4 }, (_, i) =>
				i % 4 === 3 ? 255 : (Math.floor(i / 4) * 7 + (i % 4) * 85) % 256,
			);
			const rampQ = async (format: "rgba8unorm" | "rgba8unorm-srgb") => {
				const r = await masksTex(
					device,
					{ ...input, photo: tex(device, format, w, h, ramp) },
					{ read: true },
				);
				return (r.data as { q: Float32Array[] }).q;
			};
			const rampU = await rampQ("rgba8unorm");
			const rampS = await rampQ("rgba8unorm-srgb");
			// the r8unorm output (coverage)
			const tr = await masksTex(device, input, { texture: "r8unorm" });
			const r8 = await readTexture(device, tr.texture as Texture, 1);
			const cov8 = Uint8Array.from({ length: n }, (_, i) => bytes[i * 4]);
			// the array path's own tolerance: CPU guidedFilter vs the array GPU path
			const cpu = guidedFilter(m.I, m.cov, w, h, jobs[0].r, jobs[0].eps);
			const tArr = await time(reps, async () => {
				const s = masksInputsCpu(geoBuf, gw, gh, px, w, h, sky, fgMask);
				const j2 = [{ ...jobs[0], p: s.cov }];
				if (s.fg) j2.push({ ...jobs[jobs.length - 1], p: s.fg });
				const q2 = await guidedFiltersGpu(device, s.I, w, h, j2);
				const b = new Uint8Array(n * 4);
				for (let i = 0; i < n; i++) b[i * 4] = Math.round(q2[0][i] * 255);
				return b;
			});
			const tTex = await time(reps, async () => {
				await masksTex(device, input, { texture: "rgba8unorm" });
				await idle(device);
			});
			const tTexRead = await time(reps, () =>
				masksTex(device, input, { texture: "rgba8unorm", read: true }),
			);
			const cpuIn = masksInputsCpu(geoBuf, gw, gh, px, w, h, sky, fgMask);
			out.masks = {
				grid: [w, h],
				jobs: jobs.map((j) => [j.r, j.eps]),
				exact:
					q.every((d) => d.diff === 0) &&
					diff(bytes, data.masks).diff === 0 &&
					diff(bytes, texBytes).diff === 0 &&
					qf.every((qq, j) => diff(data.q[j], qq).diff === 0) &&
					qs.every((qq, j) => diff(data.q[j], qq).diff === 0) &&
					rampS.every((qq, j) => diff(rampU[j], qq).diff === 0) &&
					diff(cov8, r8).diff === 0,
				q,
				masksBytes: diff(bytes, data.masks),
				textureBytes: diff(bytes, texBytes),
				flipped: qf.map((qq, j) => diff(data.q[j], qq)),
				srgbPhoto: qs.map((qq, j) => diff(data.q[j], qq)),
				srgbRamp: rampS.map((qq, j) => diff(rampU[j], qq)),
				r8Coverage: diff(cov8, r8),
				captureVsBenchInputs: {
					I: diff(m.I, cpuIn.I),
					cov: diff(m.cov, cpuIn.cov),
					fg: m.fg && cpuIn.fg ? diff(m.fg, cpuIn.fg) : null,
				},
				arrayVsCpuCoverage: diff(cpu, arr[0]),
				ms: { array: tArr, tex: tTex, texRead: tTexRead },
			};
			// eviction race: 8 grid sizes (8 graph keys > the 6-graph LRU) in flight at once must all
			// resolve, each bit-identical to the same call made alone
			const sizes = Array.from(
				{ length: 8 },
				(_, k) => [w - 2 * k, h - k] as [number, number],
			);
			const one = (size: [number, number]) =>
				masksTex(device, { ...input, size }, { read: true }).then(
					(r) => (r.data as { q: Float32Array[] }).q[0],
				);
			const burst = await Promise.allSettled(sizes.map(one));
			let raceOk = burst.every((r) => r.status === "fulfilled");
			for (let k = 0; raceOk && k < sizes.length; k++)
				raceOk =
					diff(
						(burst[k] as PromiseFulfilledResult<Float32Array>).value,
						await one(sizes[k]),
					).diff === 0;
			const mo = out.masks as Record<string, unknown>;
			mo.evictionRace = {
				ok: raceOk,
				rejected: burst
					.filter((r) => r.status === "rejected")
					.map((r) =>
						String((r as PromiseRejectedResult).reason).slice(0, 200),
					),
			};
			mo.exact = mo.exact === true && raceOk;
		}

		// ── stats
		const s = inputs.stats;
		if (s) {
			const { w, h } = s;
			const layerGl = flipRows(s.layer, w, h, 4);
			const layerTex = tex(device, "rgba32float", w, h, layerGl);
			const photoTex = tex(
				device,
				"rgba8unorm",
				w,
				h,
				new Uint8Array(s.photo.buffer, s.photo.byteOffset, s.photo.byteLength),
			);
			const arrIn = {
				photo: s.photo,
				layer: s.layer,
				w,
				h,
				range: s.range,
				fg: s.fg,
				minRange: s.minRange,
			};
			const input = {
				geometry,
				layer: { texture: layerTex, flipY: true },
				photo: photoTex,
				fg: fgTex,
				minRange: s.minRange,
			};
			const a = await bandStatsGpu(device, arrIn);
			const b = (await bandStatsTex(device, input)).stats as ColorStats;
			const a0 = await bandStatsGpu(device, arrIn, { subgroups: false });
			const b0 = (await bandStatsTex(device, input, { subgroups: false }))
				.stats as ColorStats;
			const tArr = await time(reps, () => {
				// setStats' array build from the read-back geometry and layer
				const layer = flipRows(layerGl, w, h, 4);
				const range = new Float32Array(w * h);
				for (let y = 0; y < h; y++)
					for (let x = 0; x < w; x++) {
						const r =
							geoBuf[
								((gh - 1 - Math.floor(((y + 0.5) * gh) / h)) * gw +
									Math.floor(((x + 0.5) * gw) / w)) *
									4 +
									3
							];
						range[y * w + x] = r > 0 && Number.isFinite(r) ? r : 0;
					}
				return bandStatsGpu(device, { ...arrIn, layer, range });
			});
			const tTex = await time(reps, async () => {
				await bandStatsTex(device, input, { read: false });
				await idle(device);
			});
			const tTexRead = await time(reps, () => bandStatsTex(device, input));
			out.stats = {
				grid: [w, h],
				subgroups: statsDiff(a, b),
				plain: statsDiff(a0, b0),
				counts: Array.from(a.count),
				ms: { array: tArr, tex: tTex, texRead: tTexRead },
			};
		}

		// ── haze prep
		const hz = inputs.haze;
		if (hz && hz.geo.kind === "xyzr") {
			const { geoW: W, geoH: H } = hz;
			const photoTex = tex(
				device,
				"rgba8unorm",
				hz.photo.width,
				hz.photo.height,
				new Uint8Array(
					hz.photo.data.buffer,
					hz.photo.data.byteOffset,
					hz.photo.data.byteLength,
				),
			);
			const small = hz.geo.data;
			const cpu = hazeInputsCpu(
				small,
				W,
				H,
				hz.sky ?? null,
				hz.foreground ?? null,
			);
			const arrays = {
				W,
				H,
				photo: hz.photo,
				...cpu,
				hasFg: !!hz.foreground,
			};
			const input = { geometry, photo: photoTex, sky: skyTex, fg: fgTex };
			const a = (await hazePrepArrays(device, arrays, { read: true }))
				.data as HazePrep;
			const b = (await hazePrepTex(device, input, { read: true }))
				.data as HazePrep;
			const tArr = await time(reps, () => {
				// the haze controller's ×2 decimation, then fitHazeGpu's input build
				const S = 2;
				const sm = new Float32Array(W * H * 4);
				for (let y = 0; y < H; y++)
					for (let x = 0; x < W; x++)
						for (let c = 0; c < 4; c++)
							sm[(y * W + x) * 4 + c] = geoBuf[(y * S * gw + x * S) * 4 + c];
				const c2 = hazeInputsCpu(
					sm,
					W,
					H,
					hz.sky ?? null,
					hz.foreground ?? null,
				);
				return hazePrepArrays(device, { ...arrays, ...c2 }, { read: true });
			});
			const tTex = await time(reps, async () => {
				await hazePrepTex(device, input);
				await idle(device);
			});
			const tTexRead = await time(reps, () =>
				hazePrepTex(device, input, { read: true }),
			);
			out.haze = {
				grid: [W, H],
				photo: [hz.photo.width, hz.photo.height],
				...hazeDiff(a, b),
				binned: Array.from(a.counts).reduce((x, y) => x + y, 0),
				ms: { array: tArr, tex: tTex, texRead: tTexRead },
			};
		}

		// ── variants: a sky mask (synthetic when the engine has none: every byte value, odd size)
		// and an odd mask grid (padded texture rows, r8 packing with a partial last word)
		const skyV: SkyMask = sky ?? {
			width: 333,
			height: 250,
			data: Uint8Array.from(
				{ length: 333 * 250 },
				(_, i) => ((i % 333) * 7 + Math.floor(i / 333) * 13) & 255,
			),
		};
		const skyVTex = tex(
			device,
			"r8unorm",
			skyV.width,
			skyV.height,
			Uint8Array.from(skyV.data),
		);
		const variants: Record<string, unknown> = { syntheticSky: !sky };
		if (m) {
			const w2 = m.w - 13;
			const h2 = m.h - 7;
			const px2 = photoPixels(img, w2, h2).data;
			const c = masksInputsCpu(geoBuf, gw, gh, px2, w2, h2, skyV, fgMask);
			const jobs = [
				{ p: c.cov, r: Math.max(2, Math.round(w2 * 0.008)), eps: 4e-4 },
			];
			if (c.fg)
				jobs.push({
					p: c.fg,
					r: Math.max(3, Math.round(w2 * 0.012)),
					eps: 1e-3,
				});
			const arr = await guidedFiltersGpu(device, c.I, w2, h2, jobs);
			const input = {
				geometry,
				photo: tex(device, "rgba8unorm", w2, h2, new Uint8Array(px2.buffer)),
				sky: skyVTex,
				fg: fgTex,
				size: [w2, h2] as [number, number],
			};
			const t = await masksTex(device, input, { read: true });
			const tr = await masksTex(device, input, { texture: "r8unorm" });
			const r8 = await readTexture(device, tr.texture as Texture, 1);
			const cov8 = Uint8Array.from(arr[0], (q) => Math.round(q * 255));
			const q = (t.data as { q: Float32Array[] }).q.map((qt, j) =>
				diff(arr[j], qt),
			);
			variants.masks = {
				grid: [w2, h2],
				exact: q.every((d) => d.diff === 0) && diff(cov8, r8).diff === 0,
				q,
				r8Coverage: diff(cov8, r8),
			};
		}
		if (hz && hz.geo.kind === "xyzr") {
			const { geoW: W, geoH: H } = hz;
			const cpu = hazeInputsCpu(hz.geo.data, W, H, skyV, hz.foreground ?? null);
			const photoTex = tex(
				device,
				"rgba8unorm",
				hz.photo.width,
				hz.photo.height,
				new Uint8Array(
					hz.photo.data.buffer,
					hz.photo.data.byteOffset,
					hz.photo.data.byteLength,
				),
			);
			const a = (
				await hazePrepArrays(
					device,
					{ W, H, photo: hz.photo, ...cpu, hasFg: !!hz.foreground },
					{ read: true },
				)
			).data as HazePrep;
			const b = (
				await hazePrepTex(
					device,
					{ geometry, photo: photoTex, sky: skyVTex, fg: fgTex },
					{ read: true },
				)
			).data as HazePrep;
			variants.haze = hazeDiff(a, b);
		}
		out.variants = variants;

		// ── adopted render device: a second WebGPU device stands in for deck's; once adopted,
		// getComputeDevice() returns it and the texture passes run on its own textures
		if (m && out.masks) {
			// while rd is adopted, any app compute would land on it too: start from an idle sidecar
			// (the page is settled and the bench drives nothing else) and keep the window short
			await idle(device);
			const rd = await luma.createDevice({
				id: "textures-bench-render",
				type: "webgpu",
				adapters: [webgpuAdapter],
			});
			try {
				adoptRenderDevice(rd);
				const d2 = await getComputeDevice();
				const { w, h } = m;
				const px = photoPixels(img, w, h).data;
				const t2 = await masksTex(
					rd,
					{
						geometry: {
							texture: texture(rd, "rgba32float", gw, gh, geoBuf),
							flipY: true,
						},
						photo: texture(rd, "rgba8unorm", w, h, new Uint8Array(px.buffer)),
						fg: fgMask
							? texture(
									rd,
									"r8unorm",
									fgMask.width,
									fgMask.height,
									Uint8Array.from(fgMask.data),
								)
							: null,
					},
					{ texture: "rgba8unorm", read: true },
				);
				const main = await masksTex(
					device,
					{
						geometry,
						photo: tex(device, "rgba8unorm", w, h, new Uint8Array(px.buffer)),
						fg: fgTex,
					},
					{ read: true },
				);
				const q2 = (t2.data as { q: Float32Array[] }).q;
				const q1 = (main.data as { q: Float32Array[] }).q;
				out.adopted = {
					returned: d2 === rd,
					exact: q2.every((q, j) => diff(q1[j], q).diff === 0),
				};
			} finally {
				rd.destroy();
			}
			// losing it un-adopts: back to the sidecar
			await Promise.race([rd.lost, new Promise((r) => setTimeout(r, 1000))]);
			(out.adopted as Record<string, unknown>).afterDestroy =
				(await getComputeDevice()) === device;
		}
	} finally {
		for (const t of made) t.destroy();
	}
	return out;
}
