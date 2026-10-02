// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU geometry pass for the deck backend: the terrain tiles of a live Deck, rendered through the
// photo camera into a float target that holds the range (m) per pixel. deck.gl port of
// engine.ts renderGeometry()/geoRT (materials.ts style 3).
//
// - `TerrainPassRenderer` draws the Deck's TerrainTileLayers (same GPU meshes, no copies) into any
//   framebuffer with a PhotoViewport, as the 'geometry' (range) or 'color' (styled, linear) pass.
// - `GeometryTarget` owns an r32float(+depth) framebuffer and a truly async readback: readPixels
//   into a STREAM_READ pixel-pack buffer, fenceSync + flush, the fence polled across tasks, and
//   getBufferSubData only once the GPU queue is short (see readbackQuiet for why).
// - `GpuGeometrySource` implements the GeometrySource contract (geometry-source.ts) on top of both.
//
// Range only is rendered (r32float, 4 B/px): xyz is exactly eye + ray(pixel centre)·range, so it is
// rebuilt on the CPU instead of reading back three extra floats per pixel.
import type { Deck, Layer } from "@deck.gl/core";
import {
	Buffer,
	type Device,
	type Fence,
	type Framebuffer,
	type Texture,
} from "@luma.gl/core";
import type { Vec3 } from "#/lib/ontology/core/geometry";
import type { Pose } from "../camera";
import { poseBasis } from "../pose";
import type { GeometrySource } from "./geometry-source";
import { glOf } from "./gl";
import { drawLayersOffscreen } from "./offscreen-layers";
import { PhotoViewport } from "./photo-view";
import type { TileMesh } from "./terrain-data";
import {
	currentTerrainPass,
	isTerrainTile,
	type PhotoRangeData,
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

/** The layers a terrain pass draws: trails join the colour pass only (three hides them in its
 * geometry renders). */
function terrainPassLayer(layer: Layer) {
	return (
		isTerrainTile(layer) ||
		(currentTerrainPass() === "color" && isTrailLayer(layer))
	);
}

function terrainPassParameters(layer: Layer) {
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

/** Draws a Deck's terrain tiles through a photo camera into an offscreen framebuffer. */
export class TerrainPassRenderer {
	constructor(readonly device: Device) {}

	render(
		kind: TerrainPassKind,
		layers: Layer[],
		target: Framebuffer,
		pose: Pose,
		eye: Vec3,
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
			drawLayersOffscreen(this.device, {
				layers: drawn,
				viewport,
				target,
				pass: `terrain-${kind}`,
				clearColor: [0, 0, 0, 0],
				clearCanvas: true,
				shouldDrawLayer: terrainPassLayer,
				getLayerParameters: terrainPassParameters,
				// the viewport is already in target pixels
				shaderModuleProps: { project: { devicePixelRatio: 1 } },
			}),
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
function frustumCuller(pose: Pose, eye: Vec3, aspect: number) {
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
	// submit the fence (and the readPixels before it) now rather than with the next frame's flush
	(device as unknown as { gl?: WebGL2RenderingContext }).gl?.flush();
	const ok = await Promise.race([
		fence.signaled.then(() => true),
		device.lost.then(() => false),
	]);
	// luma's WebGL fence keeps polling until it signals: deleting it earlier leaves that poll spinning
	if (ok) fence.destroy();
	else {
		// device lost: on a dead context clientWaitSync never reports a signal, so luma's poll would re-arm
		// its 1 ms timer forever. Swap in a stub that reads as signaled so that poll resolves (stale) and stops.
		const f = fence as unknown as { gl?: object };
		if (f.gl) f.gl = { ALREADY_SIGNALED: 1, clientWaitSync: () => 1 };
	}
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

/** Timings of one readTextureQuiet(). */
export type QuietReadTiming = {
	fenceMs: number;
	polls: number;
	probes: number;
	copyMs: number;
	readbackMs: number;
};

/**
 * Asynchronous texture readback on the WebGL fallback: `issueRead` queues the read into a fresh
 * pack buffer (texture.readBuffer: PIXEL_PACK_BUFFER + readPixels; the buffer is new per read, so
 * its storage is never a reused, already-fenced one; MAP_READ, so luma rigi.5 hints it
 * STREAM_READ), then a fence behind it is waited on, the GPU queue is waited short (glFence +
 * readbackQuiet) and only then is the buffer copied out with Buffer.readAsync (a plain
 * getBufferSubData on WebGL: a memcpy once the data landed, never a stall).
 * Resolves the bytes or null = cancelled / context lost. The bytes are a fresh Uint8Array (offset
 * 0), or, with `target` (at least `bytes` long), a view of `target`'s memory that the copy wrote
 * straight into (luma rigi.5 `readAsync({target})`: no extra array, no second copy). `target` is
 * only written once the read is not cancelled.
 */
export async function readTextureQuiet(
	device: Device,
	bytes: number,
	id: string,
	issueRead: (buffer: Buffer) => void,
	cancelled: () => boolean = () => false,
	target?: ArrayBufferView<ArrayBuffer>,
): Promise<{ data: Uint8Array; timing: QuietReadTiming } | null> {
	const gl = glOf(device);
	const buffer = readbackBuffer(device, bytes, id);
	try {
		const t0 = performance.now();
		issueRead(buffer);
		const fence = await glFence(gl, cancelled);
		const quiet = fence.ok
			? await readbackQuiet(gl, fence.ms, cancelled)
			: { ok: false, probes: 0 };
		const t1 = performance.now();
		if (!quiet.ok || cancelled()) return null;
		const data = await buffer.readAsync(
			0,
			bytes,
			target ? { target } : undefined,
		);
		const t2 = performance.now();
		return {
			data,
			timing: {
				fenceMs: t1 - t0,
				polls: fence.polls,
				probes: quiet.probes,
				copyMs: t2 - t1,
				readbackMs: t2 - t0,
			},
		};
	} finally {
		// kept until the copy: the readPixels reads into this buffer
		buffer.destroy();
	}
}

/** Resolves on the next timer turn (a fence's status can only change between tasks). */
const nextTurn = () => new Promise<void>((res) => setTimeout(res, 4));

/**
 * Fences every GL command issued so far, flushes it and polls it with clientWaitSync(…, 0) on
 * later tasks; never blocks the thread. ok = signalled; false = context lost / wait failed /
 * `cancelled()`.
 */
export async function glFence(
	gl: WebGL2RenderingContext,
	cancelled: () => boolean = () => false,
): Promise<{ ok: boolean; polls: number; ms: number }> {
	const t0 = performance.now();
	const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
	if (!sync) return { ok: false, polls: 0, ms: 0 };
	gl.flush();
	let polls = 0;
	const done = (ok: boolean) => ({ ok, polls, ms: performance.now() - t0 });
	try {
		for (;;) {
			await nextTurn();
			polls++;
			if (cancelled() || gl.isContextLost()) return done(false);
			const s = gl.clientWaitSync(sync, 0, 0);
			if (s === gl.ALREADY_SIGNALED || s === gl.CONDITION_SATISFIED)
				return done(true);
			if (s === gl.WAIT_FAILED) return done(false);
		}
	} finally {
		gl.deleteSync(sync);
	}
}

/** A fence that signals within this many ms of being inserted = the GPU queue is short. */
export const QUIET_FENCE_MS = 40;
/** Longest a readback defers its copy for a quiet queue before copying anyway (bounded stall). */
export const QUIET_MAX_MS = 3000;

/**
 * Resolves once the GPU queue is short: `firstMs` (how long the fence behind the readPixels took)
 * or a fresh probe fence signalled within QUIET_FENCE_MS. Why: on Chrome + ANGLE Metal the
 * getBufferSubData that ends every WebGL readback is a synchronous round-trip that waits for the
 * whole queued backlog, even behind a signalled fence and with fresh STREAM_READ storage (the
 * shadow-copy fast path did not engage in the app: measured 100–420 ms per call for 16×16 and
 * 1024×768 alike while GPU-bound frames were queued; luma's Buffer.readAsync is that same bare
 * call). While frames keep the GPU busy (a drag at 10 fps) the copy waits here off the thread;
 * once the queue drains it is a ~1 ms memcpy. After QUIET_MAX_MS it copies anyway.
 * `quiet` = the queue was short when it returned (false = cancelled / lost / gave up).
 */
export async function readbackQuiet(
	gl: WebGL2RenderingContext,
	firstMs: number,
	cancelled: () => boolean = () => false,
): Promise<{ ok: boolean; quiet: boolean; probes: number }> {
	let probes = 0;
	if (firstMs <= QUIET_FENCE_MS) return { ok: true, quiet: true, probes };
	const t0 = performance.now();
	while (performance.now() - t0 < QUIET_MAX_MS) {
		probes++;
		const f = await glFence(gl, cancelled);
		if (!f.ok) return { ok: false, quiet: false, probes };
		if (f.ms <= QUIET_FENCE_MS) return { ok: true, quiet: true, probes };
	}
	return { ok: !cancelled() && !gl.isContextLost(), quiet: false, probes };
}

/** Timing of the last GeometryTarget.read(), ms. */
export type ReadbackTiming = {
	/** readPixels issued → fence signalled and queue short (GPU work + deferral, off the thread). */
	fenceMs: number;
	/** Polls of the readPixels fence. */
	polls: number;
	/** Probe fences waited for a short GPU queue before the copy (0 = it was short already). */
	probes: number;
	/** The synchronous getBufferSubData (should be a memcpy: ~1 ms for 1024×768 floats). */
	copyMs: number;
	/** readPixels issued → data in `out`. */
	readbackMs: number;
	/** Bytes read back (RED/FLOAT: 4 per pixel; the RGBA/FLOAT fallback: 16). */
	bytes?: number;
};

/** An r32float + depth render target with an asynchronous (PBO + fence) readback. */
export class GeometryTarget {
	fbo: Framebuffer;
	/** null = not probed yet; true = RED/FLOAT is not a readPixels format here, read RGBA/FLOAT */
	private readRGBA: boolean | null = null;
	private destroyed = false;
	/** Timing of the last completed read(). */
	lastRead: ReadbackTiming | null = null;

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
	 * readPixels into a STREAM_READ pack buffer now and copies it out once a fence behind it has
	 * been seen signalled and the GPU queue is short (readbackQuiet); does not stall the thread
	 * (at most a bounded copy after QUIET_MAX_MS of continuous GPU load). false = superseded
	 * (resize / destroy) or context lost.
	 */
	async read(out: Float32Array<ArrayBuffer>): Promise<boolean> {
		if (this.destroyed) return false;
		const { width, height } = this.fbo;
		const n = width * height;
		this.readRGBA ??= !this.redFloatReadable();
		const comps = this.readRGBA ? 4 : 1;
		const bytes = n * comps * 4;
		const texture = this.texture;
		// one fresh buffer per read, so overlapping reads never share storage (a newer read must not
		// overwrite a buffer whose fence an older one is still waiting on)
		// RED/FLOAT: the copy lands straight in `out` (no 4 MB staging array + set per read)
		const res = await readTextureQuiet(
			this.device,
			bytes,
			"geometry-readback",
			(buffer) =>
				comps === 1
					? texture.readBuffer({}, buffer)
					: this.readPixelsRgbaInto(buffer),
			() => this.destroyed,
			comps === 1 ? out : undefined,
		);
		if (!res || this.destroyed) return false;
		if (comps !== 1) {
			const f = new Float32Array(res.data.buffer, 0, n * comps);
			for (let i = 0; i < n; i++) out[i] = f[i * 4];
		}
		this.lastRead = { ...res.timing, bytes };
		return true;
	}

	/** Whether readPixels accepts RED/FLOAT for this target (implementation-defined for float targets). */
	private redFloatReadable() {
		const gl = glOf(this.device);
		const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboHandle);
		gl.readBuffer(gl.COLOR_ATTACHMENT0);
		const ok =
			gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RED &&
			gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.FLOAT;
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
		return ok;
	}

	/** readPixels RGBA/FLOAT of the range attachment into `buffer` (always an allowed format): the
	 * fallback where RED/FLOAT isn't a readPixels format, which texture.readBuffer cannot express
	 * (it reads in the texture's own format, RED). */
	private readPixelsRgbaInto(buffer: Buffer) {
		const gl = glOf(this.device);
		const handle = (buffer as unknown as { handle: WebGLBuffer }).handle;
		const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
		const prevPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
		const prevAlign = gl.getParameter(gl.PACK_ALIGNMENT);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboHandle);
		gl.readBuffer(gl.COLOR_ATTACHMENT0);
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, handle);
		gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
		gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, 0);
		gl.pixelStorei(gl.PACK_ALIGNMENT, prevAlign);
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prevPack);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
	}

	private get fboHandle() {
		return (this.fbo as unknown as { handle: WebGLFramebuffer }).handle;
	}

	/** The range framebuffer's GL handle (GpuGeometrySource.copyRangeTo reads from it). */
	get framebufferHandle() {
		return this.fboHandle;
	}

	destroy() {
		this.destroyed = true;
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
	/** Of readbackMs: the synchronous getBufferSubData (≈1 ms when the readback is truly async). */
	copyMs?: number;
	/** Fence polls (timer turns) the readback waited. */
	polls?: number;
	/** Quiet-queue probe fences before the copy (readbackQuiet; 0 = the GPU queue was short). */
	probes?: number;
	/** Row flip, sky → Infinity, xyz rebuild. */
	unpackMs: number;
	totalMs: number;
};

export type XyzRay = {
	f: { x: number; y: number; z: number };
	rt: { x: number; y: number; z: number };
	up: { x: number; y: number; z: number };
	t: number;
	aspect: number;
	w: number;
	h: number;
	eye: Vec3;
};

/** The pixel-centre ray of pose.ts unprojectDir, with the basis hoisted out of the pixel loop. */
export function makeXyzRay(
	pose: Pose,
	w: number,
	h: number,
	eye: Vec3,
): XyzRay {
	const { forward: f, right: rt, up } = poseBasis(pose);
	const t = Math.tan((pose.vfov * Math.PI) / 360);
	return { f, rt, up, t, aspect: w / h, w, h, eye };
}

/** Writes eye + ray(x, y)·r (NaN for sky, r not finite) to out[o..o+2]. */
export function xyzPixel(
	out: ArrayLike<number> & { [i: number]: number },
	o: number,
	r: number,
	x: number,
	y: number,
	ray: XyzRay,
) {
	if (!Number.isFinite(r)) {
		out[o] = out[o + 1] = out[o + 2] = Number.NaN;
		return;
	}
	const { f, rt, up, t, aspect, w, h } = ray;
	const sy = (1 - (2 * (y + 0.5)) / h) * t;
	const sx = ((2 * (x + 0.5)) / w - 1) * t * aspect;
	const dx = f.x + rt.x * sx + up.x * sy;
	const dy = f.y + rt.y * sx + up.y * sy;
	const dz = f.z + rt.z * sx + up.z * sy;
	const k = r / Math.hypot(dx, dy, dz);
	out[o] = ray.eye[0] + dx * k;
	out[o + 1] = ray.eye[1] + dy * k;
	out[o + 2] = ray.eye[2] + dz * k;
}

/**
 * GeometrySource backed by the GPU: renders the Deck's current terrain tiles through the photo
 * camera at `eye`, reads the range back asynchronously and (optionally) rebuilds xyz.
 * Layout per geometry-source.ts: row 0 = top, Infinity = sky, xyz NaN for sky.
 */
export class GpuGeometrySource implements GeometrySource {
	readonly width: number;
	readonly height: number;
	readonly range: Float32Array;
	pose: Pose | null = null;
	/** Timing of the last completed render(). */
	timing: GeometryTiming | null = null;
	/** Bytes the last completed readback copied (render() / readDrawn()). */
	get readBytes() {
		return this.target.lastRead?.bytes ?? 0;
	}
	private target: GeometryTarget;
	private renderer: TerrainPassRenderer;
	private raw: Float32Array<ArrayBuffer>;
	private wantXyz: boolean;
	/** The pose `range` was unpacked for (what xyz is rebuilt from), and the memoised full array. */
	private xyzRay: XyzRay | null = null;
	private xyzFull: Float32Array | null = null;
	/** render() calls issued (each draws into the target right away). */
	private seq = 0;
	/** The render() whose result `range` / `pose` hold (== seq: the target holds it too). */
	private shown = 0;
	/** The pose the target holds (last drawOnly() / render()). */
	private drawn: Pose | null = null;
	/** Draw framebuffer of copyRangeTo (created on first use). */
	private copyFbo: WebGLFramebuffer | null = null;
	private disposed = false;

	constructor(
		private deck: Deck,
		private eye: Vec3,
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
		this.wantXyz = opts.xyz !== false;
		this.target = new GeometryTarget(device, width, height);
		this.renderer = new TerrainPassRenderer(device);
	}

	/** The r32float texture of the last render (GL order, 0 = sky), for GPU consumers. */
	get texture() {
		return this.target.texture;
	}

	/**
	 * GPU twin of rangeMapFrom(this): copies the range target into `dst` (an r32float texture of
	 * this size) with its rows flipped to the drape's order (row 0 = top), on the GPU (no readback,
	 * no re-upload). The texels are exactly rangeMapFrom's: the target clears to 0 (sky; terrain
	 * the near discard drops stays 0 too) and only ever receives length(vWorld - eye) > 0, never
	 * Infinity / NaN, so rangeMapFrom's Infinity → 0 fix-up is the identity on this data and the
	 * shader's `seen > 0.0` test sees the same sky. A nearest-filter blit at scale 1 lands every
	 * destination pixel centre on a source texel centre: a bit-exact copy. (Flipping in GLSL
	 * instead is not exact: hardware nearest filtering rounds the texel coordinate in fixed point,
	 * so floor(v·h) and h-1-floor((1-v)·h) disagree near texel edges; and editing the terrain
	 * shader re-optimises the geometry pass that shares it, which moved IMG_6958's range bits.)
	 *
	 * false (nothing copied) unless the target still holds the render that `range` describes: a
	 * newer render() draws into the target at once, before its readback lands, and the caller
	 * keys its copy to the buffer's generation (engine.ts drapeRange); likewise after a failed
	 * readback, after dispose(), or for a texture of another size.
	 */
	copyRangeTo(dst: Texture): boolean {
		if (this.disposed || !this.pose || this.shown !== this.seq) return false;
		const { width: w, height: h } = this;
		if (
			dst.width !== w ||
			dst.height !== h ||
			this.target.width !== w ||
			this.target.height !== h
		)
			return false;
		const gl = glOf(this.target.device);
		this.copyFbo ??= gl.createFramebuffer();
		if (!this.copyFbo) return false;
		const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
		const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
		const scissor = gl.isEnabled(gl.SCISSOR_TEST);
		const discard = gl.isEnabled(gl.RASTERIZER_DISCARD);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.target.framebufferHandle);
		gl.readBuffer(gl.COLOR_ATTACHMENT0);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.copyFbo);
		gl.framebufferTexture2D(
			gl.DRAW_FRAMEBUFFER,
			gl.COLOR_ATTACHMENT0,
			gl.TEXTURE_2D,
			(dst as unknown as { handle: WebGLTexture }).handle,
			0,
		);
		// blits pass the scissor test and rasterizer discard (no other fragment operation)
		if (scissor) gl.disable(gl.SCISSOR_TEST);
		if (discard) gl.disable(gl.RASTERIZER_DISCARD);
		// destination rows h → 0: the flip (GL row 0 = bottom → the drape's row 0 = top)
		gl.blitFramebuffer(0, 0, w, h, 0, h, w, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
		if (scissor) gl.enable(gl.SCISSOR_TEST);
		if (discard) gl.enable(gl.RASTERIZER_DISCARD);
		// detach: the texture is sampled next, and its owner may destroy it any time
		gl.framebufferTexture2D(
			gl.DRAW_FRAMEBUFFER,
			gl.COLOR_ATTACHMENT0,
			gl.TEXTURE_2D,
			null,
			0,
		);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
		return true;
	}

	/** The luma device the target lives on (GPU consumers of `texture`). */
	get device() {
		return this.target.device;
	}

	/** Draws issued so far (drawOnly() / render()); readDrawn() takes the value after its draw. */
	get drawSeq() {
		return this.seq;
	}

	/**
	 * render() without the readback, for GPU consumers of `texture`: draws the terrain through
	 * `pose` into the target and returns. `range`, `xyz`, `pose` and `timing` keep describing the
	 * last render() (they are not this draw's) until readDrawn(), copyRangeTo says no until then,
	 * and a render() still waiting for its readback is superseded (the target no longer holds it).
	 * false = disposed.
	 */
	drawOnly(pose: Pose): boolean {
		if (this.disposed) return false;
		++this.seq;
		this.drawPass(pose);
		return true;
	}

	/**
	 * Reads back what drawOnly() number `seq` (drawSeq right after it) drew for `pose` (render()'s
	 * second half), so `range` / `pose` describe it. false = anything else is in the target now (a
	 * later drawOnly() / render(), e.g. a concurrent autoAlign, or another pose), disposed, lost:
	 * the caller must not score what it would read.
	 */
	async readDrawn(seq: number, pose: Pose): Promise<boolean> {
		const drawn = this.drawn;
		if (this.disposed || !drawn || this.seq !== seq) return false;
		if (
			drawn.yaw !== pose.yaw ||
			drawn.pitch !== pose.pitch ||
			drawn.roll !== pose.roll ||
			drawn.vfov !== pose.vfov
		)
			return false;
		if (this.shown === seq) return true;
		const t = performance.now();
		await this.finish(seq, drawn, t, t);
		return this.shown === seq;
	}

	private drawPass(pose: Pose) {
		// layerManager is protected in the typings but the documented way to reach the live layers
		const lm = (
			this.deck as unknown as { layerManager?: { getLayers(): Layer[] } }
		).layerManager;
		const layers = lm?.getLayers() ?? [];
		this.renderer.render("geometry", layers, this.target.fbo, pose, this.eye);
		this.drawn = { ...pose };
	}

	async render(pose: Pose): Promise<void> {
		if (this.disposed) return;
		const seq = ++this.seq;
		const t0 = performance.now();
		this.drawPass(pose);
		const t1 = performance.now();
		await this.finish(seq, pose, t0, t1);
	}

	private async finish(seq: number, pose: Pose, t0: number, t1: number) {
		const ok = await this.target.read(this.raw);
		const t2 = performance.now();
		// a newer render() superseded this one: its buffers win
		if (!ok || seq !== this.seq || this.disposed) return;
		this.unpack(pose);
		const t3 = performance.now();
		this.pose = { ...pose };
		this.shown = seq;
		this.timing = {
			submitMs: t1 - t0,
			readbackMs: t2 - t1,
			copyMs: this.target.lastRead?.copyMs,
			polls: this.target.lastRead?.polls,
			probes: this.target.lastRead?.probes,
			unpackMs: t3 - t2,
			totalMs: t3 - t0,
		};
	}

	private unpack(pose: Pose) {
		const { width: w, height: h, raw, range } = this;
		for (let y = 0; y < h; y++) {
			const src = (h - 1 - y) * w;
			const dst = y * w;
			for (let x = 0; x < w; x++) {
				const r = raw[src + x];
				range[dst + x] = r > 0 ? r : Number.POSITIVE_INFINITY;
			}
		}
		// xyz is lazy: xyzAt() / the `xyz` getter rebuild it from this range and pose on demand
		this.xyzRay = makeXyzRay(pose, w, h, this.eye);
		this.xyzFull = null;
	}

	/**
	 * The ENU hit point of pixel `i` of the last completed render (NaN for sky), computed on demand
	 * with the arithmetic of the full array. Null when xyz was not requested or nothing is shown.
	 */
	xyzAt(i: number, out: [number, number, number] = [0, 0, 0]) {
		const ray = this.xyzRay;
		if (!this.wantXyz || !ray) return null;
		const x = i % ray.w;
		const y = (i - x) / ray.w;
		xyzPixel(out, 0, this.range[i], x, y, ray);
		// the full array is float32: round the same way
		out[0] = Math.fround(out[0]);
		out[1] = Math.fround(out[1]);
		out[2] = Math.fround(out[2]);
		return out;
	}

	/** The full xyz array (3 per pixel, row 0 = top, NaN for sky), built on first read per render. */
	get xyz(): Float32Array | undefined {
		if (!this.wantXyz) return undefined;
		if (!this.xyzFull) {
			const { width: w, height: h, range } = this;
			const full = new Float32Array(w * h * 3).fill(Number.NaN);
			const ray = this.xyzRay;
			if (ray) {
				for (let y = 0; y < h; y++)
					for (let x = 0; x < w; x++) {
						const i = y * w + x;
						xyzPixel(full, i * 3, range[i], x, y, ray);
					}
			}
			this.xyzFull = full;
		}
		return this.xyzFull;
	}

	dispose() {
		this.disposed = true;
		if (this.copyFbo) glOf(this.target.device).deleteFramebuffer(this.copyFbo);
		this.copyFbo = null;
		this.target.destroy();
	}
}

/**
 * The drape's range map (terrain-layer.ts photoRange: row 0 = top, 0 = sky) from a source, on the
 * CPU: the fallback of GpuGeometrySource.copyRangeTo (CPU geometry sources, no GPU copy).
 */
export function rangeMapFrom(
	src: Pick<GeometrySource, "width" | "height" | "range">,
): PhotoRangeData {
	const data = new Float32Array(src.range.length);
	for (let i = 0; i < data.length; i++) {
		const r = src.range[i];
		data[i] = Number.isFinite(r) ? r : 0;
	}
	return { width: src.width, height: src.height, data };
}
