// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cascade = vi.hoisted(() => ({
	solve: vi.fn(),
	dispose: vi.fn(),
	created: [] as unknown[],
}));
vi.mock("../../../integration/unknown-pose", () => ({
	photoUnknowns: () => ({}),
	UnknownPoseSolver: class {
		constructor(public meta: unknown) {
			cascade.created.push(meta);
		}
		solve = cascade.solve;
		dispose = cascade.dispose;
	},
}));

import type { Pose } from "../../../camera";
import type { PhotoMeta } from "../../../photos";
import { loadSolvedPose, saveSolvedPose } from "../../roll";
import type { Roll, RollPhoto } from "../../types";
import { alignRoll, alignTargets, clearSolvedPoses } from "../align";

const pose = (yaw: number): Pose => ({ yaw, pitch: 0, roll: 0, vfov: 55 });
function photo(
	id: string,
	src: RollPhoto["poseSource"],
	heading: number | null,
	o: { viewpoint?: number; t?: number; imgFails?: boolean } = {},
): RollPhoto {
	return {
		meta: {
			id,
			src: o.imgFails ? "bad://x" : `${id}.jpg`,
			heading,
			pitch: 0,
			roll: 0,
			vfov: 55,
		} as unknown as PhotoMeta,
		pose: pose(heading ?? 0),
		poseSource: src,
		confidence: null,
		eyeAlt: null,
		t: o.t ?? 0,
		viewpoint: o.viewpoint ?? 0,
	};
}
const rollOf = (photos: RollPhoto[]): Roll => ({
	id: "r",
	name: "r",
	photos,
	viewpoints: [],
	center: { lat: 0, lon: 0 },
	radiusM: 0,
	region: null,
});

let store: Map<string, string>;
beforeEach(() => {
	cascade.solve.mockReset();
	cascade.dispose.mockReset();
	cascade.created.length = 0;
	store = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	// an Image whose load succeeds unless its src starts with bad://
	vi.stubGlobal(
		"Image",
		class {
			crossOrigin = "";
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			set src(v: string) {
				setTimeout(
					() => (v.startsWith("bad://") ? this.onerror?.() : this.onload?.()),
					0,
				);
			}
		},
	);
});
afterEach(() => vi.unstubAllGlobals());

const accepted = (yaw: number, confidence = 0.9) => ({
	accepted: true,
	pose: pose(yaw),
	confidence,
	stage: "skyline",
});
const rejected = (yaw: number) => ({
	accepted: false,
	pose: pose(yaw),
	confidence: 0.2,
	stage: "skyline",
});

describe("alignTargets", () => {
	const roll = rollOf([
		photo("a", "prior", 0),
		photo("b", "saved", 0),
		photo("c", "solved", 0),
		photo("d", "ground-truth", 0),
	]);
	it("is the prior-only photos, plus solved ones when resolving", () => {
		expect(alignTargets(roll).map((p) => p.meta.id)).toEqual(["a"]);
		expect(alignTargets(roll, true).map((p) => p.meta.id)).toEqual(["a", "c"]);
	});
});

