// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BRAND, BRAND_LIGHT, brandAlpha } from "#/brand/khipu";
import { DEG } from "#/lib/geodesy";
import type { ResolvedTheme } from "#/lib/theme";
import { useTheme } from "#/lib/theme/react";
import { type Angles, horizonDistAt, R_EFF, type Scene } from "./model";

// The little world: the baked heightfield as ridgelines seen from behind and above the
// photographer, with the camera, its view wedge, the compass uncertainty and the skyline
// footprint (the ridges that form the photo's skyline) drawn on top.

export type WorldState = {
	pose: Angles;
	/** 0..1 opacity of each overlay. */
	uncertainty: number;
	wedge: number;
	footprint: number;
	peaks: number;
	/** Compass half-width of the uncertainty fan, degrees. */
	fan: number;
	/** 0 = camera at the GPS altitude, 1 = snapped to the DEM ground + 1.6 m. */
	eyeSnap: number;
};

const VEX = 1.7;

type Viewer = {
	w: number;
	h: number;
	f: number;
	vz: number;
	vv: number;
	tilt: number;
};

/** (u across, v ahead, z up) in metres relative to the eye → screen px, or null when behind. */
function toScreen(V: Viewer, eye: number, u: number, v: number, z: number) {
	const dv = v - V.vv;
	const dz = (z - eye) * VEX - V.vz;
	const ct = Math.cos(V.tilt);
	const st = Math.sin(V.tilt);
	const depth = dv * ct - dz * st;
	if (depth < 200) return null;
	const up = dv * st + dz * ct;
	return [V.w / 2 + (V.f * u) / depth, V.h * 0.6 - (V.f * up) / depth] as const;
}

const polar = (s: Scene, az: number, d: number) => {
	const a = (az - s.heightfield.yaw) * DEG;
	return [d * Math.sin(a), d * Math.cos(a)] as const;
};

export const WorldView = memo(WorldViewImpl);

