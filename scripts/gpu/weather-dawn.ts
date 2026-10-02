// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// layers/weather.ts on a luma.gl WebGPU device over Dawn in node: builds the WeatherCore's Model
// through the real pass helpers (RIGI_WGSL_ASSEMBLER, luma's `precipitation` module at @group(3) next
// to the group-0 camera / weather modules), draws rain and snow through the real colour pass
// (hosts/passes.ts runColorPass: 1x rgba16float + reversed-Z depth) and reads it
// back: finite everywhere, a plausible coverage, premultiplied (rgb <= alpha), nothing when off.
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/weather-dawn.ts
// Exit 0 with SKIP when DAWN_DIR is unset, 1 on a failed check, 2 when there is no adapter.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device, Texture } from "@luma.gl/core";
import type { Precipitation } from "../../src/lib/look/weather/precipitation";
import { precipitationFor } from "../../src/lib/look/weather/precipitation";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP weather-dawn: DAWN_DIR is not set");
	process.exit(0);
}
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
const gpu = create([]);
if (!(await gpu.requestAdapter())) {
	console.error("no WebGPU adapter");
	process.exit(2);
}
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node", webdriver: true },
	configurable: true,
});
const { luma } = await import("@luma.gl/core");
const { webgpuAdapter } = await import("@luma.gl/webgpu");
const { runColorPass } = await import("../../src/lib/deck-webgpu/hosts/passes");
const { ColorTargets, GeometryTargets } = await import(
	"../../src/lib/deck-webgpu/targets"
);
const { createWeatherCore } = await import(
	"../../src/lib/deck-webgpu/layers/weather"
);

const device: Device = await luma.createDevice({
	type: "webgpu",
	adapters: [webgpuAdapter],
	createCanvasContext: false,
} as never);

const errors: string[] = [];
(device as unknown as { handle: GPUDevice }).handle.addEventListener(
	"uncapturederror",
	(e) => errors.push(String((e as GPUUncapturedErrorEvent).error.message)),
);

function half(h: number) {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const f = h & 0x3ff;
	if (e === 0) return s * 2 ** -14 * (f / 1024);
	if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY;
	return s * 2 ** (e - 15) * (1 + f / 1024);
}
async function readRgba16f(tex: Texture) {
	const layout = tex.computeMemoryLayout();
	const buf = device.createBuffer({
		byteLength: layout.byteLength,
		usage: 0x0001 | 0x0008,
	});
	tex.readBuffer({}, buf);
	const bytes = await buf.readAsync(0, layout.byteLength);
	buf.destroy();
	const u16 = new Uint16Array(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength / 2,
	);
	const out = new Float32Array(tex.width * tex.height * 4);
	const stride = layout.bytesPerRow / 2;
	for (let y = 0; y < tex.height; y++)
		for (let x = 0; x < tex.width * 4; x++)
			out[y * tex.width * 4 + x] = half(u16[y * stride + x]);
	return out;
}

const W = 320;
const H = 200;
const color = new ColorTargets(device, W, H, "weather-dawn-color");
const geometry = new GeometryTargets(device, 16, 16, "weather-dawn-geometry");
// 1x direct: Dawn-node rejects luma's MSAA resolveTargets texture (as layers/pins.check.ts notes)
color.setReduced(true);
const core = createWeatherCore(device, "weather-dawn");
const view = {
	eye: [30000, -30000, 2500] as [number, number, number],
	forward: [0, 1, 0] as [number, number, number],
	up: [0, 0, 1] as [number, number, number],
	vfov: 40,
	near: 1,
};

let bad = 0;
const check = (name: string, ok: boolean, info = "") => {
	if (!ok) bad++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name} ${info}`);
};

async function frame(p: Precipitation | null) {
	core.setPrecipitation(p);
	runColorPass({
		device,
		cores: [core],
		geometry,
		color,
		view,
		frame: { frame: 0, time: 0, view: "world" },
	});
	device.submit();
	const px = await readRgba16f(color.color);
	let nonFinite = 0;
	let covered = 0;
	let notPremultiplied = 0;
	let maxAlpha = 0;
	for (let i = 0; i < W * H; i++) {
		for (let c = 0; c < 4; c++)
			if (!Number.isFinite(px[i * 4 + c])) nonFinite++;
		const a = px[i * 4 + 3];
		if (a > 0.01) covered++;
		maxAlpha = Math.max(maxAlpha, a);
		if (px[i * 4] > a + 2e-3 || px[i * 4 + 2] > a + 2e-3) notPremultiplied++;
	}
	return { nonFinite, covered, notPremultiplied, maxAlpha };
}

try {
	const rain = precipitationFor({ mode: "rain", intensity: 1, wind: 4 });
	const snow = precipitationFor({ mode: "snow", intensity: 1, wind: 2 });
	if (!rain || !snow) throw new Error("precipitationFor returned null");
	const off = await frame(null);
	check("off draws nothing", off.covered === 0 && off.nonFinite === 0);
	for (const [name, p] of [
		["rain", rain],
		["snow", snow],
	] as const) {
		const r = await frame(p);
		check(
			`${name} draws finite, premultiplied particles`,
			r.nonFinite === 0 &&
				r.notPremultiplied === 0 &&
				r.covered > 50 &&
				r.covered < W * H * 0.5 &&
				r.maxAlpha <= 1.001,
			JSON.stringify(r),
		);
	}
} catch (e) {
	console.error(e);
	bad++;
}
check(
	"no uncaptured GPU validation errors",
	errors.length === 0,
	errors[0] ?? "",
);
core.destroy();
color.destroy();
geometry.destroy();
device.destroy();
process.exit(bad ? 1 : 0);
