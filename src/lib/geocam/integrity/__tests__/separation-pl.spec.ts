// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Solution-separation protection level with an injected solver: PL = |x0 - xk| + K * sigma_sep, the
// pass rule, availability (fail closed), and the bubble test.
import { describe, expect, it } from "vitest";
import {
	type CameraX,
	type Factor,
	type GeoState,
	IDX,
	type MapProblem,
	type MapResult,
	NP,
} from "../../core";
import {
	bubbleTest,
	dataRows,
	defaultSubsets,
	PL_DEFAULTS,
	protectionLevel,
	type SubsetSpec,
} from "../separation";

const base = {
	pose: { yaw: 0, pitch: 0, roll: 0, vfov: 40 },
	eye: [0, 0, 0],
	aspect: 1.5,
	intr: { fScale: 1, k1: 0, cx: 0, cy: 0 },
} as CameraX;

const dataFactor = (family: Factor["family"], dim = 20, value = 0): Factor => ({
	family,
	name: family,
	dim,
	loss: { kind: "l2" },
	residual: () => new Float64Array(dim).fill(value),
});
const priorFactor = (): Factor => ({
	family: "gps",
	name: "gps",
	dim: 2,
	loss: { kind: "l2" },
	prior: true,
	residual: () => new Float64Array(2),
});
const problem = (factors: Factor[]): MapProblem => ({
	base,
	f0Px1600: 1000,
	factors,
	free: { rotation: true, focal: true, eye: true },
});

const state = (p: Partial<Record<keyof typeof IDX, number>> = {}): GeoState => {
	const x = new Float64Array(NP);
	for (const [k, v] of Object.entries(p))
		x[IDX[k as keyof typeof IDX]] = v as number;
	return x;
};
const diag = (d: Partial<Record<keyof typeof IDX, number>>): Float64Array => {
	const c = new Float64Array(NP * NP);
	for (const [k, v] of Object.entries(d))
		c[IDX[k as keyof typeof IDX] * NP + IDX[k as keyof typeof IDX]] =
			v as number;
	return c;
};
const result = (
	x: GeoState,
	cov: Float64Array,
	over: Partial<MapResult> = {},
): MapResult =>
	({
		x,
		cam: base,
		cov,
		sigma: {},
		sigmaEN: Math.sqrt(
			Math.max(cov[IDX.E * NP + IDX.E], cov[IDX.N * NP + IDX.N]),
		),
		perFamily: [],
		mad: 1,
		iterations: 1,
		outer: 1,
		converged: true,
		ms: 0,
		...over,
	}) as MapResult;

const full = result(state(), diag({ E: 4, N: 4, U: 1, yaw: 0.01 }));

describe("dataRows", () => {
	it("counts finite rows of non-prior factors only", () => {
		const nan: Factor = {
			...dataFactor("skyline", 5),
			residual: () =>
				Float64Array.of(1, Number.NaN, 2, Number.POSITIVE_INFINITY, 0),
		};
		expect(
			dataRows([priorFactor(), dataFactor("point", 10), nan], state()),
		).toBe(13);
		expect(dataRows([priorFactor()], state())).toBe(0);
	});
});

