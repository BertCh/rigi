// Parity / speed / VRAM bench of the haze graph path (./haze-graph.ts) against the dispatch path
// (./haze.ts), on the look inputs captured from a live engine (capture.ts). Run in the page by
// scripts/gpu/look-bench.mjs --module /src/lib/gpu/look/haze-graph-bench.ts --fn runHazeGraphBench.
// "identical" = the two HazeFits are equal number for number (JSON, samples included).
// - graph vs dispatch on the captured input, with the adaptive head and with a forced 64-slot head;
// - reuse with different data: the same N (a perturbed photo / sky: cache hit) and another N (a crop:
//   a second cached graph), interleaved, each against the dispatch path on the same input;
// - fitHazeFromPrep on textures.ts's prep (array path and texture path) vs fitHazeGpu, and vs the CPU;
// - the clear rule: the prep graph without its clear nodes must fail compile();
// - ms: median of `reps` after a warm-up; VRAM: pooled bytes + graph transients (physical).
import { Buffer, type Device, Texture } from "@luma.gl/core";
import { fitHaze, type HazeFit, type HazeFitInput } from "../../look/haze-fit";
import { cachedGraph, releaseCachedGraphs } from "../core/graph";
import { poolStats, releasePool } from "../core/pool";
import { getComputeDevice } from "../device";
import { captureLookInputs } from "./capture";
import { fitHazeGpu, hazeGpuTimes, K_HZ_BIN, K_HZ_HIST } from "./haze";
import {
	fitHazeFromPrep,
	hazeGraphStats,
	prepAndFitHazeTex,
} from "./haze-graph";
import { hazePrepArrays, hazePrepTex } from "./textures";

const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

async function time<T>(reps: number, f: () => Promise<T>) {
	let out = await f();
	const ts: number[] = [];
	for (let i = 0; i < reps; i++) {
		const t = performance.now();
		out = await f();
		ts.push(performance.now() - t);
	}
	return { ms: +median(ts).toFixed(2), out };
}

const sameFit = (a: HazeFit, b: HazeFit) =>
	JSON.stringify(a) === JSON.stringify(b);

/** The largest relative difference over the fit's scalar and vector fields (vs the CPU twin). */
function maxRel(c: HazeFit, g: HazeFit) {
	let m = 0;
	const rel = (a: number, b: number) =>
		Math.abs(a - b) / Math.max(1e-12, Math.abs(a));
	for (const k of ["visibility", "quality", "rms", "betaM", "hM"] as const)
		m = Math.max(m, rel(c[k], g[k]));
	for (const k of ["airlight", "betaR", "j0", "beta"] as const)
		for (let i = 0; i < 3; i++) m = Math.max(m, rel(c[k][i], g[k][i]));
	return m;
}

/** A W' × H' crop (x ≥ x0, rows kept from the top) of an xyzr input: another N, other data. */
function crop(h: HazeFitInput, dx: number, dy: number): HazeFitInput {
	if (h.geo.kind !== "xyzr") return h;
	const W = h.geoW - dx;
	const H = h.geoH - dy;
	const src = h.geo.data;
	const data = new Float32Array(W * H * 4);
	// geo row 0 = bottom: keep the top H rows of the image = geo rows dy … geoH − 1
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			for (let c = 0; c < 4; c++)
				data[(y * W + x) * 4 + c] = src[((y + dy) * h.geoW + x + dx) * 4 + c];
	const pw = 2 * W;
	const ph = 2 * H;
	const p = new Uint8ClampedArray(pw * ph * 4);
	const sw = h.photo.width;
	for (let y = 0; y < ph; y++)
		for (let x = 0; x < pw; x++)
			for (let c = 0; c < 4; c++)
				p[(y * pw + x) * 4 + c] = h.photo.data[(y * sw + x + 2 * dx) * 4 + c];
	return {
		...h,
		geo: { kind: "xyzr", data },
		geoW: W,
		geoH: H,
		photo: { width: pw, height: ph, data: p },
	};
}

/** Same shape, other data: the photo's channels rotated and darkened, the sky mask shifted. */
function perturb(h: HazeFitInput): HazeFitInput {
	const d = h.photo.data;
	const p = new Uint8ClampedArray(d.length);
	for (let i = 0; i < d.length; i += 4) {
		p[i] = (d[i + 1] * 7) >> 3;
		p[i + 1] = (d[i + 2] * 7) >> 3;
		p[i + 2] = (d[i] * 7) >> 3;
		p[i + 3] = 255;
	}
	const m = h.sky;
	const sky = m && {
		...m,
		data: Uint8Array.from(m.data, (_, i) =>
			i % m.width < 3 ? 0 : m.data[i - 3],
		),
	};
	return { ...h, photo: { ...h.photo, data: p }, sky };
}

