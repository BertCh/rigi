// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device, Texture } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mask8 } from "#/lib/look/composite";
import { gridSize, MASK_LONG_SIDE } from "#/lib/look/composite";
import { presetStyle } from "#/lib/style/presets";
import type { ViewStyle } from "#/lib/style/types";
import { withFlags } from "#/test/helpers";
import { LookBridge } from "../compute-bridge";
import {
	attachFrameTimings,
	currentFrameTimings,
	frameTimingsSupported,
	getFrameTimings,
	passTimestamps,
} from "../frame-timings";
import { ReleaseTimer } from "../imagery";
import {
	GEOMETRY_DEBOUNCE_MS,
	GeometryGenerations,
	terrainCoresOf,
} from "../layers/geometry-source";
import { DEFAULT_TILES3D_OPTIONS, tiles3dCoreOptions } from "../layers/tiles3d";
import {
	ModelCache,
	modelEpoch,
	PASS_ORDER,
	passModelProps,
	setColorSamples,
	targetKey,
} from "../pass";
import { rangeOf } from "../readback";
import {
	DrawBundle,
	getRenderBundleTargetKey,
	modelBundleKeys,
	RenderBundleSet,
	type RenderBundleTarget,
	recordModels,
} from "../render-bundle";
import {
	type TerrainShaderPart,
	terrainDefines,
	terrainModules,
	terrainSource,
} from "../terrain";

// The bridge warms its compute pipelines on construction; a fake device cannot build them.
vi.mock("#/lib/gpu/look/textures", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/lib/gpu/look/textures")>()),
	warmTextureKernelsAsync: async () => 0,
}));

