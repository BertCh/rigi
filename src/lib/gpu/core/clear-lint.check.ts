// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// ComputeGraph clear lint (core/clear-lint.ts), node-only. Run: npx tsx src/lib/gpu/core/clear-lint.check.ts
import { type ClearAudit, clearLintError, type LintHandle } from "./clear-lint";

type H = LintHandle;
const T = (id: string): H => ({ id, transient: true });
const I = (id: string): H => ({ id, transient: false });

/**
 * A node: what it clears whole / clears partly / writes partially / uses / writes, and its gate
 * (buffer, byteOffset); `unknown`: scheduled but not audited (an undeclared raw node).
 */
type N = {
	id: string;
	clears?: H[];
	partClears?: H[];
	unknown?: true;
	partial?: H[];
	uses?: H[];
	writes?: H[];
	gate?: [H, number];
};
const lint = (nodes: N[], gpuConditioned: string[] = []) => {
	const audit: ClearAudit<H> = {
		clears: new Map(),
		wholeClears: new Map(),
		partial: new Map(),
		uses: new Map(),
		writes: new Map(),
		gates: new Map(),
	};
	for (const n of nodes) {
		if (n.unknown) continue;
		const cl = [...(n.clears ?? []), ...(n.partClears ?? [])];
		if (cl.length) audit.clears.set(n.id, cl);
		if (n.clears) audit.wholeClears.set(n.id, n.clears);
		audit.partial.set(n.id, n.partial ?? []);
		const uses = [...(n.uses ?? []), ...cl];
		if (n.gate) uses.push(n.gate[0]);
		audit.uses.set(n.id, uses);
		audit.writes.set(n.id, [...(n.writes ?? []), ...cl]);
		if (n.gate)
			audit.gates.set(n.id, { buffer: n.gate[0], byteOffset: n.gate[1] });
	}
	return clearLintError(
		nodes.map((n) => n.id),
		audit,
		gpuConditioned,
	);
};

const failures: string[] = [];
let cases = 0;
const expect = (name: string, got: string | null, want: string | null) => {
	cases++;
	const ok = want === null ? got === null : !!got?.includes(want);
	if (!ok) failures.push(`${name}: got ${JSON.stringify(got)}, want ${want}`);
};

const v = T("v");
const acc = T("acc");
const cmd = I("cmd");
const cmd2 = I("cmd2");
const out = I("out");

// --- partial / atomic writes (the pre-W0.1 rule, unchanged) ---
expect(
	"atomic without clear",
	lint([{ id: "h", partial: [acc], uses: [acc], writes: [acc] }]),
	'transient "acc" is written partially / atomically by h without a clear node',
);
expect(
	"atomic with clear",
	lint([
		{ id: "c", clears: [acc] },
		{ id: "h", partial: [acc], uses: [acc], writes: [acc] },
	]),
	null,
);
expect(
	"use before clear",
	lint([
		{ id: "peek", uses: [acc] },
		{ id: "c", clears: [acc] },
		{ id: "h", partial: [acc], uses: [acc], writes: [acc] },
	]),
	"peek uses transient",
);
expect(
	"partial import not linted",
	lint([{ id: "h", partial: [out], uses: [out], writes: [out] }]),
	null,
);

