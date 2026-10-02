// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	type CSSProperties,
	type KeyboardEvent,
	memo,
	type PointerEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { cn } from "#/lib/utils";
import { HandScaleBar, NorthArrow } from "../notebook/carto";
import { PenLine, SketchPath, SketchPolyline } from "../notebook/Ink";
import { inkFor, LAYER_INKS } from "./inks";
import { HandLabel } from "./labels";
import {
	ARM_SEQUENCE,
	ease,
	MOTION,
	useArmedInView,
	useMotionAllowed,
} from "./motion";
import {
	CrispLine,
	coneWedge,
	DemPatch,
	type GipfelbuchPhotoData,
} from "./real";
import { poseAt, useAlignmentStory } from "./story";
import {
	coneFitBox,
	declutterRim,
	type FootprintRun,
	followMode,
	footprintRuns,
	mapPeakSet,
	mixHex,
	type Placed,
	peakInk,
	placeNamed,
	rayDraw,
	SEARCH_LOOP_MS,
	searchT,
	wrap180,
} from "./story-map";

// The side map of an alignment story: the DEM patch around the camera with the view cone at the
// story's position between the phone's guess and the solved pose. It follows its photo: it names the
// photo's own peaks in the photo's inks, draws the ground that forms the photo's skyline, and draws
// rays to the named summits as the cone arrives. The guess (dashed) and the solved cone (hairline)
// stay as ghosts, an arc measures the compass correction. Inside an AlignmentStoryProvider the map
// follows the wipe or stage (settling with the geo spill, a drag at once), and dragging round the
// camera (or the arrow keys) drives the story from the map. Spec: reports/gipfelbuch-explainers-2026-10-02/M-maps.md.
//
// Two layers: a memoised BASE (relief, footprint, context ticks, solved ghost, furniture) and a LIVE
// svg on top that re-renders as t moves.

