// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Link } from "#/lib/atlas/graph-utils";
import { GROUPS } from "#/lib/atlas/graph-utils";
import type {
	AtlasGroup,
	AtlasKind,
	AtlasNode,
	AtlasStatus,
} from "#/lib/atlas/types";

/** Hand-rolled force simulation for the Atlas graphs (no dependencies). */
export interface FNode {
	id: string;
	title: string;
	group: AtlasGroup;
	kind: AtlasKind;
	status: AtlasStatus;
	tagline: string;
	deg: number;
	r: number;
	x: number;
	y: number;
	vx: number;
	vy: number;
	fx: number | null;
	fy: number | null;
	/** Displayed opacity (eased toward the target each frame). */
	a: number;
	phase: number;
}
export interface FLink {
	s: FNode;
	t: FNode;
	rel: string;
	curve: number;
}

function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 4294967296;
	};
}
function hash(s: string) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++)
		h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}

export interface SimOpts {
	/** Pin this node at the origin and lay out around it (compact graph). */
	focusId?: string;
	/** Pull groups toward anchors on a ring so they read as islands. */
	anchors?: boolean;
}

export function createSim(
	nodes: AtlasNode[],
	links: Link[],
	opts: SimOpts = {},
) {
	const rand = rng(7);
	const deg = new Map<string, number>();
	for (const l of links) {
		deg.set(l.from, (deg.get(l.from) ?? 0) + 1);
		deg.set(l.to, (deg.get(l.to) ?? 0) + 1);
	}
	const present = GROUPS.filter((g) => nodes.some((n) => n.group === g.id));
	const ring = 80 + 30 * Math.sqrt(nodes.length);
	const anchor = new Map<AtlasGroup, { x: number; y: number }>();
	present.forEach((g, i) => {
		const a = (i / present.length) * Math.PI * 2 - Math.PI / 2;
		anchor.set(g.id, { x: Math.cos(a) * ring * 1.6, y: Math.sin(a) * ring });
	});
	const fn: FNode[] = nodes.map((n) => {
		const d = deg.get(n.id) ?? 0;
		const an = (opts.anchors ? anchor.get(n.group) : null) ?? { x: 0, y: 0 };
		const focus = n.id === opts.focusId;
		return {
			id: n.id,
			title: n.title,
			group: n.group,
			kind: n.kind,
			status: n.status,
			tagline: n.tagline,
			deg: d,
			r: focus ? 13 : Math.min(15, 4.2 + 2 * Math.sqrt(d)),
			x: an.x + (rand() - 0.5) * 90,
			y: an.y + (rand() - 0.5) * 90,
			vx: 0,
			vy: 0,
			fx: focus ? 0 : null,
			fy: focus ? 0 : null,
			a: 0,
			phase: rand() * 6.28,
		};
	});
	const idx = new Map(fn.map((n) => [n.id, n]));
	const fl: FLink[] = [];
	const seen = new Set<string>();
	for (const l of links) {
		const s = idx.get(l.from);
		const t = idx.get(l.to);
		if (!s || !t) continue;
		fl.push({
			s,
			t,
			rel: l.rel,
			curve: hash(`${l.from}>${l.to}`) % 2 ? 1 : -1,
		});
		seen.add(`${l.from}|${l.to}`);
	}
	const adj = new Map<string, Set<string>>();
	for (const n of fn) adj.set(n.id, new Set());
	for (const l of fl) {
		adj.get(l.s.id)?.add(l.t.id);
		adj.get(l.t.id)?.add(l.s.id);
	}

	const sim = {
		nodes: fn,
		links: fl,
		adj,
		idx,
		alpha: 1,
		tick() {
			sim.alpha = Math.max(0, sim.alpha * 0.99);
			const al = sim.alpha;
			if (al < 0.004) return false;
			const n = fn.length;
			for (let i = 0; i < n; i++) {
				const a = fn[i];
				for (let j = i + 1; j < n; j++) {
					const b = fn[j];
					let dx = b.x - a.x;
					let dy = b.y - a.y;
					let d2 = dx * dx + dy * dy;
					if (d2 > 160000) continue;
					if (d2 < 0.01) {
						dx = rand() - 0.5;
						dy = rand() - 0.5;
						d2 = dx * dx + dy * dy + 0.01;
					}
					const d = Math.sqrt(d2);
					const f = Math.min(40, (opts.focusId ? 1500 : 1700) / d2) * al;
					const fx = (dx / d) * f;
					const fy = (dy / d) * f;
					a.vx -= fx;
					a.vy -= fy;
					b.vx += fx;
					b.vy += fy;
					const min = a.r + b.r + 9;
					if (d < min) {
						const push = ((min - d) / d) * 0.25;
						a.vx -= dx * push;
						a.vy -= dy * push;
						b.vx += dx * push;
						b.vy += dy * push;
					}
				}
			}
			for (const l of fl) {
				const dx = l.t.x - l.s.x;
				const dy = l.t.y - l.s.y;
				const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
				const rest =
					(l.s.group === l.t.group ? 44 : 120) +
					l.s.r +
					l.t.r +
					(opts.focusId ? 40 : 0);
				const x = l.s.group === l.t.group || opts.focusId ? 1 : 0.12;
				const k = ((d - rest) / d) * 0.24 * al * x;
				const ws = l.t.deg / (l.s.deg + l.t.deg || 1);
				l.s.vx += dx * k * ws;
				l.s.vy += dy * k * ws;
				l.t.vx -= dx * k * (1 - ws);
				l.t.vy -= dy * k * (1 - ws);
			}
			for (const p of fn) {
				const an = opts.anchors ? anchor.get(p.group) : null;
				if (an) {
					p.vx += (an.x - p.x) * 0.07 * al;
					p.vy += (an.y - p.y) * 0.07 * al;
				}
				if (!an) {
					p.vx -= p.x * 0.004 * al;
					p.vy -= p.y * 0.004 * al;
				}
				p.vx *= 0.6;
				p.vy *= 0.6;
				if (p.fx != null && p.fy != null) {
					p.x = p.fx;
					p.y = p.fy;
					p.vx = p.vy = 0;
				} else {
					p.x += p.vx;
					p.y += p.vy;
				}
			}
			return true;
		},
		warm(ticks = 480) {
			for (let i = 0; i < ticks; i++) sim.tick();
			sim.alpha = 0.03;
		},
		reheat(a = 0.3) {
			sim.alpha = Math.max(sim.alpha, a);
		},
		bounds() {
			let x0 = Infinity;
			let y0 = Infinity;
			let x1 = -Infinity;
			let y1 = -Infinity;
			for (const p of fn) {
				x0 = Math.min(x0, p.x - p.r);
				y0 = Math.min(y0, p.y - p.r);
				x1 = Math.max(x1, p.x + p.r);
				y1 = Math.max(y1, p.y + p.r);
			}
			if (!fn.length) return { x0: -100, y0: -100, x1: 100, y1: 100 };
			return { x0, y0, x1, y1 };
		},
	};
	sim.warm();
	return sim;
}
export type Sim = ReturnType<typeof createSim>;
