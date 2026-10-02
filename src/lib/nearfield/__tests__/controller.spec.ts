// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFlags } from "#/test/helpers";
import type { PhotoMeta } from "../../photos";
import { ANCHOR_LOW_TRUST } from "../anchor";
import type { NearFieldClient } from "../client";
import {
	gaussianModelFromUrl,
	LOW_TRUST_QUALITY,
	NearFieldController,
	type NearFieldHost,
	poseAccepted,
	poseKey,
} from "../controller";
import { ANCHOR_MIN_QUALITY, type NearFieldDepth } from "../types";
import { depthMap, type FakeHost, fakeHost, POSE } from "./step-fixture";

const prior = vi.hoisted(() => ({
	calls: 0,
	impl: async (): Promise<null> => null,
}));
vi.mock("../object-evidence", () => ({
	prepareObjectPrior: () => {
		prior.calls++;
		return prior.impl();
	},
}));

function fakeClient(depth: () => NearFieldDepth | null, ok = true) {
	const client = {
		up: ok,
		available: vi.fn(async () => client.up),
		depth: vi.fn(async () => depth()),
		gaussiansWithMeta: vi.fn(async () => null),
	};
	return client;
}

let photoN = 0;
function photo(): PhotoMeta {
	// a fresh id per test: the service results are cached per photo across controllers
	photoN++;
	return { id: `ctl-${photoN}`, src: `/p/${photoN}.jpg` } as PhotoMeta;
}

function controller(
	client: ReturnType<typeof fakeClient>,
	host: FakeHost = fakeHost(),
) {
	return new NearFieldController(host, photo(), {
		client: client as unknown as NearFieldClient,
		gaussianModel: "lift",
	});
}

beforeEach(() => {
	prior.calls = 0;
	prior.impl = async () => null;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(new Blob([new Uint8Array([1, 2, 3])]))),
	);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("poseAccepted", () => {
	it("accepts solver-confirmed and user-confirmed states only", () => {
		for (const s of ["accepted", "pinned", "saved", "manual"])
			expect(poseAccepted(s)).toBe(true);
		expect(poseAccepted("auto", "verified")).toBe(true);
		expect(poseAccepted("auto", "matched")).toBe(true);
		expect(poseAccepted("auto")).toBe(false);
		expect(poseAccepted("auto", "rejected")).toBe(false);
		for (const s of ["near-compass", "prior", "unverified", "", null])
			expect(poseAccepted(s)).toBe(false);
	});
});

describe("trust thresholds", () => {
	it("the panel's low-trust band is the export header's, above the hide gate", () => {
		expect(LOW_TRUST_QUALITY).toBe(ANCHOR_LOW_TRUST);
		expect(LOW_TRUST_QUALITY).toBeGreaterThan(ANCHOR_MIN_QUALITY);
	});
});

