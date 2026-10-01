#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors


// Pixel-diff baseline harness for the photo route (styling chunk 0, see out/lead/deck-parity/styling.md §4).
// It captures /photo/<id>?renderer=deck (the WebGL deck engine) in each view at a fixed pose with the CPU
// WebGL backend (SwiftShader), then compares the captures against the stored baseline so each styling
// chunk can show that "classic" is still pixel-identical.
//
// RECAPTURE REQUIRED (2026-10-01): until then this harness ran the three.js PhotoEngine (?renderer=three),
// which has been removed. Its baseline (out/lead/style-baseline) is a three.js reference and means nothing
// for deck, so the default root moved to out/lead/style-baseline-deck, which starts empty: `check` exits 1
// ("no baseline") and the CI row (scripts/ci/checks.mjs style-baseline) SKIPs until someone captures the
// deck reference ONCE, deliberately, on a tree whose classic look is known good:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/style-baseline.mjs capture --url http://localhost:3100
// Only after that is the classic pixel check (and the geometry hash) meaningful again.
//
// Usage (the vite dev server must be on :3100, because the harness needs window.__engine):
//   node scripts/style-baseline.mjs check               capture and diff against the baseline (the normal run)
//   node scripts/style-baseline.mjs capture --force     re-take the baseline (only on purpose; see below)
//   node scripts/style-baseline.mjs check --record-geometry
//                                                       check, then (only if every image row passes) replace
//                                                       just the geometry reference (hashes + range maps)
//
// Options:
//   --url http://localhost:3100    dev server
//   --photos IMG_7086,IMG_7068     subset of photos (default: PHOTOS below)
//   --views overlay-contours,...   subset of views (default: VIEWS below)
//   --no-export                    skip the engine.exportImage(true) capture
//   --tol 0                        per-channel tolerance (0..255) when counting differing pixels
//   --noise 0.01                   % of a capture's pixels that may differ and still count as run-to-run
//                                  noise (status "noise", exit 0). --noise 0 demands exact identity.
//   --out out/lead/style-baseline-deck  root directory (the three.js-era baseline is in out/lead/style-baseline)
//
// Disk use (the disk is often nearly full): the baseline is about 10 MB. `check` keeps no copy of
// its captures. It compares in memory and writes only report.json, plus a <name>.diff.png (differing
// pixels in red over a grey copy) for each capture with status "diff" (not for noise). Old diff images are removed when a
// check starts.
//
// What it also checks: the geometry pass (ENU xyz + range, read by align.ts, sampleAt, labels and
// occlusion). It hashes the engine's CPU copy of the geometry buffer (deck: the GeometrySource's range +
// xyz, row 0 = top) for each photo and compares it with baseline.json; the range (sky = 0) is also stored (baseline/<id>__geometry-range.f32.gz)
// so a mismatch reports how many pixels differ and by how much (m). Owner requirement (session 9e): style chunks must never
// change the geometry output, so a geometry-hash mismatch is always a failure.
//
// Required after every later styling chunk (2–7):
//   1. node scripts/style-baseline.mjs check    -> "N/N pass", no "diff" rows, "geometry: identical"
//   2. node scripts/eval-app.mjs                -> the app accuracy eval against :3100, compared with
//                                                  the previous numbers (9e's requirement)
//
// How determinism is achieved: SwiftShader, DPR 1, a fixed viewport, a fixed pose from
// data/ground-truth.json injected as the saved pose (so no auto-align or second opinion runs),
// and a wait before each capture until the network is idle and the canvas and label layer are
// unchanged across 3 samples 0.8 s apart.
// Known residual noise (measured 2026-09-25, 3 runs against one baseline): with the geometry hash
// identical, 0–2 isolated pixels (max Δ ≤ 21) differ in some photo views, about 16 px (Δ 1) in the
// 2048 px export JPEG, and 8–35 px (Δ ≤ 16) in the world view. They sit mostly on trail lines and
// silhouette edges. That is far below any real style change (a changed colour or line width moves
// thousands of pixels), so the default --noise 0.01 % (48 px on an 800x600 capture) marks them
// "noise", not "diff". The exact counts are always printed. A real regression must show "diff".
// Exit code: 0 = everything identical, 3 = differences, 1 or 2 = errors.

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- config -----------------------------------------------------------------------------
/** IMG_7086: snowy Bernese Alps + a person (foreground mask), landscape. IMG_7068: portrait. */
const PHOTOS = ["IMG_7086", "IMG_7068"];

