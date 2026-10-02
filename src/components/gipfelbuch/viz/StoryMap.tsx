// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	type CSSProperties,
	type KeyboardEvent,
	type PointerEvent,
	useEffect,
	useState,
} from "react";
import { cn } from "#/lib/utils";
import { SketchPath } from "../notebook/Ink";
import { SWISS } from "../swiss/inks";
import { useInView, useReducedMotion } from "./hooks";
import { inkFor, LAYER_INKS } from "./inks";
import {
	CrispLine,
	coneWedge,
	DemPatch,
	type GipfelbuchPhotoData,
} from "./real";
import { poseAt, useAlignmentStory, useTween } from "./story";

// The side map of an alignment story: the DEM patch around the camera with the view cone at the
// story's position between the phone's guess and the solved pose. The guess (dashed) and the solved
// cone (hairline) stay as ghosts, an arc measures the compass correction, and summits light up as the
// cone sweeps over them. Inside an AlignmentStoryProvider the map follows the wipe or stage, and
// dragging round the camera (or the arrow keys) drives the story from the map.

/** Cone inks on paper, from the one layer table (the same as DemPatch's cones). Hex, so they can be mixed. */
const PRIOR_INK = LAYER_INKS.prior.paperHex;
const SOLVED_INK = LAYER_INKS.solved.paperHex;
/** Hand block capitals for summit names (hand pass). */
const CAPS = "var(--gb-font-caps), var(--gb-font-hand), cursive";
/** DemPatch's square viewBox side. */
const S = 400;
const RAD = Math.PI / 180;
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const sgn = (v: number) =>
	`${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;

function mixHex(a: string, b: string, t: number): string {
	const c = (h: string, i: number) => Number.parseInt(h.slice(i, i + 2), 16);
	const u = Math.min(1, Math.max(0, t));
	return `#${[1, 3, 5]
		.map((i) =>
			Math.round(c(a, i) + (c(b, i) - c(a, i)) * u)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

/**
 * "Try small turns": with no story around it, the map can play the search itself, a damped sweep
 * either side of the guess that settles on the solved pose. Static at the solved pose under reduced
 * motion and automation.
 */
function useSearchSweep(
	on: boolean,
): [ReturnType<typeof useInView<HTMLDivElement>>[0], number] {
	const [ref, inView] = useInView<HTMLDivElement>({ once: false });
	const reduce = useReducedMotion();
	const [t, setT] = useState(1);
	useEffect(() => {
		if (!on || !inView || reduce || navigator.webdriver) {
			setT(1);
			return;
		}
		const period = 5200;
		const t0 = performance.now();
		let raf = 0;
		let lastFrame = Number.NEGATIVE_INFINITY;
		const tick = (now: number) => {
			raf = requestAnimationFrame(tick);
			// 30 fps cap: a state update per display frame (120 Hz) re-renders the map for no visible gain
			if (now - lastFrame < 1000 / 30 - 2) return;
			lastFrame = now;
			const u = ((now - t0) % period) / (period * 0.72);
			// from the guess, overshoot both ways, settle; then hold on the solution
			setT(u >= 1 ? 1 : 1 - Math.cos(3 * Math.PI * u) * (1 - u) ** 1.4);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [on, inView, reduce]);
	return [ref, t];
}

export function StoryMap({
	data: d,
	search = false,
	readout = true,
	className,
}: {
	data: GipfelbuchPhotoData | null;
	/** Play the yaw search on its own when no story drives the map. */
	search?: boolean;
	/** The yaw line under the map (guess → solved, correction). */
	readout?: boolean;
	className?: string;
}) {
	const story = useAlignmentStory();
	const [ref, swept] = useSearchSweep(search && !story);
	const tStory = useTween(story ? story.t : 1);
	const t = story ? tStory : search ? swept : 1;
	if (!d) return <DemPatch data={null} className={className} />;
	const dyaw = wrap180(d.solved.yaw - d.prior.yaw);
	const live = poseAt(d, t);
	const half = d.demPatch.halfKm * 1000;
	const reach = half * 1.6;
	const settled = story ? Math.abs(story.t - tStory) < 0.01 : true;
	const stateWord =
		t <= 0.02 ? "phone's guess" : t >= 0.98 ? "solved" : "correcting";
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
	return (
		<div ref={ref} className={className}>
			<div
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
						e.currentTarget.setPointerCapture?.(e.pointerId);
						fromMap(e);
					},
					onPointerMove: (e: PointerEvent<HTMLDivElement>) =>
						e.buttons && fromMap(e),
					onKeyDown: key,
				})}
			>
				<DemPatch data={d} cone={[]} peaks={false} imprint={false}>
					{(_, toPx) => {
						const wedge = (yaw: number, hfov: number, dist: number) =>
							coneWedge(d, yaw, hfov, dist, S);
						const ink = mixHex(PRIOR_INK, SOLVED_INK, t);
						// the correction arc, from the guess's heading to the live heading
						const arcR = S * 0.17;
						const arcDist = (arcR * 2 * half) / S;
						const p0 = toPx(d.prior.yaw, arcDist);
						const p1 = toPx(live.yaw, arcDist);
						const sweep = wrap180(live.yaw - d.prior.yaw);
						const mid = toPx(
							d.prior.yaw + sweep / 2,
							arcDist + (26 * 2 * half) / S,
						);
						const peaks = d.peaks
							.filter((p) => p.labelled && p.distance < half * 1.35)
							.map((p) => {
								const [x, y] = toPx(p.az, p.distance);
								const inside =
									Math.abs(wrap180(p.az - live.yaw)) <= live.hfov / 2;
								return { p, x, y, inside };
							})
							.filter(({ x, y }) => x > 4 && y > 4 && x < S - 4 && y < S - 4);
						return (
							<g>
								<path
									d={wedge(live.yaw, live.hfov, reach)}
									fill={ink}
									fillOpacity={0.12}
								/>
								<CrispLine
									d={wedge(d.prior.yaw, d.prior.hfov, reach)}
									color={PRIOR_INK}
									width={1.3}
									dash="5 4"
									opacity={0.45 + 0.4 * (1 - Math.min(1, Math.max(0, t)))}
									seed="story-prior"
								/>
								<SketchPath
									d={wedge(d.solved.yaw, d.solved.hfov, reach)}
									seed="story-solved-ghost"
									color={SOLVED_INK}
									width={0.9}
									opacity={0.6}
									passes={1}
									tolerance={0.5}
								/>
								<CrispLine
									d={wedge(live.yaw, live.hfov, reach)}
									color={ink}
									width={2}
									seed="story-live"
								/>
								{Math.abs(sweep) > 0.15 && (
									<g>
										<SketchPath
											d={`M${p0[0]} ${p0[1]}A${arcR} ${arcR} 0 0 ${sweep > 0 ? 1 : 0} ${p1[0]} ${p1[1]}`}
											seed="story-arc"
											color={SWISS.red}
											width={1.8}
											passes={1}
											tolerance={0.5}
										/>
										<text
											x={mid[0]}
											y={mid[1] + 4}
											textAnchor="middle"
											fontSize={13}
											stroke={SWISS.paper}
											strokeWidth={3}
											paintOrder="stroke"
											strokeLinejoin="round"
											className="nb-num"
											style={{ fill: SWISS.red }}
										>
											{sgn(sweep)}°
										</text>
									</g>
								)}
								{peaks.map(({ p, x, y, inside }) => {
									const flip = x > S - 90;
									return (
										<g
											key={p.name}
											opacity={inside ? 1 : 0.32}
											style={{ transition: "opacity 220ms ease-out" }}
										>
											<path
												d={`M${x} ${y - 4}l-3.6 6.2h7.2z`}
												fill={inside ? SWISS.navy : SWISS.secondary}
											/>
											<text
												x={flip ? x - 6 : x + 6}
												y={y + 2}
												textAnchor={flip ? "end" : "start"}
												fontSize={11.5}
												stroke={SWISS.paper}
												strokeWidth={2.8}
												strokeLinejoin="round"
												paintOrder="stroke"
												className="nb-label"
												style={{
													fill: inside ? SWISS.navy : SWISS.secondary,
													fontFamily: CAPS,
												}}
											>
												{p.name}
											</text>
										</g>
									);
								})}
							</g>
						);
					}}
				</DemPatch>
				<span
					className={cn(
						"nb-hand pointer-events-none absolute top-1.5 left-2.5 text-[20px] leading-[22px] font-bold transition-colors motion-reduce:transition-none [text-shadow:0_0_2px_var(--gb-paper,#ece6da),0_0_4px_var(--gb-paper,#ece6da),0_0_6px_var(--gb-paper,#ece6da)]",
						settled && t >= 0.98
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
					<span className={t < 0.5 ? "text-[var(--gb-ink)]" : undefined}>
						{d.prior.yaw.toFixed(1)}°
					</span>{" "}
					→{" "}
					<span className={t >= 0.5 ? "text-[var(--gb-ink)]" : undefined}>
						{d.solved.yaw.toFixed(1)}°
					</span>{" "}
					· {d.peaks.filter((p) => p.labelled).length} peaks named
					{story ? " · drag the cone" : ""}
				</p>
			)}
		</div>
	);
}
