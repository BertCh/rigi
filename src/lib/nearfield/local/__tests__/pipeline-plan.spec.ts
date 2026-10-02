// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { CpuNn } from "#/lib/nn/cpu";
import { composeParamWords, composeWorkgroups } from "../compose-gpu";
import { resamplePosEmbed, tokenGrid } from "../depth-net";
import { cpuPathReadBytes, planDepthPipeline } from "../pipeline-gpu";

describe("planDepthPipeline", () => {
	it("sizes a 1024 x 768 photo", () => {
		const p = planDepthPipeline(1024, 768, 1200);
		const [bh, bw] = tokenGrid(1200, 1024 / 768);
		expect([p.bh, p.bw]).toEqual([bh, bw]);
		expect(p.ih).toBe(bh * 14);
		expect(p.iw).toBe(bw * 14);
		expect(p.upsample).toBe(false);
		expect(p.depthBytes).toBe(1024 * 768 * 4);
		expect(p.normalBytes).toBe(3 * 1024 * 768 * 4);
		expect(p.cells).toBe(512 * 384);
		expect(p.recordsBytes).toBe(512 * 384 * 48);
		// graph 1 reads points64 (64·64·3) + mask64 (64·64) + the scale, as f32
		expect(p.graph1ReadBytes).toBe((64 * 64 * 4 + 1) * 4);
		expect(p.graph2ReadBytes).toBe(
			p.depthBytes + p.normalBytes + p.recordsBytes,
		);
	});

	it("flags a photo smaller than the net input as an upsample", () => {
		expect(planDepthPipeline(320, 240, 1200).upsample).toBe(true);
		expect(planDepthPipeline(1024, 768, 1200).upsample).toBe(false);
	});

	it("reads far less than the CPU path before graph 2 (64² vs full planes)", () => {
		const p = planDepthPipeline(1024, 768, 1200);
		expect(p.graph1ReadBytes).toBeLessThan(
			cpuPathReadBytes(1024, 768, true) / 100,
		);
		expect(cpuPathReadBytes(1024, 768, false)).toBeLessThan(
			cpuPathReadBytes(1024, 768, true),
		);
	});
});

describe("compose kernel launch", () => {
	it("covers n pixels with at most 4096 groups in x", () => {
		for (const n of [1, 255, 256, 257, 786432, 4096 * 256 * 3 + 1]) {
			const [x, y] = composeWorkgroups(n);
			expect(x).toBeLessThanOrEqual(4096);
			expect(x * y * 256).toBeGreaterThanOrEqual(n);
		}
	});

	it("packs n, hasNormal, shift and scale", () => {
		const w = composeParamWords(10, true, 0.5, 2);
		const u = new Uint32Array(w);
		const f = new Float32Array(w);
		expect([u[0], u[1], f[2], f[3]]).toEqual([10, 1, 0.5, 2]);
	});
});

describe("resamplePosEmbed sizing (bicubic scale_factor semantics)", () => {
	it("gives (1 + bh·bw) rows for grids around the checkpoint's 37 x 37", async () => {
		const nn = new CpuNn();
		const M = 37;
		const C = 4;
		const pos = nn.fromArray(
			Float32Array.from({ length: (1 + M * M) * C }, (_, i) => Math.sin(i)),
			[1, 1 + M * M, C],
		);
		for (const [bh, bw] of [
			[30, 40],
			[40, 30],
			[11, 17],
			[37, 37],
		]) {
			const out = resamplePosEmbed(nn, pos, M, bh, bw);
			expect(out.shape).toEqual([1, 1 + bh * bw, C]);
		}
		// the cls row passes through
		const out = await nn.read(resamplePosEmbed(nn, pos, M, 30, 40));
		const src = await nn.read(pos);
		expect([...out.slice(0, C)]).toEqual([...src.slice(0, C)]);
	});
});
