// SVG sink for the panorama / inline label layouts (layout.ts), themed from ViewStyle.labels: the
// name and elevation colours, the halo (an outline painted under the text, or a soft shadow), the
// leader and the summit dot. Labels fade in and out; hover shows the distance.
import { useEffect, useRef, useState } from "react";
import { toCss } from "../../style/color";
import type { LabelStyle } from "../../style/types";
import { uncertainOpacity } from "../../terroir/labels/names";
import { contrastFilter } from "./contrast";
import { eleSuffix, type PlacedLabel, tierFonts } from "./layout";

export type PeakLabelsSvgProps = {
	labels: PlacedLabel[];
	width: number;
	height: number;
	style: LabelStyle;
	onHover?: (label: PlacedLabel | null) => void;
	onClick?: (label: PlacedLabel) => void;
	className?: string;
	/** terroir.subPill: a stronger halo under the elevation text so it reads on bright cloud */
	subPill?: boolean;
	/** terroir.uncertainty with a guessed pose: softer labels (far first) and dashed leaders */
	uncertain?: boolean;
	/** halo.adaptive: 0..1 extra glow per label from the backdrop under it (labels/contrast.ts) */
	contrast?: (label: PlacedLabel) => number;
};

const FADE_MS = 220;
const ACCENT = "#ffd66b";

type Shown = PlacedLabel & { leaving?: boolean };

