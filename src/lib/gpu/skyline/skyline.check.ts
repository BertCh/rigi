// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check (no GPU): detectSkylineWith with CPU stages is identical to detectSkyline (the stage split
// the GPU path plugs into), the per-row polynomial table of the GPU model kernel evaluates to the CPU's
// modelSky polynomial, and detectSkylineAsync falls back to the CPU result when ?skylineGpu is off.
import { setFlagOverride } from "#/lib/flags";
import {
	computeFeatures,
	detectSkyline,
	detectSkylineAsync,
	detectSkylineWith,
	type Features,
	fitSkyModel,
	heuristicSky,
	modelSky,
} from "#/lib/geo/skyline";
import { skylineModelRows } from "./index";

const w = 160;
const h = 120;
const data = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++)
	for (let x = 0; x < w; x++) {
		const ridge = 70 + 12 * Math.sin(x / 11) + 0.2 * x;
		const o = 4 * (y * w + x);
		if (y < ridge) {
			data[o] = 110 + y * 0.4;
			data[o + 1] = 160 + y * 0.3;
			data[o + 2] = 235;
		} else {
			data[o] = 60 + ((x * 7 + y * 13) % 17);
			data[o + 1] = 70 + ((x * 5 + y * 3) % 11);
			data[o + 2] = 50;
		}
		data[o + 3] = 255;
	}
const img = { width: w, height: h, data };

let failures = 0;
const expect = (ok: boolean, what: string) => {
	if (!ok) {
		failures++;
		console.error(`FAIL ${what}`);
	}
};
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
	return true;
};

const ref = detectSkyline(img);
expect(
	[...ref.rows].filter(Number.isFinite).length > w / 2,
	"synthetic ridge is found",
);

let cachedFeatures: ReturnType<typeof computeFeatures> | undefined;
let cachedPrior: Float32Array | undefined;
const viaStages = await detectSkylineWith(
	img,
	{},
	{
		features: async (i) => {
			cachedFeatures = computeFeatures(i);
			cachedPrior = heuristicSky(cachedFeatures, w * h);
			return { f: cachedFeatures, prior: cachedPrior };
		},
		modelSky: async (m) => modelSky(cachedFeatures as Features, w, h, m),
	},
);
expect(same(ref.rows, viaStages.rows), "stage split: rows identical");
expect(same(ref.weight, viaStages.weight), "stage split: weight identical");
expect(
	!!viaStages.sky && same(ref.sky ?? [], viaStages.sky),
	"stage split: sky identical",
);

// the GPU kernel's per-row table reproduces the CPU modelSky polynomial
const f = computeFeatures(img);
const prior = heuristicSky(f, w * h);
const model = fitSkyModel(f, w, h, (_x, y, i) => prior[i] * (1 - y / h) ** 6);
expect(!!model, "sky model fits");
if (model) {
	const table = skylineModelRows(model, h);
	let worst = 0;
	for (let y = 0; y < h; y += 7)
		for (let x = 0; x < w; x += 9) {
			const u = x / w - 0.5;
			const v = y / h - 0.5;
			for (let c = 0; c < 3; c++) {
				const k = model.coef[c];
				const exact =
					k[0] +
					k[1] * u +
					k[2] * v +
					k[3] * u * u +
					k[4] * u * v +
					k[5] * v * v +
					k[6] * v ** 3 +
					k[7] * u * v * v;
				const o = y * 9 + c * 3;
				const viaTable = table[o] + u * (table[o + 1] + u * table[o + 2]);
				worst = Math.max(worst, Math.abs(exact - viaTable));
			}
		}
	expect(worst < 1e-5, `row table vs basis polynomial (max ${worst})`);
}

// flag pinned off: the async detector is the CPU detector
setFlagOverride("skylineGpu", "off");
const viaAsync = await detectSkylineAsync(img);
expect(
	same(ref.rows, viaAsync.rows),
	"detectSkylineAsync (flag off) = detectSkyline",
);

if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("skyline stage-split check ok");
