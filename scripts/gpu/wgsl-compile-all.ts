// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL full-permutation compile gate. Assembles every WGSL program variant the app can produce and
// builds it on a native WebGPU implementation in node (Dawn, via the `webgpu` npm package) through
// luma.gl, exactly as the layers do: the same Model props, the same RIGI_WGSL_ASSEMBLER (modules,
// defines, `@binding(auto)` resolution), the same colour / geometry / screen target formats. A
// variant fails on a thrown error, a WebGPU validation error (shader module OR pipeline creation:
// an unresolved name like `ter_pal` or a bad `@binding(auto)` layout only shows at pipeline
// creation), or an error message in the shader's compilation info.
//
// Enumerated (never a full cartesian product):
//   terrain        every preset (src/lib/style/presets.ts) through the style pipeline (presetStyle ->
//                  lookKey / terrainDefines / deckTerrainStyle / terroirShader -> styleFeatures), for
//                  each of the six terrain styles and the three view modes (overlay / replace / world);
//                  plus the one-hot of every LOOK_* and TERROIR_* switch, plus a pairwise covering
//                  array over all of them, each on every style; plus the plugin chains (drape,
//                  drape + harmonize, atmosphere fog, finish) on representative programs. Per-tile and
//                  batched terrain, colour and geometry passes.
//   composite      every subset of {INK, REFINE, HARMONIZE, OUTPUT} through compositeDefines
//   layers         trail, flow, glow, gizmo (plane / edges / pin), splats, tiles3d (mesh / instanced /
//                  debug), multi-drape, world sky, photo sky, present (4 modes' shared program),
//                  imagery mip chain
//   kernels        every defineKernel spec found in src/lib/gpu and src/lib/deck-webgpu (compute)
// Not covered: programs built inside functions that no module exports (the raw createComputePipeline
// callers named in kernel-layout-check.mjs), and the draw-time uniform / binding values.
//
// `webgpu` is deliberately not a dependency of the app; install it anywhere and point DAWN_DIR at it:
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # 0.3.x loads on macOS 14; newer wants 26
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/wgsl-compile-all.ts [--filter text] [--verbose] [--list]
// Without DAWN_DIR it prints SKIP and exits 0. Exit 1 on any failing variant, 2 on no adapter.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");
const LIST = argv.includes("--list");
const filterAt = argv.indexOf("--filter");
const FILTER = filterAt >= 0 ? argv[filterAt + 1] : "";
const ROOT = path.resolve(import.meta.dirname, "../..");

