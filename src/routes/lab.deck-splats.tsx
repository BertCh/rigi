// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Lab: DeckSplatLayer (src/lib/nearfield/deck-splat-layer.ts) on its own, no DeckEngine. A synthetic
// GaussianCloud (person, hut, tree, a half-buried rock, and a red ball hidden behind a hill) over a
// synthetic tile drawn by the repo's own TerrainLayer (hillshade, log depth), through the same
// PhotoView the deck engine uses (CARTESIAN, ENU metres).
//   Query: ?mode=fp|orbit  &truth=1  &nodepth=1  &n=<extra random splats>  &yaw= &pitch= &x= &y= &z=
//   First person: drag to look, WASD / arrows to move, Q/E down/up. Orbit: drag to orbit the hut.
//   Harness hook: window.__splatLab { setView, stats, measureFps, probe, backend }.
//   Backend: WebGL2 only. DeckSplatLayer is GLSL (no WGSL path), and `new Deck` here creates deck's default
//   WebGL device, so there is no ?renderer= param; backend() reports the live device type ("webgl") and
//   scripts/nearfield/deck-splat-lab-check.mjs asserts it.

import { Deck } from "@deck.gl/core";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PhotoView } from "#/lib/deck/photo-view";
import { createSyntheticTile } from "#/lib/deck/synthetic-tile";
import { TerrainLayer } from "#/lib/deck/terrain-layer";
import { DEG as D } from "#/lib/geodesy";
import { DeckSplatLayer, splatStats } from "#/lib/nearfield/deck-splat-layer";
import { type GaussianCloud, PROVENANCE_CODE } from "#/lib/nearfield/types";

type Search = {
	mode?: "fp" | "orbit";
	truth?: boolean;
	nodepth?: boolean;
	n?: number;
	yaw?: number;
	pitch?: number;
	x?: number;
	y?: number;
	z?: number;
};

const num = (v: unknown) => {
	const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
	return Number.isFinite(n) ? n : undefined;
};

export const Route = createFileRoute("/lab/deck-splats")({
	ssr: false,
	validateSearch: (s: Record<string, unknown>): Search => ({
		mode: s.mode === "orbit" ? "orbit" : s.mode === "fp" ? "fp" : undefined,
		truth: s.truth === true || s.truth === "1" || s.truth === 1 || undefined,
		nodepth:
			s.nodepth === true || s.nodepth === "1" || s.nodepth === 1 || undefined,
		n: num(s.n),
		yaw: num(s.yaw),
		pitch: num(s.pitch),
		x: num(s.x),
		y: num(s.y),
		z: num(s.z),
	}),
	head: () => ({ meta: [{ title: "Lab · deck splats" }] }),
	component: LabDeckSplatsGate,
});

// ---------------- synthetic world ----------------

const ORIGIN_ELEV = 2000;
const HILL = { x: 0, y: 120, h: 30, r: 38 };
const HUT = { x: 12, y: 45, w: 6, d: 5, h: 4 };
const HIDDEN = { x: 0, y: 220, r: 6 };

/** Ground height (ENU z, metres) of the synthetic terrain. */
function groundZ(x: number, y: number) {
	const hill =
		HILL.h *
		Math.exp(-((x - HILL.x) ** 2 + (y - HILL.y) ** 2) / (HILL.r * HILL.r));
	const far = 0.35 * Math.max(0, y - 250); // a slope rising to the north beyond the hill
	return 0.05 * y + hill + far + 0.6 * Math.sin(x * 0.07) * Math.cos(y * 0.05);
}

/** A z14 tile (about 1.7 km square) centred on the ENU origin, ENU z = height - ORIGIN_ELEV. */
function syntheticTile() {
	return createSyntheticTile((x, y) => groundZ(x, y) + ORIGIN_ELEV, {
		z: 14,
		frameH: ORIGIN_ELEV,
	}).tile;
}

type Splat = {
	p: [number, number, number];
	s: [number, number, number];
	q: [number, number, number, number];
	c: [number, number, number, number];
	prov: number;
};

// quaternions (w, x, y, z) that turn the local z axis onto ±x / ±y / ±z
const Q_ID: Splat["q"] = [1, 0, 0, 0];
const Q_ZX: Splat["q"] = [Math.SQRT1_2, 0, Math.SQRT1_2, 0];
const Q_ZY: Splat["q"] = [Math.SQRT1_2, -Math.SQRT1_2, 0, 0];