describe("defaultSubsets", () => {
	it("leaves each data family out only when another data family remains, never a prior", () => {
		const names = defaultSubsets(
			problem([priorFactor(), dataFactor("skyline"), dataFactor("point")]),
		).map((s) => s.name);
		expect(names).toEqual(["-skyline", "-point"]);
		expect(
			defaultSubsets(problem([priorFactor(), dataFactor("skyline")])),
		).toEqual([]);
		const s = defaultSubsets(
			problem([priorFactor(), dataFactor("skyline"), dataFactor("point")]),
		)[0];
		expect(s.factors.map((f) => f.family)).toEqual(["gps", "point"]);
	});

	it("adds left/right/near/far row masks only for factors with row metadata", () => {
		const sky = dataFactor("skyline", 4);
		const pts = dataFactor("point", 4);
		const info = new Map<Factor, { u: number; depthM: number }[]>([
			[
				pts,
				[
					{ u: 0.1, depthM: 500 },
					{ u: 0.9, depthM: 500 },
					{ u: 0.1, depthM: 5000 },
					{ u: 0.9, depthM: 5000 },
				],
			],
		]);
		const subs = defaultSubsets(problem([priorFactor(), sky, pts]), {
			rowInfo: (f) => info.get(f),
			bandSplitM: 2000,
		});
		expect(subs.map((s) => s.name)).toEqual([
			"-skyline",
			"-point",
			"-left",
			"-right",
			"-near",
			"-far",
		]);
		const rows = (name: string) => {
			const f = subs
				.find((s) => s.name === name)
				?.factors.find((x) => x.family === "point") as Factor;
			return Array.from(f.residual(state())).map((v) => Number.isNaN(v));
		};
		// "-left" drops the left half (u < 0.5): rows 0 and 2 read NaN
		expect(rows("-left")).toEqual([true, false, true, false]);
		expect(rows("-right")).toEqual([false, true, false, true]);
		expect(rows("-near")).toEqual([true, true, false, false]);
		expect(rows("-far")).toEqual([false, false, true, true]);
		// the skyline factor has no metadata and stays whole
		expect(subs[2].factors.find((f) => f.family === "skyline")).toBe(sky);
	});

	it("emits no row-mask subset when no factor has metadata", () => {
		const subs = defaultSubsets(
			problem([dataFactor("skyline"), dataFactor("point")]),
			{ rowInfo: () => undefined },
		);
		expect(subs.map((s) => s.name)).toEqual(["-skyline", "-point"]);
	});
});