/**
 * `mode` and `pick` are clicked in the sidebar, so React state, stage sizing and the label layer
 * behave exactly as they do for a user. `engine` is an extra partial of Settings pushed to
 * window.__engine after the clicks. RESET_ENGINE undoes it for the next view.
 */
const VIEWS = [
	{ id: "overlay-contours", mode: "Overlay", pick: ["Contours"] },
	{ id: "overlay-bands", mode: "Overlay", pick: ["Bands"] },
	{
		id: "overlay-depthtint",
		mode: "Overlay",
		pick: ["Contours"],
		engine: { depthTint: 0.6 },
	},
	{ id: "replace-satellite", mode: "Blend", pick: ["Satellite", "Lens"] },
	{ id: "replace-topo", mode: "Blend", pick: ["Topo map", "Lens"] },
	{ id: "replace-hillshade", mode: "Blend", pick: ["Relief", "Lens"] },
	{ id: "world-satellite", mode: "In map", pick: ["Satellite"] },
];
const RESET_ENGINE = { depthTint: 0 };

// 320 px sidebar + an 800 px stage (a 4:3 photo renders at 800x600)
const W = 1120;
const H = 700;

// ---- args -------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = {};
for (let i = 1; i < argv.length; i++) {
	const a = argv[i];
	if (!a.startsWith("--")) continue;
	const k = a.slice(2);
	if (k === "force" || k === "no-export" || k === "record-geometry")
		opt[k] = true;
	else opt[k] = argv[++i];
}
if (!["capture", "check"].includes(cmd)) {
	console.error(
		"usage: node scripts/style-baseline.mjs check | capture --force  [--url] [--photos] [--views] [--no-export] [--tol] [--out]",
	);
	process.exit(1);
}
const BASE_URL = (opt.url ?? "http://localhost:3100").replace(/\/$/, "");
const OUT = resolve(ROOT, opt.out ?? "out/lead/style-baseline-deck");
const BASE_DIR = join(OUT, "baseline");
const DIFF_DIR = join(OUT, "diff");
const META = join(OUT, "baseline.json");
const photos = opt.photos ? opt.photos.split(",") : PHOTOS;
const views = opt.views
	? VIEWS.filter((v) => opt.views.split(",").includes(v.id))
	: VIEWS;
const tol = Number(opt.tol ?? 0);
const noisePct = Number(opt.noise ?? 0.01);
const withExport = !opt["no-export"];

const t0 = Date.now();

/** Newest mtime under src/: a change during a run means the captures may mix two code versions. */
function srcStamp() {
	let max = 0;
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else max = Math.max(max, statSync(p).mtimeMs);
		}
	};
	walk(join(ROOT, "src"));
	return max;
}
const stamp0 = srcStamp();
const srcWarning = () =>
	srcStamp() !== stamp0
		? "WARN: files under src/ changed during this run (another session?); re-run before trusting a diff"
		: null;
const log = (...m) =>
	console.log(
		`[style-baseline ${((Date.now() - t0) / 1000).toFixed(1)}s]`,
		...m,
	);

// ---- fixed poses --------------------------------------------------------------------------
const gt = JSON.parse(
	readFileSync(join(ROOT, "data/ground-truth.json"), "utf8"),
);
function fixedPose(id) {
	const g = gt[id];
	if (!g) throw new Error(`no ground truth for ${id}`);
	// Pose.vfov is the FOV across the photo's own vertical side: 2·atan(H / 2f), f in GT pixels
	const vfov = (2 * Math.atan(g.height / (2 * g.f)) * 180) / Math.PI;
	return { yaw: g.yaw, pitch: g.pitch, roll: g.roll, vfov };
}

// ---- pixels -------------------------------------------------------------------------------
async function decode(buf) {
	const img = await loadImage(buf);
	const c = createCanvas(img.width, img.height);
	const g = c.getContext("2d");
	g.drawImage(img, 0, 0);
	return {
		w: img.width,
		h: img.height,
		data: g.getImageData(0, 0, img.width, img.height).data,
	};
}

