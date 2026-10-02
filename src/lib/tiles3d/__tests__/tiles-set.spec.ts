// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFlags } from "#/test/helpers";

type Props = {
	maximumScreenSpaceError: number;
	cacheBytes: number;
	maximumCacheOverflowBytes: number;
	onTileLoad: (t: unknown) => void;
	onTileUnload: (t: unknown) => void;
	onTileError: (t: unknown, message: string, url: string) => void;
	onTraversalComplete: (s: unknown[]) => unknown[];
};
type FakeTileset = {
	source: { input: { url: string }; loadOptions: Record<string, unknown> };
	props: Props;
	selectedTiles: unknown[];
	requestedTiles: unknown[];
	gpuMemoryUsageInBytes: number;
	updates: { getFrustumPlanes(): Record<string, { distance: number }> }[];
	loaded: boolean;
	destroyed: boolean;
};

const h = vi.hoisted(() => ({
	key: undefined as string | undefined,
	tilesets: [] as unknown[],
}));

vi.mock("@loaders.gl/core", () => ({ coreApi: { name: "core" } }));
vi.mock("@loaders.gl/3d-tiles/bundled", () => ({
	Tiles3DLoader: { id: "3d-tiles" },
}));
vi.mock("@loaders.gl/tiles", () => ({
	Tiles3DSource: class {
		constructor(
			public input: { url: string },
			public loadOptions: Record<string, unknown>,
		) {}
	},
	Tileset3D: class {
		selectedTiles: unknown[] = [];
		requestedTiles: unknown[] = [];
		gpuMemoryUsageInBytes = 1234;
		updates: unknown[] = [];
		loaded = true;
		destroyed = false;
		constructor(
			public source: unknown,
			public props: unknown,
		) {
			h.tilesets.push(this);
		}
		update(v?: unknown) {
			if (v) this.updates.push(v);
		}
		isLoaded() {
			return this.loaded;
		}
		destroy() {
			this.destroyed = true;
		}
	},
}));
vi.mock("../config", async (orig) => ({
	...(await orig<typeof import("../config")>()),
	googleTilesKey: () => h.key,
}));

import { TILES3D_SOURCES, type Tiles3DConfig, tiles3dConfig } from "../config";
import type { TileMesh } from "../content";
import { enuFromEcef } from "../frame";
import { geoidUndulation } from "../geoid";
import { googleCopyrights, Tiles3DSet } from "../tiles";

const cfg = (sources: Tiles3DConfig["sources"]): Tiles3DConfig => ({
	sources,
	blend: "fill",
	radius: 3000,
	fadeStart: 2200,
});
const LAT = 46.7;
const LON = 7.7;
const at = () => ({
	lat: LAT,
	lon: LON,
	eye: [10, 20, 30] as [number, number, number],
});
const tilesets = () => h.tilesets as FakeTileset[];

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
type Material = { baseColorFactor?: number[]; image?: unknown };
function tile(
	id: string,
	o: {
		material?: Material;
		color?: boolean;
		copyright?: string;
		type?: string;
	} = {},
) {
	const pbr: Record<string, unknown> = {};
	if (o.material?.baseColorFactor)
		pbr.baseColorFactor = o.material.baseColorFactor;
	if (o.material?.image)
		pbr.baseColorTexture = { texture: { source: { image: o.material.image } } };
	return {
		id,
		type: o.type ?? "scenegraph",
		contentReady: true,
		content: {
			cartesianModelMatrix: IDENTITY,
			gltf: {
				asset: o.copyright ? { copyright: o.copyright } : undefined,
				scenes: [
					{
						nodes: [
							{
								mesh: {
									primitives: [
										{
											attributes: {
												POSITION: {
													value: new Float32Array(9),
													count: 3,
													size: 3,
												},
												...(o.color
													? {
															COLOR_0: {
																value: new Float32Array(9),
																count: 3,
																size: 3,
															},
														}
													: {}),
											},
											material: { pbrMetallicRoughness: pbr },
										},
									],
								},
							},
						],
					},
				],
			},
		},
	};
}

const view = (position = [0, 0, 100]) => ({
	position: position as [number, number, number],
	// identity rotation: right = +x, up = +y, forward = -z (looking down)
	viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
	projectionMatrix: new Array(16).fill(0),
	fovY: 60,
	aspect: 1.5,
});

