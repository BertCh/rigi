/**
 * WP-C cue dump + acceptance audit (CPU only, no GPU render).
 *
 *   npx tsx tools/concord/cues/dump.mts [--pose gt|app] [--png N] [IMG_xxxx ...]
 *
 * Default photos: the DEV split of tools/concord/pins/PROTOCOL.txt (holdout photos are refused unless
 * CONCORD_HOLDOUT=final). Per photo:
 *   GeomBuffer: CPU ray cast (src/lib/concord/cues/raycast.ts) of the eval scene's Terrarium DEM
 *     (scripts/concord/lib.ts loadScene; same frame/curvature as the eval pins) at the baseline pose.
 *   PhotoEdges: .cache/jpg/1600/<photo>.jpg at long side 1600 (px @1600).
 *   Lakes: cached Overpass water (out/concord/pins/osm/*_water.json, region.ts-style natural=water
 *     query incl. multipolygon relations); level = median DEM inside the polygon (≤ 30 km).
 * Writes out/concord/cues/<pose>/<photo>.json (+ .png audit overlays for the first N photos) and
 * out/concord/cues/<pose>/summary.json; prints the acceptance table.
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
	baselineCam,
	enuOf,
	loadPins,
	loadScene,
	loadSplit,
	median,
	R_EFF,
	type Scene,
	scorePins,
} from "../../../scripts/concord/lib.ts";
import { loadRGBA, ROOT } from "../../../scripts/lib/node-io.ts";
import {
	type CameraX,
	DISTANCE_BANDS,
	distanceBand,
	unprojectDirX,
} from "../../../src/lib/concord/core/index.ts";
import {
	buildGeomBuffer,
	type ExtractResult,
	extractCues,
	focal1600,
	type Lake,
	lakeLevel,
	lakesFromOverpass,
	type MatchedCue,
	photoEdgesFromRGBA,
} from "../../../src/lib/concord/cues/index.ts";
import { destination } from "../../../src/lib/geodesy.ts";

const DEG = Math.PI / 180;
const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
	const i = args.indexOf(k);
	if (i < 0) return d;
	const v = args[i + 1];
	args.splice(i, 2);
	return v;
};
const pose = opt("--pose", "gt") as "gt" | "app";
const nPng = Number(opt("--png", "99"));
const nZoom = Number(opt("--zoom", "5"));
const mirrorPx = opt("--mirror", "");
const tag = opt("--tag", "");
const geomLong = Number(opt("--geom", "800"));
const OUT = path.join(ROOT, "out", "concord", "cues", pose + tag);
fs.mkdirSync(OUT, { recursive: true });

const split = loadSplit();
let photos = args.filter((a) => a.startsWith("IMG_"));
if (!photos.length)
	photos = Object.keys(split)
		.filter((p) => split[p] === "dev")
		.sort();
for (const p of photos)
	if (split[p] !== "dev" && process.env.CONCORD_HOLDOUT !== "final")
		throw new Error(`${p} is a holdout photo; refusing (set CONCORD_HOLDOUT=final)`);

// ---------------------------------------------------------------- scene helpers

function heightFn(s: Scene) {
	return (e: number, n: number, d: number) => {
		const dO = Math.hypot(e, n);
		const az = Math.atan2(e, n) / DEG;
		const p = dO > 0 ? destination(s.lat, s.lon, az, dO) : { lat: s.lat, lon: s.lon };
		return (
			s.terrain.sampleAt(p.lon, p.lat, d) - s.eyeAlt - (dO * dO) / (2 * R_EFF)
		);
	};
}

let osmMemo: unknown[] | undefined;
function osmWater(): unknown[] {
	if (!osmMemo) {
		const dir = path.join(ROOT, "out", "concord", "pins", "osm");
		const seen = new Set<string>();
		osmMemo = [];
		for (const f of fs.readdirSync(dir).filter((f) => f.endsWith("_water.json")))
			for (const e of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).elements) {
				const k = `${e.type}/${e.id}`;
				if (seen.has(k)) continue;
				seen.add(k);
				osmMemo.push(e);
			}
	}
	return osmMemo;
}

function lakesFor(s: Scene): Lake[] {
	const toEN = (lat: number, lon: number): [number, number] => {
		const v = enuOf(s, lat, lon, 0);
		return [v[0], v[1]];
	};
	const lakes = lakesFromOverpass(
		osmWater() as Parameters<typeof lakesFromOverpass>[0],
		toEN,
		{ minAreaM2: 50_000 },
	).filter((l) => l.polygon.some(([e, n]) => Math.hypot(e, n) < 40_000));
	for (const l of lakes) {
		const abs = (e: number, n: number) => {
			const dO = Math.hypot(e, n);
			const p = destination(s.lat, s.lon, Math.atan2(e, n) / DEG, dO);
			return s.terrain.sampleAt(p.lon, p.lat, dO);
		};
		const r = lakeLevel(l, abs, { region: (e, n) => Math.hypot(e, n) < 30_000 });
		l.levelM = r.levelM;
		(l as Lake & { levelIqr?: number }).levelIqr = r.iqrM;
	}
	return lakes.filter((l) => Number.isFinite(l.levelM));
}

// ---------------------------------------------------------------- metrics

type PinRes = ReturnType<typeof scorePins>[number] & { u: number; v: number };
type Norm = { nu: number; nv: number };
const normalOf = (c: MatchedCue): Norm =>
	c.kind === "edge" ? { nu: c.nu, nv: c.nv } : { nu: 0, nv: 1 };

/** Per pin: weighted sign vote of same-band cues (see RESULT.txt). */
function signAgreement(
	pins: PinRes[],
	cues: MatchedCue[],
	aspect: number,
	minComp = 0.5,
) {
	const { W, H } = aspect >= 1 ? { W: 1600, H: 1600 / aspect } : { W: 1600 * aspect, H: 1600 };
	return pins.map((p) => {
		let vote = 0;
		let n = 0;
		const same = cues.filter((c) => distanceBand(c.depthM) === p.band);
		for (const c of same) {
			const { nu, nv } = normalOf(c);
			const a = p.dxPx * nu + p.dyPx * nv;
			if (Math.abs(a) < minComp || Math.abs(c.residualPx) < 0.5) continue;
			const dImg = Math.hypot((c.u - p.u) * W, (c.v - p.v) * H);
			const w = c.conf * Math.exp(-dImg / 400);
			vote += w * Math.sign(a) * Math.sign(c.residualPx);
			n++;
		}
		return {
			id: p.id,
			label: p.label,
			band: p.band,
			px: +p.px.toFixed(2),
			dx: +p.dxPx.toFixed(2),
			dy: +p.dyPx.toFixed(2),
			nSameBand: same.length,
			nPairs: n,
			vote: +vote.toFixed(3),
			agree: n ? vote > 0 : null,
		};
	});
}

