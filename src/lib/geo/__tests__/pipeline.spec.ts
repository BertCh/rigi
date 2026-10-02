// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { angleDiffDeg } from "#/test/helpers";
import type { DemSource } from "../../dem";
import { cameraFromAngles } from "../camera";
import type { HorizonProfile } from "../horizon";
import {
	cascade,
	cascadeAsync,
	EYE_ABOVE_GROUND,
	loadScene,
} from "../pipeline";
import { projectSkylineRows } from "../solve";

// One world-spanning z0 tile of 8x8 samples at 1000 m (a 1 km band needs only that tile).
const N = 8;
const DEM: DemSource = {
	name: "flat",
	url: () => "",
	tileSize: N,
	maxZoom: 0,
	levels: [{ z: 0, maxDistance: 1000 }],
};
const flat = async () => new Float32Array(N * N).fill(1000);

describe("loadScene", () => {
	it("eye = GPS altitude, but at least standing height above the ground", async () => {
		const at = (alt: number | null | undefined) =>
			loadScene(46.7, 7.7, alt, DEM, flat).then((s) => s.eye);
		const ground = (await loadScene(46.7, 7.7, null, DEM, flat)).ground;
		expect(ground).toBeCloseTo(1000, 6);
		expect(await at(null)).toBeCloseTo(1000 + EYE_ABOVE_GROUND, 6);
		expect(await at(undefined)).toBeCloseTo(1000 + EYE_ABOVE_GROUND, 6);
		expect(await at(900)).toBeCloseTo(1000 + EYE_ABOVE_GROUND, 6); // GPS inside the hill
		expect(await at(1001)).toBeCloseTo(1000 + EYE_ABOVE_GROUND, 6);
		expect(await at(2000)).toBe(2000);
	});

	it("throws when the camera's tile did not load", async () => {
		await expect(
			loadScene(46.7, 7.7, 1500, DEM, async () => undefined),
		).rejects.toThrow(/No DEM data/);
	});

	it("loads through the shared tile cache: a second scene fetches nothing", async () => {
		const tiles = new Map<string, Float32Array>();
		let fetched = 0;
		const counting = async () => {
			fetched++;
			return flat();
		};
		await loadScene(46.7, 7.7, null, DEM, counting, tiles);
		expect([...tiles.keys()]).toEqual(["0/0/0"]);
		expect(fetched).toBe(1);
		await loadScene(46.7, 7.7, null, DEM, counting, tiles);
		expect(fetched).toBe(1);
	});
});

/** A synthetic 0.5-degree-step panorama with two distinct peaks (as in solve.spec.ts). */
function profile(): HorizonProfile {
	const step = 0.5;
	const n = 720;
	const elevation = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const az = i * step;
		elevation[i] =
			3 +
			2 * Math.sin((az * Math.PI) / 37) +
			1.5 * Math.sin((az * Math.PI) / 11 + 1) +
			9 * Math.exp(-(((az - 150) / 4) ** 2)) +
			6 * Math.exp(-(((az - 175) / 3) ** 2));
	}
	return {
		step,
		elevation,
		distance: new Float32Array(n).fill(5000),
		ridges: Array.from({ length: n }, () => []),
	};
}

describe("cascade on a synthetic panorama", () => {
	const h = profile();
	const truth = cameraFromAngles({
		width: 400,
		height: 300,
		f: 420,
		yaw: 160,
		pitch: 3,
		roll: 0,
	});
	const rows = projectSkylineRows(truth, h, 400);
	const sky = {
		width: 400,
		height: 300,
		rows,
		weight: new Float32Array(400).map((_, x) =>
			Number.isFinite(rows[x]) ? 1 : 0,
		),
	};
	const prior = cameraFromAngles({ ...truth, yaw: 151, pitch: 2.4 });

	it("a confident solve answers alone (stage solve, one candidate)", () => {
		const r = cascade(prior, h, sky);
		expect(r.stage).toBe("solve");
		expect(r.accepted).toBe(true);
		expect(r.candidates).toHaveLength(1);
		expect(r.candidates[0].camera).toBe(r.camera);
		expect(angleDiffDeg(r.camera.yaw, 160)).toBeLessThan(0.2);
		expect(Number.isFinite(r.residualPx)).toBe(true);
	});

	it("cascadeAsync without a coarse provider equals cascade", async () => {
		const a = cascade(prior, h, sky);
		const b = await cascadeAsync(prior, h, sky);
		expect(b.camera.yaw).toBe(a.camera.yaw);
		expect(b.camera.pitch).toBe(a.camera.pitch);
		expect(b.confidence).toBe(a.confidence);
		expect(b.stage).toBe(a.stage);
	});

	it("no skyline: both stages reject and the solve's no-skyline result is returned", () => {
		const empty = { ...sky, weight: new Float32Array(400) };
		const r = cascade(prior, h, empty);
		expect(r.accepted).toBe(false);
		expect(r.stage).toBe("solve");
		expect(r.rejectReason).toBe("no-skyline");
		expect(r.camera).toBe(prior);
		expect(r.candidates.map((c) => [c.stage, c.accepted])).toEqual([
			["solve", false],
			["refine", false],
		]);
	});
});
