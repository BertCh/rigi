// GPU twin of look/relief/field.ts buildReliefField: the heights are still rasterised on the CPU
// (rasterizeHeights, ~15 ms: tile lookups), then shadow, sky view, curvature and the generalised
// normal run as WGSL kernels (relief.wgsl.ts) and the two RGBA8 textures are read back. Buffers are
// pooled (core/pool.ts, lease "look-relief"), so a warm call allocates nothing on the GPU.
import type { Device } from "@luma.gl/core";
import type { EnuFrame } from "../../geodesy";
import type { Vec3 } from "../../look/atmosphere";
import type { ReliefField } from "../../look/relief/field";
import {
	type Extent,
	type HeightTile,
	rasterizeHeights,
} from "../../look/relief/heights";
import {
	clear,
	defineKernel,
	dispatch,
	kernel,
	pooledStorage,
	pooledUniform,
	stageReads,
	submit,
	withLease,
} from "./kernel";
import {
	RELIEF_DOWN,
	RELIEF_PACK,
	RELIEF_SHADOW,
	RELIEF_SUM,
	RELIEF_SVF,
} from "./relief.wgsl";

export const K_RELIEF_SHADOW = defineKernel("relief-shadow", RELIEF_SHADOW, [
	["prm", "uniform"],
	["H", "read-only-storage"],
	["shadow", "storage"],
]);
export const K_RELIEF_DOWN = defineKernel("relief-down", RELIEF_DOWN, [
	["prm", "uniform"],
	["Hf", "read-only-storage"],
	["Hh", "storage"],
]);
export const K_RELIEF_SVF = defineKernel("relief-svf", RELIEF_SVF, [
	["prm", "uniform"],
	["Hh", "read-only-storage"],
	["hull", "storage"],
	["acc8", "storage"],
]);
export const K_RELIEF_SUM = defineKernel("relief-sum", RELIEF_SUM, [
	["prm", "uniform"],
	["acc8", "read-only-storage"],
	["acc", "storage"],
]);
export const K_RELIEF_PACK = defineKernel("relief-pack", RELIEF_PACK, [
	["prm", "uniform"],
	["H", "read-only-storage"],
	["shadow", "read-only-storage"],
	["acc", "read-only-storage"],
	["field", "storage"],
	["gen", "storage"],
]);

// mirror of field.ts (keep in sync)
const RES = 1024;
const HALF = 20000;
const AHEAD = 12000;
const SVF_R = 3000;
const HOLE = -1e6;

export type ReliefGpuOptions = {
	/** run the passes on a core ComputeGraph (relief-graph.ts); default true; false: the pooled path below */
	graph?: boolean;
};

/** GPU twin of buildReliefField(tiles, frame, sunDir, yawDeg). */
export async function buildReliefFieldGpu(
	device: Device,
	tiles: readonly HeightTile[],
	frame: EnuFrame,
	sunDir: Vec3,
	yawDeg: number | null,
	opts: ReliefGpuOptions = {},
): Promise<ReliefField> {
	const t0 = performance.now();
	const { res, extent, px, H } = reliefHeights(tiles, frame, yawDeg);
	const { field, gen } = await reliefPassesGpu(
		device,
		H,
		res,
		px,
		sunDir,
		opts,
	);
	return { res, extent, field, gen, ms: performance.now() - t0 };
}

/** buildReliefField's extent + rasterised heights (res², row 0 = south) for `yawDeg`. */
export function reliefHeights(
	tiles: readonly HeightTile[],
	frame: EnuFrame,
	yawDeg: number | null,
) {
	const res = RES;
	const a = ((yawDeg ?? 0) * Math.PI) / 180;
	const c =
		yawDeg == null ? [0, 0] : [Math.sin(a) * AHEAD, Math.cos(a) * AHEAD];
	const extent: Extent = [c[0] - HALF, c[1] - HALF, c[0] + HALF, c[1] + HALF];
	const px = (2 * HALF) / res;
	const H = rasterizeHeights(tiles, frame, extent, res, HOLE);
	return { res, extent, px, H };
}

