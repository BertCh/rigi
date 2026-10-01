// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Schema + sanity check for public/terroir (pure node): npx tsx scripts/terroir/pack.check.ts
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	NameClass,
	TerroirPack,
	TerroirPackIndex,
} from "../../src/lib/terroir/types";
import { decodePng } from "./lib/png";

const ROOT = resolve(import.meta.dirname, "../../public/terroir");
let fails = 0;
const ok = (c: unknown, msg: string) => {
	if (!c) {
		fails++;
		console.error("FAIL", msg);
	} else console.log("ok  ", msg);
};

const CLS: NameClass[] = [
	"peak-major",
	"peak",
	"peak-minor",
	"ridge",
	"massif",
	"pass",
	"glacier",
	"lake",
	"river",
	"waterfall",
	"valley",
	"region",
	"city",
	"town",
	"village",
	"hamlet",
	"alp",
	"hut",
	"field",
	"lift",
	"other",
];
const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
const bboxOk = (b: unknown) =>
	Array.isArray(b) &&
	b.length === 4 &&
	b.every(finite) &&
	(b as number[])[0] < (b as number[])[2] &&
	(b as number[])[1] < (b as number[])[3];

const idx = JSON.parse(
	readFileSync(join(ROOT, "index.json"), "utf8"),
) as TerroirPackIndex;
ok(
	idx.v === 1 && Array.isArray(idx.packs) && idx.packs.length > 0,
	"index.json v1 with packs",
);
for (const e of idx.packs)
	ok(
		typeof e.id === "string" &&
			typeof e.name === "string" &&
			typeof e.path === "string" &&
			bboxOk(e.bbox),
		`index entry ${e.id}`,
	);

