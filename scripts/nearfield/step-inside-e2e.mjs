#!/usr/bin/env node
// Step Inside end to end, per deck renderer (headless, real GPU; default WebGL deck). For each photo: GT pose injected as the
// saved pose (accepted), panel + anchor quality, hover readout on an Object pixel, step inside (start ==
// photo camera, orbit moves), Truth, back, In map drape with the feature on vs off, the .ply export.
// Screenshots → tools/nearfield/shots/e2e-<renderer>-<id>-*.png, numbers → e2e-report-<renderer>.json.
//   node scripts/gpu/with-render-lock.mjs -- node scripts/nearfield/step-inside-e2e.mjs --renderer=deck IMG_7018
//   --survey: only build every GT photo (quality / Object pixels)
//   --dead: service URL pointed at a dead port (window.__nearfieldUrl) → the panel must stay invisible
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3110";
const OUT = join(ROOT, "tools/nearfield/shots");
mkdirSync(OUT, { recursive: true });
const gt = JSON.parse(
	readFileSync(join(ROOT, "data/ground-truth.json"), "utf8"),
);
const arg = (k, d) =>
	process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const renderer = arg("renderer", "deck");
const survey = process.argv.includes("--survey");
let ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (survey && !ids.length) ids = Object.keys(gt).sort();
if (!ids.length) ids = ["IMG_7018", "IMG_7130"];

