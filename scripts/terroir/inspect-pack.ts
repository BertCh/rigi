// Prints a summary of a built terroir pack: npx tsx scripts/terroir/inspect-pack.ts [id]
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { COVER_CLASSES, NAME_TYPO } from "../../src/lib/terroir/classes";
import type { TerroirPack } from "../../src/lib/terroir/types";

const id = process.argv[2] ?? "thunersee";
const dir = resolve(import.meta.dirname, "../../public/terroir", id);
const pack = JSON.parse(
	readFileSync(join(dir, "pack.json"), "utf8"),
) as TerroirPack;
const kb = (f: string) =>
	`${(statSync(join(dir, f)).size / 1024).toFixed(0)} kB`;

console.log(
	`pack ${pack.id} "${pack.name}" bbox=${pack.bbox} created=${pack.created}`,
);
console.log(
	`files: pack.json ${kb("pack.json")}, cover.png ${kb("cover.png")}`,
);
const counts: Record<string, number> = {};
for (const n of pack.names) counts[n.cls] = (counts[n.cls] ?? 0) + 1;
console.log(`\nnames: ${pack.names.length}`);
console.log(
	Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${k}=${v}`)
		.join("  "),
);
console.log(
	"  with alt:",
	pack.names.filter((n) => n.alt).length,
	" with line:",
	pack.names.filter((n) => n.line).length,
	" src osm:",
	pack.names.filter((n) => n.src === "osm").length,
);
const pr = (n: TerroirPack["names"][number]) =>
	NAME_TYPO[n.cls].priority + (n.ele ?? 0) / 1e4;
console.log("\ntop 20 by class priority then elevation:");
for (const n of [...pack.names].sort((a, b) => pr(b) - pr(a)).slice(0, 20))
	console.log(
		`  ${n.cls.padEnd(11)} ${n.name.padEnd(22)} ${String(n.ele ?? "?").padStart(5)} m  ${n.lat.toFixed(4)},${n.lon.toFixed(4)}${n.alt ? `  alt=${n.alt}` : ""}${n.prominence ? `  prom=${n.prominence}` : ""}`,
	);

console.log(
	"\ncover:",
	pack.cover &&
		`${pack.cover.width}x${pack.cover.height} cell~${pack.cover.cellM} m`,
);
const h = pack.cover?.histogram ?? {};
const tot = Object.values(h).reduce((a, b) => a + b, 0);
for (const c of COVER_CLASSES)
	if (h[c.id])
		console.log(
			`  ${String(c.id).padStart(2)} ${c.key.padEnd(10)} ${((h[c.id] / tot) * 100).toFixed(1).padStart(5)}%`,
		);

console.log("\nglaciers:");
for (const g of pack.glaciers) {
	const verts = g.polygons.reduce(
		(a, p) => a + p.reduce((b, r) => b + r.length, 0),
		0,
	);
	console.log(
		`  ${g.year}: ${g.polygons.length} polygons, ${verts} vertices, named ${g.names?.filter(Boolean).length ?? 0}  (${g.source})`,
	);
}
console.log(
	"\nlithology:",
	pack.lithology
		? `${pack.lithology.length} units, ${pack.lithology.reduce((a, u) => a + u.polygons.length, 0)} polygons`
		: "null",
);
if (pack.lithology) {
	const by: Record<string, number> = {};
	for (const u of pack.lithology)
		by[u.cls] = (by[u.cls] ?? 0) + u.polygons.length;
	console.log("  ", JSON.stringify(by));
}
console.log("\nsources:");
for (const s of pack.sources)
	console.log(`  ${s.id.padEnd(16)} ${s.licence}  | ${s.credit}`);