/** The tile object a fake tileset was last handed (load callbacks key meshes by object identity). */
const loaded = new WeakMap<FakeTileset, Map<string, unknown>>();
function load(ts: FakeTileset, t: ReturnType<typeof tile>) {
	const m = loaded.get(ts) ?? new Map<string, unknown>();
	m.set(t.id, t);
	loaded.set(ts, m);
	ts.props.onTileLoad(t);
	return t;
}

beforeEach(() => {
	h.key = undefined;
	h.tilesets.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("Tiles3DSet construction", () => {
	it("makes one tileset per source with its url, error target and a bounded byte cache", () => {
		new Tiles3DSet(cfg(["swisstopo-buildings", "swisstopo-vegetation"]), at());
		const [b, v] = tilesets();
		expect(b.source.input.url).toBe(TILES3D_SOURCES["swisstopo-buildings"].url);
		expect(v.source.input.url).toBe(
			TILES3D_SOURCES["swisstopo-vegetation"].url,
		);
		expect(b.props.maximumScreenSpaceError).toBe(
			TILES3D_SOURCES["swisstopo-buildings"].errorTarget,
		);
		expect(b.props.cacheBytes).toBeLessThan(0.4 * 2 ** 30);
		expect(b.props.maximumCacheOverflowBytes).toBeGreaterThan(0);
	});

	it("points the Draco decoder at public/tiles3d/draco for both decoder profiles", () => {
		new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const modules = tilesets()[0].source.loadOptions.modules as Record<
			string,
			string
		>;
		expect(modules["draco_wasm_wrapper.js"]).toMatch(
			/tiles3d\/draco\/draco_wasm_wrapper\.js$/,
		);
		expect(modules["draco_decoder_gltf.wasm"]).toMatch(
			/tiles3d\/draco\/draco_decoder\.wasm$/,
		);
	});

	it("copies the eye and the fade into the shared uniforms; caller uniforms win", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at(), {
			clear: [1, 2],
		});
		expect(set.uniforms.eye).toEqual([10, 20, 30]);
		expect(set.uniforms.fade).toEqual([2200, 3000]);
		expect(set.uniforms.clear).toEqual([1, 2]);
	});

	it("uses the EGM2008 undulation", () => {
		expect(new Tiles3DSet(cfg(["swisstopo-buildings"]), at()).geoidN).toBe(
			geoidUndulation(LAT, LON),
		);
	});

	it("puts the Google key on the root url and skips Google without one", () => {
		h.key = "k 123";
		const set = new Tiles3DSet(cfg(["google"]), at());
		expect(tilesets()[0].source.input.url).toBe(
			`${TILES3D_SOURCES.google.url}?key=k%20123`,
		);
		expect(set.hasGoogle).toBe(true);
		h.key = undefined;
		h.tilesets.length = 0;
		const none = new Tiles3DSet(cfg(["google"]), at());
		expect(h.tilesets).toHaveLength(0);
		expect(none.hasGoogle).toBe(false);
		expect(none.attributions()).toBe("");
	});

	it("places MSL sources without the geoid shift and ellipsoidal (Google) ones with it", () => {
		h.key = "k";
		const set = new Tiles3DSet(cfg(["google", "swisstopo-buildings"]), at());
		const [g, b] = tilesets();
		g.selectedTiles = [load(g, tile("g"))];
		b.selectedTiles = [];
		const [gm] = set.visibleMeshes();
		g.selectedTiles = [];
		b.selectedTiles = [load(b, tile("b"))];
		const [bm] = set.visibleMeshes();
		const close = (got: ArrayLike<number>, want: unknown) =>
			Array.from(want as number[]).forEach((w, i) => {
				expect(got[i]).toBeCloseTo(w, 9);
			});
		close(gm.matrix, enuFromEcef(LAT, LON, set.geoidN));
		close(bm.matrix, enuFromEcef(LAT, LON, 0));
	});
});

