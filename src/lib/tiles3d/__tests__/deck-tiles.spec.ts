// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFlags } from "#/test/helpers";

const h = vi.hoisted(() => ({
	sets: [] as FakeSet[],
	layers: [] as Record<string, unknown>[],
	google: false,
	attribution: "credits",
}));
type FakeSet = {
	config: unknown;
	at: { lat: number; lon: number; eye: unknown };
	uniforms: { eye: unknown };
	version: number;
	geoidN: number;
	onChange?: () => void;
	updates: unknown[];
	disposed: boolean;
	hasGoogle: boolean;
};

vi.mock("../tiles", () => ({
	Tiles3DSet: class {
		uniforms = { eye: undefined as unknown };
		version = 7;
		geoidN = 50.123;
		onChange?: () => void;
		updates: unknown[] = [];
		disposed = false;
		hasGoogle = h.google;
		constructor(
			public config: unknown,
			public at: FakeSet["at"],
		) {
			h.sets.push(this as unknown as FakeSet);
		}
		update(...a: unknown[]) {
			this.updates.push(a);
		}
		attributions() {
			return h.attribution;
		}
		dispose() {
			this.disposed = true;
		}
	},
}));
vi.mock("../deck-layer", () => ({
	Tiles3DDeckLayer: class {
		constructor(public props: Record<string, unknown>) {
			h.layers.push(props);
		}
	},
}));

import { DeckTiles3D } from "../deck-tiles";

const flush = () => new Promise((r) => setTimeout(r, 0));
const eye = (): [number, number, number] => [1, 2, 3];
const stepView = () => ({
	position: [4, 5, 6] as [number, number, number],
	viewMatrix: new Array(16).fill(0),
	projectionMatrix: new Array(16).fill(0),
	fovY: 60,
	aspect: 2,
});
const layerArgs = (o: { truth?: boolean } = {}) => ({
	photoViewProj: [1],
	photoPos: [0, 0, 0] as [number, number, number],
	photoRange: null,
	photoFg: null,
	truth: o.truth ?? false,
	camera: [4, 5, 6] as [number, number, number],
});

