#!/usr/bin/env node
// A/B of autoAlign's silhouette re-rank: GPU masks (silhouetteGpu = true, deck/silhouette-mask.ts)
// vs the CPU scorer (false), on every eval-app photo (data/control-points.json) and a few perturbed
// priors per photo, plus one autoAlign(false) from the settled pose. Every field of both AlignResults
// (pose, score, confidence, alternatives[i].{pose, score, sil, total}) is compared with Object.is;
// the run fails on any difference. Also records per-call re-rank ms, bytes read back and fallbacks.
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/silhouette-ab.mjs [--engine deck|webgpu]
//        [--reps N] [IMG_xxxx ...]
// deck       = the app page (/photo/<id>?renderer=deck, window.__engine = DeckEngine, WebGL2)
// webgpu-app = the app page with ?renderer=webgpu (window.__engine = WebGpuEngine, the default)
// webgpu     = WebGpuEngine created in-page on its own canvas (deck-webgpu/engine.check.ts style)
// Env APP_URL (default http://localhost:3100). Output: out/gpu/silhouette-ab-<engine>.json
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "../deck-webgpu/gpu-args.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3100";
const argv = process.argv.slice(2);
const opt = (k, d) => {
	const i = argv.indexOf(k);
	return i >= 0 ? argv[i + 1] : d;
};
const engine = opt("--engine", "deck");
const reps = Number(opt("--reps", "1"));
const only = argv.filter(
	(a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"),
);
const cps = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data/control-points.json"), "utf8"),
);
const ids = Object.keys(cps).filter((id) => !only.length || only.includes(id));
// prior perturbations (Δyaw°, Δpitch°): the search window moves, so do the finalists
const PERTURB = [
	[0, 0],
	[7, 0],
	[-7, 0.8],
	[15, -1],
];

