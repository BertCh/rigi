// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// ViTPose-B int8 download (VITPOSE_WEIGHTS q8) against the fp16 checkpoint on real person crops, over Dawn in
// node (src/lib/nn GPU backend). Both weights run on the same 192 x 256 crops; per keypoint it reports the
// decoded position difference in the network input frame (median / p90 / max), the heatmap peak change and the
// fraction of keypoints whose argmax cell moved. Keypoints are also split by the fp16 peak (>= --conf, default
// 0.3): low-peak keypoints (occluded, out of frame) are noise in both files.
//
// Inputs are pre-decoded so node needs no JPEG decoder: `--dir` holds index.json
// ([{ name, W, H, boxes: [[x, y, w, h] ...] }], COCO pixel boxes) and <name>.rgb (RGB8 at W x H), e.g. made with
// PIL from public/demo/photos-1024 and public/photos with hand-picked person boxes.
//   DAWN_DIR=/tmp/dawn npx tsx scripts/body/vitpose-weights-eval.ts --dir <dir> [--weights q8] [--json out.json]

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	compareHeatmaps,
	type KeypointDiff,
	summarizeParity,
} from "../../src/lib/body/keypoint-parity";
import {
	COCO17,
	cropPerson,
	cropWindow,
	VITPOSE_B,
	VITPOSE_WEIGHTS,
	VitPose,
	type VitPoseWeights,
} from "../../src/lib/body/vitpose";
import { GpuNn } from "../../src/lib/nn/gpu/gpu-nn";
import { dawnDevice } from "../nn/dawn";

const argv = process.argv.slice(2);
const arg = (k: string) =>
	argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined;
const dir = arg("--dir");
if (!dir) {
	console.error(
		"usage: vitpose-weights-eval.ts --dir <dir> [--weights q8] [--conf 0.3] [--json out.json]",
	);
	process.exit(2);
}
const variant = (arg("--weights") ?? "q8") as VitPoseWeights;
const conf = Number(arg("--conf") ?? 0.3);
const device = await dawnDevice("vitpose-weights-eval");
if (!device) {
	console.log("SKIP vitpose-weights-eval: DAWN_DIR not set or no adapter");
	process.exit(0);
}
const MODELS = path.resolve(import.meta.dirname, "../../public/models");
type Photo = {
	name: string;
	W: number;
	H: number;
	boxes: [number, number, number, number][];
};
const photos = JSON.parse(
	readFileSync(path.join(dir, "index.json"), "utf8"),
) as Photo[];

const nn = new GpuNn(device);
const load = (file: string) =>
	new VitPose(
		nn,
		nn.weightsFromBytes(new Uint8Array(readFileSync(path.join(MODELS, file)))),
	);
const reference = load(VITPOSE_WEIGHTS.fp16);
const candidate = load(VITPOSE_WEIGHTS[variant]);
const [IH, IW] = VITPOSE_B.input;
const K = COCO17.length;

const all: KeypointDiff[] = [];
const perKeypoint: KeypointDiff[][] = COCO17.map(() => []);
let persons = 0;
for (const p of photos) {
	const rgb = new Uint8Array(readFileSync(path.join(dir, `${p.name}.rgb`)));
	const image = { width: p.W, height: p.H, data: rgb, channels: 3 as const };
	for (const box of p.boxes) {
		const win = cropWindow(box[0], box[1], box[2], box[3]);
		const crop = cropPerson(image, win);
		const heat = async (net: VitPose) => {
			const x = nn.fromArray(crop, [1, 3, IH, IW]);
			const hm = await nn.forward(() => net.network(x));
			const out = await nn.read(hm);
			nn.dispose([hm, x]);
			return out;
		};
		const diffs = compareHeatmaps(
			await heat(reference),
			await heat(candidate),
			K,
		);
		persons++;
		diffs.forEach((d, k) => {
			all.push(d);
			perKeypoint[k].push(d);
		});
		const s = summarizeParity(diffs);
		console.log(
			`${p.name} box ${box.map((v) => Math.round(v)).join(",")}: med ${s.errMedian.toFixed(2)} p90 ${s.errP90.toFixed(2)} max ${s.errMax.toFixed(2)} px, moved ${(100 * s.argmaxMovedFraction).toFixed(0)}%`,
		);
	}
}

const f = (v: number, d = 2) => v.toFixed(d);
const line = (label: string, s: ReturnType<typeof summarizeParity>) =>
	`${label}: n ${s.count}, input-px error med ${f(s.errMedian)} p90 ${f(s.errP90)} max ${f(s.errMax)}, peak change med ${f(s.scoreDeltaMedian, 3)} max ${f(s.scoreDeltaMax, 3)}, argmax moved ${f(100 * s.argmaxMovedFraction, 1)}%`;
console.log(
	`\n${variant} vs fp16 over ${persons} person crops (${photos.length} photos)`,
);
const confident = all.filter((d) => d.scoreA >= conf);
console.log(line("all keypoints", summarizeParity(all)));
console.log(line(`fp16 peak >= ${conf}`, summarizeParity(confident)));
console.log(
	line(
		`fp16 peak < ${conf}`,
		summarizeParity(all.filter((d) => d.scoreA < conf)),
	),
);
for (const [k, name] of COCO17.entries())
	console.log(line(`  ${name.padEnd(13)}`, summarizeParity(perKeypoint[k])));
if (arg("--json"))
	writeFileSync(
		arg("--json") as string,
		JSON.stringify({
			variant,
			persons,
			all: summarizeParity(all),
			confident: summarizeParity(confident),
		}),
	);
process.exit(0);