describe("NearFieldController.build", () => {
	it("builds an anchored scene, caches it per pose and reuses the service results", async () => {
		const client = fakeClient(() => depthMap());
		const host = fakeHost();
		const c = controller(client, host);
		const phases: string[] = [];
		c.onState((s) => phases.push(s.phase));
		const scene = await c.build();
		expect(scene).not.toBeNull();
		expect(c.state.phase).toBe("ready");
		expect(c.state.quality).toBeGreaterThan(LOW_TRUST_QUALITY);
		expect(c.state.lowTrust).toBe(false);
		expect(c.state.depthModel).toBe("moge2");
		expect(c.state.gaussians).toBe("client depth-lift");
		expect(scene?.model).toBe("moge2-lift");
		expect(scene?.measure?.pose).toEqual(POSE);
		expect(phases[0]).toBe("loading");
		expect(c.hasSceneForPose()).toBe(true);
		// same pose: the cached scene, no service call
		expect(await c.build()).toBe(scene);
		expect(client.depth).toHaveBeenCalledTimes(1);
		// new pose: rebuilt locally from the cached depth
		host.pose = { ...POSE, yaw: POSE.yaw + 1 };
		c.invalidate();
		expect(c.scene).toBeNull();
		expect(c.state.phase).toBe("idle");
		const s2 = await c.build();
		expect(s2).not.toBeNull();
		expect(s2).not.toBe(scene);
		expect(client.depth).toHaveBeenCalledTimes(1);
	});

	it("shares one in-flight build for the same pose", async () => {
		const client = fakeClient(() => depthMap());
		const c = controller(client);
		const [a, b] = await Promise.all([c.build(), c.build()]);
		expect(a).toBe(b);
		expect(client.depth).toHaveBeenCalledTimes(1);
	});

	it("hides a scene whose anchor is below the gate (low-quality, not shown)", async () => {
		const client = fakeClient(() => depthMap(true));
		const host = fakeHost();
		const c = controller(client, host);
		c.show();
		expect(await c.build()).toBeNull();
		expect(c.state.phase).toBe("low-quality");
		expect(c.state.quality).toBeLessThan(ANCHOR_MIN_QUALITY);
		expect(c.state.message).toMatch(/too weak/);
		expect(c.scene).toBeNull();
		expect(host.setNearField).toHaveBeenLastCalledWith(null);
	});

	it("reports an error when the service returns no depth, and does not cache the failure", async () => {
		let fail = true;
		const client = fakeClient(() => (fail ? null : depthMap()));
		const c = controller(client);
		expect(await c.build()).toBeNull();
		expect(c.state.phase).toBe("error");
		expect(c.hasPhotoData()).toBe(false);
		fail = false;
		expect(await c.build()).not.toBeNull();
		expect(client.depth).toHaveBeenCalledTimes(2);
	});

	it("returns to idle, not loading, when the service is down", async () => {
		const client = fakeClient(() => depthMap(), false);
		const c = controller(client);
		expect(await c.build()).toBeNull();
		expect(c.state.phase).toBe("unavailable");
		expect(client.depth).not.toHaveBeenCalled();
	});

	it("builds for the pose current after the service call (the DEM grid is sampled then)", async () => {
		const host = fakeHost();
		const client = fakeClient(() => depthMap());
		client.depth.mockImplementation(async () => {
			host.pose = { ...POSE, yaw: POSE.yaw + 5 };
			return depthMap();
		});
		const c = controller(client, host);
		const scene = await c.build();
		expect(scene?.measure?.pose.yaw).toBe(POSE.yaw + 5);
	});

	it("drops a build whose pose moved while the object prior loaded (no mixed-pose scene)", async () => {
		withFlags({ tiles3dObjects: "on" });
		const host = fakeHost();
		prior.impl = async () => {
			host.pose = { ...POSE, yaw: POSE.yaw + 5 };
			return null;
		};
		const c = controller(
			fakeClient(() => depthMap()),
			host,
		);
		expect(await c.build()).toBeNull();
		expect(c.scene).toBeNull();
		expect(c.hasSceneForPose()).toBe(false);
		expect(c.state.phase).toBe("idle");
		expect(prior.calls).toBe(1);
		// back at the old pose: nothing built from the moved camera was cached under its key
		host.pose = { ...POSE };
		expect(c.hasSceneForPose()).toBe(false);
	});

	it("a disposed controller stops quietly and emits nothing", async () => {
		const client = fakeClient(() => depthMap());
		const c = controller(client);
		const cb = vi.fn();
		c.onState(cb);
		const p = c.build();
		c.dispose();
		expect(await p).toBeNull();
		const n = cb.mock.calls.length;
		c.show();
		expect(cb.mock.calls.length).toBe(n);
	});
});

describe("NearFieldController.available", () => {
	it("a failed probe does not hide a built scene; it does mark an idle controller unavailable", async () => {
		const client = fakeClient(() => depthMap());
		const c = controller(client);
		await c.build();
		expect(c.state.phase).toBe("ready");
		client.up = false;
		expect(await c.available(true)).toBe(false);
		expect(c.state.phase).toBe("ready");

		const idle = controller(fakeClient(() => depthMap(), false));
		expect(await idle.available()).toBe(false);
		expect(idle.state.phase).toBe("unavailable");
	});

	it("an unsupported engine (no setNearField) is never available", async () => {
		const host = fakeHost() as Partial<FakeHost>;
		delete host.setNearField;
		const client = fakeClient(() => depthMap());
		const c = new NearFieldController(host as NearFieldHost, photo(), {
			client: client as unknown as NearFieldClient,
			gaussianModel: "lift",
		});
		expect(c.supported).toBe(false);
		expect(await c.available()).toBe(false);
		expect(client.available).not.toHaveBeenCalled();
	});
});

describe("show / hide / view options", () => {
	it("forwards the scene and merged options to the renderer", async () => {
		const host = fakeHost();
		const c = controller(
			fakeClient(() => depthMap()),
			host,
		);
		const scene = await c.build();
		c.show({ truth: true });
		expect(host.setNearField).toHaveBeenLastCalledWith(scene, { truth: true });
		c.setViewOpts({ maskDrape: true });
		expect(host.setNearField).toHaveBeenLastCalledWith(scene, {
			truth: true,
			maskDrape: true,
		});
		c.hide();
		expect(host.setNearField).toHaveBeenLastCalledWith(null);
	});
});

describe("poseKey", () => {
	it("changes with the angles and the eye, not with sub-tolerance noise", () => {
		const e = { x: 1, y: 2, z: 3 };
		expect(poseKey(POSE, e)).toBe(poseKey({ ...POSE }, { ...e }));
		expect(poseKey(POSE, e)).not.toBe(poseKey({ ...POSE, yaw: 20.001 }, e));
		expect(poseKey(POSE, e)).not.toBe(poseKey(POSE, { ...e, z: 3.1 }));
		expect(poseKey(POSE, e)).toBe(poseKey({ ...POSE, yaw: 20.00001 }, e));
	});
});

describe("gaussianModelFromUrl", () => {
	it("SHARP (research-only weights) only in a dev build", () => {
		withFlags({ nearfield: "sharp" });
		expect(gaussianModelFromUrl(true)).toBe("sharp");
		expect(gaussianModelFromUrl(false)).toBe("lift");
		expect(console.warn).toHaveBeenCalled();
		withFlags({ nearfield: "on" });
		expect(gaussianModelFromUrl(true)).toBe("lift");
	});
});
