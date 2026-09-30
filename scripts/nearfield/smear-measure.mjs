#!/usr/bin/env node
// P1 exit gate "the split removes >= 80% of person/hut/tree drape smear" (reports/step-inside-design.md).
// Labels: tools/nearfield/smear/labels.json (hand-drawn blind, before any Step Inside run).
//
// Smear is computed from the engine's own drape visibility rule (materials.ts / deck terrain-layer.ts):
// a terrain fragment takes photo pixel puv when
//     seen(puv) > 0  &&  r < seen*1.015 + 15  &&  r > minProjectRange  &&  !(photoFg(puv) > 0.5)
// For photo pixel puv the fragment that passes is the first DEM hit along the ray (r == seen), so the
// photo pixel is painted onto terrain ("smeared", when the pixel shows an object standing above the
// ground) iff  seen > minProjectRange && mask(puv) <= 0.5 . `seen` = engine.sampleAt(u, v).range (the
// readback of the same GPU range buffer the shader samples); the mask is the texture the drape binds
// in the world view (off: people mask when protectPeople; on: three nf.masks.worldFg|worldObj,
// deck drapeMask().photoFg), bilinear like the GPU sampler.
// Which of those terrain points a given offset viewer then sees is a visibility question of the
// viewer, not of the drape: the photo-space fraction is the viewpoint-independent smear.
//
//   node scripts/gpu/with-render-lock.mjs -- node scripts/nearfield/smear-measure.mjs [--renderer=deck] [ids…]
// Output: tools/nearfield/smear/grid-<renderer>-<id>.json (per-cell arrays) + summary via smear-report.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3110";
const OUT = join(ROOT, "tools/nearfield/smear");
mkdirSync(OUT, { recursive: true });
const gt = JSON.parse(
	readFileSync(join(ROOT, "data/ground-truth.json"), "utf8"),
);
const labels = JSON.parse(readFileSync(join(OUT, "labels.json"), "utf8"));
const arg = (k, d) =>
	process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const renderer = arg("renderer", "three");
const GW = Number(arg("grid", "320"));
const VARIANTS = arg("variants", "").split(",").filter(Boolean).map(Number);
let ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!ids.length) ids = Object.keys(labels.photos).sort();

