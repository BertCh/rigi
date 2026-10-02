// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Fast-tier ratchet that keeps the GPU code luma-native. It counts raw WebGPU / private-luma /
// raw WebGL escapes in src/lib/** (tests and *.check.ts excluded) per file and rule, compares
// them with scripts/ci/gpu-raw-baseline.json and FAILS only when a count goes UP or a new file
// appears. Decreases are reported as "improved"; lower the baseline with --write.
//   node scripts/ci/gpu-raw-lint.mjs [--write] [--list]

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const baselinePath = join(root, "scripts/ci/gpu-raw-baseline.json");
const SOURCE = /\.(ts|tsx|mts)$/;
const EXCLUDED = /(\.check\.ts|\.spec\.tsx?|\.d\.ts)$|(^|\/)__tests__\//;

/** Each rule is tested per source line (comments stripped); `multi` rules run on the whole text. */
const RULES = {
	rawWebGpu: {
		re: /navigator\.gpu\b|\brequestAdapter\(|\brequestDevice\(/g,
		what: "raw navigator.gpu / requestAdapter / requestDevice (use luma's create/attach)",
	},
	handle: {
		re: /\.handle\.(queue|createBuffer|createTexture|createCommandEncoder|createRenderBundleEncoder)\b|\.handle as GPU|as unknown as \{\s*handle\b|\bhandle:\s*GPU(Device|Buffer|Texture|CommandEncoder)\b|\.mapAsync\(|\.onSubmittedWorkDone\(|\.getCurrentTexture\(/g,
		what: "native handle used as a GPU object (queue, mapAsync, onSubmittedWorkDone, getCurrentTexture)",
	},
	privateMember: {
		re: /as unknown as \{[^}]{0,200}?\b_[A-Za-z]\w*\s*[?:(]|\b(?:device|gpuDevice|webgpuDevice|encoder|commandEncoder|[A-Za-z]*Device)\._[A-Za-z]\w*/g,
		what: "private luma member reached through a cast or `device._x`",
		multi: true,
	},
	rawGl: {
		re: /\bgl2?\.[A-Za-z]/g,
		what: "raw WebGL call `gl.xxx` (counted per file)",
	},
};

/** Known must-stay reasons, used when --write meets a file without a note. */
const WHY = [
	[
		"src/lib/gpu/core/queue.ts",
		"submitWithDefault: private WebGPUDevice finalize + multi-buffer queue.submit and opt-in error scopes; needs a luma submit(buffers[]) patch (audit-gpu A7/A8)",
	],
	[
		"src/lib/gpu/core/readback.ts",
		"raw mapAsync: Buffer.mapAndReadAsync awaits onSubmittedWorkDone first; needs a luma waitForQueue:false option (audit-gpu A9)",
	],
	[
		"src/lib/gpu/core/pool.ts",
		"raw encoder.clearBuffer via handle; luma has no CommandEncoder.clearBuffer (audit-gpu A6)",
	],
	[
		"src/lib/gpu/device.ts",
		"sidecar device: one requestAdapter probe for adapter max limits (audit-gpu A4)",
	],
	["src/lib/gpu/core/selftest.ts", "selftest drives the raw device on purpose"],
	[
		"src/lib/gpu/sky/model.ts",
		"ORT (onnxruntime-web) needs the raw GPUDevice attached; stays",
	],
	[
		"src/lib/sky/model.ts",
		"ORT (onnxruntime-web) needs the raw GPUDevice attached; stays",
	],
	[
		"src/lib/gpu/sky/refine-graph.ts",
		"ORT output buffer wrapped via the public props.handle (audit-gpu A11)",
	],
	[
		"src/lib/gpu/sky/prep.ts",
		"bitmap upload on device.handle; replaceable with Texture.copyExternalImage (audit-gpu A1)",
	],
	[
		"src/lib/deck-webgpu/render-bundle.ts",
		"MSAA render-bundle encoder: luma validation rejects sampleCount>1 (audit-render R4); flag off",
	],
	[
		"src/lib/deck-webgpu/device.ts",
		"createRenderDevice: adapter probe for features and limits before luma create",
	],
	[
		"src/lib/deck-webgpu/imagery.ts",
		"imagery tile staging uses native mapAsync/queue helpers; candidate to move to luma Texture APIs",
	],
	[
		"src/lib/renderer-select.ts",
		"engine probe: navigator.gpu + a probe device, the one place that decides WebGPU vs WebGL2",
	],
	["src/lib/flags/index.ts", "flag text mentions navigator.gpu"],
	[
		"src/lib/deck/composite.ts",
		"WebGL2 fallback: MAX_SAMPLES probe, benchmark gl.finish, renderColorPixels RGBA/FLOAT readPixels, fence waits; MSAA is luma (rigi.5 multisampled textures + resolveTargets)",
	],
	[
		"src/lib/deck/geometry-pass.ts",
		"WebGL2 fallback: PBO pool + blit flip (audit-render R1)",
	],
	[
		"src/lib/deck/silhouette-gl.ts",
		"WebGL2 fallback: raw GLSL programs (audit-render R1)",
	],
	["src/lib/deck/device-lost.ts", "WebGL2 fallback: context-loss handling"],
	["src/lib/deck/engine.ts", "WebGL2 engine host"],
	[
		"src/lib/roll/map/range-gpu.ts",
		"two raw WebGL2 programs of their own (audit-render R1)",
	],
	[
		"src/lib/roll/mosaic/panoGL.ts",
		"stand-alone raw WebGL2 panorama renderer (audit-render R2)",
	],
	[
		"src/lib/nearfield/deck-splat-layer.ts",
		"WebGL2 splat layer on deck's gl context",
	],
	["src/lib/gpu/lab.ts", "dev lab tool (audit-gpu A11)"],
];

function walk(dir, out) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (SOURCE.test(entry.name)) out.push(full);
	}
	return out;
}

/** Blank out comments and string-free line comments while keeping offsets/newlines. */
function stripComments(text) {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(
			/(^|[^:"'`\\])\/\/[^\n]*/g,
			(m, p) => p + " ".repeat(m.length - p.length),
		);
}

export function scanText(text) {
	const code = stripComments(text);
	const counts = {};
	for (const [rule, { re }] of Object.entries(RULES)) {
		const hits = code.match(re);
		if (hits?.length) counts[rule] = hits.length;
	}
	return counts;
}

function scanTree() {
	const files = walk(join(root, "src/lib"), []).sort();
	const result = {};
	for (const file of files) {
		const rel = relative(root, file).split("\\").join("/");
		if (EXCLUDED.test(rel)) continue;
		const counts = scanText(readFileSync(file, "utf8"));
		if (Object.keys(counts).length) result[rel] = counts;
	}
	return result;
}

function main() {
	const args = process.argv.slice(2);
	const current = scanTree();
	const baseline = existsSync(baselinePath)
		? JSON.parse(readFileSync(baselinePath, "utf8"))
		: {};
	if (args.includes("--list")) {
		for (const [file, counts] of Object.entries(current))
			console.log(file, JSON.stringify(counts));
		return 0;
	}
	if (args.includes("--write")) {
		const next = {};
		for (const [file, counts] of Object.entries(current)) {
			const why =
				baseline[file]?.why ?? WHY.find(([p]) => p === file)?.[1] ?? "";
			next[file] = { ...counts, why };
		}
		writeFileSync(baselinePath, `${JSON.stringify(next, null, "\t")}\n`);
		console.log(
			`gpu-raw-lint: wrote ${Object.keys(next).length} files to scripts/ci/gpu-raw-baseline.json`,
		);
		return 0;
	}
	const failures = [];
	const improved = [];
	for (const [file, counts] of Object.entries(current)) {
		for (const [rule, n] of Object.entries(counts)) {
			const allowed = baseline[file]?.[rule] ?? 0;
			if (n > allowed)
				failures.push(
					`${file}: ${rule} ${allowed} -> ${n}  (${RULES[rule].what})`,
				);
		}
	}
	for (const [file, entry] of Object.entries(baseline)) {
		for (const rule of Object.keys(RULES)) {
			const allowed = entry[rule] ?? 0;
			const n = current[file]?.[rule] ?? 0;
			if (n < allowed) improved.push(`${file}: ${rule} ${allowed} -> ${n}`);
		}
	}
	for (const line of improved)
		console.log(`improved, lower the baseline with --write: ${line}`);
	if (failures.length) {
		console.error(
			"gpu-raw-lint FAIL: new raw WebGPU / private-luma / raw WebGL use (go through luma, or justify in gpu-raw-baseline.json with --write):",
		);
		for (const line of failures) console.error(`  ${line}`);
		return 1;
	}
	const total = Object.values(current).reduce(
		(s, c) => s + Object.values(c).reduce((a, b) => a + b, 0),
		0,
	);
	console.log(
		`gpu-raw-lint PASS: ${Object.keys(current).length} allowlisted files, ${total} escapes (ratchet, no increases)`,
	);
	return 0;
}

process.exit(main());