describe("near-field mask (the viewport's far plane)", () => {
	it("culls beyond the radius from the camera plus its offset from the eye", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		set.update(view([10, 20, 30]), 800, 600); // camera at the eye
		const ts = tilesets()[0];
		const far = ts.updates[0].getFrustumPlanes().far;
		// forward = -z: the inward far normal is +z, so the plane sits at z = 30 - 3000
		expect(far.distance).toBeCloseTo(30 - 3000, 6);
		set.update(view([110, 20, 30]), 800, 600); // 100 m east of the eye
		expect(ts.updates[1].getFrustumPlanes().far.distance).toBeCloseTo(
			30 - 3100,
			6,
		);
	});
});

describe("update", () => {
	it("traverses on a new pose, skips an identical one once loaded, and keeps going while loading", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const ts = tilesets()[0];
		set.update(view(), 800, 600);
		set.update(view(), 800, 600);
		expect(ts.updates).toHaveLength(1);
		ts.loaded = false;
		set.update(view(), 800, 600);
		expect(ts.updates).toHaveLength(2);
		ts.loaded = true;
		set.update(view([1, 0, 100]), 800, 600);
		expect(ts.updates).toHaveLength(3);
	});

	it("silences updates after dispose", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		set.dispose();
		set.update(view(), 1, 1);
		expect(tilesets()[0].updates).toHaveLength(0);
	});
});

describe("tile content", () => {
	it("turns a loaded tile into TileMeshes, bumps the version and asks for a frame", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const onChange = vi.fn();
		set.onChange = onChange;
		const ts = tilesets()[0];
		const t = load(ts, tile("a"));
		ts.selectedTiles = [t];
		expect(set.visibleMeshes()).toHaveLength(1);
		expect(set.version).toBe(1);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("ignores nested tilesets (json tiles)", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const ts = tilesets()[0];
		const t = load(ts, tile("n", { type: "json" }));
		ts.selectedTiles = [t];
		expect(set.visibleMeshes()).toEqual([]);
	});

	it("a coloured untextured material keeps its colour; white or absent takes the source fallback; a texture wins", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const ts = tilesets()[0];
		const image = { width: 4, height: 4 };
		const ts3 = [
			load(
				ts,
				tile("c", { material: { baseColorFactor: [0.5, 0.25, 0.1, 1] } }),
			),
			load(ts, tile("w", { material: { baseColorFactor: [1, 1, 1, 1] } })),
			load(
				ts,
				tile("t", {
					material: { baseColorFactor: [0.5, 0.25, 0.1, 1], image },
				}),
			),
		];
		ts.selectedTiles = ts3;
		const [c, w, t] = set.visibleMeshes();
		const fb = TILES3D_SOURCES["swisstopo-buildings"].fallbackColor;
		expect(c.color).toEqual([0.5, 0.25, 0.1]);
		expect(w.color).toEqual(fb);
		expect(t.image).toBe(image);
		expect(t.color).toEqual(fb);
	});

	it("carries the source's depth bias; ?tiles3dBias overrides it", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const ts = tilesets()[0];
		ts.selectedTiles = [load(ts, tile("a"))];
		expect(set.visibleMeshes()[0].depthBias).toBe(
			TILES3D_SOURCES["swisstopo-buildings"].depthBias,
		);
		withFlags({ tiles3dBias: "0.9" });
		const set2 = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const ts2 = tilesets()[1];
		ts2.selectedTiles = [load(ts2, tile("a"))];
		expect(set2.visibleMeshes()[0].depthBias).toBe(0.9);
	});

	it("frees meshes on unload: tells the hooks, closes the image, bumps the version", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const ts = tilesets()[0];
		const close = vi.fn();
		const t = load(
			ts,
			tile("a", { material: { image: { width: 2, height: 2, close } } }),
		);
		ts.selectedTiles = [t];
		const [mesh] = set.visibleMeshes();
		const hook = vi.fn();
		set.onDisposeMesh.add(hook);
		const v0 = set.version;
		ts.props.onTileUnload(t);
		expect(hook).toHaveBeenCalledWith(mesh);
		expect(close).toHaveBeenCalled();
		expect(set.version).toBe(v0 + 1);
		expect(set.visibleMeshes()).toEqual([]);
		ts.props.onTileUnload(t); // a second unload is a no-op
		expect(hook).toHaveBeenCalledTimes(1);
	});

	it("a changed selection bumps the version; an unchanged one does not; errors warn", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const onChange = vi.fn();
		set.onChange = onChange;
		const ts = tilesets()[0];
		ts.props.onTraversalComplete([{ id: "a" }, { id: "b" }]);
		expect(set.version).toBe(1);
		ts.props.onTraversalComplete([{ id: "a" }, { id: "b" }]);
		expect(set.version).toBe(1);
		ts.props.onTraversalComplete([{ id: "a" }]);
		expect(set.version).toBe(2);
		expect(onChange).toHaveBeenCalledTimes(2);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		ts.props.onTileError({ id: "a" }, "404", "https://x/y");
		expect(warn.mock.calls[0][0]).toContain("swisstopo-buildings: 404");
		expect(set.stats()[0].failed).toBe(1);
	});
});

