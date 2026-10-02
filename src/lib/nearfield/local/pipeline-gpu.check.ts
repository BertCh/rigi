// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside's depth pipeline on the compute graph (./pipeline-gpu.ts: GPU prep, net, compose, normals,
// lift; 64² reads only) against the former flow, over Dawn in node, on demo photos with the q8 weights.
//   OLD  RGBA → CPU planes (sky/core.ts resamplePlanes, the same input filter) → net.run → full readbacks
//        → composeDepth (CPU) → lift records (CPU twin of the lift)
//   NEW  the same RGBA as padded rows → prepSkyGpuFromRows → graph 1 → focal fit → graph 2 → one read
// Reports per photo: depth |d / d_old - 1| median and p90 on pixels valid in both, valid IoU, focal rel
// diff, normal angle median, splat count, lift position rel diff median (cells kept by both); the pos-embed
// GPU resample vs interpolatePosEmbed; the normals-from-depth kernel vs normalsFromDepth on the q8lite path
// (angle median, valid agreement); a photo smaller than the net input (the upsample path); end-to-end time
// OLD vs NEW (warm, median of 5, noisy shared machine) and the bytes read back.
//
//   DAWN_DIR=/tmp/dawn npx tsx src/lib/nearfield/local/pipeline-gpu.check.ts [--photos 3]
// SKIP (exit 0) without DAWN_DIR, the q8 / q8lite weights or the demo photos.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { releaseCachedGraphs } from "#/lib/gpu/core/graph";
import { GpuNn } from "#/lib/nn/gpu/gpu-nn";
import { resamplePlanes, rgbPlanes } from "#/lib/sky/core";
import { dawnDevice } from "../../../../scripts/nn/dawn";
import { composeDepth, normalsFromDepth } from "./compose";
import {
	FOCAL_GRID,
	interpolatePosEmbed,
	MOGE2_VITS,
	MOGE2_WEIGHTS,
	MogeDepthNet,
} from "./depth-net";
import { liftRecordsCpu } from "./lift";
import {
	cpuPathReadBytes,
	type DepthPhoto,
	estimateDepthGraph,
	planDepthPipeline,
} from "./pipeline-gpu";

const ID = "nearfield-pipeline-gpu";
const device = await dawnDevice(ID);
if (!device) {
	console.log(`SKIP ${ID}: DAWN_DIR not set or no adapter`);
	process.exit(0);
}
const MODELS = path.resolve(import.meta.dirname, "../../../../public/models");
const PHOTOS = path.resolve(
	import.meta.dirname,
	"../../../../public/demo/photos-1024",
);
for (const f of [MOGE2_WEIGHTS.q8, MOGE2_WEIGHTS.q8lite])
	if (!existsSync(path.join(MODELS, f))) {
		console.log(`SKIP ${ID}: ${f} missing`);
		process.exit(0);
	}
const argv = process.argv.slice(2);
const nPhotos = argv.includes("--photos")
	? Number(argv[argv.indexOf("--photos") + 1])
	: 3;
const names = ["demo-01", "demo-04", "demo-07", "demo-10", "demo-12"]
	.filter((n) => existsSync(path.join(PHOTOS, `${n}.jpg`)))
	.slice(0, nPhotos);
if (!names.length) {
	console.log(`SKIP ${ID}: no demo photos`);
	process.exit(0);
}

let failed = 0;
const check = (ok: boolean, msg: string) => {
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};
const median = (a: number[]) => {
	const s = [...a].sort((x, y) => x - y);
	return s[s.length >> 1] ?? Number.NaN;
};
const pct = (a: number[], p: number) => {
	const s = [...a].sort((x, y) => x - y);
	return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? Number.NaN;
};

const nn = new GpuNn(device);
const loadNet = (file: string) =>
	new MogeDepthNet(
		nn,
		nn.weightsFromBytes(new Uint8Array(readFileSync(path.join(MODELS, file)))),
		device,
	);

type Raster = { W: number; H: number; rgba: Uint8Array };
async function decode(name: string, maxSide?: number): Promise<Raster> {
	const img = await loadImage(path.join(PHOTOS, `${name}.jpg`));
	const s = maxSide
		? Math.min(1, maxSide / Math.max(img.width, img.height))
		: 1;
	const W = Math.max(1, Math.round(img.width * s));
	const H = Math.max(1, Math.round(img.height * s));
	const c = createCanvas(W, H);
	const ctx = c.getContext("2d");
	ctx.drawImage(img, 0, 0, W, H);
	return { W, H, rgba: new Uint8Array(ctx.getImageData(0, 0, W, H).data) };
}

const TOKENS = 1200;
const rowsOf = (r: Raster) => {
	const rowBytes = Math.ceil((r.W * 4) / 256) * 256;
	const rows = new Uint8Array(rowBytes * r.H);
	for (let y = 0; y < r.H; y++)
		rows.set(r.rgba.subarray(4 * y * r.W, 4 * (y + 1) * r.W), y * rowBytes);
	return rows;
};

