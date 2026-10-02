// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Producer for quantized model files (src/lib/nn/quant.ts format) from an fp16 safetensors in
// public/models: smaller downloads, expanded back to f16 at load time on the GPU. Deterministic: the
// same input and preset give the same bytes (sorted tensor names, stable JSON).
//
//   npx tsx scripts/models/quantize.ts --preset moge2-q4 [--in <file>] [--manifest]
//
// Rules per tensor (first match): `keep` stays fp16, `drop` is left out, otherwise matrices and conv
// kernels with >= MIN_NUMEL elements go to int4 in groups of `group` along a row (when the group tiles
// the row) or to int8 with one scale per row. --manifest adds / replaces the output's row in
// scripts/models/manifest.json.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type QuantInfo, quantize } from "../../src/lib/nn/quant";
import {
	encodeSafetensors,
	entryF32,
	parseSafetensors,
	type SafeTensorEntry,
} from "../../src/lib/nn/safetensors";

type Preset = {
	input: string;
	/** output basename before the hash */
	name: string;
	/** int4 for these (regex on the name), int8 for other quantized tensors; none = int8 everywhere */
	int4?: RegExp;
	group: number;
	keep: RegExp;
	drop?: RegExp;
	licence: string;
	source: string;
};

const MOGE_FP16 = "moge2-vits-normal.6d404d23.safetensors";
const MOGE_KEEP =
	/pos_embed|patch_embed|cls_token|mask_token|image_(mean|std)|\.norm\d?\.|\.bias$|gamma$/;
const MOGE_SOURCE = `${MOGE_FP16} (MoGe-2 ViT-S normal, Ruicheng/moge-2-vits-normal @ 26b477f4, MIT; DINOv2-S Apache-2.0)`;
// int4 (round to nearest, groups of 32) was measured and rejected for this network: depth off by 16%
// median even with only the ViT MLPs in int4 (reports/step-inside-download.md). The quant format and
// the `int4` rule stay for models that tolerate it.
const PRESETS: Record<string, Preset> = {
	"moge2-q8": {
		input: MOGE_FP16,
		name: "moge2-vits-q8",
		group: 0,
		keep: MOGE_KEEP,
		licence: "MIT AND Apache-2.0",
		source: `${MOGE_SOURCE}, int8 weights with one scale per row`,
	},
	// without the normal head: compose.ts derives normals from the depth (about 20° from the head's)
	"moge2-q8lite": {
		input: MOGE_FP16,
		name: "moge2-vits-q8lite",
		group: 0,
		keep: MOGE_KEEP,
		drop: /^normal_head\./,
		licence: "MIT AND Apache-2.0",
		source: `${MOGE_SOURCE}, normal head dropped, int8 weights with one scale per row`,
	},
};

const VITPOSE_FP16 = "vitpose-b.71b52d25.safetensors";
// The ViT linears (qkv / proj / fc1 / fc2) go to int8; the patch conv, the head conv, norms, biases and the
// folded pos embed stay fp16 (together about 3 MB; the head conv feeds the heatmaps directly).
const VITPOSE_KEEP = /^patch\.|^head\.|pos_embed|^norm\.|\.ln\d\.|\.bias$/;
PRESETS["vitpose-q8"] = {
	input: VITPOSE_FP16,
	name: "vitpose-b-q8",
	group: 0,
	keep: VITPOSE_KEEP,
	licence: "Apache-2.0",
	source: `${VITPOSE_FP16} (ViTPose-B simple, HF usyd-community/vitpose-base-simple @ a93ac0c6, Apache-2.0; ViTPose code Apache-2.0), int8 weights with one scale per row`,
};

const MIN_NUMEL = 4096;
const ROOT = path.resolve(import.meta.dirname, "../..");
const MODELS = path.join(ROOT, "public/models");

const argv = process.argv.slice(2);
const arg = (k: string) =>
	argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined;
const preset = PRESETS[arg("--preset") ?? ""];
if (!preset) {
	console.error(
		`usage: quantize.ts --preset ${Object.keys(PRESETS).join("|")} [--in file] [--manifest]`,
	);
	process.exit(2);
}
const input = arg("--in") ?? preset.input;
const src = parseSafetensors(readFileSync(path.join(MODELS, input)));

type Out = Parameters<typeof encodeSafetensors>[0];
const tensors: Out = {};
const table: Record<string, QuantInfo> = {};
let fp16Bytes = 0;
let quantBytes = 0;
let dropped = 0;

function keepAsIs(e: SafeTensorEntry) {
	tensors[e.name] = e.half
		? { shape: e.shape, data: e.half, dtype: "F16" }
		: { shape: e.shape, data: entryF32(e), dtype: "F32" };
	fp16Bytes += e.half ? e.half.byteLength : (e.data?.byteLength ?? 0);
}

for (const name of [...src.entries.keys()].sort()) {
	const e = src.entries.get(name) as SafeTensorEntry;
	if (preset.drop?.test(name)) {
		dropped++;
		continue;
	}
	const numel = e.shape.reduce((a, v) => a * v, 1);
	if (preset.keep.test(name) || e.shape.length < 2 || numel < MIN_NUMEL) {
		keepAsIs(e);
		continue;
	}
	const cols = numel / e.shape[0];
	const four = !!preset.int4?.test(name) && cols % preset.group === 0;
	const { q, scale, info } = quantize(
		entryF32(e),
		e.shape,
		four ? 4 : 8,
		four ? preset.group : cols,
	);
	tensors[`${name}.qweight`] = { shape: [q.length], data: q, dtype: "U8" };
	tensors[`${name}.qscale`] = {
		shape: [e.shape[0], scale.length / e.shape[0]],
		data: scale,
		dtype: "F16",
	};
	table[name] = info;
	quantBytes += q.byteLength + scale.byteLength;
}

const metadata = {
	...src.metadata,
	quant: JSON.stringify(table),
	quant_source: input,
};
const bytes = encodeSafetensors(tensors, metadata);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const file = `${preset.name}.${sha256.slice(0, 8)}.safetensors`;
writeFileSync(path.join(MODELS, file), bytes);
const row = {
	file,
	sha256,
	bytes: bytes.byteLength,
	licence: preset.licence,
	source: preset.source,
	producer: `scripts/models/quantize.ts --preset ${arg("--preset")}`,
};
console.log(
	`${file}: ${(bytes.byteLength / 1e6).toFixed(1)} MB (${Object.keys(table).length} quantized ${(quantBytes / 1e6).toFixed(1)} MB, fp16 kept ${(fp16Bytes / 1e6).toFixed(1)} MB, ${dropped} dropped)`,
);
console.log(JSON.stringify(row, null, "\t"));

if (argv.includes("--manifest")) {
	const mpath = path.join(ROOT, "scripts/models/manifest.json");
	const rows = JSON.parse(readFileSync(mpath, "utf8")) as (typeof row)[];
	// replace an earlier output of the same preset, keep everything else in place
	const at = rows.findIndex((r) => r.file.startsWith(`${preset.name}.`));
	if (at >= 0) rows[at] = row;
	else rows.push(row);
	writeFileSync(mpath, `${JSON.stringify(rows, null, "\t")}\n`);
	console.log(`manifest: ${at >= 0 ? "replaced" : "added"} ${file}`);
}
