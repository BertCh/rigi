// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import { engineNearFieldScene } from "../../export/splat";
import type { PhotoMeta } from "../../photos";
import type { Renderer } from "../../renderer";
import type { NearFieldSource } from "../client";
import { NearFieldController, previewMessage, STEP_SPLIT } from "../controller";
import { intrinsicsFromPose, rayFactor, sampleDemGrid } from "../geom";
import {
	demPreviewDepth,
	isPreviewScene,
	PREVIEW_DEPTH_MODEL,
	previewGridSize,
} from "../preview";
import { buildNearFieldScene } from "../scene";
import { type NearFieldDepth, PixelClass } from "../types";
import {
	ASPECT,
	depthMap,
	EYE_Z,
	fakeHost,
	groundRange,
	POSE,
} from "./step-fixture";

vi.mock("../object-evidence", () => ({
	prepareObjectPrior: async () => null,
}));

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(new Blob([new Uint8Array([1, 2, 3])]))),
	);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** A client whose depth resolves when the test says so (the model "downloading"). */
function slowClient() {
	let gate = deferred<NearFieldDepth | null>();
	const client = {
		available: vi.fn(async () => true),
		depth: vi.fn(
			async (
				_b: Blob,
				o?: { onProgress?: (m: string) => void },
			): Promise<NearFieldDepth | null> => {
				o?.onProgress?.("downloading model 34 MB (12%)");
				return gate.promise;
			},
		),
		gaussiansWithMeta: vi.fn(async () => null),
		finish(d: NearFieldDepth | null) {
			gate.resolve(d);
		},
		reset() {
			gate = deferred();
		},
	};
	return client;
}

let photoN = 0;
const photo = () => {
	photoN++;
	return { id: `pv-${photoN}`, src: `/pv/${photoN}.jpg` } as PhotoMeta;
};

describe("previewGridSize", () => {
	it("keeps the photo aspect on a long side of 160", () => {
		expect(previewGridSize(4 / 3)).toEqual({ width: 160, height: 120 });
		expect(previewGridSize(0.5)).toEqual({ width: 80, height: 160 });
		expect(previewGridSize(Number.NaN)).toEqual({ width: 160, height: 160 });
	});
});

describe("demPreviewDepth", () => {
	const W = 32;
	const H = 24;
	const K = intrinsicsFromPose(POSE, ASPECT);
	const grid = sampleDemGrid(W, H, (u, v) => groundRange(POSE, EYE_Z, u, v));

	it("is the DEM range along each ray as z-depth, invalid where no terrain", () => {
		const d = demPreviewDepth(grid, W, H, K);
		expect(d.model).toBe(PREVIEW_DEPTH_MODEL);
		expect(d.intrinsicsNorm).toEqual(K);
		let valid = 0;
		for (let j = 0; j < H; j++)
			for (let i = 0; i < W; i++) {
				const k = j * W + i;
				const r = grid[k];
				if (Number.isNaN(r)) {
					expect(d.valid[k]).toBe(0);
					continue;
				}
				valid++;
				expect(d.valid[k]).toBe(1);
				const ray = d.depth[k] * rayFactor(K, (i + 0.5) / W, (j + 0.5) / H);
				expect(ray).toBeCloseTo(r, 2);
			}
		// the fixture looks 15° down from 10 m: ground below the horizon, sky above
		expect(valid).toBeGreaterThan(0);
		expect(valid).toBeLessThan(W * H);
	});

	it("drops sky-mask pixels even where the DEM has a hit", () => {
		const sky = { width: 1, height: 2, data: [255, 255] };
		const d = demPreviewDepth(grid, W, H, K, sky);
		expect(d.valid.every((x) => x === 0)).toBe(true);
	});

	it("builds a scene with terrain only: no splats, no Object, identity anchor", () => {
		const host = fakeHost();
		const depth = demPreviewDepth(grid, W, H, K);
		const scene = buildNearFieldScene({
			photoId: "p",
			depth,
			renderer: host,
			photo: null,
			split: STEP_SPLIT,
			demGrid: grid,
			anchor: { mode: "scale" },
			ground: false,
			farObjects: false,
		});
		expect(scene.splats.count).toBe(0);
		expect(scene.split.counts[PixelClass.Object] ?? 0).toBe(0);
		expect(scene.split.counts[PixelClass.Terrain]).toBeGreaterThan(0);
		expect(scene.anchor.scale).toBeCloseTo(1, 2);
		expect(scene.confidenceRadius).toBeGreaterThanOrEqual(10);
	});
});

