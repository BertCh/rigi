#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Drape identity check (deck renderer, WebGL2): per photo, settle the app's final pose, then hash
//   - geometry: the query geometry buffer (geoSrc.range, row 0 = top, Infinity = sky)
//   - drapeRange: what the world drape samples (the CPU range map's data, or the GPU drape texture
//     read back and normalised to the same layout: row 0 = top, 0 = sky)
//   - world exports (exportImage in world mode): the orbit entry view per world style, and the view
//     from the photographer's eye after flyToPhoto
// and writes JSON. Run it against the unpatched and the patched tree and diff the outputs.
// --cpu-drape forces the patched engine's CPU fallback (DeckEngineOptions.gpuDrape false).
// Usage (under the render lock):
//   node scripts/gpu/drape-identity.mjs --url http://localhost:3121 --out out.json \
//     [--photos IMG_6958,...] [--cpu-drape]
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", "http://localhost:3121");
const OUT = arg("out", "drape-identity.json");
const IDS = arg("photos", "IMG_6958,IMG_7018,IMG_7063,IMG_7086,IMG_7155").split(
	",",
);

const browser = await chromium.launch({
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const CPU_DRAPE = process.argv.includes("--cpu-drape");
const rows = [];
for (const id of IDS) {
	try {
		rows.push(await run(id));
	} catch (err) {
		rows.push({ id, error: String(err).slice(0, 500) });
		console.log(JSON.stringify(rows.at(-1)));
	}
}
await browser.close();
writeFileSync(OUT, JSON.stringify(rows, null, 1));

async function run(id) {
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const logs = [];
	page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
	page.on("console", (m) => {
		const t = m.text();
		if (m.type() === "error" || /GL_INVALID|WebGL: |feedback/i.test(t))
			logs.push(`${m.type()}: ${t.slice(0, 300)}`);
	});
	await page.addInitScript(() => localStorage.clear());
	await page.goto(`${BASE}/photo/${id}?renderer=deck`);
	await page.waitForSelector("[data-ready]", {
		state: "attached",
		timeout: 240_000,
	});
	await page.waitForFunction(
		() =>
			document.querySelector("[data-ready]")?.getAttribute("data-verify") !==
			"pending",
		null,
		{ timeout: 240_000 },
	);
	const r = await page.evaluate(async (cpuDrape) => {
		const e = window.__engine;
		if (cpuDrape) {
			if (!("gpuDrape" in e)) throw new Error("no gpuDrape option here");
			e.gpuDrape = false;
		}
		const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
		const hex = async (buf) =>
			[...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
		const r6 = (v) => Math.round(v * 1e6) / 1e6;
		const pose = {
			yaw: r6(e.pose.yaw),
			pitch: r6(e.pose.pitch),
			roll: r6(e.pose.roll),
			vfov: r6(e.pose.vfov),
		};
		e.setPose(pose);
		const settle = async () => {
			for (let i = 0; i < 150; i++) {
				await sleep(200);
				const s = e.renderSet?.stats;
				if (i > 5 && s && s.pending === 0) break;
			}
			await e.readback();
			await sleep(500);
			await e.readback();
		};
		await settle();
		const src = e.geoSrc;
		// the streamed terrain (ids, mesh resolution, source zoom): a different stream = different pixels
		const terrainKey = () =>
			hex(
				new TextEncoder().encode(
					(e.renderSet?.tiles ?? [])
						.map((t) => `${t.id}:${t.size}:${t.seg}:${t.sourceZ}`)
						.sort()
						.join(","),
				),
			);
		const out = {
			terrain: await terrainKey(),
			pose,
			srcKind: e.geoSrcKind,
			size: [src.width, src.height],
			geometry: await hex(src.range.slice().buffer),
		};
		// what the drape samples, normalised to rangeMapFrom's layout (row 0 = top, 0 = sky)
		const drapeHash = async () => {
			const m = e.drape?.map;
			if (!m) return { kind: "none" };
			if (m.data)
				return { kind: "cpu", hash: await hex(m.data.slice().buffer) };
			const gl = e.deck.device.gl;
			const { width: w, height: h } = m;
			const fb = gl.createFramebuffer();
			const prevR = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
			gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
			gl.framebufferTexture2D(
				gl.READ_FRAMEBUFFER,
				gl.COLOR_ATTACHMENT0,
				gl.TEXTURE_2D,
				m.texture.handle,
				0,
			);
			const rgba = new Float32Array(w * h * 4);
			gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
			gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevR);
			gl.deleteFramebuffer(fb);
			// texture row 0 is the top row (the GPU path's copy is flipped to rangeMapFrom's order)
			const data = new Float32Array(w * h);
			for (let i = 0; i < w * h; i++) {
				const v = rgba[i * 4];
				data[i] = v > 0 && Number.isFinite(v) ? v : 0;
			}
			return { kind: "gpu", hash: await hex(data.buffer) };
		};
		const exportHash = async () => {
			let prev = "";
			for (let k = 0; k < 20; k++) {
				const b = await e.exportImage(false);
				const h = await hex(await b.arrayBuffer());
				if (h === prev) return h;
				prev = h;
				await sleep(1000);
			}
			return `unstable:${prev}`;
		};
		out.world = {};
		for (const ws of ["hillshade", "satellite"]) {
			e.setSettings({ mode: "photo" });
			await sleep(300);
			e.setSettings({ mode: "world", worldStyle: ws });
			await settle();
			await sleep(1500);
			out.world[ws] = await exportHash();
			out.world[`${ws}Terrain`] = await terrainKey();
			out.world[`${ws}Imagery`] = e.imagery.map.size;
		}
		out.drapeRange = await drapeHash();
		e.flyToPhoto(50);
		for (let i = 0; i < 50 && e.isFlying; i++) await sleep(100);
		await sleep(1500);
		out.world.eye = await exportHash();
		out.drapeGen = e.drape?.gen;
		out.geoBufGen = e.geoBufGen;
		out.geometryAfter = await hex(e.geoSrc.range.slice().buffer);
		return out;
	}, CPU_DRAPE);
	console.log(JSON.stringify({ id, ...r, logs: logs.length }));
	await page.close();
	return { id, ...r, logs };
}
