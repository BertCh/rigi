#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Repeat test for the classic peak-label placement (workstream "labels", 2026-09-30).
// Opens /photo/<id>?renderer=deck N times in fresh browsers exactly like scripts/style-baseline.mjs
// (SwiftShader, DPR 1, 1120x700, the ground-truth pose injected as the saved pose, Overlay >
// Contours), waits until the canvas and label layer are stable, then records:
//   - every DOM label block (text + rect, rounded to 0.01 px) and a hash of them
//   - a hash of the export JPEG (engine.exportImage(true), the canvas-drawn labels)
//   - the Fira Sans font faces' load status at capture time
// and prints how many distinct DOM / export placements the runs produced (1 = deterministic).
//
// Usage (run through the render lock):
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/labels-repeat.mjs \
//     --url http://localhost:3156 --photo IMG_7068 --runs 5 --out out/gpu/followups/labels/after.json
// Stress: --font-delay 0,6000 (ms, cycled over runs) holds the Fira Sans files back; --cpu 1,4 slows
// the page (CDP CPU throttling), so label updates and readbacks interleave differently.
// --save-exports <dir> writes one export JPEG per distinct hash (to diff them).
// --wire 1 serves PhotoWorkspace with the proposed font-epoch memo deps (test-only injection).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++)
	if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
const BASE_URL = (opt.url ?? "http://localhost:3156").replace(/\/$/, "");
const id = opt.photo ?? "IMG_7068";
const runs = Number(opt.runs ?? 5);
/** ms to delay each fonts.gstatic.com response; a list ("0,6000") cycles over the runs */
const fontDelays = String(opt["font-delay"] ?? "0")
	.split(",")
	.map(Number);
const cpus = String(opt.cpu ?? "1")
	.split(",")
	.map(Number);
/** --wire 1: inject the useLabelFontEpoch wiring into the served PhotoWorkspace (see below) */
const wire = opt.wire === "1";
/** --save-exports <dir>: write one export JPEG per distinct export hash */
const saveExports = opt["save-exports"] ?? "";
const OUT = opt.out ? resolve(ROOT, opt.out) : null;
const W = 1120;
const H = 700;

const gt = JSON.parse(
	readFileSync(join(ROOT, "data/ground-truth.json"), "utf8"),
);
const g = gt[id];
const pose = {
	yaw: g.yaw,
	pitch: g.pitch,
	roll: g.roll,
	vfov: (2 * Math.atan(g.height / (2 * g.f)) * 180) / Math.PI,
};
const sha = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);

