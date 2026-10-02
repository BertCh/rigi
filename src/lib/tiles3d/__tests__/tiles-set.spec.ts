// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFlags } from "#/test/helpers";

const h = vi.hoisted(() => ({
	key: undefined as string | undefined,
	renderers: [] as unknown[],
	plugins: [] as { kind: string; arg: unknown }[],
}));

vi.mock("3d-tiles-renderer/three", () => ({
	TilesRenderer: class FakeTiles {
		group: import("three").Group;
		lruCache = { maxBytesSize: 0, minBytesSize: 0, cachedBytes: 1234 };
		errorTarget = 0;
		visibleTiles = new Set<unknown>([1, 2]);
		stats = { downloading: 2, parsing: 1, failed: 4 };
		cameras = new Set<unknown>();
		handlers = new Map<string, ((e: unknown) => void)[]>();
		attributions: { type: string; value: unknown }[] = [];
		plugs: unknown[] = [];
		disposed = false;
		setCameraCalls = 0;
		updates = 0;
		constructor(public url?: string) {
			this.group = new (
				globalThis as unknown as { __THREE: typeof THREE }
			).__THREE.Group();
			h.renderers.push(this);
		}
		registerPlugin(p: unknown) {
			this.plugs.push(p);
			h.plugins.push({
				kind: (p as { name?: string }).name ?? p?.constructor?.name ?? "?",
				arg: p,
			});
		}
		addEventListener(name: string, fn: (e: unknown) => void) {
			this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
		}
		emit(name: string, e: unknown = {}) {
			for (const fn of this.handlers.get(name) ?? []) fn(e);
		}
		hasCamera(c: unknown) {
			return this.cameras.has(c);
		}
		setCamera(c: unknown) {
			this.cameras.add(c);
			this.setCameraCalls++;
		}
		setResolution() {}
		update() {
			this.updates++;
		}
		getAttributions() {
			return this.attributions;
		}
		dispose() {
			this.disposed = true;
		}
	},
}));
vi.mock("3d-tiles-renderer/core/plugins", () => ({
	GoogleCloudAuthPlugin: class GoogleCloudAuthPlugin {
		constructor(public opts: unknown) {}
	},
}));
vi.mock("3d-tiles-renderer/plugins", () => ({
	GLTFExtensionsPlugin: class GLTFExtensionsPlugin {
		constructor(public opts: unknown) {}
	},
	UnloadTilesPlugin: class UnloadTilesPlugin {
		constructor(public opts: unknown) {}
	},
}));
vi.mock("three/examples/jsm/loaders/DRACOLoader.js", () => ({
	DRACOLoader: class {
		path = "";
		setDecoderPath(p: string) {
			this.path = p;
		}
	},
}));
vi.mock("../config", async (orig) => ({
	...(await orig<typeof import("../config")>()),
	googleTilesKey: () => h.key,
}));

(globalThis as unknown as { __THREE: typeof THREE }).__THREE = THREE;

import {
	TILES3D_LAYER,
	TILES3D_SOURCES,
	type Tiles3DConfig,
	tiles3dConfig,
} from "../config";
import { enuFromEcef } from "../frame";
import { geoidUndulation } from "../geoid";
import { Tiles3DSet } from "../tiles";

type Fake = {
	url?: string;
	group: THREE.Group;
	lruCache: { maxBytesSize: number; minBytesSize: number };
	errorTarget: number;
	plugs: {
		name?: string;
		opts?: unknown;
		calculateTileViewError?: (
			tile: unknown,
			target: { inView: boolean },
		) => boolean;
		center?: THREE.Vector3;
		radius?: number;
	}[];
	emit: (n: string, e?: unknown) => void;
	setCameraCalls: number;
	updates: number;
	disposed: boolean;
	attributions: { type: string; value: unknown }[];
};

const cfg = (sources: Tiles3DConfig["sources"]): Tiles3DConfig => ({
	sources,
	blend: "fill",
	radius: 3000,
	fadeStart: 2200,
});
const LAT = 46.7;
const LON = 7.7;
const at = () => ({ lat: LAT, lon: LON, eye: new THREE.Vector3(10, 20, 30) });
const renderers = () => h.renderers as Fake[];

