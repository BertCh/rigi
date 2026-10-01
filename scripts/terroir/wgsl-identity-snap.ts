// WGSL identity proof for the terroir port in deck-webgpu (reports/terroir-cartography.md): with every
// terroir switch off, the generated terrain-styles WGSL, the pipeline keys, the shader modules and the
// terrainStyle uniform layout must be byte-identical to before the port.
//   npx tsx scripts/terroir/wgsl-identity-snap.ts > after.txt   (and the same at the pre-port commit)
//   diff before.txt after.txt   (empty = identical)
// Dumps: every style x every LOOK feature combination of terrainStyleWGSL, and for every preset x style x
// mode the TerrainStyles key, the shading part's wgsl / defines / module names, and the terrainStyle
// uniform key order + the module's WGSL struct and uniformTypes.
import { createHash } from "node:crypto";
import { deckTerrainStyle } from "../../src/lib/style/deck-apply.ts";
import { PRESET_IDS, presetStyle } from "../../src/lib/style/presets.ts";
import {
	TerrainStyles,
	type TerrainStyleFeatures,
	type TerrainStyleName,
	terrainStyleModule,
	terrainStyleWGSL,
} from "../../src/lib/deck-webgpu/layers/terrain-styles.ts";

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const out: string[] = [];
const STYLES: TerrainStyleName[] = ["hillshade", "imagery", "contours", "elevation", "slope", "slopeClass"];
const FT = ["alpine", "relief", "tanaka", "atmosphere", "water"] as const;

out.push(`module terrainStyle ${h(JSON.stringify(terrainStyleModule))}`);
out.push(terrainStyleModule.source);
for (const st of STYLES)
	for (let m = 0; m < 1 << FT.length; m++) {
		const ft = Object.fromEntries(FT.map((k, i) => [k, !!(m & (1 << i))])) as TerrainStyleFeatures;
		const w = terrainStyleWGSL(st, ft);
		out.push(`wgsl ${st} ${m} len=${w.length} ${h(w)}`);
	}
// full text once per style for a readable diff
for (const st of STYLES) out.push(terrainStyleWGSL(st, { alpine: true, relief: true, tanaka: false, atmosphere: false, water: true }));

for (const id of PRESET_IDS) {
	const style = presetStyle(id);
	for (const mode of ["overlay", "world"] as const)
		for (const st of STYLES) {
			const look = deckTerrainStyle(style, mode);
			const ts = new TerrainStyles(null as never, { style: st, look, contourInterval: 50 });
			const part = ts.shading;
			const u = ts.styleUniforms({ frame: { view: "photo" } } as never);
			out.push(
				`${id} ${mode} ${st} key=${ts.key} wgsl=${h(part.wgsl)} mods=${(part.modules ?? []).map((x) => x.name)} def=${JSON.stringify(part.defines)} uniforms=${Object.keys(u).join(",")} fin=${ts.finish?.key ?? "-"}`,
			);
		}
}
console.log(out.join("\n"));
