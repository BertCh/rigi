/**
 * Interior pin candidates for BLIND clicking (WP-A; protocol: tools/concord/pins/PROTOCOL.txt §2).
 *
 *   npx tsx tools/concord/pins/candidates.mts [IMG_xxxx ...]      (default: the 14 GT photos)
 *
 * Per photo: OSM churches/chapels, rail/cable-car stations, bridge ends, piers/towers/huts and
 * lake/coast shore points at 0.3–5 km, from one Overpass query per location (cached in
 * out/concord/pins/osm/). Each is projected at the GT pose only to keep features that are in frame
 * and not hidden by the DEM (Terrarium line of sight). Outputs (out/concord/pins/):
 *   candidates.json            names, kinds, map coords + map links — NO image positions
 *   candidates-predicted.json  GT-pose projections (do NOT open before clicking; see PROTOCOL)
 *   click.html                 static clicking helper (plain photo, no overlays) → exports InteriorPin JSON
 */
import fs from "node:fs";
import path from "node:path";
import { projectX } from "../../../src/lib/concord/core/index.ts";
import { apparentElevation } from "../../../src/lib/geo/peaks.ts";
import { destination, distanceBearing } from "../../../src/lib/geodesy.ts";
import { OVERPASS, type OsmElement, overpass } from "../../../src/lib/overpass.ts";
import {
	enuOf,
	gtCam,
	gtPhotos,
	loadScene,
	loadSplit,
	type Scene,
} from "../../../scripts/concord/lib.ts";
import { heicToJpeg, IMG_DIR, ROOT } from "../../../scripts/lib/node-io.ts";

const OUT = path.join(ROOT, "out", "concord", "pins");
const OSM_CACHE = path.join(OUT, "osm");
const RADIUS = 5500;
const MIN_D = 300;
const MAX_D = 5000;
const MIN_SEP_PX = 28; // at the 1600-width basis
const MAX_PER_PHOTO = 36;
const MAX_SHORE = 10;

type Kind = "building" | "bridge" | "shore" | "other";
type Cand = {
	cid: string;
	kind: Kind;
	what: string;
	name: string;
	lat: number;
	lon: number;
	distM: number;
	osm: string;
	priority: number;
};

const queries = (lat: number, lon: number) => {
	const a = `(around:${RADIUS},${lat.toFixed(5)},${lon.toFixed(5)})`;
	return {
		poi: `[out:json][timeout:90];(
nwr["amenity"="place_of_worship"]${a};
nwr["building"="church"]${a};
nwr["building"="chapel"]${a};
nwr["railway"~"^(station|halt)$"]${a};
nwr["aerialway"="station"]${a};
nwr["man_made"~"^(tower|lighthouse)$"]${a};
nwr["tourism"~"^(alpine_hut|wilderness_hut)$"]${a};
);out center;`,
		lines: `[out:json][timeout:90];(
way["bridge"="yes"]["highway"~"^(primary|secondary|tertiary|unclassified|residential|trunk|track|service)$"]${a};
way["bridge"="yes"]["railway"]${a};
way["man_made"~"^(pier|breakwater)$"]${a};
);out geom;`,
		water: `[out:json][timeout:120];(
way["natural"="water"]["name"]${a};
way["natural"="coastline"]${a};
rel["natural"="water"]["name"]${a};
way(r)${a};
);out geom;`,
	};
};

/** Three Overpass queries (POIs as centres, line features and shore ways with geometry), cached. */
async function osmFor(lat: number, lon: number): Promise<OsmElement[]> {
	const key = `${lat.toFixed(3)}_${lon.toFixed(3)}`;
	const out: OsmElement[] = [];
	for (const [kind, q] of Object.entries(queries(lat, lon))) {
		const file = path.join(OSM_CACHE, `${key}_${kind}.json`);
		let els: OsmElement[];
		if (fs.existsSync(file))
			els = JSON.parse(fs.readFileSync(file, "utf8")).elements;
		else {
			console.error(`  overpass ${key} ${kind} …`);
			let j: { elements: OsmElement[] } | undefined;
			for (let attempt = 0; attempt < 3 && !j; attempt++) {
				try {
					j = await overpass(q, {
						endpoints: [OVERPASS.main],
						timeoutMs: 150_000,
						userAgent: "rigi-concord-candidates/1 (research)",
					});
				} catch (e) {
					console.error(`  retry ${attempt + 1}: ${(e as Error).message}`);
					await new Promise((r) => setTimeout(r, 15_000 * (attempt + 1)));
				}
			}
			if (!j) {
				if (kind === "poi") throw new Error(`overpass ${kind} failed`);
				console.error(`  WARNING ${key}: no ${kind} features (Overpass failed); not cached`);
				els = [];
			} else {
				fs.mkdirSync(OSM_CACHE, { recursive: true });
				fs.writeFileSync(file, JSON.stringify(j));
				els = j.elements;
			}
		}
		// multipolygon member ways carry no tags of their own: they are lake shores
		if (kind === "water")
			for (const e of els)
				if (e.type === "way" && !e.tags?.natural)
					e.tags = { ...e.tags, natural: "water" };
		out.push(...els);
	}
	return out;
}