/** Compare a capture (buffer) with its baseline file; writes a diff image only on failure. */
async function compare(name, buf) {
	const bf = join(BASE_DIR, name);
	if (!existsSync(bf)) return { file: name, status: "no-baseline" };
	const a = await decode(readFileSync(bf));
	const b = await decode(buf);
	if (a.w !== b.w || a.h !== b.h)
		return {
			file: name,
			status: "size",
			base: `${a.w}x${a.h}`,
			cur: `${b.w}x${b.h}`,
		};
	let diff = 0;
	let maxd = 0;
	const out = createCanvas(a.w, a.h);
	const og = out.getContext("2d");
	const od = og.createImageData(a.w, a.h);
	for (let i = 0; i < a.data.length; i += 4) {
		const d = Math.max(
			Math.abs(a.data[i] - b.data[i]),
			Math.abs(a.data[i + 1] - b.data[i + 1]),
			Math.abs(a.data[i + 2] - b.data[i + 2]),
		);
		if (d > maxd) maxd = d;
		if (d > tol) {
			diff++;
			od.data[i] = 255;
			od.data[i + 1] = od.data[i + 2] = 0;
		} else
			od.data[i] =
				od.data[i + 1] =
				od.data[i + 2] =
					(a.data[i] + a.data[i + 1] + a.data[i + 2]) / 12;
		od.data[i + 3] = 255;
	}
	const total = a.w * a.h;
	const status = !diff
		? "same"
		: diff <= (total * noisePct) / 100
			? "noise"
			: "diff";
	const row = {
		file: name,
		status,
		diffPx: diff,
		total,
		maxChannelDelta: maxd,
	};
	if (status === "diff") {
		og.putImageData(od, 0, 0);
		mkdirSync(DIFF_DIR, { recursive: true });
		row.diffImage = join(DIFF_DIR, name.replace(/\.(png|jpg)$/, ".diff.png"));
		writeFileSync(row.diffImage, await out.encode("png"));
	}
	return row;
}

