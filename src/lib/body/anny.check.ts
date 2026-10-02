// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The TypeScript Anny evaluator (./anny.ts) against scripts/models/anny.py --dump-ref: a random shape + pose posed
// by (a) the producer's numpy twin of anny.ts on the baked data and (b) Anny's own LBS on the full 104-bone rig and the
// exact (non-linearised) phenotype mesh, written to out/body/anny-ref/.
//
//   npx tsx src/lib/body/anny.check.ts
//
// Tolerances: (a) ≤ 0.05 mm (same data, f64 vs f64); (b) mean ≤ 3 mm, max ≤ 10 mm (the linear shape basis and the
// rig reduction, measured by the producer). SKIP (exit 0) without the weights or the reference.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { entryF32, parseSafetensors } from "#/lib/nn/safetensors";
import { ANNY_FILE, annyFromBytes, evaluateBody } from "./anny";

const skip = (why: string) => {
	console.log(`SKIP anny: ${why}`);
	process.exit(0);
};
const weights = path.join("public/models", ANNY_FILE);
if (!existsSync(weights)) skip(`${weights} missing`);
const refFile = "out/body/anny-ref/ref.safetensors";
if (!existsSync(refFile))
	skip(
		`${refFile} missing (python scripts/models/anny.py --dump-ref out/body/anny-ref)`,
	);

const model = annyFromBytes(new Uint8Array(readFileSync(weights)));
const ref = parseSafetensors(new Uint8Array(readFileSync(refFile)));
const arr = (n: string) => {
	const e = ref.entries.get(n);
	if (!e) throw new Error(`reference: missing ${n}`);
	return entryF32(e);
};
const t0 = performance.now();
const posed = evaluateBody(model, arr("beta"), arr("pose"));
const ms = performance.now() - t0;
const dist = (a: ArrayLike<number>) => {
	let max = 0;
	let sum = 0;
	const n = a.length / 3;
	for (let i = 0; i < n; i++) {
		const d = Math.hypot(
			posed.vertices[3 * i] - a[3 * i],
			posed.vertices[3 * i + 1] - a[3 * i + 1],
			posed.vertices[3 * i + 2] - a[3 * i + 2],
		);
		max = Math.max(max, d);
		sum += d;
	}
	return { max: max * 1000, mean: (sum / n) * 1000 };
};
let failed = 0;
const twin = dist(arr("reduced.vertices"));
const okTwin = twin.max <= 0.05;
if (!okTwin) failed++;
console.log(
	`${okTwin ? "ok  " : "FAIL"} vs numpy twin   max ${twin.max.toFixed(4)} mm, mean ${twin.mean.toFixed(4)} mm`,
);
const anny = dist(arr("anny.vertices"));
const okAnny = anny.mean <= 3 && anny.max <= 10;
if (!okAnny) failed++;
console.log(
	`${okAnny ? "ok  " : "FAIL"} vs Anny full rig max ${anny.max.toFixed(2)} mm, mean ${anny.mean.toFixed(2)} mm`,
);
console.log(
	`${model.vertexCount} vertices, ${model.faces.length / 3} faces, ${model.jointCount} joints; evaluate ${ms.toFixed(2)} ms`,
);
console.log(failed ? `${failed} failed` : "ok");
process.exit(failed ? 1 : 0);