describe("render bundles", () => {
	const target: RenderBundleTarget = {
		colorFormats: ["rgba16float", null],
		depthFormat: "depth32float",
		sampleCount: 1,
	};

	it("target keys are stable and distinguish every field", () => {
		const k = getRenderBundleTargetKey(target);
		expect(k).toBe(getRenderBundleTargetKey({ ...target }));
		expect(k).toContain("null");
		const variants = [
			{ ...target, depthFormat: false as const },
			{ ...target, sampleCount: 4 },
			{ ...target, depthReadOnly: true },
			{ ...target, stencilReadOnly: true },
			{ ...target, colorFormats: ["rgba8unorm" as const] },
		];
		const keys = new Set([k, ...variants.map(getRenderBundleTargetKey)]);
		expect(keys.size).toBe(variants.length + 1);
		expect(
			getRenderBundleTargetKey({ ...target, depthFormat: false }),
		).toContain("nodepth");
	});

	function fakeDevice() {
		const made: { destroyed: boolean; finished: boolean }[] = [];
		const device = {
			createRenderBundleEncoder: () => {
				const enc = {
					destroyed: false,
					finished: false,
					destroy() {
						this.destroyed = true;
					},
					finish() {
						this.finished = true;
						const b = {
							destroyed: false,
							destroy() {
								this.destroyed = true;
							},
						};
						made.push(b as never);
						return b;
					},
				};
				return enc;
			},
		} as unknown as Device;
		return { device, made };
	}

	it("DrawBundle records once per key set and re-records when keys change", () => {
		const { device, made } = fakeDevice();
		const record = vi.fn(() => true);
		const b = new DrawBundle(device, "b", target, record);
		const k1 = [1, "a"];
		const first = b.get(k1);
		expect(first).not.toBeNull();
		expect(b.get([1, "a"])).toBe(first);
		expect(b.stats).toEqual({ records: 1, hits: 1, incomplete: 0 });
		expect(record).toHaveBeenCalledTimes(1);
		const second = b.get([1, "b"]);
		expect(second).not.toBe(first);
		expect((first as unknown as { destroyed: boolean }).destroyed).toBe(true);
		expect(b.stats.records).toBe(2);
		expect(made.length).toBe(2);
		b.discard();
		expect((second as unknown as { destroyed: boolean }).destroyed).toBe(true);
		b.get([1, "b"]);
		expect(b.stats.records).toBe(3);
	});

	it("an incomplete recording is never cached and never executed", () => {
		const { device } = fakeDevice();
		let complete = false;
		const b = new DrawBundle(device, "b", target, () => complete);
		const pass = { executeBundles: vi.fn() };
		expect(b.execute(pass as never, [1])).toBe(false);
		expect(b.execute(pass as never, [1])).toBe(false);
		expect(b.stats.incomplete).toBe(2);
		expect(pass.executeBundles).not.toHaveBeenCalled();
		complete = true;
		expect(b.execute(pass as never, [1])).toBe(true);
		expect(pass.executeBundles).toHaveBeenCalledTimes(1);
	});

	it("a throwing recorder destroys its encoder and rethrows", () => {
		const encoders: { destroyed: boolean }[] = [];
		const device = {
			createRenderBundleEncoder: () => {
				const e = {
					destroyed: false,
					destroy() {
						this.destroyed = true;
					},
					finish: () => ({ destroy() {} }),
				};
				encoders.push(e);
				return e;
			},
		} as unknown as Device;
		const b = new DrawBundle(device, "b", target, () => {
			throw new Error("boom");
		});
		expect(() => b.get([])).toThrow("boom");
		expect(encoders[0].destroyed).toBe(true);
	});

	it("RenderBundleSet keeps a variant per target and sums stats", () => {
		const { device } = fakeDevice();
		const set = new RenderBundleSet(device, "s", () => true);
		const msaa = { ...target, sampleCount: 1 };
		const drag = { ...target, colorFormats: ["rgba8unorm" as const] };
		const pass = { executeBundles: vi.fn() };
		set.execute(pass as never, msaa, [1]);
		set.execute(pass as never, msaa, [1]);
		set.execute(pass as never, drag, [1]);
		expect(set.size).toBe(2);
		expect(set.stats).toEqual({ records: 2, hits: 1, incomplete: 0 });
		set.invalidateAll();
		set.execute(pass as never, msaa, [1]);
		expect(set.stats.records).toBe(3);
		set.destroy();
		expect(set.size).toBe(0);
	});

	it("recordModels reports whether every draw happened; modelBundleKeys lists identities", () => {
		const draws: string[] = [];
		const m = (id: string, ok: boolean) =>
			({
				draw: () => {
					draws.push(id);
					return ok;
				},
				pipeline: { id },
				vertexArray: { id },
				bindings: { z: 1, a: 2 },
			}) as unknown as Model;
		expect(recordModels({} as never, [m("a", true), m("b", true)])).toBe(true);
		expect(recordModels({} as never, [m("c", false), m("d", true)])).toBe(
			false,
		);
		expect(draws).toEqual(["a", "b", "c", "d"]); // a skipped draw does not stop the rest
		const model = m("a", true);
		const keys = modelBundleKeys(model);
		expect(keys.length).toBe(5);
		expect(keys[0]).toBe(model);
		expect(keys.slice(3)).toEqual([2, 1]); // bindings sorted by name: a, z
	});
});

