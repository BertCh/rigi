// swissNAMES3D (CSV anchors + shapefile geometry) -> TerroirName[].
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	BBox,
	LonLat,
	NameClass,
	NameLang,
	NameStatus,
	TerroirName,
} from "../../../src/lib/terroir/types";
import type { Dem } from "./dem";
import {
	haversineM,
	lv95ToWgs84,
	ringAreaM2,
	simplify,
	wgs84ToLv95,
} from "./geo";
import { groupRings, readDbf, readShp } from "./shp";

type Row = {
	uuid: string;
	nuuid: string;
	name: string;
	status: string;
	sprache: string;
	typ: string;
	group: string;
	art: string;
	usage: string;
	pop: string;
	E: number;
	N: number;
	Z: number;
	src: "PKT" | "LIN" | "PLY";
};

const csvRows = (
	file: string,
	src: Row["src"],
	lv: [number, number, number, number],
): Row[] => {
	const lines = readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/);
	const head = lines[0].split(";");
	const ix = (k: string) => head.indexOf(k);
	const iNU = ix("NAME_UUID");
	const [iU, iN, iS, iL, iT, iG, iA, iE, iNn, iZ] = [
		"UUID",
		"NAME",
		"STATUS",
		"SPRACHCODE",
		"NAMEN_TYP",
		"NAMENGRUPPE_UUID",
		"OBJEKTART",
		"E",
		"N",
		"Z",
	].map(ix);
	const iUse = ix("GEBAEUDENUTZUNG"),
		iPop = ix("EINWOHNERKATEGORIE");
	const out: Row[] = [];
	for (let i = 1; i < lines.length; i++) {
		const c = lines[i].split(";");
		if (c.length !== head.length) continue;
		const E = +c[iE],
			N = +c[iNn];
		if (E < lv[0] || E > lv[2] || N < lv[1] || N > lv[3]) continue;
		out.push({
			uuid: c[iU],
			nuuid: c[iNU],
			name: c[iN],
			status: c[iS],
			sprache: c[iL],
			typ: c[iT],
			group: c[iG],
			art: c[iA],
			usage: iUse >= 0 ? c[iUse] : "",
			pop: iPop >= 0 ? c[iPop] : "",
			E,
			N,
			Z: +c[iZ],
			src,
		});
	}
	return out;
};

const LANG: Record<string, NameLang> = {
	Hochdeutsch: "de",
	Franzoesisch: "fr",
	Italienisch: "it",
	Rumantsch: "rm",
	mehrsprachig: "multi",
};
const lang = (s: string): NameLang | null => LANG[s.split(" ")[0]] ?? null;
const STATUS: Record<string, NameStatus> = {
	offiziell: "official",
	ueblich: "usual",
	informell: "informal",
};

const HUT = /(h[üu]e?tte|cabane|capanna|berghaus|biwak|bivouac)$/i;
const ALP =
	/(^|[\s-])(alp|alpe|alpen|stafel|staffel|alm)([\s-]|$)|(alp|alpe)$/i;

/** objektart -> class (null = dropped). Peaks are tiered later. */
function classify(r: Row): NameClass | null {
	switch (r.art) {
		case "Hauptgipfel":
		case "Gipfel":
		case "Alpiner Gipfel":
			return "peak";
		case "Haupthuegel":
		case "Felskopf":
			return "peak-minor";
		case "Pass":
		case "Strassenpass":
			return "pass";
		case "Wasserfall":
			return "waterfall";
		case "Aussichtspunkt":
			return "other";
		case "Ortsteil":
			return "hamlet";
		case "Ort": {
			const p = r.pop;
			if (p.startsWith("> 100") || p.startsWith("10'000")) return "city";
			if (p.startsWith("2'000") || p.startsWith("1'000")) return "town";
			if (p.startsWith("100 bis")) return "village";
			if (p.startsWith("20 bis") || p.startsWith("50 bis")) return "hamlet";
			return null; // < 20 inhabitants
		}
		case "Gebaeude":
			return HUT.test(r.name) && r.Z >= 1500 ? "hut" : null;
		case "Flurname swisstopo":
		case "Lokalname swisstopo":
			if (r.Z >= 1800 && HUT.test(r.name)) return "hut";
			return r.Z >= 900 && ALP.test(r.name) && r.status === "offiziell"
				? "alp"
				: null;
		case "Grat":
		case "Huegelzug":
			return "ridge";
		case "Massiv":
			return "massif";
		case "Gebiet":
		case "Landschaftsname":
		case "Grossregion":
			return "region";
		case "Tal":
		case "Haupttal":
			return "valley";
		case "See":
			return "lake";
		case "Gletscher":
			return "glacier";
		case "Fliessgewaesser":
			return "river";
		case "Luftseilbahn":
		case "Gondelbahn":
		case "Sesselbahn":
		case "Standseilbahn":
			return "lift";
		default:
			return null;
	}
}
// Schutzhuette (point rows) -> hut
const isHutUse = (r: Row) => r.usage === "Schutzhuette";

