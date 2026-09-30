// In-browser isolation check for layers/terrain-styles.ts (no lab, no region data). Draws a
// synthetic DEM tile (a smooth massif, 1000–3100 m, slopes 0–60°) through the real TerrainCore
// geometry + MSAA colour passes (hosts/passes.ts) with every style program, reads back the
// resolved colour and the geometry targets, and checks against a CPU port of the WebGL shader:
//   compile     every style × LOOK feature program builds with no WebGPU validation error
//   hillshade   classic: hypso(elev) · shade(n), hazed — CPU reference per pixel (≤ 1.5 %)
//   imagery     a constant sRGB tile: decoded, softened on steep faces, hazed (≤ 2 %)
//   contours    premultiplied (rgb ≤ a), lines sit on elevation multiples of the interval
//   elevation   off-line pixels: alpha = band alpha · ground fade, colour = band ramp · shade
//   slopeClass  < 29° transparent, > 46° the fourth class colour at slope alpha
//   slope       opaque everywhere
//   nearDiscard photo view: nothing nearer than the radius; world view: unaffected
//   features    alpine / relief / tanaka / atmosphere programs render finite, non-degenerate
// Run from a page served by vite (any route), e.g. with playwright:
//   await page.evaluate(async () => (await import("/src/lib/deck-webgpu/layers/terrain-styles.check.ts")).runTerrainStylesCheck())
import { type Device, luma, type Texture } from "@luma.gl/core";
import { webgpuAdapter } from "@luma.gl/webgpu";
import type { TileMesh } from "#/lib/deck/terrain-data";
import { atmosphereValues } from "#/lib/look/atmosphere";
import {
	type DeckTerrainStyle,
	deckTerrainStyle,
} from "#/lib/style/deck-apply";
import { CLASSIC } from "#/lib/style/defaults";
import type { CameraPose } from "../hosts/passes";
import { runColorPass, runGeometryPass } from "../hosts/passes";
import { ImageryArray } from "../imagery";
import { TextureReader } from "../readback";
import { ColorTargets, GeometryTargets } from "../targets";
import { TerrainCore } from "../terrain";
import {
	type TerrainStyleFeatures,
	type TerrainStyleName,
	TerrainStyles,
} from "./terrain-styles";

type V3 = [number, number, number];

// ---- synthetic DEM tile -------------------------------------------------------------------------

const N = 160; // vertices per side
const X0 = -3000;
const X1 = 3000;
const Y0 = 300;
const Y1 = 6300;
const height = (x: number, y: number) =>
	1000 +
	2100 * Math.exp(-((x - 300) ** 2 + (y - 3800) ** 2) / (2 * 900 ** 2)) +
	120 * Math.sin(x / 700) * Math.cos(y / 900);

function syntheticTile(): TileMesh {
	const positions = new Float32Array(N * N * 3);
	const normals = new Float32Array(N * N * 3);
	const texCoords = new Float32Array(N * N * 2);
	const elev = new Float32Array(N * N);
	const h = 1;
	for (let j = 0; j < N; j++)
		for (let i = 0; i < N; i++) {
			const k = j * N + i;
			const x = X0 + ((X1 - X0) * i) / (N - 1);
			const y = Y1 - ((Y1 - Y0) * j) / (N - 1); // row 0 = north, as buildMesh
			const z = height(x, y);
			const dx = (height(x + h, y) - height(x - h, y)) / (2 * h);
			const dy = (height(x, y + h) - height(x, y - h)) / (2 * h);
			const l = Math.hypot(dx, dy, 1);
			positions.set([x, y, z], k * 3);
			normals.set([-dx / l, -dy / l, 1 / l], k * 3);
			texCoords.set([i / (N - 1), j / (N - 1)], k * 2);
			elev[k] = z;
		}
	const indices = new Uint32Array((N - 1) * (N - 1) * 6);
	let o = 0;
	for (let j = 0; j < N - 1; j++)
		for (let i = 0; i < N - 1; i++) {
			const a = j * N + i;
			indices.set([a, a + N, a + 1, a + 1, a + N, a + N + 1], o);
			o += 6;
		}
	return {
		id: "synthetic",
		key: { x: 0, y: 0, z: 12 } as never,
		distance: 0,
		size: N,
		heights: new Float32Array(0),
		sourceZ: 12,
		focus: true,
		seg: N - 1,
		positions,
		normals,
		texCoords,
		elev,
		indices,
	};
}

