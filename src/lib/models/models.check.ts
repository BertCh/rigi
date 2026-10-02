// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Model weights on disk (public/models, gitignored): every manifest row that is present verifies
// (size + sha256 through verifyModel), and createOrtSession runs the sky model end to end in node
// (WASM/CPU). Rows that are missing are reported as SKIP (fetch them with scripts/models/fetch.mjs).
//   npx tsx src/lib/models/models.check.ts

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as ort from "onnxruntime-web";
import MANIFEST from "../../../scripts/models/manifest.json";
import { createOrtSession, type ModelEntry, verifyModel } from "./index";

const dir = process.env.RIGI_MODELS_DIR ?? join(process.cwd(), "public/models");
let failed = 0;
let present = 0;
for (const row of MANIFEST as ModelEntry[]) {
	const path = join(dir, row.file);
	if (!existsSync(path)) {
		console.log(`SKIP  ${row.file} (missing; node scripts/models/fetch.mjs)`);
		continue;
	}
	present++;
	const size = statSync(path).size;
	try {
		if (size !== row.bytes) throw new Error(`size ${size} != ${row.bytes}`);
		const b = readFileSync(path);
		await verifyModel(
			row.file,
			b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
		);
		console.log(`ok    ${row.file} (${row.licence})`);
	} catch (e) {
		console.log(`FAIL  ${row.file}: ${e instanceof Error ? e.message : e}`);
		failed++;
	}
}

const SKY = "skyseg-u2netp.873ea284.onnx";
if (existsSync(join(dir, SKY))) {
	ort.env.logLevel = "error";
	const { session, backend } = await createOrtSession(SKY);
	const [h, w] = [64, 96];
	const input = new ort.Tensor("float32", new Float32Array(3 * h * w), [
		1,
		3,
		h,
		w,
	]);
	const out = (await session.run({ [session.inputNames[0]]: input }))[
		session.outputNames[0]
	];
	const data = out.data as Float32Array;
	const finite = data.every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
	const shapeOk = out.dims.at(-1) === w && out.dims.at(-2) === h;
	console.log(
		`${shapeOk && finite ? "ok   " : "FAIL "} createOrtSession(${SKY}) on ${backend}: output [${out.dims.join(",")}], P in [0,1]: ${finite}`,
	);
	if (!(shapeOk && finite)) failed++;
	await session.release();
} else console.log(`SKIP  createOrtSession(${SKY}) (missing)`);

console.log(
	failed
		? `models: FAIL (${failed})`
		: `models: PASS (${present}/${MANIFEST.length} present)`,
);
process.exit(failed ? 1 : 0);