const geomOf = (e: OsmElement) => [
	...(e.geometry ?? []),
	...(e.members ?? []).flatMap((m) => m.geometry ?? []),
];
function centroid(e: OsmElement): { lat: number; lon: number } | null {
	if (e.lat !== undefined && e.lon !== undefined)
		return { lat: e.lat, lon: e.lon };
	const c = (e as { center?: { lat: number; lon: number } }).center;
	if (c) return c;
	const g = geomOf(e);
	if (!g.length) return null;
	return {
		lat: g.reduce((s, p) => s + p.lat, 0) / g.length,
		lon: g.reduce((s, p) => s + p.lon, 0) / g.length,
	};
}

function extract(s: Scene, els: OsmElement[]): Cand[] {
	const out: Cand[] = [];
	const push = (
		e: OsmElement,
		p: { lat: number; lon: number },
		kind: Kind,
		what: string,
		priority: number,
		suffix = "",
	) => {
		const { distance } = distanceBearing(s.lat, s.lon, p.lat, p.lon);
		if (distance < MIN_D || distance > MAX_D) return;
		const name = e.tags?.name ?? "";
		out.push({
			cid: `${e.type}/${(e as { id?: number }).id ?? "?"}${suffix}`,
			kind,
			what,
			name,
			lat: p.lat,
			lon: p.lon,
			distM: Math.round(distance),
			osm: `https://www.openstreetmap.org/${e.type}/${(e as { id?: number }).id}`,
			priority,
		});
	};
	for (const e of els) {
		const t = e.tags ?? {};
		if (
			t.amenity === "place_of_worship" ||
			/^(church|chapel|cathedral)$/.test(t.building ?? "")
		) {
			const c = centroid(e);
			if (c) push(e, c, "building", t.building ?? "place of worship", 0);
		} else if (t.railway === "station" || t.railway === "halt") {
			const c = centroid(e);
			if (c) push(e, c, "building", `rail ${t.railway}`, 1);
		} else if (t.aerialway === "station") {
			const c = centroid(e);
			if (c) push(e, c, "building", "cable-car station", 0);
		} else if (/^(alpine_hut|wilderness_hut)$/.test(t.tourism ?? "")) {
			const c = centroid(e);
			if (c) push(e, c, "building", t.tourism as string, 1);
		} else if (/^(tower|lighthouse)$/.test(t.man_made ?? "")) {
			const c = centroid(e);
			if (c) push(e, c, "other", t.man_made as string, 2);
		} else if (/^(pier|breakwater)$/.test(t.man_made ?? "")) {
			const g = geomOf(e);
			if (g.length >= 2) {
				push(e, g[0], "shore", `${t.man_made} end A`, 2, ":a");
				push(e, g[g.length - 1], "shore", `${t.man_made} end B`, 2, ":b");
			}
		} else if (t.bridge === "yes") {
			const g = e.geometry ?? [];
			if (g.length >= 2) {
				const what = `${t.railway ? "rail" : (t.highway ?? "road")} bridge end`;
				push(e, g[0], "bridge", `${what} A`, 1, ":a");
				push(e, g[g.length - 1], "bridge", `${what} B`, 1, ":b");
			}
		} else if (t.natural === "water" || t.natural === "coastline") {
			// shore vertices, thinned to ≥ 200 m spacing
			let last: { lat: number; lon: number } | null = null;
			for (const [i, p] of geomOf(e).entries()) {
				if (
					last &&
					distanceBearing(last.lat, last.lon, p.lat, p.lon).distance < 200
				)
					continue;
				last = p;
				push(
					e,
					p,
					"shore",
					t.natural === "coastline" ? "coast point" : `shore of ${t.name ?? "lake"}`,
					3,
					`:v${i}`,
				);
			}
		}
	}
	return out;
}

/** DEM line of sight from the GT eye to a point `hAbove` m above ground. */
function visible(s: Scene, c: Cand, hAbove: number) {
	const h = s.terrain.sampleAt(c.lon, c.lat, c.distM) + hAbove;
	if (!Number.isFinite(h)) return null;
	const target = apparentElevation(h, s.eyeAlt, c.distM);
	const { bearing } = distanceBearing(s.lat, s.lon, c.lat, c.lon);
	const stop = c.distM - Math.max(40, c.distM * 0.02);
	for (let d = 20; d < stop; d += Math.max(10, d * 0.004)) {
		const p = destination(s.lat, s.lon, bearing, d);
		const hh = s.terrain.sampleAt(p.lon, p.lat, d);
		if (!Number.isNaN(hh) && apparentElevation(hh, s.eyeAlt, d) > target + 0.05)
			return null;
	}
	return h;
}

