#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createHash } from "node:crypto";
// Roll drape atlas identity check (/roll map, deck on WebGL2): per roll, wait for every range map,
// then hash (SHA-256)
//   - the range atlas (r32float, read back whole + per photo cell): what the drape samples
//   - the coarse cull grids (DrapeAtlas.coarse, per photo)
//   - the map canvas (the overview the map opens on, once two shots in a row agree)
// and write JSON. Run it against the unpatched and the patched tree and diff the outputs.
// --rerange gpu|cpu|fallback (patched tree only) then redoes every range map on that path
// (fallback = gpuRange on but the GPU helper unusable: the in-path CPU fallback)
// (RollMapOptions.gpuRange; the private field is flipped at runtime) and hashes again;
// --repeat n does it n times and reports the per-path range stats (debugDrape().ranges).
// Usage (under the render lock; timing runs with RENDER_LOCK_EXCLUSIVE=1):
//   node scripts/gpu/with-render-lock.mjs -- node scripts/roll/atlas-identity.mjs \
//     --url http://localhost:3151 --out out.json [--rolls region-0,region-1] \
//     [--rerange gpu,cpu] [--repeat 1] [--shots out/roll-atlas]
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", "http://localhost:3151");
const OUT = arg("out", "atlas-identity.json");
const ROLLS = arg("rolls", "region-0,region-1").split(",");
const RERANGE = (arg("rerange", "") || "").split(",").filter(Boolean);
const REPEAT = Number(arg("repeat", "1"));
const SHOTS = arg("shots", "");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});

/** In the page: wait until no range map is queued or in flight and the drape count is stable. */
const settle = () =>
	new Promise((res, rej) => {
		const r = window.__roll;
		const t0 = performance.now();
		let last = "";
		let since = performance.now();
		const tick = () => {
			const d = r.debugDrape?.();
			const key = JSON.stringify([
				d?.draped,
				r.rangeWorkers,
				r.rangeQueue?.length,
				r.rangesStarted,
			]);
			if (key !== last) {
				last = key;
				since = performance.now();
			}
			const idle =
				d && r.rangesStarted && r.rangeWorkers === 0 && !r.rangeQueue.length;
			if (idle && performance.now() - since > 3000) return res(d);
			if (performance.now() - t0 > 300_000) return rej(new Error(key));
			setTimeout(tick, 250);
		};
		tick();
	});

/** In the page: hashes of the range atlas (whole, per cell) and the coarse grids. */
const atlasHashes = async () => {
	const r = window.__roll;
	const a = r.atlas;
	const gl = r.deck.device.gl;
	const hex = async (buf) =>
		[...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	const { width: W, height: H } = a.range;
	const fb = gl.createFramebuffer();
	const prevR = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
	gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
	gl.framebufferTexture2D(
		gl.READ_FRAMEBUFFER,
		gl.COLOR_ATTACHMENT0,
		gl.TEXTURE_2D,
		a.range.handle,
		0,
	);
	const rgba = new Float32Array(W * H * 4);
	gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, rgba);
	gl.framebufferTexture2D(
		gl.READ_FRAMEBUFFER,
		gl.COLOR_ATTACHMENT0,
		gl.TEXTURE_2D,
		null,
		0,
	);
	gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevR);
	gl.deleteFramebuffer(fb);
	// readPixels row 0 = texture row 0 (= writeData's y): the same layout setRange wrote
	const all = new Float32Array(W * H);
	for (let i = 0; i < all.length; i++) all[i] = rgba[i * 4];
	const cells = [];
	const coarse = [];
	let nonFinite = 0;
	let sky = 0;
	for (const [k, c] of a.cells.entries()) {
		const [x, y, w, h] = c.range;
		const cell = new Float32Array(w * h);
		for (let j = 0; j < h; j++)
			cell.set(all.subarray((y + j) * W + x, (y + j) * W + x + w), j * w);
		for (const v of cell) {
			if (!Number.isFinite(v)) nonFinite++;
			else if (v === 0) sky++;
		}
		cells.push(`${a.ids[k]}:${await hex(cell.buffer)}`);
		const g = a.coarse[k];
		coarse.push(
			g
				? `${a.ids[k]}:${g.width}x${g.height}:${await hex(g.data.slice().buffer)}`
				: `${a.ids[k]}:none`,
		);
	}
	return {
		size: [W, H],
		atlas: await hex(all.buffer),
		cells,
		coarse,
		ready: a.ready.filter(Boolean).length,
		sky,
		nonFinite,
	};
};

async function canvasShot(page, tag) {
	const el = await page.$("canvas");
	let prev = "";
	for (let k = 0; k < 20; k++) {
		const png = await el.screenshot();
		const h = createHash("sha256").update(png).digest("hex");
		if (h === prev) {
			if (SHOTS) writeFileSync(`${SHOTS}/${tag}.png`, png);
			return h;
		}
		prev = h;
		await page.waitForTimeout(1500);
	}
	return `unstable:${prev}`;
}

async function run(id) {
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const logs = [];
	page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
	page.on("console", (m) => {
		const t = m.text();
		if (
			m.type() === "error" ||
			/GL_INVALID|WebGL: |feedback|range-gpu/i.test(t)
		)
			logs.push(`${m.type()}: ${t.slice(0, 300)}`);
	});
	await page.addInitScript(() => localStorage.clear());
	const t0 = Date.now();
	await page.goto(`${BASE}/roll/${id}?view=map`);
	await page.waitForFunction(() => window.__roll, null, { timeout: 120_000 });
	const drape = await page.evaluate(settle);
	const loadMs = Date.now() - t0;
	await page.mouse.move(1, 1);
	const out = {
		id,
		loadMs,
		drape,
		init: await page.evaluate(atlasHashes),
		shot: await canvasShot(page, `${id}-init`),
	};
	console.log(JSON.stringify({ id, loadMs, init: out.init.atlas }));
	out.rerange = [];
	for (let rep = 0; rep < REPEAT; rep++)
		for (const path of RERANGE) {
			const t = await page.evaluate(async (path) => {
				const gpu = path !== "cpu";
				const r = window.__roll;
				if (!("gpuRange" in r)) throw new Error("no gpuRange option here");
				r.gpuRange = gpu;
				if (r.rangeGpu) r.rangeGpu.broken = path === "fallback";
				const todo = r.placed.filter((p) => r.slot.has(p.id));
				const t0 = performance.now();
				await r.enqueueRanges(todo);
				return { photos: todo.length, batchMs: performance.now() - t0 };
			}, path);
			await page.evaluate(settle);
			const h = await page.evaluate(atlasHashes);
			const row = { path, rep, ...t, ...h };
			if (rep === 0) row.shot = await canvasShot(page, `${id}-${path}`);
			out.rerange.push(row);
			console.log(
				JSON.stringify({
					id,
					path,
					rep,
					batchMs: t.batchMs,
					same: h.atlas === out.init.atlas,
				}),
			);
		}
	out.ranges = (await page.evaluate(() => window.__roll.debugDrape()))?.ranges;
	out.readFormat = await page.evaluate(() => {
		const gl = window.__roll.deck.device.gl;
		return {
			renderer: gl.getParameter(gl.RENDERER),
		};
	});
	out.logs = logs;
	await page.close();
	return out;
}

const rows = [];
for (const id of ROLLS) {
	try {
		rows.push(await run(id));
	} catch (err) {
		rows.push({ id, error: String(err).slice(0, 500) });
		console.log(JSON.stringify(rows.at(-1)));
	}
}
await browser.close();
writeFileSync(OUT, JSON.stringify(rows, null, 1));
