// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Parity / speed bench for the GPU sky refine (refine.ts) against the CPU refine (sky/core.ts
// refineToWorking + toBytes), run in the page realm by scripts/gpu/sky-bench.mjs. It mirrors the sky
// worker: U²-Net-P runs on the luma compute device (nn graph) with its
// output left on the GPU, and the GPU refine reads that buffer; the CPU refine gets the same P(sky)
// downloaded. Extra cases exercise the other resample branches: the classical fallback's low-res
// P(sky) (640 px, uploaded floats) and a 512 px working image under a 640 px model (area-average
// downsample instead of bilinear upsample).
import { getComputeDevice } from "#/lib/gpu/device";
import {
	classicalSky,
	type ModelRun,
	refineToWorking,
	resamplePlanes,
	rgbPlanes,
	toBytes,
	workingSize,
} from "#/lib/sky/core";
import { createSkyModel, inferSkyModel } from "#/lib/sky/model";
import { refineSkyGpu, type SkyProb, warmSkyKernels } from "./refine";

type Diff = {
	maxAbs: number;
	p99: number;
	over1e5: number;
	bytesDiff: number;
	bytesMax: number;
};

function diff(
	q: Float32Array,
	ref: Float32Array,
	b: Uint8Array,
	refB: Uint8Array,
): Diff {
	const d = new Float32Array(q.length);
	let maxAbs = 0;
	let over1e5 = 0;
	for (let i = 0; i < q.length; i++) {
		d[i] = Math.abs(q[i] - ref[i]);
		if (!(d[i] <= maxAbs)) maxAbs = d[i];
		if (d[i] > 1e-5) over1e5++;
	}
	d.sort();
	let bytesDiff = 0;
	let bytesMax = 0;
	for (let i = 0; i < b.length; i++) {
		const e = Math.abs(b[i] - refB[i]);
		if (e) bytesDiff++;
		if (e > bytesMax) bytesMax = e;
	}
	return {
		maxAbs,
		p99: d[Math.floor(0.99 * (d.length - 1))],
		over1e5,
		bytesDiff,
		bytesMax,
	};
}

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

async function rasterise(name: string, longSide: number) {
	const img = new Image();
	img.src = `/photos/${name}.jpg`;
	await img.decode();
	const { width: W, height: H } = workingSize(
		img.naturalWidth,
		img.naturalHeight,
		longSide,
	);
	const c = new OffscreenCanvas(W, H);
	const ctx = c.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("no 2d context");
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(img, 0, 0, W, H);
	return { W, H, rgba: new Uint8Array(ctx.getImageData(0, 0, W, H).data) };
}

export async function runSkyBench(names: string[], reps = 3) {
	const device = await getComputeDevice();
	if (!device) return { error: "no compute device" };
	await warmSkyKernels(device);
	const model = await createSkyModel({ device, backends: ["webgpu"] });
	const out = {
		device: {
			shared: model.device === device,
			features: [...device.features].filter((f) => !f.includes("-texture-")),
		},
		photos: [] as unknown[],
		extra: [] as unknown[],
	};

	// GPU and CPU refine of one low-res P(sky); gpuProb is what the GPU reads (the model's buffer or floats)
	const compare = async (
		W: number,
		H: number,
		rgba: Uint8Array,
		low: ModelRun,
		guideLo: Float32Array,
		gpuProb: SkyProb,
	) => {
		const rgb = rgbPlanes({ width: W, height: H, data: rgba });
		const input = {
			W,
			H,
			rgba,
			lw: low.width,
			lh: low.height,
			guideLo,
			prob: gpuProb,
		};
		const g = await refineSkyGpu(device, { ...input, floats: true });
		const cq = refineToWorking(rgb, W, H, low, true);
		return diff(g.q as Float32Array, cq, g.bytes, toBytes(cq));
	};

	for (const name of names) {
		const { W, H, rgba } = await rasterise(name, 1024);
		const rgb = rgbPlanes({ width: W, height: H, data: rgba });
		const ms = {
			model: [] as number[],
			gpuRefine: [] as number[],
			gpuRefineFloat: [] as number[],
			download: [] as number[],
			cpuRefine: [] as number[],
		};
		let d: Diff | undefined;
		let lo = "";
		let sameUpload = true;
		for (let r = 0; r < reps; r++) {
			let t = performance.now();
			const inf = await inferSkyModel(model, rgb, W, H);
			ms.model.push(performance.now() - t);
			lo = `${inf.width}x${inf.height}${inf.gpuBuffer ? " gpu-buffer" : " cpu"}`;
			try {
				const input = {
					W,
					H,
					rgba,
					lw: inf.width,
					lh: inf.height,
					guideLo: inf.rgbLo,
					prob: inf.gpuBuffer ?? (await inf.download()),
				};
				t = performance.now();
				const g = await refineSkyGpu(device, input);
				ms.gpuRefine.push(performance.now() - t);
				t = performance.now();
				const gf = await refineSkyGpu(device, { ...input, floats: true });
				ms.gpuRefineFloat.push(performance.now() - t);
				t = performance.now();
				const prob = await inf.download();
				ms.download.push(performance.now() - t);
				const low = { prob, width: inf.width, height: inf.height };
				t = performance.now();
				const cq = refineToWorking(rgb, W, H, low, true);
				const cb = toBytes(cq);
				ms.cpuRefine.push(performance.now() - t);
				d = diff(gf.q as Float32Array, cq, g.bytes, cb);
				// the same P(sky) uploaded from the CPU gives the same bytes as the model's buffer
				const gu = await refineSkyGpu(device, { ...input, prob });
				for (let i = 0; i < gu.bytes.length; i++)
					if (gu.bytes[i] !== g.bytes[i]) {
						sameUpload = false;
						break;
					}
			} finally {
				inf.release();
			}
		}
		out.photos.push({
			name,
			size: `${W}x${H}`,
			lo,
			...(d as Diff),
			sameAsUploadedProb: sameUpload,
			ms: Object.fromEntries(
				Object.entries(ms).map(([k, v]) => [k, med(v)]),
			) as Record<keyof typeof ms, number>,
		});
	}

	// other resample branches, on the first photo
	{
		const { W, H, rgba } = await rasterise(names[0], 1024);
		const rgb = rgbPlanes({ width: W, height: H, data: rgba });
		const low = classicalSky(rgb, W, H);
		const guideLo = resamplePlanes(rgb, W, H, 3, low.width, low.height);
		out.extra.push({
			case: `classical fallback ${low.width}x${low.height} → ${W}x${H}`,
			...(await compare(W, H, rgba, low, guideLo, low.prob)),
		});
	}
	{
		const { W, H, rgba } = await rasterise(names[0], 512);
		const rgb = rgbPlanes({ width: W, height: H, data: rgba });
		const inf = await inferSkyModel(model, rgb, W, H, 640);
		try {
			const prob = await inf.download();
			const low = { prob, width: inf.width, height: inf.height };
			out.extra.push({
				case: `model ${inf.width}x${inf.height} → ${W}x${H} (downsample)`,
				...(await compare(W, H, rgba, low, inf.rgbLo, inf.gpuBuffer ?? prob)),
			});
		} finally {
			inf.release();
		}
	}
	return out;
}
