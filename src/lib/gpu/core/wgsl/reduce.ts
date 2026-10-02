// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared WGSL for workgroup tree reductions. The reductions in Rigi's kernels are fused into larger
// kernels (the partial is consumed in the same dispatch), so `GPUReduction` cannot replace them; these
// generators emit the *inlined statements* instead, so a kernel keeps its own workgroup arrays (and
// their names) and its fusion.
//
// The tree is the classic halving one: `for (s = size / 2; s > 0; s >>= 1) { if (lid < s) combine(lid,
// lid + s); barrier }`. The combine order is fixed by that loop, so a float sum is bit-identical to the
// hand-written loops it replaced. min / max and the arg variants (ties go to the LOWER index) are
// order-independent and exact.
//
//   const tree = wgslTreeReduce({ size: 64, steps: [sumStep("sc"), sumStep("sf")] });
//   `... sc[li] = cnt; sf[li] = cost; ${tree} if (li == 0u) { out = sc[0]; }`
//
// Subgroup path (`wgslSubgroupReduce`): callers enable it only when `hasFeature(device, "subgroups")`,
// and the module must start with `enable subgroups;`. min / max are exact; `sum` changes the summation
// order and therefore needs `allowReorder: true`, which only a caller that already accepts that drift
// (the opt-in BAND_STATS_SG path) may pass.

/** One combine statement: `lane` is the WGSL expression of the surviving slot, `peer` of its partner. */
export type ReduceStep = (lane: string, peer: string) => string;

/** `arr[lane] += arr[peer]` */
export const sumStep =
	(array: string): ReduceStep =>
	(lane, peer) =>
		`${array}[${lane}] += ${array}[${peer}];`;

/** `arr[lane] = min(arr[lane], arr[peer])` (f32 / u32 / i32 scalars) */
export const minStep =
	(array: string): ReduceStep =>
	(lane, peer) =>
		`${array}[${lane}] = min(${array}[${lane}], ${array}[${peer}]);`;

/** `arr[lane] = max(arr[lane], arr[peer])` */
export const maxStep =
	(array: string): ReduceStep =>
	(lane, peer) =>
		`${array}[${lane}] = max(${array}[${lane}], ${array}[${peer}]);`;

/** Row sum for an `array<array<T, width>, size>` workgroup array (one inner loop of `width` adds). */
export const sumRowStep =
	(array: string, width: number): ReduceStep =>
	(lane, peer) =>
		`for (var k = 0u; k < ${width}u; k++) { ${array}[${lane}][k] += ${array}[${peer}][k]; }`;

export interface ArgStepOptions {
	/** Workgroup array of values. */
	value: string;
	/** Workgroup array of indices (u32). */
	index: string;
	/** "max": larger value wins; "min": smaller wins. Equal values: the smaller index wins. */
	mode: "max" | "min";
	/** An index value meaning "no candidate" (never wins, always loses), e.g. `"NONE"` or `"0xffffffffu"`. */
	none?: string;
}

/** Arg-max / arg-min with the first-index tie-break. */
export function argStep({
	value,
	index,
	mode,
	none,
}: ArgStepOptions): ReduceStep {
	const cmp = mode === "max" ? ">" : "<";
	return (lane, peer) => {
		const pv = `${value}[${peer}]`;
		const pi = `${index}[${peer}]`;
		const lv = `${value}[${lane}]`;
		const li = `${index}[${lane}]`;
		const wins = `${pv} ${cmp} ${lv} || (${pv} == ${lv} && ${pi} < ${li})`;
		const cond = none
			? `${pi} != ${none} && (${li} == ${none} || ${wins})`
			: wins;
		return `if (${cond}) { ${value}[${lane}] = ${pv}; ${index}[${lane}] = ${pi}; }`;
	};
}

export interface KeyMinStepOptions {
	/** Workgroup array of u32 (or f32) keys. */
	key: string;
	/** Arrays copied along when the peer's key is strictly smaller (ties keep the lower lane). */
	payloads: readonly string[];
}

/** Min over `key` carrying payload arrays; a tie keeps the lane's own entry. */
export function keyMinStep({ key, payloads }: KeyMinStepOptions): ReduceStep {
	return (lane, peer) => {
		const copies = [key, ...payloads]
			.map((a) => `${a}[${lane}] = ${a}[${peer}];`)
			.join(" ");
		return `if (${key}[${peer}] < ${key}[${lane}]) { ${copies} }`;
	};
}

