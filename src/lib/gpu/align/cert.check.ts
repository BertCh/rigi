// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// npx tsx src/lib/gpu/align/cert.check.ts [maxPhotos] [priorsPerPhoto] [modes]
//   modes: comma list of default, ftz, div3, tier2, cpu (default: all); the CI fast tier runs
//   `2 1` (synthetic + 2 photos at their prior, every mode on the synthetic scene)
// Node check of the certified-f32 refine (WAG W3.3; no browser, no GPU). The round loop runs in the
// f32 CPU emulation of its WGSL (./cert-emulate.ts) under the production host loop (./cert-refine.ts
// certifiedRefine, via align.ts autoAlignLanes), and must reproduce autoAlign's float64 result:
//  1. decision identity: on a synthetic skyline scene (several priors) and on real edge maps (the
//     photoprep CPU twin, align.ts edgeMapFromPixels, on public/photos/*.jpg scaled to 512 px by macOS
//     `sips`, with the photo's cached horizon profile in .cache/horizon and its ground-truth prior;
//     skipped cleanly when any of those is missing), every AlignResult bit-identical (poses, scores,
//     confidence, alternatives): 0 decision differences. Reports the tie-path rate (decisions the
//     certified compare left to the CPU) and the other halts;
//  2. the runtime guard: an emulated device whose intervals are shifted (a broken bound) is caught
//     (RefineBoundViolation) by the runtime checks
//     (the per-call audit of sampled intervals against exact f64 scores, or the decision re-checks);
//  3. stress modes on the synthetic scene, all bit-identical too: a flush-to-zero machine (subnormal
//     results and loads flushed, as WGSL allows), divisions perturbed by up to ±3 ULP, every comparison
//     forced through EVAL2 ("tier2"), every comparison and pass start forced to the CPU ("cpu"); with
//     the default CPU-decision limit the "cpu" mode must abort (CertAbort) instead;
//  4. alignProbeOk: sqrt failures pass (align takes no square roots), anything else fails;
//  5. latticeSlack stays tiny for ordinary poses; f32Down / f32Up bracket their double and stay
//     normal.
// The strict-IEEE probe and the df32 budgets have their own check (../precision/ieee-probe.check.ts).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type AlignResult,
	autoAlign,
	autoAlignLanes,
	type CoarseGridScores,
	type EdgeMap,
	edgeMapFg,
	edgeMapFromPixels,
	fitPriorSky,
	RefineBoundViolation,
} from "#/lib/align";
import type { Pose } from "#/lib/camera";
import {
	setDivSqrtPerturbation,
	setFlushSubnormals,
} from "#/lib/gpu/precision/df32";
import { type EmulateOptions, emulatedRunner } from "./cert-emulate";
import { alignProbeOk } from "./cert-gpu";
import {
	CertAbort,
	type CertStats,
	certifiable,
	certifiedRefine,
	f32Down,
	f32Up,
	latticeSlack,
	newCertStats,
} from "./cert-refine";