function makeRng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

function syntheticCloud(extra: number): GaussianCloud {
	const rnd = makeRng(7);
	const out: Splat[] = [];
	const jitter = (c: number, a = 18) =>
		Math.max(0, Math.min(255, c + (rnd() - 0.5) * a));
	// sphere / ellipsoid surface
	const ellipsoid = (
		cx: number,
		cy: number,
		cz: number,
		rx: number,
		ry: number,
		rz: number,
		count: number,
		col: (z: number) => [number, number, number],
		prov: number,
		size: number,
	) => {
		for (let i = 0; i < count; i++) {
			const u = rnd() * 2 - 1;
			const t = rnd() * Math.PI * 2;
			const r = Math.sqrt(1 - u * u);
			const z = cz + rz * u;
			const c = col(u);
			out.push({
				p: [cx + rx * r * Math.cos(t), cy + ry * r * Math.sin(t), z],
				s: [size, size, size],
				q: Q_ID,
				c: [jitter(c[0]), jitter(c[1]), jitter(c[2]), 235],
				prov,
			});
		}
	};
	const g0 = (x: number, y: number) => groundZ(x, y);

	// person: legs dark, jacket red, head skin (observed)
	{
		const x = -6;
		const y = 25;
		const z0 = g0(x, y);
		ellipsoid(
			x,
			y,
			z0 + 0.45,
			0.22,
			0.16,
			0.45,
			700,
			() => [40, 45, 60],
			PROVENANCE_CODE.observed,
			0.06,
		);
		ellipsoid(
			x,
			y,
			z0 + 1.2,
			0.26,
			0.18,
			0.35,
			900,
			() => [200, 30, 35],
			PROVENANCE_CODE.observed,
			0.06,
		);
		ellipsoid(
			x,
			y,
			z0 + 1.67,
			0.11,
			0.11,
			0.13,
			300,
			() => [225, 180, 150],
			PROVENANCE_CODE.observed,
			0.04,
		);
	}
	// hut: flat splats on the walls (anisotropic), roof on top (reconstructed)
	{
		const { x, y, w, d, h } = HUT;
		const z0 = g0(x, y) - 0.5;
		const wall: [number, number, number] = [150, 105, 70];
		const step = 0.3;
		for (let a = -w / 2; a <= w / 2; a += step)
			for (let b = 0; b <= h; b += step) {
				for (const sgn of [-1, 1]) {
					out.push({
						p: [x + a, y + (sgn * d) / 2, z0 + b],
						s: [step * 0.7, step * 0.7, 0.02],
						q: Q_ZY,
						c: [jitter(wall[0]), jitter(wall[1]), jitter(wall[2]), 245],
						prov: PROVENANCE_CODE.reconstructed,
					});
				}
			}
		for (let a = -d / 2; a <= d / 2; a += step)
			for (let b = 0; b <= h; b += step)
				for (const sgn of [-1, 1])
					out.push({
						p: [x + (sgn * w) / 2, y + a, z0 + b],
						s: [step * 0.7, step * 0.7, 0.02],
						q: Q_ZX,
						c: [
							jitter(wall[0] - 20),
							jitter(wall[1] - 15),
							jitter(wall[2] - 10),
							245,
						],
						prov: PROVENANCE_CODE.reconstructed,
					});
		for (let a = -w / 2 - 0.4; a <= w / 2 + 0.4; a += step)
			for (let b = -d / 2 - 0.4; b <= d / 2 + 0.4; b += step)
				out.push({
					p: [x + a, y + b, z0 + h],
					s: [step * 0.7, step * 0.7, 0.02],
					q: Q_ID,
					c: [jitter(90), jitter(70), jitter(60), 250],
					prov: PROVENANCE_CODE.reconstructed,
				});
	}
	// tree: a cone of green blobs (generated)
	{
		const x = 25;
		const y = 70;
		const z0 = g0(x, y);
		for (let i = 0; i < 2500; i++) {
			const t = rnd();
			const r = (1 - t) * 3 * Math.sqrt(rnd());
			const a = rnd() * Math.PI * 2;
			out.push({
				p: [x + r * Math.cos(a), y + r * Math.sin(a), z0 + 1.5 + t * 9],
				s: [0.18, 0.18, 0.18],
				q: Q_ID,
				c: [jitter(30, 30), jitter(95, 40), jitter(40, 30), 220],
				prov: PROVENANCE_CODE.generated,
			});
		}
		ellipsoid(
			x,
			y,
			z0 + 0.8,
			0.25,
			0.25,
			0.8,
			200,
			() => [80, 55, 35],
			PROVENANCE_CODE.generated,
			0.08,
		);
	}
	// rock: a sphere centred ON the ground — the terrain must hide its lower half (dem tint)
	{
		const x = -15;
		const y = 60;
		ellipsoid(
			x,
			y,
			g0(x, y),
			4,
			4,
			4,
			5000,
			(u) => {
				const v = 150 + u * 40;
				return [v, v, v + 8];
			},
			PROVENANCE_CODE.dem,
			0.22,
		);
	}
	// hidden: a bright red ball behind the hill — invisible unless the depth test is off
	{
		const { x, y, r } = HIDDEN;
		ellipsoid(
			x,
			y,
			g0(x, y) + r,
			r,
			r,
			r,
			3000,
			() => [255, 0, 0],
			PROVENANCE_CODE.observed,
			0.35,
		);
	}
	// stress: random splats scattered over the near field, sitting on the ground
	for (let i = 0; i < extra; i++) {
		const x = (rnd() - 0.5) * 160;
		const y = 8 + rnd() * 110;
		const z = g0(x, y) + rnd() * 3;
		const s = 0.05 + rnd() * 0.25;
		out.push({
			p: [x, y, z],
			s: [s, s * (0.3 + rnd()), s * (0.3 + rnd())],
			q: (() => {
				const w = rnd() - 0.5;
				const a = rnd() - 0.5;
				const b = rnd() - 0.5;
				const c = rnd() - 0.5;
				const l = Math.hypot(w, a, b, c) || 1;
				return [w / l, a / l, b / l, c / l] as Splat["q"];
			})(),
			c: [rnd() * 255, rnd() * 255, rnd() * 255, 120 + rnd() * 120],
			prov: (rnd() * 4) | 0,
		});
	}
	const n = out.length;
	const cloud: GaussianCloud = {
		count: n,
		frame: "enu",
		positions: new Float32Array(n * 3),
		scales: new Float32Array(n * 3),
		rotations: new Float32Array(n * 4),
		colors: new Uint8Array(n * 4),
		provenance: new Uint8Array(n),
	};
	out.forEach((s, i) => {
		cloud.positions.set(s.p, i * 3);
		cloud.scales.set(s.s, i * 3);
		cloud.rotations.set(s.q, i * 4);
		cloud.colors.set(
			s.c.map((v) => Math.round(v)),
			i * 4,
		);
		cloud.provenance[i] = s.prov;
	});
	return cloud;
}

