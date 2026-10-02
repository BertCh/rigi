// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * The MediaPipe people segmenters (DeepLab v3, selfie multiclass) on the nn runtime. scripts/models/
 * mediapipe-seg.py turns each float32 .tflite into fp16 safetensors whose `__metadata__.program` is the
 * exported TFLite op list (layout `rigi-tflite-1`); this file interprets exactly that topology, so the
 * MobileNetV2 / ASPP / attention-block structure is not re-derived by hand.
 *
 * TFLite is NHWC, nn is NCHW. Every value is held lazily in whichever layout produced it and permuted on
 * demand (cached): convs, resizes and pooling run NCHW; reshape / transpose / softmax / sum (the selfie
 * model's window-partition attention) run on the NHWC view; a stride-1 1x1 conv on a value that only
 * exists as NHWC is a `linear` over the channel axis (no permute). Fused relu / relu6 are nn unaries
 * (nn fuses them into the conv store).
 */
import type { Nn, Tensor, Weights } from "#/lib/nn";

type Act = "" | "relu" | "relu6";
type Op =
	| [
			"conv",
			string,
			string,
			string,
			number,
			[number, number, number, number],
			number,
			number,
			Act,
	  ]
	| ["tconv", string, string, string, number, Act]
	| ["add" | "mul", string, string, string, Act]
	| ["reshape", string, string, number[]]
	| ["transpose", string, string, number[]]
	| ["softmax" | "gap", string, string]
	| ["sum", string, string, number]
	| ["cat", string, string[], number]
	| [
			"resize",
			string,
			string,
			[number, number],
			"bilinear" | "nearest",
			boolean,
	  ];

export interface TfliteNet {
	readonly weights: Weights;
	readonly program: readonly Op[];
	readonly input: string;
	readonly output: string;
	/** Model input [1, H, W, 3] (NHWC). */
	readonly inputShape: readonly number[];
	/** Model output [1, H, W, C] (NHWC). */
	readonly outputShape: readonly number[];
	/** MediaPipe's preprocessing: (byte - mean) / std on 0..255 RGB. */
	readonly mean: number;
	readonly std: number;
}

/** Binds a loaded weights file (nn.loadWeights / nn.weightsFromBytes) to its program. */
export function bindTfliteNet(weights: Weights): TfliteNet {
	const md = weights.metadata;
	if (!md.program || md.layout !== "rigi-tflite-1")
		throw new Error("tflite-net: not a rigi-tflite-1 weights file");
	return {
		weights,
		program: JSON.parse(md.program) as Op[],
		input: md.input,
		output: md.output,
		inputShape: JSON.parse(md.inputShape),
		outputShape: JSON.parse(md.outputShape),
		mean: Number(md.mean),
		std: Number(md.std),
	};
}

/** One value in one or both layouts. */
type Val = { nhwc?: Tensor; nchw?: Tensor };

export interface TfliteRun {
	/** Model output as [1, C, H, W] (NCHW) f32; for the selfie model these are logits. */
	output: Tensor;
	/** Requested intermediates (`trace`) as NHWC tensors, by tensor name `t<i>`. */
	taps: Record<string, Tensor>;
}

/**
 * The forward pass. Call it inside `nn.forward(() => …)` on the GPU backend (one graph submission) or
 * directly on the CPU backend. `x` is the preprocessed NHWC input [1, H, W, 3] and is not consumed.
 */
export function runTfliteNet(
	nn: Nn,
	net: TfliteNet,
	x: Tensor,
	trace: ReadonlySet<string> = new Set(),
): TfliteRun {
	const vals = new Map<string, Val>([[net.input, { nhwc: x }]]);
	const toNhwc = (v: Val): Tensor => {
		v.nhwc ??= nn.permute(v.nchw as Tensor, [0, 2, 3, 1]);
		return v.nhwc;
	};
	const toNchw = (v: Val): Tensor => {
		v.nchw ??= nn.permute(v.nhwc as Tensor, [0, 3, 1, 2]);
		return v.nchw;
	};
	const val = (name: string): Val => {
		const v = vals.get(name);
		if (!v) throw new Error(`tflite-net: undefined tensor ${name}`);
		return v;
	};
	const activate = (y: Tensor, act: Act): Tensor =>
		act === "relu" ? nn.relu(y) : act === "relu6" ? nn.clamp(y, 0, 6) : y;
	// an add / mul operand: a tensor value, or an fp32 constant ([C], broadcast over the channel axis)
	const operand = (name: string, nchw: boolean): { t: Tensor } => {
		if (name.startsWith("c")) {
			const c = net.weights.get(name);
			return {
				t:
					nchw && c.shape.length === 1
						? nn.reshape(c, [1, c.shape[0], 1, 1])
						: c,
			};
		}
		const v = val(name);
		return { t: nchw ? toNchw(v) : toNhwc(v) };
	};

	for (const op of net.program) {
		const out: Val = {};
		switch (op[0]) {
			case "conv": {
				const [, , inName, name, stride, pad, dilation, groups, act] = op;
				const w = net.weights.get(`${name}.w`);
				const b = net.weights.get(`${name}.b`);
				const v = val(inName);
				const kh = w.shape[2];
				const kw = w.shape[3];
				if (
					kh === 1 &&
					kw === 1 &&
					stride === 1 &&
					groups === 1 &&
					v.nhwc &&
					!v.nchw
				) {
					// 1x1 conv on an NHWC-only value = linear over the channel axis
					out.nhwc = activate(
						nn.linear(v.nhwc, nn.reshape(w, [w.shape[0], w.shape[1]]), b),
						act,
					);
					break;
				}
				let xin = toNchw(v);
				const [pt, pb, pl, pr] = pad;
				const symmetric = pt === pb && pl === pr;
				if (!symmetric) xin = nn.pad(xin, [pl, pr, pt, pb]);
				out.nchw = activate(
					nn.conv2d(xin, w, b, {
						stride,
						padding: symmetric ? [pt, pl] : 0,
						dilation,
						groups,
					}),
					act,
				);
				break;
			}
			case "tconv": {
				const [, , inName, name, stride, act] = op;
				out.nchw = activate(
					nn.convTranspose2d(
						toNchw(val(inName)),
						net.weights.get(`${name}.w`),
						net.weights.get(`${name}.b`),
						{ stride },
					),
					act,
				);
				break;
			}
			case "add":
			case "mul": {
				const [kind, , an, bn, act] = op;
				const va = an.startsWith("c") ? undefined : val(an);
				const vb = bn.startsWith("c") ? undefined : val(bn);
				// NCHW when every tensor operand already has that layout, else NHWC
				const nchw = (!va || !!va.nchw) && (!vb || !!vb.nchw);
				const a = operand(an, nchw).t;
				const b = operand(bn, nchw).t;
				const y = activate(kind === "add" ? nn.add(a, b) : nn.mul(a, b), act);
				if (nchw) out.nchw = y;
				else out.nhwc = y;
				break;
			}
			case "reshape":
				out.nhwc = nn.reshape(toNhwc(val(op[2])), op[3]);
				break;
			case "transpose":
				out.nhwc = nn.permute(toNhwc(val(op[2])), op[3]);
				break;
			case "softmax":
				out.nhwc = nn.softmax(toNhwc(val(op[2])), -1);
				break;
			case "sum":
				out.nhwc = nn.sum(toNhwc(val(op[2])), op[3], true);
				break;
			case "gap":
				out.nchw = nn.mean(nn.mean(toNchw(val(op[2])), 3, true), 2, true);
				break;
			case "cat": {
				const vs = op[2].map(val);
				if (op[3] === 3) out.nchw = nn.concat(vs.map(toNchw), 1);
				else out.nhwc = nn.concat(vs.map(toNhwc), op[3]);
				break;
			}
			case "resize": {
				const [, , inName, size, mode, alignCorners] = op;
				const xin = toNchw(val(inName));
				out.nchw =
					xin.shape[2] === size[0] && xin.shape[3] === size[1]
						? xin
						: nn.interpolate(xin, { size, mode, alignCorners });
				break;
			}
		}
		vals.set(op[1], out);
	}
	const taps: Record<string, Tensor> = {};
	for (const name of trace) taps[name] = toNhwc(val(name));
	return { output: toNchw(val(net.output)), taps };
}