// ---- capture ------------------------------------------------------------------------------
/** Runs every view for one photo; `sink(name, buffer)` stores (capture) or compares (check). */
async function runPhoto(id, sink) {
	const browser = await chromium.launch({
		headless: true,
		args: [
			"--use-angle=swiftshader",
			"--enable-unsafe-swiftshader",
			"--ignore-gpu-blocklist",
			"--font-render-hinting=none",
		],
	});
	const plog = (...m) => log(`[${id}]`, ...m);
	let geometry = null;
	try {
		const ctx = await browser.newContext({
			viewport: { width: W, height: H },
			deviceScaleFactor: 1,
			locale: "en-US",
			timezoneId: "Europe/Zurich",
		});
		const pose = fixedPose(id);
		await ctx.addInitScript(
			([key, val]) => {
				try {
					localStorage.setItem(key, val);
				} catch {}
			},
			[`mt-image:pose:${id}`, JSON.stringify(pose)],
		);
		// no HMR: other sessions edit this shared tree, and a hot update mid-run would re-render or
		// remount the workspace. The HMR socket is answered by a silent mock instead of vite.
		await ctx.routeWebSocket(
			(u) => u.origin === new URL(BASE_URL).origin.replace(/^http/, "ws"),
			() => {},
		);
		const page = await ctx.newPage();
		// in-flight requests, by start time. Long-lived dev requests (the devtools SSE pipe, module
		// worker scripts) never "finish", so they are ignored. A request older than 30 s is logged once
		// and then no longer blocks.
		const pending = new Map();
		const ignored = (u) =>
			/\/__tsd\/|worker_file|\/@vite\/|__vite_ping/.test(u);
		page.on("request", (r) => !ignored(r.url()) && pending.set(r, Date.now()));
		page.on("requestfinished", (r) => pending.delete(r));
		page.on("requestfailed", (r) => {
			pending.delete(r);
			const e = r.failure()?.errorText ?? "";
			if (!e.includes("ERR_ABORTED")) plog(`[requestfailed] ${r.url()} ${e}`);
		});
		page.on("pageerror", (e) => plog(`[pageerror] ${e.message}`));
		const busy = () => {
			let n = 0;
			for (const [r, t] of pending) {
				if (Date.now() - t < 30000) n++;
				else if (!r._sbStale) {
					r._sbStale = true;
					plog(`WARN request stuck >30 s, ignoring: ${r.url().slice(0, 120)}`);
				}
			}
			return n;
		};

		plog(
			`goto (yaw ${pose.yaw.toFixed(2)} pitch ${pose.pitch.toFixed(2)} roll ${pose.roll.toFixed(2)} vfov ${pose.vfov.toFixed(2)})`,
		);
		// renderer pinned to the WebGL deck (SwiftShader has no WebGPU, and the baseline must not follow the
		// app default); ?renderer=deck is the only flag on the URL (no style/concord). Reads the private
		// geometry source (e.geoSrc) for the geometry hash.
		await page.goto(`${BASE_URL}/photo/${id}?renderer=deck`, {
			waitUntil: "load",
			timeout: 120000,
		});
		await page.waitForSelector("[data-ready]", {
			state: "attached",
			timeout: 300000,
		});
		if (!(await page.evaluate(() => !!window.__engine)))
			throw new Error(
				"window.__engine missing: run against the vite dev server",
			);
		const kind = await page.evaluate(() =>
			window.__engine.backend === "webgpu"
				? "webgpu"
				: (window.__engine.kind ?? "unknown"),
		);
		if (kind !== "deck")
			throw new Error(
				`renderer=deck was asked for but __engine.kind is ${kind}`,
			);
		plog("ready");

		const waitStable = async (label) => {
			const deadline = Date.now() + 180000;
			let last = "";
			let same = 0;
			while (Date.now() < deadline) {
				await page.waitForTimeout(800);
				if (busy() > 0) {
					same = 0;
					continue;
				}
				// deck draws without preserveDrawingBuffer, so the canvas cannot be read back between frames:
				// hash a screenshot of the stage (canvas + the DOM label layer above it) instead
				const box = await page.locator("canvas").first().boundingBox();
				if (!box) {
					last = "nocanvas";
					same = 0;
					continue;
				}
				const shot = await page.screenshot({
					clip: box,
					animations: "disabled",
					caret: "hide",
				});
				const flying = await page.evaluate(() =>
					window.__engine?.isFlying ? 1 : 0,
				);
				const h = `${Math.round(box.width)}x${Math.round(box.height)}:${createHash("sha1").update(shot).digest("hex")}:${flying}`;
				if (h === last) {
					if (++same >= 3) return;
				} else {
					same = 0;
					last = h;
				}
			}
			plog(`WARN ${label}: not stable after 180 s`);
		};
		const click = (name) =>
			page
				.getByRole("button", { name, exact: true })
				.first()
				.click({ timeout: 20000 });

		// geometry pass for the fixed pose: sha1 of the CPU copy, taken before any mode switch
		await click("Overlay");
		await click("Contours");
		await waitStable("geometry");
		const g = await page.evaluate(async () => {
			const e = window.__engine;
			await e.readback();
			// deck's query GeometrySource (private): range (m, row 0 = top, Infinity = sky) + xyz (NaN = sky)
			const src = e.geoSrc;
			if (!src?.range) throw new Error("no deck geometry source (e.geoSrc)");
			const xyz = src.xyz ?? new Float32Array(0);
			const all = new Float32Array(src.range.length + xyz.length);
			all.set(src.range);
			all.set(xyz, src.range.length);
			const d = await crypto.subtle.digest("SHA-1", new Uint8Array(all.buffer));
			// the range (sky = 0), for the pixel count of a mismatch
			const r = new Float32Array(src.range.length);
			for (let i = 0; i < r.length; i++)
				r[i] = Number.isFinite(src.range[i]) ? src.range[i] : 0;
			const u = new Uint8Array(r.buffer);
			let b = "";
			for (let i = 0; i < u.length; i += 0x8000)
				b += String.fromCharCode(...u.subarray(i, i + 0x8000));
			return {
				hash: `${src.width}x${src.height}:${[...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("")}`,
				range: btoa(b),
			};
		});
		geometry = { hash: g.hash, range: Buffer.from(g.range, "base64") };

		// export (the "Save image" path at full photo resolution, labels on): overlay contours
		if (withExport) {
			const b64 = await page.evaluate(async () => {
				const blob = await window.__engine.exportImage(true);
				if (!blob) return null;
				const buf = new Uint8Array(await blob.arrayBuffer());
				let s = "";
				for (let i = 0; i < buf.length; i += 0x8000)
					s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
				return btoa(s);
			});
			if (b64)
				await sink(
					`${id}__export-overlay-contours.jpg`,
					Buffer.from(b64, "base64"),
				);
			else plog("WARN export returned null");
		}

		for (const v of views) {
			await click(v.mode);
			for (const p of v.pick) await click(p);
			await page.evaluate((s) => window.__engine.setSettings(s), {
				...RESET_ENGINE,
				...(v.engine ?? {}),
			});
			// keep the mouse off the stage (the lens follows the pointer; hover shows a tooltip)
			await page.mouse.move(W - 2, H - 2);
			await waitStable(v.id);
			const box = await page.locator("canvas").first().boundingBox();
			// the canvas box also covers the DOM label layer, which is drawn above it with the same bounds
			const buf = await page.screenshot({
				clip: box,
				animations: "disabled",
				caret: "hide",
			});
			await sink(`${id}__${v.id}.png`, buf);
		}
	} finally {
		await browser.close();
	}
	return geometry;
}

