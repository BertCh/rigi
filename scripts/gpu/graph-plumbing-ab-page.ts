// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Page side of scripts/gpu/graph-plumbing-ab.mjs (WAG graph plumbing): the two page-device modules
// that moved from raw dispatches onto core ComputeGraphs (deck-webgpu/silhouette-gpu.ts,
// deck-webgpu/geo-query-gpu.ts) against a replica of their former raw-dispatch path
// (same kernel specs, fetched with definedKernels; same buffers, bindings, dispatch sizes, one
// encoder, core submit + stageReads), on the same inputs:
// - BIT: the read-back bytes (silhouette masks; verdict / skyline / gather words, nonces included)
//   must be identical, byte for byte;
// - timing: wall ms from the call to its result graph vs raw, interleaved, median / p90 over `reps`.
// Synthetic inputs: rgba32float targets with layered ridge ranges plus zero / negative / denormal /
// Inf / NaN texels; random peak samples and thresholds.
import { Buffer, type Device, Texture } from "@luma.gl/core";
import {
	silGroups,
	silhouetteThresholds,
	silMaskWords,
} from "#/lib/deck/silhouette-mask";
import { GeoQueryGpu } from "#/lib/deck-webgpu/geo-query-gpu";
import { SilhouetteMaskGpu } from "#/lib/deck-webgpu/silhouette-gpu";
import {
	definedKernels,
	type KernelSpec,
	kernelAsync,
} from "#/lib/gpu/core/kernel";
import { submit } from "#/lib/gpu/core/queue";
import { stageReads } from "#/lib/gpu/core/readback";
import { dispatch } from "#/lib/gpu/core/test-dispatch";
import { getComputeDevice } from "#/lib/gpu/device";

const WG = 64;

const spec = (group: string, id: string): KernelSpec => {
	const s = definedKernels(group).find((k) => k.id === id);
	if (!s) throw new Error(`no kernel ${group}/${id}`);
	return s;
};

let seed = 12345;
const random = () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 4294967296;
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const p90 = (xs: number[]) =>
	[...xs].sort((a, b) => a - b)[
		Math.min(xs.length - 1, Math.floor(xs.length * 0.9))
	];
const summary = (xs: number[]) => ({
	median: median(xs),
	p90: p90(xs),
	min: Math.min(...xs),
	n: xs.length,
});

/** Run the graph and the raw call, graph first on even reps and raw first on odd ones; time each. */
async function both<G, R>(
	graphCall: () => Promise<G>,
	rawCall: () => Promise<R>,
	graphFirst: boolean,
) {
	const time = async <T>(f: () => Promise<T>) => {
		const t0 = performance.now();
		const value = await f();
		return { value, ms: performance.now() - t0 };
	};
	if (graphFirst) {
		const g = await time(graphCall);
		const r = await time(rawCall);
		return { graph: g.value, raw: r.value, graphMs: g.ms, rawMs: r.ms };
	}
	const r = await time(rawCall);
	const g = await time(graphCall);
	return { graph: g.value, raw: r.value, graphMs: g.ms, rawMs: r.ms };
}

const sameBytes = (a: ArrayBufferView, b: ArrayBufferView) => {
	if (a.byteLength !== b.byteLength) return false;
	const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
	const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
};

/** A synthetic geometry target: layered ridges (w = range, 0 = sky above the ridge) + odd texels. */
function makeTarget(device: Device, W: number, H: number, odd: boolean) {
	const data = new Float32Array(W * H * 4);
	const view = new Uint32Array(data.buffer);
	const phase = random() * 6;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			const ridge1 = H * (0.3 + 0.1 * Math.sin(x * 0.03 + phase));
			const ridge2 = H * (0.5 + 0.08 * Math.sin(x * 0.07 + 2 * phase));
			let r = 0;
			if (y >= ridge2) r = 2000 + 3000 * random();
			else if (y >= ridge1) r = 9000 + 20000 * random();
			data[i] = x;
			data[i + 1] = y;
			data[i + 2] = r * 0.01;
			data[i + 3] = r;
		}
	if (odd)
		for (let k = 0; k < (W * H) / 50; k++) {
			const i = Math.floor(random() * W * H) * 4 + 3;
			const kind = Math.floor(random() * 6);
			if (kind === 0) data[i] = 0;
			else if (kind === 1) data[i] = -data[i];
			else if (kind === 2)
				view[i] = 1 + Math.floor(random() * 0x7fffff); // denormal
			else if (kind === 3) data[i] = Number.POSITIVE_INFINITY;
			else if (kind === 4) data[i] = Number.NaN;
			else data[i] = data[i] * Math.exp((random() - 0.5) * 2);
		}
	const tex = device.createTexture({
		id: "ab-target",
		format: "rgba32float",
		width: W,
		height: H,
		usage: Texture.SAMPLE | Texture.COPY_DST,
	});
	tex.writeData(data);
	return tex;
}

