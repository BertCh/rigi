// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU yaw correlation of refinePose (src/lib/refine/fft-gpu.ts: four-step FFT on luma GPUFFT1D in a
// core ComputeGraph) against the f64 CPU twin (fft.ts / init.ts) on a real luma WebGPU device in node (Dawn).
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/refine-fft-dawn.ts
// (a) the four-step forward / inverse alone vs fft.ts on random signals (M = 8192, 2048, 512): max error
//     relative to the max magnitude; (b) correlateGpu vs correlateCpu and globalInitAsync(GPU) vs globalInit on
//     synthetic skyline problems: max |dC| / max |C|, top-mode dYaw difference (<= one grid step 360/M), mode set
//     agreement, PSR relative difference, NaN count; (c) refinePoseAsync vs refinePose: final camera yaw / pitch /
//     roll difference (<= 0.01 deg) and the accept decision. Also warm GPU vs CPU correlation time.
// Uses the new API (correlateGpu), so it does not run on the base tree. SKIP (exit 0) without DAWN_DIR;
// exit 1 on any tolerance failure.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type Device, Buffer as LumaBuffer } from "@luma.gl/core";
import { cameraFromAngles } from "../../src/lib/geo/camera";
import type { HorizonProfile } from "../../src/lib/geo/horizon";
import { projectSkylineRows } from "../../src/lib/geo/solve";
import { ComputeGraph } from "../../src/lib/gpu/core/graph";
import { GPUFFT1D } from "../../src/lib/gpu/core/luma";
import { adoptRenderDevice } from "../../src/lib/gpu/device";
import { fft, ifft } from "../../src/lib/refine/fft";
import {
	correlateGpu,
	K_DFT_FWD,
	K_DFT_INV,
	K_PACK,
	K_TWIDDLE_FWD,
	K_TWIDDLE_INV,
	verifiedSplit,
} from "../../src/lib/refine/fft-gpu";
import { FFT_U } from "../../src/lib/refine/fft-gpu.wgsl";
import {
	type FourStepPlan,
	permutedIndex,
	planFourStep,
	twiddleTable,
} from "../../src/lib/refine/fourstep";
import { refinePose, refinePoseAsync } from "../../src/lib/refine/index";
import {
	correlateCpu,
	DEFAULT_INIT,
	globalInit,
	globalInitAsync,
	type InitOptions,
	prepareInit,
} from "../../src/lib/refine/init";
import {
	columnsFromSkyline,
	paramsFromCamera,
} from "../../src/lib/refine/model";

const ID = "refine-fft-dawn";
const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log(`SKIP ${ID}: DAWN_DIR not set`);
	process.exit(0);
}
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
// keep the instance referenced: Dawn drops pipelines of a collected instance
const gpu = create([]);
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});
const { luma } = await import("@luma.gl/core");
const { webgpuAdapter } = await import("@luma.gl/webgpu");
const device = (await luma.createDevice({
	type: "webgpu",
	adapters: [webgpuAdapter],
	createCanvasContext: false,
} as never)) as Device;
adoptRenderDevice(device);
void gpu;

let failed = 0;
const fail = (m: string) => {
	failed++;
	console.log(`FAIL ${m}`);
};
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
const STORAGE = LumaBuffer.STORAGE | LumaBuffer.COPY_DST | LumaBuffer.COPY_SRC;
const UNIFORM = LumaBuffer.UNIFORM | LumaBuffer.COPY_DST;

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return (s / 2 ** 32) * 2 - 1;
	};
}

// ---------- (a) four-step alone ----------

const mkBuf = (data: Float32Array) => {
	const b = device.createBuffer({
		usage: STORAGE,
		byteLength: data.byteLength,
	});
	b.write(data);
	return b;
};