// ---------------------------------------------------------------- PNG

const BAND_COL: Record<string, string> = {
	"<0.5km": "#ff4040",
	"0.5-2km": "#ff9a1f",
	"2-5km": "#ffe01f",
	"5-15km": "#3cff5a",
	">15km": "#4ab8ff",
};

async function drawPng(
	file: string,
	jpg: string,
	cam: CameraX,
	r: ExtractResult,
	pins: PinRes[],
) {
	const img = await loadImage(jpg);
	const L = 800;
	const Wd = cam.aspect >= 1 ? L : Math.round(L * cam.aspect);
	const Hd = cam.aspect >= 1 ? Math.round(L / cam.aspect) : L;
	const k = Wd / (cam.aspect >= 1 ? 1600 : 1600 * cam.aspect); // px@1600 → display
	const cv = createCanvas(Wd, Hd + 36);
	const ctx = cv.getContext("2d");
	ctx.fillStyle = "#000";
	ctx.fillRect(0, 0, Wd, Hd + 36);
	ctx.globalAlpha = 0.8;
	ctx.drawImage(img, 0, 0, Wd, Hd);
	ctx.globalAlpha = 1;
	const matched = new Set(r.cues.filter((c) => c.kind === "edge").map((c) => `${c.u},${c.v}`));
	for (const c of r.predicted) {
		if (matched.has(`${c.u},${c.v}`)) continue;
		ctx.fillStyle = "rgba(170,170,170,0.8)";
		ctx.fillRect(c.u * Wd - 1, c.v * Hd - 1, 2, 2);
	}
	for (const c of r.cues) {
		const x = c.u * Wd;
		const y = c.v * Hd;
		if (c.kind === "edge") {
			// predicted point; tick to the observed edge (actual length, not exaggerated)
			const ox = x - c.residualPx * c.nu * k;
			const oy = y - c.residualPx * c.nv * k;
			ctx.strokeStyle = BAND_COL[distanceBand(c.depthM)];
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x, y);
			ctx.lineTo(ox, oy);
			ctx.stroke();
			ctx.fillStyle = BAND_COL[distanceBand(c.depthM)];
			ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
		}
	}
	for (const p of r.water.predicted) {
		ctx.fillStyle = "#00ffff";
		ctx.fillRect(p.u * Wd - 1, p.v * Hd - 1, 2, 2);
	}
	for (const c of r.cues)
		if (c.kind === "level" || c.kind === "shore") {
			ctx.fillStyle = c.kind === "level" ? "#ff00ff" : "#ffffff";
			ctx.fillRect(c.u * Wd - 1, c.v * Hd - 1, 2, 2);
		}
	for (const p of pins) {
		const x = p.u * Wd;
		const y = p.v * Hd;
		ctx.strokeStyle = "#ff40ff";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.arc(x, y, 5, 0, 2 * Math.PI);
		ctx.stroke();
		ctx.beginPath();
		ctx.moveTo(x, y);
		ctx.lineTo(x + p.dxPx * k, y + p.dyPx * k);
		ctx.stroke();
	}
	ctx.fillStyle = "#fff";
	ctx.font = "11px sans-serif";
	ctx.fillText(
		`${path.basename(file, ".png")} (${pose})  contour cues: dot=predicted, tick→observed edge (true length), colour=band <0.5 red, 0.5-2 orange, 2-5 yellow, 5-15 green, >15 blue; grey=unmatched`,
		4,
		Hd + 14,
	);
	ctx.fillText(
		"cyan=predicted waterline, magenta=observed (level), white=observed (shore); pink circle=pin (observed) with line to predicted",
		4,
		Hd + 29,
	);
	fs.writeFileSync(file, cv.toBuffer("image/png"));
}