// ---------------- camera ----------------

type Cam = {
	mode: "fp" | "orbit";
	yaw: number;
	pitch: number;
	eye: [number, number, number];
	/** Orbit: azimuth / elevation (deg) and distance around the hut. */
	az: number;
	el: number;
	dist: number;
};

function orbitView(c: Cam) {
	const t: [number, number, number] = [HUT.x, HUT.y, groundZ(HUT.x, HUT.y) + 2];
	const ce = Math.cos(c.el * D);
	const eye: [number, number, number] = [
		t[0] - c.dist * Math.sin(c.az * D) * ce,
		t[1] - c.dist * Math.cos(c.az * D) * ce,
		t[2] + c.dist * Math.sin(c.el * D),
	];
	return { eye, yaw: c.az, pitch: -c.el };
}

function photoViewState(c: Cam) {
	const v = c.mode === "orbit" ? orbitView(c) : c;
	return {
		photo: { yaw: v.yaw, pitch: v.pitch, roll: 0, vfov: 60, eye: v.eye },
	};
}

type LabHook = {
	setView: (v: Partial<Cam>) => void;
	stats: () => Record<string, unknown>;
	measureFps: (ms: number) => Promise<{ fps: number; frames: number }>;
	/** Screen (CSS px) positions of the test objects: hidden ball, rock centre, rock bottom. */
	probe: () => Record<string, number[] | null>;
	/** Luma device type of the Deck ("webgl" here; the splat layer is GLSL only). */
	backend: () => string;
};

// ---------------- page ----------------

// dev-only: the production build shows a stub (same gate as dev.graph / lab.splats)
function LabDeckSplatsGate() {
	if (!import.meta.env.DEV) return <p>dev only</p>;
	return <LabDeckSplats />;
}

