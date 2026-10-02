// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	canShare,
	decodeShare,
	encodeShare,
	SHARE_REASON_LOCAL,
	SHARE_REASON_STATE,
	type SharePayload,
	shareUrl,
} from "../index";

const payload = (over: Partial<SharePayload["pose"]> = {}): SharePayload => ({
	v: 1,
	photo: { kind: "demo", id: "demo-09" },
	pose: { yaw: 123.456, pitch: -3.21, roll: 0.5, vfov: 48.2, ...over },
	state: "accepted",
});

describe("share codes", () => {
	it("round-trips a payload with angles rounded to 0.01", () => {
		const code = encodeShare(payload());
		expect(code).toBe("1~demo-09~123.46~-3.21~0.5~48.2~accepted");
		expect(decodeShare(code)).toEqual({
			...payload(),
			pose: { yaw: 123.46, pitch: -3.21, roll: 0.5, vfov: 48.2 },
		});
	});

	it("is URL-safe", () => {
		const code = encodeShare(payload({ pitch: -89.999, roll: -0.004 }));
		expect(encodeURIComponent(code)).toBe(code);
		expect(code).not.toContain("-0~");
	});

	it("wraps yaw into [0, 360)", () => {
		expect(decodeShare(encodeShare(payload({ yaw: -10 })))?.pose.yaw).toBe(350);
		expect(decodeShare(encodeShare(payload({ yaw: 359.999 })))?.pose.yaw).toBe(
			0,
		);
		expect(decodeShare(encodeShare(payload({ yaw: 720.25 })))?.pose.yaw).toBe(
			0.25,
		);
	});

	it("keeps every shareable state", () => {
		for (const state of ["accepted", "manual", "pinned", "saved"] as const)
			expect(decodeShare(encodeShare({ ...payload(), state }))?.state).toBe(
				state,
			);
	});

	it("refuses to encode an invalid pose", () => {
		expect(() => encodeShare(payload({ vfov: 200 }))).toThrow();
		expect(() => encodeShare(payload({ yaw: Number.NaN }))).toThrow();
	});

	it.each([
		["", "empty"],
		["2~demo-09~1~2~3~40~accepted", "unknown version"],
		["1~local-abc~1~2~3~40~accepted", "non-demo photo"],
		["1~demo-9~1~2~3~40~accepted", "bad id"],
		["1~demo-09~1~2~3~40~prior", "non-endorsed state"],
		["1~demo-09~1~2~3~40~unverified", "non-endorsed state"],
		["1~demo-09~1~95~3~40~accepted", "pitch out of range"],
		["1~demo-09~1~2~-91~40~accepted", "roll out of range"],
		["1~demo-09~1~2~3~0.5~accepted", "vfov too small"],
		["1~demo-09~1~2~3~170~accepted", "vfov too large"],
		["1~demo-09~1e3~2~3~40~accepted", "exponent"],
		["1~demo-09~Infinity~2~3~40~accepted", "non-finite"],
		["1~demo-09~1~2~3~accepted", "too few fields"],
		["1~demo-09~1~2~3~40~accepted~x", "too many fields"],
		["%E0%A4%A", "malformed escape"],
		["x".repeat(200), "too long"],
	])("rejects %s (%s)", (code) => {
		expect(decodeShare(code)).toBeNull();
	});

	it("rejects non-strings", () => {
		expect(decodeShare(null)).toBeNull();
		expect(decodeShare(undefined)).toBeNull();
	});

	it("decodes a percent-encoded code", () => {
		expect(
			decodeShare("1%7Edemo-01%7E10%7E0%7E0%7E50%7Emanual")?.photo.id,
		).toBe("demo-01");
	});

	it("builds the gated read-only URL", () => {
		expect(shareUrl("https://rigi.example/", payload())).toBe(
			"https://rigi.example/s/1~demo-09~123.46~-3.21~0.5~48.2~accepted?share=on",
		);
	});
});

describe("canShare", () => {
	it("allows a demo photo with an endorsed state", () => {
		expect(canShare("demo-03", "accepted")).toEqual({ ok: true });
		expect(canShare("demo-03", "manual")).toEqual({ ok: true });
	});
	it("refuses uploads, which only live on the sender's device", () => {
		expect(canShare("local-7463c51f2d", "accepted")).toEqual({
			ok: false,
			reason: SHARE_REASON_LOCAL,
		});
	});
	it("refuses candidate and failed states", () => {
		for (const s of ["prior", "unverified", "near-compass", null] as const)
			expect(canShare("demo-03", s)).toEqual({
				ok: false,
				reason: SHARE_REASON_STATE,
			});
	});
});
