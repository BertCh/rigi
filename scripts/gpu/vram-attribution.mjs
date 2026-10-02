#!/usr/bin/env node

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
// Who owns the photo view's GPU memory (WAG W1.6). Dev-only instrument, nothing ships: an init
// script wraps the native GPUDevice.createTexture / createBuffer / createQuerySet and the matching
// destroy() calls, so every live WebGPU allocation is known with its label, descriptor, analytic
// byte size and the first app (/src/) frames of its creation stack. Totals are cross-checked
// against luma's statsManager ("GPU Time and Memory", the instrument of vram-probe.mjs).
// Allocations that are garbage collected without destroy() are dropped via a FinalizationRegistry.
// Always under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/vram-attribution.mjs
//     [--url http://localhost:3100] [--out out/vram/attribution.json] [--query ""] [--wait 2000]
//     [IMG_7086]
import { APP_URL } from "../lib/harness.mjs";
import { launch, makeArg, openPhoto } from "./probe-common.mjs";

const arg = makeArg();
const BASE = arg("url", APP_URL);
const OUT = arg("out", "out/vram/attribution.json");
const QUERY = arg("query", "");
const WAIT_MS = Number(arg("wait", "2000"));
const given = process.argv.filter(
	(a, i) => a.startsWith("IMG_") && !process.argv[i - 1]?.startsWith("--"),
);
const ids = given.length ? given : ["IMG_7086"];

// Runs in the page before any app code.
function installTracker() {
	const BPP = {
		r8unorm: 1,
		r8uint: 1,
		r8snorm: 1,
		r8sint: 1,
		rg8unorm: 2,
		r16float: 2,
		r16uint: 2,
		r16sint: 2,
		rgba8unorm: 4,
		"rgba8unorm-srgb": 4,
		bgra8unorm: 4,
		"bgra8unorm-srgb": 4,
		rgba8uint: 4,
		rgba8snorm: 4,
		rg16float: 4,
		r32float: 4,
		r32uint: 4,
		r32sint: 4,
		rgb10a2unorm: 4,
		rg11b10ufloat: 4,
		depth32float: 4,
		depth24plus: 4,
		"depth24plus-stencil8": 4,
		"depth32float-stencil8": 8,
		depth16unorm: 2,
		stencil8: 1,
		rgba16float: 8,
		rgba16uint: 8,
		rg32float: 8,
		rg32uint: 8,
		rgba32float: 16,
		rgba32uint: 16,
		rgba32sint: 16,
	};
	const live = new Map();
	let nextId = 1;
	const devices = new WeakMap();
	let nextDevice = 1;
	const registry = new FinalizationRegistry((id) => {
		const r = live.get(id);
		if (r) r.gc = true;
		live.delete(id);
	});
	const stackOf = () =>
		(new Error().stack ?? "")
			.split("\n")
			.slice(2)
			.map((l) => l.trim())
			.filter((l) => l.includes("/src/") || l.includes("/@fs/"))
			.slice(0, 6)
			.map((l) =>
				l
					.replace(/^at /, "")
					.replace(/https?:\/\/[^/]+\//, "")
					.replace(/\?[^:)]*/, ""),
			);
	const deviceId = (d) => {
		let id = devices.get(d);
		if (!id) {
			id = nextDevice++;
			devices.set(d, id);
		}
		return id;
	};
	const dims = (size) => {
		if (Array.isArray(size) || size?.[Symbol.iterator])
			return [...size].concat([1, 1, 1]).slice(0, 3);
		return [size.width, size.height ?? 1, size.depthOrArrayLayers ?? 1];
	};
	const texBytes = (desc) => {
		const [w, h, l] = dims(desc.size);
		const bpp = BPP[desc.format] ?? 4;
		const mips = desc.mipLevelCount ?? 1;
		const samples = desc.sampleCount ?? 1;
		let total = 0;
		for (let m = 0; m < mips; m++)
			total +=
				Math.max(1, w >> m) *
				Math.max(1, h >> m) *
				(desc.dimension === "3d" ? Math.max(1, l >> m) : l) *
				bpp;
		return { bytes: total * samples, w, h, l, bppKnown: desc.format in BPP };
	};
	const track = (obj, rec) => {
		const id = nextId++;
		rec.id = id;
		rec.t = performance.now();
		live.set(id, rec);
		obj.__rigiVramId = id;
		registry.register(obj, id);
	};
	const P = GPUDevice.prototype;
	const createTexture = P.createTexture;
	P.createTexture = function (desc) {
		const tex = createTexture.call(this, desc);
		const b = texBytes(desc);
		track(tex, {
			kind: "texture",
			device: deviceId(this),
			label: desc.label ?? "",
			format: desc.format,
			usage: desc.usage,
			mips: desc.mipLevelCount ?? 1,
			samples: desc.sampleCount ?? 1,
			dimension: desc.dimension ?? "2d",
			...b,
			stack: stackOf(),
		});
		return tex;
	};
	const createBuffer = P.createBuffer;
	P.createBuffer = function (desc) {
		const buf = createBuffer.call(this, desc);
		track(buf, {
			kind: "buffer",
			device: deviceId(this),
			label: desc.label ?? "",
			usage: desc.usage,
			bytes: desc.size,
			stack: stackOf(),
		});
		return buf;
	};
	const createQuerySet = P.createQuerySet;
	P.createQuerySet = function (desc) {
		const q = createQuerySet.call(this, desc);
		track(q, {
			kind: "queryset",
			device: deviceId(this),
			label: desc.label ?? "",
			bytes: desc.count * 8,
			stack: stackOf(),
		});
		return q;
	};
	for (const C of [GPUTexture, GPUBuffer, GPUQuerySet]) {
		const destroy = C.prototype.destroy;
		C.prototype.destroy = function () {
			if (this.__rigiVramId) live.delete(this.__rigiVramId);
			return destroy.call(this);
		};
	}
	const destroyDevice = GPUDevice.prototype.destroy;
	GPUDevice.prototype.destroy = function () {
		const id = devices.get(this);
		for (const [k, r] of live) if (r.device === id) live.delete(k);
		return destroyDevice.call(this);
	};
	const configure = GPUCanvasContext.prototype.configure;
	window.__rigiCanvasConfigs = [];
	GPUCanvasContext.prototype.configure = function (c) {
		window.__rigiCanvasConfigs.push({
			format: c.format,
			w: this.canvas.width,
			h: this.canvas.height,
			usage: c.usage,
		});
		return configure.call(this, c);
	};
	window.__rigiVram = () => [...live.values()];
}