async function inPage(o) {
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	let e = window.__engine;
	let dispose = () => {};
	if (o.engine === "webgpu") {
		const { WebGpuEngine } = await import("/src/lib/deck-webgpu/engine.ts");
		const { getPhoto, loadRegion } = await import("/src/lib/photos.ts");
		const avail = await WebGpuEngine.available();
		if (!avail.ok) return { error: `webgpu: ${avail.reason}` };
		const photo = getPhoto(o.id);
		const c = document.createElement("canvas");
		c.style.cssText =
			"position:fixed;left:0;top:0;width:960px;height:640px;z-index:9999";
		document.body.appendChild(c);
		e = new WebGpuEngine(c, photo, {});
		e.resize(960, 640);
		await e.init(loadRegion(photo.region).catch(() => null));
		await e.readback();
		dispose = () => {
			e.dispose();
			c.remove();
		};
	}
	const diffs = [];
	const cmp = (a, b, at) => {
		if (typeof a === "number" || typeof b === "number") {
			if (!Object.is(a, b)) diffs.push(`${at}: ${a} vs ${b}`);
			return;
		}
		if (a === null || b === null || typeof a !== "object") {
			if (!Object.is(a, b)) diffs.push(`${at}: ${a} vs ${b}`);
			return;
		}
		const ka = Object.keys(a).sort();
		const kb = Object.keys(b).sort();
		if (ka.join() !== kb.join()) diffs.push(`${at}: keys ${ka} vs ${kb}`);
		for (const k of ka) cmp(a[k], b[k], `${at}.${k}`);
	};
	const prior0 = { ...e.prior };
	const calls = [];
	const run = async (gpu, fromPrior) => {
		e.silhouetteGpu = gpu;
		const t = performance.now();
		const r = await e.autoAlign(fromPrior);
		const wall = performance.now() - t;
		const s = e.stats.silhouette;
		return { r, wall, s: s ? { ...s } : null };
	};
	const cases = o.perturb.map(([dy, dp]) => ({ dy, dp, fromPrior: true }));
	cases.push({ dy: 0, dp: 0, fromPrior: false });
	for (const [ci, c] of cases.entries())
		for (let rep = 0; rep < o.reps; rep++) {
			Object.assign(e.prior, {
				yaw: prior0.yaw + c.dy,
				pitch: prior0.pitch + c.dp,
			});
			// alternate which path runs first (autoAlign refits the sky model from the prior)
			const gpuFirst = (ci + rep) % 2 === 1;
			const first = await run(gpuFirst, c.fromPrior);
			await wait(50);
			const second = await run(!gpuFirst, c.fromPrior);
			const [g, cpu] = gpuFirst ? [first, second] : [second, first];
			const before = diffs.length;
			cmp(g.r, cpu.r, `case${ci}`);
			calls.push({
				case: c,
				rep,
				alts: cpu.r?.alternatives?.length ?? 0,
				diffs: diffs.length - before,
				gpu: { wall: g.wall, ...g.s },
				cpu: { wall: cpu.wall, ...cpu.s },
			});
		}
	Object.assign(e.prior, prior0);
	e.silhouetteGpu = true;
	// the engine that actually ran (webgpu-app may fall back to the WebGL deck)
	const ran = e.backend === "webgpu" ? "webgpu" : (e.kind ?? "three");
	dispose();
	return { diffs, calls, ran };
}

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const out = { engine, base: BASE, reps, photos: {} };
let total = 0;
let compared = 0;
for (const id of ids) {
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const errs = [];
	page.on("pageerror", (e) => errs.push(e.message));
	page.on("console", (m) => {
		if (/silhouette-(gl|gpu)/.test(m.text())) errs.push(m.text());
	});
	await page.addInitScript(() => localStorage.clear());
	let res;
	try {
		if (engine === "deck" || engine === "webgpu-app") {
			const r = engine === "deck" ? "deck" : "webgpu";
			await page.goto(`${BASE}/photo/${id}?renderer=${r}`);
			await page.waitForSelector("[data-ready]", {
				state: "attached",
				timeout: 180000,
			});
			await page.waitForFunction(
				() =>
					document
						.querySelector("[data-ready]")
						?.getAttribute("data-verify") !== "pending",
				null,
				{ timeout: 180000 },
			);
		} else await page.goto(`${BASE}/`);
		res = await page.evaluate(inPage, {
			id,
			engine,
			perturb: PERTURB,
			reps,
		});
	} catch (e) {
		res = { error: String(e).slice(0, 400) };
	}
	res.errors = errs;
	out.photos[id] = res;
	const n = res.diffs?.length ?? 0;
	total += n;
	compared += res.calls?.length ?? 0;
	const fb = (res.calls ?? []).reduce((s, c) => s + (c.gpu.fallbacks ?? 0), 0);
	const paths = [...new Set((res.calls ?? []).map((c) => c.gpu.path))];
	console.log(
		`${id}  [${res.ran ?? "?"}]  ${res.error ? `ERROR ${res.error}` : `${res.calls.length} comparisons, ${n} diffs, gpu path ${paths}, fallbacks ${fb}`}${errs.length ? `  [${errs.length} console]` : ""}`,
	);
	await page.close();
}
await browser.close();

const calls = Object.values(out.photos).flatMap((p) => p.calls ?? []);
const med = (xs) => {
	const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
	return s.length ? s[s.length >> 1] : null;
};
const sum = (k, f) => med(calls.map((c) => f(c[k])));
out.summary = {
	comparisons: compared,
	diffs: total,
	errors: Object.entries(out.photos)
		.filter(([, p]) => p.error)
		.map(([id]) => id),
	fallbacks: calls.reduce((s, c) => s + (c.gpu.fallbacks ?? 0), 0),
	gpuPaths: calls.filter((c) => c.gpu.path === "gpu").length,
	median: {
		rerankMs: { gpu: sum("gpu", (s) => s.ms), cpu: sum("cpu", (s) => s.ms) },
		scoreMs: {
			gpu: sum("gpu", (s) => s.scoreMs),
			cpu: sum("cpu", (s) => s.scoreMs),
		},
		bytes: { gpu: sum("gpu", (s) => s.bytes), cpu: sum("cpu", (s) => s.bytes) },
		autoAlignWallMs: {
			gpu: sum("gpu", (s) => s.wall),
			cpu: sum("cpu", (s) => s.wall),
		},
	},
};
fs.mkdirSync(path.join(ROOT, "out/gpu"), { recursive: true });
const file = path.join(ROOT, `out/gpu/silhouette-ab-${engine}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.summary, null, 1));
console.log(`→ ${path.relative(ROOT, file)}`);
process.exit(total === 0 && !out.summary.errors.length ? 0 : 1);