describe("ReleaseTimer", () => {
	let now = 0;
	let pending: { fn: () => void; at: number; id: number } | null = null;
	let nextId = 1;
	const host = {
		now: () => now,
		setTimeout: (fn: () => void, ms: number) => {
			pending = { fn, at: now + ms, id: nextId++ };
			return pending.id;
		},
		clearTimeout: (h: unknown) => {
			if (pending?.id === h) pending = null;
		},
	};
	const advance = (ms: number) => {
		now += ms;
		if (pending && pending.at <= now) {
			const p = pending;
			pending = null;
			p.fn();
		}
	};
	beforeEach(() => {
		now = 0;
		pending = null;
	});

	it("fires once after the first arm; later arms keep the first deadline", () => {
		const fired = vi.fn();
		const t = new ReleaseTimer(fired, host);
		expect(t.armed).toBe(false);
		t.arm(1000);
		t.arm(5000);
		expect(t.armed).toBe(true);
		advance(999);
		expect(fired).not.toHaveBeenCalled();
		advance(1);
		expect(fired).toHaveBeenCalledTimes(1);
		expect(t.armed).toBe(false);
	});

	it("cancel disarms", () => {
		const fired = vi.fn();
		const t = new ReleaseTimer(fired, host);
		t.arm(100);
		t.cancel();
		t.cancel();
		advance(1000);
		expect(fired).not.toHaveBeenCalled();
		expect(t.armed).toBe(false);
	});

	it("a hold past the deadline defers the firing and re-arms for the remainder", () => {
		const fired = vi.fn();
		const t = new ReleaseTimer(fired, host);
		t.arm(100);
		t.holdUntil(350);
		t.holdUntil(200); // never shortens
		advance(100);
		expect(fired).not.toHaveBeenCalled();
		expect(t.deferrals).toBe(1);
		expect(t.armed).toBe(true);
		advance(249);
		expect(fired).not.toHaveBeenCalled();
		advance(1);
		expect(fired).toHaveBeenCalledTimes(1);
	});
});

describe("GeometryGenerations", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("window", globalThis);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const pose = { yaw: 0, pitch: 0, roll: 0, vfov: 40 };
	function make(extra: Record<string, unknown> = {}) {
		const src = {
			pose: null as typeof pose | null,
			render: vi.fn(async (p: typeof pose) => {
				src.pose = { ...p };
			}),
		};
		const onFresh = vi.fn();
		let canRender = true;
		const g = new GeometryGenerations({
			source: () => src as never,
			pose: () => pose,
			canRender: () => canRender,
			onFresh,
			...extra,
		});
		return { g, src, onFresh, setCan: (v: boolean) => (canRender = v) };
	}

	it("invalidate debounces one refresh and the buffer becomes ready", async () => {
		const { g, src, onFresh } = make();
		expect(g.ready()).toBe(false);
		g.invalidate();
		g.invalidate();
		g.invalidate();
		expect(g.generation).toBe(3);
		await vi.advanceTimersByTimeAsync(GEOMETRY_DEBOUNCE_MS - 1);
		expect(src.render).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2);
		expect(src.render).toHaveBeenCalledTimes(1);
		expect(g.ready()).toBe(true);
		expect(onFresh).toHaveBeenCalledWith(3);
		g.invalidate();
		expect(g.ready()).toBe(false);
	});

	it("an interactive view or no terrain schedules nothing; readback forces it", async () => {
		let interactive = true;
		const { g, src } = make({ interactive: () => interactive });
		g.invalidate();
		await vi.advanceTimersByTimeAsync(1000);
		expect(src.render).not.toHaveBeenCalled();
		interactive = false;
		expect(await g.readback()).toBe(true);
		expect(src.render).toHaveBeenCalledTimes(1);
		expect(await g.readback()).toBe(true); // already fresh
		expect(src.render).toHaveBeenCalledTimes(1);
	});

	it("a pose change during the render supersedes it (not fresh), readback retries", async () => {
		let g: GeometryGenerations;
		const src = {
			pose: null as typeof pose | null,
			n: 0,
			async render(p: typeof pose) {
				this.n++;
				if (this.n === 1) g.invalidate(); // newer change while rendering
				this.pose = { ...p };
			},
		};
		g = new GeometryGenerations({
			source: () => src as never,
			pose: () => pose,
			canRender: () => true,
		});
		g.invalidate();
		expect(await g.refresh()).toBe(false);
		expect(await g.readback()).toBe(true);
		expect(src.n).toBe(2);
	});

	it("readback waits for the first successful refresh without terrain, and dispose releases waiters", async () => {
		const { g, setCan } = make();
		setCan(false);
		const waiting = g.readback();
		g.dispose();
		expect(await waiting).toBe(false);
		expect(g.ready()).toBe(false);
		expect(await g.refresh()).toBe(false);
		expect(await g.readback()).toBe(false);
	});

	it("a source that is not there yet or a pose that does not match leaves it stale", async () => {
		const g = new GeometryGenerations({
			source: () => null,
			pose: () => pose,
			canRender: () => true,
		});
		expect(await g.refresh()).toBe(false);
		const src = { pose: { ...pose, yaw: 5 }, render: async () => {} };
		const g2 = new GeometryGenerations({
			source: () => src as never,
			pose: () => pose,
			canRender: () => true,
		});
		expect(await g2.refresh()).toBe(false);
	});

	it("terrainCoresOf selects geometry-pass terrain cores by id", () => {
		const core = (id: string, passes: string[]) => ({ id, passes }) as never;
		const out = terrainCoresOf([
			core("terrain", ["geometry", "color"]),
			core("batched-terrain", ["geometry"]),
			core("trails", ["color"]),
			core("terrain-sky", ["geometry"]),
			core("terrain", ["color"]),
		]);
		expect(out.map((c) => c.id)).toEqual(["terrain", "batched-terrain"]);
	});
});

