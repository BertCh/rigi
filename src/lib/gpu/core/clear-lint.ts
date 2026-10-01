// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// ComputeGraph's clear lint as a pure function over the scheduled node order (no luma import, so a
// node check can run it): graph transients are never zeroed and alias other transients' bytes, so
// - a transient written partially / atomically needs a clear node before that write and before any
//   other use of it in the encoding;
// - a transient written by a GPU-conditioned node (indirect dispatch: x = 0 skips it, any x writes
//   only part of it) counts as written partially, and then needs a WHOLE-buffer clear before that
//   node, when a later node (up to the next whole clear of it) may use it without the same GPU gate:
//   a node not gated by the same indirect command (same buffer and byteOffset), any node after the
//   command buffer is written again (the gate no longer says what the writer did), or a node the
//   lint cannot see (an unaudited raw g.graph.* or adopted-graph node: it may read anything).
// - a GPU-conditioned node the lint cannot see (not in `gates`) is refused outright.
// Imports (transient = false) are the caller's and are not linted.

/** What the lint needs of a graph buffer handle (GraphBufferHandle satisfies it). */
export type LintHandle = { readonly id: string; readonly transient: boolean };

/** A GPU-conditioned node's indirect command. */
export type LintGate<H> = { buffer: H; byteOffset: number };

/**
 * Per node id: buffers it clears (any range) / clears whole / writes partially / uses at all / writes
 * at all, and its gate. A node with no `uses` entry is unaudited (invisible to the lint).
 */
export type ClearAudit<H> = {
	clears: Map<string, H[]>;
	wholeClears: Map<string, H[]>;
	partial: Map<string, H[]>;
	uses: Map<string, H[]>;
	writes: Map<string, H[]>;
	gates: Map<string, LintGate<H>>;
};

const sameGate = <H>(a: LintGate<H>, b: LintGate<H> | undefined) =>
	!!b && a.buffer === b.buffer && a.byteOffset === b.byteOffset;

/**
 * The first clear-lint violation of `order` (scheduled node ids), or null. `gpuConditioned`: ids of
 * the scheduled nodes that carry a GPU condition (from the compiled graph's preflight), so a gated
 * node the audit did not record is refused.
 */
export function clearLintError<H extends LintHandle>(
	order: readonly string[],
	audit: ClearAudit<H>,
	gpuConditioned: readonly string[] = [],
): string | null {
	const { clears, wholeClears, partial, uses, writes, gates } = audit;
	for (const id of gpuConditioned)
		if (!gates.has(id))
			return `GPU-conditioned node ${id} is outside the clear lint (add it with addKernel / addComputePass, or declareNode it)`;
	// [node, buffer, why, needs a whole clear]: the buffer needs a clear before the node
	const needs: [string, H, string, boolean][] = [];
	for (const [node, bufs] of partial)
		for (const b of bufs)
			needs.push([
				node,
				b,
				`is written partially / atomically by ${node}`,
				false,
			]);
	for (const [node, gate] of gates) {
		const at = order.indexOf(node);
		for (const b of writes.get(node) ?? []) {
			if (!b.transient) continue;
			// the gated writer may itself rewrite its command (read at dispatch, before its writes)
			let rewritten = !!writes.get(node)?.includes(gate.buffer);
			for (const n of order.slice(at + 1)) {
				if (wholeClears.get(n)?.includes(b)) break;
				const seen = uses.get(n);
				const why = !seen
					? `may be used by ${n} (outside the clear lint)`
					: !seen.includes(b)
						? ""
						: rewritten
							? `is used by ${n} after its indirect command "${gate.buffer.id}" was rewritten`
							: !sameGate(gate, gates.get(n))
								? `is used by ${n} (not gated by the same indirect command)`
								: "";
				if (why) {
					needs.push([
						node,
						b,
						`is written by GPU-conditioned ${node} and ${why}`,
						true,
					]);
					break;
				}
				if (writes.get(n)?.includes(gate.buffer)) rewritten = true;
			}
		}
	}
	for (const [node, b, why, whole] of needs) {
		if (!b.transient) continue;
		const clearing = whole ? wholeClears : clears;
		const at = order.indexOf(node);
		let cleared = false;
		for (const n of order.slice(0, at)) {
			if (clearing.get(n)?.includes(b)) cleared = true;
			else if (!cleared && uses.get(n)?.includes(b))
				return `${n} uses transient "${b.id}" before its ${whole ? "whole-buffer " : ""}clear node`;
		}
		if (!cleared)
			return `transient "${b.id}" ${why} without a ${whole ? "whole-buffer " : ""}clear node before it`;
	}
	return null;
}
