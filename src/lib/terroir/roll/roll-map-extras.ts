// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Extra deck layers for the roll 3D map (terroir T0.6/T0.8/T0.9/T2.8), added through the engine's
// setExtraLayers hook so roll-map.ts needs no layer code of its own:
//   - camera halos (soft rings in pixels, so the cameras are findable at overview zoom)
//   - prior-pose uncertainty: a dashed dark overlay on the EXIF-only frustums + a widened ±10° fan
//   - place names (TextLayer, billboarded, pixel sizes) with greedy priority collision filtering
// Display-only. Layers draw before the engine's pins and never pick.
import { COORDINATE_SYSTEM } from "@deck.gl/core";
import {
	PathLayer,
	PolygonLayer,
	ScatterplotLayer,
	TextLayer,
} from "@deck.gl/layers";
import { LogDepthExtension } from "#/lib/deck/world-view";
import type { Vec3 } from "#/lib/ontology/core/geometry";
import { loadRegion, type RegionPeak } from "#/lib/photos";
import { poseBasis } from "#/lib/pose";
import type { RollMapEngine } from "../../roll/map/roll-map";
import { viewpointColor } from "../../roll/map/roll-map";
import { hfovOf } from "../../roll/roll";
import type { Roll } from "../../roll/types";
import { NAME_TYPO, peakTier } from "../classes";
import { findPack, packCredit } from "../pack";
import type { NameClass, TerroirName } from "../types";
import { isUncertainPose, PRIOR_FAN_DEG } from "./logic";

const DEPTH_OFF = { depthCompare: "always", depthWriteEnabled: false } as const;
const BASE_PX = 13;
/** Never draw a label smaller than this (drop it instead of shrinking). */
const MIN_PX = 11;
const MAX_LABELS = 25;
/** Tighter camera-distance reach (m) for the small classes, on top of NAME_TYPO.nearReachM. */
const REACH_M: Partial<Record<NameClass, number>> = {
	"peak-minor": 5000,
	village: 9000,
	hut: 7000,
	pass: 12000,
	glacier: 30000,
};
/** Score boost so lakes and towns win collisions and the cap. */
const BOOST: Partial<Record<NameClass, number>> = {
	lake: 60,
	city: 60,
	town: 40,
};
/** Name classes shown on the roll map (pack names; peaks also come from the roll's region). */
const SHOWN: ReadonlySet<NameClass> = new Set<NameClass>([
	"peak-major",
	"peak",
	"peak-minor",
	"lake",
	"city",
	"town",
	"village",
	"pass",
	"hut",
	"glacier",
	"massif",
	"region",
]);
const SANS = "Inter, ui-sans-serif, system-ui, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";

type Cand = {
	text: string;
	cls: NameClass;
	lat: number;
	lon: number;
	ele: number | null;
};

export type ExtrasOptions = {
	names: boolean;
	/** Hide halos and fans (the camera is inside a photographer's viewpoint). */
	inView: boolean;
	visibleIds: ReadonlySet<string> | null;
	onBearing?: (deg: number) => void;
	onCredit?: (credit: string | null) => void;
};

const upperSpaced = (s: string, tracking: number) =>
	tracking >= 0.1 ? [...s.toUpperCase()].join(" ") : s.toUpperCase();

function dashed(a: Vec3, b: Vec3, dash: number): Vec3[][] {
	const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
	const n = Math.max(1, Math.floor(len / (2 * dash)));
	const out: Vec3[][] = [];
	for (let i = 0; i < n; i++) {
		const t0 = (i * 2 * dash) / len;
		const t1 = Math.min(1, ((i * 2 + 1) * dash) / len);
		const at = (t: number): Vec3 => [
			a[0] + (b[0] - a[0]) * t,
			a[1] + (b[1] - a[1]) * t,
			a[2] + (b[2] - a[2]) * t,
		];
		out.push([at(t0), at(t1)]);
	}
	return out;
}

/** The deck layer extensions for a roll map backend: log depth on WebGL2, none on WebGPU (no WGSL hooks). */
export function layerExtensions(kind: "webgl" | "webgpu") {
	return kind === "webgl" ? [new LogDepthExtension()] : [];
}

export class RollMapExtras {
	private opts: ExtrasOptions;
	private cands: Cand[] = [];
	private timer = 0;
	private disposed = false;
	private camKey = "";
	private camsKey = "";
	private lastNames = 0;
	private z = new Map<string, number>();
	private bearing = Number.NaN;

	constructor(
		private engine: RollMapEngine,
		private roll: Roll,
		opts: ExtrasOptions,
	) {
		this.opts = opts;
		void this.loadNames();
		this.timer = window.setInterval(() => this.tick(), 200);
	}

