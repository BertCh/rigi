// Snapshot of every terrain shader program's inputs (deck terrainShaders + luma assembly, three
// makeTerrainMaterial) and the deck tile draw's uniform values, per preset × mode × layer style, with
// the terroir switches OFF. Proves the terroir shader work is additive (byte-identical when off):
//   1. a pre-change copy OUTSIDE the repo (a copy under the repo breaks `tsc -p .`): cp -R src package.json
//      tsconfig.json scripts/terroir/shader-identity-snap.ts → <scratch>/before/…, restore the pre-change
//      deck/terrain-layer.ts + materials.ts there, symlink node_modules; run it there > before.txt
//   2. here > after.txt; diff before.txt after.txt (must be empty)
// --on: also splices + luma-assembles every program with every terroir switch on (stderr summary).
import { createHash } from "node:crypto";
import { assembleGLSLShaderPair } from "@luma.gl/shadertools";
import {
	fs,
	STYLE,
	setTerrainShaderProps,
	terrainShaders,
	terroirFs,
	withTerrainPass,
} from "../../src/lib/deck/terrain-layer.ts";
import { terrainDefines, withSlopeLayer } from "../../src/lib/look/look-key.ts";
import {
	makeSharedUniforms,
	makeTerrainMaterial,
} from "../../src/lib/materials.ts";
import { deckTerrainStyle } from "../../src/lib/style/deck-apply.ts";
import { CLASSIC } from "../../src/lib/style/defaults.ts";
import { PRESET_IDS, presetStyle } from "../../src/lib/style/presets.ts";
import type { ViewStyle } from "../../src/lib/style/types.ts";

const h = (s: string) =>
	createHash("sha256").update(s).digest("hex").slice(0, 16);
const platformInfo = {
	type: "webgl",
	gpu: "test",
	shaderLanguage: "glsl",
	shaderLanguageVersion: 300,
	features: new Set<string>(),
} as never;

const lines: string[] = [];
const styles = PRESET_IDS.map(
	(id) => [id, presetStyle(id)] as [string, ViewStyle],
);
// the terroir preset with every terroir switch off: must equal its pre-change program
styles.push([
	"terroir-off",
	{ ...presetStyle("terroir"), terroir: CLASSIC.terroir },
]);
for (const [id, style] of styles) {
	for (const mode of ["overlay", "replace", "world"] as const) {
		const look = deckTerrainStyle(style, mode);
		for (const st of Object.keys(STYLE) as (keyof typeof STYLE)[]) {
			const sh = terrainShaders(
				{ look, style: st },
				"#version 300 es\nvoid main() {}\n",
			) as {
				vs: string;
				fs: string;
				modules: { name: string; vs?: string; fs?: string; inject?: unknown }[];
				defines?: Record<string, boolean>;
				inject?: unknown;
			};
			let asm = "";
			try {
				const r = assembleGLSLShaderPair({
					platformInfo,
					vs: sh.vs,
					fs: sh.fs,
					modules: sh.modules as never,
					defines: sh.defines ?? {},
				} as never) as { vs: string; fs: string };
				asm = `${h(r.vs)} ${h(r.fs)}`;
			} catch (e) {
				asm = `assemble-error ${(e as Error).message.slice(0, 60)}`;
			}
			const mods = sh.modules.map(
				(m) =>
					`${m.name}:${h(`${m.vs ?? ""}|${m.fs ?? ""}|${JSON.stringify(m.inject ?? null)}`)}`,
			);
			// the uniform values the tile draw sets (textures as tags), per pass
			const vals: string[] = [];
			for (const pass of [null, "geometry", "color"] as const) {
				const got: unknown[] = [];
				const model = {
					shaderInputs: { setProps: (p: unknown) => got.push(p) },
				} as never;
				const tex = (n: string) => ({ toJSON: () => n }) as never;
				const draw = () =>
					setTerrainShaderProps(
						model,
						{
							style: st,
							look,
							contourInterval: 50,
							contourOpacity: 1,
							elevRange: [400, 4200],
							haze: null,
							projectPhoto: 0,
							photoViewProj: null,
							photoPos: [0, 0, 0],
							photoMinRange: 80,
							nearFade: 60,
							nearDiscard: 20,
							protectPeople: true,
							harmonize: null,
							truth: 0,
							photoTexture: null,
							photoRange: null,
							photoFg: null,
							emptyTexture: tex("empty"),
							reliefTex: null,
							terroir: null,
						},
						undefined,
						{ cameraPosition: [0, 0, 0] },
					);
				if (pass) withTerrainPass(pass, draw);
				else draw();
				vals.push(h(JSON.stringify(got)));
			}
			lines.push(
				`deck ${id} ${mode} ${st} vals=${vals.join("/")} fs=${h(sh.fs)} vs=${h(sh.vs)} defines=${JSON.stringify(sh.defines ?? null)} inject=${JSON.stringify(sh.inject ?? null)} mods=${mods.join(",")} asm=${asm}`,
			);
		}
	}
	// three: the terrain material for the style's terrain defines (± the slope layer)
	for (const slope of [false, true]) {
		const d = Object.fromEntries(
			withSlopeLayer(terrainDefines(style), slope).map((k) => [k, ""]),
		);
		const m = makeTerrainMaterial(makeSharedUniforms(), d);
		lines.push(
			`three ${id} slope=${slope} frag=${h(m.fragmentShader)} vert=${h(m.vertexShader)} defines=${JSON.stringify(m.defines)} key=${h(m.customProgramCacheKey())}`,
		);
	}
}
console.log(lines.join("\n"));