beforeEach(() => {
	h.sets.length = 0;
	h.layers.length = 0;
	h.google = false;
	h.attribution = "credits";
	vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("DeckTiles3D.create", () => {
	it("is null when ?tiles3d is off, so the engine never touches tiles", () => {
		expect(DeckTiles3D.create(() => {})).toBeNull();
	});
	it("builds an instance once a source is selected", () => {
		withFlags({ tiles3d: "buildings" });
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
		const t = DeckTiles3D.create(() => {});
		expect(t).not.toBeNull();
		t?.dispose();
	});
});

describe("DeckTiles3D lifecycle", () => {
	beforeEach(() => withFlags({ tiles3d: "swisstopo" }));

	it("replays an enter() that arrived before the modules loaded, and asks for a redraw", async () => {
		const onChange = vi.fn();
		const t = DeckTiles3D.create(onChange) as DeckTiles3D;
		t.enter(46.7, 7.7, eye());
		expect(t.tiles).toBeNull();
		await flush();
		expect(h.sets).toHaveLength(1);
		expect(h.sets[0].at).toMatchObject({ lat: 46.7, lon: 7.7 });
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(t.tiles).not.toBeNull();
		expect(console.info).toHaveBeenCalled();
	});

	it("does not replay a pending enter() after exit()", async () => {
		const t = DeckTiles3D.create(() => {}) as DeckTiles3D;
		t.enter(46.7, 7.7, eye());
		t.exit();
		await flush();
		expect(h.sets).toHaveLength(0);
	});

	it("reuses one set across enters and refreshes the eye uniform (a copy)", async () => {
		const t = DeckTiles3D.create(() => {}) as DeckTiles3D;
		await flush();
		const e1 = eye();
		t.enter(46.7, 7.7, e1);
		const e2 = eye();
		t.enter(46.7, 7.7, e2);
		expect(h.sets).toHaveLength(1);
		expect(h.sets[0].uniforms.eye).toEqual(e2);
	});

	it("refines from the world camera only while active", async () => {
		const t = DeckTiles3D.create(() => {}) as DeckTiles3D;
		await flush();
		const cam = stepView();
		t.update(cam, 100, 50); // no set yet
		t.enter(46.7, 7.7, eye());
		t.update(cam, 100, 50);
		expect(h.sets[0].updates).toEqual([[cam, 100, 50]]);
		t.exit();
		t.update(cam, 100, 50);
		expect(h.sets[0].updates).toHaveLength(1);
	});

	it("coalesces tile arrivals into one redraw per animation frame, and only while active", async () => {
		const frames: (() => void)[] = [];
		vi.stubGlobal("requestAnimationFrame", (f: () => void) => frames.push(f));
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
		const onChange = vi.fn();
		const t = DeckTiles3D.create(onChange) as DeckTiles3D;
		await flush();
		t.enter(46.7, 7.7, eye());
		const set = h.sets[0];
		set.onChange?.();
		set.onChange?.();
		set.onChange?.();
		expect(frames).toHaveLength(1);
		frames[0]();
		expect(onChange).toHaveBeenCalledTimes(1);
		set.onChange?.();
		expect(frames).toHaveLength(2);
		t.exit();
		frames[1]();
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("attribution is only offered while active", async () => {
		const t = DeckTiles3D.create(() => {}) as DeckTiles3D;
		await flush();
		expect(t.attribution()).toBeNull();
		t.enter(46.7, 7.7, eye());
		expect(t.attribution()).toBe("credits");
		t.exit();
		expect(t.attribution()).toBeNull();
	});

	it("dispose frees the set and ignores late module arrivals", async () => {
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
		const t = DeckTiles3D.create(() => {}) as DeckTiles3D;
		t.enter(46.7, 7.7, eye());
		t.dispose();
		await flush();
		expect(h.sets).toHaveLength(0);
		const u = DeckTiles3D.create(() => {}) as DeckTiles3D;
		await flush();
		u.enter(46.7, 7.7, eye());
		u.dispose();
		expect(h.sets[0].disposed).toBe(true);
		expect(u.tiles).toBeNull();
	});
});

describe("DeckTiles3D.layer", () => {
	beforeEach(() => withFlags({ tiles3d: "swisstopo", tiles3dBlend: "fill" }));

	it("is null until the set exists and the view is active", async () => {
		const t = DeckTiles3D.create(() => {}) as DeckTiles3D;
		await flush();
		expect(t.layer(layerArgs())).toBeNull();
		t.enter(46.7, 7.7, eye());
		expect(t.layer(layerArgs())).not.toBeNull();
		t.exit();
		expect(t.layer(layerArgs())).toBeNull();
	});

	it("passes the photo projection, fill blend, set version and camera to the layer", async () => {
		const t = DeckTiles3D.create(() => {}) as DeckTiles3D;
		await flush();
		t.enter(46.7, 7.7, eye());
		t.layer(layerArgs());
		const p = h.layers[0];
		expect(p).toMatchObject({
			id: "world-tiles3d",
			version: 7,
			fill: true,
			photoViewProj: [1],
			truth: 0,
			hideDisplayOnly: false,
			camera: [4, 5, 6],
		});
	});

	it("'over' blend turns fill off", async () => {
		withFlags({ tiles3d: "swisstopo", tiles3dBlend: "over" });
		const t = DeckTiles3D.create(() => {}) as DeckTiles3D;
		await flush();
		t.enter(46.7, 7.7, eye());
		t.layer(layerArgs());
		expect(h.layers[0].fill).toBe(false);
	});

	it("Truth view tints with the DEM provenance colour and hides display-only tiles", async () => {
		const t = DeckTiles3D.create(() => {}) as DeckTiles3D;
		await flush();
		t.enter(46.7, 7.7, eye());
		t.layer(layerArgs({ truth: true }));
		const p = h.layers[0];
		expect(p.truth).toBeGreaterThan(0);
		expect(p.hideDisplayOnly).toBe(true);
		const rgb = p.truthColor as number[];
		expect(rgb).toHaveLength(3);
		for (const c of rgb) {
			expect(c).toBeGreaterThanOrEqual(0);
			expect(c).toBeLessThanOrEqual(1);
		}
	});
});

describe("DeckTiles3D.withoutDisplayOnly", () => {
	beforeEach(() => withFlags({ tiles3d: "swisstopo" }));

	it("just runs the capture when there is no Google layer", async () => {
		const onChange = vi.fn();
		const t = DeckTiles3D.create(onChange) as DeckTiles3D;
		await flush();
		t.enter(46.7, 7.7, eye());
		expect(await t.withoutDisplayOnly(async () => "shot")).toBe("shot");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("hides display-only tiles during the capture, then restores and redraws, even on failure", async () => {
		h.google = true;
		const onChange = vi.fn();
		const t = DeckTiles3D.create(onChange) as DeckTiles3D;
		await flush();
		t.enter(46.7, 7.7, eye());
		let seen: unknown;
		await t.withoutDisplayOnly(async () => {
			t.layer(layerArgs());
			seen = h.layers[h.layers.length - 1].hideDisplayOnly;
		});
		expect(seen).toBe(true);
		expect(onChange).toHaveBeenCalledTimes(1);
		t.layer(layerArgs());
		expect(h.layers[h.layers.length - 1].hideDisplayOnly).toBe(false);
		await expect(
			t.withoutDisplayOnly(async () => {
				throw new Error("capture failed");
			}),
		).rejects.toThrow("capture failed");
		expect(onChange).toHaveBeenCalledTimes(2);
		t.layer(layerArgs());
		expect(h.layers[h.layers.length - 1].hideDisplayOnly).toBe(false);
	});
});