beforeEach(() => {
	h.key = undefined;
	h.renderers.length = 0;
	h.plugins.length = 0;
});
afterEach(() => vi.restoreAllMocks());

function meshWith(
	material: THREE.Material | THREE.Material[],
	withColor = false,
) {
	const g = new THREE.BufferGeometry();
	g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
	if (withColor)
		g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(9), 3));
	return new THREE.Mesh(g, material);
}

describe("Tiles3DSet construction", () => {
	it("makes one renderer per source with its url, error target and ENU placement", () => {
		const set = new Tiles3DSet(
			cfg(["swisstopo-buildings", "swisstopo-vegetation"]),
			at(),
		);
		const [b, v] = renderers();
		expect(b.url).toBe(TILES3D_SOURCES["swisstopo-buildings"].url);
		expect(v.url).toBe(TILES3D_SOURCES["swisstopo-vegetation"].url);
		expect(b.errorTarget).toBe(
			TILES3D_SOURCES["swisstopo-buildings"].errorTarget,
		);
		expect(set.group.name).toBe("tiles3d");
		expect(set.group.children).toHaveLength(2);
		expect(set.group.layers.isEnabled(TILES3D_LAYER)).toBe(true);
		expect(b.group.matrixAutoUpdate).toBe(false);
		// MSL source: ENU matrix without the geoid shift
		expect(b.group.matrix.equals(enuFromEcef(LAT, LON, 0))).toBe(true);
		expect(b.lruCache.maxBytesSize).toBeGreaterThan(b.lruCache.minBytesSize);
		expect(b.lruCache.maxBytesSize).toBeLessThan(0.4 * 2 ** 30);
	});

	it("copies the eye and the fade into the shared uniforms; caller uniforms win", () => {
		const own = { uOpacity: { value: 0.5 } };
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at(), own);
		expect(set.uniforms.uEye.value.toArray()).toEqual([10, 20, 30]);
		expect(set.uniforms.uFade.value.toArray()).toEqual([2200, 3000]);
		expect(set.uniforms.uOpacity).toBe(own.uOpacity);
	});

	it("uses the EGM2008 undulation", () => {
		expect(new Tiles3DSet(cfg(["swisstopo-buildings"]), at()).geoidN).toBe(
			geoidUndulation(LAT, LON),
		);
	});

	it("applies the geoid shift to ellipsoidal (Google) tiles only, and registers the auth plugin", () => {
		h.key = "k-123";
		const set = new Tiles3DSet(cfg(["google", "swisstopo-buildings"]), at());
		const [g, b] = renderers();
		expect(g.url).toBeUndefined(); // the Google plugin supplies the root
		expect(g.group.matrix.equals(enuFromEcef(LAT, LON, set.geoidN))).toBe(true);
		expect(b.group.matrix.equals(enuFromEcef(LAT, LON, 0))).toBe(true);
		const auth = g.plugs.find(
			(p) => p.opts && (p.opts as { apiToken?: string }).apiToken,
		);
		expect(auth?.opts).toEqual({ apiToken: "k-123", autoRefreshToken: true });
		expect(set.hasGoogle).toBe(true);
	});

	it("skips Google without a key", () => {
		const set = new Tiles3DSet(cfg(["google"]), at());
		expect(set.group.children).toHaveLength(0);
		expect(set.hasGoogle).toBe(false);
		expect(set.attributions()).toBe("");
	});
});