/** NEW: the pipeline from the photo's RGBA. */
function newPath(net: MogeDepthNet, r: Raster) {
	const plan = planDepthPipeline(r.W, r.H, TOKENS);
	const photo: DepthPhoto = {
		width: r.W,
		height: r.H,
		bh: plan.bh,
		bw: plan.bw,
		pixels: { rows: rowsOf(r) },
	};
	if (plan.upsample) {
		// the upsample raster: nearest-neighbour is enough for the parity case (OLD uses the same raster)
		const up = upsampleNearest(r, plan.iw, plan.ih);
		photo.netPixels = { rows: rowsOf(up) };
	}
	return estimateDepthGraph(device as never, net, photo, {
		model: "check",
	});
}

function upsampleNearest(r: Raster, W: number, H: number): Raster {
	const rgba = new Uint8Array(W * H * 4);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const sx = Math.min(r.W - 1, Math.floor((x * r.W) / W));
			const sy = Math.min(r.H - 1, Math.floor((y * r.H) / H));
			rgba.set(
				r.rgba.subarray(4 * (sy * r.W + sx), 4 * (sy * r.W + sx) + 4),
				4 * (y * W + x),
			);
		}
	return { W, H, rgba };
}

/** OLD: CPU planes → net.run → full readbacks → CPU compose → CPU lift records. */
async function oldPath(net: MogeDepthNet, r: Raster) {
	const plan = planDepthPipeline(r.W, r.H, TOKENS);
	let planes: Float32Array;
	if (plan.upsample) {
		const up = upsampleNearest(r, plan.iw, plan.ih);
		planes = rgbPlanes({ width: up.W, height: up.H, data: up.rgba } as never);
	} else
		planes = resamplePlanes(
			rgbPlanes({ width: r.W, height: r.H, data: r.rgba } as never),
			r.W,
			r.H,
			3,
			plan.iw,
			plan.ih,
		);
	const image = nn.fromArray(planes, [1, 3, plan.ih, plan.iw]);
	const out = await net.run(image, r.W / r.H, [r.H, r.W]);
	const [z, mask, normal, points64, mask64, scale] = await Promise.all([
		nn.read(out.z),
		nn.read(out.mask),
		out.normal ? nn.read(out.normal) : null,
		nn.read(out.points64),
		nn.read(out.mask64),
		nn.read(out.metricScale),
	]);
	nn.dispose([image, ...Object.values(out).filter((t) => t !== null)]);
	const depth = composeDepth(
		{
			width: r.W,
			height: r.H,
			z,
			mask,
			normal,
			points64,
			mask64,
			focalGrid: FOCAL_GRID,
			metricScale: scale[0],
		},
		"old",
	);
	const K = depth.intrinsicsNorm as {
		fx: number;
		fy: number;
		cx: number;
		cy: number;
	};
	const lift = liftRecordsCpu({
		width: r.W,
		height: r.H,
		depth: depth.depth,
		valid: depth.valid,
		normal: depth.normal,
		rgba: r.rgba,
		K,
	});
	return {
		depth,
		lift,
		readBytes: cpuPathReadBytes(r.W, r.H, net.hasNormalHead),
	};
}

const angleDeg = (a: Float32Array, b: Float32Array, k: number) => {
	const d =
		a[3 * k] * b[3 * k] +
		a[3 * k + 1] * b[3 * k + 1] +
		a[3 * k + 2] * b[3 * k + 2];
	return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
};

// ---- pos embed: GPU resample vs the CPU reference ----------------------------------------------------
const q8 = loadNet(MOGE2_WEIGHTS.q8);
{
	const M = MOGE2_VITS.posGrid;
	const C = MOGE2_VITS.dim;
	const raw = await nn.read(q8.weights.get("encoder.backbone.pos_embed"));
	for (const [bh, bw] of [
		[30, 40],
		[40, 30],
		[37, 37],
	]) {
		const { pos } = await q8.gridConsts(bh, bw, bw / bh);
		const got = await nn.read(pos);
		const want = interpolatePosEmbed(raw, M, C, bh, bw);
		let max = 0;
		for (let i = 0; i < want.length; i++)
			max = Math.max(max, Math.abs(got[i] - want[i]));
		check(
			got.length === want.length && max < 2e-3,
			`pos embed ${bh}x${bw}: GPU vs CPU max |Δ| ${max.toExponential(2)}`,
		);
	}
}

// ---- photos: OLD vs NEW ------------------------------------------------------------------------------
const rasters: [string, Raster][] = [];
for (const n of names) rasters.push([n, await decode(n, 1024)]);
rasters.push([`${names[0]} small`, await decode(names[0], 320)]);

