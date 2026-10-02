// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU column scan: one workgroup per reduced column, 64 threads down the column. The frame is
// copied once per frame into a texture allocated once (copyExternalImage, no mips); the kernel
// box-samples it to the reduced grid, computes skyness into workgroup memory, finds the best
// sky-above / ground-below step by an argmax reduction and writes (row, weight) per column. The
// result is 2 floats per column, read through the core readback ring in one submit; nothing
// awaits a map in the caller's frame. The CPU twin is skyline-cpu.ts scanColumnsCpu.
//
// The graph has no transients (imported texture, imported output buffer), so runNow() submits
// synchronously and two scans can be in flight: the later submit's writes land after the earlier
// copy in queue order.
import { Buffer, type Device, Texture } from "@luma.gl/core";
import { ComputeGraph } from "../gpu/core/graph";
import { defineKernel } from "../gpu/core/kernel";
import type { TrackFrame } from "../live/contract";
import {
	MAX_SCAN_ROWS,
	SCAN_HALF_WINDOW,
	type ScanResult,
	STEP_FLOOR,
	STEP_RANGE,
	scanHeight,
} from "./skyline-cpu";
import type { ColumnScanner } from "./types";

const SCAN_WGSL = /* wgsl */ `
override SRC_W: u32;
override SRC_H: u32;
override OUT_W: u32;
override OUT_H: u32;
const K: u32 = ${SCAN_HALF_WINDOW}u;
const MAX_ROWS: u32 = ${MAX_SCAN_ROWS}u;

@group(0) @binding(0) var frame: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> columns: array<vec2f>;

var<workgroup> skyRow: array<f32, ${MAX_SCAN_ROWS}>;
var<workgroup> bestStep: array<f32, 64>;
var<workgroup> bestRow: array<u32, 64>;

fn skyness(c: vec3f) -> f32 {
	let lum = dot(c, vec3f(0.299, 0.587, 0.114));
	return 0.5 * lum + 0.5 * (0.5 + 0.5 * (c.b - c.r));
}

fn stepAt(y: i32) -> f32 {
	var above = 0.0;
	var below = 0.0;
	let last = i32(OUT_H) - 1;
	for (var i = 1; i <= i32(K); i++) {
		above += skyRow[u32(max(0, y - i))];
		below += skyRow[u32(min(last, y + i - 1))];
	}
	return (above - below) / f32(K);
}

// @workgroup_size(64): one thread per row slot down a column
@compute @workgroup_size(64) fn main(
	@builtin(workgroup_id) wg: vec3u,
	@builtin(local_invocation_index) li: u32,
) {
	let x = wg.x;
	let cx = ((2u * x + 1u) * SRC_W) / (2u * OUT_W);
	let x0 = max(cx, 1u) - 1u;
	let x1 = min(cx, SRC_W - 1u);
	for (var y = li; y < OUT_H; y += 64u) {
		let cy = ((2u * y + 1u) * SRC_H) / (2u * OUT_H);
		let y0 = max(cy, 1u) - 1u;
		let y1 = min(cy, SRC_H - 1u);
		let c = (textureLoad(frame, vec2u(x0, y0), 0).rgb + textureLoad(frame, vec2u(x1, y0), 0).rgb
			+ textureLoad(frame, vec2u(x0, y1), 0).rgb + textureLoad(frame, vec2u(x1, y1), 0).rgb) * 0.25;
		skyRow[y] = skyness(c);
	}
	workgroupBarrier();
	var best = -1e30;
	var bestY = 0u;
	for (var y = K + li; y + K <= OUT_H; y += 64u) {
		let e = stepAt(i32(y));
		if (e > best) { best = e; bestY = y; }
	}
	bestStep[li] = best;
	bestRow[li] = bestY;
	workgroupBarrier();
	for (var s = 32u; s > 0u; s >>= 1u) {
		if (li < s) {
			let a = bestStep[li];
			let b = bestStep[li + s];
			let ya = bestRow[li];
			let yb = bestRow[li + s];
			// larger step wins; equal steps go to the smaller row (matches the CPU scan order)
			if (b > a || (b == a && yb < ya)) { bestStep[li] = b; bestRow[li] = yb; }
		}
		workgroupBarrier();
	}
	if (li == 0u) {
		let top = bestStep[0];
		if (top < -1e29) {
			columns[x] = vec2f(-1.0, 0.0);
			return;
		}
		let y = i32(bestRow[0]);
		let em = stepAt(y - 1);
		let ep = stepAt(y + 1);
		let den = em - 2.0 * top + ep;
		var off = 0.0;
		if (abs(den) > 1e-9) { off = clamp(0.5 * (em - ep) / den, -0.5, 0.5); }
		let w = clamp((top - ${STEP_FLOOR}) / ${STEP_RANGE}, 0.0, 1.0);
		columns[x] = vec2f(f32(y) + off, w);
	}
}
`;

