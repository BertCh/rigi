// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	type Ref,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	GROUP_BY_ID,
	groupColor,
	type Link,
	STATUS_META,
} from "#/lib/atlas/graph-utils";
import type { AtlasNode } from "#/lib/atlas/types";
import { createSim, type FNode, type Sim } from "./force";

export interface GraphApi {
	zoomBy(f: number): void;
	fit(): void;
	focus(id: string): void;
}

const rgbCache = new Map<string, [number, number, number]>();
function rgb(hex: string): [number, number, number] {
	let c = rgbCache.get(hex);
	if (!c) {
		const n = Number.parseInt(hex.slice(1), 16);
		c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
		rgbCache.set(hex, c);
	}
	return c;
}
const rgba = (hex: string, a: number) => {
	const [r, g, b] = rgb(hex);
	return `rgba(${r},${g},${b},${a})`;
};
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

interface View {
	x: number;
	y: number;
	k: number;
}

export interface GraphCanvasProps {
	nodes: AtlasNode[];
	links: Link[];
	onOpen: (id: string) => void;
	focusId?: string;
	/** Compact: every label forced, no territories, gentle zoom limits. */
	compact?: boolean;
	/** When set, nodes outside the set are dimmed (search / filters). */
	matchIds?: Set<string> | null;
	className?: string;
	apiRef?: Ref<GraphApi>;
	/** Hide the "ctrl + scroll" hint. */
	noHint?: boolean;
}

/**
 * Canvas renderer + interaction for the Atlas graphs. Zoom needs ctrl / cmd + wheel, a pinch, or the
 * buttons, so a page scrolling past the graph never gets trapped.
 */