	setOptions(o: Partial<ExtrasOptions>) {
		Object.assign(this.opts, o);
		this.camKey = "";
		this.camsKey = "";
		this.tick();
	}

	dispose() {
		this.disposed = true;
		window.clearInterval(this.timer);
		for (const k of ["terroir-cams", "terroir-names"])
			this.engine.setExtraLayers(k, null);
	}

	private async loadNames() {
		const [pack, region] = await Promise.all([
			findPack(this.roll.center.lat, this.roll.center.lon).catch(() => null),
			this.roll.region
				? loadRegion(this.roll.region).catch(() => null)
				: Promise.resolve(null),
		]);
		if (this.disposed) return;
		const out: Cand[] = [];
		const peaks: RegionPeak[] = region?.peaks ?? [];
		for (const p of peaks)
			if (p.name)
				out.push({
					text: p.name,
					cls: peakTier(p.prominence, p.ele),
					lat: p.lat,
					lon: p.lon,
					ele: p.ele,
				});
		const near = (a: Cand, b: TerroirName) =>
			a.text.toLowerCase() === b.name.toLowerCase() &&
			Math.hypot((a.lat - b.lat) * 111_000, (a.lon - b.lon) * 76_000) < 600;
		for (const n of pack?.names ?? []) {
			if (!SHOWN.has(n.cls)) continue;
			if (out.some((c) => near(c, n))) continue;
			out.push({
				text: n.name,
				cls: n.cls,
				lat: n.lat,
				lon: n.lon,
				ele: n.ele,
			});
		}
		this.cands = out;
		this.camKey = "";
		this.opts.onCredit?.(pack && out.length ? packCredit(pack) : null);
		this.tick();
	}

	private tick() {
		if (this.disposed) return;
		const cam = this.engine.world.cam;
		const tgt = this.engine.world.controls?.target;
		if (tgt) {
			const b =
				((Math.atan2(tgt.x - cam.position.x, tgt.y - cam.position.y) * 180) /
					Math.PI +
					360) %
				360;
			if (!(Math.abs(b - this.bearing) < 0.5)) {
				this.bearing = b;
				this.opts.onBearing?.(b);
			}
		}
		const q = cam.quaternion;
		const key = [
			Math.round(cam.position.x / 4),
			Math.round(cam.position.y / 4),
			Math.round(cam.position.z / 4),
			q.x.toFixed(3),
			q.y.toFixed(3),
			q.z.toFixed(3),
			this.opts.names,
			this.cands.length,
		].join("|");
		const now = performance.now();
		// heights stream in: redo the names every 2 s for a while even when the camera is still
		const stale =
			this.opts.names &&
			now - this.lastNames > 2000 &&
			this.z.size < this.cands.length;
		if (key !== this.camKey || stale) {
			this.camKey = key;
			this.lastNames = now;
			this.buildNames();
		}
		this.buildCameras();
	}

	/** LogDepthExtension is a GLSL shader hook: WebGL2 only. The layers draw with depth off anyway. */
	private depthExtensions() {
		return layerExtensions(this.engine.backendKind);
	}

	// ---------------- cameras: halo + prior uncertainty ----------------

