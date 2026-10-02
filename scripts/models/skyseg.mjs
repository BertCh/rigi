#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Producer for skyseg-u2netp.<hash>.onnx: downloads the MIT U²-Net-P ncnn weights at a pinned commit
// of xiongzhu666/Sky-Segmentation-and-Post-processing and converts them with
// src/lib/sky/tools/ncnn2onnx.py (needs a Python with onnx + numpy; see README.md). Reproducible:
// the output sha256 is 873ea284….
//   node scripts/models/skyseg.mjs <out.onnx>

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { download, python, ROOT, run, sha256File } from "./lib.mjs";

const COMMIT = "1f7811b32b64ddc957269defff84bc87a3f0b74f";
const BASE = `https://raw.githubusercontent.com/xiongzhu666/Sky-Segmentation-and-Post-processing/${COMMIT}`;
const INPUTS = {
	"skysegsmall_sim-opt-fp16.param":
		"7af3523130445db42d94503558c08ce991932f843b92e4e921c99d732768895e",
	"skysegsmall_sim-opt-fp16.bin":
		"ff1e18f71dc0a0cf8a56b634c59f68d296deffd015cbed27a6d5e302f991faf2",
};

const out = process.argv[2];
if (!out) {
	console.error("usage: node scripts/models/skyseg.mjs <out.onnx>");
	process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), "rigi-skyseg-"));
try {
	for (const [name, sha] of Object.entries(INPUTS)) {
		await download(`${BASE}/${name}`, join(dir, name));
		const got = await sha256File(join(dir, name));
		if (got !== sha) throw new Error(`${name}: sha256 ${got} != ${sha}`);
	}
	run(python(), [
		join(ROOT, "src/lib/sky/tools/ncnn2onnx.py"),
		...Object.keys(INPUTS).map((n) => join(dir, n)),
		out,
	]);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