async function once(run) {
	const fontDelay = fontDelays[(run - 1) % fontDelays.length];
	const cpu = cpus[(run - 1) % cpus.length];
	const browser = await chromium.launch({
		headless: true,
		args: [
			"--use-angle=swiftshader",
			"--enable-unsafe-swiftshader",
			"--ignore-gpu-blocklist",
			"--font-render-hinting=none",
		],
	});
	try {
		const ctx = await browser.newContext({
			viewport: { width: W, height: H },
			deviceScaleFactor: 1,
			locale: "en-US",
			timezoneId: "Europe/Zurich",
		});
		await ctx.addInitScript(
			([key, val]) => {
				try {
					localStorage.setItem(key, val);
				} catch {}
			},
			[`mt-image:pose:${id}`, JSON.stringify(pose)],
		);
		await ctx.routeWebSocket(
			(u) => u.origin === new URL(BASE_URL).origin.replace(/^http/, "ws"),
			() => {},
		);
		// stress knobs (the flake needs timing to vary): hold the Google Fonts files back, slow the CPU
		if (fontDelay)
			await ctx.route(/fonts\.gstatic\.com/, async (route) => {
				await new Promise((r) => setTimeout(r, fontDelay));
				await route.continue();
			});
		if (wire)
			// test-only stand-in for the proposed PhotoWorkspace wiring (that file belongs to another
			// session): the served module gets `useLabelFontEpoch()` in the deps of its two label layout
			// memos, so they re-run when a font load finishes. The source file is not touched.
			await ctx.route(
				/\/src\/components\/PhotoWorkspace\.tsx/,
				async (route) => {
					const res = await route.fetch();
					let js = await res.text();
					const deps =
						/\[\s*labels,\s*stageSize\.w,\s*stageSize\.h,\s*viewStyle\.labels\s*\]/g;
					const n = js.match(deps)?.length ?? 0;
					if (n !== 2 || !js.includes("const placedRef = useRef([]);"))
						throw new Error(
							`--wire: PhotoWorkspace shape changed (${n} memo deps)`,
						);
					js =
						`import { useLabelFontEpoch as __useLabelFontEpoch } from "/src/lib/look/labels/useLabelFonts.ts";\n${js}`
							.replace(
								"const placedRef = useRef([]);",
								"const placedRef = useRef([]); const __lfe = __useLabelFontEpoch();",
							)
							.replace(
								deps,
								"[labels, stageSize.w, stageSize.h, viewStyle.labels, __lfe]",
							);
					await route.fulfill({ response: res, body: js });
				},
			);
		const page = await ctx.newPage();
		if (cpu > 1)
			await (await ctx.newCDPSession(page)).send(
				"Emulation.setCPUThrottlingRate",
				{ rate: cpu },
			);
		const t0 = Date.now();
		await page.goto(`${BASE_URL}/photo/${id}?renderer=deck`, {
			waitUntil: "load",
			timeout: 120000,
		});
		await page.waitForSelector("[data-ready]", {
			state: "attached",
			timeout: 300000,
		});
		const click = (name) =>
			page
				.getByRole("button", { name, exact: true })
				.first()
				.click({ timeout: 20000 });
		await click("Overlay");
		await click("Contours");
		await page.mouse.move(W - 2, H - 2);
		// stable: canvas pixels + label layer unchanged over 3 samples 0.8 s apart (as style-baseline)
		const waitStable = async () => {
			let last = "";
			let same = 0;
			const deadline = Date.now() + 180000;
			while (Date.now() < deadline) {
				await page.waitForTimeout(800);
				const h = await page.evaluate(() => {
					const c = document.querySelector("canvas");
					const gl = c?.getContext("webgl2");
					if (!c || !gl) return "nocanvas";
					const px = new Uint8Array(c.width * c.height * 4);
					gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
					let a = 0x811c9dc5;
					for (let i = 0; i < px.length; i++)
						a = Math.imul(a ^ px[i], 0x01000193);
					return `${a >>> 0}:${c.nextElementSibling?.innerHTML.length ?? 0}:${c.nextElementSibling?.innerHTML ?? ""}`;
				});
				if (h === last) {
					if (++same >= 3) break;
				} else {
					same = 0;
					last = h;
				}
			}
		};
		await waitStable();
		// the harness also waits for the network (so for the font files) before it captures: wait for
		// every font load in flight, then for the canvas and labels to settle again
		await page.evaluate(() => document.fonts.ready);
		await waitStable();
		const state = await page.evaluate(async (saveExports) => {
			const layer = document.querySelector("canvas")?.nextElementSibling;
			const blocks = [
				...(layer?.querySelectorAll(".whitespace-nowrap") ?? []),
			].map((el) => {
				const r = el.getBoundingClientRect();
				const f = (v) => Math.round(v * 100) / 100;
				return {
					text: [...el.children].map((c) => c.textContent).join(" / "),
					rect: [f(r.left), f(r.top), f(r.width), f(r.height)],
					// the layout's own output (classic.ts: anchorX, lead, align), independent of the drawn font
					place: [
						el.style.left,
						el.style.top,
						el.style.bottom,
						el.style.textAlign,
					],
				};
			});
			// Fira Sans faces per weight: loaded / declared (one face per subset)
			const fw = {};
			for (const f of document.fonts)
				if (/Fira Sans/.test(f.family)) {
					fw[f.weight] ??= [0, 0];
					fw[f.weight][1]++;
					if (f.status === "loaded") fw[f.weight][0]++;
				}
			const fonts = Object.entries(fw).map(([w, [l, n]]) => `${w}:${l}/${n}`);
			// the ranked, visible candidates before declutter (to tell "different input" from "different layout")
			const peaks = window.__engine
				.peakLabels(100, { declutter: false })
				.map((l) => [l.name, l.u, l.v, l.rank]);
			const blob = await window.__engine.exportImage(true);
			const buf = new Uint8Array(await blob.arrayBuffer());
			const d = await crypto.subtle.digest("SHA-1", buf);
			let b64 = "";
			if (saveExports)
				for (let i = 0; i < buf.length; i += 0x8000)
					b64 += String.fromCharCode(...buf.subarray(i, i + 0x8000));
			return {
				exportB64: saveExports ? btoa(b64) : "",
				blocks,
				peaks,
				fonts,
				exportSha: [...new Uint8Array(d)]
					.slice(0, 6)
					.map((x) => x.toString(16).padStart(2, "0"))
					.join(""),
			};
		}, saveExports);
		const domSha = sha(JSON.stringify(state.blocks));
		if (saveExports) {
			// one JPEG per distinct export hash, to see where two exports differ
			mkdirSync(saveExports, { recursive: true });
			const f = `${saveExports}/${id}-${state.exportSha}.jpg`;
			if (!existsSync(f))
				writeFileSync(f, Buffer.from(state.exportB64, "base64"));
		}
		const r = {
			run,
			fontDelay,
			cpu,
			wire,
			secs: (Date.now() - t0) / 1000,
			domSha,
			exportSha: state.exportSha,
			peaksSha: sha(JSON.stringify(state.peaks)),
			peaks: state.peaks,
			fonts: state.fonts.join(" "),
			blocks: state.blocks,
		};
		console.log(
			`[labels-repeat ${id} #${run} fontDelay ${fontDelay} cpu ${cpu}${wire ? " wired" : ""}] ${r.secs.toFixed(1)}s dom ${domSha} (${state.blocks.length} blocks) peaks ${r.peaksSha} (${state.peaks.length}) export ${r.exportSha} fonts ${r.fonts}`,
		);
		return r;
	} finally {
		await browser.close();
	}
}

const results = [];
for (let i = 1; i <= runs; i++) results.push(await once(i));
const dom = new Set(results.map((r) => r.domSha));
const exp = new Set(results.map((r) => r.exportSha));
console.log(
	`\n${id}: ${runs} runs -> ${dom.size} distinct DOM label placement(s), ${exp.size} distinct export image(s)`,
);
if (dom.size > 1) {
	// which blocks differ from run 1
	const ref = results[0].blocks;
	for (const r of results.slice(1)) {
		const diffs = r.blocks.filter(
			(b, i) => JSON.stringify(b) !== JSON.stringify(ref[i]),
		);
		if (diffs.length)
			console.log(
				`  run ${r.run} vs 1: ${diffs.length} block(s) differ, e.g. ${JSON.stringify(diffs[0])} vs ${JSON.stringify(ref[r.blocks.indexOf(diffs[0])])}`,
			);
	}
}
if (OUT) {
	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(
		OUT,
		`${JSON.stringify({ at: new Date().toISOString(), photo: id, pose, runs: results, distinctDom: dom.size, distinctExport: exp.size }, null, 2)}\n`,
	);
}
process.exit(dom.size > 1 || exp.size > 1 ? 3 : 0);
