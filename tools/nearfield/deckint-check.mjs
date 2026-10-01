#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside P1b: DeckEngine.setNearField end to end on a bundled photo in ?renderer=deck.
// A synthetic NearFieldScene (camera-anchored ENU splats in front of the solved camera: a red ball
// on the terrain line, a yellow ball over the sky, a blue post, and a green ball BEHIND the terrain
// that the log depth must hide) → photo view (off / on / truth / half opacity / off again) and the
// world view (drape masked / unmasked, orbit + at the photographer). Screenshots:
// tools/nearfield/shots/deckint-*.png. Checks: off-again is byte-identical to off; the splats
// change pixels only near where they project; the hidden ball changes nothing.
// Usage: node scripts/gpu/with-render-lock.mjs -- node tools/nearfield/deckint-check.mjs
//        [--url http://localhost:3110] [--photo IMG_6958]
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", "http://localhost:3110");
const ID = arg("photo", "IMG_6958");
const SHOTS = resolve(import.meta.dirname, "shots");
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const logs = [];
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
	if (m.type() === "error" || /splat|nearfield|composite/i.test(m.text()))
		logs.push(`${m.type()}: ${m.text().slice(0, 300)}`);
});
await page.addInitScript(() => localStorage.clear());
await page.goto(`${BASE}/photo/${ID}?renderer=deck`);
await page.waitForSelector("[data-ready]", { timeout: 240_000 });
await page.evaluate(async () => {
	await window.__engine.readback();
});

