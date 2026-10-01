// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Feasibility spike (2026-09-30): can deck.gl 9.4 drive our custom layers on a WebGPU device?
// Kept as a reproducible diagnostic: /lab/deck-webgpu?spike=1 runs it and prints the report
// (window.__deckWebgpuSpike). It needs deck's FULL build: under the app's vite.config.ts
// (`visgl:webgl-only` condition) deck's WebGPU branches are compiled out, which the report
// detects (`deckBuild: "webgl-only"`). Serve with scripts/deck-webgpu/vite.webgpu.config.ts.
//
// Checks, each recorded pass / fail with the error text:
//   T1 Deck({deviceProps: {type: 'webgpu'}}) + our PhotoView (CARTESIAN ENU) + an OrthographicView
//      + layerFilter; a custom WGSL layer through deck's project32 module; a screen-view layer.
//   T2 the same Deck with a custom WGSL layer on OUR camera uniforms + reversed-Z (depth32float,
//      'greater', view clearDepth 0) drawn in deck's own canvas pass.
//   T3 _LayersPass into our own framebuffer: rgba32float + depth32float, reversed-Z; readback.
//   T4 _LayersPass into a 4× MSAA rgba16float framebuffer + a resolve pass; readback.
// Deliberately exercises deck internals (`_LayersPass`): a lab probe of deck.gl, not app code.
import {
	COORDINATE_SYSTEM,
	Deck,
	Layer,
	type LayerContext,
	_LayersPass as LayersPass,
	OrthographicView,
	project32,
} from "@deck.gl/core";
import type { Device, Framebuffer, RenderPass, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { webgpuAdapter } from "@luma.gl/webgpu";
import { PhotoView, PhotoViewport } from "#/lib/deck/photo-view";
import { cameraModule, cameraUniforms, photoCamera } from "./camera";
import { REVERSED_Z } from "./depth";
import { deckBuild } from "./device";

export type SpikeCheck = { id: string; ok: boolean; detail: string };
export type SpikeReport = {
	deckBuild: "full" | "webgl-only";
	adapter?: string;
	checks: SpikeCheck[];
	errors: string[];
	ms: number;
};

const POSE = { yaw: 0, pitch: -5, roll: 0, vfov: 50 };
const EYE: [number, number, number] = [0, 0, 100];

// A 2 km ground quad at z=0 (grey) and a wall 100 km north (blue): T1 via deck's project32.
const projectWGSL = /* wgsl */ `
struct Attributes { @location(0) positions: vec3<f32>, @location(1) colors: vec4<f32> };
struct Varyings { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32> };
@vertex fn vertexMain(a: Attributes) -> Varyings {
  var v: Varyings;
  v.position = project_position_to_clipspace(a.positions, vec3<f32>(0.0), vec3<f32>(0.0));
  v.color = a.colors;
  return v;
}
@fragment fn fragmentMain(v: Varyings) -> @location(0) vec4<f32> { return v.color; }
`;

// T2/T3/T4: the same geometry through the foundation's camera module (reversed-Z), writing
// ENU xyz + range (geometry) or colour, depending on the target.
const ownWGSL = /* wgsl */ `
struct Attributes { @location(0) positions: vec3<f32>, @location(1) colors: vec4<f32> };
struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) enu: vec3<f32>,
};
@vertex fn vertexMain(a: Attributes) -> Varyings {
  var v: Varyings;
  v.position = camera_clip(a.positions);
  v.color = a.colors;
  v.enu = a.positions;
  return v;
}
@fragment fn fragmentMain(v: Varyings) -> @location(0) vec4<f32> {
  if (SPIKE_GEOMETRY) { return vec4<f32>(v.enu, camera_range(v.enu)); }
  return v.color;
}
`;

function sceneBuffers(device: Device) {
	// two triangles each: ground (x ±1 km, y 0..2 km, z 0) and far wall (y 100 km, z 0..8 km)
	const g = [
		-1000, 50, 0, 1000, 50, 0, 1000, 2000, 0, -1000, 50, 0, 1000, 2000, 0,
		-1000, 2000, 0,
	];
	const w = [
		-60000, 100000, 0, 60000, 100000, 0, 60000, 100000, 8000, -60000, 100000, 0,
		60000, 100000, 8000, -60000, 100000, 8000,
	];
	const pos = new Float32Array([...g, ...w]);
	const col = new Float32Array(12 * 4);
	for (let i = 0; i < 12; i++)
		col.set(i < 6 ? [0.5, 0.5, 0.5, 1] : [0.2, 0.3, 0.9, 1], i * 4);
	return {
		positions: device.createBuffer({ data: pos }),
		colors: device.createBuffer({ data: col }),
	};
}

type SpikeProps = { variant: "project" | "own" | "geometry"; samples?: number };

class SpikeLayer extends Layer<SpikeProps> {
	static layerName = "SpikeLayer";
	declare state: { model?: Model };

	initializeState() {
		const device = this.context.device;
		const { positions, colors } = sceneBuffers(device);
		const own = this.props.variant !== "project";
		const samples = this.props.samples ?? 1;
		const source = own
			? ownWGSL.replace(
					"SPIKE_GEOMETRY",
					this.props.variant === "geometry" ? "true" : "false",
				)
			: projectWGSL;
		const model = new Model(device, {
			id: `${this.id}-model`,
			...(own
				? { source, modules: [cameraModule] }
				: this.getShaders({ source, modules: [project32] })),
			bufferLayout: [
				{ name: "positions", format: "float32x3" },
				{ name: "colors", format: "float32x4" },
			],
			attributes: { positions, colors },
			vertexCount: 12,
			topology: "triangle-list",
			parameters: {
				cullMode: "none",
				...(own ? REVERSED_Z.parameters : {}),
				...(samples > 1 ? { sampleCount: samples } : {}),
			},
		});
		this.setState({ model });
	}

	getModels() {
		return this.state.model ? [this.state.model] : [];
	}

	draw({ renderPass }: { renderPass: RenderPass }) {
		const model = this.state.model;
		if (!model) return;
		if (this.props.variant !== "project") {
			const vp = this.context.viewport as PhotoViewport;
			model.shaderInputs.setProps({
				camera: cameraUniforms(
					photoCamera({
						pose: vp.pose,
						eye: vp.eye,
						width: vp.width,
						height: vp.height,
					}),
				),
			});
		}
		model.draw(renderPass);
	}

	finalizeState(context: LayerContext) {
		this.state.model?.destroy();
		super.finalizeState(context);
	}
}

const screenWGSL = /* wgsl */ `
struct Varyings { @builtin(position) position: vec4<f32> };
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> Varyings {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(-0.8, -1.0), vec2(-1.0, -0.8));
  var v: Varyings;
  v.position = vec4<f32>(p[i], 0.5, 1.0);
  return v;
}
@fragment fn fragmentMain(v: Varyings) -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }
`;

class ScreenSpikeLayer extends Layer {
	static layerName = "ScreenSpikeLayer";
	declare state: { model?: Model };
	initializeState() {
		this.setState({
			model: new Model(this.context.device, {
				id: `${this.id}-model`,
				source: screenWGSL,
				vertexCount: 3,
				parameters: { depthCompare: "always", depthWriteEnabled: false },
			}),
		});
	}
	draw({ renderPass }: { renderPass: RenderPass }) {
		this.state.model?.draw(renderPass);
	}
	finalizeState(context: LayerContext) {
		this.state.model?.destroy();
		super.finalizeState(context);
	}
}

/** Read one texel (rgba float / half) back from a texture. */
async function readTexel(tex: Texture, x: number, y: number) {
	const buf = tex.device.createBuffer({
		byteLength: 256,
		usage: 0x0001 | 0x0008,
	}); // MAP_READ | COPY_DST
	tex.readBuffer({ x, y, width: 1, height: 1 }, buf);
	const bytes = await buf.readAsync(0, 256);
	buf.destroy();
	const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 16);
	if (tex.format === "rgba32float") return [...new Float32Array(data, 0, 4)];
	const u = new Uint16Array(data, 0, 4);
	return [...u].map(halfToFloat);
}

