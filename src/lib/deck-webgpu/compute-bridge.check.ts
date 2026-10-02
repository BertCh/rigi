// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Parity + latency check of compute-bridge.ts inside a live WebGpuEngine (the lab page):
//   await (await import('/src/lib/deck-webgpu/compute-bridge.check.ts')).runBridgeCheck(window.__engine)
// For the engine's current pose / style / masks it runs each look pass both ways on the SAME
// geometry buffer and compares the outputs bit for bit:
//   masks  readback path = a fresh CompositeLook.updateMasks (range grid read back + photoPixels →
//          guided filters → RGBA8 bytes) vs a fresh LookBridge.updateMasks → its texture read back
//   stats  readLayer (offscreen colour → readTexture → CPU) + CompositeLook.setStats vs
//          renderLayer → LookBridge.setStats on the colour target
//   haze   hazePrepArrays(HazeController's ×2 decimation + fitHazeGpu's input build from the
//          range readback) vs LookBridge.hazePrep on the geometry target
//   fit    the whole HazeFit (JSON): a fresh HazeController on the readback path (range readback →
//          fitHazeGpu) vs one with `bridged` = LookBridge.fitHaze (prepAndFitHazeTex on the target),
//          plus the engine's live fit, the bridged fit's stage medians (fit.stagesMs, haze.ts
//          hazeGpuTimes); and the guards (stale prep, wrong geo size) reject; and the GPU airlight
//          band (the GPU band, haze-band.ts, default on) vs the CPU band on the bridged path: its
//          fit (bandExact), what the band did (band: "gpu" = used) and both paths' stage medians
//   relief the readback path (buildReliefFieldGpu: relief graph → read node → bytes, uploaded with
//          TerrainStyles.setReliefField's descriptor + writeData) vs LookBridge.reliefField (the
//          same graph → copyBufferToTexture), both textures read back, field + gen; plus the
//          engine's live resident field (if its pose / sun still match) and the lazy CPU copy
// and times each (median of `reps`, warm). The final look image is compared by the harness
// (scripts/deck-webgpu/bridge-check.mjs) with engine.setLookBridge(false / true).
import type { Device, Texture } from "@luma.gl/core";
import type { EnuFrame } from "#/lib/geodesy";
import { getComputeDevice } from "#/lib/gpu/device";
import { hazeGpuTimes } from "#/lib/gpu/look/haze";
import {
	fitHazeFromPrep,
	hazeArgminStats,
	hazeGraphStats,
	prepAndFitHazeTex,
} from "#/lib/gpu/look/haze-graph";
import { buildReliefFieldGpu } from "#/lib/gpu/look/relief";
import {
	type HazePrep,
	hazePrepArrays,
	hazePrepTex,
} from "#/lib/gpu/look/textures";
import type { Vec3 } from "#/lib/look/atmosphere";
import type { ColorStats } from "#/lib/look/color-stats";
import {
	blendCut,
	CompositeLook,
	gridSize,
	photoPixels,
	type RangeGrid,
	STATS_LONG_SIDE,
	trustedRange,
} from "#/lib/look/composite";
import {
	type BridgedHazeFit,
	HazeController,
	rangeGeo,
} from "#/lib/look/haze-controller";
import type { HazeFit, SkyMask } from "#/lib/look/haze-fit";
import type { ResidentReliefField } from "#/lib/look/relief/field";
import type { HeightTile } from "#/lib/look/relief/heights";
import type { ViewStyle } from "#/lib/style/types";
import { LookBridge, readRgba8 } from "./compute-bridge";
import type { WebGpuEngine } from "./engine";
import { WebGpuGeometrySource } from "./layers/geometry-source";