describe("terrain program assembly", () => {
	const part = (
		key: string,
		extra: Partial<TerrainShaderPart> = {},
	): TerrainShaderPart => ({ key, wgsl: `// ${key}`, ...extra });

	it("terrainSource splices the vertex, parts and plugin calls into the common source", () => {
		const src = terrainSource("fn vertexMain() {}", part("shade"), [
			part("fog", { apply: "fog_fn" }),
			part("noop"),
		]);
		expect(src).toContain("fn vertexMain() {}");
		expect(src).toContain("// shade");
		expect(src).toContain("// fog");
		expect(src).toContain("c = fog_fn(c, s);");
		expect(src).not.toContain("__TERRAIN");
		// no shading, no plugins: markers still removed
		expect(terrainSource("", null, [])).not.toContain("__TERRAIN");
	});

	it("terrainModules adds part modules once, after the three base ones", () => {
		const m = { name: "extra" } as never;
		const out = terrainModules([
			part("a", { modules: [m] }),
			part("b", { modules: [m] }),
		]);
		expect(out.map((x) => x.name).slice(0, 3)).toEqual([
			"camera",
			"fog",
			"terrain",
		]);
		expect(out.filter((x) => x.name === "extra").length).toBe(1);
	});

	it("terrainDefines: geometry pass ignores part defines; colour merges them", () => {
		const parts = [
			part("a", { defines: { X: true } }),
			part("b", { defines: { Y: 2 } }),
			part("c"),
		];
		expect(terrainDefines("geometry", parts)).toEqual({ GEOMETRY_PASS: true });
		expect(terrainDefines("color", parts)).toEqual({ X: true, Y: 2 });
	});
});

