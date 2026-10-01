// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU runner of the certified-f32 refine (./cert-refine.ts certifiedRefine): one core ComputeGraph run
// (one submit) per call, R fixed rounds encoded as
//
//   DECIDE_0 → [EVAL_r (GPU indirect condition: cmd at 512·r) → EVAL2_r (cmd at 512·r + 256)
//               → DECIDE_{r+1} (writes both commands of round r + 1)]  for r < R  → read
//
// DECIDE writes the indirect commands (x = jobs of that tier; 0 once every lane is done or halted, or
// when no comparison needs the double-f32 re-check, so those dispatches are skipped on the GPU with no
// CPU round trip). All buffers are pooled IMPORTS ("align/cert-*" slots and the shared align input
// slots): the lane state persists across submits on the CPU (uploaded every run: ≤ 8 × 192 B), the
// move log and the lattice tables are uploaded only when the CPU changed them (a tie-path move, a
// re-centred window) or another writer wrote the slot. The GPU-condition clear lint covers transients
// only; nothing here is a transient. Stale results cannot pass: each result echoes its job's serial
// (per-submit nonce, lane, sequence) and DECIDE halts the lane (REASON.stale → GPU error → the f64
// path) on a mismatch. Read back per submit: the lane states, the move logs and the audit rings
// (≤ 8 · (192 + 4096 + 2048) B).
import { Buffer, type Device } from "@luma.gl/core";
import type { EdgeMap } from "#/lib/align";
import { cachedGraph } from "#/lib/gpu/core/graph";
import { defineKernel } from "#/lib/gpu/core/kernel";
import {
	acquire,
	pooledStorage,
	pooledUniform,
	withLease,
} from "#/lib/gpu/core/pool";
import { pinResidentPlanes } from "#/lib/gpu/photoprep";
import { split } from "#/lib/gpu/precision/df32";
import {
	PROBE_IN,
	PROBE_OUT,
	type ProbeVerdict,
	probeInputs,
	verifyProbe,
} from "#/lib/gpu/precision/ieee-probe";
import {
	CERT_DECIDE_WGSL,
	CERT_EVAL_WGSL,
	CERT_EVAL2_WGSL,
	e2Coef,
	eCoef,
} from "./cert.wgsl";
import {
	type CertBuffers,
	type CertRunner,
	JOB_WORDS,
	type LatticeSlack,
	LOG_CAP,
	MAX_JOBS,
	RES_WORDS,
	U_WORDS,
	WINDOW,
} from "./cert-refine";
import { dirTable } from "./pose-bound";
import {
	ALIGN_GROUP,
	type PoseGridStats,
	STORAGE,
	uploadOnce,
} from "./pose-grid";

/** cachedGraph group of the certified refine (declared in gpu/app-graph/manifest.ts). */
export const CERT_GRAPH_GROUP = "align-cert";

const ro = "read-only-storage" as const;
const DECIDE = defineKernel(
	"align-cert-decide",
	CERT_DECIDE_WGSL,
	[
		["u", "uniform"],
		["state", "storage"],
		["moves", "storage"],
		["jobs", "storage"],
		["res", ro],
		["cmd", "storage"],
		["audit", "storage"],
	],
	{ group: ALIGN_GROUP, label: "align-cert-decide" },
);
const evalLayout = (
	tables: string,
): [string, "uniform" | typeof ro | "storage"][] => [
	["u", "uniform"],
	["jobs", ro],
	[tables, ro],
	["dirs", ro],
	["coarse", ro],
	["fine", ro],
	["fg", ro],
	["skyCum", ro],
	["res", "storage"],
];
const EVAL = defineKernel(
	"align-cert-eval",
	CERT_EVAL_WGSL,
	evalLayout("tables"),
	{
		group: ALIGN_GROUP,
		label: "align-cert-eval",
	},
);
const EVAL2 = defineKernel(
	"align-cert-eval2",
	CERT_EVAL2_WGSL,
	evalLayout("tables2"),
	{ group: ALIGN_GROUP, label: "align-cert-eval2" },
);

