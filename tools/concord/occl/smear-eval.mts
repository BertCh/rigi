// WP-F CPU evaluation: does the DSM occluder stop the Step Inside drape smear? DEV photos only.
//   npx tsx tools/concord/occl/smear-eval.mts [--renderer=three|deck] [--dtm=4|2] [--radius=2000]
//        [--maxTiles=N] [--minObj=2.5] [--near=15] [--nowedge]
//
// Inputs (read-only): tools/nearfield/smear/grid-<renderer>-<id>.json.gz (per-cell app range, classic drape
// mask `off`, Step Inside mask `on`, measured at the GT pose — scripts/nearfield/smear-measure.mjs) and the
// blind labels tools/nearfield/smear/labels.json. Photo split: tools/concord/pins/PROTOCOL.txt (holdout
// photos are skipped and never read).
//
// Smear rule (smear-measure.mjs): a labelled cell smears iff range > minRange (80 m) and it is not masked.
// The occluder adds a mask wherever the DSM object hit h is in front of the terrain: occludedBy(range, h)
// (range > h·1.05 + 3 m, OCCL_RULE). Variants:
//   off        classic drape (people mask) — the baseline
//   occl       classic + DSM occluder (the WP-F product: not gated by Step Inside anchor quality)
//   on+occl    Step Inside mask (product gating: gated photos show no scene) + DSM occluder
// Collateral: unlabelled cells > 0.02 from any label box, draped with `off`, masked by the variant.
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { unprojectDirX } from "../../../src/lib/concord/core";
import {
	eyeAltitudeOver,
	loadNearDsm,
	type NearDsm,
	nearHeightAt,
} from "../../../src/lib/concord/occl/ndsm";
import {
	objectHitRange,
	occludedBy,
} from "../../../src/lib/concord/occl/occluder";
import { inSwissExtent } from "../../../src/lib/concord/occl/swiss-cog";
import { gtCam, loadGT, loadSplit } from "../../../scripts/concord/lib";
import {
	cacheBytes,
	cachedJsonFetcher,
	cachedRangeFetcher,
	netStats,
} from "./node-io.mts";
import { wedgeOf } from "./wedge.mts";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SMEAR = path.join(ROOT, "tools/nearfield/smear");
const arg = (k: string, d?: string) =>
	process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const renderer = arg("renderer", "three") as string;
const dtmRes = Number(arg("dtm", "4")) as 2 | 4;
const radius = Number(arg("radius", "2000"));
const maxTiles = arg("maxTiles") ? Number(arg("maxTiles")) : undefined;
/** Byte budget per photo (default = loadNearDsm's product default 4.5 MB; "inf" = none). */
const maxBytes = arg("maxBytes")
	? Number(arg("maxBytes")?.replace("inf", "Infinity"))
	: undefined;
const minObjM = Number(arg("minObj", "2.5"));
const nearSkipM = Number(arg("near", "15"));
const useWedge = !process.argv.includes("--nowedge");
const BAND = 0.02;

const labels = JSON.parse(
	fs.readFileSync(path.join(SMEAR, "labels.json"), "utf8"),
) as {
	photos: Record<
		string,
		{ cls: string; poly?: number[][]; box?: number[]; unsure?: boolean }[]
	>;
};
const split = loadSplit();
const gt = loadGT();