const CAPS: Partial<Record<NameClass, number>> = {
	"peak-minor": 700,
	ridge: 350,
	region: 160,
	alp: 300,
	lift: 120,
	waterfall: 40,
	river: 150,
	valley: 200,
	pass: 300,
	hamlet: 350,
	other: 40,
};

export type OsmPeak = {
	name: string;
	lat: number;
	lon: number;
	ele: number | null;
	prominence: number | null;
};

function labelPoint(rings: [number, number][][]): [number, number] {
	// pole of inaccessibility (coarse grid search) of the largest outer ring, with holes ignored
	let best = rings[0],
		ba = 0;
	for (const r of rings) {
		const a = Math.abs(ringAreaM2(r));
		if (a > ba) {
			ba = a;
			best = r;
		}
	}
	const xs = best.map((p) => p[0]),
		ys = best.map((p) => p[1]);
	const x0 = Math.min(...xs),
		x1 = Math.max(...xs),
		y0 = Math.min(...ys),
		y1 = Math.max(...ys);
	const inside = (x: number, y: number) => {
		let c = false;
		for (let i = 0, j = best.length - 1; i < best.length; j = i++)
			if (
				best[i][1] > y !== best[j][1] > y &&
				x <
					((best[j][0] - best[i][0]) * (y - best[i][1])) /
						(best[j][1] - best[i][1]) +
						best[i][0]
			)
				c = !c;
		return c;
	};
	const dist = (x: number, y: number) => {
		let d = Infinity;
		for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
			const [ax, ay] = best[j],
				[bx, by] = best[i];
			const dx = bx - ax,
				dy = by - ay,
				l2 = dx * dx + dy * dy;
			const t = l2
				? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2))
				: 0;
			d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
		}
		return d;
	};
	let bp: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2],
		bd = -1;
	// subsample vertices for the distance test on huge rings
	const step = Math.max(1, Math.floor(best.length / 400));
	const sub = step > 1 ? best.filter((_, i) => i % step === 0) : best;
	const saved = best;
	best = sub;
	let cx0 = x0,
		cx1 = x1,
		cy0 = y0,
		cy1 = y1;
	for (let pass = 0; pass < 3; pass++) {
		const N = 18;
		for (let i = 0; i <= N; i++)
			for (let j = 0; j <= N; j++) {
				const x = cx0 + ((cx1 - cx0) * i) / N,
					y = cy0 + ((cy1 - cy0) * j) / N;
				if (!inside(x, y)) continue;
				const d = dist(x, y);
				if (d > bd) {
					bd = d;
					bp = [x, y];
				}
			}
		const hx = (cx1 - cx0) / 6,
			hy = (cy1 - cy0) / 6;
		cx0 = bp[0] - hx;
		cx1 = bp[0] + hx;
		cy0 = bp[1] - hy;
		cy1 = bp[1] + hy;
	}
	best = saved;
	return bp;
}

/** A medial-ish polyline for elongated polygons: vertex means in bins along the principal axis. */
function axisLine(rings: [number, number][][]): [number, number][] | null {
	const pts = rings[0].length > 3 ? rings[0] : null;
	if (!pts) return null;
	let mx = 0,
		my = 0;
	for (const p of pts) {
		mx += p[0];
		my += p[1];
	}
	mx /= pts.length;
	my /= pts.length;
	let sxx = 0,
		sxy = 0,
		syy = 0;
	for (const p of pts) {
		const dx = p[0] - mx,
			dy = p[1] - my;
		sxx += dx * dx;
		sxy += dx * dy;
		syy += dy * dy;
	}
	const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
	const ux = Math.cos(th),
		uy = Math.sin(th);
	const ts = pts.map((p) => (p[0] - mx) * ux + (p[1] - my) * uy);
	const ws = pts.map((p) => -(p[0] - mx) * uy + (p[1] - my) * ux);
	const t0 = Math.min(...ts),
		t1 = Math.max(...ts);
	const w0 = Math.max(...ws) - Math.min(...ws);
	if (t1 - t0 < 2.2 * w0) return null;
	const B = 8,
		acc: { x: number; y: number; n: number }[] = Array.from(
			{ length: B },
			() => ({ x: 0, y: 0, n: 0 }),
		);
	pts.forEach((p, i) => {
		const b = Math.min(B - 1, Math.floor(((ts[i] - t0) / (t1 - t0)) * B));
		acc[b].x += p[0];
		acc[b].y += p[1];
		acc[b].n++;
	});
	const out = acc
		.filter((a) => a.n)
		.map((a) => [a.x / a.n, a.y / a.n] as [number, number]);
	return out.length >= 2 ? out : null;
}