/** EVAL2's module, entry point `probe` (cert.wgsl.ts): the strict-IEEE probe compiled with EVAL2. */
const EVAL2_PROBE = defineKernel(
	"align-cert-eval2-probe",
	CERT_EVAL2_WGSL,
	evalLayout("tables2"),
	{ group: ALIGN_GROUP, label: "align-cert-eval2-probe", entryPoint: "probe" },
);

/**
 * The verdict checks align's arithmetic needs. Align never takes a square root, so the probe's sqrt
 * and ddSqrt records (WGSL allows ~4.5 ULP sqrt, more than the probe's 4) do not disqualify a device;
 * flushing subnormals is accepted by the verifier itself (align's bound charges absolute slack for it:
 * cert.wgsl.ts). Anything else failing, or a probe error, keeps the f64 path.
 */
export function alignProbeOk(v: ProbeVerdict & { error?: string }) {
	if ("error" in v && v.error) return false;
	return Object.keys(v.failures).every((k) => k === "sqrt" || k === "ddSqrt");
}

export type ModuleProbe = ProbeVerdict & { ms: number; error?: string };
const moduleProbes = new WeakMap<Device, Promise<ModuleProbe>>();

/**
 * The strict-IEEE probe run through EVAL2's own shader module (its `probe` entry point), once per
 * device: fma fusion, opq's survival and flushing are decided per compiled shader, so the shared
 * probe's verdict alone does not cover EVAL2. Never rejects ({ ok: false, error } on a GPU error).
 */
export function probeEval2Module(device: Device): Promise<ModuleProbe> {
	let p = moduleProbes.get(device);
	if (!p) {
		p = runModuleProbe(device).catch(
			(e): ModuleProbe => ({
				ok: false,
				n: 0,
				failures: {},
				worst: {},
				ms: 0,
				error: String(e),
			}),
		);
		moduleProbes.set(device, p);
	}
	return p;
}

async function runModuleProbe(device: Device): Promise<ModuleProbe> {
	const t0 = performance.now();
	const pin = probeInputs();
	const n = pin.length / PROBE_IN;
	const outBytes = n * PROBE_OUT * 4;
	const out = await withLease(ALIGN_GROUP, async () => {
		const uw = new ArrayBuffer(U_WORDS * 4);
		new Uint32Array(uw)[2] = n; // u.nDirs = records; u.zero (word 13) = 0
		const dummy = (key: string) =>
			pooledStorage(device, `align/cert-probe-${key}`, new Float32Array(16));
		const inputs: Record<string, Buffer> = {
			u: pooledUniform(device, "align/cert-probe-u", uw),
			jobs: dummy("jobs"),
			tables2: dummy("tables2"),
			dirs: pooledStorage(device, "align/cert-probe-in", pin),
			coarse: dummy("coarse"),
			fine: dummy("fine"),
			fg: dummy("fg"),
			skyCum: dummy("skycum"),
			res: acquire(device, "align/cert-probe-out", outBytes, STORAGE),
		};
		const key = [
			"probe",
			...Object.entries(inputs).map(([k, v]) => `${k}${v.byteLength}`),
		].join(",");
		const { graph } = cachedGraph<void>(device, CERT_GRAPH_GROUP, key, (g) => {
			const imp: Record<string, ReturnType<typeof g.importBuffer>> = {};
			for (const [name, buf] of Object.entries(inputs))
				imp[name] = g.importBuffer(
					name,
					buf.byteLength,
					undefined,
					name === "u" ? UNIFORM : STORAGE,
				);
			g.addKernel({
				id: "probe",
				spec: EVAL2_PROBE,
				bindings: imp,
				workgroups: [Math.ceil(n / 64)],
			});
			g.readNode("read", [{ buffer: imp.res, size: outBytes }]);
			g.compile();
			return undefined;
		});
		const { reads } = await graph.run(undefined, { buffers: inputs });
		const buf = reads.read?.[0];
		if (!buf) throw new Error("align-cert probe: read node did not run");
		return new Float32Array(buf.slice(0, outBytes));
	});
	return { ...verifyProbe(pin, out), ms: performance.now() - t0 };
}

