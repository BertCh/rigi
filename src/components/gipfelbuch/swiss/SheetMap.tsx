// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
	HandDot,
	HandText,
	PenLine,
	SketchPath,
	SketchPolyline,
} from "../notebook/Ink";
import { LAYER_INKS } from "../viz/inks";
import {
	EASE,
	MOTION,
	stagger,
	useArmedInView,
	useMotionAllowed,
} from "../viz/motion";
import { IMHOF_TINT_STOPS, ImhofRampFilter } from "./imhof";
import { paintPolygon } from "./paint";
import { SheetContourRuns } from "./sheet-contour-runs";
import {
	type FollowInput,
	followGeometry,
	wedgePath,
	wrap180,
} from "./sheet-follow";
import { labelSizes, layoutLabels } from "./sheet-labels";
import {
	SHEET_ASPECT,
	type SheetData,
	useElementWidth,
	useSheet,
	useSheetRock,
} from "./useSheet";

export interface SheetMapProps {
	className?: string;
	/** Demo photo id (for example "demo-03") whose viewpoint is emphasised. */
	highlight?: string;
	/** Draw the demo camera positions with their view cones. Default true. */
	showViewpoints?: boolean;
	/**
	 * The highlighted camera follows its photo: the phone's guess as a dashed ghost wedge, the solved
	 * wedge in the photo's solved ink, the correction arc with its signed degrees and pencil rays to the
	 * summits the photo names. Applies to the `highlight` viewpoint only.
	 */
	follow?: FollowInput;
}

const HALO = {
	paintOrder: "stroke",
	stroke: "var(--gb-paper)",
	strokeWidth: 7,
	strokeLinejoin: "round",
} as const;

const rad = (deg: number) => (deg * Math.PI) / 180;
/** Compass bearing to a sheet-space point offset (north up). */
const polar = (x: number, y: number, bearing: number, r: number) =>
	`${(x + r * Math.sin(rad(bearing))).toFixed(1)} ${(y - r * Math.cos(rad(bearing))).toFixed(1)}`;

