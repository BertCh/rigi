// GPU geometry pass for the deck backend: the terrain tiles of a live Deck, rendered through the
// photo camera into a float target that holds the range (m) per pixel. deck.gl port of
// engine.ts renderGeometry()/geoRT (materials.ts style 3).
//
// - `TerrainPassRenderer` draws the Deck's TerrainTileLayers (same GPU meshes, no copies) into any
//   framebuffer with a PhotoViewport, as the 'geometry' (range) or 'color' (styled, linear) pass.
// - `GeometryTarget` owns an r32float(+depth) framebuffer and an async PBO + fence readback
//   (luma texture.readBuffer → Buffer, device.createFence, then Buffer.readAsync).
// - `GpuGeometrySource` implements the GeometrySource contract (geometry-source.ts) on top of both.
//
// Range only is rendered (r32float, 4 B/px): xyz is exactly eye + ray(pixel centre)·range, so it is
// rebuilt on the CPU instead of reading back three extra floats per pixel.
import {
	type Deck,
	type Layer,
	_LayersPass as LayersPass,
} from "@deck.gl/core";
import {
	Buffer,
	type Device,
	type Fence,
	type Framebuffer,
} from "@luma.gl/core";
import type { Pose } from "../camera";
import { poseBasis } from "../pose";
import type { GeometrySource } from "./geometry-source";
import { PhotoViewport } from "./photo-view";
import type { TileMesh } from "./terrain-data";
import {
	currentTerrainPass,
	isTerrainTile,
	type PhotoRangeMap,
	type TerrainPassKind,
	withTerrainPass,
} from "./terrain-layer";
import { isTrailLayer } from "./trail-layer";

/** engine.ts geoRT: 1024 px on the long side. */
export const GEOMETRY_LONG_SIDE = 1024;

export function geometrySize(aspect: number, longSide = GEOMETRY_LONG_SIDE) {
	return aspect >= 1
		? { width: longSide, height: Math.round(longSide / aspect) }
		: { width: Math.round(longSide * aspect), height: longSide };
}

type Eye = [number, number, number];

class TerrainLayersPass extends LayersPass {
	shouldDrawLayer(layer: Layer) {
		// trails join the colour pass only (three hides them in its geometry renders)
		return (
			isTerrainTile(layer) ||
			(currentTerrainPass() === "color" && isTrailLayer(layer))
		);
	}
	protected getLayerParameters(layer: Layer) {
		// trails blend over the terrain colour and depth-test against it (half-float blends fine)
		if (isTrailLayer(layer)) return { ...layer.props.parameters };
		// float targets can't blend (EXT_float_blend); the colour pass keeps straight alpha like
		// three's layerRT (ShaderMaterial transparent: false → NoBlending)
		return {
			...layer.props.parameters,
			blend: false,
			depthWriteEnabled: true,
			depthCompare: "less-equal" as const,
		};
	}
}

/** Draws a Deck's terrain tiles through a photo camera into an offscreen framebuffer. */
export class TerrainPassRenderer {
	private pass: TerrainLayersPass;
	constructor(readonly device: Device) {
		this.pass = new TerrainLayersPass(device, { id: "terrain-pass" });
	}

	render(
		kind: TerrainPassKind,
		layers: Layer[],
		target: Framebuffer,
		pose: Pose,
		eye: Eye,
		near = 1,
		far = 400_000,
	) {
		const viewport = new PhotoViewport({
			id: `terrain-${kind}`,
			...pose,
			eye,
			x: 0,
			y: 0,
			width: target.width,
			height: target.height,
			near,
			far,
		});
		// tiles outside the camera frustum cost deck ~30 µs of CPU each per pass: skip them
		const cull = frustumCuller(pose, eye, target.width / target.height);
		const drawn = layers.filter(
			(l) => !isTerrainTile(l) || !cull((l.props as { mesh?: TileMesh }).mesh),
		);
		withTerrainPass(kind, () =>
			this.pass.render({
				layers: drawn,
				viewports: [viewport],
				views: {},
				onViewportActive: () => {},
				target,
				pass: `terrain-${kind}`,
				clearColor: [0, 0, 0, 0],
				clearCanvas: true,
				layerFilter: null,
				// the viewport is already in target pixels
				shaderModuleProps: { project: { devicePixelRatio: 1 } },
			} as never),
		);
	}
}

