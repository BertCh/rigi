// Split class of the labelled cells that still smear with the feature on (forced), per label class.
//   node tools/nearfield/smear/why.mjs [three|deck]
import fs, { existsSync as _ex, readFileSync as _rd } from "node:fs";
import { gunzipSync } from "node:zlib";

// grids are stored gzipped (grid-*.json.gz); plain .json still read
const readGrid = (f) =>
	_ex(f)
		? JSON.parse(_rd(f, "utf8"))
		: JSON.parse(gunzipSync(_rd(`${f}.gz`)).toString("utf8"));
const gridExists = (f) => _ex(f) || _ex(`${f}.gz`);
const dir = new URL(".", import.meta.url).pathname;
const r = process.argv[2] ?? "three";
const L = JSON.parse(fs.readFileSync(`${dir}labels.json`, "utf8")).photos;
const inPoly = (p, x, y) => {
	let s = false;
	for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
		const [a, b] = p[i],
			[c, d] = p[j];
		if (b > y !== d > y && x < ((c - a) * (y - b)) / (d - b) + a) s = !s;
	}
	return s;
};
const inS = (l, x, y) =>
	l.box
		? x >= l.box[0] && x <= l.box[2] && y >= l.box[1] && y <= l.box[3]
		: inPoly(l.poly, x, y);
const names = ["Sky", "Terrain", "Object", "Far", "Unknown"];
const out = {};
for (const [id, list] of Object.entries(L)) {
	const f = `${dir}grid-${r}-${id}.json`;
	if (!gridExists(f)) continue;
	const g = readGrid(f);
	for (let j = 0; j < g.GH; j++)
		for (let i = 0; i < g.GW; i++) {
			const k = j * g.GW + i,
				x = (i + 0.5) / g.GW,
				y = (j + 0.5) / g.GH;
			let h = null;
			for (const l of list)
				if (
					!l.unsure &&
					inS(l, x, y) &&
					(!h || (l.cls === "person" && h.cls !== "person"))
				)
					h = l;
			if (!h || !(g.range[k] > g.minRange) || g.off[k] || g.on[k]) continue;
			const o = (out[h.cls] ??= {});
			const n = names[g.cls[k]] ?? "none";
			o[n] = (o[n] ?? 0) + 1;
		}
}
console.log(JSON.stringify(out));