function WorldViewImpl({
	scene,
	state,
	className,
}: {
	scene: Scene;
	state: WorldState;
	className?: string;
}) {
	const wrap = useRef<HTMLDivElement>(null);
	const base = useRef<HTMLCanvasElement>(null);
	const over = useRef<HTMLCanvasElement>(null);
	const viewer = useRef<Viewer | null>(null);
	const [size, setSize] = useState(0);
	// The page theme, unless an ancestor island pins one (the Gipfelbuch embeds this scene in a dark island).
	const pageTheme = useTheme().resolved;
	const [theme, setTheme] = useState<ResolvedTheme>(pageTheme);
	useLayoutEffect(() => {
		setTheme(islandTheme(wrap.current, pageTheme));
	}, [pageTheme]);

	// Terrain: drawn once per size.
	useEffect(() => {
		const el = wrap.current;
		const cv = base.current;
		if (!el || !cv) return;
		const draw = () => {
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			const w = el.clientWidth;
			const h = el.clientHeight;
			for (const c of [cv, over.current]) {
				if (!c) continue;
				c.width = Math.round(w * dpr);
				c.height = Math.round(h * dpr);
			}
			const V: Viewer = {
				w,
				h,
				f: w * 0.5,
				vz: 13_000,
				vv: -16_000,
				tilt: 30 * DEG,
			};
			viewer.current = V;
			const g = cv.getContext("2d");
			if (!g) return;
			g.setTransform(dpr, 0, 0, dpr, 0, 0);
			g.clearRect(0, 0, w, h);
			const { u, v0, v1, nu, nv, heights } = scene.heightfield;
			for (let j = nv - 1; j >= 0; j--) {
				const v = v0 + (j / (nv - 1)) * (v1 - v0);
				const near = 1 - j / (nv - 1);
				g.beginPath();
				let first = true;
				let x0 = 0;
				let x1 = 0;
				for (let i = 0; i < nu; i++) {
					const uu = (i / (nu - 1) - 0.5) * u;
					const z = heights[j * nu + i] - (v * v) / (2 * R_EFF);
					const p = toScreen(V, scene.eye, uu, v, z);
					if (!p) continue;
					if (first) {
						g.moveTo(p[0], p[1]);
						x0 = p[0];
						first = false;
					} else g.lineTo(p[0], p[1]);
					x1 = p[0];
				}
				if (first) continue;
				// Close below the row so nearer rows hide farther ones.
				g.lineTo(x1, h + 10);
				g.lineTo(x0, h + 10);
				g.closePath();
				// far rows fade towards the haze: lighter on the dark ground, darker on the light one
				const far = 1 - near;
				g.fillStyle =
					theme === "light"
						? `rgb(${244 - 20 * far},${244 - 17 * far},${244 - 13 * far})`
						: `rgb(${19 + 10 * far},${19 + 14 * far},${19 + 17 * far})`;
				g.fill();
				g.strokeStyle = brandAlpha(
					"paper",
					(theme === "light" ? 0.14 : 0.1) + 0.32 * near,
					theme,
				);
				g.lineWidth = 0.6 + 0.5 * near;
				g.stroke();
			}
			setSize((n) => n + 1);
		};
		draw();
		const ro = new ResizeObserver(draw);
		ro.observe(el);
		return () => ro.disconnect();
	}, [scene, theme]);

	// Overlays: every state change, and again after the canvases are resized (size).
	// biome-ignore lint/correctness/useExhaustiveDependencies: size is the resize trigger
	useEffect(() => {
		const cv = over.current;
		const V = viewer.current;
		if (!cv || !V) return;
		const g = cv.getContext("2d");
		if (!g) return;
		const dpr = cv.width / V.w;
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.clearRect(0, 0, V.w, V.h);
		const ink = (role: "paper" | "trap" | "glow", a: number) =>
			brandAlpha(role, a, theme);
		const solid = theme === "light" ? BRAND_LIGHT : BRAND;
		const eye = scene.eye;
		const at = (u: number, v: number, z: number) => toScreen(V, eye, u, v, z);
		const cam = at(0, 0, eye);
		if (!cam) return;
		const aspect = scene.width / scene.height;
		const hh = Math.atan(Math.tan((state.pose.vfov * DEG) / 2) * aspect) / DEG;
		const R = 30_000;

		const fan = (a0: number, a1: number, fill: string, edge?: string) => {
			g.beginPath();
			g.moveTo(cam[0], cam[1]);
			for (let a = a0; a <= a1 + 1e-6; a += (a1 - a0) / 24) {
				const [u, v] = polar(scene, a, R);
				const p = at(u, v, eye);
				if (p) g.lineTo(p[0], p[1]);
			}
			g.closePath();
			g.fillStyle = fill;
			g.fill();
			if (edge) {
				g.strokeStyle = edge;
				g.lineWidth = 1;
				g.stroke();
			}
		};

		const yaw0 = scene.prior.yaw;
		if (state.uncertainty > 0) {
			g.globalAlpha = state.uncertainty;
			fan(yaw0 - state.fan - hh, yaw0 + state.fan + hh, ink("trap", 0.07));
			g.setLineDash([3, 4]);
			for (const a of [yaw0 - state.fan - hh, yaw0 + state.fan + hh]) {
				const [u, v] = polar(scene, a, R);
				const p = at(u, v, eye);
				if (!p) continue;
				g.beginPath();
				g.moveTo(cam[0], cam[1]);
				g.lineTo(p[0], p[1]);
				g.strokeStyle = ink("trap", 0.55);
				g.stroke();
			}
			g.setLineDash([]);
		}

		if (state.wedge > 0) {
			g.globalAlpha = state.wedge;
			fan(
				state.pose.yaw - hh,
				state.pose.yaw + hh,
				ink("glow", 0.16),
				ink("glow", 0.75),
			);
		}

		// Skyline footprint: where each line of sight in view first grazes the terrain's skyline.
		if (state.footprint > 0) {
			g.globalAlpha = state.footprint;
			let prev: readonly [number, number] | null = null;
			for (let a = state.pose.yaw - hh; a <= state.pose.yaw + hh; a += 0.4) {
				const d = horizonDistAt(scene, a);
				if (!(d > 300)) {
					prev = null;
					continue;
				}
				const [u, v] = polar(scene, a, d);
				const z = groundZ(scene, u, v);
				const p = at(u, v, z + 30);
				if (!p) {
					prev = null;
					continue;
				}
				if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < 22) {
					g.beginPath();
					g.moveTo(prev[0], prev[1]);
					g.lineTo(p[0], p[1]);
					g.strokeStyle = ink("paper", 0.95);
					g.lineWidth = 2;
					g.stroke();
				}
				prev = p;
			}
			// A few sight lines, camera → skyline.
			g.lineWidth = 0.8;
			for (let k = -2; k <= 2; k++) {
				const a = state.pose.yaw + (k / 2.6) * hh;
				const d = horizonDistAt(scene, a);
				if (!(d > 300)) continue;
				const [u, v] = polar(scene, a, d);
				const p = at(u, v, groundZ(scene, u, v) + 30);
				if (!p) continue;
				g.beginPath();
				g.moveTo(cam[0], cam[1]);
				g.lineTo(p[0], p[1]);
				g.strokeStyle = ink("paper", 0.28);
				g.stroke();
			}
		}

		if (state.peaks > 0) {
			g.globalAlpha = state.peaks;
			g.font = "500 10px ui-monospace, SFMono-Regular, Menlo, monospace";
			g.textAlign = "center";
			const pins = scene.peaks
				.map((pk) => {
					const [u, v] = polar(scene, pk.az, pk.dist);
					return { name: pk.name.split(" / ")[0], p: at(u, v, pk.ele) };
				})
				.filter(
					(x): x is { name: string; p: readonly [number, number] } => !!x.p,
				)
				.sort((a, b) => a.p[0] - b.p[0]);
			// Each label takes the lowest of three heights where it overlaps no other; else pin only.
			const boxes: [number, number, number, number][] = [];
			for (const { name, p } of pins) {
				const half = g.measureText(name).width / 2 + 3;
				const row = [0, 1, 2].findIndex((k) => {
					const base = p[1] - 15 - k * 12;
					const r: [number, number, number, number] = [
						p[0] - half,
						base - 10,
						p[0] + half,
						base,
					];
					if (
						boxes.some(
							(o) => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1],
						)
					)
						return false;
					boxes.push(r);
					return true;
				});
				const top = p[1] - 12 - Math.max(0, row) * 12;
				g.strokeStyle = ink("glow", 0.9);
				g.lineWidth = 1;
				g.beginPath();
				g.moveTo(p[0], p[1]);
				g.lineTo(p[0], top);
				g.stroke();
				g.fillStyle = solid.glow;
				g.beginPath();
				g.arc(p[0], p[1], 2.2, 0, Math.PI * 2);
				g.fill();
				if (row < 0) continue;
				g.fillStyle = ink("paper", 0.85);
				g.fillText(name, p[0], top - 3);
			}
		}

		// The camera itself: from the GPS altitude (often inside the mountain) up onto the ground.
		g.globalAlpha = 1;
		const gps = scene.gpsAlt ?? eye;
		const camZ = gps + (eye - gps) * state.eyeSnap;
		const here = at(0, 0, camZ) ?? cam;
		if (Math.abs(eye - gps) > 20) {
			const ghost = at(0, 0, gps);
			if (ghost) {
				g.setLineDash([2, 3]);
				g.strokeStyle = ink("trap", 0.8);
				g.beginPath();
				g.moveTo(ghost[0], ghost[1]);
				g.lineTo(cam[0], cam[1]);
				g.stroke();
				g.setLineDash([]);
				g.strokeStyle = ink("trap", 0.9);
				g.beginPath();
				g.arc(ghost[0], ghost[1], 3.5, 0, Math.PI * 2);
				g.stroke();
				g.font = "500 9.5px ui-monospace, SFMono-Regular, Menlo, monospace";
				g.textAlign = "left";
				g.fillStyle = ink("trap", 0.95);
				g.fillText(`GPS ${Math.round(gps)} m`, ghost[0] + 8, ghost[1] + 3);
			}
		}
		g.fillStyle = solid.paper;
		g.beginPath();
		g.arc(here[0], here[1], 4, 0, Math.PI * 2);
		g.fill();
		g.strokeStyle = ink("paper", 0.35);
		g.lineWidth = 1;
		g.beginPath();
		g.arc(here[0], here[1], 9, 0, Math.PI * 2);
		g.stroke();
		if (state.eyeSnap > 0.5) {
			g.font = "500 9.5px ui-monospace, SFMono-Regular, Menlo, monospace";
			g.textAlign = "right";
			g.fillStyle = ink("paper", 0.8);
			g.fillText(`eye ${Math.round(eye)} m`, here[0] - 13, here[1] + 3);
		}
	}, [scene, state, size, theme]);

	return (
		<div ref={wrap} className={`relative ${className ?? ""}`}>
			<canvas ref={base} className="absolute inset-0 size-full" />
			<canvas ref={over} className="absolute inset-0 size-full" />
		</div>
	);
}

