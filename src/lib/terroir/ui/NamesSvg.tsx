// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Terroir names in the photo overlay and Blend (reports/terroir-cartography.md T0.5 / phase 1):
// lakes, glaciers, ridges, massifs, passes, huts, settlements, alps… from the region's pack, typeset
// by class (labels/names.ts + classes.ts NAME_TYPO), laid out clear of each other and of the peak
// labels already on screen. Peaks the engine labels stay the engine's. TerroirLayer gates the mode.
import { useLayoutEffect, useRef, useState } from "react";
import { svgHaloWidth } from "#/lib/look/labels/css";
import { useLabelFontEpoch } from "#/lib/look/labels/useLabelFonts";
import { toCss } from "#/lib/style/color";
import { padRect, type Rect } from "../labels/names";
import {
	type GlyphKind,
	type NameItem,
	type PlaceState,
	peakLabelRects,
	placeNames,
} from "../labels/placeNames";
import type { TerroirCtx } from "./context";

const FADE_MS = 220;

const sig = (items: NameItem[]) =>
	items
		.map(
			(i) =>
				`${i.id}@${i.x.toFixed(0)},${i.y.toFixed(0)}${i.path ? i.path.length : ""}:${i.opacity}`,
		)
		.join("|");

function Glyph({
	kind,
	x,
	y,
	color,
	halo,
}: {
	kind: GlyphKind;
	x: number;
	y: number;
	color: string;
	halo: string;
}) {
	const d =
		kind === "pass"
			? "M-5 -3 Q0 3 5 -3" // a saddle between two summits
			: kind === "hut"
				? "M-4 2 V-1 L0 -4 L4 -1 V2 Z"
				: "M-5 0 H5";
	const dash = kind === "lift" ? "2 2" : undefined;
	return (
		<g transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
			<path
				d={d}
				fill="none"
				stroke={halo}
				strokeOpacity={0.55}
				strokeWidth={3.2}
				strokeLinejoin="round"
				strokeDasharray={dash}
			/>
			<path
				d={d}
				fill="none"
				stroke={color}
				strokeWidth={1.3}
				strokeLinejoin="round"
				strokeLinecap="round"
				strokeDasharray={dash}
			/>
		</g>
	);
}

export function NamesSvg({ ctx }: { ctx: TerroirCtx }) {
	const svgRef = useRef<SVGSVGElement>(null);
	const state = useRef<PlaceState>({ prev: new Set() });
	const lastSig = useRef("");
	const [items, setItems] = useState<NameItem[]>([]);
	const fontEpoch = useLabelFontEpoch();
	const uid = useRef(`ns${Math.random().toString(36).slice(2, 7)}`).current;

	// the peak labels are DOM, committed in the same pass as this layer: read them after commit
	// biome-ignore lint/correctness/useExhaustiveDependencies: ctx changes every engine frame; fontEpoch re-measures
	useLayoutEffect(() => {
		const svg = svgRef.current;
		const stage = ctx.stageEl;
		const origin = svg?.getBoundingClientRect() ?? null;
		const obs: Rect[] = peakLabelRects(
			stage ?? svg?.parentElement ?? null,
			origin,
		).map((r) => padRect(r, 2));
		const next = placeNames(ctx, state.current, obs, uid);
		const s = sig(next);
		if (s !== lastSig.current) {
			lastSig.current = s;
			setItems(next);
		}
	}, [ctx, fontEpoch, uid]);

	const ls = ctx.style.labels;
	const haloCss = ls.halo.kind === "none" ? "none" : toCss(ls.halo.color);
	return (
		<svg
			ref={svgRef}
			width={ctx.w}
			height={ctx.h}
			viewBox={`0 0 ${ctx.w} ${ctx.h}`}
			style={{
				position: "absolute",
				inset: 0,
				pointerEvents: "none",
				overflow: "visible",
				fontFamily: ls.fontFamily,
			}}
			aria-label="Place names"
			role="img"
		>
			<style>{`
        .ns-g { transition: opacity ${FADE_MS}ms ease-out; }
        @starting-style { .ns-g { opacity: 0 !important; } }
        .ns-t { paint-order: stroke fill; stroke-linejoin: round; stroke-linecap: round; text-rendering: geometricPrecision; font-kerning: normal; }
      `}</style>
			{items.map((it) => {
				const t = it.type;
				const halo = svgHaloWidth(ls.halo, t.px);
				const textStyle = {
					fontSize: t.px,
					fontWeight: t.weight,
					fontStyle: t.italic ? "italic" : "normal",
					letterSpacing: t.trackPx || undefined,
				} as const;
				const [pid, d] = it.path ? it.path.split("|") : [null, null];
				return (
					<g key={it.id} className="ns-g" style={{ opacity: it.opacity }}>
						{it.glyph && (
							<Glyph
								kind={it.glyph.kind}
								x={it.glyph.x}
								y={it.glyph.y}
								color={t.color}
								halo={haloCss}
							/>
						)}
						{pid && d ? (
							<>
								<defs>
									<path id={pid} d={d} fill="none" />
								</defs>
								<text
									className="ns-t"
									style={textStyle}
									fill={t.color}
									stroke={haloCss}
									strokeWidth={halo}
								>
									<textPath
										href={`#${pid}`}
										startOffset="50%"
										textAnchor="middle"
									>
										{it.text}
									</textPath>
								</text>
							</>
						) : (
							<>
								<text
									className="ns-t"
									x={it.x}
									y={it.y}
									textAnchor="middle"
									style={textStyle}
									fill={t.color}
									stroke={haloCss}
									strokeWidth={halo}
								>
									{it.text}
								</text>
								{it.alt && (
									<text
										className="ns-t"
										x={it.x}
										y={it.altY}
										textAnchor="middle"
										style={{
											...textStyle,
											fontSize: t.px * 0.82,
											fontWeight: 400,
											fontStyle: "normal",
											letterSpacing: undefined,
										}}
										fill={t.color}
										fillOpacity={0.75}
										stroke={haloCss}
										strokeWidth={halo}
									>
										{it.alt}
									</text>
								)}
							</>
						)}
					</g>
				);
			})}
		</svg>
	);
}