const PRIOR_INK = LAYER_INKS.prior.paperHex;
const SOLVED_INK = LAYER_INKS.solved.paperHex;
/** DemPatch's square viewBox side. */
const S = 400;
const RAD = Math.PI / 180;
const TERRAIN_INK = "var(--fig-terrain-ink, var(--gb-contour))";
const sgn = (v: number) =>
	`${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;

/** The search loop clock; re-renders only the component that holds it, and only while on screen. */
function useSearchClock(
	on: boolean,
): [
	RefObject<HTMLDivElement | null>,
	{ t: number; opacity: number; rays: number },
] {
	const { ref, armed } = useArmedInView<HTMLDivElement>({
		arm: ARM_SEQUENCE,
	});
	const motion = useMotionAllowed();
	const [state, setState] = useState({ t: 1, opacity: 1, rays: 1 });
	useEffect(() => {
		if (!on || !armed || !motion) {
			setState({ t: 1, opacity: 1, rays: 1 });
			return;
		}
		const t0 = performance.now();
		let raf = 0;
		let lastFrame = Number.NEGATIVE_INFINITY;
		const tick = (now: number) => {
			raf = requestAnimationFrame(tick);
			// 30 fps cap (landing perf): a state update per display frame buys nothing visible
			if (now - lastFrame < 1000 / 30 - 2) return;
			lastFrame = now;
			const { t, opacity, rays } = searchT((now - t0) % SEARCH_LOOP_MS);
			setState((s) =>
				s.t === t && s.opacity === opacity && s.rays === rays
					? s
					: { t, opacity, rays },
			);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [on, armed, motion]);
	return [ref, state];
}

/**
 * Follows the story's t: settles to it over MOTION.settle (ease.out, like the geo spill's slide), but
 * at once for a drag (this map's own pointer, the story's `instant` flag, or a run of small fast steps).
 */
function useFollowT(
	target: number,
	enabled: boolean,
	dragging: RefObject<boolean>,
	storyInstant: boolean | undefined,
): number {
	const motion = useMotionAllowed();
	const [v, setV] = useState(target);
	const cur = useRef(target);
	const prev = useRef({ target, at: performance.now() });
	useEffect(() => {
		if (!enabled) return;
		const next = { target, at: performance.now() };
		const mode = followMode(prev.current, next);
		prev.current = next;
		const from = cur.current;
		if (
			!motion ||
			storyInstant ||
			dragging.current ||
			mode === "instant" ||
			Math.abs(from - target) < 1e-4
		) {
			cur.current = target;
			setV(target);
			return;
		}
		const t0 = performance.now();
		let raf = 0;
		const tick = (now: number) => {
			const u = Math.min(1, (now - t0) / MOTION.settle);
			cur.current = from + (target - from) * ease.out(u);
			setV(cur.current);
			if (u < 1) raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [target, enabled, motion, dragging, storyInstant]);
	return enabled ? v : target;
}

/** Rendered width of an element, px (0 until measured). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
	const [w, setW] = useState(0);
	useEffect(() => {
		const el = ref.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref]);
	return w;
}

const BaseMap = memo(function BaseMap({
	d,
	runs,
	context,
	furniture,
}: {
	d: GipfelbuchPhotoData;
	runs: FootprintRun[];
	context: { az: number; distance: number }[];
	furniture: boolean;
}) {
	const half = d.demPatch.halfKm * 1000;
	const reach = half * 1.6;
	return (
		<DemPatch
			data={d}
			cone={[]}
			peaks={false}
			imprint={false}
			furniture={false}
		>
			{(_, toPx) => (
				<g>
					{runs.map((r) => (
						<SketchPolyline
							key={`${r.az0}-${r.az1}`}
							points={r.pts}
							seed={`${d.id}-sm-fp-${r.az0}`}
							data
							passes={1}
							color={TERRAIN_INK}
							width={0.9}
							opacity={0.35}
						/>
					))}
					{context.map((p) => {
						const [x, y] = toPx(p.az, p.distance);
						if (x < 4 || y < 4 || x > S - 4 || y > S - 4) return null;
						return (
							<path
								key={`${p.az}-${p.distance}`}
								d={`M${x} ${y - 3}l-2.6 4.5h5.2z`}
								fill="none"
								stroke="var(--gb-pencil)"
								strokeWidth={0.8}
								opacity={0.5}
							/>
						);
					})}
					<SketchPath
						d={coneWedge(d, d.solved.yaw, d.solved.hfov, reach, S)}
						seed={`${d.id}-sm-solved-ghost`}
						color={SOLVED_INK}
						width={0.9}
						opacity={0.6}
						passes={1}
						tolerance={0.5}
					/>
					{furniture && (
						<>
							<HandScaleBar
								x={14}
								y={386}
								metersPerPixel={(2 * half) / S}
								maxWidth={110}
								seed={`${d.id}-sm-scale`}
							/>
							<NorthArrow x={24} y={72} length={22} seed={`${d.id}-sm-north`} />
						</>
					)}
				</g>
			)}
		</DemPatch>
	);
});

function LiveLayer({
	d,
	t,
	runs,
	placed,
	opacity,
	rayT,
}: {
	d: GipfelbuchPhotoData;
	t: number;
	runs: FootprintRun[];
	placed: Placed[];
	opacity: number;
	/** Position on the t axis the rays draw at (search mode); defaults to t. */
	rayT?: number;
}) {
	const clipId = `sm-clip-${useId().replace(/:/g, "")}`;
	const live = poseAt(d, t);
	const half = d.demPatch.halfKm * 1000;
	const reach = half * 1.6;
	const ink = mixHex(PRIOR_INK, SOLVED_INK, t);
	const tc = Math.min(1, Math.max(0, t));
	const toPx = (az: number, dist: number): [number, number] => [
		S / 2 + (Math.sin(az * RAD) * dist * S) / (2 * half),
		S / 2 - (Math.cos(az * RAD) * dist * S) / (2 * half),
	];
	const wedge = coneWedge(d, live.yaw, live.hfov, reach, S);
	// the correction arc, from the guess's heading to the live heading
	const arcR = S * 0.17;
	const arcDist = (arcR * 2 * half) / S;
	const p0 = toPx(d.prior.yaw, arcDist);
	const p1 = toPx(live.yaw, arcDist);
	const sweep = wrap180(live.yaw - d.prior.yaw);
	const mid = toPx(d.prior.yaw + sweep / 2, arcDist + (26 * 2 * half) / S);
	return (
		<svg
			viewBox={`0 0 ${S} ${S}`}
			className="pointer-events-none absolute inset-0 h-full w-full"
			aria-hidden="true"
			role="presentation"
			style={{ opacity }}
		>
			<defs>
				<clipPath id={clipId}>
					<path d={wedge} />
				</clipPath>
			</defs>
			<path d={wedge} fill={ink} fillOpacity={0.12} />
			<CrispLine
				d={coneWedge(d, d.prior.yaw, d.prior.hfov, reach, S)}
				color={PRIOR_INK}
				width={1.3}
				dash="5 4"
				opacity={0.45 + 0.4 * (1 - tc)}
				seed="story-prior"
			/>
			{/* the skyline footprint: the part of the ground the live cone sees */}
			<g clipPath={`url(#${clipId})`}>
				{runs.map((r) => (
					<SketchPolyline
						key={`${r.az0}-${r.az1}`}
						points={r.pts}
						seed={`${d.id}-sm-fp-${r.az0}`}
						data
						passes={1}
						color={TERRAIN_INK}
						width={1.6}
						opacity={0.95}
					/>
				))}
			</g>
			<CrispLine d={wedge} color={ink} width={2} seed="story-live" />
			{placed.map(({ p, x, y }, rank) => {
				const k = rayDraw(rayT ?? t, rank, placed.length);
				if (k <= 0.01) return null;
				return (
					<PenLine
						key={p.name}
						from={[S / 2, S / 2]}
						to={[S / 2 + k * (x - S / 2), S / 2 + k * (y - S / 2)]}
						seed={`${d.id}-sm-ray-${p.name}`}
						color={LAYER_INKS.solved.paper}
						width={1.2}
					/>
				);
			})}
			{Math.abs(sweep) > 0.15 && (
				<g>
					<SketchPath
						d={`M${p0[0]} ${p0[1]}A${arcR} ${arcR} 0 0 ${sweep > 0 ? 1 : 0} ${p1[0]} ${p1[1]}`}
						seed="story-arc"
						color="var(--gb-red)"
						width={1.8}
						passes={1}
						tolerance={0.5}
					/>
					<HandLabel
						x={mid[0]}
						y={mid[1] + 4}
						anchor="middle"
						size={13}
						color="var(--gb-red)"
					>
						{`${sgn(sweep)}°`}
					</HandLabel>
				</g>
			)}
			{placed.map(({ p, x, y, rim, km, label }) => {
				const inside = Math.abs(wrap180(p.az - live.yaw)) <= live.hfov / 2;
				const color = (inside && peakInk(t, true)) || "var(--gb-pencil)";
				const flip = rim ? x > S / 2 : x > S - 90;
				const ax = Math.sin(p.az * RAD);
				const ay = -Math.cos(p.az * RAD);
				return (
					<g
						key={p.name}
						opacity={inside ? 1 : 0.32}
						style={{ transition: `opacity ${MOTION.quick}ms ease-out` }}
					>
						{rim ? (
							<path
								d={`M${x - ay * 6} ${y + ax * 6}L${x + ay * 6} ${y - ax * 6}`}
								fill="none"
								strokeWidth={1.6}
								strokeLinecap="round"
								style={{ stroke: color }}
							/>
						) : (
							<path
								d={`M${x} ${y - 4}l-3.6 6.2h7.2z`}
								style={{ fill: color }}
							/>
						)}
						{label && (
							<>
								<HandLabel
									x={flip ? x - 6 : x + 6}
									y={y + 2}
									anchor={flip ? "end" : "start"}
									size={10.5}
									halo={2.8}
									color={color}
									caps
								>
									{p.name}
								</HandLabel>
								{rim && (
									<HandLabel
										x={flip ? x - 6 : x + 6}
										y={y + 13}
										anchor={flip ? "end" : "start"}
										size={9.5}
										halo={2.8}
										color={color}
										italic
									>
										{`${km} km`}
									</HandLabel>
								)}
							</>
						)}
					</g>
				);
			})}
		</svg>
	);
}