/** The engine internals the check reads (private in engine.ts). */
type Internals = {
	style: ViewStyle;
	settings: { mode: string; method: string; rangeKm: number; feather: number };
	photo: { hAccuracy?: number | null; width: number; height: number };
	photoImg?: HTMLImageElement;
	fgMask: SkyMask | null;
	skyMaskStore: SkyMask | null;
	geoSrc?: unknown;
	geoBufGen: number;
	brushVersion: number;
	aspect: number;
	eyeAlt: number;
	hazeFit: HazeFit | null;
	look(mode: "overlay"): { sunDir: Vec3 };
	terrain?: { tiles: readonly HeightTile[] };
	frame: EnuFrame;
	pose: { yaw: number };
	relief: { resident: ResidentReliefField | null };
	gpu: {
		device: Device;
		composite: { brushCanvas: HTMLCanvasElement };
		bridge: LookBridge | null;
	} | null;
	rangeGrid(): RangeGrid | null;
	readLayer(w: number, h: number): Promise<Float32Array | null>;
	renderLayer(
		w: number,
		h: number,
		consume: (c: Texture) => Promise<unknown>,
	): Promise<void>;
};

type Diff = { n: number; diff: number; max: number };
function diff(a: ArrayLike<number>, b: ArrayLike<number>): Diff {
	const n = Math.min(a.length, b.length);
	let d = 0;
	let max = 0;
	for (let i = 0; i < n; i++) {
		const x = a[i];
		const y = b[i];
		if (Object.is(x, y) || x === y || (Number.isNaN(x) && Number.isNaN(y)))
			continue;
		d++;
		const e = Math.abs(x - y);
		if (!(e <= max)) max = e;
	}
	return { n, diff: d + Math.abs(a.length - b.length), max };
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

export { readRgba8 };

function statsDiff(a: ColorStats | null, b: ColorStats | null) {
	if (!a || !b) return { exact: false, missing: !a ? "readback" : "bridge" };
	const keys = ["photoMean", "photoStd", "layerMean", "layerStd"] as const;
	const out: Record<string, unknown> = {
		count: diff(a.count, b.count),
		valid: a.valid === b.valid,
	};
	for (const k of keys) out[k] = diff(a[k], b[k]);
	const exact =
		(out.count as Diff).diff === 0 &&
		out.valid === true &&
		keys.every((k) => (out[k] as Diff).diff === 0);
	return {
		exact,
		validBoth: a.valid && b.valid,
		count: Array.from(a.count),
		...out,
	};
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

/** HazeController.update's decimation + fitHazeGpu's input build, from the range readback. */
function hazeArrays(
	range: Float32Array,
	w: number,
	h: number,
	sky: SkyMask | null,
	fg: SkyMask | null,
	img: HTMLImageElement,
) {
	const W = Math.floor(w / 2);
	const H = Math.floor(h / 2);
	// rangeGeo: row 0 = bottom, non-finite = 0; then the ×2 decimation
	const full = new Float32Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const r = range[(h - 1 - y) * w + x];
			full[y * w + x] = Number.isFinite(r) ? r : 0;
		}
	const small = new Float32Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) small[y * W + x] = full[y * 2 * w + x * 2];
	const N = W * H;
	const r = new Float32Array(N);
	const pSky = new Float32Array(N);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) r[y * W + x] = small[(H - 1 - y) * W + x];
	const at = (m: SkyMask, x: number, y: number) =>
		m.data[
			Math.min(m.height - 1, Math.floor(((y + 0.5) * m.height) / H)) * m.width +
				Math.min(m.width - 1, Math.floor(((x + 0.5) * m.width) / W))
		];
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			pSky[i] = sky ? at(sky, x, y) / 255 : r[i] > 0 ? 0 : 1;
		}
	const fgBits = new Uint32Array(Math.ceil(N / 32));
	if (fg)
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++)
				if (at(fg, x, y) > 64) {
					const i = y * W + x;
					fgBits[i >> 5] |= 1 << (i & 31);
				}
	const px = photoPixels(img, W * 2, H * 2);
	return {
		W,
		H,
		photo: { width: px.width, height: px.height, data: px.data },
		range: r,
		pSky,
		fgBits,
		hasFg: !!fg,
	};
}