/** 1:1 panel at the 1600 basis around the kept cues (height ≤ 480 px), for the visual false-cue audit. */
async function drawZoom(file: string, jpg: string, cam: CameraX, r: ExtractResult) {
	if (!r.cues.length) return;
	const img = await loadImage(jpg);
	const W = cam.aspect >= 1 ? 1600 : Math.round(1600 * cam.aspect);
	const H = cam.aspect >= 1 ? Math.round(1600 / cam.aspect) : 1600;
	const vs = r.cues.map((c) => c.v * H).sort((a, b) => a - b);
	const vMed = vs[vs.length >> 1];
	const y0 = Math.max(0, Math.min(H - 480, Math.round(vMed - 240)));
	const hh = Math.min(480, H);
	const cv = createCanvas(W, hh);
	const ctx = cv.getContext("2d");
	ctx.drawImage(img, 0, (y0 / H) * img.height, img.width, (hh / H) * img.height, 0, 0, W, hh);
	for (const c of r.predicted) {
		ctx.fillStyle = "rgba(200,200,200,0.9)";
		ctx.fillRect(c.u * W - 0.5, c.v * H - y0 - 0.5, 1, 1);
	}
	for (const c of r.water.predicted) {
		ctx.fillStyle = "#00ffff";
		ctx.fillRect(c.u * W - 0.5, c.v * H - y0 - 0.5, 1.5, 1.5);
	}
	for (const c of r.cues) {
		const x = c.u * W;
		const y = c.v * H - y0;
		const [nu, nv] = c.kind === "edge" ? [c.nu, c.nv] : [0, 1];
		const col = c.kind === "edge" ? BAND_COL[distanceBand(c.depthM)] : c.kind === "level" ? "#ff00ff" : "#ffffff";
		// observed position: predicted − residual·n (for water cues u,v is already the observed pixel)
		const [ox, oy] = c.kind === "edge" ? [x - c.residualPx * nu, y - c.residualPx * nv] : [x, y];
		ctx.strokeStyle = col;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(ox - 3 * nv, oy + 3 * nu);
		ctx.lineTo(ox + 3 * nv, oy - 3 * nu);
		ctx.stroke();
	}
	fs.writeFileSync(file, cv.toBuffer("image/png"));
}

