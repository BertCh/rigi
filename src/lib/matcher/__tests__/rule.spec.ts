// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	baseline,
	confidence,
	dang,
	FROZEN_RULE_SHA1,
	RULE_ID,
	select,
	type T6Candidate,
	type T6Record,
	type VerifiedCandidate,
	veto,
} from "../rule";

const pose = (yaw = 100, pitch = 0) => ({ yaw, pitch, roll: 0, vfov: 20 });

type Opts = {
	yaw?: number;
	pitch?: number;
	support?: number | null;
	inliers?: number;
	cueAgree?: number | null;
	sky?: number | null;
	gap?: number | null;
	gapError?: string;
	matchPose?: ReturnType<typeof pose> | null;
	alsoFrom?: string[];
};

function cand(source: string, o: Opts = {}): T6Candidate {
	return {
		source,
		alsoFrom: o.alsoFrom,
		pose: pose(),
		fused: {
			pose: pose(o.yaw ?? 100, o.pitch ?? 0),
			checks: {
				cueAgreeDeg: o.cueAgree ?? null,
				skylineMedPx: o.sky ?? null,
				matchSupport: o.support ?? null,
			},
			inliers: o.inliers,
			cues: { match: o.matchPose ? { pose: o.matchPose } : null },
			basinGap:
				o.gap === undefined && !o.gapError
					? null
					: { gap: o.gap ?? null, error: o.gapError },
		},
	};
}

const aprioriOpts: Opts = {
	cueAgree: 0.5,
	sky: 2,
	support: 0.4,
	inliers: 10,
	gap: 0.5,
};
const rec = (
	candidates: T6Candidate[],
	extra: Partial<T6Record> = {},
): T6Record => ({
	positionSource: "dem-snap",
	baselineSeed: "narrow",
	candidates,
	...extra,
});
const sel = (r: T6Record) => select(r) as VerifiedCandidate;