for (const entry of idx.packs) {
	const pack = JSON.parse(
		readFileSync(join(ROOT, entry.path, "pack.json"), "utf8"),
	) as TerroirPack;
	const p = entry.id;
	ok(pack.v === 1 && pack.id === entry.id && bboxOk(pack.bbox), `${p}: header`);
	ok(
		pack.sources.length > 0 &&
			pack.sources.every(
				(s) => s.id && s.label && s.licence && s.url && s.credit,
			),
		`${p}: sources complete`,
	);
	const [w, s, e, n] = pack.bbox;
	ok(
		pack.names.length > 500 && pack.names.length <= 4500,
		`${p}: ${pack.names.length} names within budget`,
	);
	ok(
		pack.names.every(
			(x) =>
				x.name &&
				CLS.includes(x.cls) &&
				finite(x.lat) &&
				finite(x.lon) &&
				x.lon >= w &&
				x.lon <= e &&
				x.lat >= s &&
				x.lat <= n &&
				(x.ele === null || finite(x.ele)) &&
				(x.src === "swissnames3d" || x.src === "osm") &&
				(x.lang === null ||
					["de", "fr", "it", "rm", "multi"].includes(x.lang)) &&
				(x.status === null ||
					["official", "usual", "informal"].includes(x.status)),
		),
		`${p}: every name valid and inside bbox`,
	);
	ok(
		pack.glaciers.length >= 2 &&
			pack.glaciers.some((g) => g.year <= 1973) &&
			pack.glaciers.some((g) => g.year >= 2016),
		`${p}: glacier years ${pack.glaciers.map((g) => g.year)}`,
	);
	for (const g of pack.glaciers) {
		const hs = g.heights;
		const parallel =
			!!hs &&
			hs.length === g.polygons.length &&
			g.polygons.every(
				(poly, i) =>
					poly.length === hs[i].length &&
					poly.every((r, j) => r.length === hs[i][j].length),
			);
		ok(
			parallel && (!g.names || g.names.length === g.polygons.length),
			`${p}: glacier ${g.year} heights/names parallel to polygons`,
		);
		ok(
			g.polygons.every((poly) =>
				poly.every(
					(r) => r.length >= 4 && r.every((v) => finite(v[0]) && finite(v[1])),
				),
			),
			`${p}: glacier ${g.year} rings valid`,
		);
	}
	ok(
		!pack.lithology ||
			pack.lithology.every((u) => u.label && u.cls && u.polygons.length > 0),
		`${p}: lithology valid or null`,
	);

	const cover = pack.cover;
	if (!cover) throw new Error(`${p}: missing cover`);
	ok(
		!!cover && cover.url === "cover.png" && bboxOk(cover.bbox),
		`${p}: cover meta`,
	);
	const png = decodePng(readFileSync(join(ROOT, entry.path, cover.url)));
	ok(
		png.width === cover.width && png.height === cover.height,
		`${p}: cover PNG ${png.width}x${png.height} matches meta`,
	);
	const at = (lat: number, lon: number) => {
		const x = Math.min(
			png.width - 1,
			Math.floor(
				((lon - cover.bbox[0]) / (cover.bbox[2] - cover.bbox[0])) * png.width,
			),
		);
		const y = Math.min(
			png.height - 1,
			Math.floor(
				((cover.bbox[3] - lat) / (cover.bbox[3] - cover.bbox[1])) * png.height,
			),
		);
		return png.data[(y * png.width + x) * png.channels];
	};
	const hist: Record<number, number> = {};
	for (let i = 0; i < png.width * png.height; i++)
		hist[png.data[i * png.channels]] =
			(hist[png.data[i * png.channels]] ?? 0) + 1;
	ok(
		Object.keys(hist).every((k) => +k >= 0 && +k <= 14),
		`${p}: cover values within 0..14`,
	);
	ok(
		Object.entries(cover.histogram ?? {}).every(([k, v]) => hist[+k] === v),
		`${p}: histogram matches PNG`,
	);
	ok((hist[0] ?? 0) / (png.width * png.height) < 0.02, `${p}: <2% no-data`);

	if (p === "thunersee") {
		const find = (
			name: string,
			cls: NameClass[],
			lat: number,
			lon: number,
			r = 0.05,
		) =>
			pack.names.find(
				(x) =>
					x.name.includes(name) &&
					cls.includes(x.cls) &&
					Math.abs(x.lat - lat) < r &&
					Math.abs(x.lon - lon) < r,
			);
		const jf = find("Jungfrau", ["peak", "peak-major"], 46.537, 7.962, 0.03);
		ok(
			!!jf && jf.ele != null && Math.abs(jf.ele - 4158) < 25,
			`Jungfrau peak ${jf?.cls} ele=${jf?.ele}`,
		);
		ok(!!find("Thunersee", ["lake"], 46.7, 7.75, 0.1), "Thunersee is a lake");
		ok(
			!!find("Brienzersee", ["lake"], 46.73, 7.97, 0.1),
			"Brienzersee is a lake",
		);
		ok(
			!!find("Interlaken", ["city", "town", "village"], 46.686, 7.863, 0.03),
			"Interlaken present",
		);
		ok(!!find("Thun", ["city", "town"], 46.758, 7.628, 0.03), "Thun present");
		ok(
			[
				"Eiger",
				"Mönch",
				"Finsteraarhorn",
				"Schreckhorn",
				"Wetterhorn",
				"Blüemlisalp",
			].every((nm) => pack.names.some((x) => x.name.includes(nm))),
			"Eiger/Mönch/Finsteraarhorn/Schreckhorn/Wetterhorn/Blüemlisalp present",
		);
		ok(
			at(46.69, 7.72) === 12,
			`cover at Lake Thun centre = ${at(46.69, 7.72)} (12)`,
		);
		ok(
			[1, 2].includes(at(46.52, 8.0)),
			`cover at Jungfraufirn/Aletsch (46.52N 8.00E) = ${at(46.52, 8.0)} (1|2)`,
		);
		ok(
			[1, 2].includes(at(46.5475, 7.985)),
			`cover at Jungfraujoch firn (46.5475N 7.985E) = ${at(46.5475, 7.985)} (1|2)`,
		);
		const forest = at(46.72, 7.76);
		ok(
			forest === 5 || forest === 6,
			`forest point (46.72N 7.76E, Habkern slope) = ${forest} (5|6)`,
		);
		ok(
			at(46.7115, 7.7745) !== 12,
			`Niederhorn summit is not water (${at(46.7115, 7.7745)})`,
		);
		ok((hist[1] ?? 0) + (hist[2] ?? 0) > 20000, "ice present");
		ok(
			(pack.glaciers.find((g) => g.year === 1850)?.polygons.length ?? 0) > 100,
			"1850 extent has glaciers",
		);
	}
}
console.log(fails ? `\n${fails} FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