// ── silhouette: the former SilhouetteMaskGpu.run, raw dispatches ─────────────────────────────────
async function silhouetteRaw(
	device: Device,
	ranges: Texture[],
	W: number,
	H: number,
	nonce: number,
	prms: Buffer[],
	outRef: { out: Buffer | null },
	thresholds: number[],
	groups: number,
) {
	const k = await kernelAsync(device, spec("silhouette", "silhouette-mask"));
	const per = silMaskWords(W, H);
	const bytes = per * ranges.length * 4;
	if (!outRef.out || outRef.out.byteLength < bytes) {
		outRef.out?.destroy();
		outRef.out = device.createBuffer({
			id: "ab-silhouette-out",
			byteLength: bytes,
			usage: Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST,
		});
	}
	const enc = device.createCommandEncoder({ id: "silhouette-mask-raw" });
	ranges.forEach((tex, i) => {
		const words = new ArrayBuffer(48);
		const iv = new Int32Array(words);
		const uv = new Uint32Array(words);
		const fv = new Float32Array(words);
		iv[0] = W;
		iv[1] = H;
		iv[2] = groups;
		uv[3] = i * per;
		uv[4] = nonce;
		fv.set(thresholds, 5);
		prms[i] ??= device.createBuffer({
			id: `ab-silhouette-prm-${i}`,
			byteLength: 48,
			usage: Buffer.UNIFORM | Buffer.COPY_DST,
		});
		prms[i].write(new Uint8Array(words));
		dispatch(
			enc,
			k,
			{ prm: prms[i], geo: tex, outp: outRef.out as Buffer },
			Math.ceil((groups * H) / WG),
		);
	});
	const st = stageReads(device, enc, [{ buffer: outRef.out, size: bytes }]);
	submit(device, enc);
	const [ab] = await st.read();
	return new Uint32Array(ab.slice(0, bytes));
}

// ── geo-query: the former GeoQueryGpu.run, one raw dispatch per kernel ──────────────────────────────
async function geoRaw(
	device: Device,
	which: "verdict" | "gather" | "skyline",
	tex: Texture,
	input: Uint32Array | null,
	n: number,
	outWords: number,
	nonce: number,
) {
	const k = await kernelAsync(device, spec("geo-query", `geo-${which}`));
	const bufs: Buffer[] = [];
	try {
		const words = new ArrayBuffer(16);
		new Uint32Array(words).set([n, nonce]);
		new Int32Array(words).set([tex.width, tex.height], 2);
		const prm = device.createBuffer({
			id: "geo-query-prm",
			usage: Buffer.UNIFORM | Buffer.COPY_DST,
			data: new Uint8Array(words),
		});
		bufs.push(prm);
		const out = device.createBuffer({
			id: "geo-query-out",
			byteLength: Math.max(16, outWords * 4),
			usage: Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST,
		});
		bufs.push(out);
		const bind: Record<string, Buffer | Texture> = { prm, geo: tex, outp: out };
		if (input) {
			const q = device.createBuffer({
				id: "geo-query-in",
				usage: Buffer.STORAGE | Buffer.COPY_DST,
				data: input,
			});
			bufs.push(q);
			bind.q = q;
		}
		const enc = device.createCommandEncoder({ id: `geo-query-raw-${which}` });
		dispatch(enc, k, bind, Math.ceil(n / WG));
		const bytes = outWords * 4;
		const st = stageReads(device, enc, [{ buffer: out, size: bytes }]);
		submit(device, enc);
		const [ab] = await st.read();
		return new Uint32Array(ab.slice(0, bytes));
	} finally {
		for (const b of bufs) b.destroy();
	}
}

type RawJob = {
	which: "verdict" | "gather" | "skyline";
	n: number;
	input: Uint32Array | null;
	outWords: number;
	nonce: number;
};
/** GeoQueryGpu's private graph run (the raw words, nonces included). */
const geoGraph = (q: GeoQueryGpu, tex: Texture, jobs: RawJob[]) =>
	(
		q as unknown as {
			run: (t: Texture, j: RawJob[]) => Promise<Uint32Array[] | null>;
		}
	).run(tex, jobs);

