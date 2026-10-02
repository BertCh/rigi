// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Fusion planning over a recording's node list (pure CPU, no device):
// - fuseElementwise: an elementwise node (unary / binary / where, `Node.ew`) absorbs the elementwise
//   nodes that produce its operands when they feed nothing else and have the same shape (bias add +
//   gelu, a * gamma + residual, ...). The result is one kernel over the leaves of the expression tree.
// - fuseLayerNorm: a layerNorm whose input is an elementwise node over flat operands becomes one
//   kernel that evaluates the expression itself (broadcast operands included) (the residual add of a transformer block), and still
//   writes the expression's value when something else reads it (the residual stream).
// Both mutate nodes in place and return the list without the absorbed nodes. GEMM / conv epilogues
// are fuseEpilogues in runtime.ts and run first.

import { sameShape, stridesOf } from "../shape";
import { type EwDesc, ewKernel } from "./k-elementwise";
import { layerNormResidualKernel } from "./k-fused";
import { getKernelCaps } from "./kernel-caps";
import type { Node, Storage } from "./runtime";

/** The default WebGPU maxStorageBuffersPerShaderStage; GpuNn raises the limit to the device's own. */
export const DEFAULT_KERNEL_BUFFERS = 8;

/**
 * Storage buffer bindings a fused kernel may use (the parameter buffer included): the device's
 * `maxStorageBuffersPerShaderStage`, set by GpuNn's constructor through kernel-caps (capped, a
 * longer fused chain gains nothing past this).
 */
const kernelBuffers = () => getKernelCaps().maxStorageBuffers;

type Graph = {
	consumers: Map<Storage, number>;
	producers: Map<Storage, Node[]>;
};

function analyse(nodes: Node[]): Graph {
	const consumers = new Map<Storage, number>();
	const producers = new Map<Storage, Node[]>();
	for (const n of nodes) {
		for (const s of n.inputs) consumers.set(s, (consumers.get(s) ?? 0) + 1);
		for (const s of n.outputs) {
			const l = producers.get(s);
			if (l) l.push(n);
			else producers.set(s, [n]);
		}
	}
	return { consumers, producers };
}

const tensorOps = (d: EwDesc) => d.ops.filter((o) => o.kind === "tensor");

/** The sole node writing `s` (undefined for several writers or none). */
const soleProducer = (g: Graph, s: Storage) => {
	const l = g.producers.get(s);
	return l?.length === 1 ? l[0] : undefined;
};

/** Every input of `n` is written at most once (so reading it at a later position is safe). */
const singleAssignment = (g: Graph, n: Node) =>
	n.inputs.every((s) => (g.producers.get(s)?.length ?? 0) <= 1);

const isContiguous = (strides: readonly number[], shape: readonly number[]) =>
	strides.every((v, i) => v === stridesOf(shape)[i]);

export function fuseElementwise(nodes: Node[], outputs: Set<Storage>): Node[] {
	const g = analyse(nodes);
	const dropped = new Set<Node>();
	const merged = new Set<Node>();
	for (const c of nodes) {
		if (!c.ew || dropped.has(c)) continue;
		for (let again = true; again; ) {
			again = false;
			const d = c.ew as EwDesc;
			let ti = 0;
			for (let k = 0; k < d.ops.length; k++) {
				const o = d.ops[k];
				if (o.kind !== "tensor") continue;
				const st = c.inputs[ti];
				const p = soleProducer(g, st);
				const pd = p?.ew;
				if (
					p &&
					pd &&
					p !== c &&
					!dropped.has(p) &&
					p.outputs.length === 1 &&
					g.consumers.get(st) === 1 &&
					!outputs.has(st) &&
					sameShape(pd.shape, d.shape) &&
					isContiguous(o.strides, d.shape) &&
					singleAssignment(g, p) &&
					tensorOps(d).length - 1 + tensorOps(pd).length <= kernelBuffers() - 2
				) {
					c.ew = absorb(d, k, pd);
					c.inputs = [
						...c.inputs.slice(0, ti),
						...p.inputs,
						...c.inputs.slice(ti + 1),
					];
					c.act = undefined;
					c.fuse = undefined;
					dropped.add(p);
					merged.add(c);
					again = true;
					break;
				}
				ti++;
			}
		}
	}
	for (const c of merged) {
		Object.assign(c, ewKernel(c.ew as EwDesc));
		c.luma = undefined;
		c.textures = undefined;
	}
	return dropped.size ? nodes.filter((n) => !dropped.has(n)) : nodes;
}

/** `c` with operand `k` replaced by the whole of `p` (p's result feeds c's statement). */
export function absorb(c: EwDesc, k: number, p: EwDesc): EwDesc {
	return {
		shape: c.shape,
		ops: [...c.ops.slice(0, k), ...p.ops, ...c.ops.slice(k + 1)],
		key: `${c.key}[${k}=${p.key}]`,
		stmt: (names, out, uid) => {
			const v = `p${uid()}`;
			const pn = names.slice(k, k + p.ops.length);
			const cn = [...names.slice(0, k), v, ...names.slice(k + p.ops.length)];
			return `var ${v} = 0.0;\n  { ${p.stmt(pn, v, uid)} }\n  { ${c.stmt(cn, out, uid)} }`;
		},
	};
}

