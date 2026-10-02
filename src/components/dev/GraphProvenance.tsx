// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useState } from "react";
import { LensGlyph } from "#/brand/LensGlyph";
import type { GraphInspection, NodeInspection } from "#/lib/gpu/core/inspect";

// The "lens" readout of /dev/graph: per node, what the inspection record says about how it runs.
// Fed only by GraphInspection (core/inspect.ts): node kind, condition (skip state), the preflight
// workload bound and the p50 timings. The luma compiler's lowering decisions (why a realization was
// chosen) are not part of that record, so they are not shown. Absent fields render nothing.

const ms = (value: number | undefined) =>
	value === undefined ? undefined : `${value.toFixed(3)} ms`;

/** The facts one node's record carries, in reading order; empty when it carries none. */
export function describeNode(node: NodeInspection): string[] {
	const facts: string[] = [];
	if (node.type) facts.push(node.type);
	if (node.condition) facts.push(node.condition);
	if (node.maximumInvocationCount !== undefined)
		facts.push(`up to ${node.maximumInvocationCount} invocations`);
	const cpu = ms(node.cpu.p50Ms);
	if (cpu) facts.push(`cpu p50 ${cpu}`);
	const gpu = ms(node.gpu.p50Ms);
	if (gpu) facts.push(`gpu p50 ${gpu}`);
	return facts;
}

/** Collapsed by default; renders nothing when no node has any recorded fact. */
export function GraphProvenance({
	nodes,
}: {
	nodes: GraphInspection["nodes"];
}) {
	const [open, setOpen] = useState(false);
	const rows = nodes
		.map((node) => ({ id: node.id, facts: describeNode(node) }))
		.filter((row) => row.facts.length > 0);
	if (!rows.length) return null;
	return (
		<div className="py-1 font-mono text-xs" data-testid="graph-provenance">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="inline-flex items-center gap-1.5 text-[var(--rigi-glow)]"
			>
				<LensGlyph size={12} />
				Provenance, as recorded ({rows.length})
			</button>
			{open && (
				<ul className="mt-1 pl-5 text-white/55">
					{rows.map((row) => (
						<li key={row.id}>
							<span className="text-[var(--rigi-paper)]">{row.id}</span>
							{": "}
							{row.facts.join(" · ")}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
