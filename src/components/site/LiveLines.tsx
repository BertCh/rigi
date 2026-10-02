// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The live landing views' sides: baked line art (lineArt.ts) projected through the live camera onto
// a 2D canvas laid around the frame, behind it, so the terrain's lines carry on past the frame's edges
// and move with the orbit or the sway. Same idea as the static Surround (Surround.tsx), drawn per frame:
// the canvas runs BLEED frame widths past each side (md and up only; on phones the sides are
// off-screen), fades out at the outer edges, and leaves the frame's own rectangle empty. A rAF loop
// capped at FPS reads the camera and redraws only when it moved; it stops offscreen. Strokes take the
// page's paper colour (--rigi-paper), so they follow the theme.

import { useEffect, useRef } from "react";
import { decodeLines, type Lines, type View } from "./lineArt";

/** Spill past each side (frame widths), above and below (frame heights). */
const BLEED = 0.5;
const TOP = 0.06;
const BOTTOM = 0.12;
const FPS = 30;
/** Frame rate while nobody is dragging, zooming or typing (the autorotate keeps moving the view). */
const IDLE_FPS = 15;
const IDLE_AFTER_MS = 1500;
/** Distance-fade buckets for strokes (contours). */
const FADE_BUCKETS = 6;
// 1: the side strokes are faded hairlines, so a retina backing store only costs fill rate
const DPR_MAX = 1;
const LABEL_FONT = "600 10.5px ui-sans-serif, system-ui, sans-serif";
const SUB_FONT = "9.5px ui-monospace, monospace";

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
const SPAN = 1 + 2 * BLEED;
const VSPAN = 1 + TOP + BOTTOM;
const FADE_L = pct((BLEED * 0.6) / SPAN);
const FADE_R = pct(1 - (BLEED * 0.6) / SPAN);
const FADE_T = pct(TOP / VSPAN);
const FADE_B = pct((TOP + 1) / VSPAN);
const MASK = `linear-gradient(to right, transparent, #000 ${FADE_L}, #000 ${FADE_R}, transparent), linear-gradient(to bottom, transparent, #000 ${FADE_T}, #000 ${FADE_B}, transparent)`;