export function GraphCanvas({
	nodes,
	links,
	onOpen,
	focusId,
	compact,
	matchIds,
	className,
	apiRef,
	noHint,
}: GraphCanvasProps) {
	const wrap = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const card = useRef<HTMLDivElement>(null);
	const [hover, setHover] = useState<FNode | null>(null);
	const [selected, setSelected] = useState<FNode | null>(null);
	const [hint, setHint] = useState(false);
	const live = useRef({
		matchIds,
		onOpen,
		hover: null as FNode | null,
		selected: null as FNode | null,
	});
	live.current.matchIds = matchIds;
	live.current.onOpen = onOpen;
	live.current.selected = selected;
	const ctl = useRef<GraphApi>({ zoomBy() {}, fit() {}, focus() {} });
	useImperativeHandle(apiRef, () => ({
		zoomBy: (f) => ctl.current.zoomBy(f),
		fit: () => ctl.current.fit(),
		focus: (id) => ctl.current.focus(id),
	}));

	const sim: Sim = useMemo(
		() => createSim(nodes, links, { focusId, anchors: !compact }),
		[nodes, links, focusId, compact],
	);
	// FLink has no origin field (force.ts is not ours): resolve ontology-derived links once per sim.
	const derived = useMemo(() => {
		const keys = new Set(
			links
				.filter((l) => l.origin === "ontology")
				.map((l) => `${l.from}>${l.to}>${l.rel}`),
		);
		const set = new WeakSet<object>();
		for (const l of sim.links)
			if (keys.has(`${l.s.id}>${l.t.id}>${l.rel}`)) set.add(l);
		return set;
	}, [sim, links]);

	useEffect(() => {
		const cv = canvas.current;
		const box = wrap.current;
		if (!cv || !box) return;
		const ctx = cv.getContext("2d");
		if (!ctx) return;
		const reduce = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		const view: View = { x: 0, y: 0, k: 1 };
		const target: View = { x: 0, y: 0, k: 1 };
		let W = 0;
		let H = 0;
		let dpr = 1;
		let touched = false;
		let visible = true;
		let raf = 0;
		let hintTimer = 0;
		const maxK = 4;
		const minK = 0.15;

		const fitView = (animate: boolean) => {
			const b = sim.bounds();
			const pad = compact ? 36 : 56;
			const bw = Math.max(80, b.x1 - b.x0);
			const bh = Math.max(80, b.y1 - b.y0);
			const k = clamp(
				Math.min((W - pad * 2) / bw, (H - pad * 2) / bh),
				minK,
				compact ? 1.5 : 1.8,
			);
			const t = {
				k,
				x: W / 2 - ((b.x0 + b.x1) / 2) * k,
				y: H / 2 - ((b.y0 + b.y1) / 2) * k,
			};
			Object.assign(target, t);
			if (!animate) Object.assign(view, t);
		};
		const resize = () => {
			const r = box.getBoundingClientRect();
			W = Math.max(1, r.width);
			H = Math.max(1, r.height);
			dpr = Math.min(2, window.devicePixelRatio || 1);
			cv.width = Math.round(W * dpr);
			cv.height = Math.round(H * dpr);
			if (!touched) fitView(false);
		};
		resize();
		const ro = new ResizeObserver(resize);
		ro.observe(box);

		const zoomAt = (px: number, py: number, f: number) => {
			touched = true;
			const k = clamp(target.k * f, minK, maxK);
			const real = k / target.k;
			target.x = px - (px - target.x) * real;
			target.y = py - (py - target.y) * real;
			target.k = k;
		};
		ctl.current = {
			zoomBy: (f) => zoomAt(W / 2, H / 2, f),
			fit: () => {
				touched = false;
				fitView(true);
			},
			focus: (id) => {
				const n = sim.idx.get(id);
				if (!n) return;
				touched = true;
				const k = clamp(Math.max(target.k, 1.5), minK, maxK);
				Object.assign(target, { k, x: W / 2 - n.x * k, y: H / 2 - n.y * k });
				live.current.hover = n;
				setHover(n);
			},
		};

		// ---- interaction ----
		const toWorld = (sx: number, sy: number) => ({
			x: (sx - view.x) / view.k,
			y: (sy - view.y) / view.k,
		});
		const pick = (sx: number, sy: number): FNode | null => {
			let best: FNode | null = null;
			let bd = Infinity;
			const m = live.current.matchIds;
			for (const n of sim.nodes) {
				if (m && !m.has(n.id)) continue;
				const dx = n.x * view.k + view.x - sx;
				const dy = n.y * view.k + view.y - sy;
				const d = Math.hypot(dx, dy);
				const rr = Math.max(n.r * view.k, 5) + 5;
				if (d < rr && d < bd) {
					bd = d;
					best = n;
				}
			}
			return best;
		};
		type Drag =
			| {
					kind: "pan";
					sx: number;
					sy: number;
					vx: number;
					vy: number;
					moved: boolean;
			  }
			| { kind: "node"; n: FNode; sx: number; sy: number; moved: boolean };
		let drag: Drag | null = null;
		const pos = (e: PointerEvent) => {
			const r = cv.getBoundingClientRect();
			return { x: e.clientX - r.left, y: e.clientY - r.top };
		};
		const setHoverNode = (n: FNode | null) => {
			if (live.current.hover === n) return;
			live.current.hover = n;
			setHover(n);
		};
		const onDown = (e: PointerEvent) => {
			const p = pos(e);
			const n = pick(p.x, p.y);
			cv.setPointerCapture(e.pointerId);
			if (n && e.pointerType === "mouse")
				drag = { kind: "node", n, sx: p.x, sy: p.y, moved: false };
			else if (n) drag = { kind: "node", n, sx: p.x, sy: p.y, moved: false };
			else
				drag = {
					kind: "pan",
					sx: p.x,
					sy: p.y,
					vx: target.x,
					vy: target.y,
					moved: false,
				};
		};
		const onMove = (e: PointerEvent) => {
			const p = pos(e);
			if (drag) {
				if (Math.hypot(p.x - drag.sx, p.y - drag.sy) > 4) drag.moved = true;
				if (drag.kind === "pan" && drag.moved) {
					touched = true;
					target.x = drag.vx + (p.x - drag.sx);
					target.y = drag.vy + (p.y - drag.sy);
					view.x = target.x;
					view.y = target.y;
				} else if (drag.kind === "node" && drag.moved) {
					const w = toWorld(p.x, p.y);
					drag.n.fx = w.x;
					drag.n.fy = w.y;
					sim.reheat(0.25);
				}
			} else if (e.pointerType === "mouse") {
				const n = pick(p.x, p.y);
				setHoverNode(n);
				cv.style.cursor = n ? "pointer" : "grab";
			}
			const c = card.current;
			if (c) {
				const cw = 260;
				const x = p.x + 18 + cw > W ? p.x - cw - 14 : p.x + 18;
				c.style.transform = `translate(${Math.max(8, x)}px, ${clamp(p.y + 14, 8, H - 110)}px)`;
			}
		};
		const onUp = (e: PointerEvent) => {
			const d = drag;
			drag = null;
			if (!d) return;
			if (d.kind === "node") {
				if (!(d.n.id === focusId)) {
					d.n.fx = null;
					d.n.fy = null;
				}
				if (!d.moved) {
					if (e.pointerType === "mouse" || live.current.selected?.id === d.n.id)
						live.current.onOpen(d.n.id);
					else {
						setSelected(d.n);
						setHoverNode(d.n);
					}
				}
			} else if (!d.moved) {
				setSelected(null);
				if (e.pointerType !== "mouse") setHoverNode(null);
			}
		};
		const onLeave = () => {
			if (!drag) setHoverNode(null);
		};
		const onWheel = (e: WheelEvent) => {
			if (!(e.ctrlKey || e.metaKey)) {
				setHint(true);
				clearTimeout(hintTimer);
				hintTimer = window.setTimeout(() => setHint(false), 1400);
				return; // let the page scroll
			}
			e.preventDefault();
			const r = cv.getBoundingClientRect();
			zoomAt(
				e.clientX - r.left,
				e.clientY - r.top,
				Math.exp(
					-clamp(e.deltaY, -120, 120) * (e.deltaMode === 1 ? 0.05 : 0.0105),
				),
			);
		};
		cv.addEventListener("pointerdown", onDown);
		cv.addEventListener("pointermove", onMove);
		cv.addEventListener("pointerup", onUp);
		cv.addEventListener("pointercancel", onUp);
		cv.addEventListener("pointerleave", onLeave);
		cv.addEventListener("wheel", onWheel, { passive: false });

		const io = new IntersectionObserver(([en]) => {
			visible = en.isIntersecting;
			if (visible && !raf) raf = requestAnimationFrame(frame);
		});
		io.observe(box);

		// ---- drawing ----
		const labelW = new Map<string, number>();
		const FONT = "500 11.5px Manrope, system-ui, sans-serif";
		let last = performance.now();
		function frame(now: number) {
			raf = 0;
			if (!visible || document.hidden) return;
			const dt = Math.min(0.05, (now - last) / 1000);
			last = now;
			sim.tick();
			// ease view
			const e = 1 - Math.exp(-dt * 11);
			if (!drag || drag.kind !== "pan") {
				view.x += (target.x - view.x) * e;
				view.y += (target.y - view.y) * e;
			}
			view.k += (target.k - view.k) * e;
			draw(now / 1000, dt);
			raf = requestAnimationFrame(frame);
		}

		function draw(t: number, dt: number) {
			if (!ctx) return;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, W, H);
			const { k } = view;
			const hv = live.current.hover;
			const hs = hv ? sim.adj.get(hv.id) : undefined;
			const m = live.current.matchIds;
			const ease = 1 - Math.exp(-dt * 9);

			// target alpha per node
			for (const n of sim.nodes) {
				let ta = 1;
				if (m && !m.has(n.id)) ta = 0.1;
				if (hv && n !== hv && !hs?.has(n.id)) ta = Math.min(ta, 0.14);
				n.a += (ta - n.a) * ease;
				if (n.a < 0.001 && ta > 0.5) n.a = 0.05;
			}

			// graticule: faint world grid, like map sheet lines
			if (!compact) {
				const step = 200 * k;
				if (step > 24) {
					ctx.strokeStyle = "rgba(236,230,218,0.035)";
					ctx.lineWidth = 1;
					ctx.beginPath();
					const ox = view.x % step;
					const oy = view.y % step;
					for (let x = ox; x < W; x += step)
						ctx.moveTo(Math.round(x) + 0.5, 0),
							ctx.lineTo(Math.round(x) + 0.5, H);
					for (let y = oy; y < H; y += step)
						ctx.moveTo(0, Math.round(y) + 0.5),
							ctx.lineTo(W, Math.round(y) + 0.5);
					ctx.stroke();
				}
			}

			// territories + group names
			if (!compact) {
				const acc = new Map<
					string,
					{ x: number; y: number; n: number; vis: number }
				>();
				for (const n of sim.nodes) {
					const g = acc.get(n.group) ?? { x: 0, y: 0, n: 0, vis: 0 };
					g.x += n.x;
					g.y += n.y;
					g.n++;
					g.vis += n.a;
					acc.set(n.group, g);
				}
				for (const [gid, g] of acc) {
					const cx = g.x / g.n;
					const cy = g.y / g.n;
					let rad = 40;
					for (const n of sim.nodes)
						if (n.group === gid)
							rad = Math.max(rad, Math.hypot(n.x - cx, n.y - cy) + 46);
					const col = groupColor(gid as never);
					const vis = g.vis / g.n;
					const sx = cx * k + view.x;
					const sy = cy * k + view.y;
					const sr = rad * k;
					const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
					grd.addColorStop(0, rgba(col, 0.1 * vis));
					grd.addColorStop(0.7, rgba(col, 0.04 * vis));
					grd.addColorStop(1, rgba(col, 0));
					ctx.fillStyle = grd;
					ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
					const fade = clamp(1.55 - k, 0, 1) * vis;
					if (fade > 0.02 && g.n > 1) {
						const label =
							GROUP_BY_ID[gid as keyof typeof GROUP_BY_ID]?.label ?? gid;
						ctx.font = `600 ${Math.round(clamp(rad * 0.34 * k, 15, 46))}px Fraunces, Georgia, serif`;
						ctx.textAlign = "center";
						ctx.textBaseline = "middle";
						ctx.fillStyle = rgba(col, 0.3 * fade);
						ctx.fillText(label, sx, sy - sr * 0.8);
					}
				}
			}

			// edges
			const flow = reduce ? 0 : t * 18;
			ctx.textAlign = "left";
			for (const pass of [0, 1]) {
				for (const l of sim.links) {
					const hot = !!hv && (l.s === hv || l.t === hv);
					if ((pass === 1) !== hot) continue;
					const ax = l.s.x * k + view.x;
					const ay = l.s.y * k + view.y;
					const bx = l.t.x * k + view.x;
					const by = l.t.y * k + view.y;
					if (
						(ax < -40 && bx < -40) ||
						(ax > W + 40 && bx > W + 40) ||
						(ay < -40 && by < -40) ||
						(ay > H + 40 && by > H + 40)
					)
						continue;
					const dx = bx - ax;
					const dy = by - ay;
					const len = Math.hypot(dx, dy) || 1;
					const mx = (ax + bx) / 2 - (dy / len) * len * 0.09 * l.curve;
					const my = (ay + by) / 2 + (dx / len) * len * 0.09 * l.curve;
					const dim = Math.min(l.s.a, l.t.a);
					const onto = derived.has(l);
					ctx.beginPath();
					ctx.moveTo(ax, ay);
					ctx.quadraticCurveTo(mx, my, bx, by);
					if (hot) {
						const g = ctx.createLinearGradient(ax, ay, bx, by);
						g.addColorStop(0, rgba(groupColor(l.s.group), 0.95));
						g.addColorStop(1, rgba(groupColor(l.t.group), 0.95));
						ctx.strokeStyle = g;
						ctx.lineWidth = 1.6;
						ctx.setLineDash(onto ? [2, 4] : [5, 5]);
						ctx.lineDashOffset = -flow;
						ctx.stroke();
						ctx.setLineDash([]);
						// arrow head at target
						const tx = bx - mx;
						const ty = by - my;
						const tl = Math.hypot(tx, ty) || 1;
						const ux = tx / tl;
						const uy = ty / tl;
						const tipx = bx - ux * (l.t.r * k + 2);
						const tipy = by - uy * (l.t.r * k + 2);
						ctx.beginPath();
						ctx.moveTo(tipx, tipy);
						ctx.lineTo(tipx - ux * 7 - uy * 3.5, tipy - uy * 7 + ux * 3.5);
						ctx.lineTo(tipx - ux * 7 + uy * 3.5, tipy - uy * 7 - ux * 3.5);
						ctx.closePath();
						ctx.fillStyle = rgba(groupColor(l.t.group), 0.95);
						ctx.fill();
						// relation label
						if (k > 0.55 || compact) {
							ctx.font = "italic 500 10.5px Fraunces, Georgia, serif";
							const qx = 0.25 * ax + 0.5 * mx + 0.25 * bx;
							const qy = 0.25 * ay + 0.5 * my + 0.25 * by;
							const w = ctx.measureText(l.rel).width;
							ctx.fillStyle = "rgba(14,16,18,0.82)";
							ctx.fillRect(qx - w / 2 - 4, qy - 8, w + 8, 16);
							ctx.fillStyle = "rgba(236,230,218,0.85)";
							ctx.textAlign = "center";
							ctx.textBaseline = "middle";
							ctx.fillText(l.rel, qx, qy + 0.5);
							ctx.textAlign = "left";
						}
					} else {
						ctx.strokeStyle = `rgba(236,230,218,${(hv ? 0.03 : l.s.group !== l.t.group ? (onto ? 0.035 : 0.06) : onto ? 0.1 : 0.2) * dim + 0.008})`;
						ctx.lineWidth = 1;
						if (onto) ctx.setLineDash([3, 4]);
						ctx.stroke();
						if (onto) ctx.setLineDash([]);
					}
				}
			}

			// nodes
			const order = [...sim.nodes].sort((a, b) => a.a - b.a || a.r - b.r);
			for (const n of order) {
				const sx = n.x * k + view.x;
				const sy = n.y * k + view.y;
				if (sx < -30 || sx > W + 30 || sy < -30 || sy > H + 30) continue;
				const col = groupColor(n.group);
				const rr = n.r * k ** 0.55;
				const hot = n === hv || n === live.current.selected;
				const a = n.a * (n.status === "killed" ? 0.5 : 1);
				if (n.status === "live" || hot) {
					const pulse = reduce ? 0 : Math.sin(t * 1.3 + n.phase) * 0.18;
					const gr = rr * (hot ? 3.6 : 2.5 + pulse);
					const g = ctx.createRadialGradient(sx, sy, rr * 0.4, sx, sy, gr);
					g.addColorStop(0, rgba(col, (hot ? 0.5 : 0.28) * a));
					g.addColorStop(1, rgba(col, 0));
					ctx.fillStyle = g;
					ctx.beginPath();
					ctx.arc(sx, sy, gr, 0, 6.2832);
					ctx.fill();
				}
				ctx.beginPath();
				ctx.arc(sx, sy, rr, 0, 6.2832);
				if (n.status === "live") {
					ctx.fillStyle = rgba(col, a);
					ctx.fill();
				} else if (n.status === "flagged") {
					ctx.fillStyle = rgba(col, 0.5 * a);
					ctx.fill();
					ctx.strokeStyle = rgba(col, a);
					ctx.lineWidth = 1.4;
					ctx.stroke();
					ctx.beginPath();
					ctx.arc(sx, sy, rr + 3.2, 0, 6.2832);
					ctx.setLineDash([2.5, 3]);
					ctx.lineWidth = 1;
					ctx.stroke();
					ctx.setLineDash([]);
				} else if (n.status === "research") {
					ctx.fillStyle = rgba(col, 0.14 * a);
					ctx.fill();
					ctx.strokeStyle = rgba(col, a);
					ctx.lineWidth = 1.6;
					ctx.stroke();
				} else {
					// killed: a ghost - dashed outline, no fill
					ctx.setLineDash([2, 3]);
					ctx.strokeStyle = rgba(col, 0.75 * a);
					ctx.lineWidth = 1.2;
					ctx.stroke();
					ctx.setLineDash([]);
				}
				if (n.id === focusId) {
					ctx.beginPath();
					ctx.arc(sx, sy, rr + 5, 0, 6.2832);
					ctx.strokeStyle = "rgba(236,230,218,0.8)";
					ctx.lineWidth = 1;
					ctx.stroke();
				}
			}

			// labels, greedy declutter: hovered neighbourhood first, then by size
			ctx.textBaseline = "middle";
			ctx.textAlign = "left";
			const placed: [number, number, number, number][] = [];
			const cand = sim.nodes
				.map((n) => {
					const hot = n === hv || (hs?.has(n.id) ?? false) || n.id === focusId;
					const size = n.r * k ** 0.55 + (compact ? 10 : 0);
					return { n, hot, size, score: (hot ? 1000 : 0) + n.r };
				})
				.sort((a, b) => b.score - a.score);
			for (const { n, hot, size } of cand) {
				const fade = hot
					? 1
					: clamp(
							(size * (compact ? 1 : Math.min(1.6, k + 0.3)) - 5.5) / 3.5,
							0,
							1,
						);
				const alpha = fade * n.a;
				if (alpha < 0.04) continue;
				const sx = n.x * k + view.x;
				const sy = n.y * k + view.y;
				if (sx < -10 || sx > W || sy < -10 || sy > H + 10) continue;
				const rr = n.r * k ** 0.55;
				ctx.font = hot && n === hv ? FONT.replace("11.5", "13") : FONT;
				let w = labelW.get(n.title + (hot && n === hv ? "!" : ""));
				if (w == null) {
					w = ctx.measureText(n.title).width;
					labelW.set(n.title + (hot && n === hv ? "!" : ""), w);
				}
				let lx = sx + rr + 6;
				if (lx + w > W - 6) lx = sx - rr - 6 - w;
				const box: [number, number, number, number] = [
					lx - 2,
					sy - 8,
					lx + w + 2,
					sy + 8,
				];
				if (
					!hot &&
					placed.some(
						(p) =>
							box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1],
					)
				)
					continue;
				placed.push(box);
				ctx.lineJoin = "round";
				ctx.lineWidth = 3.5;
				ctx.strokeStyle = `rgba(14,16,18,${0.85 * alpha})`;
				ctx.strokeText(n.title, lx, sy + 0.5);
				ctx.fillStyle =
					n.status === "killed"
						? `rgba(236,230,218,${0.55 * alpha})`
						: `rgba(236,230,218,${(hot ? 1 : 0.86) * alpha})`;
				ctx.fillText(n.title, lx, sy + 0.5);
			}
		}

		raf = requestAnimationFrame(frame);
		return () => {
			cancelAnimationFrame(raf);
			raf = 0;
			clearTimeout(hintTimer);
			ro.disconnect();
			io.disconnect();
			cv.removeEventListener("pointerdown", onDown);
			cv.removeEventListener("pointermove", onMove);
			cv.removeEventListener("pointerup", onUp);
			cv.removeEventListener("pointercancel", onUp);
			cv.removeEventListener("pointerleave", onLeave);
			cv.removeEventListener("wheel", onWheel);
		};
	}, [sim, derived, compact, focusId]);

	const info = hover ?? selected;
	return (
		<div ref={wrap} className={`relative overflow-hidden ${className ?? ""}`}>
			<canvas
				ref={canvas}
				role="img"
				aria-label="Interactive graph of Rigi concepts"
				className="absolute inset-0 size-full cursor-grab touch-pan-y active:cursor-grabbing"
			/>
			{info && (
				<div
					ref={card}
					className="pointer-events-none absolute top-0 left-0 z-10 w-[260px] rounded-xl bg-[var(--rigi-ink)]/92 p-3 shadow-2xl ring-1 ring-white/12 backdrop-blur-md"
					style={{ transform: "translate(12px, 12px)" }}
				>
					<div
						className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.14em] uppercase"
						style={{ color: groupColor(info.group) }}
					>
						<span
							className="size-1.5 rounded-full"
							style={{ background: groupColor(info.group) }}
						/>
						{GROUP_BY_ID[info.group].label}
						<span
							className="ml-auto"
							style={{ color: STATUS_META[info.status].color }}
						>
							{STATUS_META[info.status].label}
						</span>
					</div>
					<div className="display-title mt-1 text-[17px] leading-tight font-bold text-[var(--rigi-paper)]">
						{info.title}
					</div>
					<p className="mt-1 text-[12px] leading-snug text-white/60">
						{info.tagline}
					</p>
					<p className="mt-2 font-mono text-[10px] text-white/35">
						{info.deg} connection{info.deg === 1 ? "" : "s"} ·{" "}
						{selected ? "tap again to open" : "click to open"}
					</p>
				</div>
			)}
			{!noHint && (
				<div
					className={`pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1.5 font-mono text-[10.5px] text-white/70 ring-1 ring-white/10 backdrop-blur transition-opacity duration-300 ${hint ? "opacity-100" : "opacity-0"}`}
				>
					Hold Ctrl / Cmd and scroll, or pinch, to zoom
				</div>
			)}
		</div>
	);
}