// --on: every program with every terroir switch on (a synthetic cover grid) must splice and assemble
if (process.argv.includes("--on")) {
	const { EnuFrame } = await import("../../src/lib/geodesy.ts");
	const { makeGrid } = await import("../../src/lib/terroir/pack.ts");
	const { terroirShader } = await import(
		"../../src/lib/terroir/glsl/values.ts"
	);
	const { terrainFragment } = await import("../../src/lib/materials.ts");
	const grid = makeGrid([7.35, 46.45, 8.25, 46.95], 9, 7, new Uint8Array(63));
	const frame = new EnuFrame(46.71, 7.77, 0);
	let n = 0;
	for (const [, base] of styles) {
		const style: ViewStyle = {
			...base,
			terroir: {
				...base.terroir,
				contours: { adaptive: true, swissIndex: true, inkByCover: true },
				cover: { on: true, snow: "date" },
			},
		};
		const terroir = terroirShader(style, grid, frame, "2025-02-10T10:00:00Z");
		if (terroir?.defines.length !== 4)
			throw new Error(`defines ${terroir?.defines}`);
		for (const mode of ["overlay", "replace", "world"] as const) {
			const look = deckTerrainStyle(style, mode);
			for (const st of Object.keys(STYLE) as (keyof typeof STYLE)[]) {
				const sh = terrainShaders(
					{ look, style: st, terroir },
					"#version 300 es\nvoid main() {}\n",
				);
				assembleGLSLShaderPair({
					platformInfo,
					...sh,
					defines: sh.defines ?? {},
				} as never);
				n++;
				// the batched layer's variant of the fragment shader (batched-terrain-layer.ts fsBatched)
				const batched = fs
					.replace(
						"uniform sampler2D terrainMap;",
						"uniform highp sampler2DArray terrainMaps;\nflat in float vMapLayer;",
					)
					.replace(
						"texture(terrainMap, vUv)",
						"texture(terrainMaps, vec3(vUv, vMapLayer))",
					)
					.replace(
						"textureLod(terrainMap, vUv, 3.0)",
						"textureLod(terrainMaps, vec3(vUv, vMapLayer), 3.0)",
					);
				if (terroirFs({ look, style: st, terroir }, batched) === batched)
					throw new Error("batched fs not spliced");
				if (terroirFs({ look, style: st, terroir: null }, batched) !== batched)
					throw new Error("batched fs changed with terroir off");
			}
		}
		for (const slope of [false, true]) {
			const d = Object.fromEntries(
				[
					...withSlopeLayer(terrainDefines(style), slope),
					...terroir.defines,
				].map((k) => [k, ""]),
			);
			if (
				terrainFragment(d) ===
				makeTerrainMaterial(makeSharedUniforms(), {}).fragmentShader
			)
				throw new Error("three fragment not patched");
			n++;
		}
	}
	console.error(`terroir on: ${n} programs spliced + assembled`);
}