describe("protectionLevel", () => {
	const subsetOf = (name: string): SubsetSpec => ({
		name,
		factors: [dataFactor("point")],
	});
	const solver = (r: MapResult | Error | ((n: number) => MapResult)) => {
		let n = 0;
		return async () => {
			n++;
			if (r instanceof Error) throw r;
			return typeof r === "function" ? r(n) : r;
		};
	};
	const run = (res: MapResult | Error, o: object = {}) =>
		protectionLevel(problem([dataFactor("point")]), full, {
			subsets: [subsetOf("s")],
			solve: solver(res),
			...o,
		});

	it("PL = separation + K * sqrt(cov_k - cov_0), per axis group", async () => {
		const xk = state({ E: 3, N: 4, U: 2, yaw: 0.3 });
		const covk = diag({ E: 8, N: 4, U: 5, yaw: 0.05 });
		const pl = await run(result(xk, covk));
		const K = PL_DEFAULTS.kMd;
		// E/N block of cov_k - cov_0 = diag(4, 0): sqrt(lambda_max) = 2
		expect(pl.plH).toBeCloseTo(5 + K * 2, 9);
		expect(pl.plV).toBeCloseTo(2 + K * 2, 9);
		expect(pl.plYawDeg).toBeCloseTo(0.3 + K * Math.sqrt(0.04), 9);
		expect(pl.subsets[0].ok).toBe(true);
		expect(pl.subsets[0].dH).toBeCloseTo(5, 12);
		// fault-free terms use the full covariance
		expect(pl.plFFH).toBeCloseTo(K * 2, 9);
		expect(pl.plFFV).toBeCloseTo(K * 1, 9);
	});

	it("passes a consistent subset and fails when a PL reaches its alert limit", async () => {
		const ok = await run(
			result(state({ E: 0.1 }), diag({ E: 4.01, N: 4, U: 1.01, yaw: 0.0101 })),
		);
		expect(ok.pass).toBe(true);
		expect(ok.reasons).toEqual([]);
		const bad = await run(
			result(state({ E: 60 }), diag({ E: 4, N: 4, U: 1, yaw: 0.01 })),
		);
		expect(bad.pass).toBe(false);
		expect(bad.reasons.join(" ")).toMatch(/PL_H/);
		expect(bad.worst.H).toBe("s");
		const yaw = await run(
			result(state({ yaw: 5 }), diag({ E: 4, N: 4, U: 1, yaw: 0.01 })),
			{ alertYawDeg: 100 },
		);
		expect(yaw.pass).toBe(true);
	});

	it("clamps a negative covariance difference to zero separation", async () => {
		const pl = await run(
			result(state(), diag({ E: 1, N: 1, U: 0.1, yaw: 0.001 })),
		);
		expect(pl.subsets[0].sepH).toBe(0);
		expect(pl.subsets[0].sepV).toBe(0);
		expect(pl.plH).toBe(0);
		expect(pl.pass).toBe(true);
	});

	it("fails closed on a subset with too few data rows without solving it", async () => {
		const calls: number[] = [];
		const pl = await protectionLevel(problem([dataFactor("point")]), full, {
			subsets: [{ name: "thin", factors: [dataFactor("point", 3)] }],
			solve: async () => {
				calls.push(1);
				return full;
			},
		});
		expect(calls).toEqual([]);
		expect(pl.pass).toBe(false);
		expect(pl.subsets[0].ok).toBe(false);
		expect(pl.subsets[0].why).toMatch(/unavailable: 3 data rows < 12/);
		expect(pl.plH).toBe(Number.POSITIVE_INFINITY);
	});

	it("fails closed on a solver exception and on a non-converged subset", async () => {
		const thrown = await run(new Error("singular"));
		expect(thrown.pass).toBe(false);
		expect(thrown.subsets[0].why).toBe("solve failed: singular");
		const nc = await run(
			result(state(), diag({ E: 5, N: 5, U: 2, yaw: 0.02 }), {
				converged: false,
			}),
		);
		expect(nc.pass).toBe(false);
		expect(nc.subsets[0].why).toBe("not converged");
		expect(nc.reasons.join(" ")).toMatch(/did not converge/);
	});

	it("treats an unobservable axis (infinity minus infinity) as unbounded", async () => {
		const inf = Number.POSITIVE_INFINITY;
		const fullInf = result(state(), diag({ E: inf, N: inf, U: 1, yaw: 0.01 }));
		const pl = await protectionLevel(problem([dataFactor("point")]), fullInf, {
			subsets: [subsetOf("s")],
			solve: async () =>
				result(state(), diag({ E: inf, N: inf, U: 1, yaw: 0.01 })),
		});
		expect(pl.plH).toBe(Number.POSITIVE_INFINITY);
		expect(pl.pass).toBe(false);
	});

	it("a problem with no redundancy has no subsets and does not pass", async () => {
		const pl = await protectionLevel(problem([dataFactor("point")]), full, {
			solve: solver(full),
		});
		expect(pl.subsets).toEqual([]);
		expect(pl.pass).toBe(false);
		expect(pl.reasons).toContain("no subsets (no redundancy)");
	});

	it("picks the worst subset per axis group and relinearises factors before counting rows", async () => {
		const relin: string[] = [];
		const mk = (name: string): SubsetSpec => ({
			name,
			factors: [
				{
					...dataFactor("point"),
					relinearize: async () => void relin.push(name),
				},
			],
		});
		const results: Record<string, MapResult> = {
			a: result(state({ E: 10 }), diag({ E: 4, N: 4, U: 1, yaw: 0.01 })),
			b: result(state({ U: 20 }), diag({ E: 4, N: 4, U: 1, yaw: 0.01 })),
		};
		let i = 0;
		const pl = await protectionLevel(problem([dataFactor("point")]), full, {
			subsets: [mk("a"), mk("b")],
			solve: async () => results[["a", "b"][i++]],
			alertH: 1000,
			alertV: 1000,
		});
		expect(relin).toEqual(["a", "b"]);
		expect(pl.worst.H).toBe("a");
		expect(pl.worst.V).toBe("b");
	});
});

describe("bubbleTest", () => {
	const pl = {
		plH: 10,
		plV: 5,
		plYawDeg: 0.5,
		plFFH: 20,
		plFFV: 2,
		plFFYawDeg: 0.2,
	} as never;
	it("is inside when within max(PL, K*sigma0) in every group", () => {
		const t = bubbleTest(state({ E: 15, U: 4, yaw: 0.4 }), full, pl);
		expect(t.outside).toBe(false);
		expect([t.bubbleH, t.bubbleV, t.bubbleYawDeg]).toEqual([20, 5, 0.5]);
	});
	it("is outside when any one group leaves its bubble, with wrapped yaw", () => {
		expect(bubbleTest(state({ E: 25 }), full, pl).outside).toBe(true);
		expect(bubbleTest(state({ U: -6 }), full, pl).outside).toBe(true);
		expect(bubbleTest(state({ yaw: 359.7 }), full, pl).outside).toBe(false); // 0.3 deg away
		expect(bubbleTest(state({ yaw: 359 }), full, pl).outside).toBe(true); // 1 deg away
	});
});