// ---- geometry reference ---------------------------------------------------------------------
const geoRangeFile = (id) => join(BASE_DIR, `${id}__geometry-range.f32.gz`);
const f32 = (b) =>
	new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
/** Differing geometry pixels (range, bitwise) against the stored reference, and the max |Δrange| (m; sky = 0). */
function geoDiff(id, range) {
	if (!existsSync(geoRangeFile(id))) return { diffPx: null, maxAbs: null };
	const a = f32(gunzipSync(readFileSync(geoRangeFile(id))));
	const b = f32(range);
	if (a.length !== b.length)
		return { diffPx: `size ${a.length} vs ${b.length}`, maxAbs: null };
	let n = 0;
	let max = 0;
	for (let i = 0; i < a.length; i++)
		if (!Object.is(a[i], b[i])) {
			n++;
			const d = Math.abs((a[i] || 0) - (b[i] || 0));
			if (d > max) max = d;
		}
	return { diffPx: n, maxAbs: max };
}

// ---- main ---------------------------------------------------------------------------------
if (cmd === "capture") {
	if (existsSync(BASE_DIR) && readdirSync(BASE_DIR).length && !opt.force) {
		console.error(
			`${BASE_DIR} already has a baseline; pass --force to replace it (only before chunk 2, or deliberately)`,
		);
		process.exit(1);
	}
	rmSync(BASE_DIR, { recursive: true, force: true });
	rmSync(DIFF_DIR, { recursive: true, force: true });
	mkdirSync(BASE_DIR, { recursive: true });
	const geometry = {};
	const failures = [];
	for (const id of photos) {
		try {
			const g = await runPhoto(id, async (name, buf) => {
				writeFileSync(join(BASE_DIR, name), buf);
				log(`[${id}] saved ${name}`);
			});
			geometry[id] = g.hash;
			writeFileSync(geoRangeFile(id), gzipSync(g.range));
		} catch (e) {
			failures.push(id);
			log(`[${id}] ERROR ${e.message.split("\n")[0]}`);
		}
	}
	writeFileSync(
		META,
		`${JSON.stringify({ capturedAt: new Date().toISOString(), renderer: "deck", url: BASE_URL, viewport: [W, H], photos, views: views.map((v) => v.id), export: withExport, poses: Object.fromEntries(photos.map((p) => [p, fixedPose(p)])), geometry }, null, 2)}\n`,
	);
	log(
		`baseline in ${BASE_DIR}${failures.length ? `; FAILED: ${failures.join(",")}` : ""}`,
	);
	if (srcWarning()) log(srcWarning());
	process.exit(failures.length ? 2 : 0);
}