async function fourStepGpu(
	plan: FourStepPlan,
	dft: boolean,
	nSig: number,
	x: Float32Array,
	spec: Float32Array,
) {
	const { M, N1, N2 } = plan;
	const cbytes = nSig * M * 8;
	const u = device.createBuffer({
		usage: UNIFORM,
		byteLength: FFT_U.byteLength,
	});
	u.write(
		new Uint8Array(
			FFT_U.pack({ M, N1, N2, nSig, nPair: nSig, nShift: 1, S: 0 }),
		),
	);
	const tw = mkBuf(twiddleTable(M));
	const groups = (n: number): [number] => [Math.ceil(n / 256)];
	const bufs: Record<string, ReturnType<typeof mkBuf>> = { p: u, tw };
	// forward
	const gf = new ComputeGraph(device, `${ID}-fwd-${M}`);
	{
		const p = gf.importBuffer("p", FFT_U.byteLength, undefined, UNIFORM);
		const xi = gf.importBuffer("x", x.byteLength);
		const twi = gf.importBuffer("tw", M * 8);
		const A = gf.transientBuffer("a", cbytes);
		const B = gf.transientBuffer("b", cbytes);
		gf.addKernel({
			id: "pack",
			spec: K_PACK,
			bindings: { p, x: xi, a: A },
			workgroups: groups(nSig * M),
		});
		gf.add(
			new GPUFFT1D({
				id: "f1",
				input: gf.graph.createDataView(A, {
					format: "float32x2",
					length: nSig * M,
				}),
				output: gf.graph.createDataView(B, {
					format: "float32x2",
					length: nSig * M,
				}),
				length: N2,
				batchCount: (nSig * M) / N2,
				direction: "forward",
			}),
		);
		if (N1 > 1) {
			gf.addKernel({
				id: "tw",
				spec: K_TWIDDLE_FWD,
				bindings: { p, a: B, tw: twi, b: A },
				workgroups: groups(nSig * M),
			});
			if (dft)
				gf.addKernel({
					id: "dft",
					spec: K_DFT_FWD,
					bindings: { p, a: A, tw: twi, b: B },
					workgroups: groups(nSig * M),
				});
			else
				gf.add(
					new GPUFFT1D({
						id: "f2",
						input: gf.graph.createDataView(A, {
							format: "float32x2",
							length: nSig * M,
						}),
						output: gf.graph.createDataView(B, {
							format: "float32x2",
							length: nSig * M,
						}),
						length: N1,
						batchCount: (nSig * M) / N1,
						direction: "forward",
					}),
				);
		}
		gf.readNode("out", [B]);
		gf.compile();
	}
	const fx = mkBuf(x);
	const fr = await gf.run(undefined, { buffers: { ...bufs, x: fx } });
	const fwd = new Float32Array(fr.reads.out[0]);
	// inverse of `spec` (permuted order)
	const gi = new ComputeGraph(device, `${ID}-inv-${M}`);
	{
		const p = gi.importBuffer("p", FFT_U.byteLength, undefined, UNIFORM);
		const si = gi.importBuffer("spec", cbytes);
		const twi = gi.importBuffer("tw", M * 8);
		const C = gi.transientBuffer("c", cbytes);
		const D = gi.transientBuffer("d", cbytes);
		const L = N1 > 1 ? N1 : N2;
		if (dft && N1 > 1)
			gi.addKernel({
				id: "dft",
				spec: K_DFT_INV,
				bindings: { p, a: si, tw: twi, b: D },
				workgroups: groups(nSig * M),
			});
		else
			gi.add(
				new GPUFFT1D({
					id: "i1",
					input: gi.graph.createDataView(si, {
						format: "float32x2",
						length: nSig * M,
					}),
					output: gi.graph.createDataView(D, {
						format: "float32x2",
						length: nSig * M,
					}),
					length: L,
					batchCount: (nSig * M) / L,
					direction: "inverse",
				}),
			);
		if (N1 > 1) {
			gi.addKernel({
				id: "tw",
				spec: K_TWIDDLE_INV,
				bindings: { p, a: D, tw: twi, b: C },
				workgroups: groups(nSig * M),
			});
			gi.add(
				new GPUFFT1D({
					id: "i2",
					input: gi.graph.createDataView(C, {
						format: "float32x2",
						length: nSig * M,
					}),
					output: gi.graph.createDataView(D, {
						format: "float32x2",
						length: nSig * M,
					}),
					length: N2,
					batchCount: (nSig * M) / N2,
					direction: "inverse",
				}),
			);
		}
		gi.readNode("out", [D]);
		gi.compile();
	}
	const ir = await gi.run(undefined, {
		buffers: { ...bufs, spec: mkBuf(spec) },
	});
	const inv = new Float32Array(ir.reads.out[0]);
	return { fwd, inv };
}

