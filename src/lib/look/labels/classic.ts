// Placement for the 'classic' peak labels (dot + leader + name / sub text block), shared by the DOM
// labels (PhotoWorkspace) and the export canvas (canvas.ts drawPeakLabels). Pure TS, no DOM.
//
// Which labels show is still rank.ts (rankPeaks + declutterClassic); this only decides where each
// one goes, greedily in rank order:
// - Text shape is flexible: the name may wrap onto 2–3 balanced lines, and the "ele · dist" sub line
//   may split at " · ", so a long name fits between neighbours or next to an image edge. Under the
//   top edge the block can flatten to one line (sub after the name) or, at worst, the name alone.
// - The block prefers to sit centred above its summit on a vertical leader of the style's length. It
//   may shorten the leader (tight under the top edge), lengthen it (to stack over a neighbour), or
//   slide sideways with an angled leader. Near an image edge it is clamped inside and re-anchored
//   (left / right aligned text) so it is never cut off.
// - Below the summit is the last resort (a summit hard under the top edge).
// Blocks never overlap each other, leaders never cross text, and text avoids other summits' dots. A
// label with no valid spot is dropped. `prev` (the previous layout) adds hysteresis while dragging.

import { prevIsCurrent, stampFontEpoch } from "./layout";

export type ClassicInput = {
	id: string;
	name: string;
	/** second line ("1,234 m · 5.6 km"), '' for none */
	sub: string;
	/** summit, px */
	x: number;
	y: number;
};

export type ClassicOptions = {
	width: number;
	height: number;
	/** CSS font strings used for measuring */
	nameFont: string;
	subFont: string;
	nameLineH: number;
	subLineH: number;
	/** preferred leader length, px */
	leadPx: number;
	/** summit dot diameter, px */
	dotPx: number;
	measure: (text: string, font: string) => number;
	/** clearance between blocks, px (default 0.3 × nameLineH) */
	gapPx?: number;
	/** min distance from the image edge, px (default 3) */
	edgePx?: number;
};

export type ClassicPlaced = {
	id: string;
	name: string;
	x: number;
	y: number;
	nameLines: string[];
	subLines: string[];
	/** sub on the name's line (after it) instead of below */
	subInline: boolean;
	below: boolean;
	/** vertical distance from the summit to the block's near edge, px */
	lead: number;
	align: "left" | "center" | "right";
	/** x of the text anchor (block left / centre / right per align), px */
	anchorX: number;
	box: { x0: number; y0: number; x1: number; y1: number };
	/** summit → block edge, px */
	leader: [number, number, number, number];
	/** shape + spot identity, for hysteresis */
	key: string;
};

type Box = { x0: number; y0: number; x1: number; y1: number };

const boxHit = (a: Box, b: Box, pad: number) =>
	a.x0 < b.x1 + pad &&
	b.x0 < a.x1 + pad &&
	a.y0 < b.y1 + pad &&
	b.y0 < a.y1 + pad;

/** Segment p0→p1 intersects box (Liang–Barsky). */
function segHitsBox(
	[x0, y0, x1, y1]: [number, number, number, number],
	b: Box,
	pad = 0,
) {
	const dx = x1 - x0;
	const dy = y1 - y0;
	let t0 = 0;
	let t1 = 1;
	const p = [-dx, dx, -dy, dy];
	const q = [
		x0 - (b.x0 - pad),
		b.x1 + pad - x0,
		y0 - (b.y0 - pad),
		b.y1 + pad - y0,
	];
	for (let i = 0; i < 4; i++) {
		if (p[i] === 0) {
			if (q[i] < 0) return false;
		} else {
			const t = q[i] / p[i];
			if (p[i] < 0) t0 = Math.max(t0, t);
			else t1 = Math.min(t1, t);
			if (t0 > t1) return false;
		}
	}
	return true;
}

function segsCross(
	a: [number, number, number, number],
	b: [number, number, number, number],
) {
	const o = (
		ax: number,
		ay: number,
		bx: number,
		by: number,
		cx: number,
		cy: number,
	) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
	return (
		o(a[0], a[1], a[2], a[3], b[0], b[1]) *
			o(a[0], a[1], a[2], a[3], b[2], b[3]) <
			0 &&
		o(b[0], b[1], b[2], b[3], a[0], a[1]) *
			o(b[0], b[1], b[2], b[3], a[2], a[3]) <
			0
	);
}