const maxPhotos = Number(process.argv[2] ?? 1e9);
const priorsPerPhoto = Number(process.argv[3] ?? 2);
const modes = new Set(
	(process.argv[4] ?? "default,ftz,div3,tier2,cpu").split(","),
);
let failures = 0;
const check = (name: string, ok: boolean, info = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? ` ${info}` : ""}`);
};
const D = Math.PI / 180;

const same = (a: AlignResult, b: AlignResult) =>
	Object.is(a.score, b.score) &&
	Object.is(a.confidence, b.confidence) &&
	(["yaw", "pitch", "roll", "vfov"] as const).every((k) =>
		Object.is(a.pose[k], b.pose[k]),
	) &&
	(a.alternatives ?? []).length === (b.alternatives ?? []).length &&
	(a.alternatives ?? []).every((x, i) => {
		const y = (b.alternatives ?? [])[i];
		return (
			Object.is(x.score, y.score) &&
			(["yaw", "pitch", "roll", "vfov"] as const).every((k) =>
				Object.is(x.pose[k], y.pose[k]),
			)
		);
	});

const total = newCertStats();
const add = (s: CertStats) => {
	for (const k of Object.keys(total) as (keyof CertStats)[]) total[k] += s[k];
};

/** f64 autoAlign vs the certified refine (emulated) on one (scene, prior); both from the same sky fit. */
async function compare(
	name: string,
	prior: Pose,
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
	o: {
		yawRange?: number;
		emu?: EmulateOptions;
		verifyAll?: boolean;
		maxCpu?: number;
		overlap?: boolean;
		random?: () => number;
	} = {},
) {
	const yawRange = o.yawRange ?? 25;
	const verifyAll = o.verifyAll ?? false;
	fitPriorSky(prior, aspect, dirs, edge);
	const grid = (): CoarseGridScores => ({
		scores: new Float32Array(0),
		tol: 0,
		skyFitted: true,
	});
	const ref = autoAlign(prior, aspect, dirs, edge, yawRange, grid());
	const st = newCertStats();
	const t0 = performance.now();
	const got = await autoAlignLanes(
		prior,
		aspect,
		dirs,
		edge,
		yawRange,
		grid(),
		(starts, ctx) => {
			if (!certifiable(starts, prior, aspect))
				throw new Error(`${name}: not certifiable`);
			return certifiedRefine(starts, ctx, {
				runner: emulatedRunner(aspect, dirs, edge, o.emu),
				stats: st,
				verify: verifyAll ? { check: () => true } : undefined,
				// the check audits more than the app (8 per call): 64 EVAL + 32 EVAL2 intervals per call
				audit: verifyAll ? 1e6 : 64,
				maxCpuDecisions: o.maxCpu,
				overlap: o.overlap,
				random: o.random,
			});
		},
	);
	const ms = performance.now() - t0;
	return { ref, got, st, ms };
}

const report = (name: string, r: Awaited<ReturnType<typeof compare>>) => {
	add(r.st);
	const dec = r.st.certAccepts + r.st.certRejects + r.st.ties + r.st.unbounded;
	check(
		`identity ${name}`,
		same(r.ref, r.got),
		`decisions ${dec}: f32 ${dec - r.st.tier2Decided - r.st.ties - r.st.unbounded}, df32 ${r.st.tier2Decided}, CPU ${r.st.ties + r.st.unbounded} (ties ${r.st.ties}, unbounded ${r.st.unbounded}); starts ${r.st.starts} windows ${r.st.windows} submits ${r.st.submits} cpuEvals ${r.st.cpuEvals} audited ${r.st.audited} forced ${r.st.forced} (${r.ms.toFixed(0)} ms emulated)${same(r.ref, r.got) ? "" : ` ref ${JSON.stringify(r.ref.pose)} ${r.ref.score} got ${JSON.stringify(r.got.pose)} ${r.got.score}`}`,
	);
};

// ---------------- synthetic scene (refine-guard.check.ts's) ----------------
function synthetic() {
	const ridge = (az: number) =>
		2.5 + 1.8 * Math.sin(az * 7 * D) + 0.9 * Math.sin(az * 19 * D + 1);
	const n = 4096;
	const dirs = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		const az = 60 + (i / n) * 120;
		const el = ridge(az) * D;
		dirs[i * 3] = Math.sin(az * D) * Math.cos(el);
		dirs[i * 3 + 1] = Math.cos(az * D) * Math.cos(el);
		dirs[i * 3 + 2] = Math.sin(el);
	}
	const truth: Pose = { yaw: 120, pitch: 1, roll: 0.5, vfov: 40 };
	const aspect = 1.5;
	const w = 192;
	const h = 128;
	const rows = new Float32Array(w).fill(h);
	const t = Math.tan((truth.vfov * D) / 2);
	for (let i = 0; i < n; i++) {
		const az = 60 + (i / n) * 120;
		const x = 0.5 + Math.tan((az - truth.yaw) * D) / (t * aspect) / 2;
		const v = 0.5 - Math.tan((ridge(az) - truth.pitch) * D) / t / 2;
		const col = Math.floor(x * w);
		if (col >= 0 && col < w) rows[col] = Math.min(rows[col], v * h);
	}
	const rgb = new Uint8ClampedArray(w * h * 4);
	const coarse = new Float32Array(w * h);
	const fine = new Float32Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const sky = y < rows[x];
			rgb.set(sky ? [120, 160, 230, 255] : [90, 80, 60, 255], i * 4);
			const d = Math.abs(y - rows[x]);
			coarse[i] = Math.exp(-(d * d) / 40);
			fine[i] = Math.exp(-(d * d) / 4);
		}
	const edge: EdgeMap = {
		w,
		h,
		coarse,
		fine,
		sky: new Float32Array(w * h),
		skyCum: new Float32Array(w * (h + 1)),
		rgb,
		fg: new Float32Array(w * h),
	};
	return { dirs, aspect, edge };
}

{
	const s = synthetic();
	const priors: Pose[] = [
		{ yaw: 124, pitch: 0, roll: 0, vfov: 41 },
		{ yaw: 113, pitch: 2.5, roll: -1, vfov: 38 },
		{ yaw: 131.3, pitch: -1.2, roll: 1.7, vfov: 43.5 },
	];
	for (const [i, prior] of priors.entries())
		report(
			`synthetic#${i}`,
			await compare(`synthetic#${i}`, prior, s.aspect, s.dirs, s.edge),
		);
}