function LabDeckSplats() {
	const search = Route.useSearch();
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const deckRef = useRef<Deck | null>(null);
	const camRef = useRef<Cam>({
		mode: search.mode ?? "fp",
		yaw: search.yaw ?? 0,
		pitch: search.pitch ?? -2,
		eye: [
			search.x ?? 0,
			search.y ?? 0,
			search.z ?? groundZ(search.x ?? 0, search.y ?? 0) + 1.7,
		],
		az: search.yaw ?? 20,
		el: 18,
		dist: 30,
	});
	const [truth, setTruth] = useState(!!search.truth);
	const [depth, setDepth] = useState(!search.nodepth);
	const [opacity, setOpacity] = useState(1);
	const [mode, setMode] = useState<Cam["mode"]>(camRef.current.mode);
	const [hud, setHud] = useState("");
	const extra = search.n ?? 0;

	const [world] = useState(() => {
		return { tile: syntheticTile(), cloud: syntheticCloud(extra) };
	});

	const layers = () => [
		new TerrainLayer({
			id: "lab-terrain",
			tiles: [world.tile],
			style: "hillshade",
			elevRange: [1900, 2400],
			contourInterval: 10,
		}),
		new DeckSplatLayer({
			id: "lab-splats",
			cloud: world.cloud,
			truth,
			opacity,
			noDepthTest: !depth,
			sortEvery: 1,
		}),
	];

	// biome-ignore lint/correctness/useExhaustiveDependencies: deck is created once
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		let frames = 0;
		const deck = new Deck({
			canvas,
			width: null,
			height: null,
			useDevicePixels: Math.min(window.devicePixelRatio || 1, 2),
			views: [new PhotoView({ id: "photo", near: 0.3, far: 400_000 })],
			viewState: photoViewState(camRef.current),
			layers: layers(),
			controller: false,
			onAfterRender: () => {
				frames++;
			},
			onError: (e: Error) => console.error("[lab-deck-splats]", e),
		} as never);
		deckRef.current = deck;
		const redraw = () =>
			deck.setProps({ viewState: photoViewState(camRef.current) } as never);

		// input
		let drag: { x: number; y: number } | null = null;
		const down = (e: PointerEvent) => {
			drag = { x: e.clientX, y: e.clientY };
			canvas.setPointerCapture(e.pointerId);
		};
		const move = (e: PointerEvent) => {
			if (!drag) return;
			const dx = e.clientX - drag.x;
			const dy = e.clientY - drag.y;
			drag = { x: e.clientX, y: e.clientY };
			const c = camRef.current;
			if (c.mode === "orbit") {
				c.az += dx * 0.3;
				c.el = Math.max(2, Math.min(80, c.el + dy * 0.3));
			} else {
				c.yaw -= dx * 0.15;
				c.pitch = Math.max(-85, Math.min(85, c.pitch + dy * 0.15));
			}
			redraw();
		};
		const up = () => {
			drag = null;
		};
		const wheel = (e: WheelEvent) => {
			const c = camRef.current;
			if (c.mode !== "orbit") return;
			c.dist = Math.max(3, Math.min(400, c.dist * Math.exp(e.deltaY * 0.001)));
			redraw();
		};
		const key = (e: KeyboardEvent) => {
			const c = camRef.current;
			if (c.mode !== "fp") return;
			const f = [Math.sin(c.yaw * D), Math.cos(c.yaw * D)];
			const r = [Math.cos(c.yaw * D), -Math.sin(c.yaw * D)];
			const s = e.shiftKey ? 5 : 1;
			const k = e.key.toLowerCase();
			let [dx, dy, dz] = [0, 0, 0];
			if (k === "w" || k === "arrowup") [dx, dy] = [f[0] * s, f[1] * s];
			else if (k === "s" || k === "arrowdown")
				[dx, dy] = [-f[0] * s, -f[1] * s];
			else if (k === "d" || k === "arrowright") [dx, dy] = [r[0] * s, r[1] * s];
			else if (k === "a" || k === "arrowleft")
				[dx, dy] = [-r[0] * s, -r[1] * s];
			else if (k === "e") dz = s;
			else if (k === "q") dz = -s;
			else return;
			c.eye = [c.eye[0] + dx, c.eye[1] + dy, c.eye[2] + dz];
			redraw();
		};
		canvas.addEventListener("pointerdown", down);
		canvas.addEventListener("pointermove", move);
		canvas.addEventListener("pointerup", up);
		canvas.addEventListener("wheel", wheel, { passive: true });
		window.addEventListener("keydown", key);

		const hook: LabHook = {
			setView: (v) => {
				Object.assign(camRef.current, v);
				if (v.mode) setMode(v.mode);
				redraw();
			},
			stats: () => ({ ...splatStats, count: world.cloud.count }),
			backend: () =>
				(deck as unknown as { device?: { type?: string } }).device?.type ??
				"unknown",
			probe: () => {
				const vp = deck.getViewports()[0];
				const at = (x: number, y: number, dz: number) =>
					vp ? vp.project([x, y, groundZ(x, y) + dz]) : null;
				return {
					hidden: at(HIDDEN.x, HIDDEN.y, HIDDEN.r),
					rockTop: at(-15, 60, 3),
					// lower-left of the rock's buried half: (-15, 60, -3) sits behind the person's
					// jacket in the default first-person view, so it could not show the terrain clip
					rockBottom: at(-17.8, 60, -2.2),
					size: [vp?.width ?? 0, vp?.height ?? 0],
				};
			},
			measureFps: async (ms) => {
				// turn the camera every frame (forces re-sorts) and count rendered frames
				const c = camRef.current;
				const f0 = frames;
				const t0 = performance.now();
				await new Promise<void>((res) => {
					const tick = () => {
						if (performance.now() - t0 >= ms) return res();
						if (c.mode === "orbit") c.az += 0.5;
						else c.yaw += 0.25;
						redraw();
						requestAnimationFrame(tick);
					};
					requestAnimationFrame(tick);
				});
				const frames1 = frames - f0;
				return {
					fps: (frames1 * 1000) / (performance.now() - t0),
					frames: frames1,
				};
			},
		};
		window.__splatLab = hook;

		const hudTimer = setInterval(() => {
			const s = splatStats;
			setHud(
				`${world.cloud.count.toLocaleString()} splats · drawn ${s.drawn.toLocaleString()} · sorts ${s.sorts} (${s.lastSortMs.toFixed(1)} ms, ${s.worker ? "worker" : "main"})`,
			);
		}, 500);
		canvas.dataset.ready = "1";
		return () => {
			clearInterval(hudTimer);
			canvas.removeEventListener("pointerdown", down);
			canvas.removeEventListener("pointermove", move);
			canvas.removeEventListener("pointerup", up);
			canvas.removeEventListener("wheel", wheel);
			window.removeEventListener("keydown", key);
			deck.finalize();
			deckRef.current = null;
		};
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: layers() reads these
	useEffect(() => {
		deckRef.current?.setProps({ layers: layers() } as never);
	}, [truth, depth, opacity]);

	useEffect(() => {
		camRef.current.mode = mode;
		deckRef.current?.setProps({
			viewState: photoViewState(camRef.current),
		} as never);
	}, [mode]);

	return (
		<div
			data-theme="dark"
			style={{
				position: "fixed",
				inset: 0,
				background: "linear-gradient(#7ea6cf, #c9dbea)",
			}}
		>
			<canvas
				ref={canvasRef}
				style={{ width: "100%", height: "100%", display: "block" }}
			/>
			<div
				style={{
					position: "absolute",
					top: 8,
					left: 8,
					padding: "6px 10px",
					background: "rgba(14,16,18,0.75)",
					color: "#eee",
					font: "12px system-ui, sans-serif",
					borderRadius: 6,
					display: "flex",
					gap: 12,
					alignItems: "center",
					flexWrap: "wrap",
					maxWidth: "calc(100vw - 32px)",
				}}
			>
				<strong>deck splats</strong>
				<label>
					<input
						type="checkbox"
						checked={mode === "orbit"}
						onChange={(e) => setMode(e.target.checked ? "orbit" : "fp")}
					/>{" "}
					orbit
				</label>
				<label>
					<input
						type="checkbox"
						checked={truth}
						onChange={(e) => setTruth(e.target.checked)}
					/>{" "}
					truth
				</label>
				<label>
					<input
						type="checkbox"
						checked={depth}
						onChange={(e) => setDepth(e.target.checked)}
					/>{" "}
					depth test
				</label>
				<label>
					opacity{" "}
					<input
						type="range"
						min={0}
						max={1}
						step={0.05}
						value={opacity}
						onChange={(e) => setOpacity(Number(e.target.value))}
					/>
				</label>
				<span data-testid="hud">{hud}</span>
			</div>
		</div>
	);
}