const fixedPose = (id) => {
	const g = gt[id];
	return {
		yaw: g.yaw,
		pitch: g.pitch,
		roll: g.roll,
		vfov: (2 * Math.atan(g.height / (2 * g.f)) * 180) / Math.PI,
	};
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
for (const id of ids) {
	const log = (...m) => console.log(`[${renderer} ${id}]`, ...m);
	const ctx = await browser.newContext({
		viewport: { width: 1400, height: 900 },
		deviceScaleFactor: 1,
	});
	await ctx.addInitScript(
		([k, v]) => {
			try {
				localStorage.setItem(k, v);
			} catch {}
		},
		[`mt-image:pose:${id}`, JSON.stringify(fixedPose(id))],
	);
	await ctx.routeWebSocket(
		(u) => u.origin === new URL(BASE).origin.replace(/^http/, "ws"),
		() => {},
	);
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	try {
		const q = renderer === "three" ? "" : `&renderer=${renderer}`;
		await page.goto(`${BASE}/photo/${id}?nearfield=on${q}`);
		await page.waitForSelector("[data-ready]", {
			state: "attached",
			timeout: 180000,
		});
		await page.waitForSelector("[data-nearfield-status]", { timeout: 30000 });
		// the people mask lands asynchronously (MediaPipe); wait for it (or give up: no people)
		for (let t = 0; t < 30; t++) {
			if (await page.evaluate(() => !!window.__engine.foregroundMask)) break;
			await sleep(500);
		}
		await sleep(1000);
		const res = await page.evaluate(
			async ({ GW, renderer, VARIANTS }) => {
				const eng = window.__engine;
				const nf = window.__nearfield;
				const bilinear = (m, u, v) => {
					if (!m) return 0;
					const { width: w, height: h, data, stride = 1 } = m;
					const x = Math.min(w - 1, Math.max(0, u * w - 0.5));
					const y = Math.min(h - 1, Math.max(0, v * h - 0.5));
					const x0 = Math.floor(x);
					const y0 = Math.floor(y);
					const x1 = Math.min(w - 1, x0 + 1);
					const y1 = Math.min(h - 1, y0 + 1);
					const fx = x - x0;
					const fy = y - y0;
					const at = (xx, yy) => data[(yy * w + xx) * stride] / 255;
					return (
						(at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) +
						(at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy
					);
				};
				const s = eng.settings ?? {};
				const protect = s.protectPeople !== false;
				const minRange = s.minProjectRange ?? 80;
				const fg = eng.foregroundMask ?? null;
				// feature OFF: exactly the classic drape mask
				const offMask = protect ? fg : null;
				const built = await nf.build();
				const st = nf.state;
				const cache = nf.controller.sceneCache;
				const scene =
					built ?? (cache?.size ? [...cache.values()].at(-1) : null) ?? null;
				let onMask = null;
				let forced = false;
				if (scene) {
					if (!built) {
						// below the quality gate the product shows nothing: force it only to measure the split
						forced = true;
						eng.setNearField(scene, { maskDrape: true });
					} else nf.show({ truth: false, maskDrape: true });
					await new Promise((r) =>
						requestAnimationFrame(() => requestAnimationFrame(r)),
					);
					if (renderer === "three") {
						const m = eng.nf?.masks;
						const t = m && (protect ? m.worldFg : m.worldObj);
						if (t)
							onMask = {
								width: t.image.width,
								height: t.image.height,
								data: t.image.data,
								stride: 4,
							};
					} else {
						const dm = eng.drapeMask();
						onMask = dm.protectPeople ? dm.photoFg : null;
					}
				}
				// sensitivity (diagnostic only, not the product): the same scene build with a larger nearRadius;
				// drape mask = split Object cells (3x3 dilated, as engine.ts worldFg) OR the people mask
				const variants = {};
				const radii = VARIANTS; // [] unless --variants=300,500
				if (radii.length && scene) {
					const data = await nf.controller.fetchPhotoData();
					const { buildNearFieldScene } = await import(
						"/src/lib/nearfield/scene.ts"
					);
					const { STEP_SPLIT } = await import(
						"/src/lib/nearfield/controller.ts"
					);
					for (const R of radii) {
						const sc = buildNearFieldScene({
							photoId: "smear",
							depth: data.depth,
							cloud: data.cloud,
							cloudIntrinsics: data.cloudK,
							renderer: eng,
							photo: null,
							skyMask: eng.skyMaskData ?? null,
							peopleMask: fg,
							split: { ...STEP_SPLIT, nearRadius: R },
						});
						const { width: w, height: h, cls: c } = sc.split;
						const obj = new Uint8Array(w * h);
						for (let y = 0; y < h; y++)
							for (let x = 0; x < w; x++) {
								if (c[y * w + x] !== 2) continue;
								for (let dy = -1; dy <= 1; dy++)
									for (let dx = -1; dx <= 1; dx++) {
										const xx = x + dx;
										const yy = y + dy;
										if (xx >= 0 && yy >= 0 && xx < w && yy < h)
											obj[yy * w + xx] = 255;
									}
							}
						variants[R] = {
							m: { width: w, height: h, data: obj },
							counts: sc.split.counts,
						};
					}
				}
				const aspect = eng.aspect; // W/H of the photo
				const GH = Math.round(GW / aspect);
				const n = GW * GH;
				const range = new Array(n);
				const off = new Array(n);
				const on = new Array(n);
				const cls = new Array(n);
				const sp = scene?.split;
				const vOn = {};
				for (const R of Object.keys(variants)) vOn[R] = new Array(n);
				for (let j = 0; j < GH; j++)
					for (let i = 0; i < GW; i++) {
						const k = j * GW + i;
						const u = (i + 0.5) / GW;
						const v = (j + 0.5) / GH;
						const r = eng.sampleAt(u, v)?.range ?? 0;
						range[k] = Math.round(r * 10) / 10;
						off[k] = bilinear(offMask, u, v) > 0.5 ? 1 : 0;
						on[k] = scene ? (bilinear(onMask, u, v) > 0.5 ? 1 : 0) : off[k];
						for (const [R, vv] of Object.entries(variants))
							vOn[R][k] =
								Math.max(
									bilinear(vv.m, u, v),
									protect ? bilinear(fg, u, v) : 0,
								) > 0.5
									? 1
									: 0;
						cls[k] = sp
							? sp.cls[
									Math.min(sp.height - 1, Math.floor(v * sp.height)) *
										sp.width +
										Math.min(sp.width - 1, Math.floor(u * sp.width))
								]
							: 255;
					}
				return {
					GW,
					GH,
					aspect,
					protect,
					minRange,
					hasPeopleMask: !!fg,
					fresh: eng.geometryReady?.() ?? null,
					quality: scene?.anchor?.quality ?? null,
					phase: st?.phase,
					forced,
					hasScene: !!scene,
					splitCounts: sp?.counts ?? null,
					variants: Object.fromEntries(
						Object.entries(variants).map(([R, vv]) => [
							R,
							{ counts: vv.counts, on: vOn[R] },
						]),
					),
					range,
					off,
					on,
					cls,
				};
			},
			{ GW, renderer, VARIANTS },
		);
		res.id = id;
		res.renderer = renderer;
		res.errors = errors.slice(0, 10);
		writeFileSync(
			join(OUT, `grid-${renderer}-${id}.json`),
			JSON.stringify(res),
		);
		log(
			"q",
			res.quality?.toFixed?.(3),
			res.phase,
			"forced",
			res.forced,
			"fresh",
			res.fresh,
			"people",
			res.hasPeopleMask,
			"offMasked",
			res.off.reduce((a, b) => a + b, 0),
			"onMasked",
			res.on.reduce((a, b) => a + b, 0),
		);
	} catch (e) {
		log("ERROR", String(e?.message ?? e).slice(0, 300));
		writeFileSync(
			join(OUT, `grid-${renderer}-${id}.json`),
			JSON.stringify({ id, renderer, error: String(e?.message ?? e) }),
		);
	} finally {
		await ctx.close();
	}
}
await browser.close();