/** Bounding sphere of a tile mesh (ENU metres), cached per mesh. */
const spheres = new WeakMap<TileMesh, [number, number, number, number]>();
function tileSphere(m: TileMesh) {
	let s = spheres.get(m);
	if (s) return s;
	const p = m.positions;
	let x0 = Infinity,
		y0 = Infinity,
		z0 = Infinity,
		x1 = -Infinity,
		y1 = -Infinity,
		z1 = -Infinity;
	for (let i = 0; i < p.length; i += 3) {
		const x = p[i],
			y = p[i + 1],
			z = p[i + 2];
		if (x < x0) x0 = x;
		if (x > x1) x1 = x;
		if (y < y0) y0 = y;
		if (y > y1) y1 = y;
		if (z < z0) z0 = z;
		if (z > z1) z1 = z;
	}
	s = [
		(x0 + x1) / 2,
		(y0 + y1) / 2,
		(z0 + z1) / 2,
		Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2,
	];
	spheres.set(m, s);
	return s;
}

/** true = the mesh's bounding sphere lies entirely outside the photo camera's frustum. */
function frustumCuller(pose: Pose, eye: Eye, aspect: number) {
	const { forward: f, right: r, up: u } = poseBasis(pose);
	const ty = Math.tan((pose.vfov * Math.PI) / 360);
	const tx = ty * aspect;
	const nx = Math.hypot(1, tx);
	const ny = Math.hypot(1, ty);
	return (m: TileMesh | undefined) => {
		if (!m?.positions?.length) return false;
		const [cx, cy, cz, rad] = tileSphere(m);
		const dx = cx - eye[0];
		const dy = cy - eye[1];
		const dz = cz - eye[2];
		const z = dx * f.x + dy * f.y + dz * f.z;
		const x = dx * r.x + dy * r.y + dz * r.z;
		const y = dx * u.x + dy * u.y + dz * u.z;
		const pad = rad * 1.02 + 1;
		return (
			z < -pad ||
			(Math.abs(x) - z * tx) / nx > pad ||
			(Math.abs(y) - z * ty) / ny > pad
		);
	};
}

type GL = WebGL2RenderingContext;

/**
 * Resolves true once every GPU command issued so far has completed (a luma Fence polled from
 * timers), false if the device is lost first. Never blocks the thread: after it, reading a
 * Buffer that a readBuffer() wrote is a plain copy, not a pipeline stall (on WebGL luma's
 * Buffer.readAsync is a bare getBufferSubData, so it must only run behind this).
 */
export async function gpuDone(device: Device): Promise<boolean> {
	if (device.isLost) return false;
	let fence: Fence;
	try {
		fence = device.createFence();
	} catch {
		return false;
	}
	const ok = await Promise.race([
		fence.signaled.then(() => true),
		device.lost.then(() => false),
	]);
	// luma's WebGL fence keeps polling until it signals: deleting it earlier leaves that poll spinning
	if (ok) fence.destroy();
	return ok;
}

/** A GPU buffer a texture can be read into (texture.readBuffer) and then mapped back. */
export function readbackBuffer(device: Device, byteLength: number, id: string) {
	return device.createBuffer({
		id,
		byteLength,
		usage: Buffer.COPY_DST | Buffer.MAP_READ,
	});
}

/** An r32float + depth render target with an asynchronous (PBO + fence) readback. */
export class GeometryTarget {
	fbo: Framebuffer;
	private pbo: Buffer | null = null;
	/** null = not probed yet; true = RED/FLOAT is not a readPixels format here, read RGBA/FLOAT */
	private readRGBA: boolean | null = null;
	private destroyed = false;

	constructor(
		readonly device: Device,
		width: number,
		height: number,
	) {
		// EXT_color_buffer_float (luma enables it on first query)
		if (!device.features.has("float32-renderable-webgl"))
			throw new Error("float32 render targets unsupported");
		this.fbo = this.create(width, height);
	}

	private create(width: number, height: number) {
		const color = this.device.createTexture({
			id: "geometry-range",
			format: "r32float",
			width,
			height,
			sampler: {
				minFilter: "nearest",
				magFilter: "nearest",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			},
		});
		return this.device.createFramebuffer({
			id: "geometry-fbo",
			width,
			height,
			colorAttachments: [color],
			depthStencilAttachment: "depth24plus",
		});
	}