// check
if (!existsSync(META)) {
	console.error(
		`no baseline at ${OUT}; capture the deck reference first (the three.js-era one does not apply):\n  node scripts/gpu/with-render-lock.mjs -- node scripts/style-baseline.mjs capture`,
	);
	process.exit(1);
}
const meta = JSON.parse(readFileSync(META, "utf8"));
if (meta.renderer !== "deck") {
	console.error(
		`${META} was captured on ${meta.renderer ?? "three.js"}, not the deck engine this harness now runs; recapture it on deck first:\n  node scripts/gpu/with-render-lock.mjs -- node scripts/style-baseline.mjs capture --out ${OUT}${OUT.endsWith("style-baseline") ? " --force" : ""}`,
	);
	process.exit(1);
}
rmSync(DIFF_DIR, { recursive: true, force: true });
const rows = [];
const geo = [];
let errors = 0;
for (const id of photos) {
	try {
		const g = await runPhoto(id, async (name, buf) => {
			const r = await compare(name, buf);
			rows.push(r);
			log(
				`[${id}] ${name}: ${r.status}${r.diffPx ? ` ${r.diffPx} px, max Δ ${r.maxChannelDelta}` : ""}`,
			);
		});
		const want = meta.geometry?.[id];
		geo.push({
			photo: id,
			status: !want ? "no-baseline" : g.hash === want ? "same" : "diff",
			hash: g.hash,
			baseline: want,
			...geoDiff(id, g.range),
			range: g.range,
		});
	} catch (e) {
		errors++;
		log(`[${id}] ERROR ${e.message.split("\n")[0]}`);
	}
}
writeFileSync(
	join(OUT, "report.json"),
	`${JSON.stringify({ at: new Date().toISOString(), tol, noisePct, geometry: geo.map(({ range: _r, ...g }) => g), rows }, null, 2)}\n`,
);
console.log("");
const pad = Math.max(10, ...rows.map((r) => r.file.length));
for (const r of rows) {
	const extra = r.diffPx
		? `${r.diffPx} px (${((100 * r.diffPx) / r.total).toFixed(4)}%), max Δ ${r.maxChannelDelta}`
		: r.status === "size"
			? `${r.base} vs ${r.cur}`
			: "";
	console.log(`  ${r.file.padEnd(pad)}  ${r.status.padEnd(11)} ${extra}`);
}
for (const g of geo)
	console.log(
		`  geometry ${g.photo.padEnd(pad - 9)}  ${g.status.padEnd(11)} ${g.hash}  ${g.diffPx == null ? "(no stored range map: pixel count n/a)" : `${g.diffPx} px differ, max |Δrange| ${g.maxAbs?.toFixed(3)} m`}`,
	);
const badRows = rows.filter(
	(r) => r.status !== "same" && r.status !== "noise",
).length;
const noisy = rows.filter((r) => r.status === "noise").length;
const badGeo = geo.filter((g) => g.status !== "same").length;
console.log(
	`\n${rows.length - badRows}/${rows.length} pass (${rows.length - badRows - noisy} exact, ${noisy} within ${noisePct}% noise; tol ${tol}); geometry: ${badGeo ? `${badGeo} DIFFERENT` : "identical"}${errors ? `; ${errors} photo(s) errored` : ""}`,
);
if (badRows) console.log(`diff images: ${DIFF_DIR}`);
if (opt["record-geometry"]) {
	if (badRows || errors || geo.length !== photos.length)
		console.log(
			"record-geometry: NOT recorded (image rows must all pass and every photo must run)",
		);
	else {
		meta.geometry ??= {};
		for (const g of geo) {
			meta.geometry[g.photo] = g.hash;
			writeFileSync(geoRangeFile(g.photo), gzipSync(g.range));
		}
		meta.geometryRecordedAt = new Date().toISOString();
		writeFileSync(META, `${JSON.stringify(meta, null, 2)}\n`);
		console.log(
			`record-geometry: geometry reference replaced for ${geo.map((g) => g.photo).join(", ")}`,
		);
	}
}
if (srcWarning()) console.log(srcWarning());
console.log(
	"next: node scripts/eval-app.mjs  (app accuracy eval against :3100, required after each chunk)",
);
process.exit(
	errors ? 2 : badRows || (badGeo && !opt["record-geometry"]) ? 3 : 0,
);