describe("NearFieldController terrain preview", () => {
	it("shows a DEM preview while the depth loads, then swaps the depth scene in place", async () => {
		const client = slowClient();
		const host = fakeHost();
		const c = new NearFieldController(host, photo(), {
			client: client as unknown as NearFieldSource,
		});
		c.show({ truth: false });
		const onPreview = vi.fn();
		const p = c.build(undefined, { onPreview });
		await vi.waitFor(() => expect(onPreview).toHaveBeenCalledTimes(1));
		const preview = c.scene;
		expect(preview?.preview).toBe(true);
		expect(isPreviewScene(preview)).toBe(true);
		expect(preview?.model).toBe(PREVIEW_DEPTH_MODEL);
		expect(onPreview).toHaveBeenCalledWith(preview);
		expect(c.state).toMatchObject({
			phase: "loading",
			preview: true,
			depthModel: PREVIEW_DEPTH_MODEL,
			splats: 0,
		});
		expect(c.state.message).toBe(
			previewMessage("downloading model 34 MB (12%)"),
		);
		expect(c.state.message).toMatch(/^Terrain preview — downloading model/);
		// not measurable, not cached as the pose's scene
		expect(preview?.measure).toBeUndefined();
		expect(c.sampleAt(0.5, 0.8)).toBeNull();
		expect(c.hasSceneForPose()).toBe(false);
		expect(host.setNearField).toHaveBeenLastCalledWith(preview, {
			truth: false,
		});

		client.finish(depthMap());
		const scene = await p;
		expect(scene).not.toBeNull();
		expect(scene?.preview).toBeUndefined();
		expect(c.scene).toBe(scene);
		expect(c.state.phase).toBe("ready");
		expect(c.state.preview).toBeUndefined();
		expect(c.state.depthModel).toBe("moge2");
		expect(host.setNearField).toHaveBeenLastCalledWith(scene, {
			truth: false,
		});
		expect(onPreview).toHaveBeenCalledTimes(1);
	});

	it("skips the preview once the photo's depth is cached", async () => {
		const client = slowClient();
		const host = fakeHost();
		const c = new NearFieldController(host, photo(), {
			client: client as unknown as NearFieldSource,
		});
		client.finish(depthMap());
		await c.build(undefined, { preview: false });
		expect(c.depthReady()).toBe(true);
		host.pose = { ...POSE, yaw: POSE.yaw + 1 };
		c.invalidate();
		const onPreview = vi.fn();
		const s = await c.build(undefined, { onPreview });
		expect(s).not.toBeNull();
		expect(onPreview).not.toHaveBeenCalled();
	});

	it("preview: false builds without a preview", async () => {
		const client = slowClient();
		const c = new NearFieldController(fakeHost(), photo(), {
			client: client as unknown as NearFieldSource,
		});
		const states: boolean[] = [];
		c.onState((s) => states.push(!!s.preview));
		const p = c.build(undefined, { preview: false });
		await new Promise((r) => setTimeout(r, 10));
		expect(c.scene).toBeNull();
		client.finish(depthMap());
		await p;
		expect(states.some(Boolean)).toBe(false);
	});

	it("a pose change drops the preview (renderer cleared, preview state off)", async () => {
		const client = slowClient();
		const host = fakeHost();
		const c = new NearFieldController(host, photo(), {
			client: client as unknown as NearFieldSource,
		});
		c.show();
		const onPreview = vi.fn();
		void c.build(undefined, { onPreview });
		await vi.waitFor(() => expect(onPreview).toHaveBeenCalled());
		host.pose = { ...POSE, yaw: POSE.yaw + 3 };
		c.invalidate();
		expect(c.scene).toBeNull();
		expect(host.setNearField).toHaveBeenLastCalledWith(null);
		expect(c.state.phase).toBe("loading");
		expect(c.state.preview).toBeUndefined();
		client.finish(null);
	});

	it("a failed depth drops the preview and reports the error", async () => {
		const client = slowClient();
		const host = fakeHost();
		const c = new NearFieldController(host, photo(), {
			client: client as unknown as NearFieldSource,
		});
		c.show();
		const onPreview = vi.fn();
		const p = c.build(undefined, { onPreview });
		await vi.waitFor(() => expect(onPreview).toHaveBeenCalled());
		client.finish(null);
		expect(await p).toBeNull();
		expect(c.scene).toBeNull();
		expect(c.state.phase).toBe("error");
		expect(c.state.preview).toBeUndefined();
		expect(host.setNearField).toHaveBeenLastCalledWith(null);
	});

	it("a joined build gets the preview callback too", async () => {
		const client = slowClient();
		const c = new NearFieldController(fakeHost(), photo(), {
			client: client as unknown as NearFieldSource,
		});
		const a = vi.fn();
		const b = vi.fn();
		const p1 = c.build(undefined, { onPreview: a });
		const p2 = c.build(undefined, { onPreview: b });
		await vi.waitFor(() => expect(b).toHaveBeenCalledTimes(1));
		expect(a).toHaveBeenCalledTimes(1);
		client.finish(depthMap());
		expect(await p1).toBe(await p2);
	});

	it("a preview never exports, even with splats", () => {
		const scene = {
			photoId: "p",
			preview: true,
			splats: { count: 3 },
		};
		expect(
			engineNearFieldScene({ nearFieldScene: scene } as unknown as Renderer),
		).toBeNull();
		expect(
			engineNearFieldScene({
				nearFieldScene: { ...scene, preview: undefined },
			} as unknown as Renderer),
		).not.toBeNull();
	});
});
