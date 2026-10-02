// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	emuProbe,
	PROBE_IN,
	PROBE_OUT,
	probeInputs,
	verifyProbe,
} from "../ieee-probe";

describe("ieee probe", () => {
	const pin = probeInputs(256);
	it("inputs are deterministic, finite and sized", () => {
		expect(pin.length).toBe(256 * PROBE_IN);
		expect(probeInputs(256)).toEqual(pin);
		expect(pin.every(Number.isFinite)).toBe(true);
	});
	it("a strict-IEEE device (the emulation itself) passes", () => {
		const out = emuProbe(pin);
		expect(out.length).toBe(256 * PROBE_OUT);
		const v = verifyProbe(pin, out);
		expect(v.n).toBe(256);
		expect(v.failures).toEqual({});
		expect(v.ok).toBe(true);
		expect(v.worst.divUlp).toBeLessThanOrEqual(4);
	});
	it("flags a device whose mul is off by an ULP", () => {
		const out = emuProbe(pin);
		for (let i = 0; i < 256; i += 4) out[i * PROBE_OUT + 1] *= 1 + 2 ** -22;
		const v = verifyProbe(pin, out);
		expect(v.ok).toBe(false);
		expect(v.failures.mul).toBeGreaterThan(0);
	});
	it("flags a division that is far off", () => {
		const out = emuProbe(pin);
		for (let i = 0; i < 256; i++) out[i * PROBE_OUT + 3] *= 1.01;
		expect(verifyProbe(pin, out).failures.div).toBeGreaterThan(0);
	});
});