export type FrameUploader = (texture: Texture, frame: TrackFrame) => void;

/** Default upload: copyExternalImageToTexture of the frame, no flip, no mips. */
export const copyFrameExternal: FrameUploader = (texture, frame) => {
	texture.copyExternalImage({
		image: frame.source as unknown as ImageBitmap,
		width: frame.width,
		height: frame.height,
		premultipliedAlpha: false,
		flipY: false,
	});
};

interface Session {
	width: number;
	height: number;
	outHeight: number;
	texture: Texture;
	output: Buffer;
	graph: ComputeGraph<void>;
}

export class GpuColumnScanner implements ColumnScanner {
	inFlight = 0;
	private session: Session | null = null;
	private building: Promise<void> | null = null;
	private disposed = false;

	constructor(
		private readonly device: Device,
		private readonly outWidth: number,
		private readonly upload: FrameUploader = copyFrameExternal,
	) {}

	/** Builds the texture, buffer, kernel pipeline and graph for a frame size (async pipeline). */
	prepare(width: number, height: number): Promise<void> {
		if (this.session?.width === width && this.session.height === height)
			return Promise.resolve();
		this.building ??= (async () => {
			const outHeight = scanHeight(width, height, this.outWidth);
			const spec = defineKernel(
				`track-scan-${width}x${height}-${this.outWidth}`,
				SCAN_WGSL,
				{
					constants: {
						SRC_W: width,
						SRC_H: height,
						OUT_W: this.outWidth,
						OUT_H: outHeight,
					},
					group: "track",
					label: "track skyline scan",
				},
			);
			const texture = this.device.createTexture({
				id: "track-frame",
				format: "rgba8unorm",
				width,
				height,
				usage: Texture.SAMPLE | Texture.COPY_DST | Texture.RENDER,
			});
			const output = this.device.createBuffer({
				id: "track-columns",
				byteLength: this.outWidth * 8,
				usage: Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST,
			});
			const graph = new ComputeGraph<void>(
				this.device,
				`track-scan-${width}x${height}`,
			);
			const frame = graph.importTexture(
				{
					id: "frame",
					format: "rgba8unorm",
					width,
					height,
					usage: Texture.SAMPLE | Texture.COPY_DST | Texture.RENDER,
				},
				texture,
			);
			const columns = graph.importBuffer(
				"columns",
				this.outWidth * 8,
				output,
				output.usage,
			);
			graph.addKernel({
				id: "scan",
				spec,
				bindings: { frame, columns },
				workgroups: [this.outWidth],
			});
			graph.compile();
			const old = this.session;
			this.session = { width, height, outHeight, texture, output, graph };
			if (old) this.destroySession(old);
		})().finally(() => {
			this.building = null;
		});
		return this.building;
	}

	private destroySession(s: Session) {
		s.graph.destroy();
		s.texture.destroy();
		s.output.destroy();
	}

	scan(frame: TrackFrame): Promise<ScanResult | null> {
		const s = this.session;
		if (
			this.disposed ||
			!s ||
			s.width !== frame.width ||
			s.height !== frame.height
		) {
			// not ready (first frame or a size change): build in the background, skip this frame
			if (!this.disposed) void this.prepare(frame.width, frame.height);
			return Promise.resolve(null);
		}
		this.upload(s.texture, frame);
		this.inFlight++;
		const bytes = this.outWidth * 8;
		return s.graph
			.runNow(undefined, { read: [{ buffer: s.output, size: bytes }] })
			.then(({ data }) => {
				const raw = new Float32Array(data[0]);
				const rows = new Float32Array(this.outWidth);
				const weights = new Float32Array(this.outWidth);
				for (let x = 0; x < this.outWidth; x++) {
					const row = raw[2 * x];
					rows[x] = row < 0 ? Number.NaN : row;
					weights[x] = raw[2 * x + 1];
				}
				return {
					width: this.outWidth,
					height: s.outHeight,
					rows,
					weights,
				};
			})
			.finally(() => {
				this.inFlight--;
			});
	}

	dispose() {
		this.disposed = true;
		if (this.session) this.destroySession(this.session);
		this.session = null;
	}
}