// cap = largest sub-transform; the 512 caps avoid the Metal miscompile of luma's bit reversal (fft-gpu.ts)
const CASES: { M: number; cap: number; dft?: boolean }[] = [
	{ M: 2048, cap: 2048 },
	{ M: 8192, cap: 2048 },
	{ M: 512, cap: 2048 },
	{ M: 4096, cap: 512 },
	{ M: 2048, cap: 512 },
	{ M: 1024, cap: 512 },
	{ M: 8192, cap: 512, dft: true },
	{ M: 2048, cap: 512, dft: true },
];
let fft2048Ok = true;
for (const { M, cap, dft = false } of CASES) {
	const nSig = 3;
	const r = rng(M);
	const x = Float32Array.from({ length: nSig * M }, r);
	const natSpec = Float32Array.from({ length: nSig * M * 2 }, r);
	const plan = planFourStep(M, cap);
	if (!plan) throw new Error("plan");
	// the inverse input is a spectrum in permuted order built from a natural one
	const perm = new Float32Array(nSig * M * 2);
	for (let s = 0; s < nSig; s++)
		for (let k = 0; k < M; k++) {
			const j = permutedIndex(k, plan);
			perm[2 * (s * M + j)] = natSpec[2 * (s * M + k)];
			perm[2 * (s * M + j) + 1] = natSpec[2 * (s * M + k) + 1];
		}
	const { fwd, inv } = await fourStepGpu(plan, dft, nSig, x, perm);
	let eF = 0;
	let eI = 0;
	let mF = 0;
	let mI = 0;
	let nan = 0;
	for (let s = 0; s < nSig; s++) {
		const re = Float64Array.from(x.subarray(s * M, (s + 1) * M));
		const im = new Float64Array(M);
		fft(re, im);
		const ire = new Float64Array(M);
		const iim = new Float64Array(M);
		for (let k = 0; k < M; k++) {
			ire[k] = natSpec[2 * (s * M + k)];
			iim[k] = natSpec[2 * (s * M + k) + 1];
		}
		ifft(ire, iim);
		for (let k = 0; k < M; k++) {
			const j = s * M + permutedIndex(k, plan);
			eF = Math.max(
				eF,
				Math.abs(fwd[2 * j] - re[k]),
				Math.abs(fwd[2 * j + 1] - im[k]),
			);
			mF = Math.max(mF, Math.abs(re[k]), Math.abs(im[k]));
			// inverse output layout [n1][n2] -> natural n = n1 + N1*n2
			const n1 = k % plan.N1;
			const n2 = Math.floor(k / plan.N1);
			const o = 2 * (s * M + n1 * plan.N2 + n2);
			eI = Math.max(
				eI,
				Math.abs(inv[o] - ire[k]),
				Math.abs(inv[o + 1] - iim[k]),
			);
			mI = Math.max(mI, Math.abs(ire[k]), Math.abs(iim[k]));
		}
		for (const v of [
			...fwd.subarray(s * M * 2, (s + 1) * M * 2),
			...inv.subarray(s * M * 2, (s + 1) * M * 2),
		])
			if (!Number.isFinite(v)) nan++;
	}
	const ok = eF / mF <= 5e-5 && eI / mI <= 5e-5 && !nan;
	if (M === 2048 && cap === 2048) fft2048Ok = ok;
	// a 2048-point transform is the one luma length this Metal compiler miscompiles (fft-gpu.ts note)
	const tolerated = !ok && !dft && cap === 2048 && M >= 2048 && !fft2048Ok;
	console.log(
		`(a) four-step M=${M} N1=${plan.N1}${dft ? " (direct DFT)" : ""} N2=${plan.N2}: forward max rel err ${(eF / mF).toExponential(2)}, inverse ${(eI / mI).toExponential(2)}, NaN/Inf ${nan}${ok ? "" : tolerated ? "  [KNOWN ENV: device miscompiles luma's 2048-point FFT pass]" : ""}`,
	);
	if (!ok && !tolerated) fail(`four-step M=${M} cap=${cap}`);
}

// ---------- (b)/(c) synthetic refine problems ----------