for (const [name, r] of rasters) {
	const old = await oldPath(q8, r);
	const neu = await newPath(q8, r);
	const n = r.W * r.H;
	const ratios: number[] = [];
	let both = 0;
	let either = 0;
	for (let k = 0; k < n; k++) {
		const a = old.depth.valid[k] === 1;
		const b = neu.depth.valid[k] === 1;
		if (a || b) either++;
		if (a && b) {
			both++;
			ratios.push(Math.abs(neu.depth.depth[k] / old.depth.depth[k] - 1));
		}
	}
	const iou = both / Math.max(1, either);
	const medD = median(ratios);
	const p90D = pct(ratios, 0.9);
	const focal = Math.abs(neu.depth.focal / old.depth.focal - 1);
	const ang: number[] = [];
	for (let k = 0; k < n; k++)
		if (
			old.depth.valid[k] &&
			neu.depth.valid[k] &&
			old.depth.normal &&
			neu.depth.normal
		)
			ang.push(angleDeg(old.depth.normal, neu.depth.normal, k));
	const oldCount = (() => {
		let c = 0;
		for (let i = 0; i < old.lift.grid.cells; i++)
			if (new Uint32Array(old.lift.records.buffer)[i * 12 + 11]) c++;
		return c;
	})();
	const nu = new Uint32Array(
		neu.records.buffer,
		neu.records.byteOffset,
		neu.records.length,
	);
	const ou = new Uint32Array(old.lift.records.buffer);
	let newCount = 0;
	const posRel: number[] = [];
	for (let c = 0; c < neu.cells; c++) {
		if (nu[c * 12 + 11]) newCount++;
		if (nu[c * 12 + 11] && ou[c * 12 + 11]) {
			const o = c * 12;
			const d = Math.hypot(
				neu.records[o] - old.lift.records[o],
				neu.records[o + 1] - old.lift.records[o + 1],
				neu.records[o + 2] - old.lift.records[o + 2],
			);
			posRel.push(
				d /
					Math.hypot(
						old.lift.records[o],
						old.lift.records[o + 1],
						old.lift.records[o + 2],
					),
			);
		}
	}
	console.log(
		`${name} ${r.W}x${r.H}: depth |Δ| median ${(medD * 100).toFixed(3)}% p90 ${(p90D * 100).toFixed(3)}%, valid IoU ${iou.toFixed(4)}, focal ${(focal * 100).toFixed(3)}%, normal ${median(ang).toFixed(3)} deg, splats ${oldCount} -> ${newCount} (${newCount - oldCount}), lift pos ${(median(posRel) * 100).toFixed(3)}%`,
	);
	check(
		medD < 0.005 &&
			iou > 0.99 &&
			focal < 0.005 &&
			median(ang) < 1 &&
			median(posRel) < 0.005,
		`${name}: within tolerance (depth median < 0.5%, IoU > 0.99, focal < 0.5%, normal < 1 deg, lift < 0.5%)`,
	);
	// timing, warm, median of 5
	const tOld: number[] = [];
	const tNew: number[] = [];
	for (let i = 0; i < 5; i++) {
		let t = performance.now();
		await oldPath(q8, r);
		tOld.push(performance.now() - t);
		t = performance.now();
		await newPath(q8, r);
		tNew.push(performance.now() - t);
	}
	console.log(
		`    time (noisy) OLD ${median(tOld).toFixed(0)} ms, NEW ${median(tNew).toFixed(0)} ms; read back OLD ${((old.readBytes + planDepthPipeline(r.W, r.H, TOKENS).recordsBytes) / 1e6).toFixed(2)} MB (incl. the lift records; + re-upload of depth / normal / rgba), NEW ${(neu.readBytes / 1e6).toFixed(2)} MB (of which graph 1: ${(planDepthPipeline(r.W, r.H, TOKENS).graph1ReadBytes / 1e3).toFixed(0)} KB)`,
	);
}

// ---- q8lite: the normals-from-depth kernel vs the CPU reference ------------------------------------
{
	await q8.dispose();
	const lite = loadNet(MOGE2_WEIGHTS.q8lite);
	const [name, r] = rasters[0];
	const neu = await newPath(lite, r);
	const n = r.W * r.H;
	const d = neu.depth;
	const ref = normalsFromDepth(
		d.depth,
		d.valid,
		r.W,
		r.H,
		d.intrinsicsNorm as never,
	);
	const got = d.normal as Float32Array;
	const ang: number[] = [];
	let agree = 0;
	let nonzero = 0;
	for (let k = 0; k < n; k++) {
		const a = Math.hypot(ref[3 * k], ref[3 * k + 1], ref[3 * k + 2]) > 0.5;
		const b = Math.hypot(got[3 * k], got[3 * k + 1], got[3 * k + 2]) > 0.5;
		if (a || b) nonzero++;
		if (a === b) agree += a || b ? 1 : 0;
		if (a && b) ang.push(angleDeg(ref, got, k));
	}
	const agreement = agree / Math.max(1, nonzero);
	console.log(
		`q8lite ${name}: normals-from-depth kernel vs CPU: angle median ${median(ang).toFixed(4)} deg p99 ${pct(ang, 0.99).toFixed(3)} deg, nonzero agreement ${agreement.toFixed(4)}`,
	);
	check(
		median(ang) < 0.1 && agreement > 0.99,
		"q8lite normals-from-depth kernel matches normalsFromDepth",
	);
	await lite.dispose();
}
await releaseCachedGraphs(device);
console.log(failed ? `${failed} failed` : "ok");
process.exit(failed ? 1 : 0);