// --- GPU-conditioned writers (W0.1) ---
const fill: N = { id: "fill", uses: [v], writes: [v], gate: [cmd, 0] };
expect(
	"gated writer, ungated reader, no clear",
	lint([fill, { id: "read", uses: [v] }]),
	"written by GPU-conditioned fill and is used by read",
);
expect(
	"gated writer, ungated reader, clear before",
	lint([{ id: "c", clears: [v] }, fill, { id: "read", uses: [v] }]),
	null,
);
expect(
	"gated writer, same-gate reader",
	lint([fill, { id: "plus1", uses: [v, out], writes: [out], gate: [cmd, 0] }]),
	null,
);
expect(
	"same buffer, other byteOffset is another gate",
	lint([fill, { id: "plus1", uses: [v, out], writes: [out], gate: [cmd, 16] }]),
	"used by plus1",
);
expect(
	"other indirect buffer is another gate",
	lint([fill, { id: "plus1", uses: [v, out], writes: [out], gate: [cmd2, 0] }]),
	"used by plus1",
);
expect(
	"gated writer, no later use",
	lint([fill, { id: "other", uses: [out], writes: [out] }]),
	null,
);
expect(
	"a clear after the gated writer ends its reach",
	lint([fill, { id: "c", clears: [v] }, { id: "read", uses: [v] }]),
	null,
);
expect(
	"same-gate reader then ungated reader",
	lint([
		fill,
		{ id: "plus1", uses: [v, out], writes: [out], gate: [cmd, 0] },
		{ id: "read", uses: [v] },
	]),
	"used by read",
);
expect(
	"use before the clear that guards a gated writer",
	lint([
		{ id: "peek", uses: [v] },
		{ id: "c", clears: [v] },
		fill,
		{ id: "read", uses: [v] },
	]),
	"peek uses transient",
);
expect(
	"gated writer of an import",
	lint([
		{ id: "fillOut", uses: [out], writes: [out], gate: [cmd, 0] },
		{ id: "read", uses: [out] },
	]),
	null,
);
expect(
	"gated reader of a gated writer's output feeds an ungated reader",
	lint([
		{ id: "c", clears: [v] },
		fill,
		{ id: "g2", uses: [v, acc], writes: [acc], gate: [cmd, 0] },
		{ id: "read", uses: [acc] },
	]),
	"written by GPU-conditioned g2 and is used by read",
);

// --- review fixes: command rewrite, unseen nodes, whole clears ---
const writeCmd: N = { id: "writeCmd", uses: [cmd], writes: [cmd] };
const plus1: N = { id: "plus1", uses: [v, out], writes: [out], gate: [cmd, 0] };
expect(
	"same gate after the command is rewritten",
	lint([fill, writeCmd, plus1]),
	'used by plus1 after its indirect command "cmd" was rewritten',
);
expect(
	"same gate before the command is rewritten",
	lint([fill, plus1, writeCmd]),
	null,
);
expect(
	"a clear node on the command buffer is a rewrite",
	lint([fill, { id: "zeroCmd", clears: [cmd] }, plus1]),
	"was rewritten",
);
expect(
	"the gated writer rewriting its own command",
	lint([{ ...fill, uses: [v, cmd], writes: [v, cmd] }, plus1]),
	"was rewritten",
);
expect(
	"rewritten command, whole clear before the writer",
	lint([{ id: "c", clears: [v] }, fill, writeCmd, plus1]),
	null,
);
expect(
	"an unaudited node after a gated writer",
	lint([fill, { id: "opaque", unknown: true }]),
	"may be used by opaque (outside the clear lint)",
);
expect(
	"an unaudited node, whole clear before the writer",
	lint([{ id: "c", clears: [v] }, fill, { id: "opaque", unknown: true }]),
	null,
);
expect(
	"an unaudited node without any GPU gate",
	lint([
		{ id: "f", uses: [v], writes: [v] },
		{ id: "opaque", unknown: true },
	]),
	null,
);
expect(
	"an unrecorded GPU-conditioned node",
	lint(
		[
			{ id: "f", uses: [v], writes: [v] },
			{ id: "opaque", unknown: true },
		],
		["opaque"],
	),
	"GPU-conditioned node opaque is outside the clear lint",
);
expect(
	"a partial clear does not satisfy the GPU rule",
	lint([{ id: "c", partClears: [v] }, fill, { id: "read", uses: [v] }]),
	"whole-buffer clear node",
);
expect(
	"a partial clear still satisfies the atomic rule",
	lint([
		{ id: "c", partClears: [acc] },
		{ id: "h", partial: [acc], uses: [acc], writes: [acc] },
	]),
	null,
);
expect(
	"a partial clear after the gated writer does not end its reach",
	lint([fill, { id: "c", partClears: [v] }, { id: "read", uses: [v] }]),
	"used by c",
);

if (failures.length) {
	for (const f of failures) console.error(`FAIL ${f}`);
	process.exit(1);
}
console.log(`clear-lint ok: ${cases} cases`);