const fixedPose = (id) => {
	const g = gt[id];
	return {
		yaw: g.yaw,
		pitch: g.pitch,
		roll: g.roll,
		vfov: (2 * Math.atan(g.height / (2 * g.f)) * 180) / Math.PI,
	};
};

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const report = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const id of ids) {
	const r = { id, renderer };
	report[id] = r;
	const log = (...m) => console.log(`[${renderer} ${id}]`, ...m);
	const ctx = await browser.newContext({
		viewport: { width: 1400, height: 900 },
		deviceScaleFactor: 1,
		acceptDownloads: true,
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
	if (process.argv.includes("--dead"))
		await ctx.route(/127\.0\.0\.1:8767/, (route) => route.abort());
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => {
		if (m.type() === "error" || /nearfield/i.test(m.text()))
			errors.push(`[console.${m.type()}] ${m.text()}`.slice(0, 300));
	});
	const shot = async (name) => {
		const f = join(OUT, `e2e-${renderer}-${id}-${name}.png`);
		await page.locator("canvas").first().screenshot({ path: f });
		return f;
	};
	const frame = () =>
		page.evaluate(
			() =>
				new Promise((res) =>
					requestAnimationFrame(() => requestAnimationFrame(res)),
				),
		);
	try {
		const q = `&renderer=${renderer}`; // always explicit: the app default may be either
		await page.goto(`${BASE}/photo/${id}?nearfield=on${q}`);
		await page.waitForSelector("[data-ready]", {
			state: "attached",
			timeout: 180000,
		});
		r.align = await page.getAttribute("[data-ready]", "data-align");
		r.hasPeople = await page.evaluate(() => window.__engine.hasPeople);
		if (process.argv.includes("--dead")) {
			await sleep(4000);
			r.panel = await page.locator("[data-nearfield-status]").count();
			r.handle = await page.evaluate(() =>
				window.__nearfield ? window.__nearfield.state : null,
			);
			await shot("dead");
			await page.getByRole("button", { name: "In map" }).click();
			await sleep(3000);
			r.panelWorld = await page.locator("[data-nearfield-status]").count();
			await shot("dead-world");
			continue;
		}
		await page.waitForSelector("[data-nearfield-status]", { timeout: 30000 });
		r.statusBefore = await page.getAttribute(
			"[data-nearfield-status]",
			"data-nearfield-status",
		);
		await sleep(800);
		await shot("0-photo");
		const t0 = Date.now();
		const built = await page.evaluate(async () => {
			const nf = window.__nearfield;
			const s = await nf.build();
			const st = nf.state;
			return {
				ok: !!s,
				state: st,
				counts: s?.split.counts,
				anchor: s
					? { ...s.anchor, curve: undefined }
					: nf.controller.state.quality,
				radius: s?.confidenceRadius,
				model: s?.model,
			};
		});
		r.buildMs = Date.now() - t0;
		Object.assign(r, built);
		await sleep(300);
		r.statusAfter = await page.getAttribute(
			"[data-nearfield-status]",
			"data-nearfield-status",
		);
		r.qualityAttr = await page.getAttribute(
			"[data-nearfield-status]",
			"data-nearfield-quality",
		);
		log(
			"build",
			r.buildMs,
			"ms q",
			built.state.quality?.toFixed(3),
			built.state.phase,
			"splats",
			built.state.splats,
			"obj px",
			built.state.objectPixels,
		);
		if (survey || !built.ok) {
			if (!built.ok) await shot("1-not-built");
			continue;
		}
		// hover an Object pixel: readout must say 'object', range nearer than the terrain behind
		const probe = await page.evaluate(() => {
			const nf = window.__nearfield;
			const s = nf.controller.scene;
			const { width: W, height: H, cls } = s.split;
			let sx = 0;
			let sy = 0;
			let n = 0;
			for (let j = 0; j < H; j++)
				for (let i = 0; i < W; i++)
					if (cls[j * W + i] === 2) {
						sx += i;
						sy += j;
						n++;
					}
			if (!n) return null;
			const cx = sx / n;
			const cy = sy / n;
			let best = null;
			let bd = Infinity;
			for (let j = 0; j < H; j += 2)
				for (let i = 0; i < W; i += 2) {
					if (cls[j * W + i] !== 2) continue;
					const u = (i + 0.5) / W;
					const v = (j + 0.5) / H;
					const m = nf.sampleAt(u, v);
					if (!m) continue;
					const d = (i - cx) ** 2 + (j - cy) ** 2;
					if (d < bd) {
						bd = d;
						best = { u, v, m, terrain: window.__engine.sampleAt(u, v) };
					}
				}
			return best;
		});
		r.probe = probe && {
			u: probe.u,
			v: probe.v,
			objRange: probe.m.range,
			terrainRange: probe.terrain?.range ?? null,
		};
		if (probe) {
			const box = await page.locator("canvas").first().boundingBox();
			await page.mouse.move(
				box.x + probe.u * box.width,
				box.y + probe.v * box.height,
			);
			await sleep(200);
			r.hoverObject =
				(await page.locator("[data-hover-source=object]").count()) > 0;
			await page.screenshot({
				path: join(OUT, `e2e-${renderer}-${id}-1-hover.png`),
			});
			await page.mouse.move(box.x + 5, box.y + 5);
		}
		// step inside: start must equal the photo camera
		await page.click("[data-nearfield-enter]");
		await page.waitForSelector('[data-nearfield-status="stepping"]', {
			timeout: 60000,
		});
		await sleep(1800);
		await frame();
		await shot("2-step-start");
		r.stepStart = await page.evaluate(() => {
			const s = window.__nearfield.step;
			return s ? { atPhoto: s.atPhoto, offsetM: s.offsetM } : null;
		});
		await page.evaluate(() => {
			const s = window.__nearfield.step;
			s.orbit(10, 3);
			s.pan(0, 0, 1.5);
			s.snap();
		});
		await sleep(1200);
		await frame();
		r.offsetM = await page.evaluate(() => window.__nearfield.step?.offsetM);
		await shot("3-step-orbit");
		await page.click("[data-nearfield-truth]");
		await sleep(900);
		await shot("4-step-truth");
		await page.click("[data-nearfield-truth]");
		await page.click("[data-nearfield-back]");
		await page.waitForFunction(
			() => window.__nearfield.step?.atPhoto !== false,
			null,
			{ timeout: 10000 },
		);
		await sleep(600);
		const back = page.locator("[data-nearfield-back]");
		if (await back.count()) await back.click();
		await page.waitForSelector(
			'[data-nearfield-status]:not([data-nearfield-status="stepping"])',
		);
		await sleep(900);
		await shot("5-photo-after");
		// export .ply through the menu
		await page.locator("[data-export-menu] > button").click();
		await sleep(600);
		const item = page.locator('[data-export-kind="splat-ply"]');
		r.exportItems = await page
			.locator("[data-export-kind]")
			.evaluateAll((els) => els.map((e) => e.getAttribute("data-export-kind")));
		if (await item.count()) {
			const [dl] = await Promise.all([
				page.waitForEvent("download", { timeout: 15000 }),
				item.click(),
			]);
			const f = join(OUT, `e2e-${renderer}-${id}.enu.ply`);
			await dl.saveAs(f);
			const buf = readFileSync(f);
			const head = buf
				.subarray(0, Math.min(buf.length, 8000))
				.toString("latin1");
			const end = head.indexOf("end_header");
			const hdr = head.slice(0, end);
			r.export = {
				bytes: buf.length,
				vertices: Number(/element vertex (\d+)/.exec(hdr)?.[1]),
				model: /comment model (.*)/.exec(hdr)?.[1],
				quality: /comment anchor_quality (.*)/.exec(hdr)?.[1],
				commercial: /comment commercial_use (.*)/.exec(hdr)?.[1],
				generated: /provenance_counts .*generated (\d+)/.exec(hdr)?.[1],
			};
		}
		await page.keyboard.press("Escape");
		await page.mouse.click(700, 450);
		// In map: drape with the feature on vs off, at the photo camera and from the overview
		await page.getByRole("button", { name: "In map" }).click();
		await sleep(3500);
		await page.evaluate(() => window.__engine.flyToPhoto(1));
		await sleep(2500);
		await frame();
		await shot("6-world-at-photo-on");
		await page.evaluate(() => window.__engine.flyOut());
		await sleep(3000);
		await frame();
		await shot("7-world-overview-on");
		await page.evaluate(() => window.__nearfield.hide());
		await sleep(1500);
		await frame();
		await shot("8-world-overview-off");
		await page.evaluate(() => window.__engine.flyToPhoto(1));
		await sleep(2500);
		await frame();
		await shot("9-world-at-photo-off");
		await page.evaluate(() =>
			window.__nearfield.show({ truth: false, maskDrape: true }),
		);
		// step inside from In map, back
		await page.click("[data-nearfield-enter]");
		await page.waitForSelector('[data-nearfield-status="stepping"]', {
			timeout: 30000,
		});
		await sleep(1500);
		await shot("10-world-step");
		await page.click("[data-nearfield-back]");
		await page.waitForSelector(
			'[data-nearfield-status]:not([data-nearfield-status="stepping"])',
			{ timeout: 15000 },
		);
		await sleep(800);
		r.worldAfterStep = await page.evaluate(() => ({
			mode: window.__engine.settings?.mode,
		}));
	} catch (e) {
		r.error = String(e?.message ?? e).slice(0, 400);
		log("ERROR", r.error);
		await shot("x-error").catch(() => {});
	} finally {
		r.errors = errors.slice(0, 20);
		await ctx.close();
	}
	log(JSON.stringify({ ...r, errors: r.errors.length, state: undefined }));
}
await browser.close();
const f = join(
	OUT,
	`e2e-report-${renderer}${survey ? "-survey" : ""}${process.argv.includes("--dead") ? "-dead" : ""}.json`,
);
writeFileSync(f, JSON.stringify(report, null, 1));
console.log("wrote", f);