function Sheet({
	sheet,
	highlight,
	showViewpoints,
	follow,
	title,
	scale,
}: {
	sheet: SheetData;
	highlight?: string;
	showViewpoints: boolean;
	follow?: FollowInput;
	title: string;
	/** Rendered CSS px per sheet unit. */
	scale: number;
}) {
	const uid = useId().replace(/:/g, "");
	const { width: W, height: H } = sheet;
	const lakeClip = `${uid}-lake`;
	const labelId = (i: number) => `${uid}-c${i}`;
	const lakeTint = "color-mix(in srgb, var(--gb-water) 13%, var(--gb-paper))";
	const rock = useSheetRock(sheet.rock);
	const sizes = useMemo(() => labelSizes(scale), [scale]);
	const placed = useMemo(() => layoutLabels(sheet, sizes), [sheet, sizes]);
	// minimum on-screen stroke width for the rock drawing (sheet units)
	const floor = (px: number) => px / scale;
	const hachureWidth = [0.9, 1.3, 1.7, 2.3].map((u, i) =>
		Math.max(u, floor([0.45, 0.6, 0.8, 1.0][i])),
	);
	const mask = (id: string, href: string) => (
		<mask id={id} maskUnits="userSpaceOnUse" x={0} y={0} width={W} height={H}>
			<image href={href} width={W} height={H} preserveAspectRatio="none" />
		</mask>
	);
	return (
		<svg
			viewBox={`0 0 ${W} ${H}`}
			width="100%"
			role="img"
			aria-label={title}
			style={{
				display: "block",
				aspectRatio: `${W} / ${H}`,
				isolation: "isolate",
			}}
		>
			<title>{title}</title>
			<defs>
				<clipPath id={lakeClip}>
					<path d={sheet.lake.d} />
				</clipPath>
				{/* d3-contour closes rings along the grid edge; clip those closing segments away */}
				<clipPath id={`${uid}-inner`}>
					<rect x={3} y={3} width={W - 6} height={H - 6} />
				</clipPath>
				{sheet.relief.tint && (
					<ImhofRampFilter id={`${uid}-hypso`} stops={IMHOF_TINT_STOPS} />
				)}
				{mask(`${uid}-sun`, sheet.relief.sun)}
				{mask(`${uid}-shade`, sheet.relief.shade)}
				{sheet.contours.labels.map((l, i) => (
					<path key={l.ele} id={labelId(i)} d={l.d} />
				))}
			</defs>
			<rect width={W} height={H} fill="var(--gb-paper)" />
			{/* Imhof hypsometric tint: valley green-yellow, warm mid-slopes, cool summits, under the lake and relief */}
			{sheet.relief.tint && (
				<image
					href={sheet.relief.tint}
					width={W}
					height={H}
					preserveAspectRatio="none"
					filter={`url(#${uid}-hypso)`}
					opacity={0.55}
					style={{ mixBlendMode: "multiply" }}
				/>
			)}
			{/* lake tint under the relief so the flat water grey multiplies into it */}
			<path d={sheet.lake.d} fill={lakeTint} />
			{/* I4 / I6: grey relief, then a cool ink through the shade mask and a warm ink through the sun mask, as overprint */}
			<image
				href={sheet.relief.src}
				width={W}
				height={H}
				preserveAspectRatio="none"
				opacity={0.75}
				style={{ mixBlendMode: "multiply" }}
			/>
			<rect
				width={W}
				height={H}
				fill="var(--gb-navy)"
				mask={`url(#${uid}-shade)`}
				opacity={0.16}
				style={{ mixBlendMode: "multiply" }}
			/>
			<rect
				width={W}
				height={H}
				fill="var(--gb-sign-light)"
				mask={`url(#${uid}-sun)`}
				opacity={0.32}
				style={{ mixBlendMode: "multiply" }}
			/>
			{/* water-lining: wide soft strokes of the shoreline, clipped to the lake, fading inwards */}
			<g
				clipPath={`url(#${lakeClip})`}
				fill="none"
				stroke="var(--gb-water)"
				strokeLinejoin="round"
			>
				<path d={sheet.lake.d} strokeWidth={34} opacity={0.1} />
				<path d={sheet.lake.d} strokeWidth={22} opacity={0.14} />
				<path d={sheet.lake.d} strokeWidth={12} opacity={0.2} />
			</g>
			{/* the shoreline is measured: one bounded pen pass */}
			<SketchPath
				d={sheet.lake.d}
				seed="sheet-shore"
				data
				color="var(--gb-water)"
				width={2.4}
			/>
			{/* R7 / R8: rock hachures and scree, integer quarter-unit paths */}
			{rock && (
				<g transform={`scale(${1 / rock.quantum})`} fill="none">
					<g fill="var(--gb-ink)" opacity={0.8}>
						{rock.scree.map((d, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed tiers
							<path key={i} d={d} />
						))}
					</g>
					<g stroke="var(--gb-ink)" strokeLinecap="butt" strokeLinejoin="round">
						{rock.hachures.map((d, i) => (
							<path
								// biome-ignore lint/suspicious/noArrayIndexKey: fixed tiers
								key={i}
								d={d}
								strokeWidth={hachureWidth[i] * rock.quantum}
								opacity={[0.55, 0.68, 0.8, 0.9][i]}
							/>
						))}
					</g>
				</g>
			)}
			<g clipPath={`url(#${uid}-inner)`}>
				<SheetContourRuns sheet={sheet} />
			</g>
			{scale > 0.22 && (
				<g
					fill="var(--gb-contour)"
					className="nb-num"
					style={{ fontSize: sizes.contour, fontStyle: "italic" }}
				>
					{sheet.contours.labels.map((l, i) => (
						<text
							key={l.ele}
							dy={sizes.contour * 0.3}
							{...HALO}
							strokeWidth={sizes.contour * 0.4}
						>
							<textPath
								href={`#${labelId(i)}`}
								startOffset="50%"
								textAnchor="middle"
							>
								{l.ele}
							</textPath>
						</text>
					))}
				</g>
			)}
			<text
				x={sheet.lake.label[0]}
				y={sheet.lake.label[1]}
				textAnchor="middle"
				className="nb-hand"
				fill="var(--gb-water)"
				transform={`skewX(-10) translate(${(sheet.lake.label[1] * Math.tan(Math.PI / 18)).toFixed(1)} 0)`}
				style={{
					fontSize: sizes.lake,
					letterSpacing: "0.22em",
				}}
			>
				{sheet.lake.name}
			</text>
			{/* LK lettering classes by hand (S20): places upright mixed case in ink */}
			<g
				fill="var(--gb-ink)"
				className="nb-hand-small"
				style={{ fontSize: sizes.place }}
			>
				{placed.places.map((p) => (
					<g key={p.name}>
						<HandDot x={p.x} y={p.y} r={5.5} seed={`place-${p.name}`} />
						<text
							x={p.x + 12}
							y={p.y + 7}
							{...HALO}
							strokeWidth={sizes.place * 0.3}
						>
							{p.name}
						</text>
					</g>
				))}
			</g>
			<g>
				{sheet.peaks.map((p) => (
					<path
						key={p.name}
						d={paintPolygon(
							[
								[p.x, p.y - 11],
								[p.x + 9, p.y + 5],
								[p.x - 9, p.y + 5],
							],
							`peak-${p.name}`,
							1.2,
						)}
						fill="var(--gb-ink)"
					/>
				))}
				{placed.peaks.map((p) => {
					const x = p.x + (p.flip ? -15 : 15);
					return (
						<g
							key={p.name}
							textAnchor={p.flip ? "end" : "start"}
							fill="var(--gb-navy)"
						>
							{/* peaks: hand block capitals in navy, height in italic hand figures (E1) */}
							<text
								x={x}
								y={p.y - 7}
								className="nb-label"
								style={{
									fontSize: sizes.peak,
									letterSpacing: "0.04em",
									...HALO,
									strokeWidth: sizes.peak * 0.26,
								}}
							>
								{p.name}
							</text>
							<text
								x={x}
								y={p.y - 7 + sizes.spot * 1.1}
								className="nb-num"
								style={{
									fontSize: sizes.spot,
									fontStyle: "italic",
									...HALO,
									strokeWidth: sizes.spot * 0.3,
								}}
							>
								{p.ele}
							</text>
						</g>
					);
				})}
			</g>
			{showViewpoints && (
				<g>
					{sheet.viewpoints.map((v) => {
						const on = v.id === highlight;
						const a0 = v.yaw - v.hfov / 2;
						const a1 = v.yaw + v.hfov / 2;
						const r = on ? 260 : 340;
						return (
							<g key={v.id} opacity={highlight && !on ? 0.45 : 1}>
								{on && follow ? (
									<FollowedCamera
										id={v.id}
										vp={v}
										follow={follow}
										peaks={sheet.peaks}
										r={r}
									/>
								) : (
									<>
										<path
											d={`M${v.x} ${v.y}L${polar(v.x, v.y, a0, r)}A${r} ${r} 0 0 1 ${polar(v.x, v.y, a1, r)}z`}
											fill="var(--gb-red)"
											fillOpacity={on ? 0.24 : 0}
										/>
										{on && (
											<SketchPath
												d={`M${v.x} ${v.y}L${polar(v.x, v.y, a0, r)}A${r} ${r} 0 0 1 ${polar(v.x, v.y, a1, r)}z`}
												seed={`cone-${v.id}`}
												color="red"
												width={1.6}
												opacity={0.85}
												dash={v.solved ? undefined : "6 5"}
												tolerance={1.5}
											/>
										)}
									</>
								)}
								<PenLine
									from={[v.x, v.y]}
									to={
										polar(v.x, v.y, v.yaw, r + 14)
											.split(" ")
											.map(Number) as [number, number]
									}
									seed={`ray-${v.id}`}
									color="red"
									width={on ? 3 : 2.6}
									dash={v.solved ? undefined : "6 5"}
								/>
								<HandDot
									x={v.x}
									y={v.y}
									r={on ? 12 : 9}
									seed={`vp-halo-${v.id}`}
									color="var(--gb-paper)"
									opacity={1}
								/>
								<HandDot
									x={v.x}
									y={v.y}
									r={on ? 8 : 5.5}
									seed={`vp-${v.id}`}
									color="red"
									opacity={1}
								/>
								{on && (
									<HandText x={v.x + 16} y={v.y - 14} color="red" size={32}>
										{v.id.replace("demo-", "№ ")}
									</HandText>
								)}
							</g>
						);
					})}
					{!highlight && sheet.viewpoints.length > 0 && (
						<ViewpointCallout points={sheet.viewpoints} />
					)}
				</g>
			)}
			<text
				x={W - 14}
				y={H - 14}
				textAnchor="end"
				fill="var(--gb-pencil)"
				opacity={0.6}
				className="nb-hand-small"
				style={{ fontSize: sizes.credit, ...HALO, strokeWidth: 5 }}
			>
				{sheet.credit}
			</text>
		</svg>
	);
}