/**
 * Conv fusion (plain implicit-GEMM convs, `Node.conv`):
 * - a replicate pad feeding only the conv folds into the conv's loads (clamped coordinates), so the
 *   padded copy is never written;
 * - the residual add after the conv (`ew` key bin-add over two contiguous same-shape tensors, one of
 *   them the conv's output, consumed by nothing else) folds into the store: out = act(conv + bias) + res.
 */
export function fuseConv(nodes: Node[], outputs: Set<Storage>): Node[] {
	if (getKernelCaps().legacy) return nodes;
	const g = analyse(nodes);
	const at = new Map(nodes.map((n, i) => [n, i]));
	const dropped = new Set<Node>();
	for (const c of nodes) {
		const conv = c.conv;
		if (!conv || dropped.has(c)) continue;
		let replicatePad: [number, number] | null = null;
		const xin = c.inputs[0];
		const pn = soleProducer(g, xin);
		if (
			pn?.pad &&
			!dropped.has(pn) &&
			g.consumers.get(xin) === 1 &&
			!outputs.has(xin) &&
			pn.outputs.length === 1 &&
			pn.pad.height[0] === pn.pad.height[1] &&
			pn.pad.width[0] === pn.pad.width[1] &&
			singleAssignment(g, pn) &&
			(at.get(pn) as number) < (at.get(c) as number)
		) {
			replicatePad = [pn.pad.height[0], pn.pad.width[0]];
			c.inputs = [pn.inputs[0], ...c.inputs.slice(1)];
			dropped.add(pn);
		}
		const y = c.outputs[0];
		let residual: Storage | null = null;
		let add: Node | undefined;
		if (c.outputs.length === 1 && g.consumers.get(y) === 1 && !outputs.has(y)) {
			add = nodes.find(
				(n) =>
					!dropped.has(n) && n.ew?.key === "bin-add" && n.inputs.includes(y),
			);
			const d = add?.ew;
			if (add && d && add.inputs.length === 2 && add.outputs.length === 1) {
				const other = add.inputs[0] === y ? add.inputs[1] : add.inputs[0];
				const shape = d.shape;
				const op = tensorOps(d);
				const rp = soleProducer(g, other);
				if (
					other !== y &&
					op.length === 2 &&
					op.every(
						(o) => o.dtype === "f32" && isContiguous(o.strides, shape),
					) &&
					singleAssignment(g, add) &&
					(g.producers.get(other)?.length ?? 0) <= 1 &&
					(!rp || (at.get(rp) as number) < (at.get(c) as number)) &&
					c.inputs.length + 1 + 1 + 1 <= kernelBuffers()
				)
					residual = other;
				else add = undefined;
			} else add = undefined;
		}
		if (!replicatePad && !residual) continue;
		Object.assign(c, conv.make({ residual: residual !== null, replicatePad }));
		c.fuse = undefined;
		c.luma = undefined;
		c.textures = undefined;
		if (residual && add) {
			c.inputs = [...c.inputs, residual];
			c.outputs = [add.outputs[0]];
			dropped.add(add);
		}
		c.conv = undefined;
	}
	return dropped.size ? nodes.filter((n) => !dropped.has(n)) : nodes;
}

export function fuseLayerNorm(nodes: Node[], outputs: Set<Storage>): Node[] {
	const g = analyse(nodes);
	const at = new Map(nodes.map((n, i) => [n, i]));
	const dropped = new Set<Node>();
	for (const l of nodes) {
		const ln = l.ln;
		if (!ln || dropped.has(l)) continue;
		const x = l.inputs[0];
		const p = soleProducer(g, x);
		const pd = p?.ew;
		if (!p || !pd || p.outputs.length !== 1 || dropped.has(p)) continue;
		if ((at.get(p) as number) > (at.get(l) as number)) continue;
		if (pd.shape.reduce((a, b) => a * b, 1) !== ln.rows * ln.C) continue;
		if (l.inputs.filter((s) => s === x).length !== 1) continue;
		if (!singleAssignment(g, p)) continue;
		// w and b must exist at p's position
		const params = l.inputs.slice(1);
		if (
			params.some((s) => {
				const q = soleProducer(g, s);
				return (
					(g.producers.get(s)?.length ?? 0) > 1 ||
					(q && (at.get(q) as number) >= (at.get(p) as number))
				);
			})
		)
			continue;
		const emitSum = (g.consumers.get(x) ?? 0) > 1 || outputs.has(x);
		const buffers =
			1 + tensorOps(pd).length + params.length + (emitSum ? 2 : 1);
		if (buffers > kernelBuffers()) continue;
		Object.assign(p, layerNormResidualKernel(pd, ln, emitSum));
		p.inputs = [...p.inputs, ...params];
		p.outputs = emitSum ? [l.outputs[0], x] : [l.outputs[0]];
		p.luma = undefined;
		p.textures = undefined;
		p.act = undefined;
		p.fuse = undefined;
		p.ew = undefined;
		dropped.add(l);
	}
	return dropped.size ? nodes.filter((n) => !dropped.has(n)) : nodes;
}