export async function runBridgeCheck(engine: WebGpuEngine, reps = 7) {
	const e = engine as unknown as Internals;
	await engine.readback();
	const g = e.gpu;
	const img = e.photoImg;
	const src = e.geoSrc;
	const grid = e.rangeGrid();
	if (!g || !img || !grid || !(src instanceof WebGpuGeometrySource))
		return { error: "engine not ready (gpu / photo / GPU geometry source)" };
	const device = g.device;
	const same = (await getComputeDevice()) === device;
	const geometry = src.targets.geometry;
	const style = e.style;
	const fg = e.fgMask;
	const sky = e.skyMaskStore;
	const cut =
		e.settings.mode === "replace"
			? blendCut(e.settings, g.composite.brushCanvas, e.brushVersion)
			: null;
	const refineStyle: ViewStyle = {
		...style,
		composite: { ...style.composite, refine: true },
	};
	let gen = 1e6;

	// ── masks
	const maskRef = async () => {
		const L = new CompositeLook();
		L.setSky(sky);
		const done = new Promise<void>((r) => {
			L.onAsync = r;
		});
		const t0 = performance.now();
		L.updateMasks({
			style: refineStyle,
			gen: ++gen,
			img,
			fg,
			cut,
			geo: () => grid,
		});
		const cpuMs = performance.now() - t0;
		await done;
		const m = L.masks as NonNullable<CompositeLook["masks"]>;
		// the composite then uploads the bytes as its mask texture (composite.ts rgbaTexture)
		const tex = device.createTexture({
			format: "rgba8unorm",
			width: m.w,
			height: m.h,
			usage: 0x04 | 0x02,
		});
		tex.writeData(m.data as never, {
			width: m.w,
			height: m.h,
			bytesPerRow: m.w * 4,
		});
		const ms = performance.now() - t0;
		tex.destroy();
		return { m, ms, cpuMs };
	};
	const bridge = new LookBridge(device);
	const maskBridge = async () => {
		const done = new Promise<void>((r) => {
			bridge.onAsync = r;
		});
		const t0 = performance.now();
		bridge.updateMasks({
			style: refineStyle,
			gen: ++gen,
			img,
			fg,
			sky,
			cut,
			geometry,
			range: () => grid,
		});
		const cpuMs = performance.now() - t0;
		await done;
		return {
			m: bridge.masks as NonNullable<LookBridge["masks"]>,
			ms: performance.now() - t0,
			cpuMs,
		};
	};
	const a = await maskRef();
	const b = await maskBridge();
	const bBytes = await readRgba8(device, b.m.texture);
	const masks: Record<string, unknown> = {
		size: [a.m.w, a.m.h],
		sameSize: a.m.w === b.m.w && a.m.h === b.m.h,
		bytes: diff(a.m.data, bBytes),
		coverageMean:
			a.m.data.reduce((s, v, i) => (i % 4 === 0 ? s + v : s), 0) /
			(a.m.w * a.m.h * 255),
		cut: !!cut,
		people: !!fg,
		sky: !!sky && style.composite.sky === "photo",
	};
	// the engine's own live masks (if bridged) against the same reference
	const live = e.gpu?.bridge?.masks;
	if (live && live.gen === e.geoBufGen)
		masks.live = diff(a.m.data, await readRgba8(device, live.texture));
	const mt = {
		ref: [] as number[],
		refCpu: [] as number[],
		bridge: [] as number[],
		bridgeCpu: [] as number[],
	};
	for (let i = 0; i < reps; i++) {
		const r = await maskRef();
		const s = await maskBridge();
		mt.ref.push(r.ms);
		mt.refCpu.push(r.cpuMs);
		mt.bridge.push(s.ms);
		mt.bridgeCpu.push(s.cpuMs);
	}

	// ── band stats
	const [sw, sh] = gridSize(e.aspect, STATS_LONG_SIDE);
	const minRange = trustedRange(e.photo.hAccuracy);
	const statsRef = async () => {
		const t0 = performance.now();
		const layer = await e.readLayer(sw, sh);
		if (!layer) return { st: null, ms: 0 };
		const L = new CompositeLook();
		const done = new Promise<void>((r) => {
			L.onAsync = r;
		});
		L.setStats({
			key: `check-${++gen}`,
			img,
			layer,
			w: sw,
			h: sh,
			geo: grid,
			fg,
			minRange,
		});
		await done;
		return { st: L.stats, ms: performance.now() - t0, layer };
	};
	const statsBridge = async () => {
		const t0 = performance.now();
		let st: ColorStats | null = null;
		await e.renderLayer(sw, sh, async (color) => {
			st = await bridge.setStats({
				key: `check-${++gen}`,
				img,
				layer: color,
				geometry,
				fg,
				minRange,
			});
		});
		return { st: st as ColorStats | null, ms: performance.now() - t0 };
	};
	const sa = await statsRef();
	const sb = await statsBridge();
	// texels whose alpha is in (0.98, 1): readLayer un-premultiplies them before setStats, and the
	// stats kernel divides by alpha again (bandInputs takes a premultiplied layer)
	let partial = 0;
	if (sa.layer)
		for (let i = 3; i < sa.layer.length; i += 4)
			if (sa.layer[i] > 0.98 && sa.layer[i] < 1) partial++;
	const stats = {
		...statsDiff(sa.st, sb.st),
		partialAlphaTexels: partial,
		size: [sw, sh],
	};
	const st = { ref: [] as number[], bridge: [] as number[] };
	for (let i = 0; i < reps; i++) {
		st.ref.push((await statsRef()).ms);
		st.bridge.push((await statsBridge()).ms);
	}

	// ── haze prep
	const hz = hazeArrays(src.range, src.width, src.height, sky, fg, img);
	const ha = (await hazePrepArrays(device, hz, { read: true }))
		.data as HazePrep;
	const hb = (await bridge.hazePrep({ img, geometry, sky, fg, read: true }))
		.data as HazePrep;
	const haze = { ...hazeDiff(ha, hb), size: [hz.W, hz.H] };
	const ht = { ref: [] as number[], bridge: [] as number[] };
	const idle = () =>
		(
			device as unknown as {
				handle: { queue: { onSubmittedWorkDone(): Promise<void> } };
			}
		).handle.queue.onSubmittedWorkDone();
	for (let i = 0; i < reps; i++) {
		let t0 = performance.now();
		const arr = hazeArrays(src.range, src.width, src.height, sky, fg, img);
		await hazePrepArrays(device, arr);
		await idle();
		ht.ref.push(performance.now() - t0);
		t0 = performance.now();
		await bridge.hazePrep({ img, geometry, sky, fg });
		await idle();
		ht.bridge.push(performance.now() - t0);
	}

	// ── the whole haze fit: HazeController readback path vs bridged (prep + fit, one lease)
	const pose = (src as WebGpuGeometrySource).pose;
	const sunDir = e.look("overlay").sunDir;
	const fitVia = async (bridged?: BridgedHazeFit) => {
		const hc = new HazeController();
		hc.setSky(sky);
		const t0 = performance.now();
		const landed = new Promise<HazeFit | null>((r) => {
			hc.onAsync = r;
		});
		hc.update({
			style,
			pose: pose as NonNullable<typeof pose>,
			img,
			eyeAlt: e.eyeAlt,
			sunDir,
			fg,
			geo: () => ({
				geo: rangeGeo(src.range, src.width, src.height, pose as never),
				w: src.width,
				h: src.height,
			}),
			bridged,
		});
		const fit = await landed;
		await idle();
		return { fit, ms: performance.now() - t0 };
	};
	const viaBridgeWith =
		(o: { bandGpu?: boolean; argminGpu?: boolean }): BridgedHazeFit =>
		(h) =>
			bridge.fitHaze({ img, geometry, ...h, ...o });
	const viaBridge = viaBridgeWith({});
	const fr = await fitVia();
	const fb = await fitVia(viaBridge);
	// the GPU airlight band (default on) vs the CPU band, on the same bridged path
	const fbb = await fitVia(viaBridgeWith({ bandGpu: true }));
	const bandOutcome = hazeGraphStats.band ?? null;
	const fbc = await fitVia(viaBridgeWith({ bandGpu: false }));
	// the default bridged fit (GPU band + the grid arg-min program) vs the pre-2026-10-01 default
	// (CPU band, whole grid read back)
	const argminOutcome = { ...hazeArgminStats };
	const fOld = await fitVia(
		viaBridgeWith({ bandGpu: false, argminGpu: false }),
	);
	const json = (f: HazeFit | null) => JSON.stringify(f);
	const liveFit = e.hazeFit;
	const fit = {
		exact: !!fr.fit && json(fr.fit) === json(fb.fit),
		/** the GPU-band path's fit = the readback path's, and what the band did ("gpu" = used) */
		bandExact: !!fr.fit && json(fr.fit) === json(fbb.fit),
		/** the CPU-band bridged path's fit = the readback path's */
		cpuBandExact: !!fr.fit && json(fr.fit) === json(fbc.fit),
		band: bandOutcome,
		/** the default bridged fit = the old default's (CPU band, whole grid), and the arg-min's stats */
		oldDefaultExact: !!fb.fit && json(fb.fit) === json(fOld.fit),
		argmin: argminOutcome,
		live: liveFit ? json(liveFit) === json(fr.fit) : null,
		bridgeOn: !!e.gpu?.bridge,
		visibility: fr.fit?.visibility ?? null,
		quality: fr.fit?.quality ?? null,
		guards: {} as Record<string, string>,
	};
	// guards: a fit from a prep that another prep superseded, and a geo of the wrong size
	{
		const W = Math.floor(geometry.width / 2);
		const H = Math.floor(geometry.height / 2);
		const tin = {
			geometry,
			photo: bridge.photoTexture(img, W * 2, H * 2),
			step: 2,
		};
		const geoIn = {
			geo: {
				kind: "range" as const,
				data: new Float32Array(W * H),
				ray: () => [0, 0, 1] as Vec3,
			},
			eyeAlt: e.eyeAlt,
			sunDir,
		};
		const p1 = await hazePrepTex(device, tin);
		await hazePrepTex(device, tin);
		const msg = (p: Promise<unknown>) =>
			p.then(
				() => "resolved",
				(err) => String(err?.message ?? err).slice(0, 120),
			);
		fit.guards.stalePrep = await msg(fitHazeFromPrep(device, p1, geoIn));
		fit.guards.wrongGeo = await msg(
			prepAndFitHazeTex(device, tin, {
				...geoIn,
				geo: { ...geoIn.geo, data: new Float32Array(W * H - 1) },
			}),
		);
		fit.guards.invalid = await msg(
			prepAndFitHazeTex(device, tin, geoIn, { valid: () => false }),
		);
	}
	const fitT = {
		ref: [] as number[],
		bridge: [] as number[],
		bridgeCpuBand: [] as number[],
	};
	// the bridged fit's stages (haze.ts hazeGpuTimes: the GPU part incl. the prep and, on the GPU
	// band path, the band; the CPU tail), per band path ("gpuBand." = default, "cpuBand." = off)
	const fitStages: Record<string, number[]> = {};
	const stage = (path: string) => {
		for (const k of [
			"gpuPrep",
			"cpuBins",
			"cpuFreeBeta",
			"gpuGrid",
			"cpuRefine",
		]) {
			const key = `${path}.${k}`;
			fitStages[key] = [
				...(fitStages[key] ?? []),
				hazeGpuTimes[k] ?? Number.NaN,
			];
		}
	};
	// hazeGpuTimes is merged, not replaced: clear the previous fit's keys (a short fit sets fewer)
	const clearTimes = () => {
		for (const k of Object.keys(hazeGpuTimes)) delete hazeGpuTimes[k];
	};
	for (let i = 0; i < reps; i++) {
		fitT.ref.push((await fitVia()).ms);
		clearTimes();
		fitT.bridge.push((await fitVia(viaBridgeWith({ bandGpu: true }))).ms);
		stage("gpuBand");
		clearTimes();
		fitT.bridgeCpuBand.push(
			(await fitVia(viaBridgeWith({ bandGpu: false }))).ms,
		);
		stage("cpuBand");
	}
	(fit as Record<string, unknown>).stagesMs = Object.fromEntries(
		Object.entries(fitStages).map(([k, v]) => {
			const timed = v.filter(Number.isFinite);
			return [k, timed.length ? +median(timed).toFixed(2) : null];
		}),
	);
	// ── relief: readback path (bytes → writeData) vs bridge (graph → copyBufferToTexture)
	const relief: Record<string, unknown> = { ran: false };
	const rt = { ref: [] as number[], bridge: [] as number[] };
	const tiles = e.terrain?.tiles ?? [];
	if (tiles.length) {
		// ReliefController.update's yaw snap
		const yaw = (Math.round(e.pose.yaw / 30) * 30 + 360) % 360;
		const upload = (res: number, data: Uint8Array) => {
			// TerrainStyles.setReliefField's texture, + COPY_SRC to read it back
			const t = device.createTexture({
				format: "rgba8unorm",
				width: res,
				height: res,
				usage: 0x04 | 0x02 | 0x01,
			});
			t.writeData(data as never, {
				width: res,
				height: res,
				bytesPerRow: res * 4,
			});
			return t;
		};
		const reliefRef = async () => {
			const t0 = performance.now();
			const f = await buildReliefFieldGpu(device, tiles, e.frame, sunDir, yaw);
			const tf = upload(f.res, f.field);
			const tg = upload(f.res, f.gen);
			await idle();
			return { f, tf, tg, ms: performance.now() - t0 };
		};
		const reliefBridge = async () => {
			const t0 = performance.now();
			const r = await bridge.reliefField({
				tiles,
				frame: e.frame,
				sunDir,
				yawDeg: yaw,
			});
			await idle();
			return { r, ms: performance.now() - t0 };
		};
		const ra = await reliefRef();
		const rb = await reliefBridge();
		if (rb.r) {
			const [af, ag, bf, bg] = await Promise.all([
				readRgba8(device, ra.tf),
				readRgba8(device, ra.tg),
				readRgba8(device, rb.r.textures.field),
				readRgba8(device, rb.r.textures.gen),
			]);
			const lazy = await rb.r.read();
			relief.ran = true;
			relief.res = rb.r.res;
			relief.extent =
				JSON.stringify(ra.f.extent) === JSON.stringify(rb.r.extent);
			relief.field = diff(af, bf);
			relief.gen = diff(ag, bg);
			// the uploaded texture vs the bytes it came from (the readback path itself)
			relief.refUpload = diff(ra.f.field, af).diff + diff(ra.f.gen, ag).diff;
			relief.lazy =
				diff(ra.f.field, lazy.field).diff + diff(ra.f.gen, lazy.gen).diff;
			const live = e.relief.resident;
			if (live && JSON.stringify(live.extent) === JSON.stringify(ra.f.extent))
				relief.live =
					diff(af, await readRgba8(device, live.textures.field)).diff +
					diff(ag, await readRgba8(device, live.textures.gen)).diff;
			rb.r.dispose();
		} else relief.error = "bridge returned null";
		ra.tf.destroy();
		ra.tg.destroy();
		for (let i = 0; i < reps; i++) {
			const a2 = await reliefRef();
			a2.tf.destroy();
			a2.tg.destroy();
			rt.ref.push(a2.ms);
			const b2 = await reliefBridge();
			b2.r?.dispose();
			rt.bridge.push(b2.ms);
		}
	}
	const reliefExact =
		relief.ran === true &&
		relief.extent === true &&
		(relief.field as Diff).diff === 0 &&
		(relief.gen as Diff).diff === 0 &&
		relief.refUpload === 0 &&
		relief.lazy === 0;

	bridge.destroy();

	const med = (o: Record<string, number[]>) =>
		Object.fromEntries(
			Object.entries(o).map(([k, v]) => [k, +median(v).toFixed(2)]),
		);
	return {
		sameDevice: same,
		geometry: [geometry.width, geometry.height],
		masks,
		stats,
		haze,
		fit,
		relief,
		exact: {
			masks: (masks.bytes as Diff).diff === 0 && masks.sameSize === true,
			stats: stats.exact,
			haze: haze.exact,
			fit: fit.exact,
			fitBand: fit.bandExact,
			fitCpuBand: fit.cpuBandExact,
			fitOldDefault: fit.oldDefaultExact,
			relief: reliefExact,
		},
		ms: {
			masks: med(mt),
			stats: med(st),
			haze: med(ht),
			fit: med(fitT),
			relief: rt.ref.length ? med(rt) : null,
		},
	};
}