/** Crops the map's square to the cone's box at `aspect` (spec M §4, "fit"). */
function FitFrame({
	box,
	aspect,
	children,
}: {
	box: { x: number; y: number; w: number; h: number };
	aspect: number;
	children: ReactNode;
}) {
	return (
		<div
			className="relative w-full overflow-hidden"
			style={{ aspectRatio: aspect }}
		>
			<div
				className="absolute"
				style={{
					left: `${(-box.x / box.w) * 100}%`,
					top: `${(-box.y / box.h) * 100}%`,
					width: `${(S / box.w) * 100}%`,
				}}
			>
				{children}
			</div>
		</div>
	);
}

export function StoryMap({
	data: d,
	search = false,
	readout = true,
	className,
	crop,
	maxLabels,
	fit,
	aspect = 4 / 3,
}: {
	data: GipfelbuchPhotoData | null;
	/** Play the yaw search on its own when no story drives the map. */
	search?: boolean;
	/** The yaw line under the map (guess → solved, correction). */
	readout?: boolean;
	className?: string;
	/** The photo's crop in working px: the map names the peaks the photo names there. */
	crop?: [number, number, number, number];
	/** The photo's label cap (default 10, as RealPhoto). */
	maxLabels?: number;
	/** `cone`: crop the square to the camera and both cones, at `aspect` (w / h). */
	fit?: "cone";
	aspect?: number;
}) {
	const story = useAlignmentStory();
	const [ref, searched] = useSearchClock(search && !story);
	const dragging = useRef(false);
	const bodyRef = useRef<HTMLDivElement>(null);
	const width = useWidth(bodyRef);
	const t = useFollowT(
		story ? story.t : 1,
		!!story,
		dragging,
		(story as { instant?: boolean } | null)?.instant,
	);
	const tNow = story ? t : search ? searched.t : 1;
	const cropKey = crop?.join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: crop is keyed by value
	const set = useMemo(
		() => (d ? mapPeakSet(d, { crop, maxLabels }) : null),
		[d, cropKey, maxLabels],
	);
	const runs = useMemo(() => (d ? footprintRuns(d, S) : []), [d]);
	const placed = useMemo(
		() => (d && set ? declutterRim(placeNamed(d, set.named, S)) : []),
		[d, set],
	);
	const box = useMemo(
		() => (d && fit === "cone" ? coneFitBox(d, aspect) : null),
		[d, fit, aspect],
	);
	if (!d || !set) return <DemPatch data={null} className={className} />;
	const dyaw = wrap180(d.solved.yaw - d.prior.yaw);
	const settled = story ? Math.abs(story.t - t) < 0.01 : true;
	const stateWord =
		tNow <= 0.02 ? "phone's guess" : tNow >= 0.98 ? "solved" : "correcting";
	const fromMap = (e: PointerEvent<HTMLDivElement>) => {
		if (!story || Math.abs(dyaw) < 0.2) return;
		const svg = e.currentTarget.querySelector("svg");
		const r = (svg ?? e.currentTarget).getBoundingClientRect();
		const az =
			Math.atan2(
				e.clientX - (r.left + r.width / 2),
				-(e.clientY - (r.top + r.height / 2)),
			) / RAD;
		story.setT(wrap180(az - d.prior.yaw) / dyaw);
	};
	const key = (e: KeyboardEvent<HTMLDivElement>) => {
		const step =
			e.key === "ArrowLeft" || e.key === "ArrowDown"
				? -0.1
				: e.key === "ArrowRight" || e.key === "ArrowUp"
					? 0.1
					: 0;
		if (!story || !step) return;
		e.preventDefault();
		story.setT(story.t + step);
	};
	const release = () => {
		dragging.current = false;
	};
	const stack = (
		<div className="relative">
			<BaseMap d={d} runs={runs} context={set.context} furniture={!box} />
			<LiveLayer
				d={d}
				t={tNow}
				runs={runs}
				placed={width > 0 && width < 280 ? placed.slice(0, 4) : placed}
				opacity={search && !story ? searched.opacity : 1}
				rayT={search && !story ? 0.82 + 0.18 * searched.rays : undefined}
			/>
		</div>
	);
	return (
		<div
			ref={ref}
			className={cn(!fit && "mx-auto w-full max-w-[22rem]", className)}
		>
			<div
				ref={bodyRef}
				className={cn(
					"relative select-none",
					story && "cursor-grab touch-pan-y active:cursor-grabbing",
				)}
				{...(story && {
					role: "slider",
					tabIndex: 0,
					"aria-label":
						"Turn the camera from the phone's guess to the solved pose",
					"aria-valuemin": 0,
					"aria-valuemax": 100,
					"aria-valuenow": Math.round(story.t * 100),
					onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
						dragging.current = true;
						e.currentTarget.setPointerCapture?.(e.pointerId);
						fromMap(e);
					},
					onPointerMove: (e: PointerEvent<HTMLDivElement>) =>
						e.buttons && fromMap(e),
					onPointerUp: release,
					onPointerCancel: release,
					onLostPointerCapture: release,
					onKeyDown: key,
				})}
			>
				{box ? (
					<FitFrame box={box} aspect={aspect}>
						{stack}
					</FitFrame>
				) : (
					stack
				)}
				<span
					className={cn(
						"nb-hand pointer-events-none absolute top-1.5 left-2.5 text-[20px] leading-[22px] font-bold transition-colors motion-reduce:transition-none [text-shadow:0_0_2px_var(--gb-paper,#ece6da),0_0_4px_var(--gb-paper,#ece6da),0_0_6px_var(--gb-paper,#ece6da)]",
						settled && tNow >= 0.98
							? "text-[var(--sm-solved)]"
							: "text-[var(--sm-prior)]",
					)}
					style={
						{
							"--sm-solved": inkFor("solved", "paper"),
							"--sm-prior": inkFor("prior", "paper"),
						} as CSSProperties
					}
				>
					{stateWord}
				</span>
			</div>
			{readout && (
				<p className="nb-num gb-secondary mt-1.5 text-[12px] leading-[16px]">
					yaw{" "}
					<span className={tNow < 0.5 ? "text-[var(--gb-ink)]" : undefined}>
						{d.prior.yaw.toFixed(1)}°
					</span>{" "}
					→{" "}
					<span className={tNow >= 0.5 ? "text-[var(--gb-ink)]" : undefined}>
						{d.solved.yaw.toFixed(1)}°
					</span>{" "}
					· {set.named.length} peaks named
					{story ? (
						<span className="print:hidden"> · drag the cone</span>
					) : null}
				</p>
			)}
		</div>
	);
}