export async function runGraphPlumbingAb(reps: number) {
	const device = await getComputeDevice();
	if (!device) return { error: "no compute device" };
	const out: Record<string, unknown> = { adapter: device.info ?? null };
	const failures: string[] = [];

	// ── silhouette ──
	{
		const W = 384;
		const H = 288;
		const groups = silGroups(W);
		const poses = 12;
		const targets = Array.from({ length: poses }, (_, i) =>
			makeTarget(device, W, H, i % 2 === 1),
		);
		const t = silhouetteThresholds();
		const thresholds = [t.rmax, t.khi, t.klo, t.zlo, t.zhi, t.flo, t.fhi];
		const graph = new SilhouetteMaskGpu(device);
		const prms: Buffer[] = [];
		const outRef = { out: null as Buffer | null };
		let identical = 0;
		const graphMs: number[] = [];
		const rawMs: number[] = [];
		for (let r = 0; r < reps + 2; r++) {
			const nonce = 1 + (r % 0x7ffe);
			const t = await both(
				() => graph.run(targets, W, H, nonce),
				() =>
					silhouetteRaw(
						device,
						targets,
						W,
						H,
						nonce,
						prms,
						outRef,
						thresholds,
						groups,
					),
				r % 2 === 0,
			);
			const g = t.graph;
			if (g && sameBytes(g, t.raw)) identical++;
			else
				failures.push(`silhouette rep ${r}: graph ${g ? "differs" : "null"}`);
			if (r >= 2) {
				graphMs.push(t.graphMs);
				rawMs.push(t.rawMs);
			}
		}
		out.silhouette = {
			poses,
			W,
			H,
			bytesPerRun: silMaskWords(W, H) * poses * 4,
			identical,
			runs: reps + 2,
			graphMs: summary(graphMs),
			rawMs: summary(rawMs),
		};
		graph.destroy();
		for (const b of prms) b.destroy();
		outRef.out?.destroy();
		for (const tex of targets) tex.destroy();
	}

	// ── geo-query ──
	{
		const W = 1024;
		const H = 768;
		const tex = makeTarget(device, W, H, true);
		const q = new GeoQueryGpu(device);
		const results: Record<string, { identical: number; runs: number }> = {};
		const graphMs: number[] = [];
		const rawMs: number[] = [];
		const gatherGraphMs: number[] = [];
		const gatherRawMs: number[] = [];
		const note = (k: string, ok: boolean, detail: string) => {
			results[k] ??= { identical: 0, runs: 0 };
			results[k].runs++;
			if (ok) results[k].identical++;
			else failures.push(`geo-query ${k}: ${detail}`);
		};
		for (let r = 0; r < reps + 2; r++) {
			const peaks = 1 + Math.floor(random() * 60);
			const words = new Uint32Array(peaks * 6);
			const f = new Float32Array(1);
			const fu = new Uint32Array(f.buffer);
			for (let i = 0; i < peaks; i++) {
				words[i * 6] = Math.floor(random() * W);
				words[i * 6 + 1] = Math.floor(random() * H);
				words[i * 6 + 2] = Math.floor(random() * W);
				words[i * 6 + 3] = Math.floor(random() * H);
				f[0] = random() < 0.1 ? -1 : random() * 30000;
				words[i * 6 + 4] = fu[0];
			}
			const vNonce = 2 * r + 1;
			const sNonce = 2 * r + 2;
			const vs = await both(
				() =>
					geoGraph(q, tex, [
						{
							which: "verdict",
							n: peaks,
							input: words,
							outWords: peaks,
							nonce: vNonce,
						},
						{ which: "skyline", n: W, input: null, outWords: W, nonce: sNonce },
					]),
				() =>
					Promise.all([
						geoRaw(device, "verdict", tex, words, peaks, peaks, vNonce),
						geoRaw(device, "skyline", tex, null, W, W, sNonce),
					]),
				r % 2 === 0,
			);
			const g = vs.graph;
			const [rv, rs] = vs.raw;
			note("verdict", !!g && sameBytes(g[0], rv), g ? "differs" : "null");
			note("skyline", !!g && sameBytes(g[1], rs), g ? "differs" : "null");
			// skyline alone (a settle without peaks in frame)
			const gs = await geoGraph(q, tex, [
				{ which: "skyline", n: W, input: null, outWords: W, nonce: sNonce },
			]);
			note(
				"skyline-only",
				!!gs && sameBytes(gs[0], rs),
				gs ? "differs" : "null",
			);
			const px = 1 + Math.floor(random() * 40);
			const xy = new Uint32Array(px * 2);
			for (let i = 0; i < px; i++) {
				xy[2 * i] = Math.floor(random() * W);
				xy[2 * i + 1] = Math.floor(random() * H);
			}
			const ga = await both(
				() =>
					geoGraph(q, tex, [
						{
							which: "gather",
							n: px,
							input: xy,
							outWords: px * 5,
							nonce: vNonce,
						},
					]),
				() => geoRaw(device, "gather", tex, xy, px, px * 5, vNonce),
				r % 2 === 1,
			);
			const gg = ga.graph;
			const rg = ga.raw;
			note("gather", !!gg && sameBytes(gg[0], rg), gg ? "differs" : "null");
			if (r >= 2) {
				graphMs.push(vs.graphMs);
				rawMs.push(vs.rawMs);
				gatherGraphMs.push(ga.graphMs);
				gatherRawMs.push(ga.rawMs);
			}
		}
		// the public API decodes what the raw path decoded
		const api = await q.verdictsAndSkyline(tex, new Uint32Array(0));
		out.geoQuery = {
			W,
			H,
			results,
			apiSkylineRows: api.rows?.length ?? null,
			verdictsPlusSkyline: {
				graphOneSubmitMs: summary(graphMs),
				rawTwoSubmitsMs: summary(rawMs),
			},
			gather: { graphMs: summary(gatherGraphMs), rawMs: summary(gatherRawMs) },
		};
		q.destroy();
		tex.destroy();
	}

	const { listCachedGraphs } = await import("#/lib/gpu/core/graph");
	out.cachedGraphs = listCachedGraphs(device).map((g) => ({
		group: g.group,
		key: g.key,
		nodes: g.stats?.nodeCount,
	}));
	out.failures = failures;
	out.ok = failures.length === 0;
	return out;
}