// ---------------- real edge maps ----------------
const root = path.resolve(import.meta.dirname, "../../../..");

function readBmp(file: string) {
	const b = fs.readFileSync(file);
	const off = b.readUInt32LE(10);
	const w = b.readInt32LE(18);
	const hRaw = b.readInt32LE(22);
	const bpp = b.readUInt16LE(28);
	const h = Math.abs(hRaw);
	if (bpp !== 24 && bpp !== 32) throw new Error(`${file}: ${bpp} bpp`);
	const stride = Math.ceil((w * bpp) / 32) * 4;
	const d = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) {
		const row = off + (hRaw > 0 ? h - 1 - y : y) * stride;
		for (let x = 0; x < w; x++) {
			const s = row + (x * bpp) / 8;
			const i = (y * w + x) * 4;
			d[i] = b[s + 2];
			d[i + 1] = b[s + 1];
			d[i + 2] = b[s];
			d[i + 3] = 255;
		}
	}
	return { d, w, h };
}

type Gt = Record<
	string,
	{
		width: number;
		height: number;
		prior?: { yaw: number; pitch: number; roll: number; f: number } | null;
	}
>;

function realCases() {
	const photoDir = path.join(root, "public/photos");
	const hzDir = path.join(root, ".cache/horizon");
	const gtFile = path.join(root, "data/ground-truth.json");
	let sips = true;
	try {
		execFileSync("sips", ["--help"], { stdio: "ignore" });
	} catch {
		sips = false;
	}
	if (
		!sips ||
		!fs.existsSync(photoDir) ||
		!fs.existsSync(hzDir) ||
		!fs.existsSync(gtFile)
	) {
		console.log(
			"SKIP real edge maps: needs macOS `sips`, public/photos/*.jpg, .cache/horizon and data/ground-truth.json",
		);
		return [];
	}
	const gt = JSON.parse(fs.readFileSync(gtFile, "utf8")) as Gt;
	const profiles = fs.readdirSync(hzDir).filter((f) => f.endsWith(".json"));
	const out: {
		name: string;
		prior: Pose;
		aspect: number;
		dirs: Float32Array;
		d: Uint8ClampedArray;
		w: number;
		h: number;
	}[] = [];
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "align-cert-"));
	try {
		for (const pf of profiles.sort()) {
			if (out.length >= maxPhotos) break;
			const id = pf.split("_").slice(0, 2).join("_");
			const jpg = path.join(photoDir, `${id}.jpg`);
			const g = gt[id];
			if (!fs.existsSync(jpg) || !g?.prior) continue;
			const prof = JSON.parse(
				fs.readFileSync(path.join(hzDir, pf), "utf8"),
			) as {
				step: number;
				elevation: number[];
			};
			// the app's CPU horizon (deck cpu-geometry horizonDirs) samples every 0.2°
			const every = Math.max(1, Math.round(0.2 / prof.step));
			const dl: number[] = [];
			for (let k = 0; k < prof.elevation.length; k += every) {
				const el = prof.elevation[k];
				if (!Number.isFinite(el)) continue;
				const az = k * prof.step * D;
				dl.push(
					Math.sin(az) * Math.cos(el * D),
					Math.cos(az) * Math.cos(el * D),
					Math.sin(el * D),
				);
			}
			const bmp = path.join(tmp, `${id}.bmp`);
			try {
				execFileSync(
					"sips",
					["-s", "format", "bmp", "--resampleWidth", "512", jpg, "--out", bmp],
					{
						stdio: "ignore",
					},
				);
			} catch {
				continue;
			}
			const img = readBmp(bmp);
			// EXIF orientation may rotate the decoded image: take the decoded aspect
			const aspect = img.w / img.h;
			const vfov =
				(2 * Math.atan(Math.min(g.width, g.height) / 2 / g.prior.f) * 180) /
				Math.PI;
			const portrait = img.h > img.w;
			const vf = portrait
				? (2 * Math.atan(Math.max(g.width, g.height) / 2 / g.prior.f) * 180) /
					Math.PI
				: vfov;
			out.push({
				name: id,
				prior: {
					yaw: g.prior.yaw,
					pitch: g.prior.pitch,
					roll: g.prior.roll,
					vfov: vf,
				},
				aspect,
				dirs: new Float32Array(dl),
				...img,
			});
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	return out;
}

const reals = realCases();
for (const c of reals) {
	const edge = edgeMapFromPixels(c.d, c.w, c.h, edgeMapFg(c.w, c.h));
	const priors: Pose[] = [c.prior];
	// perturbed priors (compass / gravity / lens error), deterministic
	const jit = [
		[6.3, -1.1, 0.8, 1.04],
		[-8.7, 0.9, -1.3, 0.97],
		[3.1, 1.6, 2.2, 1.02],
	];
	for (const [dy, dp, dr, sv] of jit.slice(0, Math.max(0, priorsPerPhoto - 1)))
		priors.push({
			yaw: c.prior.yaw + dy,
			pitch: c.prior.pitch + dp,
			roll: c.prior.roll + dr,
			vfov: c.prior.vfov * sv,
		});
	for (const [i, prior] of priors.entries())
		report(
			`${c.name}#${i}`,
			await compare(`${c.name}#${i}`, prior, c.aspect, c.dirs, edge),
		);
}
{
	const dec =
		total.certAccepts + total.certRejects + total.ties + total.unbounded;
	const cpu = total.ties + total.unbounded;
	console.log(
		`note totals: ${dec} decisions; certified ${total.certAccepts + total.certRejects} (accept ${total.certAccepts}, reject ${total.certRejects}): f32 ${total.certAccepts + total.certRejects - total.tier2Decided}, df32 re-check ${total.tier2Decided} (${((100 * total.tier2Decided) / Math.max(1, dec)).toFixed(2)}%); CPU tie path ${cpu} (${((100 * cpu) / Math.max(1, dec)).toFixed(3)}%: ties ${total.ties}, unbounded ${total.unbounded}); start halts ${total.starts}, window halts ${total.windows}; submits ${total.submits}; GPU evals f32 ${total.evals} df32 ${total.tier2Evals}; CPU evals ${total.cpuEvals} (audited ${total.audited}, forced re-decisions ${total.forced}, verified ${total.verified}); exact-score CPU ${total.exactMs.toFixed(0)} ms, ${total.overlapMs.toFixed(0)} ms of it (${((100 * total.overlapMs) / Math.max(1e-9, total.exactMs)).toFixed(0)}%) while a submit was in flight (${total.prewarmed} forced decisions prewarmed)`,
	);
}

// ---------------- overlap: prewarming the forced re-decisions changes nothing but timing ----------------
{
	const s = synthetic();
	const prior: Pose = { yaw: 124, pitch: 0, roll: 0, vfov: 41 };
	const seeded = () => {
		let x = 0x2545f491;
		return () => {
			x ^= x << 13;
			x ^= x >>> 17;
			x ^= x << 5;
			return (x >>> 0) / 2 ** 32;
		};
	};
	const on = await compare("overlap on", prior, s.aspect, s.dirs, s.edge, {
		overlap: true,
		random: seeded(),
	});
	const off = await compare("overlap off", prior, s.aspect, s.dirs, s.edge, {
		overlap: false,
		random: seeded(),
	});
	const keys = [
		"cpuEvals",
		"audited",
		"forced",
		"verified",
		"submits",
	] as const;
	check(
		"overlap: identical result and identical exact-score work with prewarming on and off",
		same(on.ref, on.got) &&
			same(off.ref, off.got) &&
			same(on.got, off.got) &&
			keys.every((k) => on.st[k] === off.st[k]) &&
			on.st.prewarmed > 0 &&
			off.st.prewarmed === 0,
		`on: prewarmed ${on.st.prewarmed} of ${on.st.forced} forced, ${on.st.overlapMs.toFixed(1)} of ${on.st.exactMs.toFixed(1)} ms exact CPU in flight; off: ${off.st.exactMs.toFixed(1)} ms; ${keys.map((k) => `${k} ${on.st[k]}/${off.st[k]}`).join(", ")}`,
	);
}

// ---------------- runtime guard: a broken bound ----------------
{
	const s = synthetic();
	const prior: Pose = { yaw: 124, pitch: 0, roll: 0, vfov: 41 };
	for (const fault of [0.05, 2e-3]) {
		let caught = false;
		let r: Awaited<ReturnType<typeof compare>> | undefined;
		try {
			r = await compare("fault", prior, s.aspect, s.dirs, s.edge, {
				emu: { fault },
				verifyAll: true,
			});
		} catch (e) {
			if (!(e instanceof RefineBoundViolation)) throw e;
			caught = true;
		}
		check(
			`guard: intervals shifted by −${fault} → violation caught or identical`,
			caught || (r !== undefined && same(r.ref, r.got)),
			caught ? "(caught)" : "(no decision flipped)",
		);
	}
}

// ---------------- stress modes (synthetic scene) ----------------
{
	const s = synthetic();
	const prior: Pose = { yaw: 124, pitch: 0, roll: 0, vfov: 41 };
	if (modes.has("ftz")) {
		setFlushSubnormals(true);
		try {
			report("mode ftz", await compare("ftz", prior, s.aspect, s.dirs, s.edge));
		} finally {
			setFlushSubnormals(false);
		}
	}
	if (modes.has("div3")) {
		let seed = 7;
		setDivSqrtPerturbation(3, () => {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			return seed / 2 ** 32;
		});
		try {
			report(
				"mode div±3ULP",
				await compare("div3", prior, s.aspect, s.dirs, s.edge),
			);
		} finally {
			setDivSqrtPerturbation(0);
		}
	}
	if (modes.has("tier2")) {
		const r = await compare("tier2", prior, s.aspect, s.dirs, s.edge, {
			yawRange: 4,
			emu: { force: "tier2" },
		});
		report("mode tier2 (every comparison through EVAL2)", r);
		check("mode tier2: EVAL2 decided", r.st.tier2Decided > 0);
	}
	if (modes.has("cpu")) {
		const r = await compare("cpu", prior, s.aspect, s.dirs, s.edge, {
			yawRange: 4,
			emu: { force: "cpu" },
			maxCpu: Number.POSITIVE_INFINITY,
		});
		report("mode cpu (every comparison on the CPU)", r);
		check(
			"mode cpu: no GPU decision",
			r.st.certAccepts + r.st.certRejects === 0 &&
				r.st.ties + r.st.unbounded > 0,
		);
		let aborted = false;
		try {
			await compare("cpu-abort", prior, s.aspect, s.dirs, s.edge, {
				yawRange: 4,
				emu: { force: "cpu" },
			});
		} catch (e) {
			if (!(e instanceof CertAbort)) throw e;
			aborted = true;
		}
		check("mode cpu, default limit: aborts to f64 (CertAbort)", aborted);
	}
}

// ---------------- probe verdict ----------------
{
	const v = (failures: Record<string, number>, error?: string) => ({
		ok: Object.keys(failures).length === 0,
		n: 1,
		failures,
		worst: {},
		ms: 0,
		error,
	});
	check(
		"alignProbeOk: sqrt-only failures pass, others fail, errors fail",
		alignProbeOk(v({})) &&
			alignProbeOk(v({ sqrt: 3, ddSqrt: 1 })) &&
			!alignProbeOk(v({ fma: 1 })) &&
			!alignProbeOk(v({ sqrt: 1, ddDiv: 1 })) &&
			!alignProbeOk(v({}, "lost")),
	);
}

// ---------------- latticeSlack, f32Down / f32Up ----------------
{
	const sl = latticeSlack(
		[{ yaw: 300, pitch: -2, roll: 2, vfov: 50 }],
		{ yaw: 299, pitch: -2.1, roll: 2.4, vfov: 50 },
		50,
	);
	check(
		"latticeSlack: ordinary poses ≤ 1e-9 (far below f32 resolution)",
		sl.dB < 1e-9 && sl.relT < 1e-9 && sl.relV < 1e-9 && sl.pen < 1e-9,
		JSON.stringify(sl),
	);
}
{
	let bad = 0;
	for (const x of [
		0,
		1,
		-1,
		0.1,
		-0.1,
		1 / 3,
		1e-40,
		-1e-40,
		123456.789,
		2 ** -149,
		Math.PI,
		2 ** -126,
		-(2 ** -127),
	]) {
		const lo = f32Down(x);
		const hi = f32Up(x);
		if (
			!(lo <= x && x <= hi && Math.fround(lo) === lo && Math.fround(hi) === hi)
		)
			bad++;
		// exact f32 normals are their own bounds; nothing is ever subnormal
		if (
			Math.abs(x) >= 2 ** -126 &&
			Math.fround(x) === x &&
			(lo !== x || hi !== x)
		)
			bad++;
		if (Math.abs(lo) < 2 ** -126 || Math.abs(hi) < 2 ** -126) bad++;
	}
	check("f32Down / f32Up bracket their double and stay normal", bad === 0);
}

if (failures) {
	console.log(`${failures} FAILED`);
	process.exit(1);
}
console.log("all ok");