describe("t6 rule", () => {
	it("exports the frozen ids", () => {
		expect(RULE_ID).toBe("t6-rule-v1");
		expect(FROZEN_RULE_SHA1).toMatch(/^[0-9a-f]{40}$/);
	});

	it("dang uses floored modulo", () => {
		expect(dang(10, 350)).toBeCloseTo(20);
		expect(dang(350, 10)).toBeCloseTo(-20);
		expect(dang(0, 180)).toBeCloseTo(-180);
	});

	it("HIGH via apriori", () => {
		const r = rec([cand("a", aprioriOpts)]);
		const [lvl, ch] = confidence(r, sel(r));
		expect(lvl).toBe("HIGH");
		expect(ch.apriori).toBe(true);
		expect(ch.matchDominant).toBe(false);
		expect(ch.unmet).toEqual(["matchDominant"]);
		expect(ch.basinGap).toBe(0.5);
	});

	it("HIGH via matchdom (apriori false)", () => {
		const c = cand("m", {
			support: 0.8,
			inliers: 1500,
			matchPose: pose(100.1, 0.1),
			gap: 0.3,
		});
		const r = rec([c]);
		const [lvl, ch] = confidence(r, sel(r));
		expect(lvl).toBe("HIGH");
		expect(ch.apriori).toBe(false);
		expect(ch.matchDominant).toBe(true);
		expect(ch.unmet).toEqual(["apriori"]);
		// match pose too far away -> not match-dominant
		const far = rec([
			cand("m", {
				support: 0.8,
				inliers: 1500,
				matchPose: pose(101, 0),
				gap: 0.3,
			}),
		]);
		expect(confidence(far, sel(far))[0]).toBe("LOW");
	});

	it("gapOK false for untrusted position with missing or low gap", () => {
		for (const gap of [undefined, null, 0.19]) {
			const r = rec([cand("a", { ...aprioriOpts, gap })]);
			const [lvl, ch] = confidence(r, sel(r));
			expect(lvl).toBe("LOW");
			expect(ch.gapOK).toBe(false);
			expect(ch.unmet).toContain("basinGap");
		}
		const exif = rec([cand("a", { ...aprioriOpts, gap: undefined })], {
			positionSource: "exif-gps",
		});
		expect(confidence(exif, sel(exif))[0]).toBe("HIGH");
	});

	it("ambiguity makes LOW", () => {
		const a = cand("a", { ...aprioriOpts, support: 0.9, inliers: 2000 });
		const b = cand("b", { yaw: 110, support: 0.6, inliers: 400 });
		const r = rec([a, b]);
		const s = sel(r);
		expect(s.source).toBe("a");
		const [lvl, ch] = confidence(r, s);
		expect(lvl).toBe("LOW");
		expect(ch.ambiguity).toBe(1);
		expect(ch.unmet).toEqual(["matchDominant", "ambiguity"]);
		// a nearby strong rival (<= 2 deg) is no ambiguity
		const near = rec([a, cand("b", { yaw: 101, support: 0.6, inliers: 400 })]);
		expect(confidence(near, sel(near))[0]).toBe("HIGH");
	});

	it("falls back to the strongest strong candidate when none is high", () => {
		const weak = cand("w", { support: 0.9, inliers: 100 });
		const s1 = cand("s1", { support: 0.5, inliers: 400 });
		const s2 = cand("s2", { support: 0.6, inliers: 500 });
		expect(sel(rec([weak, s1, s2])).source).toBe("s2");
	});

	it("high beats a larger strong candidate", () => {
		const strongBig = cand("big", { support: 0.9, inliers: 5000 });
		const hi = cand("hi", aprioriOpts);
		expect(sel(rec([strongBig, hi])).source).toBe("hi");
	});

	it("baseline fallback, including alsoFrom, then first verified", () => {
		const a = cand("a", { support: 0.1 });
		const b = cand("sweep40", { support: 0.1, alsoFrom: ["narrow"] });
		const noPose: T6Candidate = {
			source: "x",
			pose: pose(),
			fused: { pose: null },
		};
		expect(sel(rec([noPose, a, b])).source).toBe("sweep40");
		expect(baseline(rec([a, b]))?.source).toBe("sweep40");
		const direct = cand("narrow", { support: 0.1 });
		expect(sel(rec([a, direct])).source).toBe("narrow");
		expect(sel(rec([a, b], { baselineSeed: "zzz" })).source).toBe("a");
		expect(select(rec([noPose]))).toBeNull();
	});

	it("ties pick the first maximal element", () => {
		const r = rec([cand("first", aprioriOpts), cand("second", aprioriOpts)]);
		expect(sel(r).source).toBe("first");
		const s = rec([
			cand("s1", { support: 0.6, inliers: 500 }),
			cand("s2", { support: 0.6, inliers: 500 }),
		]);
		expect(sel(s).source).toBe("s1");
	});

	it("zero and null support or inliers count as 0", () => {
		const c = cand("z", {
			support: 0,
			inliers: undefined,
			cueAgree: 0,
			sky: 0,
		});
		const r = rec([c]);
		const [lvl, ch] = confidence(r, sel(r));
		expect(lvl).toBe("LOW");
		expect(ch.inliers).toBe(0);
		expect(ch.apriori).toBe(false); // support 0 < 0.3 even though cue/sky are 0
	});

	it("veto reports why evidence was overruled", () => {
		const noGap = rec([
			cand("a", { ...aprioriOpts, gap: undefined, gapError: "boom" }),
		]);
		expect(veto(noGap, sel(noGap), { ambiguity: 0 })).toBe(
			"basinGap unavailable (boom)",
		);
		const noErr = rec([cand("a", { ...aprioriOpts, gap: undefined })]);
		expect(veto(noErr, sel(noErr), {})).toBe(
			"basinGap unavailable (not computed)",
		);
		const lowGap = rec([cand("a", { ...aprioriOpts, gap: 0.1 })]);
		expect(veto(lowGap, sel(lowGap), {})).toBe("basinGap");
		const ok = rec([cand("a", aprioriOpts)]);
		expect(veto(ok, sel(ok), { ambiguity: 2 })).toBe("ambiguity");
		expect(veto(ok, sel(ok), { ambiguity: 0 })).toBeNull();
		const none = rec([cand("a", { support: 0.1 })]);
		expect(veto(none, sel(none), { ambiguity: 1 })).toBeNull();
	});
});
