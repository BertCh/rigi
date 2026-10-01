#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Landing-page (/) perf harness: loads the page with a pinned renderer, sits at the hero, wheels down
// section by section (dwelling in each), then sits at the bottom, and reports per window: rAF frame
// times (p50/p95/max, frames > 50 ms), long tasks and long animation frames (with script attribution),
// main-thread busy time (CDP Performance metrics), renderer and GPU process CPU time, JS heap, every
// requestAnimationFrame callback by its caller (calls/s and ms/s: which loops run, and whether
// offscreen components keep running), canvas contexts / WebGPU adapters and devices / workers
// created, and network requests by type (before the first scroll vs total).
//
// Instrumentation is an init script, so it sees every rAF, getContext and requestDevice from the
// first line of app code. GPU work inside workers (the panorama's ridgeline worker) is not seen by
// the context counters; workers are counted instead.
//
// navigator.webdriver is masked (false) by default so the page behaves as for a real visitor
// (StepInsideDemo loads Google 3D tiles, HowItWorksScene animates); --webdriver keeps it true.
//
// Always under the render lock, alone (timings):
//   RENDER_LOCK_EXCLUSIVE=1 node scripts/gpu/with-render-lock.mjs -- node scripts/perf/landing-perf.mjs \
//     --renderer webgpu|deck [--url http://localhost:3100] [--json out.json] [--section <id|index|eyebrow>]
//     [--dwell 3000] [--idle 5000] [--width 1400 --height 900] [--webdriver] [--quiet]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "../deck-webgpu/gpu-args.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")
		? argv[i + 1]
		: d;
};
const has = (k) => argv.includes(`--${k}`);

const BASE = arg("url", process.env.APP_URL ?? "http://localhost:3100");
const RENDERER = arg("renderer", "webgpu");
if (!["webgpu", "deck", "auto"].includes(RENDERER)) {
	console.error(`--renderer must be webgpu, deck or auto (got ${RENDERER})`);
	process.exit(2);
}
const OUT = arg("json", null);
const SECTION = arg("section", null);
const DWELL = Number(arg("dwell", "3000"));
const IDLE = Number(arg("idle", "5000"));
const WIDTH = Number(arg("width", "1400"));
const HEIGHT = Number(arg("height", "900"));
const MASK_WEBDRIVER = !has("webdriver");
const QUIET = has("quiet");
/** Wheel step (px) and interval (ms): ~1900 px/s, a brisk but human scroll. */
const WHEEL_PX = 60;
const WHEEL_MS = 32;