	get width() {
		return this.fbo.width;
	}
	get height() {
		return this.fbo.height;
	}
	get texture() {
		return this.fbo.colorAttachments[0].texture;
	}

	resize(width: number, height: number) {
		if (width === this.fbo.width && height === this.fbo.height) return;
		const old = this.fbo;
		this.fbo = this.create(width, height);
		old.colorAttachments[0].texture.destroy();
		old.depthStencilAttachment?.texture.destroy();
		old.destroy();
	}

	/**
	 * Async readback of the range channel into `out` (GL order: row 0 = BOTTOM). Issues the
	 * readPixels into a PBO (luma texture.readBuffer) now and copies it out once a luma Fence
	 * signals; never stalls the thread. false = superseded (resize / destroy) or device lost.
	 */
	async read(out: Float32Array): Promise<boolean> {
		const { width, height } = this.fbo;
		const n = width * height;
		this.readRGBA ??= !this.redFloatReadable();
		const comps = this.readRGBA ? 4 : 1;
		const bytes = n * comps * 4;
		if (this.pbo?.byteLength !== bytes) {
			this.pbo?.destroy();
			this.pbo = readbackBuffer(this.device, bytes, "geometry-readback");
		}
		const pbo = this.pbo;
		if (comps === 1) this.texture.readBuffer({}, pbo);
		else this.readPixelsRGBA(pbo);
		if (!(await gpuDone(this.device)) || this.destroyed || pbo.destroyed)
			return false;
		const data = await pbo.readAsync(0, bytes);
		const f = new Float32Array(data.buffer, data.byteOffset, n * comps);
		if (comps === 1) out.set(f);
		else for (let i = 0; i < n; i++) out[i] = f[i * 4];
		return true;
	}

	/** Whether readPixels accepts RED/FLOAT for this target (implementation-defined for float targets). */
	private redFloatReadable() {
		const gl = (this.device as unknown as { gl: GL }).gl;
		const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboHandle);
		gl.readBuffer(gl.COLOR_ATTACHMENT0);
		const ok =
			gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RED &&
			gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.FLOAT;
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
		return ok;
	}

	/** Fallback when RED/FLOAT isn't readable: RGBA/FLOAT (always allowed) into the PBO; luma's
	 * readBuffer only reads the texture's own format. */
	private readPixelsRGBA(pbo: Buffer) {
		const gl = (this.device as unknown as { gl: GL }).gl;
		const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
		const prevPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboHandle);
		gl.readBuffer(gl.COLOR_ATTACHMENT0);
		gl.bindBuffer(
			gl.PIXEL_PACK_BUFFER,
			(pbo as unknown as { handle: WebGLBuffer }).handle,
		);
		gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, 0);
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prevPack);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
	}

	private get fboHandle() {
		return (this.fbo as unknown as { handle: WebGLFramebuffer }).handle;
	}

	destroy() {
		this.destroyed = true;
		this.pbo?.destroy();
		this.pbo = null;
		this.fbo.colorAttachments[0].texture.destroy();
		this.fbo.depthStencilAttachment?.texture.destroy();
		this.fbo.destroy();
	}
}

/** Timing of the last GpuGeometrySource.render(), ms. */
export type GeometryTiming = {
	/** CPU time to encode + submit the terrain draw calls. */
	submitMs: number;
	/** submit → fence signalled → buffer copied (GPU render + transfer). */
	readbackMs: number;
	/** Row flip, sky → Infinity, xyz rebuild. */
	unpackMs: number;
	totalMs: number;
};

/**
 * GeometrySource backed by the GPU: renders the Deck's current terrain tiles through the photo
 * camera at `eye`, reads the range back asynchronously and (optionally) rebuilds xyz.
 * Layout per geometry-source.ts: row 0 = top, Infinity = sky, xyz NaN for sky.
 */
export class GpuGeometrySource implements GeometrySource {
	readonly width: number;
	readonly height: number;
	readonly range: Float32Array;
	readonly xyz?: Float32Array;
	pose: Pose | null = null;
	/** Timing of the last completed render(). */
	timing: GeometryTiming | null = null;
	private target: GeometryTarget;
	private renderer: TerrainPassRenderer;
	private raw: Float32Array;
	private seq = 0;
	private disposed = false;