const dawnDir = process.env.DAWN_DIR;
if (!dawnDir) {
	console.log(
		"SKIP wgsl-compile: DAWN_DIR is not set (npm i webgpu@0.3.0 somewhere and point DAWN_DIR at it)",
	);
	process.exit(0);
}
const { create, globals } = await import(
	pathToFileURL(path.join(dawnDir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
const gpu = create([]);
if (!(await gpu.requestAdapter())) {
	console.error("no WebGPU adapter");
	process.exit(2);
}
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});

// ---- imports (after navigator exists: some modules read it at load) ----------------------------------
const { luma } = await import("@luma.gl/core");
const { Model } = await import("@luma.gl/engine");
const { webgpuAdapter } = await import("@luma.gl/webgpu");
type Device = import("@luma.gl/core").Device;
type ModelType = InstanceType<typeof Model>;
type TerrainShaderPart =
	import("../../src/lib/deck-webgpu/terrain").TerrainShaderPart;
type TerrainStyleName =
	import("../../src/lib/deck-webgpu/layers/terrain-styles").TerrainStyleName;
type LookDefine = import("../../src/lib/look/look-key").LookDefine;
type TerroirShader = import("../../src/lib/terroir/glsl/values").TerroirShader;

const { screenModelProps, passModelProps } = await import(
	"../../src/lib/deck-webgpu/pass"
);
const { TerrainCore } = await import("../../src/lib/deck-webgpu/terrain");
const { BatchedTerrainCore } = await import(
	"../../src/lib/deck-webgpu/layers/batched-terrain"
);
const { TerrainStyles } = await import(
	"../../src/lib/deck-webgpu/layers/terrain-styles"
);
const { DrapePart } = await import("../../src/lib/deck-webgpu/layers/drape");
const { atmosphereFogPart } = await import(
	"../../src/lib/deck-webgpu/layers/atm-sky"
);
const { presetStyle, PRESET_IDS } = await import("../../src/lib/style/presets");
const { deckTerrainStyle } = await import("../../src/lib/style/deck-apply");
const { lookKey, terrainDefines } = await import("../../src/lib/look/look-key");
const { terroirShader } = await import("../../src/lib/terroir/glsl/values");
const { terroirNeedsCover } = await import(
	"../../src/lib/terroir/wgsl/terrain"
);

// ---- device ----------------------------------------------------------------------------------------------
const device = (await luma.createDevice({
	type: "webgpu",
	adapters: [webgpuAdapter],
	createCanvasContext: false,
	// ?colorTarget=rg11b10 variants (enumerateColorTargetRg11b10)
	optionalFeatures: ["rg11b10ufloat-renderable"],
} as never)) as Device;
const raw = (device as unknown as { handle: GPUDevice }).handle;

// ---- the compile harness ---------------------------------------------------------------------------------

type Result = {
	group: string;
	id: string;
	ok: boolean;
	ms: number;
	error?: string;
};
const results: Result[] = [];
const seen = new Set<string>();
const skipped: string[] = [];

type Built = { destroy?: () => void };

/** Messages luma logs through console.* while a variant builds (its own reportError path). */
const logged: string[] = [];
const realError = console.error;
const realWarn = console.warn;
const realLog = console.log;
function captureConsole() {
	logged.length = 0;
	const grab =
		(real: typeof console.error) =>
		(...a: unknown[]) => {
			logged.push(a.map(String).join(" "));
			if (VERBOSE) real(...a);
		};
	console.error = grab(realError);
	console.warn = grab(realWarn);
	console.log = ((...a: unknown[]) => {
		logged.push(a.map(String).join(" "));
		if (VERBOSE) realLog(...a);
	}) as typeof console.log;
}
function restoreConsole() {
	console.error = realError;
	console.warn = realWarn;
	console.log = realLog;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Build one variant inside validation + internal error scopes; `make` returns what it created (a
 * Model, or anything with `pipeline.vs / fs`) so its shaders' compilation info can be read too.
 */
async function compileVariant(
	group: string,
	id: string,
	make: () => Built | Built[] | Promise<Built | Built[]>,
	/** where the variant was first enumerated (shown with a failure) */
	origin = "",
) {
	if (FILTER && !`${group}/${id}`.includes(FILTER)) return;
	const key = `${group}/${id}`;
	if (seen.has(key)) return; // dedupe equal programs enumerated twice
	seen.add(key);
	if (LIST) {
		console.log(key);
		return;
	}
	const t0 = performance.now();
	const problems: string[] = [];
	captureConsole();
	raw.pushErrorScope("validation");
	raw.pushErrorScope("internal");
	let built: Built[] = [];
	try {
		const r = await make();
		built = Array.isArray(r) ? r : [r];
		// shader compilation messages (module-level errors with line numbers)
		for (const b of built) {
			const pipeline = (b as { pipeline?: Record<string, unknown> }).pipeline;
			for (const sh of [pipeline?.vs, pipeline?.fs] as ({
				getCompilationInfo?: () => Promise<
					{ type: string; message: string; lineNum?: number }[]
				>;
			} | null)[]) {
				if (!sh?.getCompilationInfo) continue;
				for (const m of await sh.getCompilationInfo())
					if (m.type === "error")
						problems.push(`line ${m.lineNum ?? "?"}: ${oneLine(m.message)}`);
			}
			const status = (pipeline as { linkStatus?: string } | undefined)
				?.linkStatus;
			if (status === "error") problems.push("pipeline linkStatus=error");
		}
	} catch (e) {
		problems.push(`threw: ${oneLine(String((e as Error)?.message ?? e))}`);
	}
	const internal = await raw.popErrorScope();
	const validation = await raw.popErrorScope();
	restoreConsole();
	for (const e of [validation, internal])
		if (e) problems.push(oneLine((e as { message: string }).message));
	if (!problems.length)
		for (const l of logged)
			if (/error|failed/i.test(l)) {
				problems.push(`logged: ${oneLine(l)}`);
				break;
			}
	for (const b of built) {
		try {
			b.destroy?.();
		} catch {
			/* destroying a failed model */
		}
	}
	const ok = problems.length === 0;
	results.push({
		group,
		id,
		ok,
		ms: performance.now() - t0,
		error: ok
			? undefined
			: `${[...new Set(problems)].slice(0, 3).join(" | ")}${origin ? ` (from ${origin})` : ""}`,
	});
}

// ---- targets -----------------------------------------------------------------------------------------------

const SCREEN_TARGETS = [
	{
		id: "bgra",
		target: {
			width: 64,
			height: 64,
			colorFormats: [device.preferredColorFormat],
			depthFormat: null,
			samples: 1,
		},
	},
	{
		id: "bgra+depth",
		target: {
			width: 64,
			height: 64,
			colorFormats: [device.preferredColorFormat],
			depthFormat: "depth24plus",
			samples: 1,
		},
	},
];

// ---- terrain enumeration -----------------------------------------------------------------------------------

const STYLES: TerrainStyleName[] = [
	"hillshade",
	"imagery",
	"contours",
	"elevation",
	"slope",
	"slopeClass",
];
const LOOK_SWITCHES = [
	"LOOK_ALPINE",
	"LOOK_RELIEF",
	"LOOK_TANAKA",
	"LOOK_ATMOSPHERE",
	"LOOK_WATER",
	"LOOK_WATER_WAVES",
] as const satisfies readonly LookDefine[];
const TERROIR_SWITCHES = [
	"TERROIR_COVER",
	"TERROIR_PATTERN",
	"TERROIR_HATCH",
	"TERROIR_SNOW",
	"TERROIR_CONTOUR_INK",
	"TERROIR_CONTOUR_ADAPTIVE",
] as const;
const ALL_SWITCHES: readonly string[] = [...LOOK_SWITCHES, ...TERROIR_SWITCHES];

/** A terroir shader as terroirShader() would return it, with a fake cover pack grid. */
function fakeTerroir(defines: string[]): TerroirShader | null {
	if (!defines.length) return null;
	const needsGrid = defines.some(
		(d) => d !== "TERROIR_CONTOUR_ADAPTIVE" && d !== "TERROIR_HATCH",
	);
	return {
		defines: [...defines].sort(),
		swissIndex: false,
		grid: needsGrid
			? ({ bbox: [7, 46, 8, 47], width: 8, height: 8 } as never)
			: null,
		fit: null,
		snowline: defines.includes("TERROIR_SNOW") ? 2800 : null,
	} as TerroirShader;
}

type TerrainLookArg = Parameters<typeof TerrainStyles.prototype.set>[0];

const classicLook = deckTerrainStyle(presetStyle("classic"), "world");

/** TerrainStyles for (style, defines, terroir); rel / atm are truthy so the features are not gated. */
function stylesFor(
	style: TerrainStyleName,
	defines: string[],
	terroir: TerroirShader | null,
	look: typeof classicLook = classicLook,
) {
	return new TerrainStyles(device, {
		style,
		look: {
			...look,
			defines: defines.filter((d) => d.startsWith("LOOK_")) as LookDefine[],
			rel: look.rel ?? ({} as never),
			atm: look.atm ?? ({} as never),
		},
		terroir,
	} as TerrainLookArg);
}

type Plugin = { id: string; parts: () => TerrainShaderPart[] };
const NO_PLUGINS: Plugin = { id: "", parts: () => [] };

function terrainModels(
	styles: InstanceType<typeof TerrainStyles>,
	plugins: Plugin,
) {
	const parts = plugins.parts();
	const out: Built[] = [];
	const tile = new TerrainCore(device, null);
	styles.applyTo(tile, parts);
	out.push((tile as never as { model(k: string): ModelType }).model("color"));
	const batched = new BatchedTerrainCore(device, null);
	styles.applyTo(batched, parts);
	out.push(
		(batched as never as { model(k: string): ModelType }).model("color"),
	);
	return out;
}

const programKey = (styles: InstanceType<typeof TerrainStyles>) =>
	styles.key.replace("terrain-styles|", "");

/** Compile one shading program (tile + batched colour pass) plus an optional plugin chain. */
async function compileTerrain(
	label: string,
	styles: InstanceType<typeof TerrainStyles>,
	plugins: Plugin = NO_PLUGINS,
) {
	const key = `${programKey(styles)}${plugins.id ? `+${plugins.id}` : ""}`;
	await compileVariant(
		"terrain",
		key,
		() => terrainModels(styles, plugins),
		label,
	);
}

/** Greedy pairwise covering array over `n` binary switches (deterministic). */
function pairwiseRows(n: number): boolean[][] {
	const need = new Set<string>();
	for (let i = 0; i < n; i++)
		for (let j = i + 1; j < n; j++)
			for (const a of [0, 1])
				for (const b of [0, 1]) need.add(`${i},${j},${a},${b}`);
	let seed = 12345;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const rows: boolean[][] = [];
	const covered = (row: boolean[]) => {
		let c = 0;
		for (let i = 0; i < n; i++)
			for (let j = i + 1; j < n; j++)
				if (need.has(`${i},${j},${+row[i]},${+row[j]}`)) c++;
		return c;
	};
	while (need.size) {
		let best: boolean[] = [];
		let bestC = -1;
		for (let t = 0; t < 300; t++) {
			const row = Array.from({ length: n }, () => rnd() < 0.5);
			const c = covered(row);
			if (c > bestC) {
				bestC = c;
				best = row;
			}
		}
		rows.push(best);
		for (let i = 0; i < n; i++)
			for (let j = i + 1; j < n; j++)
				need.delete(`${i},${j},${+best[i]},${+best[j]}`);
	}
	return rows;
}

async function enumerateTerrain() {
	const identity = (id: string) => id;
	// 1. presets through the real style pipeline, per style and view mode
	for (const preset of PRESET_IDS) {
		const s = presetStyle(preset);
		const grid = {
			bbox: [7, 46, 8, 47],
			width: 8,
			height: 8,
			cells: new Uint8Array(64),
		} as never;
		const frame = { fromGeo: () => [0, 0, 0] };
		for (const mode of ["overlay", "replace", "world"] as const) {
			let look: typeof classicLook;
			try {
				look = deckTerrainStyle(s, mode);
			} catch (e) {
				results.push({
					group: "terrain",
					id: `preset ${preset} ${mode}`,
					ok: false,
					ms: 0,
					error: `deckTerrainStyle threw: ${(e as Error).message}`,
				});
				continue;
			}
			const lookWithDefines = {
				...look,
				defines: terrainDefines(s, lookKey(s)),
			};
			for (const withPack of [true, false]) {
				let terroir: TerroirShader | null = null;
				try {
					terroir = terroirShader(
						s,
						withPack ? grid : null,
						withPack ? frame : null,
						"2024-07-01",
					);
				} catch {
					terroir = null;
				}
				for (const style of STYLES)
					await compileTerrain(
						`preset ${preset} ${mode}${withPack ? "" : " no-pack"}`,
						stylesFor(style, lookWithDefines.defines, terroir, lookWithDefines),
					);
			}
		}
	}
	// 2. one-hot of every switch, on every style
	for (const sw of ALL_SWITCHES) {
		const defines = [sw];
		// a dependent switch alone is a no-op; the interesting form carries its prerequisite too
		if (sw === "LOOK_WATER" || sw === "LOOK_WATER_WAVES")
			defines.unshift("LOOK_ALPINE");
		if (sw === "LOOK_WATER_WAVES") defines.push("LOOK_WATER");
		if (sw === "TERROIR_PATTERN") defines.push("TERROIR_COVER");
		for (const style of STYLES)
			await compileTerrain(
				`one-hot ${sw}`,
				stylesFor(
					style,
					defines,
					fakeTerroir(defines.filter((d) => d.startsWith("TERROIR_"))),
				),
			);
	}
	// 3. pairwise covering array over all switches, on every style
	const rows = pairwiseRows(ALL_SWITCHES.length);
	rows.forEach((row, r) => {
		const on = ALL_SWITCHES.filter((_, i) => row[i]);
		for (const style of STYLES)
			pending.push(() =>
				compileTerrain(
					`pairwise #${r}`,
					stylesFor(
						style,
						on,
						fakeTerroir(on.filter((d) => d.startsWith("TERROIR_"))),
					),
				),
			);
	});
	// 4. plugin chains on representative programs
	const drapePlain = new DrapePart(device);
	const drapeHarmonize = new DrapePart(device);
	drapeHarmonize.setSettings({ harmonize: true } as never);
	const plugins: Plugin[] = [
		{ id: "drape", parts: () => [drapePlain.part()] },
		{ id: "drape+hrm", parts: () => [drapeHarmonize.part()] },
		{ id: "atmfog", parts: () => [atmosphereFogPart(() => null)] },
		{
			id: "drape+hrm+atmfog",
			parts: () => [drapeHarmonize.part(), atmosphereFogPart(() => null)],
		},
	];
	const representative: [string, string[], TerrainStyleName][] = [
		["classic", [], "hillshade"],
		["classic", [], "imagery"],
		[
			"alpine+relief+water",
			["LOOK_ALPINE", "LOOK_RELIEF", "LOOK_WATER", "LOOK_WATER_WAVES"],
			"hillshade",
		],
		["atmosphere", ["LOOK_ATMOSPHERE"], "imagery"],
		[
			"terroir full",
			[
				"LOOK_ALPINE",
				"TERROIR_COVER",
				"TERROIR_PATTERN",
				"TERROIR_HATCH",
				"TERROIR_SNOW",
			],
			"hillshade",
		],
	];
	for (const [label, defines, style] of representative)
		for (const p of plugins)
			pending.push(() =>
				compileTerrain(
					`plugin ${label}`,
					stylesFor(
						style,
						defines,
						fakeTerroir(defines.filter((d) => d.startsWith("TERROIR_"))),
					),
					p,
				),
			);
	// 5. geometry pass of both cores (style independent)
	await compileVariant("terrain", "geometry pass (tile)", () => [
		(
			new TerrainCore(device, null) as never as { model(k: string): ModelType }
		).model("geometry"),
	]);
	await compileVariant("terrain", "geometry pass (batched)", () => [
		(
			new BatchedTerrainCore(device, null) as never as {
				model(k: string): ModelType;
			}
		).model("geometry"),
	]);
	void identity;
	void terroirNeedsCover;
}

/** Variants queued by the enumerators (run after the cheap ones, so a failure list reads in order). */
const pending: (() => Promise<void>)[] = [];

// ---- composite -----------------------------------------------------------------------------------------------

async function enumerateComposite() {
	const {
		COMPOSITE_WGSL,
		compositeDefines,
		compositeModule,
		lookCompositeModule,
		bandStatsModule,
	} = await import("../../src/lib/deck-webgpu/layers/composite");
	const { ridgesModule } = await import(
		"../../src/lib/deck-webgpu/layers/ridges"
	);
	const names = [
		"LOOK_HARMONIZE",
		"LOOK_INK",
		"LOOK_OUTPUT",
		"LOOK_REFINE",
	] as const;
	for (let mask = 0; mask < 1 << names.length; mask++) {
		const on = names.filter((_, i) => mask & (1 << i)) as LookDefine[];
		const defines = compositeDefines(on);
		const blend = !!defines.LOOK_BLEND;
		for (const t of SCREEN_TARGETS)
			await compileVariant(
				"composite",
				`${on.join("+") || "classic"} [${t.id}]`,
				() => {
					const p = screenModelProps(t.target);
					return new Model(device, {
						id: "composite-compile",
						source: COMPOSITE_WGSL,
						vertexEntryPoint: "fullscreenVertex",
						fragmentEntryPoint: "fragmentMain",
						modules: [
							compositeModule,
							ridgesModule,
							...(blend ? [lookCompositeModule, bandStatsModule] : []),
						] as never,
						defines,
						vertexCount: 3,
						...p,
					} as never);
				},
			);
	}
}

// ---- the other layers -------------------------------------------------------------------------------------------

async function enumerateLayers() {
	const colorTarget = {
		width: 64,
		height: 64,
		colorFormats: ["rgba16float"],
		depthFormat: "depth24plus",
		samples: 4,
	};
	const fakeCtx = { kind: "color", target: colorTarget } as never;

	const { TrailCore } = await import("../../src/lib/deck-webgpu/layers/trail");
	await compileVariant("layers", "trail", () => [
		(new TrailCore(device) as never as { model(): ModelType }).model(),
	]);
	const { FlowCore } = await import("../../src/lib/deck-webgpu/layers/flow");
	await compileVariant("layers", "flow draw", () => [
		(new FlowCore(device) as never as { model(): ModelType }).model(),
	]);
	const { GizmoCore } = await import("../../src/lib/deck-webgpu/layers/gizmo");
	for (const part of ["plane", "edges", "pin"])
		await compileVariant("layers", `gizmo ${part}`, () => [
			(
				new GizmoCore("g", device) as never as {
					model(d: Device, p: string): ModelType;
				}
			).model(device, part),
		]);
	const { SplatsCore } = await import(
		"../../src/lib/deck-webgpu/layers/splats"
	);
	for (const kind of ["geometry", "color"])
		await compileVariant("layers", `splats ${kind}`, () => [
			(
				new SplatsCore(device) as never as { model(k: string): ModelType }
			).model(kind),
		]);
	const { Tiles3DCore } = await import(
		"../../src/lib/deck-webgpu/layers/tiles3d"
	);
	for (const kind of ["geometry", "color"])
		for (const instanced of [false, true])
			await compileVariant(
				"layers",
				`tiles3d ${kind} ${instanced ? "instanced" : "mesh"}`,
				() => [
					(
						new Tiles3DCore(device) as never as {
							model(k: string, i: boolean): ModelType;
						}
					).model(kind, instanced),
				],
			);
	const { MultiDrapeCore } = await import(
		"../../src/lib/deck-webgpu/layers/multi-drape"
	);
	await compileVariant("layers", "multi-drape", () => [
		(
			new MultiDrapeCore(device) as never as { model(c: unknown): ModelType }
		).model(fakeCtx),
	]);

	const { SKY_WGSL, skyModule, atmosphereModule, skyParameters } = await import(
		"../../src/lib/deck-webgpu/layers/atm-sky"
	);
	const { cameraModule, photoCameraModule } = await import(
		"../../src/lib/deck-webgpu/camera"
	);
	await compileVariant("layers", "world sky", () => [
		new Model(device, {
			id: "world-sky-compile",
			source: SKY_WGSL,
			vertexEntryPoint: "fullscreenVertex",
			fragmentEntryPoint: "fragmentMain",
			modules: [cameraModule, atmosphereModule, skyModule] as never,
			...passModelProps("color", { depth: "test" }),
			parameters: skyParameters(),
			topology: "triangle-list",
			vertexCount: 3,
		} as never),
	]);
	const { PHOTO_SKY_WGSL, pskyModule } = await import(
		"../../src/lib/deck-webgpu/layers/photo-sky"
	);
	await compileVariant("layers", "photo sky", () => [
		new Model(device, {
			id: "photo-sky-compile",
			source: PHOTO_SKY_WGSL,
			vertexEntryPoint: "fullscreenVertex",
			fragmentEntryPoint: "fragmentMain",
			modules: [cameraModule, photoCameraModule, pskyModule] as never,
			topology: "triangle-list",
			vertexCount: 3,
			bufferLayout: [],
			...passModelProps("color", { depth: "test", blend: true }),
		} as never),
	]);
	const { PRESENT_WGSL, presentModule } = await import(
		"../../src/lib/deck-webgpu/present"
	);
	for (const t of SCREEN_TARGETS)
		await compileVariant("layers", `present [${t.id}]`, () => [
			new Model(device, {
				id: "present-compile",
				source: PRESENT_WGSL,
				vertexEntryPoint: "fullscreenVertex",
				fragmentEntryPoint: "fragmentMain",
				modules: [presentModule] as never,
				vertexCount: 3,
				...screenModelProps(t.target),
			} as never),
		]);
	const { GLOW_WGSL, GLOW_BLEND, glowSpriteModule } = await import(
		"../../src/lib/deck-webgpu/layers/glow"
	);
	const { pointGlow } = await import("@luma.gl/shadertools");
	const { GLOW_STRIDE } = await import("../../src/lib/look/labels/glow");
	for (const t of SCREEN_TARGETS)
		await compileVariant("layers", `glow [${t.id}]`, () => {
			const p = screenModelProps(t.target);
			return [
				new Model(device, {
					id: "glow-compile",
					source: GLOW_WGSL,
					vertexEntryPoint: "vertexMain",
					fragmentEntryPoint: "fragmentMain",
					modules: [pointGlow, glowSpriteModule] as never,
					topology: "triangle-list",
					bufferLayout: [
						{
							name: "instances",
							byteStride: GLOW_STRIDE * 4,
							stepMode: "instance",
							attributes: [
								{ attribute: "uv", format: "float32x2", byteOffset: 0 },
							],
						},
					],
					isInstanced: true,
					vertexCount: 6,
					instanceCount: 0,
					...p,
					parameters: { ...p.parameters, ...GLOW_BLEND } as never,
				} as never),
			];
		});
	const { MIP_WGSL } = await import("../../src/lib/deck-webgpu/imagery");
	await compileVariant("layers", "imagery mips", () => [
		new Model(device, {
			id: "imagery-mips-compile",
			source: MIP_WGSL,
			vs: null,
			fs: null,
			vertexEntryPoint: "fullscreenVertex",
			fragmentEntryPoint: "fragmentMain",
			vertexCount: 3,
			colorAttachmentFormats: ["rgba8unorm-srgb"],
			parameters: {},
		} as never),
	]);
}

// ---- compute kernels ---------------------------------------------------------------------------------------------

async function enumerateKernels() {
	const kernelFiles: string[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (
				/\.ts$/.test(e.name) &&
				!/\.(check|test)\.ts$|^bench/.test(e.name) &&
				fs.readFileSync(p, "utf8").includes("defineKernel(")
			)
				kernelFiles.push(p);
		}
	};
	walk(path.join(ROOT, "src/lib/gpu"));
	walk(path.join(ROOT, "src/lib/deck-webgpu"));
	const importFailures: string[] = [];
	for (const f of kernelFiles.sort()) {
		try {
			await import(pathToFileURL(f).href);
		} catch (e) {
			importFailures.push(`${path.relative(ROOT, f)}: ${(e as Error).message}`);
		}
	}
	const { definedKernels, kernel } = await import(
		"../../src/lib/gpu/core/kernel"
	);
	const hasSubgroups = (
		device as unknown as { features: Set<string> }
	).features.has("subgroups");
	for (const spec of definedKernels()) {
		// selftest-bad-* are the compile-error fixtures of gpu/core/selftest.ts; the subgroup kernels need
		// a device created with the feature (the app falls back to the non-subgroup twin without it)
		if (spec.id.startsWith("selftest-bad")) continue;
		if (spec.source.includes("enable subgroups") && !hasSubgroups) {
			skipped.push(`kernels/${spec.id} (device lacks subgroups)`);
			continue;
		}
		await compileVariant("kernels", spec.id, () => {
			const k = kernel(device, spec);
			return [{ pipeline: undefined, destroy: () => k.pipeline.destroy?.() }];
		});
	}
	for (const m of importFailures)
		results.push({
			group: "kernels",
			id: `import ${m.split(":")[0]}`,
			ok: false,
			ms: 0,
			error: `module did not import in node: ${m.split(": ").slice(1).join(": ")}`,
		});
}

// ---- ?colorTarget=rg11b10 --------------------------------------------------------------------------------------
// The colour-pass programs whose pipeline declares the MSAA colour format (passModelProps("color")), rebuilt
// with the opt-in rg11b10ufloat format (targets.ts applyColorTargetFormat), then the default restored.

async function enumerateColorTargetRg11b10() {
	if (!device.features.has("rg11b10ufloat-renderable" as never)) {
		skipped.push("colortarget: device lacks rg11b10ufloat-renderable");
		return;
	}
	const { applyColorTargetFormat, getColorTargetFormat } = await import(
		"../../src/lib/deck-webgpu/targets"
	);
	if (applyColorTargetFormat(device, "rg11b10-unsafe") !== "rg11b10ufloat")
		throw new Error("applyColorTargetFormat did not select rg11b10ufloat");
	try {
		const fakeCtx = {
			kind: "color",
			target: {
				width: 64,
				height: 64,
				colorFormats: [getColorTargetFormat()],
				depthFormat: "depth24plus",
				samples: 4,
			},
		} as never;
		const g = "colortarget";
		const { TrailCore } = await import(
			"../../src/lib/deck-webgpu/layers/trail"
		);
		await compileVariant(g, "rg11b10 trail", () => [
			(new TrailCore(device) as never as { model(): ModelType }).model(),
		]);
		const { FlowCore } = await import("../../src/lib/deck-webgpu/layers/flow");
		await compileVariant(g, "rg11b10 flow draw", () => [
			(new FlowCore(device) as never as { model(): ModelType }).model(),
		]);
		const { GizmoCore } = await import(
			"../../src/lib/deck-webgpu/layers/gizmo"
		);
		for (const part of ["plane", "edges", "pin"])
			await compileVariant(g, `rg11b10 gizmo ${part}`, () => [
				(
					new GizmoCore("g", device) as never as {
						model(d: Device, p: string): ModelType;
					}
				).model(device, part),
			]);
		const { SplatsCore } = await import(
			"../../src/lib/deck-webgpu/layers/splats"
		);
		await compileVariant(g, "rg11b10 splats color", () => [
			(
				new SplatsCore(device) as never as { model(k: string): ModelType }
			).model("color"),
		]);
		const { MultiDrapeCore } = await import(
			"../../src/lib/deck-webgpu/layers/multi-drape"
		);
		await compileVariant(g, "rg11b10 multi-drape", () => [
			(
				new MultiDrapeCore(device) as never as { model(c: unknown): ModelType }
			).model(fakeCtx),
		]);
		const { SKY_WGSL, skyModule, atmosphereModule, skyParameters } =
			await import("../../src/lib/deck-webgpu/layers/atm-sky");
		const { cameraModule } = await import("../../src/lib/deck-webgpu/camera");
		await compileVariant(g, "rg11b10 world sky", () => [
			new Model(device, {
				id: "world-sky-compile-rg11b10",
				source: SKY_WGSL,
				vertexEntryPoint: "fullscreenVertex",
				fragmentEntryPoint: "fragmentMain",
				modules: [cameraModule, atmosphereModule, skyModule] as never,
				...passModelProps("color", { depth: "test" }),
				parameters: skyParameters(),
				topology: "triangle-list",
				vertexCount: 3,
			} as never),
		]);
	} finally {
		applyColorTargetFormat(device, "rgba16");
	}
}

// ---- run ---------------------------------------------------------------------------------------------------------

await enumerateTerrain();
for (const run of pending) await run();
await enumerateComposite();
await enumerateLayers();
await enumerateColorTargetRg11b10();
await enumerateKernels();

if (LIST) process.exit(0);

const groups = [...new Set(results.map((r) => r.group))];
console.log("group        variants   failed   ms");
for (const g of groups) {
	const rs = results.filter((r) => r.group === g);
	const ms = rs.reduce((a, r) => a + r.ms, 0);
	console.log(
		`${g.padEnd(12)} ${String(rs.length).padStart(8)} ${String(rs.filter((r) => !r.ok).length).padStart(8)} ${ms.toFixed(0).padStart(6)}`,
	);
}
const failed = results.filter((r) => !r.ok);
for (const s of skipped) console.log(`skip ${s}`);
for (const r of failed) console.log(`FAIL ${r.group}/${r.id}\n     ${r.error}`);
if (VERBOSE)
	for (const r of results.filter((x) => x.ok))
		console.log(`ok   ${r.group}/${r.id}`);
console.log(
	failed.length
		? `wgsl-compile: ${failed.length} of ${results.length} variants FAILED`
		: `wgsl-compile: ok (${results.length} variants compiled on Dawn)`,
);
process.exit(failed.length ? 1 : 0);