type SheetViewpoint = SheetData["viewpoints"][number];

/**
 * The followed camera's cone layers. The static render is the settled frame (ghost, solved wedge, arc,
 * degrees, rays). Once per camera, when the map is armed in view, the solved wedge swings from the guess
 * to the fix (WAAPI, view-box transform), then the arc and its label fade in, then the rays. A refused
 * photo has no solve: the ghost, the sheet's own unsolved cone and a "not solved" note.
 */
function FollowedCamera({
	id,
	vp,
	follow,
	peaks,
	r,
}: {
	id: string;
	vp: SheetViewpoint;
	follow: FollowInput;
	peaks: SheetData["peaks"];
	r: number;
}) {
	const g = useMemo(
		() => followGeometry(vp, follow, peaks, r),
		[vp, follow, peaks, r],
	);
	const motion = useMotionAllowed();
	const { ref: armRef, armed } = useArmedInView<SVGGElement>();
	const swing = useRef<SVGGElement>(null);
	const arcRef = useRef<SVGGElement>(null);
	const rayRef = useRef<SVGGElement>(null);
	const playedRef = useRef<string | null>(null);
	const [playedId, setPlayedId] = useState<string | null>(null);
	const { accepted } = follow;
	const turn = wrap180(follow.guessYaw - follow.solvedYaw);
	// until the swing has played, motion hides the settled frame's arc and rays and holds the wedge at the guess
	const pending = motion && accepted && playedId !== id;
	useEffect(() => {
		if (!motion || !accepted || !armed || playedRef.current === id) return;
		playedRef.current = id;
		setPlayedId(id);
		const animations: Animation[] = [];
		const run = (
			el: Element | null | undefined,
			keyframes: Keyframe[],
			delay: number,
			duration: number,
			easing: string,
		) => {
			if (el?.animate)
				animations.push(
					el.animate(keyframes, { delay, duration, easing, fill: "backwards" }),
				);
		};
		const swingEnd = MOTION.lead + MOTION.settle;
		run(
			swing.current,
			[{ transform: `rotate(${turn}deg)` }, { transform: "rotate(0deg)" }],
			MOTION.lead,
			MOTION.settle,
			EASE.out,
		);
		run(
			arcRef.current,
			[{ opacity: 0 }, { opacity: 1 }],
			swingEnd,
			MOTION.fade,
			EASE.out,
		);
		const rays = Array.from(rayRef.current?.children ?? []);
		for (const [i, el] of rays.entries())
			run(
				el,
				[{ opacity: 0 }, { opacity: 1 }],
				swingEnd + MOTION.fade + stagger(i),
				MOTION.fade,
				EASE.out,
			);
		return () => {
			for (const a of animations) a.cancel();
			// a cancelled swing may replay when the camera comes back
			playedRef.current = null;
		};
	}, [motion, accepted, armed, id, turn]);
	const guess = (
		<SketchPath
			d={g.guessWedge}
			seed={`guess-${id}`}
			color={LAYER_INKS.prior.paper}
			width={1.4}
			dash="6 5"
			opacity={0.6}
			tolerance={1.5}
		/>
	);
	if (!accepted) {
		const cone = wedgePath(vp.x, vp.y, vp.yaw, vp.hfov, r);
		return (
			<g ref={armRef}>
				{guess}
				<path d={cone} fill="var(--gb-red)" fillOpacity={0.24} />
				<SketchPath
					d={cone}
					seed={`cone-${id}`}
					color="red"
					width={1.6}
					opacity={0.85}
					dash="6 5"
					tolerance={1.5}
				/>
				<HandText x={vp.x + 16} y={vp.y + 34} color="pencil" size={22}>
					not solved
				</HandText>
			</g>
		);
	}
	return (
		<g ref={armRef}>
			{/* the phone's guess: a dashed ghost in the prior ink */}
			{guess}
			<g
				ref={swing}
				style={{
					transformBox: "view-box",
					transformOrigin: `${vp.x}px ${vp.y}px`,
					transform: pending ? `rotate(${turn}deg)` : undefined,
				}}
			>
				<path
					d={g.solvedWedge}
					fill={LAYER_INKS.solved.paper}
					fillOpacity={0.16}
				/>
				<SketchPath
					d={g.solvedWedge}
					seed={`solved-${id}`}
					color={LAYER_INKS.solved.paper}
					width={1.8}
					tolerance={1.5}
				/>
			</g>
			<g ref={arcRef} style={{ opacity: pending ? 0 : undefined }}>
				<SketchPath
					d={g.arc}
					seed={`arc-${id}`}
					color="red"
					width={2}
					tolerance={1}
				/>
				<HandText
					x={g.arcLabel.x}
					y={g.arcLabel.y}
					color="red"
					size={28}
					anchor="middle"
				>
					{`${g.signedDeg}°`}
				</HandText>
			</g>
			<g ref={rayRef} style={{ opacity: pending ? 0 : undefined }}>
				{g.rays.map((ray) => (
					<g key={ray.name}>
						<PenLine
							from={[vp.x, vp.y]}
							to={ray.to}
							seed={`follow-ray-${id}-${ray.name}`}
							color="pencil"
							width={1.2}
						/>
					</g>
				))}
			</g>
		</g>
	);
}