describe("near-field mask plugin", () => {
	it("hides tiles whose bounding volume is farther than the radius from the eye", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const mask = renderers()[0].plugs.find(
			(p) => p.name === "RIGI_NEARFIELD_MASK",
		);
		expect(mask).toBeDefined();
		expect(mask?.radius).toBe(3000);
		const tile = (d: number) => ({
			engineData: { boundingVolume: { distanceToPoint: () => d } },
		});
		const far = { inView: true };
		expect(mask?.calculateTileViewError?.(tile(5000), far)).toBe(true);
		expect(far.inView).toBe(false);
		const near = { inView: true };
		expect(mask?.calculateTileViewError?.(tile(100), near)).toBe(false);
		expect(near.inView).toBe(true);
		void set;
	});
	it("measures from the eye in the tileset's own (ECEF) frame", () => {
		new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const r = renderers()[0];
		const mask = r.plugs.find((p) => p.name === "RIGI_NEARFIELD_MASK");
		const expected = at().eye.applyMatrix4(enuFromEcef(LAT, LON, 0).invert());
		expect(mask?.center?.distanceTo(expected)).toBeLessThan(1e-6);
	});
});

describe("tile models", () => {
	it("replaces glTF materials with the tile material and bumps the version", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const onChange = vi.fn();
		set.onChange = onChange;
		const map = new THREE.Texture();
		const textured = meshWith(new THREE.MeshBasicMaterial({ map }));
		const coloured = meshWith(
			new THREE.MeshStandardMaterial({
				color: new THREE.Color(0.5, 0.25, 0.1),
			}),
		);
		const plain = meshWith(
			new THREE.MeshStandardMaterial({ color: 0xffffff }),
			true,
		);
		const scene = new THREE.Group();
		scene.add(textured, coloured, plain);
		renderers()[0].emit("load-model", { scene });
		for (const m of [textured, coloured, plain]) {
			expect((m.material as THREE.ShaderMaterial).name).toBe("tiles3d");
			expect(m.layers.isEnabled(TILES3D_LAYER)).toBe(true);
			expect(m.userData.tiles3dSource).toBe("swisstopo-buildings");
		}
		const um = (m: THREE.Mesh) => (m.material as THREE.ShaderMaterial).uniforms;
		expect(um(textured).uMap.value).toBe(map);
		expect(um(textured).uHasMap.value).toBe(1);
		// a coloured, untextured material keeps its colour; a white one takes the source's fallback
		expect((um(coloured).uColor.value as THREE.Color).g).toBeCloseTo(0.25, 5);
		const fb = TILES3D_SOURCES["swisstopo-buildings"].fallbackColor;
		expect((um(plain).uColor.value as THREE.Color).r).toBeCloseTo(fb[0], 5);
		expect((plain.material as THREE.ShaderMaterial).vertexColors).toBe(true);
		expect((textured.material as THREE.ShaderMaterial).vertexColors).toBe(
			false,
		);
		expect(um(textured).uDepthBias.value).toBe(
			TILES3D_SOURCES["swisstopo-buildings"].depthBias,
		);
		expect(set.version).toBe(1);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("?tiles3dBias overrides the source's depth bias", () => {
		withFlags({ tiles3dBias: "0.9" });
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const mesh = meshWith(new THREE.MeshBasicMaterial());
		renderers()[0].emit("load-model", { scene: mesh });
		expect(
			(mesh.material as THREE.ShaderMaterial).uniforms.uDepthBias.value,
		).toBe(0.9);
		void set;
	});

	it("frees materials and textures on dispose-model and tells the mesh hooks", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const mesh = meshWith(
			new THREE.MeshBasicMaterial({ map: new THREE.Texture() }),
		);
		renderers()[0].emit("load-model", { scene: mesh });
		const mat = mesh.material as THREE.ShaderMaterial;
		const matDispose = vi.spyOn(mat, "dispose");
		const texDispose = vi.spyOn(
			mat.uniforms.uMap.value as THREE.Texture,
			"dispose",
		);
		const hook = vi.fn();
		set.onDisposeMesh.add(hook);
		const v0 = set.version;
		renderers()[0].emit("dispose-model", { scene: mesh });
		expect(hook).toHaveBeenCalledWith(mesh);
		expect(matDispose).toHaveBeenCalled();
		expect(texDispose).toHaveBeenCalled();
		expect(set.version).toBe(v0 + 1);
	});

	it("visibility changes bump the version; needs-update only asks for a frame; errors warn", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const onChange = vi.fn();
		set.onChange = onChange;
		renderers()[0].emit("tile-visibility-change");
		expect(set.version).toBe(1);
		renderers()[0].emit("needs-update");
		expect(set.version).toBe(1);
		expect(onChange).toHaveBeenCalledTimes(2);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		renderers()[0].emit("load-error", { error: "404" });
		expect(warn.mock.calls[0][0]).toContain("swisstopo-buildings: 404");
	});
});