const SNAPSHOT = async () => {
	const m = window.__engine?.metrics?.();
	const lumaMem = m?.luma?.memory;
	const v = (k) => {
		const x = lumaMem?.[k];
		return typeof x === "object" && x ? (x.count ?? x.value ?? null) : x;
	};
	let graphs = null;
	try {
		const { inspectGraphs } = await import("/src/lib/gpu/core/inspect.ts");
		graphs = inspectGraphs({ observe: false }).map((g) => ({
			id: g.id,
			group: g.group,
			cached: g.cached,
			compiled: g.compiled,
			transient: g.transient,
			importedBufferBytes: g.importedBufferBytes,
			importedTextureBytes: g.importedTextureBytes,
		}));
	} catch (e) {
		graphs = { error: String(e) };
	}
	return {
		live: window.__rigiVram?.() ?? [],
		canvasConfigs: window.__rigiCanvasConfigs,
		luma: {
			gpu: v("GPU Memory"),
			buffer: v("Buffer Memory"),
			texture: v("Texture Memory"),
			externalTexture: v("External Texture Memory"),
		},
		canvas: {
			w: window.__engine?.canvas?.width,
			h: window.__engine?.canvas?.height,
		},
		engine: document
			.querySelector("[data-renderer]")
			?.getAttribute("data-renderer"),
		graphs,
		store: (() => {
			const st = window.__engine?.gpu?.terrain?.store;
			if (!st) return null;
			const gs = {};
			let small = 0;
			let big = 0;
			for (const [mesh, slot] of st.slots) {
				const g = `G${mesh.grid?.G ?? 0}/S${mesh.size}`;
				gs[g] = (gs[g] ?? 0) + 1;
				if (slot.big) big++;
				else small++;
			}
			return {
				gridCells: gs,
				rowsCap: st.rowsCap,
				small: { used: small, capacity: st.small.capacity },
				big: { used: big, capacity: st.big.capacity },
			};
		})(),
		engineMetrics: m
			? {
					terrain: m.terrain,
					imagery: m.imagery,
					splats: m.splats,
					host: m.host,
				}
			: null,
	};
};

const MiB = (b) => +(b / 2 ** 20).toFixed(2);
function summarise(snap) {
	const groups = new Map();
	for (const r of snap.live) {
		const site =
			r.stack.find((l) => !l.includes("node_modules")) ?? r.stack[0] ?? "?";
		const key = `${r.kind} ${r.label || "(no label)"} @ ${site.replace(/:\d+\)?$/, "")}`;
		const g = groups.get(key) ?? { key, n: 0, bytes: 0, example: r };
		g.n++;
		g.bytes += r.bytes;
		groups.set(key, g);
	}
	const rows = [...groups.values()].sort((a, b) => b.bytes - a.bytes);
	const total = (k) =>
		snap.live.filter((r) => r.kind === k).reduce((s, r) => s + r.bytes, 0);
	return {
		trackedMiB: {
			texture: MiB(total("texture")),
			buffer: MiB(total("buffer")),
			queryset: MiB(total("queryset")),
		},
		lumaMiB: {
			gpu: MiB(snap.luma.gpu ?? 0),
			buffer: MiB(snap.luma.buffer ?? 0),
			texture: MiB(snap.luma.texture ?? 0),
			externalTexture: MiB(snap.luma.externalTexture ?? 0),
		},
		devices: [...new Set(snap.live.map((r) => r.device))],
		rows: rows.map((g) => ({
			MiB: MiB(g.bytes),
			n: g.n,
			key: g.key,
			fmt: g.example.format,
			size:
				g.example.kind === "texture"
					? `${g.example.w}x${g.example.h}x${g.example.l} mips${g.example.mips} s${g.example.samples}`
					: undefined,
		})),
	};
}

const browser = await launch();
const results = [];
for (const id of ids) {
	const ctx = await browser.newContext({
		viewport: { width: 1400, height: 900 },
	});
	await ctx.addInitScript(installTracker);
	const page = await ctx.newPage();
	const o = await openPhoto(page, BASE, id, "webgpu", QUERY);
	await page.waitForTimeout(WAIT_MS);
	const idle = await page.evaluate(SNAPSHOT);
	const s = summarise(idle);
	results.push({ id, ...o, summary: s, raw: idle });
	console.log(
		`${id} store=${JSON.stringify(idle.store)}\n${id} engine=${idle.engine} canvas=${idle.canvas.w}x${idle.canvas.h} tracked=${JSON.stringify(s.trackedMiB)} luma=${JSON.stringify(s.lumaMiB)} devices=${s.devices}`,
	);
	for (const r of s.rows.slice(0, 40))
		console.log(
			`${String(r.MiB).padStart(8)} MiB  x${String(r.n).padEnd(3)} ${r.fmt ?? ""} ${r.size ?? ""}  ${r.key}`,
		);
	await ctx.close();
}
await browser.close();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ url: BASE, results }, null, 1));
console.log(`wrote ${OUT}`);