/** byte stride of a round's indirect commands (EVAL at +0, EVAL2 at +256: storage offsets align to 256) */
const CMD_STRIDE = 512;
const CMD_USAGE = Buffer.STORAGE | Buffer.INDIRECT | Buffer.COPY_DST;
const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
const JOBS_BYTES = MAX_JOBS * JOB_WORDS * 4;
const RES_BYTES = MAX_JOBS * RES_WORDS * 4;

type Params = { stateBytes: number; logBytes: number; auditBytes: number };

// pooled slot → the session that last wrote it (tables, moves, skyCum)
const writer = new WeakMap<object, object>();
let nonces = 0;

export type CertGpuStats = PoseGridStats & {
	/** graph runs and ms awaiting them */
	runs: number;
	gpuMs: number;
	readBytes: number;
};

/** A CertRunner on `device` for one certified refine (one autoAlign) on this photo. */
export function certGpuRunner(
	device: Device,
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
	stats?: CertGpuStats,
	/** TEST ONLY: u.fault (subtracted from every neighbour interval); undefined → 0 */
	fault?: () => number,
): CertRunner {
	const session = {};
	const { w, h } = edge;
	const nDirs = Math.floor(dirs.length / 3);
	const asp = split(aspect);
	return {
		run: (b: CertBuffers, rounds: number, slack: LatticeSlack) =>
			withLease(ALIGN_GROUP, async () => {
				const t0 = performance.now();
				const up: PoseGridStats = { uploadBytes: 0 };
				const uw = new ArrayBuffer(U_WORDS * 4);
				const ui = new Uint32Array(uw);
				const ii = new Int32Array(uw);
				const uf = new Float32Array(uw);
				nonces = (nonces + 1) >>> 0 || 1;
				ui[0] = w;
				ui[1] = h;
				ui[2] = nDirs;
				ui[3] = b.nLanes;
				// band and gaps exactly as scorePose
				ii[4] = Math.max(2, Math.round(h * 0.035));
				ii[5] = Math.max(1, Math.round(h * 0.012));
				ii[6] = Math.max(1, Math.round(h * 0.006));
				uf[7] = aspect;
				ui[8] = WINDOW;
				ui[9] = nonces;
				uf[10] = eCoef(nDirs);
				uf[11] = nDirs;
				ui[12] = LOG_CAP;
				ui[13] = 0; // ZERO (df32 opq): always 0
				uf[14] = slack.dB;
				uf[15] = slack.relT;
				uf[16] = slack.relV;
				uf[17] = slack.pen;
				uf[18] = e2Coef(nDirs);
				uf[19] = asp[0];
				uf[20] = asp[1];
				uf[21] = fault?.() ?? 0;
				const slot = (key: string, data: ArrayBufferView, dirty: boolean) => {
					const buf = acquire(device, key, data.byteLength, STORAGE);
					if (dirty || writer.get(buf) !== session) {
						buf.write(data);
						writer.set(buf, session);
						up.uploadBytes += data.byteLength;
					}
					return buf;
				};
				const res = pinResidentPlanes(device, edge);
				try {
					const inputs: Record<string, Buffer> = {
						u: pooledUniform(device, "align/cert-u", uw),
						state: pooledStorage(
							device,
							"align/cert-state",
							new Uint8Array(b.state),
						),
						moves: slot("align/cert-moves", b.log, b.logDirty),
						// zeros at the session's start (entries are matched by index on the host)
						audit: slot("align/cert-audit", b.audit, false),
						jobs: acquire(device, "align/cert-jobs", 2 * JOBS_BYTES, STORAGE),
						res: acquire(device, "align/cert-res", 2 * RES_BYTES, STORAGE),
						cmd: acquire(
							device,
							"align/cert-cmd",
							CMD_STRIDE * (rounds + 1),
							CMD_USAGE,
						),
						tables: slot("align/cert-tables", b.tables, b.tablesDirty),
						tables2: slot("align/cert-tables2", b.tables2, b.tablesDirty),
						dirs: uploadOnce(device, "align/dirs1", dirTable(dirs), up),
						coarse:
							res?.coarse ??
							uploadOnce(device, "align/coarse", edge.coarse, up),
						fine: res?.fine ?? uploadOnce(device, "align/fine", edge.fine, up),
						fg: res?.fg ?? uploadOnce(device, "align/fg", edge.fg, up),
						skyCum: slot("align/cert-skycum", edge.skyCum, false),
					};
					up.uploadBytes += uw.byteLength + b.state.byteLength;
					const key = [
						`r${rounds}`,
						...Object.entries(inputs).map(([k, v]) => `${k}${v.byteLength}`),
					].join(",");
					const { graph } = cachedGraph<Params>(
						device,
						CERT_GRAPH_GROUP,
						key,
						(g) => {
							const imp: Record<string, ReturnType<typeof g.importBuffer>> = {};
							for (const [name, buf] of Object.entries(inputs))
								imp[name] = g.importBuffer(
									name,
									buf.byteLength,
									undefined,
									name === "u" ? UNIFORM : name === "cmd" ? CMD_USAGE : STORAGE,
								);
							const decide = (r: number, after?: string) =>
								g.addKernel({
									id: `decide-${r}`,
									spec: DECIDE,
									bindings: {
										u: imp.u,
										state: imp.state,
										moves: imp.moves,
										jobs: imp.jobs,
										res: imp.res,
										// cmd[0..2] (EVAL), cmd[64..66] (EVAL2) of round r
										cmd: { buffer: imp.cmd, offset: CMD_STRIDE * r, size: 272 },
										audit: imp.audit,
									},
									workgroups: [1],
									dependsOn: after ? [after] : undefined,
								});
							const evalNode = (r: number, tier: 1 | 2) =>
								g.addKernel({
									id: `eval${tier}-${r}`,
									spec: tier === 1 ? EVAL : EVAL2,
									bindings: {
										u: imp.u,
										jobs: {
											buffer: imp.jobs,
											offset: tier === 1 ? 0 : JOBS_BYTES,
											size: JOBS_BYTES,
										},
										[tier === 1 ? "tables" : "tables2"]:
											tier === 1 ? imp.tables : imp.tables2,
										dirs: imp.dirs,
										coarse: imp.coarse,
										fine: imp.fine,
										fg: imp.fg,
										skyCum: imp.skyCum,
										res: {
											buffer: imp.res,
											offset: tier === 1 ? 0 : RES_BYTES,
											size: RES_BYTES,
										},
									},
									workgroups: [MAX_JOBS],
									dependsOn: [tier === 1 ? `decide-${r}` : `eval1-${r}`],
									condition: {
										id: `round-${r}-tier${tier}`,
										source: "gpu",
										mode: "indirect",
										buffer: imp.cmd,
										byteOffset: CMD_STRIDE * r + (tier === 1 ? 0 : 256),
									},
								});
							decide(0);
							for (let r = 0; r < rounds; r++) {
								evalNode(r, 1);
								evalNode(r, 2);
								decide(r + 1, `eval2-${r}`);
							}
							g.readNode(
								"read",
								[
									{ buffer: imp.state, size: (p) => p.stateBytes },
									{ buffer: imp.moves, size: (p) => p.logBytes },
									{ buffer: imp.audit, size: (p) => p.auditBytes },
								],
								{ dependsOn: [`decide-${rounds}`] },
							);
							g.compile();
							return undefined;
						},
					);
					const { reads } = await graph.run(
						{
							stateBytes: b.state.byteLength,
							logBytes: b.log.byteLength,
							auditBytes: b.audit.byteLength,
						},
						{ buffers: inputs },
					);
					const [st, lg, au] = reads.read ?? [];
					if (!st || !lg || !au)
						throw new Error("align-cert: read node did not run");
					new Uint8Array(b.state).set(
						new Uint8Array(st, 0, b.state.byteLength),
					);
					b.log.set(new Uint32Array(lg, 0, b.log.length));
					b.audit.set(new Uint32Array(au, 0, b.audit.length));
					if (stats) {
						stats.runs++;
						stats.gpuMs += performance.now() - t0;
						stats.readBytes +=
							b.state.byteLength + b.log.byteLength + b.audit.byteLength;
						stats.uploadBytes += up.uploadBytes;
						if (res)
							stats.residentBytes =
								(stats.residentBytes ?? 0) +
								edge.coarse.byteLength +
								edge.fine.byteLength +
								edge.fg.byteLength;
					}
				} finally {
					res?.release();
				}
			}),
	};
}