describe("pass helpers", () => {
	it("passModelProps: geometry has no blend, colour blends premultiplied only when asked", () => {
		const g = passModelProps("geometry");
		expect((g.parameters as Record<string, unknown>).blend).toBeUndefined();
		const c = passModelProps("color", { blend: true });
		expect((c.parameters as Record<string, unknown>).blend).toBe(true);
		expect((c.parameters as Record<string, unknown>).blendColorSrcFactor).toBe(
			"one",
		);
		expect(
			(passModelProps("color").parameters as Record<string, unknown>).blend,
		).toBeUndefined();
		expect(
			(
				passModelProps("geometry", { blend: true }).parameters as Record<
					string,
					unknown
				>
			).blend,
		).toBeUndefined();
		expect(c.shaderAssembler).toBeDefined();
		expect(PASS_ORDER).toEqual(["geometry", "color", "screen"]);
	});

	it("depth mode selects the reversed-Z parameter set", () => {
		const write = passModelProps("color").parameters as Record<string, unknown>;
		const test = passModelProps("color", { depth: "test" })
			.parameters as Record<string, unknown>;
		const none = passModelProps("color", { depth: "none" })
			.parameters as Record<string, unknown>;
		expect(write.depthWriteEnabled).toBe(true);
		expect(test.depthWriteEnabled).toBe(false);
		expect(none.depthCompare ?? "always").toBe("always");
	});

	it("ModelCache creates once per key, invalidates by prefix and bumps the epoch", () => {
		setColorSamples(4);
		const cache = new ModelCache();
		const destroyed: string[] = [];
		const mk = (id: string) => () =>
			({ destroy: () => destroyed.push(id) }) as unknown as Model;
		const e0 = modelEpoch();
		const a = cache.get("terrain|x", mk("a"));
		expect(cache.get("terrain|x", mk("zzz"))).toBe(a);
		cache.get("trail|x", mk("b"));
		expect(modelEpoch()).toBe(e0 + 2);
		expect(cache.entries("terrain").length).toBe(1);
		cache.invalidate("terrain");
		expect(destroyed).toEqual(["a"]);
		expect(cache.entries().length).toBe(1);
		// 1x variant coexists with the MSAA one and does not bump the epoch
		setColorSamples(1);
		const e1 = modelEpoch();
		const one = cache.get("trail|x", mk("b1"));
		expect(one).not.toBe(cache.entries("trail")[0]?.[1] ?? null);
		expect(modelEpoch()).toBe(e1);
		setColorSamples(4);
		cache.destroy();
		expect(cache.entries().length).toBe(0);
	});

	it("targetKey joins kind, formats, depth and samples", () => {
		const ctx = {
			kind: "color",
			target: {
				colorFormats: ["rgba16float", "rgba8unorm"],
				depthFormat: "depth32float",
				samples: 4,
			},
		} as never;
		expect(targetKey(ctx)).toBe("color|rgba16float,rgba8unorm|depth32float|4");
	});

	it("rangeOf takes the w channel", () => {
		expect(
			Array.from(rangeOf(new Float32Array([1, 2, 3, 10, 4, 5, 6, 20]))),
		).toEqual([10, 20]);
		expect(rangeOf(new Float32Array(0)).length).toBe(0);
	});
});