/** field.ts castShadow + skyView + curvatureAndNormal over heights `H` (res², row 0 = south). */
export async function reliefPassesGpu(
	device: Device,
	H: Float32Array,
	res: number,
	px: number,
	sun: Vec3,
	opts: ReliefGpuOptions = {},
): Promise<{ field: Uint8Array; gen: Uint8Array }> {
	const { words, degenerate } = reliefWords(res, px, sun);
	if (opts.graph ?? true)
		return (await import("./relief-graph")).reliefGraphPasses(
			device,
			H,
			res,
			words,
			degenerate,
		);
	const resH = res >> 1;
	const N = res * res;
	const NH = resH * resH;
	return withLease("look-relief", async () => {
		// every output below is fully written by its kernel, except the OR-packed shadow bytes
		// (cleared on the encoder); acc8 is cleared too, as the fresh buffers were zero
		const scratch = (key: string, bytes: number) =>
			pooledStorage(device, `look-relief/${key}`, bytes, { zero: false });
		const prm = pooledUniform(device, "look-relief/prm", words);
		const gH = pooledStorage(device, "look-relief/H", H);
		const shadow = scratch("shadow", N); // 4 texels per u32
		const Hh = scratch("Hh", NH * 4);
		const hull = scratch("hull", 8 * NH * 4);
		const acc8 = scratch("acc8", 8 * NH * 4);
		const acc = scratch("acc", NH * 4);
		const field = scratch("field", N * 4);
		const gen = scratch("gen", N * 4);

		const enc = device.createCommandEncoder({ id: "look-relief" });
		if (!degenerate) {
			clear(enc, shadow, 0, N);
			dispatch(enc, kernel(device, K_RELIEF_SHADOW), { prm, H: gH, shadow }, 1);
		}
		dispatch(
			enc,
			kernel(device, K_RELIEF_DOWN),
			{ prm, Hf: gH, Hh },
			Math.ceil(NH / 256),
		);
		clear(enc, acc8, 0, 8 * NH * 4);
		dispatch(
			enc,
			kernel(device, K_RELIEF_SVF),
			{ prm, Hh, hull, acc8 },
			Math.ceil((2 * resH) / 64),
			8,
		);
		dispatch(
			enc,
			kernel(device, K_RELIEF_SUM),
			{ prm, acc8, acc },
			Math.ceil(NH / 256),
		);
		dispatch(
			enc,
			kernel(device, K_RELIEF_PACK),
			{ prm, H: gH, shadow, acc, field, gen },
			Math.ceil(res / 16),
			Math.ceil(res / 16),
		);
		const rd = stageReads(device, enc, [
			{ buffer: field, size: N * 4 },
			{ buffer: gen, size: N * 4 },
		]);
		submit(device, enc);
		const [f, g] = await rd.read();
		return { field: new Uint8Array(f), gen: new Uint8Array(g) };
	});
}

/** The relief kernels' uniform block for (res, px, sun): castShadow's and curvatureAndNormal's constants. */
export function reliefWords(
	res: number,
	px: number,
	sun: Vec3,
): { words: ArrayBuffer; degenerate: boolean } {
	if (res > 2048 || res % 2) throw new Error(`relief res ${res} unsupported`);
	const resH = res >> 1;
	// castShadow's constants (f64 here, as the CPU)
	const hz = Math.hypot(sun[0], sun[1]);
	const degenerate = sun[2] <= -0.02 || hz < 1e-4;
	const xMajor = Math.abs(sun[0]) >= Math.abs(sun[1]);
	const major = xMajor ? sun[0] : sun[1];
	const slope = degenerate ? 0 : (xMajor ? sun[1] : sun[0]) / Math.abs(major);
	const tanEl = degenerate ? 0 : sun[2] / hz;
	const drop = px * Math.hypot(1, slope) * tanEl;
	// curvatureAndNormal's constants
	const ra = Math.max(1, Math.round(60 / px));
	const rb = Math.max(3, Math.round(250 / px));
	const da = Math.max(1, Math.round(ra / Math.SQRT2));
	const db = Math.max(1, Math.round(rb / Math.SQRT2));

	const words = new ArrayBuffer(80);
	const dv = new DataView(words);
	let o = 0;
	const u32 = (v: number) => {
		dv.setUint32(o, v, true);
		o += 4;
	};
	const i32 = (v: number) => {
		dv.setInt32(o, v, true);
		o += 4;
	};
	const f32 = (v: number) => {
		dv.setFloat32(o, v, true);
		o += 4;
	};
	u32(res);
	u32(resH);
	u32(xMajor ? 1 : res); // sa
	u32(xMajor ? res : 1); // sb
	i32(major > 0 ? 1 : -1); // s
	i32(Math.floor(slope)); // b0 = b + floor(slope)
	f32(slope - Math.floor(slope)); // the interpolation weight, constant along a row
	f32(drop);
	f32(Math.max(8, 0.6 * drop)); // w
	f32(0.6 + 0.15 * px); // bias
	i32(degenerate ? (sun[2] <= -0.02 ? 0 : 255) : -1);
	f32(px * 2); // pxH
	i32(ra);
	i32(rb);
	i32(da);
	i32(db);
	f32((0.55 / (ra * px * 0.35)) * 0.125); // ka
	f32((0.45 / (rb * px * 0.3)) * 0.125); // kb
	f32(1 / (2 * ra * px)); // g
	f32(SVF_R);
	return { words, degenerate };
}