// ---- CPU port of the classic shading (reference) ------------------------------------------------

const toLin = (c: number) => Math.max(c, 0) ** 2.2;
const smooth = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const srgbDecode = (c: number) =>
	c <= 0.04045 ? c * 0.0773993808 : (c * 0.9478672986 + 0.0521327014) ** 2.4;

function rampEval(
	r: { c0: number[]; c1: number[]; de: number[]; n: number },
	t: number,
): V3 {
	const stop = (i: number) =>
		i < 4 ? r.c0.slice(i * 4, i * 4 + 4) : r.c1.slice((i - 4) * 4, i * 4 - 12);
	const div = (i: number) => r.de[i];
	const ease = (i: number) => r.de[8 + i];
	const n = Math.round(r.n);
	let prev = stop(0);
	let c: V3 = [prev[0], prev[1], prev[2]];
	for (let i = 1; i < 8 && i < n; i++) {
		const s = stop(i);
		if (t < s[3] || i === n - 1) {
			const f =
				ease(i) > 0.5
					? smooth(prev[3], s[3], t)
					: clamp01((t - prev[3]) / div(i));
			c = [0, 1, 2].map((k) => prev[k] + (s[k] - prev[k]) * f) as V3;
			break;
		}
		prev = s;
	}
	return c;
}

function shade(L: DeckTerrainStyle, n: V3) {
	const l = Math.max(
		n[0] * L.sunDir[0] + n[1] * L.sunDir[1] + n[2] * L.sunDir[2],
		0,
	);
	return L.shade[0] * (0.5 + 0.5 * n[2]) + L.shade[1] * l;
}

function haze(L: DeckTerrainStyle, c: V3, range: number): V3 {
	const f = Math.min(
		1 - Math.exp(-range * L.hazeParams[0] * L.haze),
		L.hazeParams[1],
	);
	return c.map((x, k) => x + (toLin(L.hazeColor[k]) - x) * f) as V3;
}

// ---- readback -----------------------------------------------------------------------------------

function half(h: number) {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const fr = h & 0x3ff;
	if (e === 0) return s * 2 ** -14 * (fr / 1024);
	if (e === 31) return fr ? Number.NaN : s * Number.POSITIVE_INFINITY;
	return s * 2 ** (e - 15) * (1 + fr / 1024);
}

