// Peak labels on a 2D canvas (engine.exportImage), fed by ViewStyle.labels (styling.md §2.5).
// 'classic' is drawPeakLabels; 'panorama' / 'inline' lay out at the export size (layout.ts) and
// draw like the SVG overlay (PeakLabelsSvg.tsx).
// Classic uses the DOM's placement (classic.ts: wrapped, edge-clamped, kept above the summit). With
// `labels.export` set its metrics and halo are the original exportImage ones; with `export: null`
// they are the screen ones × W/1400 × 1.25.
import { hexToRgba01, toCss } from "../../style/color";
import type { LabelStyle } from "../../style/types";
import { inlineGap, layoutClassic } from "./classic";
import {
	candidatesFrom,
	canvasMeasure,
	eleSuffix,
	layoutLabels,
	type PlacedLabel,
	tierFonts,
} from "./layout";

export type CanvasLabel = {
	name: string;
	ele: number | null;
	u: number;
	v: number;
	distKm: number;
};

/** "1,234 m · 5.6 km" and its reduced variants (shared with the DOM labels). */
export function labelSubText(
	l: { ele: number | null; distKm: number },
	show: LabelStyle["sub"]["show"],
): string {
	const ele = l.ele ? `${Math.round(l.ele).toLocaleString()} m` : "";
	const dist = `${l.distKm.toFixed(1)} km`;
	switch (show) {
		case "ele+dist":
			return `${ele ? `${ele} · ` : ""}${dist}`;
		case "ele":
			return ele;
		case "dist":
			return dist;
		default:
			return "";
	}
}

/** rgba() of a colour with its alpha multiplied by `a`. */
function withAlpha(c: LabelStyle["name"]["color"], a: number) {
	const [r, g, b, a0] = hexToRgba01(c);
	return toCss([r, g, b, a0 * a]);
}

/** Draw `labels` (u, v normalised, v down) on a W × H canvas, placed like the DOM (classic.ts). */
export function drawPeakLabels(
	ctx: CanvasRenderingContext2D,
	labels: CanvasLabel[],
	st: LabelStyle,
	W: number,
	H: number,
) {
	const ex = st.export;
	// ex: the original exportImage metrics (s = W / scaleRef); otherwise the screen ones × k
	const s = ex ? W / ex.scaleRef : (W / 1400) * 1.25;
	const namePx = (ex ? ex.namePx : st.name.px) * s;
	const subPx = (ex ? ex.subPx : st.sub.px) * s;
	const lead = (ex ? ex.leaderPx : st.leader.lengthPx) * s;
	const leadW = (ex ? ex.leaderW : st.leader.widthPx) * s;
	const dotR = ex ? ex.dotR * s : (st.dot.px / 2) * s;
	const nameFont = `${st.name.weight} ${namePx}px ${st.fontFamily}`;
	const subFont = `${st.sub.weight} ${subPx}px ${st.fontFamily}`;
	const nameLH = ex ? ex.lineGap * s : namePx * 1.25;
	const subLH = ex ? ex.lineGap * s : subPx * 1.25;
	const placed = layoutClassic(
		labels.map((l, i) => ({
			id: String(i),
			name: l.name,
			sub: labelSubText(l, st.sub.show),
			x: l.u * W,
			y: l.v * H,
		})),
		{
			width: W,
			height: H,
			nameFont,
			subFont,
			nameLineH: nameLH,
			subLineH: subLH,
			leadPx: lead,
			dotPx: dotR * 2,
			measure: canvasMeasure,
		},
	);
	const halo = st.halo;
	const [sr, sg, sb] = hexToRgba01(st.sub.color);
	const subColor = ex ? toCss([sr, sg, sb, ex.subAlpha]) : toCss(st.sub.color);
	ctx.save();
	ctx.textBaseline = "middle";
	for (const c of placed) {
		const [x0, y0, x1, y1] = c.leader;
		if (lead > 0 && leadW > 0) {
			const g = ctx.createLinearGradient(x0, y0, x1, y1);
			g.addColorStop(0, toCss(st.leader.color));
			g.addColorStop(
				1,
				st.leader.fade ? withAlpha(st.leader.color, 0) : toCss(st.leader.color),
			);
			ctx.strokeStyle = g;
			ctx.lineWidth = leadW;
			ctx.lineCap = "butt";
			ctx.beginPath();
			ctx.moveTo(c.x, c.y);
			ctx.lineTo(x1, y1);
			ctx.stroke();
		}
		if (dotR > 0) {
			if (st.dot.glow && (!ex || ex.dotShadow)) {
				ctx.shadowColor = toCss(st.dot.glow);
				ctx.shadowBlur = st.dot.glowPx * s;
			}
			ctx.fillStyle = toCss(st.dot.color);
			ctx.beginPath();
			ctx.arc(c.x, c.y, dotR, 0, Math.PI * 2);
			ctx.fill();
			ctx.shadowBlur = 0;
		}
		ctx.textAlign = c.align;
		const text = (
			t: string,
			font: string,
			color: string,
			ty: number,
			tx = c.anchorX,
		) => {
			ctx.font = font;
			if (ex) {
				const [hr, hg, hb] = hexToRgba01(halo.color);
				ctx.shadowColor = toCss([hr, hg, hb, ex.haloAlpha]);
				ctx.shadowBlur = ex.haloBlur * s;
			} else if (halo.kind === "stroke" && halo.strokePx > 0) {
				ctx.lineJoin = "round";
				ctx.lineWidth = halo.strokePx * 2 * s;
				ctx.strokeStyle = toCss(halo.color);
				ctx.strokeText(t, tx, ty);
			} else if (halo.kind === "shadow") {
				ctx.shadowColor = toCss(halo.color);
				ctx.shadowBlur = halo.blurPx * s;
				ctx.shadowOffsetY = halo.offsetY * s;
			}
			ctx.fillStyle = color;
			ctx.fillText(t, tx, ty);
			ctx.shadowBlur = 0;
			ctx.shadowOffsetY = 0;
		};
		let ty = c.box.y0;
		if (c.subInline) {
			// one line: name then sub, left to right from the block's left edge
			ctx.textAlign = "left";
			const x0 = c.box.x0 + 1;
			const mid = ty + nameLH / 2;
			text(c.nameLines[0], nameFont, toCss(st.name.color), mid, x0);
			const sx =
				x0 +
				canvasMeasure(c.nameLines[0], nameFont) +
				2 +
				inlineGap({ nameLineH: nameLH });
			text(c.subLines[0], subFont, subColor, mid, sx);
			continue;
		}
		for (const t of c.nameLines) {
			text(t, nameFont, toCss(st.name.color), ty + nameLH / 2);
			ty += nameLH;
		}
		for (const t of c.subLines) {
			text(t, subFont, subColor, ty + subLH / 2);
			ty += subLH;
		}
	}
	ctx.restore();
}