// ---------------------------------------------------------------- main

const CP = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "control-points.json"), "utf8"));
const summary: Record<string, unknown> = {};
const allAgree: ReturnType<typeof signAgreement> = [];
const allAgree2: ReturnType<typeof signAgreement> = [];
const waterChecks: unknown[] = [];
const cueResAll: { band: string; r: number; kind: string }[] = [];

for (const [pi, photo] of photos.entries()) {
	const t0 = Date.now();
	const s = await loadScene(photo);
	const cam = await baselineCam(photo, pose);
	const gw = cam.aspect >= 1 ? geomLong : Math.round(geomLong * cam.aspect);
	const gh = Math.round(gw / cam.aspect);
	const geom = buildGeomBuffer(cam, gw, gh, heightFn(s), {
		frame: { alt0: s.eyeAlt, rEff: R_EFF },
	});
	const jpg = path.join(ROOT, ".cache", "jpg", "1600", `${photo}.jpg`);
	const ew = cam.aspect >= 1 ? 1600 : Math.round(1600 * cam.aspect);
	const rgba = await loadRGBA(jpg, ew);
	const edges = photoEdgesFromRGBA(rgba.data, rgba.width, rgba.height);
	const lakes = lakesFor(s);
	const r = extractCues(
		{ geom, cam, edges, lakes },
		mirrorPx ? { water: { mirrorHalfPx: Number(mirrorPx) } } : {},
	);
	const pins = await loadPins({ photos: [photo], split: "dev" });
	const res = scorePins(cam, pins).map((q, i) => ({
		...q,
		u: pins[i].x / 1600,
		v: (pins[i].y * cam.aspect) / 1600,
	}));
	const agree = signAgreement(
		res.filter((q) => !q.behind),
		r.cues,
		cam.aspect,
	);
	allAgree.push(...agree);
	const pinsOk = res.filter((q) => !q.behind);
	allAgree2.push(...signAgreement(pinsOk, r.cues, cam.aspect, 2));
	for (const c of r.cues)
		cueResAll.push({ band: distanceBand(c.depthM), r: c.residualPx, kind: c.kind });

	// waterline vs hand level pins (control-points "level": true)
	const fPx = focal1600(cam);
	const elOf = (u: number, v: number) => {
		const d = unprojectDirX(cam, u, v);
		return Math.asin(Math.max(-1, Math.min(1, d[2]))) / DEG;
	};
	const cp = CP[photo]?.points ?? [];
	const sc = 1600 / (CP[photo]?.basis ?? 1600);
	for (const sp of cp) {
		if (!sp.level) continue;
		const pu = (sp.x * sc) / 1600;
		const pv = (sp.y * sc * cam.aspect) / 1600;
		const wc = r.cues
			.filter((c) => c.kind === "level" || c.kind === "shore")
			.sort((a, b) => Math.abs(a.u - pu) - Math.abs(b.u - pu));
		const near = wc.filter((c) => Math.abs(c.u - pu) < 0.03);
		const pred = r.water.predicted
			.slice()
			.sort((a, b) => Math.abs(a.u - pu) - Math.abs(b.u - pu))[0];
		const c = near[0] as (MatchedCue & { predV: number; world: number[] }) | undefined;
		const lvl = c
			? Math.atan2(c.world[2] - geom.eye![2], c.depthM) / DEG
			: Number.NaN;
		// observed waterline interpolated at the pin column: LSQ line v(u) through the unique-column
		// water cues within ±120 px @1600
		const loc = wc
			.filter((q, i, a) => Math.abs(q.u - pu) * 1600 <= 120 && a.findIndex((z) => z.u === q.u) === i);
		let fit: Record<string, number> | null = null;
		if (loc.length >= 2) {
			const n = loc.length;
			const mu = loc.reduce((a, q) => a + q.u, 0) / n;
			const mv = loc.reduce((a, q) => a + q.v, 0) / n;
			let sxy = 0;
			let sxx = 0;
			for (const q of loc) {
				sxy += (q.u - mu) * (q.v - mv);
				sxx += (q.u - mu) ** 2;
			}
			const vf = mv + (sxx > 0 ? sxy / sxx : 0) * (pu - mu);
			fit = {
				n,
				observedEl: +elOf(pu, vf).toFixed(4),
				dObservedVsPinPixelDeg: +(elOf(pu, vf) - elOf(pu, pv)).toFixed(4),
				dPx: +((vf - pv) * (1600 / cam.aspect)).toFixed(2),
			};
		}
		waterChecks.push({
			photo,
			pin: sp.label,
			fit,
			predictedAtPin: pred
				? {
						el: +elOf(pu, pred.v).toFixed(4),
						dVsPinPixelDeg: +(elOf(pu, pred.v) - elOf(pu, pv)).toFixed(4),
					}
				: null,
			pinEl: sp.el,
			pinPixelEl: +elOf(pu, pv).toFixed(4),
			cue: c
				? {
						kind: c.kind,
						du: +((c.u - pu) * 1600).toFixed(1),
						shoreDistM: Math.round(c.depthM),
						targetEl: +lvl.toFixed(4),
						observedEl: +elOf(c.u, c.v).toFixed(4),
						predictedEl: +elOf(c.u, c.predV).toFixed(4),
						conf: +c.conf.toFixed(2),
						dTargetVsPinDeg: +(lvl - sp.el).toFixed(4),
						dObservedVsPinPixelDeg: +(elOf(c.u, c.v) - elOf(pu, pv)).toFixed(4),
					}
				: null,
			nearestPredicted: pred
				? { du: +((pred.u - pu) * 1600).toFixed(1), d: Math.round(pred.d) }
				: null,
			fPx: +fPx.toFixed(1),
		});
	}

	const byBand = Object.fromEntries(
		DISTANCE_BANDS.map((b) => {
			const cs = r.cues.filter((c) => distanceBand(c.depthM) === b);
			return [
				b,
				{
					n: cs.length,
					medRes: +median(cs.map((c) => c.residualPx)).toFixed(2),
					medAbs: +median(cs.map((c) => Math.abs(c.residualPx))).toFixed(2),
				},
			];
		}),
	);
	const out = {
		photo,
		pose,
		geom: { w: gw, h: gh, ...geom.stats },
		lakes: lakes.map((l) => ({
			name: l.name,
			levelM: +l.levelM.toFixed(2),
			iqrM: +((l as Lake & { levelIqr?: number }).levelIqr ?? 0).toFixed(2),
		})),
		stats: r.stats,
		waterPolarity: r.water.polarity,
		waterPredicted: r.water.predicted.length,
		byBand,
		signAgreement: agree,
		cues: r.cues.map((c) => ({
			kind: c.kind,
			u: +c.u.toFixed(5),
			v: +c.v.toFixed(5),
			...(c.kind === "edge" ? { nu: +c.nu.toFixed(3), nv: +c.nv.toFixed(3) } : {}),
			...(c.kind === "level" ? { el: +c.el.toFixed(4) } : {}),
			depthM: Math.round(c.depthM),
			residualPx: +c.residualPx.toFixed(2),
			conf: +c.conf.toFixed(2),
			sigmaPx: +c.sigmaPx.toFixed(2),
		})),
		ms: Date.now() - t0,
	};
	fs.writeFileSync(path.join(OUT, `${photo}.json`), JSON.stringify(out));
	summary[photo] = { ...out, cues: undefined, signAgreement: undefined };
	if (pi < nPng) await drawPng(path.join(OUT, `${photo}.png`), jpg, cam, r, res);
	if (pi < nZoom) await drawZoom(path.join(OUT, `${photo}_zoom.png`), jpg, cam, r);
	console.log(
		`${photo}: geom ${gw}×${gh} (${geom.stats.ms} ms), contours ${r.stats.predicted} → matched ${r.stats.matched} → kept ${r.stats.kept}; water ${r.stats.water} (pol ${r.water.polarity}, lakes ${lakes.map((l) => `${l.name}@${l.levelM.toFixed(1)}`).join(",") || "-"}); pins ${res.length}; ${Date.now() - t0} ms`,
	);
	console.log(
		`   cue bands: ${DISTANCE_BANDS.map((b) => `${b} n=${byBand[b].n} med=${byBand[b].medRes} |med|=${byBand[b].medAbs}`).join("; ")}`,
	);
}