function halfToFloat(h: number) {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const f = h & 0x3ff;
	if (e === 0) return s * 2 ** -14 * (f / 1024);
	if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY;
	return s * 2 ** (e - 15) * (1 + f / 1024);
}

let running: Promise<SpikeReport> | null = null;

/** Runs once per page (React StrictMode mounts twice; a second Deck on the canvas would steal it). */
export function runSpike(canvas: HTMLCanvasElement): Promise<SpikeReport> {
	running ??= spike(canvas);
	return running;
}

async function spike(canvas: HTMLCanvasElement): Promise<SpikeReport> {
	const t0 = performance.now();
	const checks: SpikeCheck[] = [];
	const errors: string[] = [];
	const report: SpikeReport = { deckBuild: deckBuild(), checks, errors, ms: 0 };
	const check = async (id: string, fn: () => Promise<string> | string) => {
		try {
			checks.push({ id, ok: true, detail: await fn() });
		} catch (e) {
			checks.push({
				id,
				ok: false,
				detail: String((e as Error)?.message ?? e),
			});
		}
	};
	if (!(navigator as { gpu?: unknown }).gpu) {
		checks.push({ id: "webgpu", ok: false, detail: "navigator.gpu missing" });
		return report;
	}
	const w = canvas.clientWidth || 800;
	const h = canvas.clientHeight || 500;
	let device: Device | null = null;
	let deck: Deck | null = null;
	await check("T1 deck webgpu device", async () => {
		deck = new Deck({
			canvas,
			width: null,
			height: null,
			useDevicePixels: 1,
			deviceProps: {
				type: "webgpu",
				adapters: [webgpuAdapter],
				powerPreference: "high-performance",
				optionalFeatures: ["float32-blendable", "float32-filterable"],
				// luma routes WebGPU validation errors (popErrorScope, async) here
				onError: (e: Error) => {
					errors.push(`gpu: ${e.message.slice(0, 300)}`);
					return false;
				},
			},
			views: [
				new PhotoView({ id: "photo", near: 1, far: 400_000 }),
				new OrthographicView({ id: "screen", flipY: true }),
			],
			viewState: {
				photo: { ...POSE, eye: EYE },
				screen: { target: [w / 2, h / 2, 0], zoom: 0 },
			},
			layerFilter: ({
				layer,
				viewport,
			}: {
				layer: { id: string };
				viewport: { id: string };
			}) =>
				!layer.id.startsWith("off-") &&
				layer.id.startsWith("screen-") === (viewport.id === "screen"),
			controller: false,
			onError: (e: Error) => errors.push(`deck: ${e.message}`),
		} as never);
		const d = deck as unknown as { device?: Device; animationLoop?: unknown };
		for (let i = 0; i < 200 && !d.device; i++)
			await new Promise((r) => setTimeout(r, 25));
		if (!d.device) throw new Error("no device after 5 s");
		device = d.device;
		const info = device.info;
		report.adapter = `${info.type} ${info.vendor} ${info.renderer}`;
		return `${device.type}, canvas ${w}×${h}, features: ${[...device.features].filter((f) => /float32|timestamp/.test(f)).join(" ")}`;
	});
	if (!deck || !device) return report;
	const deckR = deck as Deck;
	const dev = device as Device;
	let rendered = 0;
	deckR.setProps({ onAfterRender: () => rendered++ } as never);
	const raf = () => new Promise((r) => requestAnimationFrame(r));
	// deck applies new layers in its animation-loop frame (layerManager.updateLayers), then draws
	const frame = async () => {
		const n = rendered;
		await raf();
		await raf();
		if (rendered === n) deckR.redraw("spike");
		if (rendered === n) throw new Error("no frame rendered");
		// validation errors arrive asynchronously (error scopes): let them land in this check
		await (
			dev as unknown as { handle: GPUDevice }
		).handle.queue.onSubmittedWorkDone();
		await new Promise((r) => setTimeout(r, 20));
	};

	await check("T1 project32 layer + screen view + layerFilter", async () => {
		const before = errors.length;
		deckR.setProps({
			layers: [
				new SpikeLayer({
					id: "terrain-project",
					variant: "project",
					coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
				}),
				new ScreenSpikeLayer({ id: "screen-marker" }),
			],
		} as never);
		await frame();
		await frame();
		if (errors.length > before)
			throw new Error(errors.slice(before).join(" | "));
		return "drew without validation errors (see screenshot for pixels)";
	});

	await check(
		"T2 own-camera reversed-Z layer in deck's canvas pass",
		async () => {
			const before = errors.length;
			deckR.setProps({
				views: [
					new PhotoView({
						id: "photo",
						near: 1,
						far: 400_000,
						clear: true,
						clearDepth: 0,
					} as never),
					new OrthographicView({ id: "screen", flipY: true }),
				],
				layers: [
					new SpikeLayer({ id: "terrain-own", variant: "own" }),
					new ScreenSpikeLayer({ id: "screen-marker" }),
				],
			} as never);
			try {
				await frame();
				await frame();
			} finally {
				// put the views back (clear: true is what breaks, see below)
				deckR.setProps({
					views: [
						new PhotoView({ id: "photo", near: 1, far: 400_000 }),
						new OrthographicView({ id: "screen", flipY: true }),
					],
					layers: [],
				} as never);
				await frame().catch(() => {});
			}
			if (errors.length > before)
				throw new Error(errors.slice(before, before + 2).join(" | "));
			return "drew without validation errors";
		},
	);

	await check(
		"T2b own-camera layer in deck's canvas pass WITHOUT view clear (depth cleared to 1 by LayersPass)",
		async () => {
			const before = errors.length;
			deckR.setProps({
				layers: [new SpikeLayer({ id: "terrain-own", variant: "own" })],
			} as never);
			await frame();
			await frame();
			if (errors.length > before)
				throw new Error(errors.slice(before, before + 2).join(" | "));
			return "no validation errors; with depth cleared to 1 a 'greater-equal' test rejects every fragment (see T6 screenshot notes)";
		},
	);

	const vp = new PhotoViewport({
		id: "photo",
		...POSE,
		eye: EYE,
		x: 0,
		y: 0,
		width: 256,
		height: 160,
	});
	const runPass = (fbo: Framebuffer, layer: Layer) => {
		const pass = new LayersPass(dev, { id: "spike-pass" });
		// deck's LayersPass clears depth to 1 when clearCanvas; reversed-Z needs 0, so clear ourselves
		const clear = dev.beginRenderPass({
			framebuffer: fbo,
			clearColor: [0, 0, 0, 0],
			clearDepth: REVERSED_Z.clearDepth,
		});
		clear.end();
		pass.render({
			layers: [layer],
			viewports: [vp],
			views: {},
			onViewportActive: (v: unknown) =>
				(
					deckR as unknown as {
						layerManager: { activateViewport(v: unknown): void };
					}
				).layerManager.activateViewport(v),
			target: fbo,
			pass: "spike",
			clearCanvas: false,
			clearColor: false,
			layerFilter: null,
			shaderModuleProps: { project: { devicePixelRatio: 1 } },
		} as never);
		dev.submit();
	};
	const liveLayer = async (props: SpikeProps & { id: string }) => {
		// a layer must be initialised by a LayerManager: add it to the Deck, then pull it back out
		// deck's WebGPU LayersPass merges WEBGPU_DEFAULT_DRAW_PARAMETERS (premultiplied blending,
		// depthCompare 'less-equal') over the model's own parameters; only layer.props.parameters win
		deckR.setProps({
			layers: [
				new SpikeLayer({
					...props,
					parameters: {
						...REVERSED_Z.parameters,
						// blend:false can't remove deck's default blend state on WebGPU; make it a
						// pass-through (still needs a blendable format: float32-blendable)
						...(props.variant === "geometry"
							? {
									blendColorSrcFactor: "one",
									blendColorDstFactor: "zero",
									blendAlphaSrcFactor: "one",
									blendAlphaDstFactor: "zero",
								}
							: {}),
					},
				} as never),
			],
		} as never);
		const lm = () =>
			(deckR as unknown as { layerManager: { getLayers(): Layer[] } })
				.layerManager;
		for (let i = 0; i < 60; i++) {
			await frame();
			const l = lm()
				.getLayers()
				.find((x) => x.id === props.id);
			if (l && (l.state as { model?: unknown }).model) return l;
		}
		const seen = lm()
			.getLayers()
			.map(
				(x) => `${x.id}:${!!(x.state as { model?: unknown } | null)?.model}`,
			);
		throw new Error(`layer not initialised (layers: ${seen.join(",")})`);
	};

	await check(
		"T3 _LayersPass → rgba32float + depth32float (reversed-Z) + readback",
		async () => {
			const before = errors.length;
			const color = dev.createTexture({
				format: "rgba32float",
				width: 256,
				height: 160,
				usage: 0x10 | 0x04 | 0x01 | 0x02,
			});
			const depth = dev.createTexture({
				format: "depth32float",
				width: 256,
				height: 160,
				usage: 0x10,
			});
			const fbo = dev.createFramebuffer({
				width: 256,
				height: 160,
				colorAttachments: [color],
				depthStencilAttachment: depth,
			});
			const layer = await liveLayer({ id: "off-geo", variant: "geometry" });
			runPass(fbo, layer);
			const ground = await readTexel(color, 128, 150);
			const sky = await readTexel(color, 128, 5);
			const wall = await readTexel(color, 128, 60);
			if (errors.length > before)
				throw new Error(errors.slice(before).join(" | "));
			const fmt = (v: number[]) => v.map((x) => x.toFixed(1)).join(",");
			return `ground ${fmt(ground)} | wall ${fmt(wall)} | sky ${fmt(sky)}`;
		},
	);

	await check("T4 _LayersPass → 4× MSAA rgba16float + resolve", async () => {
		const before = errors.length;
		const ms = dev.createTexture({
			format: "rgba16float",
			width: 256,
			height: 160,
			samples: 4,
			usage: 0x10,
		});
		const msDepth = dev.createTexture({
			format: "depth32float",
			width: 256,
			height: 160,
			samples: 4,
			usage: 0x10,
		});
		const resolve = dev.createTexture({
			format: "rgba16float",
			width: 256,
			height: 160,
			usage: 0x10 | 0x04 | 0x01 | 0x02,
		});
		const fbo = dev.createFramebuffer({
			width: 256,
			height: 160,
			colorAttachments: [ms],
			depthStencilAttachment: msDepth,
		});
		const layer = await liveLayer({
			id: "off-col",
			variant: "own",
			samples: 4,
		});
		runPass(fbo, layer);
		const rp = dev.beginRenderPass({
			framebuffer: fbo,
			clearColor: false,
			clearDepth: false,
			resolveTargets: [resolve],
		} as never);
		rp.end();
		dev.submit();
		const ground = await readTexel(resolve, 128, 150);
		const wall = await readTexel(resolve, 128, 60);
		if (errors.length > before)
			throw new Error(errors.slice(before).join(" | "));
		return `ground ${ground.map((x) => x.toFixed(2))} | wall ${wall.map((x) => x.toFixed(2))}`;
	});

	await check("T5 frame time (deck canvas pass, 60 redraws)", async () => {
		deckR.setProps({
			layers: [
				new SpikeLayer({ id: "terrain-own", variant: "own" }),
				new ScreenSpikeLayer({ id: "screen-marker" }),
			],
		} as never);
		await frame();
		const s = performance.now();
		for (let i = 0; i < 60; i++) deckR.redraw("bench");
		await (
			dev as unknown as { handle: GPUDevice }
		).handle.queue.onSubmittedWorkDone();
		return `${((performance.now() - s) / 60).toFixed(3)} ms per redraw (CPU encode + GPU, 60 synchronous redraws)`;
	});
	await check(
		"T6 final canvas: project32 ground (grey) + wall (blue) + screen marker (red)",
		async () => {
			deckR.setProps({
				layers: [
					new SpikeLayer({
						id: "terrain-project",
						variant: "project",
						coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
					}),
					new ScreenSpikeLayer({ id: "screen-marker" }),
				],
			} as never);
			await frame();
			await frame();
			return "see screenshot";
		},
	);
	report.ms = Math.round(performance.now() - t0);
	return report;
}
