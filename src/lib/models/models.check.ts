// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Model weights on disk (public/models, gitignored): every manifest row that is present verifies
// (size + sha256 through verifyModel), and the sky model (src/lib/sky on src/lib/nn, CPU backend) runs end
// to end in node. Rows that are missing are reported as SKIP (fetch them with scripts/models/fetch.mjs).
//   npx tsx src/lib/models/models.check.ts

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import MANIFEST from "../../../scripts/models/manifest.json";
import { createSkyModel, runSkyModel } from "../sky/model";
import { type ModelEntry, verifyModel } from "./index";

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

const SKY = "skyseg-u2netp-nn.884ee489.safetensors";
if (existsSync(join(dir, SKY))) {
	const model = await createSkyModel({ backends: ["cpu"] });
	const [h, w] = [64, 96];
	const out = await runSkyModel(model, new Float32Array(3 * h * w), w, h, 96);
	const finite = out.prob.every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
	const shapeOk = out.width === w && out.height === h;
	console.log(
		`${shapeOk && finite ? "ok   " : "FAIL "} sky model (${SKY}) on nn ${model.backend}: output ${out.height}x${out.width}, P in [0,1]: ${finite}`,
	);
	if (!(shapeOk && finite)) failed++;
	model.dispose();
} else console.log(`SKIP  sky model (${SKY}) (missing)`);

console.log(
	failed
		? `models: FAIL (${failed})`
		: `models: PASS (${present}/${MANIFEST.length} present)`,
);
process.exit(failed ? 1 : 0);