/** Bilinear height from the baked grid (m, with the curvature drop), 0 outside it. */
function groundZ(s: Scene, u: number, v: number) {
	const hf = s.heightfield;
	const fi = (u / hf.u + 0.5) * (hf.nu - 1);
	const fj = ((v - hf.v0) / (hf.v1 - hf.v0)) * (hf.nv - 1);
	const i = Math.floor(fi);
	const j = Math.floor(fj);
	if (i < 0 || j < 0 || i >= hf.nu - 1 || j >= hf.nv - 1) return s.eye;
	const H = (a: number, b: number) => hf.heights[b * hf.nu + a];
	const tx = fi - i;
	const ty = fj - j;
	const h =
		(H(i, j) * (1 - tx) + H(i + 1, j) * tx) * (1 - ty) +
		(H(i, j + 1) * (1 - tx) + H(i + 1, j + 1) * tx) * ty;
	return h - (v * v) / (2 * R_EFF);
}

/** The nearest `data-theme` island above `el`; <html> itself may lag the page theme, so it defers to `page`. */
function islandTheme(
	el: HTMLElement | null,
	page: ResolvedTheme,
): ResolvedTheme {
	const island = el?.parentElement?.closest("[data-theme]");
	if (!island || island === document.documentElement) return page;
	const t = island.getAttribute("data-theme");
	return t === "light" || t === "dark" ? t : page;
}