	private buildCameras() {
		const placed = this.engine.debugPlaced();
		const vis = this.opts.visibleIds;
		const byId = new Map(this.roll.photos.map((p) => [p.meta.id, p]));
		const rows = placed
			.map((p) => ({ ...p, photo: byId.get(p.id) }))
			.filter((p) => p.photo && (!vis || vis.has(p.id)));
		const key = `${this.opts.inView}|${rows
			.map(
				(r) =>
					`${r.id}:${r.eye.map(Math.round).join(",")}:${r.pose.yaw.toFixed(1)}:${r.photo?.poseSource}`,
			)
			.join(";")}`;
		if (key === this.camsKey) return;
		this.camsKey = key;
		if (!rows.length || this.opts.inView) {
			this.engine.setExtraLayers("terroir-cams", null);
			return;
		}
		const common = {
			coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
			extensions: this.depthExtensions(),
			parameters: DEPTH_OFF,
			pickable: false,
		};
		const layers: unknown[] = [
			new ScatterplotLayer({
				...common,
				id: "terroir-halo",
				data: rows,
				getPosition: (r: (typeof rows)[number]) => r.eye,
				radiusUnits: "pixels",
				getRadius: 15,
				getFillColor: (r: (typeof rows)[number]) => [
					...viewpointColor(r.photo?.viewpoint ?? 0),
					48,
				],
				stroked: true,
				lineWidthUnits: "pixels",
				getLineWidth: 1.5,
				getLineColor: [255, 255, 255, 120],
				billboard: true,
			}),
		];
		const priors = rows.filter(
			(r) => r.photo && isUncertainPose(r.photo.poseSource),
		);
		if (priors.length) {
			const fans: { polygon: Vec3[]; col: Vec3 }[] = [];
			const dashes: { path: Vec3[] }[] = [];
			for (const r of priors) {
				const aspect = r.photo ? r.photo.meta.width / r.photo.meta.height : 1.5;
				const hf = hfovOf(r.pose, aspect);
				const half = hf / 2 + PRIOR_FAN_DEG;
				const L = 320;
				const pt = (yaw: number): Vec3 => [
					r.eye[0] + L * Math.sin((yaw * Math.PI) / 180),
					r.eye[1] + L * Math.cos((yaw * Math.PI) / 180),
					r.eye[2],
				];
				const poly: Vec3[] = [r.eye];
				for (let k = 0; k <= 12; k++)
					poly.push(pt(r.pose.yaw - half + (2 * half * k) / 12));
				fans.push({
					polygon: poly,
					col: viewpointColor(r.photo?.viewpoint ?? 0),
				});
				// dark dashes laid over the frustum edges: coloured / dark alternating = "dashed"
				const { forward, right, up } = poseBasis(r.pose);
				const dist = 150;
				const hh = Math.tan((r.pose.vfov * Math.PI) / 360) * dist;
				const hw = hh * aspect;
				const corner = (sx: number, sy: number): Vec3 => [
					r.eye[0] + forward.x * dist + right.x * sx * hw + up.x * sy * hh,
					r.eye[1] + forward.y * dist + right.y * sx * hw + up.y * sy * hh,
					r.eye[2] + forward.z * dist + right.z * sx * hw + up.z * sy * hh,
				];
				const [tl, tr, br, bl] = [
					corner(-1, 1),
					corner(1, 1),
					corner(1, -1),
					corner(-1, -1),
				];
				for (const [a, b] of [
					[r.eye, tl],
					[r.eye, tr],
					[r.eye, br],
					[r.eye, bl],
					[tl, tr],
					[tr, br],
					[br, bl],
					[bl, tl],
				] as [Vec3, Vec3][])
					for (const d of dashed(a, b, 5)) dashes.push({ path: d });
			}
			layers.push(
				new PolygonLayer({
					...common,
					id: "terroir-prior-fan",
					data: fans,
					getPolygon: (d: (typeof fans)[number]) => d.polygon,
					getFillColor: (d: (typeof fans)[number]) => [...d.col, 34],
					filled: true,
					stroked: false,
				}),
				new PathLayer({
					...common,
					id: "terroir-prior-dash",
					data: dashes,
					getPath: (d: (typeof dashes)[number]) => d.path,
					getColor: [14, 16, 18, 210],
					getWidth: 1.6,
					widthUnits: "pixels",
				}),
			);
		}
		this.engine.setExtraLayers("terroir-cams", layers);
	}

	// ---------------- names ----------------

