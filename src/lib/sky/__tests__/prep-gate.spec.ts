// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU sky prep's per-photo opacity gate (prepGate): a translucent photo always takes the CPU
// path, however many photos were verified before it; an opaque one follows the
// verify-the-first-PREP_VERIFY rule.
import { describe, expect, it } from "vitest";
import { PREP_VERIFY, prepGate } from "../prep";

describe("prepGate", () => {
	const verifiedCounts = [0, 1, PREP_VERIFY - 1, PREP_VERIFY, PREP_VERIFY + 10];
	for (const verified of verifiedCounts)
		for (const hasPixels of [false, true]) {
			it(`verified ${verified}, pixels ${hasPixels}`, () => {
				expect(prepGate(false, verified, hasPixels)).toBe("cpu");
				const due = verified < PREP_VERIFY;
				expect(prepGate(true, verified, hasPixels)).toBe(
					due ? (hasPixels ? "verify" : "need-pixels") : "gpu",
				);
			});
		}
});
