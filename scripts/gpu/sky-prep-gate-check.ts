// Node test of the GPU sky prep's per-photo opacity gate decision (src/lib/sky/prep.ts prepGate).
//
//   npx tsx scripts/gpu/sky-prep-gate-check.ts
//
// A translucent photo always takes the CPU path, however many photos were verified before it; an
// opaque one follows the verify-the-first-PREP_VERIFY rule. Exit 1 on any failure.
import assert from "node:assert/strict";
import { PREP_VERIFY, prepGate } from "../../src/lib/sky/prep";

for (const verified of [0, 1, PREP_VERIFY - 1, PREP_VERIFY, PREP_VERIFY + 10])
	for (const hasPixels of [false, true]) {
		assert.equal(prepGate(false, verified, hasPixels), "cpu");
		const due = verified < PREP_VERIFY;
		assert.equal(
			prepGate(true, verified, hasPixels),
			due ? (hasPixels ? "verify" : "need-pixels") : "gpu",
		);
	}
console.log("sky-prep-gate-check: ok");