export interface TreeReduceOptions {
	/** Workgroup size = slot count (a power of two). */
	size: number;
	/** Combines applied per level, in order. */
	steps: readonly ReduceStep[];
	/** The invocation's lane variable (default "lid"). */
	lane?: string;
	/** The loop stride variable (default "s"). */
	stride?: string;
	/** Emit the `workgroupBarrier()` that publishes the initial stores first (default true). */
	entryBarrier?: boolean;
	/** Line indent prefix (default two spaces). */
	indent?: string;
}

const isPow2 = (n: number) =>
	Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;

/** Inlined statements: [entry barrier], halving-tree loop. The result lands in slot 0 of each array. */
export function wgslTreeReduce({
	size,
	steps,
	lane = "lid",
	stride = "s",
	entryBarrier = true,
	indent = "  ",
}: TreeReduceOptions): string {
	if (!isPow2(size))
		throw new Error(`wgslTreeReduce: size ${size} is not a power of two`);
	const peer = `${lane} + ${stride}`;
	const body = steps.map((step) => `${indent}    ${step(lane, peer)}`);
	return [
		...(entryBarrier ? [`${indent}workgroupBarrier();`] : []),
		`${indent}for (var ${stride} = ${size / 2}u; ${stride} > 0u; ${stride} >>= 1u) {`,
		`${indent}  if (${lane} < ${stride}) {`,
		...body,
		`${indent}  }`,
		`${indent}  workgroupBarrier();`,
		`${indent}}`,
	].join("\n");
}

export interface SubgroupReduceOptions {
	op: "min" | "max" | "sum";
	type: "f32" | "u32" | "i32";
	/** Per-invocation value expression (evaluated in uniform control flow). */
	value: string;
	/** Workgroup array with one slot per subgroup (size / smallest subgroup size entries). */
	shared: string;
	/** Name of the declared result `let`. */
	result: string;
	/** Workgroup size (power of two). */
	size: number;
	/** `local_invocation_index` variable (default "lid"). */
	lane?: string;
	/** `@builtin(subgroup_invocation_id)` variable (default "sid"). */
	subgroupLane?: string;
	/** `@builtin(subgroup_size)` variable (default "ssz"). */
	subgroupSize?: string;
	/** Required for an f32 "sum": subgroup addition changes the summation order. */
	allowReorder?: boolean;
	indent?: string;
}

/**
 * Subgroup reduction block: subgroupMin / subgroupMax / subgroupAdd, lane 0 of each subgroup stores
 * its value in `shared[lane / subgroupSize]`, a barrier, then every invocation folds the
 * `size / subgroupSize` partials serially (same order everywhere) into `let <result>`. Like the
 * BAND_STATS_SG kernel it assumes subgroups are contiguous runs of `local_invocation_index`; a caller
 * that cannot rule that out checks it (see `subgroupLayoutFailed`). The module needs `enable subgroups;`
 * and the entry point the two builtins. min / max are exact; an f32 sum needs `allowReorder`.
 */
export function wgslSubgroupReduce(o: SubgroupReduceOptions): string {
	if (!isPow2(o.size))
		throw new Error(`wgslSubgroupReduce: size ${o.size} is not a power of two`);
	if (o.op === "sum" && o.type === "f32" && !o.allowReorder)
		throw new Error(
			"wgslSubgroupReduce: an f32 sum via subgroups reorders the additions; pass allowReorder",
		);
	const lane = o.lane ?? "lid";
	const sid = o.subgroupLane ?? "sid";
	const ssz = o.subgroupSize ?? "ssz";
	const ind = o.indent ?? "  ";
	const sg = { min: "subgroupMin", max: "subgroupMax", sum: "subgroupAdd" }[
		o.op
	];
	const acc = `${o.result}Acc`;
	const fold =
		o.op === "sum"
			? `${acc} += ${o.shared}[g];`
			: `${acc} = ${o.op}(${acc}, ${o.shared}[g]);`;
	return [
		`${ind}let ${o.result}Sg = ${sg}(${o.value});`,
		`${ind}if (${sid} == 0u) { ${o.shared}[${lane} / ${ssz}] = ${o.result}Sg; }`,
		`${ind}workgroupBarrier();`,
		`${ind}var ${acc}: ${o.type} = ${o.shared}[0];`,
		`${ind}for (var g = 1u; g < ${o.size}u / ${ssz}; g++) { ${fold} }`,
		`${ind}let ${o.result} = ${acc};`,
		`${ind}workgroupBarrier();`,
	].join("\n");
}