function profile(variant: number): HorizonProfile {
	const step = 0.25;
	const n = 1440;
	const elevation = new Float32Array(n);
	const distance = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const az = i * step;
		elevation[i] =
			2 +
			1.5 * Math.sin((az * Math.PI) / 23) +
			1.0 * Math.sin((az * Math.PI) / 7 + 2) +
			5 * Math.exp(-(((az - 150) / 3) ** 2)) +
			3 * Math.exp(-(((az - 172) / 2) ** 2)) +
			(variant ? 4 * Math.exp(-(((az - 125) / 2.5) ** 2)) : 0);
		distance[i] = 6000 + 4000 * Math.sin((az * Math.PI) / 61) ** 2;
	}
	return {
		step,
		elevation,
		distance,
		ridges: Array.from({ length: n }, () => []),
	};
}

interface Scenario {
	name: string;
	variant: number;
	W: number;
	H: number;
	truthYaw: number;
	priorYaw: number;
	roll: number;
	noise: number;
	occluders: boolean;
	init?: Partial<InitOptions>;
}
const SCENARIOS: Scenario[] = [
	{
		name: "init-spec +12deg",
		variant: 0,
		W: 800,
		H: 600,
		truthYaw: 150,
		priorYaw: 138,
		roll: 0,
		noise: 0,
		occluders: false,
	},
	{
		name: "refine-spec -20deg roll.5",
		variant: 1,
		W: 800,
		H: 600,
		truthYaw: 150,
		priorYaw: 130,
		roll: 0.5,
		noise: 0,
		occluders: false,
	},
	{
		name: "noisy+occluders",
		variant: 1,
		W: 800,
		H: 600,
		truthYaw: 150,
		priorYaw: 141,
		roll: 0.5,
		noise: 1.2,
		occluders: true,
	},
	{
		name: "grid 2048 range 20",
		variant: 1,
		W: 600,
		H: 450,
		truthYaw: 150,
		priorYaw: 144,
		roll: 0,
		noise: 0.5,
		occluders: false,
		init: { gridSize: 2048, yawRange: 20 },
	},
	{
		name: "grid 512 range 30",
		variant: 0,
		W: 600,
		H: 450,
		truthYaw: 150,
		priorYaw: 146,
		roll: 0,
		noise: 0,
		occluders: false,
		init: { gridSize: 512 },
	},
	{
		name: "grid 4096 range 30",
		variant: 1,
		W: 800,
		H: 600,
		truthYaw: 150,
		priorYaw: 138,
		roll: 0.3,
		noise: 0.6,
		occluders: true,
		init: { gridSize: 4096 },
	},
	{
		name: "grid 1024 range 30",
		variant: 0,
		W: 600,
		H: 450,
		truthYaw: 150,
		priorYaw: 143,
		roll: 0,
		noise: 0.3,
		occluders: false,
		init: { gridSize: 1024 },
	},
	{
		name: "tiny range (S=1)",
		variant: 1,
		W: 600,
		H: 450,
		truthYaw: 150,
		priorYaw: 150,
		roll: 0,
		noise: 0,
		occluders: false,
		init: { yawRange: 0.05 },
	},
	{
		name: "grid 16384",
		variant: 1,
		W: 800,
		H: 600,
		truthYaw: 150,
		priorYaw: 139,
		roll: 0,
		noise: 0.3,
		occluders: false,
		init: { gridSize: 16384 },
	},
];

const worst = { dC: 0, dYaw: 0, psr: 0, ang: 0, nan: 0, mism: 0, modeMiss: 0 };
let gpuTimes: number[] = [];
let cpuTimes: number[] = [];