describe("alignRoll", () => {
	it("stores accepted poses as cascade solves and leaves needs-review ones unstored", async () => {
		cascade.solve.mockImplementation(async (_img, prior: Pose) =>
			prior.yaw === 10 ? accepted(33) : rejected(prior.yaw),
		);
		const roll = rollOf([
			photo("a", "prior", 10),
			photo("b", "prior", 200, { viewpoint: 1 }),
		]);
		const seen: string[] = [];
		const phases: string[] = [];
		const out = await alignRoll(roll, {
			onPhoto: (r) => seen.push(`${r.id}:${r.status}`),
			onProgress: (p) => phases.push(p.phase),
		});
		expect(out).toMatchObject({
			accepted: 1,
			needsReview: 1,
			failed: 0,
			aborted: false,
		});
		expect(seen).toEqual(["a:accepted", "b:needs-review"]);
		expect(phases[phases.length - 1]).toBe("done");
		const solved = loadSolvedPose("a");
		expect(solved?.method).toBe("cascade");
		expect(solved?.pose.yaw).toBe(33);
		expect(solved?.confidence).toBe(0.9);
		expect(loadSolvedPose("b")).toBeNull();
		expect(cascade.dispose).toHaveBeenCalledTimes(2); // a worker per photo, always freed
	});

	it("does not persist when asked not to", async () => {
		cascade.solve.mockResolvedValue(accepted(33));
		const out = await alignRoll(rollOf([photo("a", "prior", 10)]), {
			persist: false,
		});
		expect(out.accepted).toBe(1);
		expect(loadSolvedPose("a")).toBeNull();
	});

	it("starts photos at a viewpoint from the compass shifted by the anchors' median offset", async () => {
		const priors: number[] = [];
		cascade.solve.mockImplementation(async (_img, prior: Pose) => {
			priors.push(prior.yaw);
			return accepted(prior.yaw);
		});
		const roll = rollOf([
			// a saved anchor whose pose is +30 from its compass
			{ ...photo("anchor", "saved", 100), pose: pose(130) },
			photo("t", "prior", 200, { t: 60 }),
		]);
		const out = await alignRoll(roll, { persist: false });
		expect(priors).toEqual([230]);
		expect(out.results[0]).toMatchObject({ biasDeg: 30, biasFrom: 1 });
		// the solved neighbour agrees with its anchors: no outlier flag
		expect(out.results[0].viewpointCheck?.outlier).toBe(false);
	});

	it("ignores the viewpoint bias when disabled", async () => {
		const priors: number[] = [];
		cascade.solve.mockImplementation(async (_img, prior: Pose) => {
			priors.push(prior.yaw);
			return rejected(prior.yaw);
		});
		const roll = rollOf([
			{ ...photo("anchor", "saved", 100), pose: pose(130) },
			photo("t", "prior", 200),
		]);
		await alignRoll(roll, { persist: false, viewpointBias: false });
		expect(priors).toEqual([200]);
	});

	it("learns from an acceptance and retries an earlier rejection from the new bias", async () => {
		const calls: [string, number][] = [];
		cascade.solve.mockImplementation(async (_img, prior: Pose) => {
			// a is hopeless from its raw compass; b (processed second) is accepted at +40 from its compass
			calls.push(["", prior.yaw]);
			if (prior.yaw === 100) return rejected(100);
			if (prior.yaw === 140) return accepted(140); // a's retry from the shifted prior
			return accepted(240); // b
		});
		const roll = rollOf([
			photo("a", "prior", 100, { t: 0 }),
			photo("b", "prior", 200, { t: 10 }),
		]);
		const out = await alignRoll(roll, { persist: false });
		expect(calls.map((c) => c[1])).toEqual([100, 200, 140]);
		expect(out.results.find((r) => r.id === "a")).toMatchObject({
			status: "accepted",
			attempts: 2,
			biasDeg: 40,
		});
	});

	it("flags an accepted photo that disagrees with its neighbours' bias as an outlier", async () => {
		cascade.solve.mockImplementation(async (_img, prior: Pose) =>
			accepted(prior.yaw + 60),
		);
		const roll = rollOf([
			{ ...photo("anchor", "saved", 100), pose: pose(110) },
			photo("t", "prior", 200, { t: 10 }),
		]);
		const out = await alignRoll(roll, { persist: false });
		const check = out.results[0].viewpointCheck;
		// neighbour bias 10; the solve is 60 + 10 off the compass: delta 60
		expect(check?.neighbourBiasDeg).toBe(10);
		expect(check?.deltaDeg).toBeCloseTo(60, 6);
		expect(check?.outlier).toBe(true);
	});

	it("reports a cascade exception as failed with the message, keeping the existing pose", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		cascade.solve.mockRejectedValue(new Error("no DEM"));
		const out = await alignRoll(rollOf([photo("a", "prior", 10)]), {
			persist: false,
		});
		expect(out.failed).toBe(1);
		expect(out.results[0]).toMatchObject({
			status: "failed",
			error: "no DEM",
			confidence: null,
		});
		expect(out.results[0].pose.yaw).toBe(10);
		expect(warn).toHaveBeenCalled();
	});

	it("reports an image that will not load as failed without starting a solver", async () => {
		const out = await alignRoll(
			rollOf([photo("a", "prior", 10, { imgFails: true })]),
			{
				persist: false,
			},
		);
		expect(out.results[0].status).toBe("failed");
		expect(out.results[0].error).toMatch(/could not load/);
		expect(cascade.created).toHaveLength(0);
	});

	it("stops with aborted: true when the signal fires, keeping what was stored", async () => {
		const ac = new AbortController();
		cascade.solve.mockImplementation(async () => {
			ac.abort();
			return accepted(1);
		});
		const roll = rollOf([
			photo("a", "prior", 10),
			photo("b", "prior", 20, { viewpoint: 1 }),
		]);
		const out = await alignRoll(roll, { signal: ac.signal });
		expect(out.aborted).toBe(true);
		expect(out.results.map((r) => r.id)).toEqual(["a"]);
		expect(loadSolvedPose("a")).not.toBeNull();
		expect(loadSolvedPose("b")).toBeNull();
	});

	it("turns a cascade that outlives its deadline into a failure message", async () => {
		vi.useFakeTimers();
		cascade.solve.mockImplementation(
			(_img, _prior, _unk, signal: AbortSignal) =>
				new Promise((_res, rej) =>
					signal.addEventListener("abort", () =>
						rej(new DOMException("aborted", "AbortError")),
					),
				),
		);
		const p = alignRoll(rollOf([photo("a", "prior", 10)]), {
			persist: false,
			timeoutMs: 5000,
		});
		await vi.advanceTimersByTimeAsync(10); // image load
		await vi.advanceTimersByTimeAsync(5001);
		const out = await p;
		vi.useRealTimers();
		expect(out.results[0].status).toBe("failed");
		expect(out.results[0].error).toBe("cascade did not finish within 5 s");
	});

	it("re-solves already solved photos only with resolve", async () => {
		cascade.solve.mockResolvedValue(accepted(1));
		const roll = rollOf([photo("c", "solved", 10)]);
		expect((await alignRoll(roll, { persist: false })).results).toHaveLength(0);
		expect(
			(await alignRoll(roll, { persist: false, resolve: true })).results,
		).toHaveLength(1);
	});
});

describe("clearSolvedPoses", () => {
	it("removes the stored solves of the roll's photos only", () => {
		const s = {
			pose: pose(1),
			confidence: 1,
			method: "cascade" as const,
			at: "x",
		};
		saveSolvedPose("a", s);
		saveSolvedPose("b", s);
		saveSolvedPose("elsewhere", s);
		clearSolvedPoses(rollOf([photo("a", "solved", 0), photo("b", "prior", 0)]));
		expect(loadSolvedPose("a")).toBeNull();
		expect(loadSolvedPose("b")).toBeNull();
		expect(loadSolvedPose("elsewhere")).not.toBeNull();
	});
});