/** Break points of a name: after spaces and hyphens ("Piz Bernina", "Gross-Venediger"). */
function tokens(name: string) {
	const out: string[] = [];
	for (const m of name.trim().matchAll(/[^\s-]+-?|\s+/g)) {
		if (/^\s+$/.test(m[0])) continue;
		out.push(m[0]);
	}
	return out;
}

const joinTok = (t: string[]) =>
	t.reduce((s, w, i) => (i === 0 || s.endsWith("-") ? s + w : `${s} ${w}`), "");

/** The n-line split of `name` with the narrowest widest line (n ≤ 3, brute force). */
function wrapBalanced(
	name: string,
	n: number,
	w: (s: string) => number,
): string[] | null {
	const t = tokens(name);
	if (n === 1) return [name.trim()];
	if (t.length < n) return null;
	let best: string[] | null = null;
	let bestW = Number.POSITIVE_INFINITY;
	const consider = (lines: string[]) => {
		const m = Math.max(...lines.map(w));
		if (m < bestW - 0.01) {
			bestW = m;
			best = lines;
		}
	};
	for (let i = 1; i < t.length; i++) {
		if (n === 2) consider([joinTok(t.slice(0, i)), joinTok(t.slice(i))]);
		else
			for (let j = i + 1; j < t.length; j++)
				consider([
					joinTok(t.slice(0, i)),
					joinTok(t.slice(i, j)),
					joinTok(t.slice(j)),
				]);
	}
	return best;
}

type Shape = {
	nameLines: string[];
	subLines: string[];
	subInline: boolean;
	w: number;
	h: number;
	cost: number;
	key: string;
};

function shapesFor(l: ClassicInput, o: ClassicOptions): Shape[] {
	const pad = 2; // halo / measuring slack
	const wn = (s: string) => o.measure(s, o.nameFont) + pad;
	const ws = (s: string) => o.measure(s, o.subFont) + pad;
	const subVariants: string[][] = l.sub ? [[l.sub]] : [[]];
	if (l.sub.includes(" · ")) subVariants.push(l.sub.split(" · "));
	const out: Shape[] = [];
	for (let n = 1; n <= 3; n++) {
		const lines = wrapBalanced(l.name, n, wn);
		if (!lines) break;
		for (let k = 0; k < subVariants.length; k++) {
			const sub = subVariants[k];
			// splitting the sub line only helps once the name is narrower than it
			if (k > 0 && n === 1) continue;
			const w = Math.max(...lines.map(wn), ...sub.map(ws), 1);
			out.push({
				nameLines: lines,
				subLines: sub,
				subInline: false,
				w,
				h: lines.length * o.nameLineH + sub.length * o.subLineH,
				cost: (n - 1) * 0.9 + k * 0.7,
				key: `${n}${k}`,
			});
		}
	}
	// flat variants for tight vertical space: the sub after the name on one line, or the name alone
	const name = l.name.trim();
	if (l.sub)
		out.push({
			nameLines: [name],
			subLines: [l.sub],
			subInline: true,
			w: wn(name) + inlineGap(o) + ws(l.sub),
			h: o.nameLineH,
			cost: 1,
			key: "i",
		});
	if (l.sub)
		out.push({
			nameLines: [name],
			subLines: [],
			subInline: false,
			w: wn(name),
			h: o.nameLineH,
			cost: 5,
			key: "n",
		});
	return out;
}

/** space between the name and an inline sub, px */
export const inlineGap = (o: Pick<ClassicOptions, "nameLineH">) =>
	o.nameLineH * 0.3;