const t0 = Date.now();
const log = (...m) =>
	QUIET ||
	console.log(`[landing-perf ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);

// ---- in-page instrumentation (runs before any app code) ----
function instrument(maskWebdriver) {
	if (maskWebdriver)
		Object.defineProperty(Navigator.prototype, "webdriver", {
			get: () => false,
			configurable: true,
		});
	const now = () => performance.now();
	const P = {
		frames: [], // [t, dt]
		longtasks: [], // [start, duration]
		loafs: [], // {start, duration, blocking, scripts: [{src, dur}]}
		raf: new Map(), // source -> {calls, ms}
		contexts: [], // {t, type, where}
		gpu: { adapters: 0, devices: 0, destroyed: 0, events: [] },
		workers: [], // {t, url}
		windowStart: now(),
	};
	window.__perf = P;
	const origRaf = window.requestAnimationFrame.bind(window);
	P.origRaf = origRaf;

	// caller of requestAnimationFrame -> "path:line" (origin, query and column stripped)
	const callerOf = () => {
		const lines = (new Error().stack ?? "").split("\n").slice(1);
		for (const l of lines) {
			// skip this init script's own frames (it is evaluated as an anonymous script)
			if (l.includes("__rigiPerf") || l.includes("<anonymous>")) continue;
			const m = l.match(/\(?((?:https?:\/\/[^/]+)?[^()\s]*?):(\d+):\d+\)?\s*$/);
			if (!m) continue;
			let file = m[1].replace(/^https?:\/\/[^/]+/, "").replace(/\?[^:]*$/, "");
			file = file.replace(/^\/node_modules\/\.vite\/deps\//, "deps/");
			return `${file}:${m[2]}`;
		}
		return "(unknown)";
	};
	window.requestAnimationFrame = function __rigiPerfRaf(cb) {
		const src = callerOf();
		return origRaf((ts) => {
			const a = now();
			try {
				cb(ts);
			} finally {
				let r = P.raf.get(src);
				if (!r) {
					r = { calls: 0, ms: 0 };
					P.raf.set(src, r);
				}
				r.calls++;
				r.ms += now() - a;
			}
		});
	};

	// frame clock on the original rAF (not attributed)
	let last = 0;
	const tick = (ts) => {
		if (last) P.frames.push([ts, ts - last]);
		last = ts;
		origRaf(tick);
	};
	origRaf(tick);

	try {
		new PerformanceObserver((l) => {
			for (const e of l.getEntries())
				P.longtasks.push([e.startTime, e.duration]);
		}).observe({ type: "longtask", buffered: true });
	} catch {}
	try {
		new PerformanceObserver((l) => {
			for (const e of l.getEntries())
				P.loafs.push({
					start: e.startTime,
					duration: e.duration,
					blocking: e.blockingDuration ?? 0,
					scripts: (e.scripts ?? []).map((s) => ({
						src: `${(s.sourceURL || s.invoker || "?").replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "")}${s.sourceFunctionName ? ` ${s.sourceFunctionName}` : ""}`,
						dur: s.duration,
					})),
				});
		}).observe({ type: "long-animation-frame", buffered: true });
	} catch {}

	// where a canvas sits: nearest data-testid ancestor
	const where = (c) => {
		try {
			const el = c?.closest?.("[data-testid]");
			if (el) return el.getAttribute("data-testid");
			if (c?.isConnected === false) return "(detached)";
			return c instanceof HTMLCanvasElement ? "(page)" : "(offscreen)";
		} catch {
			return "?";
		}
	};
	const seen = new WeakMap();
	const wrapGetContext = (proto) => {
		if (!proto?.getContext) return;
		const orig = proto.getContext;
		proto.getContext = function __rigiPerfGetContext(type, ...rest) {
			const ctx = orig.call(this, type, ...rest);
			if (ctx && !seen.has(this)) {
				seen.set(this, type);
				P.contexts.push({
					t: now(),
					type,
					where: where(this),
					src: callerOf(),
				});
			}
			return ctx;
		};
	};
	wrapGetContext(globalThis.HTMLCanvasElement?.prototype);
	wrapGetContext(globalThis.OffscreenCanvas?.prototype);

	if (navigator.gpu) {
		const gpuProto = Object.getPrototypeOf(navigator.gpu);
		const reqA = gpuProto.requestAdapter;
		gpuProto.requestAdapter = function __rigiPerfAdapter(...a) {
			P.gpu.adapters++;
			P.gpu.events.push({ t: now(), kind: "adapter", src: callerOf() });
			return reqA.apply(this, a);
		};
		const AP = globalThis.GPUAdapter?.prototype;
		if (AP?.requestDevice) {
			const reqD = AP.requestDevice;
			AP.requestDevice = function __rigiPerfDevice(...a) {
				P.gpu.devices++;
				P.gpu.events.push({ t: now(), kind: "device", src: callerOf() });
				return reqD.apply(this, a);
			};
		}
		const DP = globalThis.GPUDevice?.prototype;
		if (DP?.destroy) {
			const des = DP.destroy;
			DP.destroy = function __rigiPerfDestroy(...a) {
				P.gpu.destroyed++;
				P.gpu.events.push({ t: now(), kind: "destroy", src: callerOf() });
				return des.apply(this, a);
			};
		}
	}

	if (globalThis.Worker) {
		const W = globalThis.Worker;
		globalThis.Worker = new Proxy(W, {
			construct(target, args) {
				P.workers.push({
					t: now(),
					url: String(args[0]).replace(/^https?:\/\/[^/]+/, ""),
				});
				return Reflect.construct(target, args);
			},
		});
	}

	// close the current window: stats since its start, then reset the rAF tally
	P.take = () => {
		const s = P.windowStart;
		const e = now();
		const frames = P.frames.filter(([t]) => t >= s && t < e).map(([, d]) => d);
		const lts = P.longtasks.filter(([t]) => t >= s && t < e);
		const loafs = P.loafs.filter((x) => x.start >= s && x.start < e);
		const raf = [...P.raf.entries()].map(([src, r]) => ({ src, ...r }));
		P.raf.clear();
		P.windowStart = e;
		const mem = performance.memory;
		return {
			start: s,
			end: e,
			frames,
			longtasks: lts,
			loafs,
			raf,
			contexts: P.contexts.filter((c) => c.t >= s && c.t < e),
			gpuEvents: P.gpu.events.filter((c) => c.t >= s && c.t < e),
			workers: P.workers.filter((c) => c.t >= s && c.t < e),
			heap: mem ? mem.usedJSHeapSize : null,
			liveCanvases: [...document.querySelectorAll("canvas")].map((c) => ({
				where: where(c),
				type: seen.get(c) ?? null,
				w: c.width,
				h: c.height,
			})),
			scrollY: window.scrollY,
		};
	};
}

// ---- stats ----
const q = (xs, p) => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

async function launch() {
	const args = [
		...(RENDERER === "deck"
			? ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"]
			: GPU_ARGS),
		"--enable-precise-memory-info",
	];
	return chromium.launch({ headless: true, args });
}

const browser = await launch();
const context = await browser.newContext({
	viewport: { width: WIDTH, height: HEIGHT },
});
await context.addInitScript(instrument, MASK_WEBDRIVER);
const page = await context.newPage();
page.on("pageerror", (e) => log("pageerror:", e.message.split("\n")[0]));

const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable", { timeDomain: "timeTicks" });
let browserCdp = null;
try {
	browserCdp = await browser.newBrowserCDPSession();
} catch {}

async function metrics() {
	const { metrics: m } = await cdp.send("Performance.getMetrics");
	return Object.fromEntries(m.map((x) => [x.name, x.value]));
}
async function procCpu() {
	if (!browserCdp) return null;
	try {
		const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
		const out = {};
		for (const p of processInfo) out[p.type] = (out[p.type] ?? 0) + p.cpuTime;
		return out;
	} catch {
		return null;
	}
}

// ---- network ----
const requests = []; // {t, phase, type, url, host, bytes, status}
let phase = "load";
const pending = new Set();
context.on("requestfinished", (req) => {
	const ph = phase;
	const t = Date.now();
	const p = (async () => {
		let bytes = 0;
		try {
			const s = await req.sizes();
			bytes = s.responseBodySize + s.responseHeadersSize;
		} catch {}
		const resp = await req.response().catch(() => null);
		const url = req.url();
		let host = "";
		try {
			host = new URL(url).host;
		} catch {}
		requests.push({
			t,
			phase: ph,
			window: currentWindow,
			type: req.resourceType(),
			url: url.replace(/^https?:\/\/[^/]+/, "").slice(0, 160),
			host,
			bytes,
			status: resp?.status() ?? 0,
		});
	})();
	pending.add(p);
	p.finally(() => pending.delete(p));
});
context.on("requestfailed", (req) => {
	requests.push({
		t: Date.now(),
		phase,
		window: currentWindow,
		type: req.resourceType(),
		url: req
			.url()
			.replace(/^https?:\/\/[^/]+/, "")
			.slice(0, 160),
		host: (() => {
			try {
				return new URL(req.url()).host;
			} catch {
				return "";
			}
		})(),
		bytes: 0,
		status: -1,
		failure: req.failure()?.errorText,
	});
});

// ---- windows ----
const windows = [];
let currentWindow = "load";
let mark = { m: null, cpu: null, wall: 0 };
async function begin(name) {
	await page.evaluate(() => window.__perf.take()); // discard whatever came before
	currentWindow = name;
	mark = { m: await metrics(), cpu: await procCpu(), wall: Date.now() };
}
async function end(extra = {}) {
	const raw = await page.evaluate(() => window.__perf.take());
	const m = await metrics();
	const cpu = await procCpu();
	const secs = Math.max(0.001, (Date.now() - mark.wall) / 1000);
	const d = (k) => (m[k] ?? 0) - (mark.m?.[k] ?? 0);
	const procDelta = {};
	if (cpu && mark.cpu)
		for (const k of Object.keys(cpu))
			procDelta[k] = r1(((cpu[k] - (mark.cpu[k] ?? 0)) / secs) * 100); // % of one core
	const scripts = new Map();
	for (const l of raw.loafs)
		for (const s of l.scripts)
			scripts.set(s.src, (scripts.get(s.src) ?? 0) + s.dur);
	const w = {
		name: currentWindow,
		seconds: r1(secs),
		scrollY: raw.scrollY,
		frames: {
			n: raw.frames.length,
			fps: r1(raw.frames.length / secs),
			p50: r1(q(raw.frames, 0.5)),
			p95: r1(q(raw.frames, 0.95)),
			max: r1(raw.frames.length ? Math.max(...raw.frames) : null),
			over50: raw.frames.filter((x) => x > 50).length,
			over33: raw.frames.filter((x) => x > 33.4).length,
		},
		longtasks: {
			n: raw.longtasks.length,
			totalMs: Math.round(raw.longtasks.reduce((s, [, x]) => s + x, 0)),
			maxMs: Math.round(Math.max(0, ...raw.longtasks.map(([, x]) => x))),
		},
		loaf: {
			n: raw.loafs.length,
			blockingMs: Math.round(raw.loafs.reduce((s, x) => s + x.blocking, 0)),
			topScripts: [...scripts.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 6)
				.map(([src, ms]) => ({ src, ms: Math.round(ms) })),
		},
		mainThread: {
			// share of wall time (%)
			busyPct: r1((d("TaskDuration") / secs) * 100),
			scriptPct: r1((d("ScriptDuration") / secs) * 100),
			layoutPct: r1((d("LayoutDuration") / secs) * 100),
			stylePct: r1((d("RecalcStyleDuration") / secs) * 100),
			layouts: d("LayoutCount"),
			styleRecalcs: d("RecalcStyleCount"),
		},
		processCpuPct: procDelta,
		heapMB: r1((raw.heap ?? m.JSHeapUsedSize ?? 0) / 2 ** 20),
		domNodes: m.Nodes,
		raf: raw.raf
			.map((r) => ({
				src: r.src,
				perSec: r1(r.calls / secs),
				msPerSec: r1(r.ms / secs),
			}))
			.sort((a, b) => b.msPerSec - a.msPerSec || b.perSec - a.perSec),
		activeLoops: raw.raf.filter((r) => r.calls / secs >= 10).length,
		contextsCreated: raw.contexts,
		gpuEvents: raw.gpuEvents,
		workersCreated: raw.workers,
		liveCanvases: raw.liveCanvases,
		...extra,
	};
	windows.push(w);
	log(
		`${w.name.padEnd(22)} fps ${w.frames.fps} p50 ${w.frames.p50} p95 ${w.frames.p95} max ${w.frames.max} >50ms ${w.frames.over50} | LT ${w.longtasks.n}/${w.longtasks.totalMs}ms | main ${w.mainThread.busyPct}% | gpu ${procDelta.GPU ?? "?"}% rend ${procDelta.renderer ?? "?"}% | loops ${w.activeLoops} | heap ${w.heapMB}MB`,
	);
	return w;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- sections ----
async function sections() {
	return page.evaluate(() => {
		const els = [...document.querySelectorAll("main > header, main > section")];
		return els.map((el, i) => {
			const eyebrow =
				el.tagName === "HEADER"
					? "hero"
					: (el.querySelector("p")?.textContent ?? el.id ?? `s${i}`).trim();
			const slug =
				el.tagName === "HEADER"
					? "hero"
					: el.id === "start"
						? "pitch"
						: eyebrow
								.toLowerCase()
								.replace(/^\d+\s*·\s*/, "")
								.replace(/[^a-z0-9]+/g, "-")
								.replace(/^-|-$/g, "");
			const r = el.getBoundingClientRect();
			return {
				index: i,
				id: el.id || null,
				eyebrow,
				slug,
				top: Math.round(r.top + window.scrollY),
				height: Math.round(r.height),
				embed:
					el.querySelector("[data-testid]")?.getAttribute("data-testid") ??
					null,
			};
		});
	});
}

/** Wheel down (mouse over the page centre, so embeds get the wheel too) until scrollY reaches y. */
async function wheelTo(y) {
	await page.mouse.move(WIDTH / 2, HEIGHT / 2);
	let stalls = 0;
	let captured = false;
	for (let guard = 0; guard < 2000; guard++) {
		const cur = await page.evaluate(() => window.scrollY);
		const maxY = await page.evaluate(
			() => document.documentElement.scrollHeight - window.innerHeight,
		);
		const target = Math.min(y, maxY);
		if (Math.abs(cur - target) < WHEEL_PX) break;
		const dy =
			Math.sign(target - cur) * Math.min(WHEEL_PX, Math.abs(target - cur));
		await page.mouse.wheel(0, dy);
		await wait(WHEEL_MS);
		const after = await page.evaluate(() => window.scrollY);
		if (after === cur) {
			stalls++;
			if (stalls > 10) {
				// something under the pointer swallowed the wheel (or the page is still growing)
				captured = true;
				await page.evaluate((t) => window.scrollTo(0, t), target);
				break;
			}
		} else stalls = 0;
	}
	return { wheelStalled: captured };
}

// ---- run ----
const url = `${BASE}/?renderer=${RENDERER}`;
log(`open ${url} (webdriver ${MASK_WEBDRIVER ? "masked" : "visible"})`);
const navStart = Date.now();
await page.goto(url, { waitUntil: "load", timeout: 120_000 });
const loadMs = Date.now() - navStart;
await page.mouse.move(WIDTH - 10, 10);
// "load" window: from the first byte of app code to 2 s after load
await wait(2000);
currentWindow = "load";
{
	const raw = await page.evaluate(() => window.__perf.take());
	// the load window has no metric baseline: report only frames/longtasks/contexts
	windows.push({
		name: "load",
		loadEventMs: loadMs,
		frames: {
			n: raw.frames.length,
			p50: r1(q(raw.frames, 0.5)),
			p95: r1(q(raw.frames, 0.95)),
			max: r1(raw.frames.length ? Math.max(...raw.frames) : null),
			over50: raw.frames.filter((x) => x > 50).length,
		},
		longtasks: {
			n: raw.longtasks.length,
			totalMs: Math.round(raw.longtasks.reduce((s, [, x]) => s + x, 0)),
			maxMs: Math.round(Math.max(0, ...raw.longtasks.map(([, x]) => x))),
		},
		heapMB: r1((raw.heap ?? 0) / 2 ** 20),
		contextsCreated: raw.contexts,
		gpuEvents: raw.gpuEvents,
		workersCreated: raw.workers,
		raf: raw.raf.map((r) => ({ src: r.src, calls: r.calls, ms: r1(r.ms) })),
	});
	log(
		`load event ${loadMs} ms, LT ${windows[0].longtasks.n}/${windows[0].longtasks.totalMs}ms, contexts ${raw.contexts.length}, workers ${raw.workers.length}`,
	);
}

let secs = await sections();
log(
	`sections: ${secs.map((s) => `${s.index}:${s.slug}${s.embed ? `(${s.embed})` : ""}`).join(" ")}`,
);

const pick = (key) =>
	secs.find(
		(s) =>
			String(s.index) === key ||
			s.slug === key ||
			s.id === key ||
			s.embed === key ||
			s.eyebrow.toLowerCase().includes(String(key).toLowerCase()),
	);

if (!SECTION) {
	// idle at the top: nothing below the fold should be working
	await begin("idle-top");
	await wait(IDLE);
	await end();
}
phase = "scroll";

const todo = SECTION ? [pick(SECTION)].filter(Boolean) : secs.slice(1);
if (SECTION && !todo.length) {
	console.error(
		`--section ${SECTION} matches none of: ${secs.map((s) => s.slug).join(", ")}`,
	);
	await browser.close();
	process.exit(2);
}
for (const s0 of todo) {
	secs = await sections(); // layout shifts as embeds load
	const s = secs.find((x) => x.index === s0.index) ?? s0;
	// frame the section's embed: its top a little below the viewport top
	const target = Math.max(0, s.top - 40);
	if (SECTION) {
		// approach from one viewport above, so the scroll-in is measured too
		await page.evaluate(
			(y) => window.scrollTo(0, y),
			Math.max(0, target - HEIGHT),
		);
		await wait(800);
	}
	await begin(`${s.slug}:scroll`);
	const w = await wheelTo(target);
	await end({ section: s.slug, ...w });
	await begin(`${s.slug}:dwell`);
	await wait(DWELL);
	await end({ section: s.slug });
}

if (!SECTION) {
	await page.evaluate(() =>
		window.scrollTo(0, document.documentElement.scrollHeight),
	);
	await wait(500);
	await begin("idle-bottom");
	await wait(IDLE);
	await end();
}

await Promise.allSettled([...pending]);
const finalRaw = await page.evaluate(() => ({
	contexts: window.__perf.contexts,
	gpu: {
		adapters: window.__perf.gpu.adapters,
		devices: window.__perf.gpu.devices,
		destroyed: window.__perf.gpu.destroyed,
		events: window.__perf.gpu.events,
	},
	workers: window.__perf.workers,
	resolved:
		document.querySelector("[data-renderer]")?.getAttribute("data-renderer") ??
		null,
}));

const byType = (rs) => {
	const out = {};
	for (const r of rs) {
		const k = r.type;
		out[k] ??= { n: 0, kB: 0 };
		out[k].n++;
		out[k].kB += r.bytes / 1024;
	}
	for (const k of Object.keys(out)) out[k].kB = Math.round(out[k].kB);
	return out;
};
const byHost = (rs) => {
	const out = {};
	for (const r of rs) {
		out[r.host] ??= { n: 0, kB: 0 };
		out[r.host].n++;
		out[r.host].kB += r.bytes / 1024;
	}
	for (const k of Object.keys(out)) out[k].kB = Math.round(out[k].kB);
	return out;
};
const sum = (rs) => Math.round(rs.reduce((s, r) => s + r.bytes, 0) / 1024);
const beforeScroll = requests.filter((r) => r.phase === "load");
const network = {
	beforeFirstScroll: {
		n: beforeScroll.length,
		kB: sum(beforeScroll),
		byType: byType(beforeScroll),
		byHost: byHost(beforeScroll),
	},
	total: {
		n: requests.length,
		kB: sum(requests),
		byType: byType(requests),
		byHost: byHost(requests),
	},
	byWindow: Object.fromEntries(
		[...new Set(requests.map((r) => r.window))].map((w) => {
			const rs = requests.filter((r) => r.window === w);
			return [w, { n: rs.length, kB: sum(rs) }];
		}),
	),
	largest: [...requests]
		.sort((a, b) => b.bytes - a.bytes)
		.slice(0, 25)
		.map((r) => ({
			url: r.url,
			host: r.host,
			kB: Math.round(r.bytes / 1024),
			window: r.window,
		})),
	failed: requests.filter((r) => r.status < 0 || r.status >= 400).slice(0, 30),
	// same URL fetched more than once (the HTTP cache may still serve some)
	duplicates: Object.entries(
		requests.reduce((m, r) => {
			const k = `${r.host}${r.url}`;
			m[k] = (m[k] ?? 0) + 1;
			return m;
		}, {}),
	)
		.filter(([, n]) => n > 1)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 20),
};

const report = {
	when: new Date().toISOString(),
	url,
	renderer: RENDERER,
	resolvedRenderer: finalRaw.resolved,
	webdriverMasked: MASK_WEBDRIVER,
	viewport: { width: WIDTH, height: HEIGHT },
	dwellMs: DWELL,
	idleMs: IDLE,
	sections: secs,
	gpu: finalRaw.gpu,
	contexts: finalRaw.contexts,
	workers: finalRaw.workers,
	network,
	windows,
};
if (OUT) {
	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(OUT, `${JSON.stringify(report, null, "\t")}\n`);
	log(`wrote ${OUT}`);
}
log(
	`contexts ${Object.entries(
		finalRaw.contexts.reduce((m, c) => {
			const k = `${c.type}@${c.where}`;
			m[k] = (m[k] ?? 0) + 1;
			return m;
		}, {}),
	)
		.map(([k, n]) => `${n}x ${k}`)
		.join(
			", ",
		)} | adapters ${finalRaw.gpu.adapters} devices ${finalRaw.gpu.devices} destroyed ${finalRaw.gpu.destroyed} | workers ${finalRaw.workers.length}`,
);
log(
	`network: before scroll ${network.beforeFirstScroll.n} req / ${network.beforeFirstScroll.kB} kB, total ${network.total.n} req / ${network.total.kB} kB`,
);
await browser.close();