const esc = (x: string) =>
	x.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

async function main() {
	const photos = process.argv.slice(2).length
		? process.argv.slice(2)
		: gtPhotos();
	const split = loadSplit();
	const blind: Record<string, unknown> = {};
	const predicted: Record<string, unknown> = {};
	for (const photo of photos) {
		const s = await loadScene(photo);
		const cam = gtCam(photo);
		let els: OsmElement[];
		try {
			els = await osmFor(s.lat, s.lon);
		} catch (e) {
			console.error(`${photo}: overpass failed: ${(e as Error).message}`);
			continue;
		}
		const all = extract(s, els);
		const kept: (Cand & { x: number; y: number })[] = [];
		const sorted = [...all].sort(
			(a, b) => a.priority - b.priority || a.distM - b.distM,
		);
		let shores = 0;
		for (const c of sorted) {
			if (kept.length >= MAX_PER_PHOTO) break;
			if (c.kind === "shore" && shores >= MAX_SHORE) continue;
			const h = visible(s, c, c.kind === "building" ? 3 : 0.5);
			if (h === null) continue;
			const q = projectX(cam, enuOf(s, c.lat, c.lon, h));
			if (!q || q.u < 0.02 || q.u > 0.98 || q.v < 0.02 || q.v > 0.98) continue;
			const x = q.u * 1600;
			const y = (q.v * 1600) / cam.aspect;
			if (kept.some((k) => Math.hypot(k.x - x, k.y - y) < MIN_SEP_PX)) continue;
			if (c.kind === "shore") shores++;
			kept.push({ ...c, x, y });
		}
		kept.sort((a, b) => a.distM - b.distM);
		const isCH = s.lat > 45.8 && s.lat < 47.9 && s.lon > 5.9 && s.lon < 10.6;
		blind[photo] = {
			split: split[photo],
			aspect: cam.aspect,
			jpg: `../../../.cache/jpg/1600/${photo}.jpg`,
			candidates: kept.map((c) => ({
				cid: c.cid,
				kind: c.kind,
				what: c.what,
				name: c.name,
				lat: +c.lat.toFixed(7),
				lon: +c.lon.toFixed(7),
				distM: c.distM,
				osm: c.osm,
				map: isCH
					? `https://map.geo.admin.ch/?lang=en&swisssearch=${c.lat.toFixed(6)},${c.lon.toFixed(6)}&zoom=11`
					: `https://www.openstreetmap.org/?mlat=${c.lat.toFixed(6)}&mlon=${c.lon.toFixed(6)}#map=17/${c.lat.toFixed(6)}/${c.lon.toFixed(6)}`,
			})),
		};
		predicted[photo] = kept.map((c) => ({
			cid: c.cid,
			x: +c.x.toFixed(1),
			y: +c.y.toFixed(1),
		}));
		heicToJpeg(path.join(IMG_DIR, `${photo}.HEIC`), 1600);
		const near = kept.filter((c) => c.distM < 2000).length;
		console.log(
			`${photo} (${split[photo]}): ${all.length} OSM features in 0.3–5 km → ${kept.length} in frame & DEM-visible (${near} < 2 km)`,
		);
	}
	fs.mkdirSync(OUT, { recursive: true });
	fs.writeFileSync(
		path.join(OUT, "candidates.json"),
		JSON.stringify(
			{ note: "Blind candidate list: no image positions.", photos: blind },
			null,
			1,
		),
	);
	fs.writeFileSync(
		path.join(OUT, "candidates-predicted.json"),
		JSON.stringify(
			{
				WARNING:
					"GT-pose projections of the candidates. Do not open before clicking (PROTOCOL.txt §2).",
				photos: predicted,
			},
			null,
			1,
		),
	);
	fs.writeFileSync(path.join(OUT, "click.html"), clickHtml(esc(JSON.stringify(blind))));
	console.log(`wrote ${path.relative(ROOT, OUT)}/{candidates.json,candidates-predicted.json,click.html}`);
}