const decided = allAgree.filter((a) => a.agree !== null);
const agreeN = decided.filter((a) => a.agree).length;
console.log(
	`\nSIGN AGREEMENT (${pose} pose, dev pins): ${agreeN}/${decided.length} = ${((100 * agreeN) / Math.max(1, decided.length)).toFixed(1)}% (pins without same-band cue pairs: ${allAgree.length - decided.length}/${allAgree.length})`,
);
for (const b of DISTANCE_BANDS) {
	const d = decided.filter((a) => a.band === b);
	if (d.length) console.log(`   ${b}: ${d.filter((a) => a.agree).length}/${d.length}`);
}
const rate = (xs: typeof allAgree) => {
	const d = xs.filter((a) => a.agree !== null);
	return `${d.filter((a) => a.agree).length}/${d.length}`;
};
console.log(
	`   sensitivity: pins within the cue search range (|pin| ≤ 24 px): ${rate(allAgree.filter((a) => a.px <= 24))}; pin component along cue normal ≥ 2 px: ${rate(allAgree2)}; both: ${rate(allAgree2.filter((a) => a.px <= 24))}`,
);
console.log("\nWATERLINE vs hand level pins:");
for (const w of waterChecks) console.log("  ", JSON.stringify(w));
const allCueBands = Object.fromEntries(
	DISTANCE_BANDS.map((b) => {
		const rs = cueResAll.filter((c) => c.band === b).map((c) => c.r);
		return [b, { n: rs.length, med: +median(rs).toFixed(2), medAbs: +median(rs.map(Math.abs)).toFixed(2) }];
	}),
);
console.log("\nALL CUES by band:", JSON.stringify(allCueBands));
fs.writeFileSync(
	path.join(OUT, "summary.json"),
	JSON.stringify(
		{
			pose,
			photos,
			signAgreement: {
				agree: agreeN,
				decided: decided.length,
				total: allAgree.length,
				inRange: rate(allAgree.filter((a) => a.px <= 24)),
				comp2px: rate(allAgree2),
				comp2pxInRange: rate(allAgree2.filter((a) => a.px <= 24)),
				pins: allAgree,
			},
			waterChecks,
			allCueBands,
			perPhoto: summary,
		},
		null,
		1,
	),
);