/** Laid-out labels (layout.ts, px) drawn like PeakLabelsSvg: leader, summit dot, haloed text. */
export function drawPlacedLabels(
	ctx: CanvasRenderingContext2D,
	labels: PlacedLabel[],
	st: LabelStyle,
	fontPx: number,
) {
	const k = fontPx / st.name.px;
	const halo = st.halo.kind === "none" ? null : toCss(st.halo.color);
	const showEle = st.sub.show === "ele" || st.sub.show === "ele+dist";
	ctx.save();
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	ctx.textBaseline = "alphabetic";
	for (const l of [...labels].sort((a, b) => b.tier - a.tier)) {
		ctx.globalAlpha = l.opacity;
		if (l.leader) {
			const [x0, y0, x1, y1] = l.leader;
			const line = (color: string, w: number) => {
				ctx.strokeStyle = color;
				ctx.lineWidth = w;
				ctx.beginPath();
				ctx.moveTo(x0, y0);
				ctx.lineTo(x1, y1);
				ctx.stroke();
			};
			if (halo)
				line(withAlpha(st.halo.color, 0.5), (st.leader.widthPx + 2) * k);
			line(toCss(st.leader.color), st.leader.widthPx * k);
		}
		ctx.fillStyle = toCss(st.dot.color);
		ctx.beginPath();
		ctx.arc(
			l.x,
			l.y,
			(st.dot.px / 2) * k * (l.tier === 0 ? 1 : l.tier === 1 ? 0.85 : 0.7),
			0,
			Math.PI * 2,
		);
		if (halo) {
			ctx.strokeStyle = halo;
			ctx.lineWidth = 1.4 * k;
			ctx.stroke();
		}
		ctx.fill();
		const f = tierFonts(l.tier, fontPx, st.fontFamily);
		const ele = showEle ? eleSuffix(l) : "";
		ctx.save();
		ctx.translate(l.labelX, l.labelY);
		if (l.rotation) ctx.rotate((l.rotation * Math.PI) / 180);
		const nameFont = `${Math.max(f.weight, st.name.weight)} ${f.size}px ${st.fontFamily}`;
		const eleFont = `${st.sub.weight} ${f.eleSize}px ${st.fontFamily}`;
		const nameW = canvasMeasure(l.name, nameFont);
		let x =
			l.textAnchor === "start"
				? 0
				: l.textAnchor === "middle"
					? -l.textW / 2
					: -l.textW;
		ctx.textAlign = "left";
		const text = (t: string, font: string, color: string) => {
			ctx.font = font;
			if (st.halo.kind === "shadow") {
				ctx.shadowColor = halo as string;
				ctx.shadowBlur = st.halo.blurPx * k;
				ctx.shadowOffsetY = st.halo.offsetY * k;
			} else if (halo) {
				ctx.strokeStyle = halo;
				ctx.lineWidth = st.halo.strokePx * k;
				ctx.strokeText(t, x, 0);
			}
			ctx.fillStyle = color;
			ctx.fillText(t, x, 0);
			ctx.shadowBlur = 0;
			ctx.shadowOffsetY = 0;
		};
		text(l.name, nameFont, toCss(st.name.color));
		if (ele) {
			x += nameW + f.gap;
			text(ele, eleFont, toCss(st.sub.color));
		}
		ctx.restore();
	}
	ctx.restore();
}

export type ExportPeak = CanvasLabel & {
	prominence?: number | null;
	world: [number, number, number];
};

/**
 * Export labels on a W × H canvas. 'classic': drawPeakLabels on the engine's decluttered labels.
 * 'panorama' / 'inline': `peaks` are every visible peak (not decluttered), laid out at the export size
 * with the screen metrics × `scale` (export px per stage px) and the skyline (skylineAt).
 */
export function drawExportLabels(
	ctx: CanvasRenderingContext2D,
	peaks: ExportPeak[],
	st: LabelStyle,
	W: number,
	H: number,
	scale: number,
	skyline?: Float32Array | null,
) {
	if (st.layout === "classic") return drawPeakLabels(ctx, peaks, st, W, H);
	const fontPx = st.name.px * scale;
	const opts = {
		width: W,
		height: H,
		fontPx,
		style: st.layout,
		skyline: skyline ?? undefined,
		measure: canvasMeasure,
		maxLabels: st.maxLabels,
		fontFamily: st.fontFamily,
	};
	drawPlacedLabels(
		ctx,
		layoutLabels(candidatesFrom(peaks, W, H, skyline), opts),
		st,
		fontPx,
	);
}