/** Index-page hero: the Niederhorn / Thunersee sheet with contours, relief, peaks and the demo viewpoints. */
export function SheetMap({
	className,
	highlight,
	showViewpoints = true,
	follow,
}: SheetMapProps) {
	const state = useSheet();
	const ref = useRef<HTMLDivElement>(null);
	const width = useElementWidth(ref);
	const title =
		"Map of Niederhorn and Lake Thun with contours, relief, summits and the demo cameras";
	const box = { aspectRatio: String(SHEET_ASPECT), width: "100%" } as const;
	if (state.status === "ready")
		return (
			<div className={className} ref={ref}>
				<Sheet
					scale={width / state.sheet.width}
					sheet={state.sheet}
					highlight={highlight}
					showViewpoints={showViewpoints}
					follow={follow}
					title={title}
				/>
			</div>
		);
	return (
		<div className={className} ref={ref}>
			<div
				role="img"
				aria-label={
					state.status === "error" ? "Map unavailable" : "Loading map"
				}
				style={{
					...box,
					background: "var(--gb-paper-deep)",
					opacity: state.status === "loading" ? 0.6 : 1,
				}}
			/>
		</div>
	);
}

/** One label for the cluster of demo cameras, with a leader out to open ground. */
function ViewpointCallout({ points }: { points: { x: number; y: number }[] }) {
	const cx = points.reduce((t, p) => t + p.x, 0) / points.length;
	const cy = points.reduce((t, p) => t + p.y, 0) / points.length;
	const lx = cx - 150;
	const ly = cy - 190;
	return (
		<g>
			<SketchPolyline
				points={[
					[cx, cy],
					[lx, ly],
					[lx - 230, ly],
				]}
				seed="standorte-leader"
				color="red"
				width={2.4}
				tolerance={1.5}
			/>
			<HandText x={lx - 230} y={ly - 12} color="red" size={40} halo>
				{points.length} Standorte
			</HandText>
		</g>
	);
}
