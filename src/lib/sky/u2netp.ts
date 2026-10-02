// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * U²-Net-P sky segmenter (MIT; 1.1 M parameters, 119 convs) on the nn runtime: WGSL kernels on one core
 * ComputeGraph per forward on WebGPU, the CPU reference backend elsewhere. Replaces onnxruntime-web.
 *
 * Weights: scripts/models/u2netp.py turns the ONNX export (public/models/skyseg-u2netp.873ea284.onnx) into
 * fp16 safetensors (`U2NETP_WEIGHTS`) whose `__metadata__.program` is the exported data-flow graph (conv with
 * dilation, relu, 2x2 max-pool, bilinear resize to a partner's size, concat, residual add, final sigmoid), so
 * this file runs exactly the exported topology; the RSU blocks are not re-derived by hand. BatchNorm was
 * already folded into the convs by the ncnn export.
 *
 * Input: ImageNet-normalised NCHW [1, 3, H, W] (sky/core.ts `normalise`) with H, W multiples of 32 (the six
 * encoder stages halve five times and the ceil-free pools need it); output P(sky) [1, 1, H, W].
 */
import type { Nn, Tensor, Weights } from "#/lib/nn";

export const U2NETP_WEIGHTS = "skyseg-u2netp-nn.884ee489.safetensors";

type Op =
	| ["conv", string, string, string, number, number]
	| ["relu" | "pool" | "sigmoid", string, string]
	| ["cat", string, string[]]
	| ["up", string, string, string]
	| ["add", string, string, string];

export interface U2Netp {
	readonly weights: Weights;
	readonly program: readonly Op[];
	readonly input: string;
	readonly output: string;
	/** Tensor names of the eleven RSU stage outputs (the residual adds), in execution order. */
	readonly stages: readonly string[];
	/** Tensor names of the six side maps (the 1-channel convs feeding the fuse). */
	readonly sides: readonly string[];
}

/** Binds a loaded weights file (nn.loadWeights / nn.weightsFromBytes) to its program. */
export function bindU2netp(weights: Weights): U2Netp {
	const raw = weights.metadata.program;
	if (!raw || weights.metadata.layout !== "rigi-u2netp-1")
		throw new Error("u2netp: not a rigi-u2netp-1 weights file");
	const program = JSON.parse(raw) as Op[];
	const sides = program
		.filter((o) => o[0] === "conv" && weights.get(`${o[3]}.w`).shape[0] === 1)
		.map((o) => o[1]);
	return {
		weights,
		program,
		input: weights.metadata.input,
		output: weights.metadata.output,
		stages: program.filter((o) => o[0] === "add").map((o) => o[1]),
		// the last conv is the fuse; the sides are the other 1-channel convs
		sides: sides.slice(0, -1).map((n) => n.replace(/_pre$/, "")),
	};
}

export async function loadU2netp(
	nn: Nn,
	opts: Parameters<Nn["loadWeights"]>[1] = {},
): Promise<U2Netp> {
	return bindU2netp(await nn.loadWeights(U2NETP_WEIGHTS, opts));
}

export interface U2netpRun {
	/** P(sky) [1, 1, H, W]. */
	prob: Tensor;
	/** Requested intermediates (`trace`), by ONNX tensor name. */
	taps: Record<string, Tensor>;
}

/**
 * The forward pass. Call it inside `nn.forward(() => …)` on the GPU backend (one graph submission) or
 * directly on the CPU backend. `x` is the normalised [1, 3, H, W] input and is not consumed. `trace`
 * names intermediates to return alongside (parity checks). On the CPU backend every intermediate is freed
 * after its last use.
 */
export function runU2netp(
	nn: Nn,
	m: U2Netp,
	x: Tensor,
	trace: ReadonlySet<string> = new Set(),
): U2netpRun {
	const t = new Map<string, Tensor>([[m.input, x]]);
	const lastUse = new Map<string, number>();
	m.program.forEach((o, i) => {
		const ins = o[0] === "cat" ? o[2] : o[0] === "add" ? [o[2], o[3]] : [o[2]];
		for (const n of ins) lastUse.set(n, i);
		if (o[0] === "up") lastUse.set(o[3], i);
	});
	const free = nn.backend.kind === "cpu";
	const get = (n: string) => {
		const v = t.get(n);
		if (!v) throw new Error(`u2netp: undefined tensor ${n}`);
		return v;
	};
	const taps: Record<string, Tensor> = {};
	m.program.forEach((o, i) => {
		let y: Tensor;
		switch (o[0]) {
			case "conv":
				y = nn.conv2d(
					get(o[2]),
					m.weights.get(`${o[3]}.w`),
					m.weights.get(`${o[3]}.b`),
					{ padding: o[5], dilation: o[4] },
				);
				break;
			case "relu":
				y = nn.relu(get(o[2]));
				break;
			case "pool":
				y = nn.maxPool2d(get(o[2]), { kernel: 2, stride: 2, ceilMode: false });
				break;
			case "sigmoid":
				y = nn.sigmoid(get(o[2]));
				break;
			case "cat":
				y = nn.concat(o[2].map(get), 1);
				break;
			case "add":
				y = nn.add(get(o[2]), get(o[3]));
				break;
			case "up": {
				const r = get(o[3]).shape;
				y = nn.interpolate(get(o[2]), {
					size: [r[2], r[3]],
					mode: "bilinear",
					alignCorners: false,
				});
				break;
			}
		}
		t.set(o[1], y);
		if (trace.has(o[1])) taps[o[1]] = y;
		if (free) {
			const names = new Set(
				o[0] === "cat"
					? o[2]
					: o[0] === "add"
						? [o[2], o[3]]
						: o[0] === "up"
							? [o[2], o[3]]
							: [o[2]],
			);
			for (const n of names)
				if (lastUse.get(n) === i && n !== m.input && !trace.has(n)) {
					nn.dispose(get(n));
					t.delete(n);
				}
		}
	});
	return { prob: get(m.output), taps };
}