	constructor(
		private deck: Deck,
		private eye: Eye,
		width: number,
		height: number,
		opts: { xyz?: boolean } = {},
	) {
		const device = (deck as unknown as { device?: Device }).device;
		if (!device) throw new Error("Deck has no device yet (not initialised)");
		this.width = width;
		this.height = height;
		this.range = new Float32Array(width * height).fill(
			Number.POSITIVE_INFINITY,
		);
		this.raw = new Float32Array(width * height);
		if (opts.xyz !== false)
			this.xyz = new Float32Array(width * height * 3).fill(Number.NaN);
		this.target = new GeometryTarget(device, width, height);
		this.renderer = new TerrainPassRenderer(device);
	}

	/** The r32float texture of the last render (GL order, 0 = sky), for GPU consumers. */
	get texture() {
		return this.target.texture;
	}

	async render(pose: Pose): Promise<void> {
		if (this.disposed) return;
		const seq = ++this.seq;
		const t0 = performance.now();
		// layerManager is protected in the typings but the documented way to reach the live layers
		const lm = (
			this.deck as unknown as { layerManager?: { getLayers(): Layer[] } }
		).layerManager;
		const layers = lm?.getLayers() ?? [];
		this.renderer.render("geometry", layers, this.target.fbo, pose, this.eye);
		const t1 = performance.now();
		const ok = await this.target.read(this.raw);
		const t2 = performance.now();
		// a newer render() superseded this one: its buffers win
		if (!ok || seq !== this.seq || this.disposed) return;
		this.unpack(pose);
		const t3 = performance.now();
		this.pose = { ...pose };
		this.timing = {
			submitMs: t1 - t0,
			readbackMs: t2 - t1,
			unpackMs: t3 - t2,
			totalMs: t3 - t0,
		};
	}

	private unpack(pose: Pose) {
		const { width: w, height: h, raw, range, xyz } = this;
		for (let y = 0; y < h; y++) {
			const src = (h - 1 - y) * w;
			const dst = y * w;
			for (let x = 0; x < w; x++) {
				const r = raw[src + x];
				range[dst + x] = r > 0 ? r : Number.POSITIVE_INFINITY;
			}
		}
		if (!xyz) return;
		// the pixel-centre ray of pose.ts unprojectDir, with the basis hoisted out of the loop
		const { forward: f, right: rt, up } = poseBasis(pose);
		const t = Math.tan((pose.vfov * Math.PI) / 360);
		const aspect = w / h;
		const [ex, ey, ez] = this.eye;
		for (let y = 0; y < h; y++) {
			const sy = (1 - (2 * (y + 0.5)) / h) * t;
			for (let x = 0; x < w; x++) {
				const i = y * w + x;
				const r = range[i];
				if (!Number.isFinite(r)) {
					xyz[i * 3] = xyz[i * 3 + 1] = xyz[i * 3 + 2] = Number.NaN;
					continue;
				}
				const sx = ((2 * (x + 0.5)) / w - 1) * t * aspect;
				const dx = f.x + rt.x * sx + up.x * sy;
				const dy = f.y + rt.y * sx + up.y * sy;
				const dz = f.z + rt.z * sx + up.z * sy;
				const k = r / Math.hypot(dx, dy, dz);
				xyz[i * 3] = ex + dx * k;
				xyz[i * 3 + 1] = ey + dy * k;
				xyz[i * 3 + 2] = ez + dz * k;
			}
		}
	}

	dispose() {
		this.disposed = true;
		this.target.destroy();
	}
}

/** GeometrySourceFactory for a live Deck and eye (see geometry-source.ts). */
export function gpuGeometryFactory(deck: Deck, eye: Eye) {
	return (width: number, height: number) =>
		new GpuGeometrySource(deck, eye, width, height);
}

/** The drape's range map (terrain-layer.ts photoRange: row 0 = top, 0 = sky) from a source. */
export function rangeMapFrom(
	src: Pick<GeometrySource, "width" | "height" | "range">,
): PhotoRangeMap {
	const data = new Float32Array(src.range.length);
	for (let i = 0; i < data.length; i++) {
		const r = src.range[i];
		data[i] = Number.isFinite(r) ? r : 0;
	}
	return { width: src.width, height: src.height, data };
}
