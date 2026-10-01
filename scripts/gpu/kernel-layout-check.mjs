#!/usr/bin/env node
// Self-check of the hand-written kernel binding layouts (no GPU, no browser): imports every module
// under src/lib/gpu and src/lib/deck-webgpu that calls defineKernel (through tsx), then reflects each registered spec's WGSL
// with luma's getShaderLayoutFromWGSL (@luma.gl/webgpu 10.0.0-alpha.2, a thin wrapper of
// @luma.gl/shadertools/wgsl scanWGSLInterface) and compares every binding's name, group/slot and
// kind with spec.layout (core/kernel.ts: name → kind at `@group(0) @binding(i)`, i in order). Also
// checks that the entry point and each override constant are declared.
//
//   node scripts/gpu/kernel-layout-check.mjs [-v]
//
// Exit 1 listing the mismatches (or modules that failed to import); 0 when every spec agrees.
// Kernels defined inside functions (e.g. sky/bench-graph.ts) are only registered when called, so they
// are reported as unchecked, not as failures.
import fs from "node:fs";
import { register as registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getShaderLayoutFromWGSL } from "@luma.gl/webgpu";
import { register } from "tsx/esm/api";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SRC = path.join(ROOT, "src/lib");
// kernel modules live under src/lib/gpu and, for the render-device kernels, src/lib/deck-webgpu
const DIRS = ["gpu", "deck-webgpu"].map((d) => path.join(SRC, d));
const VERBOSE = process.argv.includes("-v");
// the definitions themselves, not kernels
const SKIP = new Set(["gpu/core/kernel.ts", "gpu/look/kernel.ts"]);
const CALL = /\bdefineKernel\s*\(/g;

// Vite-only specifiers (`x?url`, `x?raw`, `x?worker`): an empty-string default export is enough here
const stub = `
export async function resolve(spec, ctx, next) {
	if (/\\?(url|raw|worker|inline)$/.test(spec)) return { url: "stub:" + spec, shortCircuit: true };
	return next(spec, ctx);
}
export async function load(url, ctx, next) {
	if (url.startsWith("stub:")) return { format: "module", source: "export default '';", shortCircuit: true };
	return next(url, ctx);
}`;
register({ tsconfig: path.join(ROOT, "tsconfig.json") });
// registered last, so it resolves before tsx does
registerHooks(`data:text/javascript,${encodeURIComponent(stub)}`);
const core = await import(
	pathToFileURL(path.join(SRC, "gpu/core/kernel.ts")).href
);

function walk(dir) {
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p));
		else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
	}
	return out.sort();
}

// strip comments so a defineKernel mentioned in prose is not counted
const calls = (text) =>
	(
		text
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "")
			.match(CALL) ?? []
	).length;

const problems = [];
const notes = [];
const files = DIRS.flatMap(walk)
	.map((file) => ({ file, rel: path.relative(SRC, file) }))
	.filter(
		({ file, rel }) => !SKIP.has(rel) && calls(fs.readFileSync(file, "utf8")),
	);
// pass 1 loads every kernel module and its dependencies; pass 2 re-evaluates each module alone
// (a fresh instance via a query), so what it registers is exactly its own module-level kernels,
// whichever file imported it first
const loaded = [];
for (const f of files)
	try {
		await import(pathToFileURL(f.file).href);
		loaded.push(f);
	} catch (e) {
		problems.push(`${f.rel}: import failed: ${e?.message ?? e}`);
	}
const specs = [];
const owner = new Map();
for (const { file, rel } of loaded) {
	const before = core.definedKernels().length;
	await import(`${pathToFileURL(file).href}?layout-check`);
	const added = core.definedKernels().slice(before);
	for (const s of added) {
		specs.push(s);
		owner.set(s, rel);
	}
	if (!added.length)
		notes.push(
			`${rel}: no module-level kernels (defineKernel inside a function?): unchecked`,
		);
}

/** Problems of one spec, as strings. */
function check(spec) {
	const out = [];
	const r = getShaderLayoutFromWGSL(spec.source);
	if (!r) return ["WGSL reflection failed (ambiguous or unsupported syntax)"];
	const byLoc = new Map();
	for (const b of r.bindings) {
		if (b.group !== 0) {
			out.push(`binding "${b.name}" is in @group(${b.group}), expected 0`);
			continue;
		}
		if (byLoc.has(b.location))
			out.push(
				`@binding(${b.location}) declared twice ("${byLoc.get(b.location).name}", "${b.name}")`,
			);
		else byLoc.set(b.location, b);
	}
	spec.layout.forEach(([name, kind], i) => {
		const b = byLoc.get(i);
		if (!b) {
			out.push(
				`slot ${i} "${name}" (${kind}): no @group(0) @binding(${i}) in WGSL`,
			);
			return;
		}
		if (b.name !== name)
			out.push(`slot ${i}: layout name "${name}", WGSL "${b.name}"`);
		if (b.type !== kind)
			out.push(`slot ${i} "${name}": layout kind ${kind}, WGSL ${b.type}`);
	});
	for (const [loc, b] of byLoc)
		if (loc >= spec.layout.length)
			out.push(
				`WGSL @binding(${loc}) "${b.name}" (${b.type}) is not in the layout (${spec.layout.length} slots)`,
			);
	const src = spec.source.replace(/\/\/.*$/gm, "");
	if (!new RegExp(`@compute[^;{]*\\bfn\\s+${spec.entryPoint}\\s*\\(`).test(src))
		out.push(`entry point "${spec.entryPoint}" is not a @compute fn`);
	for (const c of Object.keys(spec.constants ?? {}))
		if (!new RegExp(`\\boverride\\s+${c}\\b`).test(src))
			out.push(`constant "${c}" has no \`override ${c}\``);
	return out;
}

let bad = 0;
for (const spec of specs) {
	const p = check(spec);
	const where = `${owner.get(spec) ?? "?"} ${spec.label} [${spec.group}]`;
	if (p.length) {
		bad++;
		for (const x of p) problems.push(`${where}: ${x}`);
	} else if (VERBOSE)
		console.log(`ok   ${where} (${spec.layout.length} bindings)`);
}
for (const n of notes) console.log(`note ${n}`);
for (const p of problems) console.log(`FAIL ${p}`);
console.log(
	`${problems.length ? "FAIL" : "PASS"}: ${specs.length - bad}/${specs.length} kernel layouts match their WGSL`,
);
process.exit(problems.length ? 1 : 0);