export async function buildNames(opts: {
	bbox: BBox;
	cacheDir: string;
	dem: Dem;
	osmPeaks: OsmPeak[];
	budget?: number;
}): Promise<{ names: TerroirName[]; stats: Record<string, number> }> {
	const { bbox, cacheDir, dem, osmPeaks } = opts;
	const corners = [
		wgs84ToLv95(bbox[1], bbox[0]),
		wgs84ToLv95(bbox[1], bbox[2]),
		wgs84ToLv95(bbox[3], bbox[0]),
		wgs84ToLv95(bbox[3], bbox[2]),
	];
	const lv: [number, number, number, number] = [
		Math.min(...corners.map((c) => c[0])) - 20000,
		Math.min(...corners.map((c) => c[1])) - 20000,
		Math.max(...corners.map((c) => c[0])) + 20000,
		Math.max(...corners.map((c) => c[1])) + 20000,
	];
	const inBox = (lon: number, lat: number) =>
		lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];

	const rows = [
		...csvRows(join(cacheDir, "sn3d/swissNAMES3D_PKT.csv"), "PKT", lv),
		...csvRows(join(cacheDir, "sn3d/swissNAMES3D_LIN.csv"), "LIN", lv),
		...csvRows(join(cacheDir, "sn3d/swissNAMES3D_PLY.csv"), "PLY", lv),
	];
	// geometry for LIN / PLY rows
	const geom = new Map<string, [number, number][][]>();
	for (const src of ["LIN", "PLY"] as const) {
		const base = join(cacheDir, "sn3d-shp", `swissNAMES3D_${src}`);
		if (!existsSync(`${base}.shp`)) continue;
		const want = new Set(rows.filter((r) => r.src === src).map((r) => r.uuid));
		const dbf = readDbf(`${base}.dbf`);
		const shp = readShp(`${base}.shp`, lv);
		for (let i = 0; i < shp.length; i++) {
			const s = shp[i];
			if (s && want.has(String(dbf[i]?.UUID)))
				geom.set(String(dbf[i].UUID), s.parts);
		}
	}

	// pair merge: official name + usual/informal variants of the same NAMENGRUPPE_UUID
	const byGroup = new Map<string, Row[]>();
	for (const r of rows)
		if (r.group && r.group !== "k_W") {
			let arr = byGroup.get(r.group);
			if (!arr) {
				arr = [];
				byGroup.set(r.group, arr);
			}
			arr.push(r);
		}
	const altOf = new Map<string, string>();
	const dropped = new Set<string>();
	for (const g of byGroup.values()) {
		if (g.length < 2) continue;
		const off = g.filter((r) => r.status === "offiziell");
		const rest = g.filter((r) => r.status !== "offiziell" && r.name);
		if (off.length === 1 && rest.length) {
			const alt = rest
				.filter((r) => r.name !== off[0].name)
				.sort(
					(a, b) => +(a.status !== "ueblich") - +(b.status !== "ueblich"),
				)[0];
			if (alt) altOf.set(off[0].nuuid, alt.name);
			for (const r of rest) dropped.add(r.nuuid);
		}
	}

	type Cand = TerroirName & { _len: number; _score: number };
	const osmIdx = osmPeaks;
	const cands: Cand[] = [];
	for (const r of rows) {
		if (dropped.has(r.nuuid) || !r.name) continue;
		let cls = classify(r);
		if (isHutUse(r)) cls = "hut";
		if (!cls) continue;
		const parts = geom.get(r.uuid);
		let [lon, lat] = lv95ToWgs84(r.E, r.N);
		let areaKm2: number | undefined;
		let line: LonLat[] | undefined;
		let len = 0;
		if (parts && r.src === "PLY") {
			const polys = groupRings(parts);
			const rings = parts.filter((p) => p.length > 3);
			let a = 0;
			for (const poly of polys) {
				a += Math.abs(ringAreaM2(poly[0]));
				for (const h of poly.slice(1)) a -= Math.abs(ringAreaM2(h));
			}
			areaKm2 = Math.max(0, a) / 1e6;
			if (rings.length) {
				const lp = labelPoint(polys.length ? polys.map((p) => p[0]) : rings);
				[lon, lat] = lv95ToWgs84(lp[0], lp[1]);
				if (cls === "ridge" || cls === "valley") {
					const ax = axisLine(
						polys.length
							? [
									polys.sort(
										(x, y) =>
											Math.abs(ringAreaM2(y[0])) - Math.abs(ringAreaM2(x[0])),
									)[0][0],
								]
							: rings,
					);
					if (ax)
						line = ax.map(
							([x, y]) =>
								lv95ToWgs84(x, y).map(
									(v) => Math.round(v * 1e5) / 1e5,
								) as LonLat,
						);
				}
			}
		} else if (parts && r.src === "LIN") {
			const ln = parts.slice().sort((a, b) => b.length - a.length)[0];
			for (let i = 1; i < ln.length; i++)
				len += Math.hypot(ln[i][0] - ln[i - 1][0], ln[i][1] - ln[i - 1][1]);
			let s = simplify(ln, 120);
			if (s.length > 40) s = simplify(ln, 400);
			if (s.length > 60)
				s = s.filter(
					(_, i) => i % Math.ceil(s.length / 60) === 0 || i === s.length - 1,
				);
			// anchor: along-line midpoint inside the bbox
			const geo = s.map(([x, y]) => lv95ToWgs84(x, y));
			const inside = geo.filter((p) => inBox(p[0], p[1]));
			line = (inside.length >= 2 ? inside : geo).map(
				(p) => p.map((v) => Math.round(v * 1e5) / 1e5) as LonLat,
			);
			const seg = line;
			let tot = 0;
			for (let i = 1; i < seg.length; i++)
				tot += haversineM(seg[i - 1][1], seg[i - 1][0], seg[i][1], seg[i][0]);
			let acc = 0;
			for (let i = 1; i < seg.length; i++) {
				const d = haversineM(
					seg[i - 1][1],
					seg[i - 1][0],
					seg[i][1],
					seg[i][0],
				);
				if (acc + d >= tot / 2) {
					const t = d ? (tot / 2 - acc) / d : 0;
					lon = seg[i - 1][0] + t * (seg[i][0] - seg[i - 1][0]);
					lat = seg[i - 1][1] + t * (seg[i][1] - seg[i - 1][1]);
					break;
				}
				acc += d;
			}
		}
		if (!inBox(lon, lat)) continue;
		// elevation: Z from swissNAMES3D for point features, DEM otherwise
		let ele: number | null =
			r.src === "PKT" && Number.isFinite(r.Z) && r.Z > 0 ? r.Z : null;
		let prominence: number | null | undefined;
		if (cls === "peak" || cls === "peak-minor") {
			let near: OsmPeak | null = null,
				nd = 300;
			for (const p of osmIdx) {
				if (Math.abs(p.lat - lat) > 0.004 || Math.abs(p.lon - lon) > 0.006)
					continue;
				const d = haversineM(lat, lon, p.lat, p.lon);
				if (d < nd) {
					nd = d;
					near = p;
				}
			}
			prominence = near?.prominence ?? null;
			if (ele == null && near?.ele != null) ele = near.ele;
			const e = ele ?? 0;
			if (
				r.art === "Hauptgipfel" ||
				r.art === "Gipfel" ||
				r.art === "Alpiner Gipfel"
			) {
				if (prominence != null)
					cls =
						prominence >= 300
							? "peak-major"
							: prominence >= 100
								? "peak"
								: "peak-minor";
				else if (r.art === "Hauptgipfel" && e >= 3500) cls = "peak-major";
				else if (
					r.art === "Hauptgipfel" ||
					r.art === "Alpiner Gipfel" ||
					e >= 2200
				)
					cls = "peak";
				else cls = "peak-minor";
			}
		}
		if (ele == null) ele = dem.sample(lat, lon);
		const t: Cand = {
			name: r.name,
			...(altOf.has(r.nuuid) ? { alt: altOf.get(r.nuuid) } : {}),
			cls,
			lat: Math.round(lat * 1e5) / 1e5,
			lon: Math.round(lon * 1e5) / 1e5,
			ele: ele == null ? null : Math.round(ele),
			lang: lang(r.sprache),
			status: STATUS[r.status] ?? null,
			src: "swissnames3d",
			...(line ? { line } : {}),
			...(areaKm2 != null
				? { areaKm2: Math.round(areaKm2 * 1000) / 1000 }
				: {}),
			...(prominence !== undefined ? { prominence } : {}),
			_len: len,
			_score: 0,
		};
		cands.push(t);
	}

	// dedupe: same name + class -> one per ~1.5 km cluster (line/area features keep the largest)
	const kept: Cand[] = [];
	const byKey = new Map<string, Cand[]>();
	for (const c of cands) {
		const k = `${c.name}|${c.cls}`;
		let arr = byKey.get(k);
		if (!arr) {
			arr = [];
			byKey.set(k, arr);
		}
		arr.push(c);
	}
	const weight = (c: Cand) =>
		(c.areaKm2 ?? 0) * 1000 + c._len + (c.line?.length ?? 0);
	for (const arr of byKey.values()) {
		arr.sort((a, b) => weight(b) - weight(a));
		const centers: Cand[] = [];
		for (const c of arr)
			if (
				!centers.some(
					(k) =>
						haversineM(k.lat, k.lon, c.lat, c.lon) <
						(c.cls === "river" || c.cls === "valley" || c.cls === "region"
							? 1e9
							: 1500),
				)
			)
				centers.push(c);
		kept.push(...centers);
	}

	// OSM peaks that swissNAMES3D lacks (>300 m from any named peak/hill)
	const peakSn = kept.filter((c) => c.cls.startsWith("peak"));
	for (const p of osmPeaks) {
		if (!inBox(p.lon, p.lat) || !p.name) continue;
		if (
			peakSn.some(
				(c) =>
					Math.abs(c.lat - p.lat) < 0.004 &&
					Math.abs(c.lon - p.lon) < 0.006 &&
					haversineM(c.lat, c.lon, p.lat, p.lon) < 300,
			)
		)
			continue;
		if (
			kept.some(
				(c) =>
					c.cls.startsWith("peak") &&
					c.name === p.name &&
					haversineM(c.lat, c.lon, p.lat, p.lon) < 1500,
			)
		)
			continue;
		const e = p.ele ?? dem.sample(p.lat, p.lon) ?? 0;
		const pr = p.prominence;
		const cls: NameClass =
			pr != null
				? pr >= 300
					? "peak-major"
					: pr >= 100
						? "peak"
						: "peak-minor"
				: e >= 2200
					? "peak"
					: "peak-minor";
		kept.push({
			name: p.name,
			cls,
			lat: p.lat,
			lon: p.lon,
			ele: Math.round(e),
			lang: null,
			status: null,
			src: "osm",
			prominence: pr,
			_len: 0,
			_score: 0,
		});
	}

	// caps per class (rank by size / elevation), then global budget
	const rank = (c: Cand) =>
		c.cls === "ridge" || c.cls === "region" || c.cls === "valley"
			? (c.areaKm2 ?? 0) + (c.line ? 0.5 : 0)
			: c.cls === "river" || c.cls === "lift"
				? c._len
				: (c.ele ?? 0);
	const out: Cand[] = [];
	const byCls = new Map<string, Cand[]>();
	for (const c of kept) {
		let arr = byCls.get(c.cls);
		if (!arr) {
			arr = [];
			byCls.set(c.cls, arr);
		}
		arr.push(c);
	}
	for (const [cls, arr] of byCls) {
		arr.sort((a, b) => rank(b) - rank(a));
		out.push(...arr.slice(0, CAPS[cls as NameClass] ?? arr.length));
	}
	const budget = opts.budget ?? 4000;
	if (out.length > budget) {
		out.sort(
			(a, b) =>
				(b.cls.startsWith("peak") ? 1e4 : 0) +
				rank(b) / 1e3 -
				((a.cls.startsWith("peak") ? 1e4 : 0) + rank(a) / 1e3),
		);
		out.length = budget;
	}
	const pri: Record<string, number> = {
		"peak-major": 0,
		lake: 1,
		city: 2,
		peak: 3,
		massif: 4,
		glacier: 5,
		town: 6,
		pass: 7,
		region: 8,
		valley: 9,
		ridge: 10,
	};
	out.sort(
		(a, b) =>
			(pri[a.cls] ?? 20) - (pri[b.cls] ?? 20) ||
			(b.ele ?? 0) - (a.ele ?? 0) ||
			(b.areaKm2 ?? 0) - (a.areaKm2 ?? 0),
	);
	const stats: Record<string, number> = {};
	for (const c of out) stats[c.cls] = (stats[c.cls] ?? 0) + 1;
	return { names: out.map(({ _len, _score, ...n }) => n), stats };
}