for (const sc of SCENARIOS) {
	const hz = profile(sc.variant);
	const truth = cameraFromAngles({
		width: sc.W,
		height: sc.H,
		f: 900,
		yaw: sc.truthYaw,
		pitch: 2,
		roll: sc.roll,
	});
	const rows = projectSkylineRows(truth, hz, sc.W);
	const r = rng(7 + sc.W + sc.priorYaw);
	const weight = new Float32Array(rows.length);
	for (let i = 0; i < rows.length; i++) {
		if (!Number.isFinite(rows[i])) continue;
		rows[i] += sc.noise * r();
		weight[i] = 1;
		if (sc.occluders && (i % 97 < 12 || i % 211 < 5)) rows[i] += 40 + 20 * r();
	}
	const skyline = { width: sc.W, height: sc.H, rows, weight };
	const prior = cameraFromAngles({
		width: sc.W,
		height: sc.H,
		f: 900,
		yaw: sc.priorYaw,
		pitch: 1.2,
		roll: 0,
	});
	const geom = {
		width: sc.W,
		height: sc.H,
		cx: prior.cx,
		cy: prior.cy,
		f0: prior.f,
	};
	const cols = columnsFromSkyline(skyline);
	const o: InitOptions = { ...DEFAULT_INIT, ...sc.init };
	const p = paramsFromCamera(prior);

	// correlations
	const prep = prepareInit(p, geom, cols, hz, o);
	const cpu = correlateCpu(prep);
	let g: Awaited<ReturnType<typeof correlateGpu>>;
	try {
		g = await correlateGpu(device, prep);
	} catch (e) {
		// only a device that miscompiles the 2048-point transform may refuse the 8192 / 16384 grids
		const tolerated = !fft2048Ok && o.gridSize >= 8192;
		console.log(
			`(b) ${sc.name}: M=${o.gridSize} GPU correlation refused (${(e as Error).message})${tolerated ? "  [KNOWN ENV, CPU fallback]" : ""}`,
		);
		if (!tolerated) fail(`${sc.name}: ${(e as Error).message}`);
		const rc = refinePose({
			camera: prior,
			horizon: hz,
			skyline,
			options: { init: sc.init },
		});
		const rg = await refinePoseAsync({
			camera: prior,
			horizon: hz,
			skyline,
			options: { init: sc.init },
		});
		const same =
			rc.camera.yaw === rg.camera.yaw &&
			rc.camera.pitch === rg.camera.pitch &&
			rc.confidence.accept === rg.confidence.accept;
		console.log(
			`(c) ${sc.name}: refinePoseAsync fell back to the CPU: result ${same ? "identical" : "DIFFERS"} to refinePose`,
		);
		if (!same) fail(`${sc.name}: fallback differs from refinePose`);
		continue;
	}
	let dC = 0;
	let nan = 0;
	for (let f = 0; f < cpu.length; f++)
		for (const kk of ["C1", "C2", "C3", "C4"] as const) {
			let m = 0;
			let d = 0;
			for (let i = 0; i < prep.nShift; i++) {
				m = Math.max(m, Math.abs(cpu[f][kk][i]));
				d = Math.max(d, Math.abs(g[f][kk][i] - cpu[f][kk][i]));
				if (!Number.isFinite(g[f][kk][i])) nan++;
			}
			dC = Math.max(dC, d / Math.max(m, 1e-30));
		}
	// timing (warm)
	const tg: number[] = [];
	const tc: number[] = [];
	for (let i = 0; i < 5; i++) {
		let t = performance.now();
		await correlateGpu(device, prep);
		tg.push(performance.now() - t);
		if (i < 3) {
			t = performance.now();
			correlateCpu(prep);
			tc.push(performance.now() - t);
		}
	}
	if (sc.init === undefined) {
		gpuTimes = tg;
		cpuTimes = tc;
	}

	// globalInit
	const a = globalInit(p, geom, cols, hz, o);
	const b = await globalInitAsync(p, geom, cols, hz, o, (pp) =>
		correlateGpu(device, pp),
	);
	const step = 360 / o.gridSize;
	const dYaw =
		a.modes.length && b.modes.length
			? Math.abs(a.modes[0].dYaw - b.modes[0].dYaw)
			: a.modes.length === b.modes.length
				? 0
				: 1e9;
	const psr = Math.abs(a.psr - b.psr) / Math.max(1e-9, Math.abs(a.psr));
	const modeSet =
		b.modes.length === a.modes.length &&
		a.modes.every((m, i) => Math.abs(m.dYaw - b.modes[i].dYaw) <= step + 1e-9);
	const modeMatch = a.modes.filter((m) =>
		b.modes.some((n) => Math.abs(n.dYaw - m.dYaw) <= step + 1e-9),
	).length;
	for (const v of b.score) if (!Number.isFinite(v)) nan++;
	const dNuis =
		a.modes.length && b.modes.length
			? Math.max(
					Math.abs(a.modes[0].dPitch - b.modes[0].dPitch),
					Math.abs(a.modes[0].dRoll - b.modes[0].dRoll),
				)
			: 0;
	console.log(
		`(b) ${sc.name}: M=${o.gridSize} S=${prep.S}  max|dC|/max|C| ${dC.toExponential(2)}  top dYaw cpu ${a.modes[0]?.dYaw.toFixed(3)} gpu ${b.modes[0]?.dYaw.toFixed(3)} (|d| ${dYaw.toFixed(4)} <= step ${step.toFixed(4)})  modes agree ${modeMatch}/${a.modes.length}${modeSet ? "" : " (SET DIFFERS)"}  top-mode d(pitch,roll) ${dNuis.toExponential(2)} deg  PSR ${a.psr.toFixed(3)} vs ${b.psr.toFixed(3)} (rel ${psr.toExponential(2)})  NaN ${nan}`,
	);
	worst.dC = Math.max(worst.dC, dC);
	worst.dYaw = Math.max(worst.dYaw, dYaw / step);
	worst.psr = Math.max(worst.psr, psr);
	worst.nan += nan;
	worst.modeMiss += a.modes.length - modeMatch;
	if (dYaw > step + 1e-9) fail(`${sc.name}: top-mode dYaw ${dYaw}`);
	if (nan) fail(`${sc.name}: non-finite`);
	if (dC > 5e-4) fail(`${sc.name}: correlation error ${dC}`);
	if (psr > 0.05) fail(`${sc.name}: PSR rel diff ${psr}`);

	// refinePose end to end (GPU init through adoptRenderDevice -> getComputeDevice)
	const input = {
		camera: prior,
		horizon: hz,
		skyline,
		options: { init: sc.init },
	};
	const rc = refinePose(input);
	const rg = await refinePoseAsync(input);
	const dy = Math.abs(((rg.camera.yaw - rc.camera.yaw + 540) % 360) - 180);
	const dp = Math.abs(rg.camera.pitch - rc.camera.pitch);
	const dr = Math.abs(rg.camera.roll - rc.camera.roll);
	const ang = Math.max(dy, dp, dr);
	worst.ang = Math.max(worst.ang, ang);
	const same = rg.confidence.accept === rc.confidence.accept;
	if (!same) worst.mism++;
	console.log(
		`(c) ${sc.name}: refinePose yaw ${rc.camera.yaw.toFixed(4)} pitch ${rc.camera.pitch.toFixed(4)} roll ${rc.camera.roll.toFixed(4)} accept ${rc.confidence.accept} | async dYaw ${dy.toExponential(2)} dPitch ${dp.toExponential(2)} dRoll ${dr.toExponential(2)} accept ${rg.confidence.accept} | split #${verifiedSplit(device, o.gridSize)} | init ms cpu ${rc.init.ms.toFixed(1)} gpu ${rg.init.ms.toFixed(1)}`,
	);
	if (ang > 0.01) fail(`${sc.name}: refinePoseAsync differs by ${ang} deg`);
	if (!same) fail(`${sc.name}: accept decision differs`);
}

console.log(
	`\nwarm correlation (M=8192, 5 scales, 2S+1=1367): GPU median ${median(gpuTimes).toFixed(1)} ms (runs ${gpuTimes.map((t) => t.toFixed(1)).join(", ")}), CPU median ${median(cpuTimes).toFixed(1)} ms (runs ${cpuTimes.map((t) => t.toFixed(1)).join(", ")})`,
);
console.log(
	`summary: worst max|dC|/max|C| ${worst.dC.toExponential(2)}, worst top-mode |dYaw| ${worst.dYaw.toFixed(3)} grid steps, worst PSR rel diff ${worst.psr.toExponential(2)}, worst camera angle diff ${worst.ang.toExponential(2)} deg, accept mismatches ${worst.mism}, mode misses ${worst.modeMiss}, NaN/Inf ${worst.nan}`,
);
device.destroy();
if (failed) {
	console.log(`FAIL ${ID} (${failed})`);
	process.exit(1);
}
console.log(`PASS ${ID}`);
process.exit(0);