export function PeakLabelsSvg({
	labels,
	width,
	height,
	style: st,
	onHover,
	onClick,
	className,
	subPill,
	uncertain,
	contrast,
}: PeakLabelsSvgProps) {
	const fontPx = st.name.px;
	const fontFamily = st.fontFamily;
	const t = {
		fill: toCss(st.name.color),
		sub: toCss(st.sub.color),
		halo: st.halo.kind === "none" ? "none" : toCss(st.halo.color),
		line: toCss(st.leader.color),
		dot: toCss(st.dot.color),
	};
	const showEle = st.sub.show === "ele" || st.sub.show === "ele+dist";
	const [hover, setHover] = useState<string | null>(null);
	// keep removed labels for one fade so they don't pop out
	const [ghosts, setGhosts] = useState<Shown[]>([]);
	const last = useRef<PlacedLabel[]>([]);
	useEffect(() => {
		const ids = new Set(labels.map((l) => l.id));
		const gone = last.current
			.filter((l) => !ids.has(l.id))
			.map((l) => ({ ...l, leaving: true }));
		last.current = labels;
		if (!gone.length) {
			setGhosts((g) => (g.length ? g.filter((l) => !ids.has(l.id)) : g));
			return;
		}
		setGhosts((g) => [
			...g.filter((l) => !ids.has(l.id) && !gone.some((n) => n.id === l.id)),
			...gone,
		]);
		const timer = setTimeout(
			() => setGhosts((g) => g.filter((l) => !gone.some((n) => n.id === l.id))),
			FADE_MS + 40,
		);
		return () => clearTimeout(timer);
	}, [labels]);

	const all: Shown[] = [...ghosts, ...labels];
	// draw low tiers first so major names sit on top of leaders
	all.sort((a, b) => b.tier - a.tier);

	return (
		<svg
			className={className}
			width={width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			style={{
				position: "absolute",
				inset: 0,
				pointerEvents: "none",
				overflow: "visible",
				fontFamily,
			}}
			aria-label="Peak labels"
			role="img"
		>
			<style>{`
        .pk-g { transition: opacity ${FADE_MS}ms ease-out; }
        @starting-style { .pk-g { opacity: 0 !important; } }
        .pk-t { paint-order: stroke fill; stroke-linejoin: round; stroke-linecap: round; font-variant-numeric: tabular-nums lining-nums; font-kerning: normal; text-rendering: geometricPrecision; }
        .pk-hit { pointer-events: visiblePainted; cursor: pointer; }
      `}</style>
			{all.map((l) => {
				const f = tierFonts(l.tier, fontPx * (l.sizeMul ?? 1), fontFamily);
				const ele = showEle ? eleSuffix(l) : "";
				const isHover = hover === l.id;
				const halo =
					st.halo.kind === "stroke"
						? st.halo.strokePx
						: st.halo.kind === "shadow"
							? Math.max(2.5, f.size * 0.19)
							: 0;
				const op = l.leaving
					? 0
					: isHover
						? 1
						: uncertain
							? Math.min(l.opacity, uncertainOpacity(l.distKm))
							: l.opacity;
				const dotR =
					(st.dot.px / 2) * (l.tier === 0 ? 1 : l.tier === 1 ? 0.85 : 0.7);
				const glow = contrast ? contrastFilter(st, contrast(l), f.size) : "";
				const shadow =
					st.halo.kind === "shadow"
						? `drop-shadow(0 ${st.halo.offsetY}px ${st.halo.blurPx * 0.6}px ${t.halo})`
						: "";
				return (
					<g
						key={l.id}
						className="pk-g"
						data-peak-label={l.id}
						style={{
							opacity: op,
							filter: [shadow, glow].filter(Boolean).join(" ") || undefined,
						}}
					>
						{l.leader && (
							<>
								<line
									x1={l.leader[0]}
									y1={l.leader[1]}
									x2={l.leader[2]}
									y2={l.leader[3]}
									stroke={t.halo}
									strokeOpacity={0.5}
									strokeWidth={st.leader.widthPx + 2}
									strokeLinecap="round"
									strokeDasharray={uncertain ? "3 3" : undefined}
								/>
								<line
									x1={l.leader[0]}
									y1={l.leader[1]}
									x2={l.leader[2]}
									y2={l.leader[3]}
									stroke={isHover ? ACCENT : t.line}
									strokeWidth={st.leader.widthPx}
									shapeRendering="geometricPrecision"
									strokeDasharray={uncertain ? "3 3" : undefined}
								/>
							</>
						)}
						<circle
							cx={l.x}
							cy={l.y}
							r={dotR}
							fill={isHover ? ACCENT : t.dot}
							stroke={t.halo}
							strokeWidth={1.4}
							paintOrder="stroke"
						/>
						{/* biome-ignore lint/a11y/useSemanticElements: an SVG <text> can't be a <button> */}
						<text
							className="pk-t pk-hit"
							transform={`translate(${l.labelX.toFixed(1)} ${l.labelY.toFixed(1)})${l.rotation ? ` rotate(${l.rotation})` : ""}`}
							textAnchor={l.textAnchor}
							stroke={t.halo}
							strokeWidth={halo}
							onPointerEnter={() => {
								setHover(l.id);
								onHover?.(l);
							}}
							onPointerLeave={() => {
								setHover(null);
								onHover?.(null);
							}}
							onClick={() => onClick?.(l)}
							onKeyDown={(e) => {
								if (e.key === "Enter") onClick?.(l);
							}}
							role="button"
							tabIndex={-1}
						>
							<tspan
								fill={isHover ? ACCENT : t.fill}
								fontSize={f.size}
								fontWeight={Math.max(f.weight, st.name.weight)}
							>
								{l.name}
							</tspan>
							{ele && (
								<tspan
									fill={t.sub}
									fontSize={f.eleSize}
									fontWeight={st.sub.weight}
									dx={f.gap}
									stroke={subPill ? t.halo : undefined}
									strokeWidth={subPill ? Math.max(halo, 2) + 3 : undefined}
								>
									{ele}
								</tspan>
							)}
							{isHover && (
								<tspan
									fill={t.sub}
									fontSize={f.eleSize}
									fontWeight={st.sub.weight}
									dx={f.gap}
								>
									{`· ${l.distKm < 10 ? l.distKm.toFixed(1) : Math.round(l.distKm)} km`}
								</tspan>
							)}
							<title>{`${l.name}${ele ? ` ${ele} m` : ""} · ${l.distKm.toFixed(1)} km`}</title>
						</text>
					</g>
				);
			})}
		</svg>
	);
}