	private buildNames() {
		if (!this.opts.names || !this.cands.length) {
			this.engine.setExtraLayers("terroir-names", null);
			return;
		}
		// backend-neutral: the engine projects (deck's viewport on WebGL2, the colour pass camera on WebGPU)
		if (!this.engine.project([0, 0, 0])) return;
		const [vw, vh] = this.engine.viewSize;
		const cam = this.engine.world.cam.position;
		const tg = this.engine.world.controls?.target;
		// deck's pixel sizes hold only at the viewport's focal distance (the camera-to-target distance):
		// scale each label by its own distance so it stays the same size on screen
		const focal = tg ? Math.max(1, cam.distanceTo(tg)) : 1;
		const frame = this.engine.frame;
		type Item = {
			c: Cand;
			pos: Vec3;
			sx: number;
			sy: number;
			size: number;
			scale: number;
			score: number;
		};
		const items: Item[] = [];
		for (const c of this.cands) {
			const typo = NAME_TYPO[c.cls];
			let h = this.z.get(`${c.lat},${c.lon}`);
			if (h === undefined) {
				const dem = this.engine.heightAt(c.lat, c.lon);
				const v = c.ele ?? dem;
				if (v == null) continue;
				h = v;
				if (c.ele != null || dem != null) this.z.set(`${c.lat},${c.lon}`, h);
			}
			const e = frame.fromGeo(c.lat, c.lon, h + 6);
			const pos: Vec3 = [e[0], e[1], e[2]];
			const d = Math.hypot(pos[0] - cam.x, pos[1] - cam.y, pos[2] - cam.z);
			if (d > Math.min(typo.nearReachM, REACH_M[c.cls] ?? Infinity)) continue;
			const sp = this.engine.project(pos);
			if (!sp) continue;
			const [sx, sy, sz] = sp;
			if (!(sz < 1) || sx < 0 || sy < 0 || sx > vw || sy > vh) continue;
			items.push({
				c,
				pos,
				sx,
				sy,
				size: Math.max(MIN_PX, Math.round(BASE_PX * typo.size)),
				scale: tg ? d / focal : 1,
				score:
					typo.priority + (BOOST[c.cls] ?? 0) + (c.ele ?? 0) / 1000 - d / 2e4,
			});
		}
		items.sort((a, b) => b.score - a.score);
		const boxes: [number, number, number, number][] = [];
		const kept: Item[] = [];
		const seen = new Set<string>();
		for (const it of items) {
			if (kept.length >= MAX_LABELS) break;
			// one label per name: swissNAMES3D carries a town as both a settlement and a district polygon
			if (seen.has(it.c.text)) continue;
			const w =
				it.c.text.length *
				it.size *
				0.58 *
				(NAME_TYPO[it.c.cls].upper ? 1.3 : 1);
			const x0 = it.sx - w / 2 - 3;
			const x1 = it.sx + w / 2 + 3;
			const y1 = it.sy - 4;
			const y0 = y1 - it.size * 1.25 - 2;
			if (boxes.some((b) => x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]))
				continue;
			boxes.push([x0, y0, x1, y1]);
			seen.add(it.c.text);
			kept.push(it);
		}
		const common = {
			coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
			extensions: this.depthExtensions(),
			parameters: DEPTH_OFF,
			pickable: false,
		};
		const dotted = kept.filter((k) => /^peak|^hut|^pass/.test(k.c.cls));
		this.engine.setExtraLayers("terroir-names", [
			new ScatterplotLayer({
				...common,
				id: "terroir-name-dots",
				data: dotted,
				getPosition: (k: Item) => k.pos,
				radiusUnits: "pixels",
				getRadius: 2.5,
				getFillColor: [255, 255, 255, 235],
				stroked: true,
				lineWidthUnits: "pixels",
				getLineWidth: 1,
				getLineColor: [14, 16, 18, 220],
				billboard: true,
			}),
			new TextLayer({
				...common,
				id: "terroir-names",
				data: kept.filter((k) => !NAME_TYPO[k.c.cls].italic),
				getPosition: (k: Item) => k.pos,
				getText: (k: Item) => {
					const t = NAME_TYPO[k.c.cls];
					return t.upper ? upperSpaced(k.c.text, t.tracking) : k.c.text;
				},
				getSize: (k: Item) => k.size * k.scale,
				sizeUnits: "pixels",
				getColor: (k: Item) => hexRgb(NAME_TYPO[k.c.cls].color),
				fontFamily: SANS,
				fontWeight: 600,
				fontSettings: { sdf: true },
				characterSet: "auto",
				outlineWidth: 3,
				outlineColor: [14, 18, 24, 215],
				billboard: true,
				getTextAnchor: "middle",
				getAlignmentBaseline: "bottom",
				getPixelOffset: [0, -5],
				updateTriggers: {
					getText: key(kept),
					getSize: key(kept),
					getColor: key(kept),
				},
			}),
			// italic classes (water, glaciers): TextLayer has no italics, so they take a serif face
			new TextLayer({
				...common,
				id: "terroir-names-serif",
				data: kept.filter((k) => NAME_TYPO[k.c.cls].italic),
				getPosition: (k: Item) => k.pos,
				getText: (k: Item) => k.c.text,
				getSize: (k: Item) => (k.size + 1) * k.scale,
				sizeUnits: "pixels",
				getColor: (k: Item) => hexRgb(NAME_TYPO[k.c.cls].color),
				fontFamily: SERIF,
				fontSettings: { sdf: true },
				characterSet: "auto",
				outlineWidth: 3,
				outlineColor: [14, 18, 24, 215],
				billboard: true,
				getTextAnchor: "middle",
				getAlignmentBaseline: "bottom",
				getPixelOffset: [0, -5],
				updateTriggers: {
					getText: key(kept),
					getSize: key(kept),
					getColor: key(kept),
				},
			}),
		]);
	}
}

const key = (ks: { c: Cand; scale: number }[]) =>
	ks.map((k) => `${k.c.text}:${k.scale.toFixed(3)}`).join("|");
const hexRgb = (h: string): [number, number, number, number] => [
	Number.parseInt(h.slice(1, 3), 16),
	Number.parseInt(h.slice(3, 5), 16),
	Number.parseInt(h.slice(5, 7), 16),
	255,
];