/** fitHazeGpu's CPU-built prep arrays (as haze.ts / textures-bench.ts; xyzr geometry). */
function prepArrays(h: HazeFitInput) {
	const { geoW: W, geoH: H, sky, foreground: fg } = h;
	const N = W * H;
	const g = h.geo.data;
	const range = new Float32Array(N);
	const pSky = new Float32Array(N);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			range[y * W + x] = g[((H - 1 - y) * W + x) * 4 + 3];
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
	return { W, H, photo: h.photo, range, pSky, fgBits, hasFg: !!fg };
}

function texture(
	device: Device,
	format: "rgba32float" | "rgba8unorm" | "r8unorm",
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

/** The clear rule is enforced: the prep graph's atomic transients without clear nodes fail compile(). */
function clearLint(device: Device) {
	const out: Record<string, string> = {};
	for (const which of ["counts", "hist"] as const) {
		const e = cachedGraph(device, "look-haze-lint", which, (g) => {
			const u = g.importBuffer(
				"u",
				48,
				undefined,
				Buffer.UNIFORM | Buffer.COPY_DST,
			);
			const s = (id: string) => g.transientBuffer(id, 1024);
			const [flagsH, range, psky, bins, counts, lin, state, hist] = [
				"flagsH",
				"range",
				"psky",
				"bins",
				"counts",
				"lin",
				"state",
				"hist",
			].map(s);
			if (which === "hist") g.clearNode("clear-counts", counts);
			g.addKernel({
				id: "bin",
				spec: K_HZ_BIN,
				bindings: { prm: u, flagsH, range, psky, bins, counts },
				workgroups: [1],
				writes: { counts: "atomic" },
			});
			g.addKernel({
				id: "hist",
				spec: K_HZ_HIST,
				bindings: { prm: u, bins, lin, state, hist },
				workgroups: [1],
				writes: { hist: "atomic" },
			});
			return undefined;
		});
		try {
			e.graph.compile();
			out[which] = "compiled (NOT refused)";
		} catch (err) {
			out[which] = String((err as Error).message).replace(
				/^.*clear lint: /,
				"",
			);
		}
	}
	void releaseCachedGraphs(device, "look-haze-lint");
	return out;
}

export async function runHazeGraphBench(
	engine: unknown,
	opts: { reps?: number; label?: string } = {},
) {
	const reps = opts.reps ?? 7;
	const device = await getComputeDevice();
	if (!device) return { error: "no WebGPU compute device" };
	const inp = captureLookInputs(engine, opts.label);
	const h = inp.haze;
	if (!h) return { source: inp.source, error: "no haze input" };
	const out: Record<string, unknown> = {
		source: inp.source,
		dims: [h.geoW, h.geoH],
		geo: h.geo.kind,
	};
	const old = await fitHazeGpu(device, h);
	const oldSteps = { ...hazeGpuTimes };

	// 1. graph vs dispatch (first run = the device's first head estimate, then adaptive)
	const g1 = await fitHazeGpu(device, h, { graph: true });
	const s1 = { ...hazeGraphStats };
	const g2 = await fitHazeGpu(device, h, { graph: true });
	const s2 = { ...hazeGraphStats };
	const gf = await fitHazeGpu(device, h, { graph: true, listHead: 64 });
	const sf = { ...hazeGraphStats };
	const oldForced = await fitHazeGpu(device, h, { listHead: 64 });
	out.parity = {
		identical: sameFit(old, g1) && sameFit(old, g2),
		firstRun: {
			head: s1.head,
			total: s1.total,
			tail: s1.tail,
			hit: s1.cacheHit,
		},
		adaptive: {
			head: s2.head,
			total: s2.total,
			tail: s2.tail,
			hit: s2.cacheHit,
		},
		forcedTail: {
			head: sf.head,
			tail: sf.tail,
			identical: sameFit(old, gf),
			dispatchForcedIdentical: sameFit(old, oldForced),
		},
		samples: old.samples.length,
		vsCpuMaxRel: maxRel(fitHaze(h), g1),
	};

	// 2. reuse with different data and shapes (interleaved; each vs the dispatch path)
	const B = perturb(h);
	const C = crop(h, 37, 21);
	const seq: [string, HazeFitInput][] = [
		["B same N", B],
		["C other N", C],
		["A again", h],
		["C again", C],
		["B again", B],
	];
	const reuse: Record<string, unknown>[] = [];
	for (const [name, x] of seq) {
		const a = await fitHazeGpu(device, x);
		const b = await fitHazeGpu(device, x, { graph: true });
		reuse.push({
			name,
			N: x.geoW * x.geoH,
			hit: hazeGraphStats.cacheHit,
			tail: hazeGraphStats.tail,
			samples: a.samples.length,
			identical: sameFit(a, b),
			differsFromA: !sameFit(a, old),
		});
	}
	out.reuse = reuse;

	// 3. fitHazeFromPrep on textures.ts's prep: array path and texture path
	const fromPrep: Record<string, unknown> = {};
	const cpu = fitHaze(h);
	if (h.geo.kind === "xyzr") {
		const arrays = prepArrays(h);
		const geoIn = { geo: h.geo, eyeAlt: h.eyeAlt, sunDir: h.sunDir };
		const fa = await fitHazeFromPrep(
			device,
			await hazePrepArrays(device, arrays),
			geoIn,
		);
		const made: Texture[] = [];
		const tex = (...a: Parameters<typeof texture>) => {
			const t = texture(...a);
			made.push(t);
			return t;
		};
		const input = {
			geometry: {
				texture: tex(device, "rgba32float", h.geoW, h.geoH, h.geo.data),
				flipY: true,
			},
			photo: tex(
				device,
				"rgba8unorm",
				h.photo.width,
				h.photo.height,
				new Uint8Array(
					h.photo.data.buffer,
					h.photo.data.byteOffset,
					h.photo.data.byteLength,
				),
			),
			sky: h.sky
				? tex(
						device,
						"r8unorm",
						h.sky.width,
						h.sky.height,
						Uint8Array.from(h.sky.data),
					)
				: null,
			fg: h.foreground
				? tex(
						device,
						"r8unorm",
						h.foreground.width,
						h.foreground.height,
						Uint8Array.from(h.foreground.data),
					)
				: null,
			step: 1,
		};
		try {
			const ft = await fitHazeFromPrep(
				device,
				await hazePrepTex(device, input),
				geoIn,
			);
			const ftForced = await fitHazeFromPrep(
				device,
				await hazePrepTex(device, input),
				geoIn,
				{ listHead: 64 },
			);
			const tail = hazeGraphStats.tail;
			// prep + fit under one lease (the bridge's entry point)
			const fc = await prepAndFitHazeTex(device, input, geoIn);
			const tArr = await time(reps, async () =>
				fitHazeFromPrep(device, await hazePrepArrays(device, arrays), geoIn),
			);
			const tTex = await time(reps, async () =>
				fitHazeFromPrep(device, await hazePrepTex(device, input), geoIn),
			);
			Object.assign(fromPrep, {
				arrays: { identical: sameFit(old, fa), ms: tArr.ms },
				tex: {
					identical: sameFit(old, ft),
					forcedTail: { tail, identical: sameFit(old, ftForced) },
					ms: tTex.ms,
				},
				combined: { identical: !!fc && sameFit(old, fc) },
				vsCpuMaxRel: maxRel(cpu, ft),
				gpuVsCpuMaxRel: maxRel(cpu, old),
			});
		} finally {
			for (const t of made) t.destroy();
		}
	} else fromPrep.skipped = "geo kind is not xyzr";
	out.fromPrep = fromPrep;

	// 4. the clear rule
	out.clearLint = clearLint(device);

	// 5. timings: dispatch and graph interleaved (cached graph, adaptive head), median of 2·reps each
	const tD: number[] = [];
	const tG: number[] = [];
	const pD: number[] = [];
	const pG: number[] = [];
	for (let i = 0; i < 2 * reps; i++) {
		let t = performance.now();
		await fitHazeGpu(device, h);
		tD.push(performance.now() - t);
		pD.push(hazeGpuTimes.gpuPrep);
		t = performance.now();
		await fitHazeGpu(device, h, { graph: true });
		tG.push(performance.now() - t);
		pG.push(hazeGpuTimes.gpuPrep);
	}
	const oldT = { ...hazeGpuTimes };
	await fitHazeGpu(device, h);
	const dT = { ...hazeGpuTimes };
	out.ms = {
		dispatch: +median(tD).toFixed(2),
		graph: +median(tG).toFixed(2),
		dispatchPrep: +median(pD).toFixed(2),
		graphPrep: +median(pG).toFixed(2),
		dispatchReadKB: dT.readKB,
		graphReadKB: oldT.readKB,
		graphTail: oldT.tailRead,
		firstDispatchReadKB: oldSteps.readKB,
	};

	// 6. VRAM: pooled bytes (+ graph transients) of one fit on each path, from a released state
	const vram = async (graph: boolean) => {
		releasePool(device, "look-haze/");
		await releaseCachedGraphs(device, "look-haze-prep");
		await releaseCachedGraphs(device, "look-haze-grid");
		const base = poolStats(device).bytes;
		await fitHazeGpu(device, h, { graph });
		const pooled = poolStats(device).bytes - base;
		const tr = graph
			? (hazeGraphStats.transientBytes?.physical ?? 0) + 5550 * 4
			: 0;
		const logical = graph
			? (hazeGraphStats.transientBytes?.logical ?? 0) + 5550 * 4
			: 0;
		return {
			pooled,
			transientPhysical: tr,
			transientLogical: logical,
			total: pooled + tr,
		};
	};
	out.vram = { dispatch: await vram(false), graph: await vram(true) };
	return out;
}
