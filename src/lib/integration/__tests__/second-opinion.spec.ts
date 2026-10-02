// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { Pose } from "#/lib/camera";
import {
	AGREE_DEG,
	CASCADE_TIMEOUT_MS,
	choosePreview,
	notVerifiedReason,
	type SecondOpinion,
} from "../second-opinion";

const pose = (yaw: number, pitch = 0): Pose => ({
	yaw,
	pitch,
	roll: 0,
	vfov: 40,
});
const prior = pose(100, 2);
const res = (
	confidence: number,
	alternatives?: { pose: Pose }[],
	p = pose(90),
): Parameters<typeof choosePreview>[0] =>
	({
		pose: p,
		confidence,
		alternatives,
	}) as unknown as Parameters<typeof choosePreview>[0];

describe("choosePreview", () => {
	it("auto-accepts a skyline alignment above the 0.2 bar", () => {
		const out = choosePreview(res(0.6), prior);
		expect(out.app.state).toBe("auto");
		expect(out.app.pose.yaw).toBe(90);
		expect(out.app.confidence).toBe(0.6);
		expect(out.note).toContain("60%");
	});
	it("does not accept at exactly 0.2", () => {
		expect(choosePreview(res(0.2), prior).app.state).toBe("prior");
	});
	it("falls back to a near-compass alternative inside the 4 deg / 1.5 deg window", () => {
		const alt = { pose: pose(102, 2.5) };
		const out = choosePreview(res(0.1, [{ pose: pose(120) }, alt]), prior);
		expect(out.app.state).toBe("near-compass");
		expect(out.app.pose).toBe(alt.pose);
		expect(out.app.confidence).toBe(0.1);
	});
	it("uses strict (exclusive) window edges", () => {
		expect(
			choosePreview(res(0.1, [{ pose: pose(104, 2) }]), prior).app.state,
		).toBe("prior");
		expect(
			choosePreview(res(0.1, [{ pose: pose(100, 3.5) }]), prior).app.state,
		).toBe("prior");
	});
	it("a confident result beats a near-compass alternative", () => {
		expect(
			choosePreview(res(0.9, [{ pose: pose(100, 2) }]), prior).app.state,
		).toBe("auto");
	});
	it("uses the compass/gravity prior with no result at all", () => {
		const out = choosePreview(null, prior);
		expect(out.app).toEqual({ pose: prior, confidence: null, state: "prior" });
		expect(out.note).toMatch(/compass/i);
	});
	it("never marks the weak fallbacks as auto", () => {
		for (const r of [null, res(0.05), res(0.1, [])])
			expect(choosePreview(r, prior).app.state).not.toBe("auto");
	});
});

describe("constants", () => {
	it("keep the documented values", () => {
		expect(AGREE_DEG).toBe(1);
		expect(CASCADE_TIMEOUT_MS).toBe(20_000);
	});
});

describe("notVerifiedReason", () => {
	const casc = {
		confidence: 0.1,
		accepted: false,
		stage: "solve",
		ms: 1,
		yaw: 0,
	};
	const ask = (
		verdict: SecondOpinion["verdict"],
		cascade: SecondOpinion["cascade"] = casc as unknown as SecondOpinion["cascade"],
	) => notVerifiedReason({ verdict, cascade });
	it("is null for verdicts that verify or carry their own note", () => {
		for (const v of ["verified", "refined", "matched", "unverified"] as const)
			expect(ask(v)).toBeNull();
	});
	it("explains kept with a cascade", () => {
		expect(ask("kept")).toBe(
			"not verified: the skyline cascade could not confirm it",
		);
	});
	it("explains kept after a cascade error", () => {
		expect(ask("kept", null)).toBe("not verified: the skyline check failed");
	});
	it("explains timeout", () => {
		expect(ask("timeout", null)).toBe(
			"not verified: the skyline check timed out",
		);
	});
});