export function LiveLines({
	src,
	getView,
	className,
}: {
	/** The baked lines (fetched once the frame is near the viewport). */
	src: string;
	/** The live camera in the lines' frame, or null to show nothing (e.g. before the engine is up). */
	getView: (lines: Lines) => View | null;
	className?: string;
}) {
	const ref = useRef<HTMLCanvasElement>(null);
	const viewRef = useRef(getView);
	viewRef.current = getView;
	useEffect(() => {
		const canvas = ref.current;
		const host = canvas?.parentElement;
		if (!canvas || !host) return;
		const wide = window.matchMedia("(min-width: 768px)");
		let lines: Lines | null = null;
		let loading = false;
		let near = false;
		let onScreen = false;
		let raf = 0;
		let last = 0;
		// last pointer-held / wheel / key time: full frame rate only while the user drives the view
		let held = false;
		let lastInput = -Infinity;
		const input = () => {
			lastInput = performance.now();
		};
		const down = () => {
			held = true;
			input();
		};
		const up = () => {
			held = false;
			input();
		};
		window.addEventListener("pointerdown", down, { passive: true });
		window.addEventListener("pointerup", up, { passive: true });
		window.addEventListener("pointercancel", up, { passive: true });
		window.addEventListener("wheel", input, { passive: true });
		window.addEventListener("keydown", input, { passive: true });
		// what the last draw was made from: redraw only when one of these changed
		const seen = new Float64Array(13);
		let seenValid = false;
		let dirty = true;
		let hidden = true;
		const scratch = createScratch();
		// cached, so a tick never forces a style recalc or a layout
		let width = host.clientWidth;
		let height = host.clientHeight;
		let ink = readInk(canvas);
		const resizeObserver = new ResizeObserver(() => {
			const w = host.clientWidth;
			const h = host.clientHeight;
			if (w === width && h === height) return;
			width = w;
			height = h;
			dirty = true;
		});
		const refreshInk = () => {
			ink = readInk(canvas);
			dirty = true;
		};
		const themeObserver = new MutationObserver(refreshInk);
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme", "class"],
		});
		const scheme = window.matchMedia("(prefers-color-scheme: dark)");
		scheme.addEventListener("change", refreshInk);
		const tick = (now: number) => {
			raf = requestAnimationFrame(tick);
			const fps = held || now - lastInput < IDLE_AFTER_MS ? FPS : IDLE_FPS;
			if (now - last < 1000 / fps - 2) return;
			last = now;
			if (!lines) return;
			const v = viewRef.current(lines);
			if (!v) {
				if (!hidden) {
					hidden = true;
					canvas.style.opacity = "0";
				}
				seenValid = false;
				return;
			}
			if (seenValid && !dirty && sameView(seen, v)) return;
			storeView(seen, v);
			seenValid = true;
			dirty = false;
			if (hidden) {
				hidden = false;
				canvas.style.opacity = "1";
			}
			draw(canvas, lines, v, width, height, ink, scratch);
		};
		const sync = () => {
			const run = onScreen && wide.matches && !document.hidden;
			if (run && near && !lines && !loading) {
				loading = true;
				fetch(src)
					.then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
					.then((b) => {
						lines = decodeLines(b);
					})
					.catch((e) => console.warn("[live lines]", src, e));
			}
			if (run && !raf) {
				// the size and ink may have changed while stopped
				width = host.clientWidth;
				height = host.clientHeight;
				ink = readInk(canvas);
				dirty = true;
				raf = requestAnimationFrame(tick);
			} else if (!run && raf) {
				cancelAnimationFrame(raf);
				raf = 0;
			}
		};
		const nearIo = new IntersectionObserver(
			([e]) => {
				if (e.isIntersecting) near = true;
				sync();
			},
			{ rootMargin: "400px 0px" },
		);
		const io = new IntersectionObserver(([e]) => {
			onScreen = e.isIntersecting;
			sync();
		});
		nearIo.observe(host);
		io.observe(host);
		resizeObserver.observe(host);
		wide.addEventListener("change", sync);
		document.addEventListener("visibilitychange", sync);
		return () => {
			window.removeEventListener("pointerdown", down);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
			window.removeEventListener("wheel", input);
			window.removeEventListener("keydown", input);
			nearIo.disconnect();
			io.disconnect();
			resizeObserver.disconnect();
			themeObserver.disconnect();
			scheme.removeEventListener("change", refreshInk);
			wide.removeEventListener("change", sync);
			document.removeEventListener("visibilitychange", sync);
			cancelAnimationFrame(raf);
		};
	}, [src]);
	return (
		<canvas
			ref={ref}
			aria-hidden
			className={`pointer-events-none absolute hidden text-[var(--rigi-paper)] opacity-0 transition-opacity duration-700 select-none md:block ${className ?? ""}`}
			style={{
				left: pct(-BLEED),
				width: pct(SPAN),
				top: pct(-TOP),
				height: pct(VSPAN),
				maskImage: MASK,
				WebkitMaskImage: MASK,
				maskComposite: "intersect",
				WebkitMaskComposite: "source-in",
			}}
		/>
	);
}

const DEFAULT_INK = "236,230,218";

/** The canvas's text colour (paper) as "r,g,b"; reads computed style, so call it on change only. */
function readInk(canvas: HTMLCanvasElement) {
	return (
		getComputedStyle(canvas)
			.color.match(/[\d.]+/g)
			?.slice(0, 3)
			.join(",") ?? DEFAULT_INK
	);
}

const POS_EPS = 0.01;
const DIR_EPS = 1e-5;
const FOV_EPS = 1e-4;

function storeView(out: Float64Array, v: View) {
	out.set(v.pos, 0);
	out.set(v.fwd, 3);
	out.set(v.up, 6);
	out.set(v.right, 9);
	out[12] = v.fov;
}