export function layoutClassic(
	labels: ClassicInput[],
	o: ClassicOptions,
	prev?: ClassicPlaced[],
): ClassicPlaced[] {
	const W = o.width;
	const H = o.height;
	const gap = o.gapPx ?? o.nameLineH * 0.3;
	const edge = o.edgePx ?? 3;
	const dotR = Math.max(2, o.dotPx / 2);
	const lead = Math.max(4, o.leadPx);
	const minLead = Math.max(dotR + 2, Math.min(lead, 6));
	const prevById = new Map(prev?.map((p) => [p.id, p]));
	const prevFresh = prevIsCurrent(prev);

	const dots: Box[] = labels.map((l) => ({
		x0: l.x - dotR - 1,
		y0: l.y - dotR - 1,
		x1: l.x + dotR + 1,
		y1: l.y + dotR + 1,
	}));
	const texts: Box[] = [];
	const leaders: [number, number, number, number][] = [];
	const out: ClassicPlaced[] = [];

	// leader length variants (× lead) and sideways shifts (× block width), with their costs
	const leads: [number, number][] = [
		[1, 0],
		[0.6, 0.6],
		[1.7, 1],
		[0.3, 1.3],
		[2.5, 2],
		[0, 1.8],
	];
	const shifts: [number, number][] = [
		[0, 0],
		[0.35, 1.2],
		[-0.35, 1.2],
		[0.7, 2.4],
		[-0.7, 2.4],
	];

	for (let li = 0; li < labels.length; li++) {
		const l = labels[li];
		if (!Number.isFinite(l.x) || !Number.isFinite(l.y)) continue;
		// hysteresis only against a previous layout from the current font epoch: after a web font
		// arrives the previous spots were chosen with fallback-font widths, and following them would
		// make the result depend on when the font came (the layout is redone fresh instead)
		const pv = prevFresh ? prevById.get(l.id) : undefined;
		let best: ClassicPlaced | null = null;
		let bestCost = Number.POSITIVE_INFINITY;
		for (const s of shapesFor(l, o)) {
			for (const below of [false, true]) {
				for (const [lk, lc] of leads) {
					const L = Math.max(minLead, lead * lk);
					if (below && lk > 1) continue;
					const y0 = below ? l.y + L : l.y - L - s.h;
					const y1 = y0 + s.h;
					if (y0 < edge || y1 > H - edge) continue;
					for (const [sk, sc] of shifts) {
						// the block centre slides by sk × width; then clamp inside the image
						let cx = l.x + sk * s.w;
						const minCx = edge + s.w / 2;
						const maxCx = W - edge - s.w / 2;
						const clamped = cx < minCx || cx > maxCx;
						cx = maxCx < minCx ? W / 2 : Math.min(maxCx, Math.max(minCx, cx));
						const box = { x0: cx - s.w / 2, y0, x1: cx + s.w / 2, y1 };
						// leader to the nearest point of the block's near edge (vertical when above it)
						const inset = Math.min(s.w / 2, 4);
						const ax = Math.min(box.x1 - inset, Math.max(box.x0 + inset, l.x));
						const ay = below ? y0 : y1;
						const dx = ax - l.x;
						// too flat a leader reads as pointing at the wrong summit
						if (Math.abs(dx) > Math.max(L, 8) * 1.2) continue;
						const leader: [number, number, number, number] = [
							l.x,
							l.y + (below ? dotR : -dotR),
							ax,
							ay,
						];
						let c = s.cost + lc + sc + (below ? 8 : 0) + Math.abs(dx) / (L + 8);
						if (c >= bestCost) continue;
						let ok = true;
						for (const t of texts)
							if (boxHit(box, t, gap) || segHitsBox(leader, t, 1)) {
								ok = false;
								break;
							}
						if (!ok) continue;
						for (const ld of leaders)
							if (segHitsBox(ld, box, 1)) {
								ok = false;
								break;
							}
						if (!ok) continue;
						for (let k = 0; k < dots.length; k++)
							if (k !== li && boxHit(box, dots[k], 1)) c += k < li ? 20 : 6;
						for (const ld of leaders) if (segsCross(ld, leader)) c += 3;
						const key = `${s.key}|${below ? "b" : "a"}${lk}|${sk}`;
						if (pv) {
							if (pv.key === key) c -= 1.5;
							else if (pv.key.split("|")[0] === s.key) c -= 0.8;
						}
						if (c >= bestCost) continue;
						const align: ClassicPlaced["align"] = clamped
							? cx > l.x
								? "left"
								: "right"
							: sk > 0
								? "left"
								: sk < 0
									? "right"
									: "center";
						bestCost = c;
						best = {
							id: l.id,
							name: l.name,
							x: l.x,
							y: l.y,
							nameLines: s.nameLines,
							subLines: s.subLines,
							subInline: s.subInline,
							below,
							lead: L,
							align,
							anchorX:
								align === "left" ? box.x0 : align === "right" ? box.x1 : cx,
							box,
							leader,
							key,
						};
					}
				}
			}
		}
		if (!best) continue;
		out.push(best);
		texts.push(best.box);
		leaders.push(best.leader);
	}
	return stampFontEpoch(out);
}