describe("visibleMeshes, sources and credits", () => {
	it("lists the selected tiles' meshes with their source and honours per-source visibility", () => {
		const set = new Tiles3DSet(
			cfg(["swisstopo-buildings", "swisstopo-vegetation"]),
			at(),
		);
		const [b, v] = tilesets();
		b.selectedTiles = [load(b, tile("a"))];
		v.selectedTiles = [load(v, tile("b"))];
		const ids = () => set.visibleMeshes().map((m: TileMesh) => m.source.id);
		expect(ids()).toEqual(["swisstopo-buildings", "swisstopo-vegetation"]);
		const v0 = set.version;
		set.setSourceVisible("swisstopo-vegetation", false);
		expect(ids()).toEqual(["swisstopo-buildings"]);
		expect(set.version).toBe(v0 + 1);
		set.setSourceVisible("swisstopo-vegetation", true);
		expect(ids()).toHaveLength(2);
	});

	it("builds the credit line: static credits, Google's copyrights first by occurrence", () => {
		h.key = "k";
		const set = new Tiles3DSet(cfg(["google", "swisstopo-buildings"]), at());
		const credit = TILES3D_SOURCES["swisstopo-buildings"].credit;
		expect(set.attributions()).toBe(`Google · ${credit}`);
		const [g] = tilesets();
		g.selectedTiles = [
			load(g, tile("1", { copyright: "Data SIO, NOAA;Maxar" })),
			load(g, tile("2", { copyright: "Maxar" })),
			load(g, tile("3", { copyright: " ; " })),
		];
		expect(set.attributions()).toBe(
			`Google · Maxar; Data SIO, NOAA · ${credit}`,
		);
		g.selectedTiles = [load(g, tile("4", { copyright: "© Google Earth" }))];
		expect(set.attributions().startsWith("© Google Earth")).toBe(true);
	});

	it("googleCopyrights: most frequent first, ties by first appearance, blanks dropped", () => {
		const t = (c: string) => tile("x", { copyright: c });
		expect(googleCopyrights([t("A;B"), t("B;C"), t("C;B"), t("")])).toEqual([
			"B",
			"C",
			"A",
		]);
	});

	it("reports per-source stats", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const ts = tilesets()[0];
		ts.selectedTiles = [{}, {}];
		ts.requestedTiles = [
			{ contentReady: false },
			{ contentReady: true },
			{ contentReady: false },
		];
		expect(set.stats()).toEqual([
			{
				source: "swisstopo-buildings",
				visible: 2,
				loading: 2,
				failed: 0,
				bytes: 1234,
			},
		]);
	});
});

describe("dispose", () => {
	it("destroys the tilesets, frees the meshes once and is idempotent", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const ts = tilesets()[0];
		load(ts, tile("a"));
		const hook = vi.fn();
		set.onDisposeMesh.add(hook);
		const onChange = vi.fn();
		set.onChange = onChange;
		set.dispose();
		set.dispose();
		expect(ts.destroyed).toBe(true);
		expect(hook).toHaveBeenCalledTimes(1);
		expect(set.stats()).toEqual([]);
	});
});

describe("config round trip", () => {
	it("a set built from the flag config uses its sources", () => {
		withFlags({ tiles3d: "buildings" });
		const c = tiles3dConfig();
		expect(c).not.toBeNull();
		new Tiles3DSet(c as Tiles3DConfig, at());
		expect(h.tilesets).toHaveLength(1);
	});
});