function clickHtml(data: string) {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Interior pin clicker</title>
<style>
:root{--bg:#fafaf8;--fg:#1c1c1a;--mut:#6b6b66;--line:#d9d9d4;--acc:#0b63c5;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecece8;--mut:#9a9a94;--line:#34342f;--acc:#6aa8ff;--card:#1f1f1d}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif}
header{padding:10px 16px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
main{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:12px;padding:12px 16px}
@media (max-width:900px){main{grid-template-columns:1fr}}
#wrap{position:relative;overflow:auto;border:1px solid var(--line);background:#000}
#img{display:block;width:100%;cursor:crosshair}
#mark{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border:2px solid #fff;border-radius:50%;pointer-events:none;display:none}
.c{border:1px solid var(--line);background:var(--card);border-radius:6px;padding:8px;margin-bottom:6px}
.c.cur{border-color:var(--acc)}.c.done{opacity:.55}
button,select,input{font:inherit}
textarea{width:100%;height:160px;font:12px ui-monospace,monospace;background:var(--card);color:var(--fg);border:1px solid var(--line)}
small{color:var(--mut)} a{color:var(--acc)}
</style></head><body>
<header><b>Interior pin clicker</b>
<select id="ph"></select><span id="info"></span>
<small>Blind protocol: no overlays. Click the feature in the photo, then Accept. Unsure → Skip.</small></header>
<main><div><div id="wrap"><img id="img" alt="photo"><div id="mark"></div></div>
<small>Zoom: browser zoom (Cmd +). Click position is recorded in the 1600-width basis.</small></div>
<aside><div id="list"></div>
<p><label>h above ground (m) <input id="ha" type="number" value="0" step="0.5" style="width:70px"></label>
<label>sigma px <input id="sg" type="number" value="2" step="0.5" style="width:60px"></label></p>
<p><label>note <input id="nt" style="width:100%"></label></p>
<p><button id="acc">Accept click</button> <button id="skip">Skip</button></p>
<p><button id="exp">Export all (copy JSON)</button></p><textarea id="out" readonly></textarea></aside></main>
<script>
const D=${data};
const st={photo:null,i:0,click:null,pins:[]};
try{st.pins=JSON.parse(localStorage.getItem("concord-pins")||"[]")}catch(e){}
const $=id=>document.getElementById(id);
const save=()=>{try{localStorage.setItem("concord-pins",JSON.stringify(st.pins))}catch(e){};$("out").value=JSON.stringify(st.pins,null,1)};
for(const p of Object.keys(D)){const o=document.createElement("option");o.value=p;o.textContent=p+" ("+D[p].split+", "+D[p].candidates.length+")";$("ph").append(o)}
function show(){const P=D[st.photo];$("img").src=P.jpg;$("mark").style.display="none";st.click=null;
 $("info").textContent=st.photo+" — "+P.split;
 $("list").innerHTML=P.candidates.map((c,i)=>{const done=st.pins.some(p=>p.id==="ip:"+st.photo+":"+c.cid);
 return '<div class="c'+(i===st.i?' cur':'')+(done?' done':'')+'" data-i="'+i+'"><b>'+(c.name||c.what)+'</b> <small>'+c.what+' · '+(c.distM/1000).toFixed(2)+' km · '+c.kind+'</small><br><a target="_blank" href="'+c.map+'">map</a> · <a target="_blank" href="'+c.osm+'">osm</a></div>'}).join("");
 for(const el of document.querySelectorAll(".c"))el.onclick=()=>{st.i=+el.dataset.i;show()}}
$("ph").onchange=()=>{st.photo=$("ph").value;st.i=0;show()};
$("img").onclick=e=>{const r=$("img").getBoundingClientRect();const fx=(e.clientX-r.left)/r.width,fy=(e.clientY-r.top)/r.height;
 const W=1600,H=1600/D[st.photo].aspect;st.click={x:+(fx*W).toFixed(1),y:+(fy*H).toFixed(1)};
 const m=$("mark");m.style.display="block";m.style.left=(e.clientX-r.left+$("wrap").scrollLeft)+"px";m.style.top=(e.clientY-r.top+$("wrap").scrollTop)+"px"};
$("acc").onclick=()=>{if(!st.click)return alert("click the feature first");const c=D[st.photo].candidates[st.i];
 const kind=c.kind==="shore"?"shore":c.kind;const pin={photo:st.photo,id:"ip:"+st.photo+":"+c.cid,x:st.click.x,y:st.click.y,basis:1600,lat:c.lat,lon:c.lon,hAbove:+$("ha").value,kind,source:"osm",split:D[st.photo].split,sigmaPx:+$("sg").value};
 if($("nt").value)pin.note=$("nt").value;else pin.note=(c.name||c.what);
 st.pins=st.pins.filter(p=>p.id!==pin.id);st.pins.push(pin);save();st.i=Math.min(st.i+1,D[st.photo].candidates.length-1);$("nt").value="";show()};
$("skip").onclick=()=>{st.i=Math.min(st.i+1,D[st.photo].candidates.length-1);show()};
$("exp").onclick=()=>{save();$("out").select();navigator.clipboard?.writeText($("out").value)};
st.photo=Object.keys(D)[0];$("ph").value=st.photo;show();save();
</script></body></html>`;
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