async function readRgba16f(device: Device, tex: Texture) {
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

// ---- the check ----------------------------------------------------------------------------------

export type TerrainStylesCheck = {
	ok: boolean;
	checks: Record<string, { ok: boolean; [k: string]: unknown }>;
};

type Frame = {
	color: Float32Array;
	xyzr: Float32Array;
	normal: Float32Array;
	errors: string[];
};

export async function runTerrainStylesCheck(
	opts: { width?: number; height?: number } = {},
): Promise<TerrainStylesCheck> {
	const W = opts.width ?? 256; // multiple of 16: 256-byte aligned rgba32float rows
	const H = opts.height ?? 192;
	const device = await luma.createDevice({
		id: "terrain-styles-check",
		type: "webgpu",
		adapters: [webgpuAdapter],
	} as never);
	const gpu = (device as unknown as { handle: GPUDevice }).handle;
	const color = new ColorTargets(device, W, H, "ts-check-color");
	const geometry = new GeometryTargets(device, W, H, "ts-check-geometry");
	const reader = new TextureReader(device);

	// imagery: one constant sRGB tile (rgb 150, 110, 70)
	const IMG = [150, 110, 70];
	const imagery = new ImageryArray(device);
	const px = new ImageData(64, 64);
	for (let i = 0; i < 64 * 64; i++) px.data.set([...IMG, 255], i * 4);
	const bmp = await createImageBitmap(px);
	const landed = new Promise<void>((r) => {
		imagery.onChange = () => r();
	});
	imagery.sync(new Map([["synthetic", bmp]]), ["synthetic"]);
	await Promise.race([landed, new Promise((r) => setTimeout(r, 3000))]);

	const tile = syntheticTile();
	const terrain = new TerrainCore(device, imagery, "ts-check-terrain");
	terrain.setTiles([tile]);
	terrain.syncImageryLayers();
	const styles = new TerrainStyles(device);
	const elevRange: [number, number] = [900, 3300];

	const eye: V3 = [0, -1500, 3400];
	const target: V3 = [300, 3800, 1800];
	const d = target.map((t, k) => t - eye[k]) as V3;
	const dl = Math.hypot(...d);
	const forward = d.map((x) => x / dl) as V3;
	const right = [forward[1], -forward[0], 0];
	const rl = Math.hypot(...right);
	const r3 = right.map((x) => x / rl) as V3;
	const up: V3 = [
		r3[1] * forward[2] - r3[2] * forward[1],
		r3[2] * forward[0] - r3[0] * forward[2],
		r3[0] * forward[1] - r3[1] * forward[0],
	];
	const cam: CameraPose = { eye, forward, up, vfov: 50, near: 1 };

	const render = async (
		p: Partial<ConstructorParameters<typeof TerrainStyles>[1]> & {
			haze?: number | null;
			/** also discard in the geometry pass (TerrainLook.nearDiscard) */
			geomDiscard?: boolean;
		},
		view: "photo" | "world" = "photo",
	): Promise<Frame> => {
		const { haze, geomDiscard, ...props } = p;
		styles.set(props);
		styles.applyTo(terrain);
		terrain.look = styles.terrainLook(elevRange, haze ?? null);
		// the check exercises the colour pass's discard only (keep the geometry pass whole)
		if (!geomDiscard) terrain.look = { ...terrain.look, nearDiscard: 0 };
		gpu.pushErrorScope("validation");
		const frame = { frame: 0, time: performance.now(), view };
		runGeometryPass({ device, cores: [terrain], geometry, photo: cam, frame });
		runColorPass({
			device,
			cores: [terrain],
			geometry,
			color,
			view: cam,
			frame,
		});
		device.submit();
		const err = await gpu.popErrorScope();
		const colorPx = await readRgba16f(device, color.color);
		const xyzr = (await reader.read(geometry.geometry)) ?? new Float32Array(0);
		const normal = await readRgba16f(device, geometry.normal);
		return {
			color: colorPx,
			xyzr,
			normal,
			errors: err ? [err.message] : [],
		};
	};

	const checks: TerrainStylesCheck["checks"] = {};
	const classicOverlay = deckTerrainStyle(CLASSIC, "overlay");
	const classicReplace = deckTerrainStyle(CLASSIC, "replace");
	/** pixel iterator over terrain texels away from depth edges */
	const interior = (fr: Frame, stepPx = 5) => {
		const out: number[] = [];
		for (let y = 2; y < H - 2; y += stepPx)
			for (let x = 2; x < W - 2; x += stepPx) {
				const i = y * W + x;
				const r = fr.xyzr[i * 4 + 3];
				if (r <= 0) continue;
				let edge = false;
				for (const j of [i - 1, i + 1, i - W, i + W])
					if (Math.abs(fr.xyzr[j * 4 + 3] - r) > r * 0.02) edge = true;
				if (!edge) out.push(i);
			}
		return out;
	};
	const nrm = (fr: Frame, i: number): V3 => {
		const n: V3 = [
			fr.normal[i * 4],
			fr.normal[i * 4 + 1],
			fr.normal[i * 4 + 2],
		];
		const l = Math.hypot(...n) || 1;
		return n.map((x) => x / l) as V3;
	};
	const slopeDeg = (n: V3) => (Math.acos(clamp01(n[2])) * 180) / Math.PI;
	const rgba = (fr: Frame, i: number) =>
		Array.from(fr.color.slice(i * 4, i * 4 + 4));
	const finite = (fr: Frame) => fr.color.every((v) => Number.isFinite(v));
	const covered = (fr: Frame) => {
		let n = 0;
		for (let i = 0; i < W * H; i++) if (fr.color[i * 4 + 3] > 0.01) n++;
		return n / (W * H);
	};

	// 1. compile / validate every program
	const combos: [TerrainStyleName, Partial<TerrainStyleFeatures>][] = [];
	for (const style of ["hillshade", "imagery"] as const)
		for (let m = 0; m < 8; m++)
			combos.push([
				style,
				{ alpine: !!(m & 1), relief: !!(m & 2), atmosphere: !!(m & 4) },
			]);
	combos.push(
		["contours", {}],
		["contours", { tanaka: true }],
		["elevation", {}],
		["elevation", { relief: true }],
		["slope", {}],
		["slopeClass", {}],
	);
	const lookWith = (ft: Partial<TerrainStyleFeatures>): DeckTerrainStyle => {
		const L = deckTerrainStyle(CLASSIC, "replace");
		const defines = [
			...(ft.alpine ? ["LOOK_ALPINE"] : []),
			...(ft.relief ? ["LOOK_RELIEF"] : []),
			...(ft.tanaka ? ["LOOK_TANAKA"] : []),
			...(ft.atmosphere ? ["LOOK_ATMOSPHERE"] : []),
		] as DeckTerrainStyle["defines"];
		return {
			...L,
			defines,
			atm: ft.atmosphere
				? atmosphereValues(CLASSIC, "replace", L.sunDir, [0, 0, 0])
				: null,
			rel: ft.relief
				? {
						sunDir: L.sunDir,
						sunColor: [1, 0.96, 0.9],
						extent: [-4000, 0, 4000, 8000],
						realism: 0.4,
						generalize: 0.5,
						curvature: 0.5,
						edge: 0.08,
					}
				: null,
		};
	};
	const compile: Record<string, unknown> = {};
	const featureFrames: Record<string, { finite: boolean; covered: number }> =
		{};
	let compileOk = true;
	for (const [style, ft] of combos) {
		const fr = await render({
			style,
			look: lookWith(ft),
			contourInterval: 100,
		});
		const name = `${style}${Object.entries(ft)
			.filter(([, v]) => v)
			.map(([k]) => `+${k}`)
			.join("")}`;
		if (fr.errors.length) {
			compileOk = false;
			compile[name] = fr.errors;
		}
		featureFrames[name] = { finite: finite(fr), covered: covered(fr) };
	}
	checks.compile = {
		ok: compileOk,
		programs: combos.length,
		errors: compile,
	};
	checks.features = {
		ok: Object.entries(featureFrames).every(
			([k, v]) =>
				v.finite &&
				(k.startsWith("contours") || k.startsWith("slopeClass")
					? v.covered > 0.01
					: v.covered > 0.3),
		),
		frames: featureFrames,
	};

	// 2. classic hillshade vs the CPU reference
	{
		const L = classicReplace;
		const fr = await render({ style: "hillshade", look: L });
		let n = 0;
		let maxErr = 0;
		let worst: unknown = null;
		for (const i of interior(fr)) {
			const nn = nrm(fr, i);
			const z = fr.xyzr[i * 4 + 2];
			const t = clamp01((z - elevRange[0]) / (elevRange[1] - elevRange[0]));
			const alb = rampEval(L.relief, t).map(toLin) as V3;
			const s = shade(L, nn);
			const want = haze(L, alb.map((c) => c * s) as V3, fr.xyzr[i * 4 + 3]);
			const got = rgba(fr, i);
			const e = Math.max(
				...want.map((w, k) => Math.abs(got[k] - w) / Math.max(w, 0.02)),
			);
			if (e > maxErr) {
				maxErr = e;
				worst = { i, want, got };
			}
			n++;
		}
		checks.hillshade = {
			ok: n > 200 && maxErr < 0.015,
			samples: n,
			maxRelErr: maxErr,
			worst,
		};
	}

	// 3. imagery: constant tile, steep-face softening, haze
	{
		const L = classicReplace;
		const fr = await render({ style: "imagery", look: L });
		const img = IMG.map((c) => srgbDecode(c / 255)) as V3;
		let n = 0;
		let maxErr = 0;
		let worst: unknown = null;
		for (const i of interior(fr)) {
			const nn = nrm(fr, i);
			const steep = 1 - smooth(0.17, 0.34, nn[2]);
			const base = img.map(
				(c) => c + (c * (0.7 + 0.45 * shade(L, nn)) - c) * 0.5 * steep,
			) as V3;
			const want = haze(L, base, fr.xyzr[i * 4 + 3]);
			const got = rgba(fr, i);
			const e = Math.max(
				...want.map((w, k) => Math.abs(got[k] - w) / Math.max(w, 0.02)),
			);
			if (e > maxErr) {
				maxErr = e;
				worst = { i, want, got };
			}
			n++;
		}
		checks.imagery = {
			ok: n > 200 && maxErr < 0.02,
			samples: n,
			maxRelErr: maxErr,
			worst,
			imageryLayers: imagery.stats.layers,
		};
	}

	// 4. contours: premultiplied, lines on elevation multiples
	{
		const I = 100;
		const L = classicOverlay;
		const fr = await render({ style: "contours", look: L, contourInterval: I });
		let premulBad = 0;
		let lines = 0;
		let offLine = 0;
		for (let y = 1; y < H - 1; y++)
			for (let x = 1; x < W - 1; x++) {
				const i = y * W + x;
				const c = rgba(fr, i);
				if (c[0] > c[3] + 2e-3 || c[1] > c[3] + 2e-3 || c[2] > c[3] + 2e-3)
					premulBad++;
				if (c[3] < 0.5 || fr.xyzr[i * 4 + 3] <= 0) continue;
				// fwidth(elev) from the geometry target's neighbours
				const z = fr.xyzr[i * 4 + 2];
				const fw =
					Math.abs(fr.xyzr[(i + 1) * 4 + 2] - z) +
					Math.abs(fr.xyzr[(i + W) * 4 + 2] - z);
				const e = z / I;
				const dPx =
					(Math.abs(((((e - 0.5) % 1) + 1) % 1) - 0.5) * I) /
					Math.max(fw, 1e-6);
				lines++;
				if (dPx > L.contourWidth * L.contourMajorMul * 0.5 + 2.5) offLine++;
			}
		checks.contours = {
			ok: premulBad === 0 && lines > 50 && offLine / lines < 0.05 && finite(fr),
			premulBad,
			linePixels: lines,
			offLineFrac: lines ? offLine / lines : null,
			covered: covered(fr),
		};
	}

	// 5. elevation bands, off-line pixels
	{
		const I = 100;
		const L = classicOverlay;
		const fr = await render({
			style: "elevation",
			look: L,
			contourInterval: I,
		});
		let n = 0;
		let matched = 0;
		let maxErr = 0;
		let worst: unknown = null;
		for (const i of interior(fr)) {
			const range = fr.xyzr[i * 4 + 3];
			const z = fr.xyzr[i * 4 + 2];
			const aWant =
				L.bandAlpha * smooth(L.bandGroundFade[0], L.bandGroundFade[1], range);
			const got = rgba(fr, i);
			n++;
			if (Math.abs(got[3] - aWant) > 2e-3 || aWant < 0.05) continue; // on a line
			const stepM = I * L.contourMajorEvery;
			// MSAA samples straddling a band boundary average two bands: skip those pixels
			const fwz =
				Math.abs(fr.xyzr[(i + 1) * 4 + 2] - z) +
				Math.abs(fr.xyzr[(i + W) * 4 + 2] - z);
			const toEdge = Math.min(
				z - Math.floor(z / stepM) * stepM,
				Math.ceil(z / stepM) * stepM - z,
			);
			if (toEdge < 1.5 * fwz) continue;
			matched++;
			const bt = clamp01(
				(Math.floor(z / stepM) * stepM - elevRange[0]) /
					(elevRange[1] - elevRange[0]),
			);
			const s = L.bandShade[0] + L.bandShade[1] * shade(L, nrm(fr, i));
			const want = rampEval(L.band, bt).map((c) => toLin(c) * s);
			const e = Math.max(
				...want.map(
					(w, k) => Math.abs(got[k] / got[3] - w) / Math.max(...want, 0.02),
				),
			);
			if (e > maxErr) {
				maxErr = e;
				worst = { i, z, want, got };
			}
		}
		checks.elevation = {
			ok: n > 200 && matched / n > 0.4 && maxErr < 0.03,
			samples: n,
			offLine: matched,
			maxRelErr: maxErr,
			worst,
		};
	}

	// 6. slope layer classes
	{
		const L = classicOverlay;
		const fr = await render({ style: "slopeClass", look: L });
		let flat = 0;
		let flatBad = 0;
		let steep = 0;
		let steepBad = 0;
		const c3 = L.slopeColors[3];
		for (const i of interior(fr, 3)) {
			const sd = slopeDeg(nrm(fr, i));
			const got = rgba(fr, i);
			if (sd < 27) {
				flat++;
				if (got[3] > 0.01) flatBad++;
			} else if (sd > 46) {
				steep++;
				const ok =
					Math.abs(got[3] - L.slopeAlpha) < 0.02 &&
					c3.every((c, k) => Math.abs(got[k] / got[3] - c) < 0.03);
				if (!ok) steepBad++;
			}
		}
		checks.slopeClass = {
			ok: flat > 50 && steep > 5 && flatBad === 0 && steepBad / steep < 0.05,
			flat,
			flatBad,
			steep,
			steepBad,
		};
	}

	// 7. slope debug: opaque
	{
		const fr = await render({ style: "slope", look: classicReplace });
		const idx = interior(fr);
		const bad = idx.filter(
			(i) => Math.abs(fr.color[i * 4 + 3] - 1) > 1e-3,
		).length;
		checks.slope = {
			ok: idx.length > 200 && bad === 0 && finite(fr),
			samples: idx.length,
			bad,
		};
	}

	// 8. nearDiscard: photo view discards (revealing only terrain beyond the radius), world view
	// does not. Reference geometry: the full surface (geometry discard off) and, for what the
	// discard reveals, the geometry pass with the same radius.
	{
		const R = 5000;
		const props = {
			style: "hillshade" as const,
			look: classicReplace,
			nearDiscard: R,
		};
		const photo = await render(props, "photo");
		const world = await render(props, "world");
		const revealed = await render({ ...props, geomDiscard: true }, "photo");
		let near = 0;
		let wrong = 0;
		let worldNearDrawn = 0;
		let minRevealed = Infinity;
		for (const i of interior(photo)) {
			if (photo.xyzr[i * 4 + 3] >= R * 0.95) continue;
			near++;
			const behind = revealed.xyzr[i * 4 + 3];
			if (behind > 0) minRevealed = Math.min(minRevealed, behind);
			const drawn = photo.color[i * 4 + 3] > 0.5;
			if (drawn !== behind > 0) wrong++;
			if (world.color[i * 4 + 3] > 0.99) worldNearDrawn++;
		}
		checks.nearDiscard = {
			ok:
				near > 50 &&
				wrong <= near * 0.01 &&
				worldNearDrawn === near &&
				!(minRevealed < R),
			near,
			wrong,
			worldNearDrawn,
			minRevealed,
		};
		styles.set({ nearDiscard: 0 });
	}

	styles.destroy();
	terrain.destroy();
	imagery.destroy();
	bmp.close();
	reader.destroy();
	color.destroy();
	geometry.destroy();
	device.destroy();
	return {
		ok: Object.values(checks).every((c) => c.ok),
		checks,
	};
}