describe("frame timings host", () => {
	const fakeDevice = (features: string[], type = "webgpu") =>
		({
			type,
			features: new Set(features),
			createQuerySet: vi.fn(() => ({
				destroy() {},
				readResults: async () => new BigUint64Array([0n, 2_000_000n]),
			})),
		}) as unknown as Device;

	it("is off unless the flag is on, and needs timestamp-query", () => {
		const d = fakeDevice(["timestamp-query"]);
		expect(frameTimingsSupported(d)).toBe(true);
		expect(frameTimingsSupported(fakeDevice([]))).toBe(false);
		expect(
			frameTimingsSupported(fakeDevice(["timestamp-query"], "webgl")),
		).toBe(false);
		expect(attachFrameTimings(d)).toBeNull();
		expect(passTimestamps(d, "x")).toEqual({});
		withFlags({ gpuFrameTimings: "on" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(attachFrameTimings(fakeDevice([]))).toBeNull();
		expect(warn).toHaveBeenCalled();
	});

	it("times a frame end to end through a fake query set", async () => {
		withFlags({ gpuFrameTimings: "on" });
		const d = fakeDevice(["timestamp-query"]);
		const t = attachFrameTimings(d);
		expect(t).not.toBeNull();
		expect(attachFrameTimings(d)).toBe(t);
		expect(getFrameTimings(d)).toBe(t);
		const seen: number[] = [];
		(t as NonNullable<typeof t>).onFrameTimings((f) => seen.push(f.totalGpuMs));
		(t as NonNullable<typeof t>).beginFrame(1);
		const props = passTimestamps(d, "geometry");
		expect(props.beginTimestampIndex).toBe(0);
		expect(props.endTimestampIndex).toBe(1);
		(t as NonNullable<typeof t>).endFrame(Promise.resolve());
		await new Promise((r) => setTimeout(r, 0));
		expect(seen).toEqual([2]);
		expect((t as NonNullable<typeof t>).latest?.passes[0].name).toBe(
			"geometry",
		);
		expect((t as NonNullable<typeof t>).mean().totalGpuMs).toBeCloseTo(2);
		(t as NonNullable<typeof t>).destroy();
		expect(getFrameTimings(d)).toBeUndefined();
		void currentFrameTimings();
	});

	it("a failed readback disables the timer instead of throwing", async () => {
		withFlags({ gpuFrameTimings: "on" });
		const d = {
			type: "webgpu",
			features: new Set(["timestamp-query"]),
			createQuerySet: () => ({
				destroy() {},
				readResults: async () => {
					throw new Error("map failed");
				},
			}),
		} as unknown as Device;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const t = attachFrameTimings(d);
		t?.beginFrame(1);
		passTimestamps(d, "color");
		t?.endFrame(Promise.resolve());
		await new Promise((r) => setTimeout(r, 0));
		expect(t?.disabledReason).toMatch(/map failed/);
		expect(warn).toHaveBeenCalled();
		t?.beginFrame(2);
		expect(passTimestamps(d, "color")).toEqual({});
		t?.destroy();
	});
});

describe("tiles3d options", () => {
	it("config blend decides fill; no config leaves defaults alone", () => {
		expect(tiles3dCoreOptions(null)).toEqual({});
		expect(tiles3dCoreOptions({ blend: "fill" } as never)).toEqual({
			fill: true,
		});
		expect(tiles3dCoreOptions({ blend: "over" } as never)).toEqual({
			fill: false,
		});
		expect(DEFAULT_TILES3D_OPTIONS.fill).toBe(true);
	});
});

// ── LookBridge settle fusion (a fake device whose textures are plain objects; ports
// compute-bridge-fusion.check.ts to Vitest)
describe("LookBridge mask pool and adoption", () => {
	type FakeTex = {
		id: string;
		width: number;
		height: number;
		destroyed: boolean;
		destroy: () => void;
	};
	const device = {
		type: "webgpu",
		isLost: false,
		createTexture: (p: { id: string; width: number; height: number }) => {
			const t: FakeTex = {
				id: p.id,
				width: p.width,
				height: p.height,
				destroyed: false,
				destroy: () => {
					t.destroyed = true;
				},
			};
			return t;
		},
	} as unknown as Device;

	type Internals = {
		outs: (Texture | null)[];
		writing: number[];
		shown: number;
		prepared: {
			seq: number;
			geometry: Texture;
			img: HTMLImageElement;
			fg: Mask8 | null;
			sky: Mask8 | null;
			w: number;
			h: number;
			slot: number;
			texture: Texture;
			cpuMs: number;
		} | null;
		maskSeq: number;
		pickOut: (idle: boolean) => number;
		outTexture: (i: number, w: number, h: number) => Texture;
	};
	const inside = (b: LookBridge) => b as unknown as Internals;

	const style: ViewStyle = presetStyle("photo-matched");
	const skyStyle = style.composite.sky === "photo";
	const geometry = device.createTexture({
		id: "geo",
		width: 1024,
		height: 683,
	} as never) as unknown as Texture;
	const [w, h] = gridSize(1024 / 683, MASK_LONG_SIDE);
	const img = {} as HTMLImageElement;
	const fg = { width: 4, height: 4, data: new Uint8Array(16) } as Mask8;
	const sky = { width: 4, height: 4, data: new Uint8Array(16) } as Mask8;

	function bridgeWithPrepared() {
		const b = new LookBridge(device);
		const x = inside(b);
		const texture = x.outTexture(0, w, h);
		x.prepared = {
			seq: 7,
			geometry,
			img,
			fg,
			sky: skyStyle ? sky : null,
			w,
			h,
			slot: 0,
			texture,
			cpuMs: 1,
		};
		return { b, x, texture };
	}
	type Call = Parameters<LookBridge["updateMasks"]>[0];
	const call: Call = {
		style,
		gen: 3,
		img,
		fg,
		sky,
		cut: null,
		geometry,
		geometrySeq: 7,
		range: () => ({ w: 1, h: 1, at: () => 0 }),
	};

	it("pickOut never hands out the shown or prepared texture, idle picks skip written ones", () => {
		const b = new LookBridge(device);
		const x = inside(b);
		expect(x.pickOut(true)).toBe(0);
		for (let i = 0; i < 4; i++) x.outTexture(i, 8, 8);
		x.shown = 0;
		x.prepared = { slot: 1 } as never;
		x.writing = [0, 0, 1, 0];
		expect(x.pickOut(true)).toBe(3);
		expect(x.pickOut(false)).toBe(3);
		x.writing = [0, 0, 1, 1];
		expect(x.pickOut(true)).toBe(-1);
		expect(x.pickOut(false)).toBe(2);
	});

	it("matching inputs adopt the prepared texture exactly once", async () => {
		const { b, x, texture } = bridgeWithPrepared();
		let fired = 0;
		b.onAsync = () => fired++;
		const seq0 = x.maskSeq;
		expect(b.updateMasks(call)).toBe(true);
		expect(b.masks?.texture).toBe(texture);
		expect(b.masks?.gen).toBe(3);
		expect(b.masks?.cut).toBe("");
		expect(x.shown).toBe(0);
		expect(x.prepared).toBeNull();
		expect(x.maskSeq).toBe(seq0 + 1);
		expect(b.fused.masksAdopted).toBe(1);
		expect(b.updateMasks(call)).toBe(false);
		await Promise.resolve();
		expect(fired).toBe(1);
	});

	const mismatches: [string, Partial<Call>][] = [
		["render seq", { geometrySeq: 8 }],
		["no render seq", { geometrySeq: undefined }],
		["geometry texture", { geometry: { ...geometry } as Texture }],
		["photo", { img: {} as HTMLImageElement }],
		["people", { fg: null }],
		["blend cut", { cut: { key: "range:8", at: () => 0 } }],
	];
	if (skyStyle) mismatches.push(["P(sky)", { sky: null }]);
	for (const [what, change] of mismatches)
		it(`a different ${what} adopts nothing and keeps the prepared pass`, () => {
			const { b, x, texture } = bridgeWithPrepared();
			try {
				b.updateMasks({ ...call, ...change });
			} catch {
				// the separate pass needs a canvas / real device: it throws, which is fine here
			}
			expect(b.masks).toBeNull();
			expect(x.prepared?.texture).toBe(texture);
			expect(b.fused.masksAdopted).toBe(0);
		});

	it("fusion off drops the prepared pass and prepares nothing", () => {
		const { b, x } = bridgeWithPrepared();
		b.fusionOn = () => false;
		try {
			b.updateMasks(call);
		} catch {}
		expect(b.masks).toBeNull();
		expect(x.prepared).toBeNull();
		const r = b.prepareMasks({
			seq: 9,
			style,
			img,
			fg,
			sky,
			geometry,
			encoder: {} as never,
		});
		expect(r).toBeNull();
		expect(x.prepared).toBeNull();
	});

	it("reset() and a refine-off prepare drop a pending prepared pass", () => {
		const a = bridgeWithPrepared();
		a.b.reset();
		expect(a.x.prepared).toBeNull();
		const c = bridgeWithPrepared();
		const off = {
			...style,
			composite: { ...style.composite, refine: false },
		} as ViewStyle;
		expect(
			c.b.prepareMasks({
				seq: 8,
				style: off,
				img,
				fg,
				sky,
				geometry,
				encoder: {} as never,
			}),
		).toBeFalsy();
		expect(c.x.prepared).toBeNull();
	});
});