type L = (typeof labels.photos)[string][number];
const inPoly = (poly: number[][], x: number, y: number) => {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i];
		const [xj, yj] = poly[j];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
			inside = !inside;
	}
	return inside;
};
const bbox = (l: L) => {
	if (l.box) return l.box;
	const xs = (l.poly as number[][]).map((p) => p[0]);
	const ys = (l.poly as number[][]).map((p) => p[1]);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const inShape = (l: L, x: number, y: number) =>
	l.box
		? x >= l.box[0] && x <= l.box[2] && y >= l.box[1] && y <= l.box[3]
		: inPoly(l.poly as number[][], x, y);

const VARIANTS = [
	"off",
	"occl",
	"onProd+occl",
	"onForced",
	"onForced+occl",
] as const;
type V = (typeof VARIANTS)[number];
type Acc = Record<V, number> & { lab: number };
const zero = (): Acc => ({
	lab: 0,
	off: 0,
	occl: 0,
	"onProd+occl": 0,
	onForced: 0,
	"onForced+occl": 0,
});
const addTo = (a: Acc, b: Partial<Acc>) => {
	for (const [k, v] of Object.entries(b)) a[k as keyof Acc] += v as number;
};
const pooledSure: Record<string, Acc> = {};
const pooledAll: Record<string, Acc> = {};
const coll: Record<V, { draped: number; removed: number }> = Object.fromEntries(
	VARIANTS.map((v) => [v, { draped: 0, removed: 0 }]),
) as never;
const perPhoto: Record<string, unknown> = {};

// pure-DTM ray march (sanity check of eye / pose / frame against the app's range buffer)
function dtmHit(d: NearDsm, eye: number[], dir: number[], maxT: number) {
	const hs = Math.hypot(dir[0], dir[1]);
	if (hs < 1e-6) return Number.NaN;
	const dt = (d.res * 0.5) / hs;
	const R_DROP = (1 - 0.13) / (2 * 6371008.8);
	for (let t = 3; t < maxT; t += dt) {
		const e = eye[0] + t * dir[0];
		const n = eye[1] + t * dir[1];
		const g = nearHeightAt(d, "dtm", e, n);
		if (!Number.isFinite(g)) return Number.NaN;
		if (eye[2] + t * dir[2] + (e * e + n * n) * R_DROP <= g) return t;
	}
	return Number.NaN;
}

/** Photo + labels (yellow; dashed = unsure) + DSM-occluded draped cells (magenta), smear left (red). */
async function viz(
	id: string,
	g: {
		GW: number;
		GH: number;
		range: number[];
		off: number[];
		minRange: number;
	},
	occ: Uint8Array,
	list: L[],
) {
	const img = await loadImage(
		fs.readFileSync(path.join(ROOT, `public/photos/${id}.jpg`)),
	);
	const W = 900;
	const H = Math.round((W * img.height) / img.width);
	const c = createCanvas(W, H);
	const x = c.getContext("2d");
	x.drawImage(img, 0, 0, W, H);
	const cw = W / g.GW;
	const ch = H / g.GH;
	for (let j = 0; j < g.GH; j++)
		for (let i = 0; i < g.GW; i++) {
			const k = j * g.GW + i;
			if (!(g.range[k] > g.minRange) || g.off[k]) continue;
			x.fillStyle = occ[k] ? "rgba(255,0,255,0.45)" : "rgba(255,0,0,0.10)";
			x.fillRect(i * cw, j * ch, cw + 0.5, ch + 0.5);
		}
	x.lineWidth = 2;
	x.strokeStyle = "yellow";
	for (const l of list) {
		x.setLineDash(l.unsure ? [6, 4] : []);
		x.beginPath();
		const pts = l.box
			? [
					[l.box[0], l.box[1]],
					[l.box[2], l.box[1]],
					[l.box[2], l.box[3]],
					[l.box[0], l.box[3]],
				]
			: (l.poly as number[][]);
		pts.forEach(([px, py], n) =>
			n ? x.lineTo(px * W, py * H) : x.moveTo(px * W, py * H),
		);
		x.closePath();
		x.stroke();
	}
	const dir = path.join(ROOT, "out/concord/occl/viz");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${renderer}-${id}.jpg`),
		await c.encode("jpeg", 80),
	);
}

const t0 = performance.now();
for (const [id, list] of Object.entries(labels.photos)) {
	if (split[id] !== "dev") continue; // holdout photos: never read
	const f = path.join(SMEAR, `grid-${renderer}-${id}.json.gz`);
	if (!fs.existsSync(f)) continue;
	const g = JSON.parse(gunzipSync(fs.readFileSync(f)).toString("utf8"));
	const G = gt[id];
	const { GW, GH, range, off, on, minRange } = g;
	const gated = !g.hasScene || g.forced;
	let dsm: NearDsm | null = null;
	if (inSwissExtent(G.lat, G.lon))
		dsm = await loadNearDsm(G.lat, G.lon, radius, 2, {
			fetcher: cachedRangeFetcher,
			json: cachedJsonFetcher,
			dtmRes,
			wedge: useWedge ? wedgeOf(G as never) : undefined,
			maxTiles,
			maxBytes,
		});
	const cam = gtCam(id);
	cam.aspect = g.aspect;
	let eyeZ = Number.NaN;
	const check: number[] = [];
	const occ = new Uint8Array(GW * GH);
	if (dsm) {
		const ground = nearHeightAt(dsm, "dtm", 0, 0);
		eyeZ = eyeAltitudeOver(G.gpsAltitude ?? G.eye, ground);
		const eye = [0, 0, eyeZ] as [number, number, number];
		for (let j = 0; j < GH; j++)
			for (let i = 0; i < GW; i++) {
				const k = j * GW + i;
				const r = range[k];
				if (!(r > minRange)) continue;
				const dir = unprojectDirX(cam, (i + 0.5) / GW, (j + 0.5) / GH);
				const h = objectHitRange(dsm, eye, dir, r, { minObjM, nearSkipM });
				if (occludedBy(r, h)) occ[k] = 1;
				if (r < 1500 && i % 4 === 0 && j % 4 === 0) {
					const t = dtmHit(dsm, eye, dir, 2 * r + 200);
					if (Number.isFinite(t)) check.push(Math.abs(t - r) / r);
				}
			}
	}
	check.sort((a, b) => a - b);
	if (process.argv.includes("--viz")) await viz(id, g, occ, list);
	const boxes = list.map(bbox);
	const pp: Record<string, Acc> = {};
	const ppColl: Record<string, { draped: number; removed: number }> = {};
	for (let j = 0; j < GH; j++)
		for (let i = 0; i < GW; i++) {
			const k = j * GW + i;
			const x = (i + 0.5) / GW;
			const y = (j + 0.5) / GH;
			let hit: L | null = null;
			for (let t = 0; t < list.length; t++) {
				const b = boxes[t];
				if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
				if (!inShape(list[t], x, y)) continue;
				if (!hit || (list[t].cls === "person" && hit.cls !== "person"))
					hit = list[t];
			}
			const draped = range[k] > minRange;
			const o = occ[k] === 1;
			const s: Record<V, boolean> = {
				off: draped && !off[k],
				occl: draped && !off[k] && !o,
				"onProd+occl": draped && !(gated ? off[k] : on[k]) && !o,
				onForced: draped && !on[k],
				"onForced+occl": draped && !on[k] && !o,
			};
			if (hit) {
				const a: Partial<Acc> = { lab: 1 };
				for (const v of VARIANTS) a[v] = s[v] ? 1 : 0;
				for (const key of [hit.cls, hit.cls === "person" ? "" : "non-person"]) {
					if (!key) continue;
					addTo((pooledAll[key] ??= zero()), a);
					if (!hit.unsure) {
						addTo((pooledSure[key] ??= zero()), a);
						addTo((pp[key] ??= zero()), a);
					}
				}
				continue;
			}
			let nearLabel = false;
			for (const b of boxes)
				if (
					x > b[0] - BAND &&
					x < b[2] + BAND &&
					y > b[1] - BAND * (GW / GH) &&
					y < b[3] + BAND * (GW / GH)
				) {
					nearLabel = true;
					break;
				}
			if (nearLabel || !s.off) continue;
			for (const v of VARIANTS) {
				coll[v].draped++;
				(ppColl[v] ??= { draped: 0, removed: 0 }).draped++;
				if (!s[v]) {
					coll[v].removed++;
					ppColl[v].removed++;
				}
			}
		}
	perPhoto[id] = {
		gated,
		dsm: dsm
			? {
					tiles: dsm.stats.tiles,
					MB: +((dsm.stats.bytes + dsm.stats.stacBytes) / 1e6).toFixed(2),
					years: dsm.years,
					eyeZ: +eyeZ.toFixed(1),
					gtEye: G.eye,
					dtmCheck: {
						n: check.length,
						medRel: +(check[check.length >> 1] ?? Number.NaN).toFixed(3),
						p90Rel: +(
							check[Math.floor(check.length * 0.9)] ?? Number.NaN
						).toFixed(3),
					},
				}
			: null,
		sure: pp,
		collateral: Object.fromEntries(
			Object.entries(ppColl).map(([v, c]) => [
				v,
				+(c.removed / Math.max(1, c.draped)).toFixed(4),
			]),
		),
	};
}

const rem = (a: Acc | undefined, v: V) =>
	a && a.off ? (a.off - a[v]) / a.off : Number.NaN;
const pct = (x: number) =>
	Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "  -  ";
const lines: string[] = [];
const p = (s: string) => {
	lines.push(s);
	console.log(s);
};
p(
	`renderer=${renderer} dtm=${dtmRes}m radius=${radius} wedge=${useWedge} maxTiles=${maxTiles ?? "-"} maxBytes=${maxBytes ?? "4.5e6(default)"} minObj=${minObjM} nearSkip=${nearSkipM}  (DEV photos only)`,
);
p("removal of smear vs classic drape (off), confident labels, pooled cells");
p(
	`${"class".padEnd(11)}${"smearOff".padStart(9)}  ${VARIANTS.slice(1)
		.map((v) => v.padStart(14))
		.join("")}`,
);
for (const c of [
	"person",
	"building",
	"tree",
	"pole",
	"structure",
	"vehicle",
	"animal",
	"rock",
	"non-person",
]) {
	const a = pooledSure[c];
	if (!a) continue;
	p(
		`${c.padEnd(11)}${String(a.off).padStart(9)}  ${VARIANTS.slice(1)
			.map((v) => pct(rem(a, v)).padStart(14))
			.join("")}`,
	);
}
const pb = zero();
for (const c of ["person", "building"])
	if (pooledSure[c]) addTo(pb, pooledSure[c]);
const bt = zero();
for (const c of ["building", "tree"])
	if (pooledSure[c]) addTo(bt, pooledSure[c]);
p(
	`${"pers+bldg".padEnd(11)}${String(pb.off).padStart(9)}  ${VARIANTS.slice(1)
		.map((v) => pct(rem(pb, v)).padStart(14))
		.join("")}`,
);
p(
	`${"bldg+tree".padEnd(11)}${String(bt.off).padStart(9)}  ${VARIANTS.slice(1)
		.map((v) => pct(rem(bt, v)).padStart(14))
		.join("")}`,
);
const npAll = pooledAll["non-person"];
p(
	`all labels incl. unsure, non-person: smearOff ${npAll?.off}  ${VARIANTS.slice(
		1,
	)
		.map((v) => `${v} ${pct(rem(npAll, v))}`)
		.join("  ")}`,
);
p(
	`collateral (unlabelled draped cells > ${BAND} from labels, now masked): ${VARIANTS.slice(
		1,
	)
		.map((v) => `${v} ${pct(coll[v].removed / Math.max(1, coll[v].draped))}`)
		.join("  ")}  [n=${coll.off.draped}]`,
);
p(
	"per photo (confident; non-person smearOff → removal occl / onProd+occl; collateral occl; DTM check)",
);
for (const [id, v] of Object.entries(perPhoto) as [string, never][]) {
	const pv = v as {
		gated: boolean;
		dsm: {
			MB: number;
			years: unknown;
			eyeZ: number;
			gtEye: number;
			dtmCheck: { n: number; medRel: number; p90Rel: number };
		} | null;
		sure: Record<string, Acc>;
		collateral: Record<string, number>;
	};
	const np = pv.sure["non-person"];
	p(
		`${id} gated=${pv.gated ? 1 : 0} ${pv.dsm ? `eye ${pv.dsm.eyeZ} (gt ${pv.dsm.gtEye}) dtmCheck med ${pv.dsm.dtmCheck.medRel} p90 ${pv.dsm.dtmCheck.p90Rel} n=${pv.dsm.dtmCheck.n}` : "outside CH (no DSM)"} | non-person ${np?.off ?? 0} → ${pct(rem(np, "occl"))} / ${pct(rem(np, "onProd+occl"))} | tree ${pct(rem(pv.sure.tree, "occl"))} bldg ${pct(rem(pv.sure.building, "occl"))} | coll ${pct(pv.collateral.occl ?? Number.NaN)}`,
	);
}
p(
	`time ${((performance.now() - t0) / 1000).toFixed(1)} s; network ${(netStats.bytes / 1e6).toFixed(1)} MB (${netStats.requests} req), cache hits ${netStats.hits}; cache ${(cacheBytes() / 1e6).toFixed(1)} MB`,
);
const out = path.join(ROOT, "out/concord/occl");
fs.mkdirSync(out, { recursive: true });
const tag = `${renderer}-dtm${dtmRes}-r${radius}${useWedge ? "w" : ""}${maxTiles ? `-t${maxTiles}` : ""}${maxBytes !== undefined ? `-b${maxBytes}` : ""}-o${minObjM}-n${nearSkipM}`;
fs.writeFileSync(
	path.join(out, `smear-${tag}.json`),
	JSON.stringify({ pooledSure, pooledAll, coll, perPhoto }, null, 1),
);
fs.writeFileSync(path.join(out, `smear-${tag}.txt`), `${lines.join("\n")}\n`);