const settle = async (ms = 1500) => {
	await page.waitForTimeout(ms);
	await page.evaluate(
		() =>
			new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
	);
};
const canvasBox = async () => {
	const b = await page.evaluate(() => {
		const c = [...document.querySelectorAll("canvas")].sort(
			(a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
		)[0];
		const r = c.getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	});
	return b;
};
// screenshots decoded and compared in the page (no PNG decoder in node_modules)
const shot = async (name) => {
	const clip = await canvasBox();
	const buf = await page.screenshot({
		clip,
		path: resolve(SHOTS, `deckint-${name}.png`),
	});
	await page.evaluate(
		async ([n, b64]) => {
			const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
			const bmp = await createImageBitmap(blob);
			const c = new OffscreenCanvas(bmp.width, bmp.height);
			const g = c.getContext("2d");
			g.drawImage(bmp, 0, 0);
			window.__shots ??= {};
			window.__shots[n] = g.getImageData(0, 0, bmp.width, bmp.height);
		},
		[name, buf.toString("base64")],
	);
	return name;
};
const diff = (a, b, thr = 6) =>
	page.evaluate(
		([a, b, thr]) => {
			const A = window.__shots[a];
			const B = window.__shots[b];
			let n = 0;
			let same = true;
			let x0 = 1e9,
				y0 = 1e9,
				x1 = -1,
				y1 = -1;
			for (let y = 0; y < A.height; y++)
				for (let x = 0; x < A.width; x++) {
					const i = (y * A.width + x) * 4;
					const d = Math.max(
						Math.abs(A.data[i] - B.data[i]),
						Math.abs(A.data[i + 1] - B.data[i + 1]),
						Math.abs(A.data[i + 2] - B.data[i + 2]),
					);
					if (d) same = false;
					if (d > thr) {
						n++;
						x0 = Math.min(x0, x);
						y0 = Math.min(y0, y);
						x1 = Math.max(x1, x);
						y1 = Math.max(y1, y);
					}
				}
			return {
				identical: same,
				changed: n,
				frac: n / (A.width * A.height),
				bbox: n ? [x0, y0, x1, y1] : null,
				size: [A.width, A.height],
			};
		},
		[a, b, thr],
	);

// the scene, built in the page from the live pose (window.__nfScene)
const info = await page.evaluate(async () => {
	const e = window.__engine;
	const { poseBasis } = await import("/src/lib/pose.ts");
	const { PROVENANCE_CODE } = await import("/src/lib/nearfield/types.ts");
	const { forward, right, up } = poseBasis(e.pose);
	const eye = [e.eye.x, e.eye.y, e.eye.z];
	const tanV = Math.tan((e.pose.vfov * Math.PI) / 360);
	const tanH = tanV * e.aspect;
	/** ENU direction through normalised photo coords (u right, v down). */
	const ray = (u, v) => {
		const x = (2 * u - 1) * tanH;
		const y = (1 - 2 * v) * tanV;
		const d = [0, 1, 2].map(
			(k) =>
				forward.getComponent(k) +
				x * right.getComponent(k) +
				y * up.getComponent(k),
		);
		const n = Math.hypot(...d);
		return d.map((c) => c / n);
	};
	const zRange = (u, v) => e.sampleAt(u, v)?.range ?? null;
	// the lowest sky pixel on the centre column and the terrain just below it
	let skyV = null;
	for (let v = 0.02; v < 0.98; v += 0.01) {
		if (zRange(0.5, v) == null) skyV = v;
		else break;
	}
	const P = [],
		S = [],
		R = [],
		C = [],
		V = [];
	const ball = (center, r, n, rgb, prov, sigma = 0.35) => {
		for (let i = 0; i < n; i++) {
			// Fibonacci sphere + interior shell
			const k = i + 0.5;
			const phi = Math.acos(1 - (2 * k) / n);
			const th = Math.PI * (1 + Math.sqrt(5)) * k;
			const rr = r * (i % 3 === 0 ? 0.6 : 1);
			P.push(
				center[0] + rr * Math.sin(phi) * Math.cos(th),
				center[1] + rr * Math.sin(phi) * Math.sin(th),
				center[2] + rr * Math.cos(phi),
			);
			S.push(sigma * r, sigma * r, sigma * r);
			R.push(1, 0, 0, 0);
			C.push(...rgb, 230);
			V.push(prov);
		}
	};
	const at = (u, v, dist) => ray(u, v).map((c, k) => eye[k] + c * dist);
	const out = { skyV, eye, pose: e.pose };
	// red: in front of the far terrain (mountain base), at a fixed 150 m, radius 6 m
	const rT = zRange(0.42, 0.4);
	ball(
		at(0.42, 0.4, 150),
		6,
		3000,
		[220, 40, 40],
		PROVENANCE_CODE.observed,
		0.12,
	);
	out.red = { u: 0.42, v: 0.4, dist: 150, dem: rT };
	// yellow: over pure sky (the first sky cell whose neighbours are sky too), 60 m out, radius 3 m
	let sky = null;
	for (let v = 0.03; v < 0.25 && !sky; v += 0.02)
		for (let u = 0.05; u < 0.95 && !sky; u += 0.02)
			if (
				[0, 0.03, -0.03].every(
					(d) => zRange(u + d, v) == null && zRange(u, v + Math.abs(d)) == null,
				)
			)
				sky = [u, v];
	sky ??= [0.1, 0.05];
	ball(
		at(sky[0], sky[1], 60),
		3,
		2000,
		[250, 210, 30],
		PROVENANCE_CODE.reconstructed,
		0.12,
	);
	out.yellow = { u: sky[0], v: sky[1], sky: zRange(sky[0], sky[1]) == null };
	// orange: across the skyline above the red ball's column (half over terrain, half over sky)
	let edgeV = null;
	for (let v = 0.02; v < 0.9; v += 0.005)
		if (zRange(0.3, v) != null) {
			edgeV = v;
			break;
		}
	if (edgeV != null)
		ball(
			at(0.3, edgeV, 300),
			8,
			2000,
			[255, 120, 20],
			PROVENANCE_CODE.observed,
			0.12,
		);
	out.orange = { u: 0.3, v: edgeV };
	// blue post: a vertical column over the lake, 60% of the DEM range there, 3 m tall
	const rP = zRange(0.2, 0.6) ?? 30;
	const base = at(0.2, 0.6, rP * 0.6);
	for (let i = 0; i < 600; i++) {
		P.push(base[0], base[1], base[2] + (i / 600) * 3);
		S.push(0.08, 0.08, 0.08);
		R.push(1, 0, 0, 0);
		C.push(40, 90, 230, 255);
		V.push(PROVENANCE_CODE.generated);
	}
	out.blue = { u: 0.2, v: 0.6, dem: rP, dist: rP * 0.6 };
	// green: BEHIND the mountain at (0.75, 0.3): DEM range + 400 m, radius 3% of the range — must be invisible
	const rG = zRange(0.75, 0.3);
	if (rG != null)
		ball(
			at(0.75, 0.3, rG + 400),
			rG * 0.03,
			2000,
			[30, 230, 60],
			PROVENANCE_CODE.observed,
			0.12,
		);
	out.green = { u: 0.75, v: 0.3, dem: rG };
	const count = V.length;
	const splats = {
		count,
		frame: "enu",
		positions: Float32Array.from(P),
		scales: Float32Array.from(S),
		rotations: Float32Array.from(R),
		colors: Uint8Array.from(C),
		provenance: Uint8Array.from(V),
	};
	// split: Object where the red ball sits (for the drape mask), 64 × 48
	const sw = 64,
		sh = Math.round(64 / e.aspect);
	const cls = new Uint8Array(sw * sh).fill(1);
	for (let y = 0; y < sh; y++)
		for (let x = 0; x < sw; x++) {
			const u = (x + 0.5) / sw,
				v = (y + 0.5) / sh;
			// Object: the red ball's box and the swimmer in the middle of the lake
			if (Math.abs(u - 0.42) < 0.05 && Math.abs(v - 0.4) < 0.07)
				cls[y * sw + x] = 2;
			if (Math.abs(u - 0.505) < 0.04 && Math.abs(v - 0.625) < 0.04)
				cls[y * sw + x] = 2;
		}
	window.__nfScene = {
		photoId: "synthetic",
		anchor: {
			scale: 1,
			shift: 0,
			residualLog: 0,
			inlierFrac: 1,
			n: 1,
			quality: 1,
			maxRange: 1000,
		},
		split: { width: sw, height: sh, cls, counts: [0, 0, 0, 0, 0] },
		splats,
		confidenceRadius: 30,
	};
	out.count = count;
	out.hasSetNearField = typeof e.setNearField === "function";
	return out;
});
console.log("scene", JSON.stringify(info));

const set = (opts) =>
	page.evaluate((o) => {
		const e = window.__engine;
		if (o === null) e.setNearField(null);
		else e.setNearField(window.__nfScene, o);
	}, opts);

const res = { photo: ID, scene: info };
const timing = async () =>
	page.evaluate(() => ({
		stats: window.__rigiSplatStats ?? null,
	}));

await settle();
const off = await shot("photo-off");
await set({});
await settle(2500);
const on = await shot("photo-on");
res.photoOn = { ...(await diff(off, on)), ...(await timing()) };
await set({ truth: true });
await settle();
const truth = await shot("photo-truth");
res.photoTruth = await diff(on, truth);
await set({ opacity: 0.5 });
await settle();
await shot("photo-half");
await set(null);
await settle();
const offAgain = await shot("photo-offagain");
res.photoOffAgain = await diff(off, offAgain, 0);

await set({});
await settle(2500);
// the full-resolution export (composite.ts encodeImage) carries the splats too
const exp = await page.evaluate(async () => {
	const blob = await window.__engine.exportImage(false);
	if (!blob) return null;
	const buf = new Uint8Array(await blob.arrayBuffer());
	let s = "";
	for (let i = 0; i < buf.length; i += 0x8000)
		s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
	return btoa(s);
});
if (exp)
	writeFileSync(
		resolve(SHOTS, "deckint-export.jpg"),
		Buffer.from(exp, "base64"),
	);
res.export = exp ? "ok" : "null";
await settle();
const onAfterExport = await shot("photo-on-afterexport");
res.photoOnAfterExport = await diff(on, onAfterExport, 6);
await set(null);
// world view
await page
	.getByRole("button", { name: "In map", exact: true })
	.first()
	.click({ timeout: 20000 });
await page.mouse.move(1398, 898);
await settle(4000);
// busy overlays (terrain loading, a re-align) must be gone before the world captures
await page
	.waitForFunction(
		() => !/Aligning|Loading terrain/.test(document.body.innerText),
		null,
		{ timeout: 120_000 },
	)
	.catch(() => logs.push("warn: busy overlay still up"));
await settle(6000);
const wOff = await shot("world-off");
await set({});
await settle(2500);
const wOn = await shot("world-on");
res.worldOn = await diff(wOff, wOn);
await set({ maskDrape: false });
await settle(1500);
const wNoMask = await shot("world-nomask");
res.worldMaskVsNoMask = await diff(wOn, wNoMask);
// at the photographer: the splats sit where they do in the photo view
await page.evaluate(() => window.__engine.flyToPhoto(10));
await settle(4000);
await set({});
await settle(2000);
await shot("world-atphoto-on");
await set({ truth: true });
await settle(1500);
await shot("world-atphoto-truth");
await set(null);
await settle(1500);
await shot("world-atphoto-off");
res.logs = logs.slice(0, 30);
console.log(JSON.stringify(res, null, 1));
writeFileSync(
	resolve(SHOTS, "deckint-result.json"),
	JSON.stringify(res, null, 1),
);
await browser.close();