function sameView(a: Float64Array, v: View) {
	for (let i = 0; i < 3; i++) {
		if (Math.abs(a[i] - v.pos[i]) > POS_EPS) return false;
		if (Math.abs(a[3 + i] - v.fwd[i]) > DIR_EPS) return false;
		if (Math.abs(a[6 + i] - v.up[i]) > DIR_EPS) return false;
		if (Math.abs(a[9 + i] - v.right[i]) > DIR_EPS) return false;
	}
	return Math.abs(a[12] - v.fov) <= FOV_EPS;
}

/** Per-bake scratch reused by every draw: strokes sorted into their (bucket, style) draw order. */
type Scratch = {
	forLines: Lines | null;
	group: Int32Array;
	order: Uint32Array;
	counts: Int32Array;
};
function createScratch(): Scratch {
	return {
		forLines: null,
		group: new Int32Array(0),
		order: new Uint32Array(0),
		counts: new Int32Array(0),
	};
}

/** Project and stroke every line; `fw`/`fh` are the frame's CSS size. */
function draw(
	canvas: HTMLCanvasElement,
	L: Lines,
	v: View,
	fw: number,
	fh: number,
	ink: string,
	scratch: Scratch,
) {
	const dpr = Math.min(DPR_MAX, window.devicePixelRatio || 1);
	const W = Math.round(fw * SPAN * dpr);
	const H = Math.round(fh * VSPAN * dpr);
	if (canvas.width !== W || canvas.height !== H) {
		canvas.width = W;
		canvas.height = H;
	}
	const g = canvas.getContext("2d");
	if (!g) return;
	g.setTransform(1, 0, 0, 1, 0, 0);
	g.clearRect(0, 0, W, H);

	// frame-normalised (u, v) → device px on this canvas
	const t = Math.tan((v.fov * Math.PI) / 360);
	const aspect = fw / Math.max(1, fh);
	const sx = (fw * dpr) / 2 / (t * aspect);
	const sy = (fh * dpr) / 2 / t;
	const cx = (BLEED + 0.5) * fw * dpr;
	const cy = (TOP + 0.5) * fh * dpr;
	// the canvas spans |x| ≤ SPAN/2 frame widths: points far past it are dropped (with a margin)
	const xLim = (SPAN / 2 + 0.3) * 2 * t * aspect;
	const yLim = (VSPAN / 2 + 0.3) * 2 * t;
	const [px, py, pz] = v.pos;
	const [rx, ry, rz] = v.right;
	const [ux, uy, uz] = v.up;
	const [fx, fy, fz] = v.fwd;

	const nStyles = L.styles.length;
	const nGroups = nStyles * FADE_BUCKETS;
	const nStrokes = L.style.length;
	const P = L.pts;
	const fade = L.fade;
	if (scratch.forLines !== L) {
		scratch.forLines = L;
		scratch.group = new Int32Array(nStrokes);
		scratch.order = new Uint32Array(nStrokes);
		scratch.counts = new Int32Array(nGroups + 1);
	}
	const { group, order, counts } = scratch;
	// pass 1: each stroke's distance bucket; a group's rank is its draw order (faintest bucket
	// first, styles last to first), then a counting sort of the strokes by rank
	counts.fill(0);
	for (let i = 0; i < nStrokes; i++) {
		const k0 = L.start[i];
		const k1 = L.start[i + 1];
		let bucket = 0;
		if (fade) {
			const m = ((k0 + k1) >> 1) * 3;
			const d = Math.hypot(P[m] - px, P[m + 1] - py, P[m + 2] - pz);
			if (d >= fade[1]) {
				group[i] = -1;
				continue;
			}
			bucket = Math.max(
				0,
				Math.min(
					FADE_BUCKETS - 1,
					Math.floor(((d - fade[0]) / (fade[1] - fade[0])) * FADE_BUCKETS),
				),
			);
		}
		const rank =
			(FADE_BUCKETS - 1 - bucket) * nStyles + (nStyles - 1 - L.style[i]);
		group[i] = rank;
		counts[rank + 1]++;
	}
	for (let r = 0; r < nGroups; r++) counts[r + 1] += counts[r];
	// counts[r] is now group r's start; fill through a moving cursor
	const cursor = counts.slice(0, nGroups);
	for (let i = 0; i < nStrokes; i++) {
		const r = group[i];
		if (r >= 0) order[cursor[r]++] = i;
	}
	// stroke only outside the frame (even-odd clip), so nothing is drawn just to be erased; the
	// frame keeps its own rectangle empty (its rounded corners show the page)
	const fx0 = BLEED * fw * dpr;
	const fy0 = TOP * fh * dpr;
	g.save();
	g.beginPath();
	g.rect(0, 0, W, H);
	g.rect(fx0, fy0, fw * dpr, fh * dpr);
	g.clip("evenodd");
	g.lineJoin = "round";
	g.lineCap = "round";
	for (let r = 0; r < nGroups; r++) {
		const from = counts[r];
		const to = counts[r + 1];
		if (from === to) continue;
		const b = FADE_BUCKETS - 1 - Math.floor(r / nStyles);
		const st = L.styles[nStyles - 1 - (r % nStyles)];
		const f = fade ? 1 - b / FADE_BUCKETS : 1;
		g.strokeStyle = `rgba(${ink},${st.alpha * f})`;
		g.lineWidth = st.width * dpr;
		g.beginPath();
		for (let n = from; n < to; n++) {
			const i = order[n];
			const k1 = L.start[i + 1];
			let pen = false;
			for (let k = L.start[i]; k < k1; k++) {
				const dx = P[k * 3] - px;
				const dy = P[k * 3 + 1] - py;
				const dz = P[k * 3 + 2] - pz;
				const z = dx * fx + dy * fy + dz * fz;
				if (z < 1) {
					pen = false;
					continue;
				}
				const x = (dx * rx + dy * ry + dz * rz) / z;
				const y = (dx * ux + dy * uy + dz * uz) / z;
				if (Math.abs(x) > xLim || Math.abs(y) > yLim) {
					pen = false;
					continue;
				}
				const X = cx + x * sx;
				const Y = cy - y * sy;
				if (pen) g.lineTo(X, Y);
				else g.moveTo(X, Y);
				pen = true;
			}
		}
		g.stroke();
	}

	g.restore();

	// peak names past the frame, on short leaders, greedily by rank without overlaps
	if (!L.labels.length) return;
	g.font = LABEL_FONT;
	const placed: [number, number][] = [];
	for (const lab of L.labels) {
		const dx = lab.p[0] - px;
		const dy = lab.p[1] - py;
		const dz = lab.p[2] - pz;
		const z = dx * fx + dy * fy + dz * fz;
		if (z < 1) continue;
		const X = cx + ((dx * rx + dy * ry + dz * rz) / z) * sx;
		const Y = cy - ((dx * ux + dy * uy + dz * uz) / z) * sy;
		const tw = (Math.max(g.measureText(lab.name).width, 60) + 10) * dpr;
		const outside =
			(X < fx0 - 4 * dpr && X + tw < fx0 - 6 * dpr) ||
			X > fx0 + fw * dpr + 4 * dpr;
		if (!outside || X < 0 || X + tw > W || Y < 48 * dpr || Y > H) continue;
		if (placed.some(([a, b]) => X < b + 6 * dpr && a < X + tw)) continue;
		placed.push([X, X + tw]);
		g.fillStyle = `rgba(${ink},0.8)`;
		g.beginPath();
		g.arc(X, Y, 2 * dpr, 0, Math.PI * 2);
		g.fill();
		g.fillRect(X - 0.5 * dpr, Y - 16 * dpr, dpr, 13 * dpr);
		g.font = LABEL_FONT;
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.fillText(lab.name, X / dpr + 4, Y / dpr - 30);
		g.font = SUB_FONT;
		g.fillStyle = `rgba(${ink},0.5)`;
		g.fillText(`${lab.ele} m`, X / dpr + 4, Y / dpr - 19);
		g.setTransform(1, 0, 0, 1, 0, 0);
		if (placed.length >= 8) break;
	}
}