describe("visibleMeshes, sources and credits", () => {
	it("lists visible meshes with their source and honours per-source and group visibility", () => {
		const set = new Tiles3DSet(
			cfg(["swisstopo-buildings", "swisstopo-vegetation"]),
			at(),
		);
		const a = meshWith(new THREE.MeshBasicMaterial());
		const b = meshWith(new THREE.MeshBasicMaterial());
		const hidden = meshWith(new THREE.MeshBasicMaterial());
		hidden.visible = false;
		const [rb, rv] = renderers();
		rb.group.add(a, hidden);
		rv.group.add(b);
		expect(set.visibleMeshes().map((x) => [x.mesh, x.source.id])).toEqual([
			[a, "swisstopo-buildings"],
			[b, "swisstopo-vegetation"],
		]);
		set.setSourceVisible("swisstopo-vegetation", false);
		expect(set.visibleMeshes().map((x) => x.mesh)).toEqual([a]);
		set.setSourceVisible("swisstopo-vegetation", true);
		set.group.visible = false;
		expect(set.visibleMeshes()).toEqual([]);
	});

	it("builds the credit line: static credits, Google's attributions first", () => {
		h.key = "k";
		const set = new Tiles3DSet(cfg(["google", "swisstopo-buildings"]), at());
		const g = renderers()[0];
		expect(set.attributions()).toBe(
			"Google · Buildings © swisstopo".replace(
				"Buildings © swisstopo",
				TILES3D_SOURCES["swisstopo-buildings"].credit,
			),
		);
		g.attributions = [
			{ type: "string", value: "Data SIO, NOAA" },
			{ type: "image", value: "logo.png" },
			{ type: "string", value: "" },
			{ type: "string", value: "Maxar" },
		];
		expect(set.attributions()).toBe(
			`Google · Data SIO, NOAA; Maxar · ${TILES3D_SOURCES["swisstopo-buildings"].credit}`,
		);
		g.attributions = [{ type: "string", value: "© Google Earth" }];
		expect(set.attributions().startsWith("© Google Earth")).toBe(true);
	});

	it("reports per-source stats", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		expect(set.stats()).toEqual([
			{
				source: "swisstopo-buildings",
				visible: 2,
				loading: 3,
				failed: 4,
				bytes: 1234,
			},
		]);
	});
});

describe("update and dispose", () => {
	it("points each renderer at the camera once, then refines every frame", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const cam = new THREE.PerspectiveCamera();
		set.update(cam, 800, 600);
		set.update(cam, 800, 600);
		const r = renderers()[0];
		expect(r.setCameraCalls).toBe(1);
		expect(r.updates).toBe(2);
	});

	it("dispose frees the renderers, detaches the group and silences later updates", () => {
		const set = new Tiles3DSet(cfg(["swisstopo-buildings"]), at());
		const parent = new THREE.Group();
		parent.add(set.group);
		const onChange = vi.fn();
		set.onChange = onChange;
		set.dispose();
		set.dispose();
		const r = renderers()[0];
		expect(r.disposed).toBe(true);
		expect(set.group.parent).toBeNull();
		expect(set.stats()).toEqual([]);
		set.update(new THREE.PerspectiveCamera(), 1, 1);
		expect(r.updates).toBe(0);
	});
});

describe("config round trip", () => {
	it("a set built from the flag config uses its blend and sources", () => {
		withFlags({ tiles3d: "buildings" });
		const c = tiles3dConfig();
		expect(c).not.toBeNull();
		const set = new Tiles3DSet(c as Tiles3DConfig, at());
		expect(set.group.children).toHaveLength(1);
	});
});
