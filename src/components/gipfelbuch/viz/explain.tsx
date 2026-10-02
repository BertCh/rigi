// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { cn } from "#/lib/utils";
import {
	HandDot,
	PenArrow,
	PenCircle,
	SketchPath,
	StepNumber,
} from "../notebook/Ink";
import { TYPE } from "../swiss/type";
import { FigureSkeleton } from "./FigureSkeleton";
import { HandFrame, HandLoop, HandSideRule, HandUnderline } from "./hand";
import { useInView, useReducedMotion } from "./hooks";
import { dashFor, inkFor, layerOfColor, type PhotoLayer } from "./inks";
import {
	CrispLine,
	GIPFELBUCH_PHOTO_IDS,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	NoImprint,
	useGipfelbuchPhoto,
	useLoadFailure,
} from "./real";
import { HandHeading, HandKicker } from "./Section";
import {
	COMPARE_COMMIT_MS,
	compareIntroX,
	compareKeyX,
	compareSide,
	stageFrameKey,
	stagesInitialIndex,
	useOpenForPrint,
	useSequenceMotion,
} from "./sequence";
import { SpillSideContext, useAlignmentStory } from "./story";

// Layout effect on the client (the wipe repaints before paint), plain effect on the server.
const useIsomorphicLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;

// Explainer kit: the building blocks of a concise, visual-first concept page.
// The recipe (see README "Explainer pages"): a hero figure on a real photo whose caption is the claim,
// then 2-4 short beats (headline = claim, 1-3 sentences, one figure each), and the engineering detail
// folded into <Details>. Copy in beats stays plain: no code identifiers, one number per sentence.

/** Short beat: a lettered headline that states the claim, up to three sentences, then its figure. */
export function Beat({
	kicker,
	title,
	children,
	figure,
	className,
}: {
	kicker?: string;
	title: string;
	children?: ReactNode;
	figure?: ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("mt-12 first:mt-2", className)}>
			{kicker && <HandKicker className="mb-2">{kicker}</HandKicker>}
			<HandHeading title={title} className="max-w-2xl" />
			{children && (
				<div className="mt-3 max-w-[66ch] space-y-3 text-[16px] leading-[24px] text-[var(--gb-ink)] [&_strong]:font-semibold [&_strong]:text-[var(--gb-ink)] [&_em]:text-[var(--gb-ink)] [&_a]:text-[var(--gb-water,var(--accent))] hover:[&_a]:underline">
					{children}
				</div>
			)}
			{figure}
		</section>
	);
}

/**
 * Collapsed in-depth detail. Keeps the precise mechanism on the page without making everyone read it.
 * Opens for printing, so the print sheet keeps the mechanism.
 */
export function Details({
	title = "How it works, in depth",
	children,
	className,
}: {
	title?: string;
	children: ReactNode;
	className?: string;
}) {
	const ref = useRef<HTMLDetailsElement>(null);
	useOpenForPrint(ref);
	return (
		<details ref={ref} className={cn("group relative mt-12", className)}>
			<summary className="flex cursor-pointer list-none items-center gap-3 py-2 pr-5 select-none [&::-webkit-details-marker]:hidden">
				<svg
					viewBox="0 0 14 14"
					className="size-3.5 shrink-0 overflow-visible transition group-open:rotate-90 motion-reduce:transition-none"
					aria-hidden="true"
				>
					<SketchPath
						d="M3 1.5L11.5 7L3 12.5Z"
						seed={`details-${title}`}
						color="red"
						width={1.4}
						tolerance={0.5}
					/>
				</svg>
				<span className="nb-hand relative text-[22px] leading-[26px] font-bold text-[var(--gb-ink)]">
					{title}
					<HandUnderline
						seed={`details-${title}`}
						color="pencil"
						width={1.1}
						opacity={0.6}
						offset={-3}
					/>
				</span>
			</summary>
			<div className="relative mt-2 space-y-4 pr-2 pb-6 pl-6 text-[13px] leading-[1.7] text-[var(--gb-ink)] [&_a]:text-[var(--gb-water,var(--accent))] [&_code]:bg-[var(--gb-paper-deep)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-[var(--gb-ink)] [&_kbd]:bg-[var(--gb-paper-deep)] [&_kbd]:px-1.5 [&_kbd]:font-mono [&_kbd]:text-[13px] [&_h3]:mt-6 [&_h3]:font-semibold [&_h3]:text-[var(--gb-ink)] [&_li]:pl-1 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5 [&_strong]:text-[var(--gb-ink)] [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
				<HandSideRule
					seed={`details-side-${title}`}
					color="pencil"
					width={1.2}
					opacity={0.55}
				/>
				{children}
			</div>
		</details>
	);
}

const SPILL_OFF = { off: true };
/** A side label at rest: the side filling less of the frame is drawn lighter. */
const LABEL_DIM = 0.55;

/**
 * Before/after on the same frame: drag (or the arrow, Home and End keys) to wipe between two pixel-aligned
 * renderings. In view, the intro plays once: the guess alone (setup), one programmed scrub to `start`
 * (change), then rest (result). A drag writes the clip and the handle straight to the DOM, as the
 * landing's Compare does, and hands its position to React (story time, spill, side map) at most once
 * a frame at 30 fps and on release. A position set from outside (the side map) ends the intro. The server render, reduced motion, webdriver and print rest at `start`. Touch
 * keeps vertical page scroll (touch-action: pan-y).
 * `spill="pose"` (default): the two sides are two poses, and the geo spill follows the wipe. `"static"`:
 * the sides are not poses (two DEM rasters, a layer split), so the margins stay put.
 */
export function Compare({
	before,
	after,
	beforeLabel,
	afterLabel,
	start = 0.5,
	spill = "pose",
	className,
}: {
	before: ReactNode;
	after: ReactNode;
	beforeLabel: string;
	afterLabel: string;
	start?: number;
	spill?: "pose" | "static";
	className?: string;
}) {
	const [ref, inView] = useInView();
	const reduce = useReducedMotion();
	const motion = useSequenceMotion(reduce);
	// inside an alignment story the wipe is the story's position (x = 1 - t: all "after" at x = 0)
	const story = useAlignmentStory();
	const [localX, setLocalX] = useState(start);
	const committedX = story ? 1 - story.t : localX;
	// the live wipe position; React state (committedX) trails it during a drag or the intro
	const xRef = useRef(committedX);
	const lastCommitted = useRef(committedX);
	const commitTimer = useRef(0);
	const dragging = useRef(false);
	const touched = useRef(false);
	const box = useRef<HTMLDivElement>(null);
	const clip = useRef<HTMLDivElement>(null);
	const handle = useRef<HTMLDivElement>(null);
	const slider = useRef<HTMLDivElement>(null);
	const beforeTag = useRef<HTMLSpanElement>(null);
	const afterTag = useRef<HTMLSpanElement>(null);
	const sideText = (v: number) =>
		compareSide(v) === "before" ? beforeLabel : afterLabel;
	const paint = (v: number) => {
		if (clip.current) clip.current.style.clipPath = `inset(0 0 0 ${v * 100}%)`;
		if (handle.current) handle.current.style.left = `${v * 100}%`;
		if (slider.current) {
			slider.current.setAttribute("aria-valuenow", String(Math.round(v * 100)));
			slider.current.setAttribute("aria-valuetext", sideText(v));
		}
		const side = compareSide(v);
		if (beforeTag.current)
			beforeTag.current.style.opacity =
				side === "before" ? "1" : `${LABEL_DIM}`;
		if (afterTag.current)
			afterTag.current.style.opacity = side === "after" ? "1" : `${LABEL_DIM}`;
	};
	const setStoryT = story?.setT;
	const commit = (v: number) => {
		window.clearTimeout(commitTimer.current);
		commitTimer.current = 0;
		lastCommitted.current = v;
		if (setStoryT) setStoryT(1 - v);
		else setLocalX(v);
	};
	const commitRef = useRef(commit);
	commitRef.current = commit;
	const apply = (v: number) => {
		xRef.current = v;
		paint(v);
		if (!commitTimer.current)
			commitTimer.current = window.setTimeout(() => {
				commitTimer.current = 0;
				commitRef.current(xRef.current);
			}, COMPARE_COMMIT_MS);
	};
	const applyRef = useRef(apply);
	applyRef.current = apply;
	// after every render: adopt a position someone else set (the side map turning the story), then
	// repaint the live position over the (possibly trailing) committed styles React just wrote
	useIsomorphicLayoutEffect(() => {
		if (Math.abs(committedX - lastCommitted.current) > 1e-6) {
			lastCommitted.current = committedX;
			// someone else moved the story: the reader takes over (the intro stops), unless mid-drag
			if (!dragging.current) {
				window.clearTimeout(commitTimer.current);
				commitTimer.current = 0;
				touched.current = true;
				xRef.current = committedX;
			}
		}
		paint(xRef.current);
	});
	useEffect(
		() => () => {
			window.clearTimeout(commitTimer.current);
			commitTimer.current = 0;
		},
		[],
	);
	// setup frame: once motion is allowed (client, not automation), the untouched wipe waits on the
	// guess; a layout effect, so a client mount does not paint the result frame first
	useIsomorphicLayoutEffect(() => {
		if (!motion || touched.current) return;
		applyRef.current(1);
		commitRef.current(1);
	}, [motion]);
	// the intro script, once, in view: hold the guess, scrub to `start`, rest
	useEffect(() => {
		if (!inView || !motion || touched.current) return;
		let raf = 0;
		const t0 = performance.now();
		const tick = (now: number) => {
			if (touched.current) return;
			const { x, done } = compareIntroX(now - t0, start);
			applyRef.current(x);
			if (done) return commitRef.current(x);
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [inView, motion, start]);
	// print rests on the result frame
	useEffect(() => {
		const toStart = () => {
			touched.current = true;
			applyRef.current(start);
			// commit synchronously, so the story, spill and side map print on the result frame too
			flushSync(() => commitRef.current(start));
		};
		window.addEventListener("beforeprint", toStart);
		return () => window.removeEventListener("beforeprint", toStart);
	}, [start]);
	const move = (e: PointerEvent) => {
		const r = box.current?.getBoundingClientRect();
		if (!r || r.width === 0) return;
		apply(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
	};
	const release = () => {
		if (!dragging.current) return;
		dragging.current = false;
		commit(xRef.current);
	};
	const key = (e: KeyboardEvent) => {
		const v = compareKeyX(e.key, xRef.current);
		if (v == null) return;
		e.preventDefault();
		touched.current = true;
		apply(v);
		commit(v);
	};
	const side = compareSide(committedX);
	return (
		<div ref={ref} className={className}>
			<NoImprint>
				<div
					ref={box}
					className="relative cursor-ew-resize touch-pan-y select-none"
					onPointerDown={(e) => {
						(e.target as Element).setPointerCapture?.(e.pointerId);
						touched.current = true;
						dragging.current = true;
						move(e);
					}}
					onPointerMove={(e) => dragging.current && move(e)}
					onPointerUp={release}
					onPointerCancel={release}
				>
					{/* one geo spill in the margins, carried by the bottom side at the wipe's position */}
					{spill === "pose" ? (
						<SpillSideContext.Provider value={{ t: 1 - committedX }}>
							{before}
						</SpillSideContext.Provider>
					) : (
						before
					)}
					<div
						ref={clip}
						className="pointer-events-none absolute inset-0"
						style={{ clipPath: `inset(0 0 0 ${committedX * 100}%)` }}
					>
						<SpillSideContext.Provider value={SPILL_OFF}>
							{after}
						</SpillSideContext.Provider>
					</div>
					<div
						ref={handle}
						className="absolute inset-y-0 w-0"
						style={{ left: `${committedX * 100}%` }}
					>
						<svg
							viewBox="0 0 8 100"
							preserveAspectRatio="none"
							className="pointer-events-none absolute inset-y-0 left-[-4px] h-full w-2 overflow-visible [&_path]:[vector-effect:non-scaling-stroke]"
							aria-hidden="true"
						>
							<path
								d="M4 0L4 100"
								stroke="var(--gb-paper, #ece6da)"
								strokeOpacity={0.75}
								strokeWidth={5}
								fill="none"
							/>
							<SketchPath
								d="M4 0L4 100"
								seed="compare-wipe"
								color="red"
								width={2.2}
								passes={1}
								tolerance={0.8}
							/>
						</svg>
						<div
							ref={slider}
							role="slider"
							tabIndex={0}
							aria-label={`${beforeLabel} / ${afterLabel}`}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={Math.round(committedX * 100)}
							aria-valuetext={sideText(committedX)}
							onKeyDown={key}
							className="absolute top-1/2 left-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center text-[var(--gb-ink,currentColor)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gb-red,var(--accent))] print:hidden"
						>
							<svg
								viewBox="0 0 36 36"
								className="pointer-events-none absolute inset-0 overflow-visible"
								aria-hidden="true"
							>
								<HandDot
									x={18}
									y={18}
									r={16}
									seed="compare-blot"
									color="var(--gb-paper, #ece6da)"
									opacity={0.95}
								/>
								<PenCircle
									center={[18, 18]}
									radiusX={14}
									seed="compare-handle"
									color="red"
									width={1.6}
								/>
								<PenArrow
									seed="compare-left"
									from={[16, 18]}
									to={[8, 18]}
									bend={0.05}
									head={4}
									width={1.3}
								/>
								<PenArrow
									seed="compare-right"
									from={[20, 18]}
									to={[28, 18]}
									bend={0.05}
									head={4}
									width={1.3}
								/>
							</svg>
						</div>
					</div>
					<span
						ref={beforeTag}
						className={`${PHOTO_LABEL} left-2`}
						style={{ opacity: side === "before" ? 1 : LABEL_DIM }}
					>
						{beforeLabel}
					</span>
					<span
						ref={afterTag}
						className={`${PHOTO_LABEL} right-2`}
						style={{ opacity: side === "after" ? 1 : LABEL_DIM }}
					>
						{afterLabel}
					</span>
				</div>
			</NoImprint>
		</div>
	);
}

export interface Stage {
	label: string;
	/** One sentence: what this stage adds. */
	caption: ReactNode;
	render: () => ReactNode;
	/** Where this stage sits in an enclosing alignment story: 0 = phone's guess, 1 = solved. */
	pose?: number;
	/**
	 * Stages with the same `frame` key keep one mounted frame (the photo is not remounted, only its
	 * layers change); stages without one each get their own frame and fade in.
	 */
	frame?: string;
}

/** A short pen arrow as a button glyph (prev/next); drawn in currentColor. */
function HandArrowIcon({ seed, dir }: { seed: string; dir: 1 | -1 }) {
	return (
		<svg
			viewBox="0 0 24 16"
			className="h-4 w-6 overflow-visible"
			aria-hidden="true"
		>
			<PenArrow
				seed={seed}
				from={dir > 0 ? [3, 9] : [21, 9]}
				to={dir > 0 ? [21, 8] : [3, 8]}
				bend={0.12}
				head={6}
				color="currentColor"
				width={1.5}
			/>
		</svg>
	);
}

/** Labels on a photo: hand block capitals with a paper halo (no chip). */
const PHOTO_LABEL =
	"gb-caps pointer-events-none absolute top-2 text-[13px] leading-[16px] text-[var(--gb-ink,#131313)] [text-shadow:0_0_2px_var(--gb-paper,#ece6da),0_0_3px_var(--gb-paper,#ece6da),0_0_5px_var(--gb-paper,#ece6da),0_0_7px_var(--gb-paper,#ece6da)]";

/**
 * Step through stages of one process on the same frame (tabs circled by hand + pen-arrow prev/next).
 * The static frame (server render, reduced motion, webdriver, print) is the last stage; where motion is
 * allowed the client steps back to the first and auto-advances while on screen, pausing while a mouse
 * rests on the frame, until the reader picks a stage. Print adds every stage's caption as a list.
 */
export function Stages({
	stages,
	interval = 3200,
	aside,
	className,
}: {
	stages: Stage[];
	interval?: number;
	/** A view kept beside the frame across stages, e.g. the story's side map. */
	aside?: ReactNode;
	className?: string;
}) {
	const [ref, inView] = useInView({ once: false });
	const reduce = useReducedMotion();
	const motion = useSequenceMotion(reduce);
	const last = stagesInitialIndex(stages.length);
	const [i, setI] = useState(last);
	const [playing, setPlaying] = useState(true);
	const [held, setHeld] = useState(false);
	// the static frame is the result; once motion is allowed the client steps back to the first stage
	const stepped = useRef(false);
	useIsomorphicLayoutEffect(() => {
		if (!motion || stepped.current) return;
		stepped.current = true;
		setI(0);
	}, [motion]);
	useEffect(() => {
		// synchronously, so the printed frame is the result
		const toResult = () => flushSync(() => setI(last));
		window.addEventListener("beforeprint", toResult);
		return () => window.removeEventListener("beforeprint", toResult);
	}, [last]);
	useEffect(() => {
		if (!playing || held || !inView || !motion) return;
		const id = window.setTimeout(
			() => setI((v) => (v + 1) % stages.length),
			i === stages.length - 1 ? interval * 1.6 : interval,
		);
		return () => window.clearTimeout(id);
	}, [playing, held, inView, motion, i, interval, stages.length]);
	const go = (n: number) => {
		stepped.current = true;
		setPlaying(false);
		// the frame under the pointer may remount and never report its pointerleave
		setHeld(false);
		setI((n + stages.length) % stages.length);
	};
	const s = stages[Math.min(i, last)];
	// a stage with a pose moves the enclosing alignment story there (only when the stage's pose
	// changes: the story's setT changes identity with every t, so it is read through a ref) ...
	const story = useAlignmentStory();
	const setStoryT = useRef(story?.setT);
	setStoryT.current = story?.setT;
	// the pose this component last wrote and the story has not reflected yet
	const pendingPose = useRef<number | null>(null);
	const currentT = useRef(story?.t);
	currentT.current = story?.t;
	useEffect(() => {
		if (!setStoryT.current || s.pose == null) return;
		// a write that changes nothing is never echoed back, so it is not waited for
		if (currentT.current == null || Math.abs(currentT.current - s.pose) > 1e-6)
			pendingPose.current = s.pose;
		setStoryT.current(s.pose);
	}, [s.pose]);
	// ... and a reader turning the story elsewhere (the side map) brings up the matching stage; the
	// story's own initial t and the echo of our own write are not the reader
	const storyT = story?.t;
	const posed = useRef({ stages, pose: s.pose });
	posed.current = { stages, pose: s.pose };
	useEffect(() => {
		const { stages: all, pose } = posed.current;
		if (storyT == null) return;
		if (pendingPose.current != null) {
			if (Math.abs(storyT - pendingPose.current) <= 1e-6)
				pendingPose.current = null;
			return;
		}
		if (pose == null || Math.abs(storyT - pose) <= 0.5) return;
		let best = -1;
		all.forEach((st, n) => {
			if (
				st.pose != null &&
				(best < 0 ||
					Math.abs(st.pose - storyT) <
						Math.abs((all[best].pose as number) - storyT))
			)
				best = n;
		});
		if (best >= 0) {
			stepped.current = true;
			setPlaying(false);
			setHeld(false);
			setI(best);
		}
	}, [storyT]);
	return (
		<div
			ref={ref}
			className={cn("py-2 [container-type:inline-size]", className)}
		>
			<div className="mb-3 flex items-start gap-1.5 print:hidden">
				{/* one row of equal tabs from 560 px of container width, two columns below */}
				<div className="grid min-w-0 flex-1 grid-cols-2 gap-x-1.5 [@container(min-width:560px)]:auto-cols-fr [@container(min-width:560px)]:grid-flow-col [@container(min-width:560px)]:grid-cols-none">
					{stages.map((st, n) => (
						<button
							key={st.label}
							type="button"
							onClick={() => go(n)}
							aria-pressed={n === i}
							className={cn(
								"gb-caps relative min-w-0 px-3 pt-1.5 pb-2 text-left text-[13px] leading-[16px] transition-colors motion-reduce:transition-none",
								n === i
									? "text-[var(--gb-ink)]"
									: "text-[var(--gb-secondary,#4a545c)] hover:text-[var(--gb-ink)]",
							)}
						>
							<span className="nb-num mr-1.5 text-[var(--gb-contour,inherit)] normal-case">
								{n + 1}.
							</span>
							{st.label}
							{n === i && (
								<HandLoop
									seed={`stage-tab-${st.label}`}
									color="red"
									width={1.6}
									inset={-1}
								/>
							)}
						</button>
					))}
				</div>
				<button
					type="button"
					onClick={() => setPlaying((p) => !p)}
					aria-label={playing ? "Pause" : "Play"}
					// nothing plays where motion is not allowed: the button keeps its place but is hidden
					aria-hidden={!motion || undefined}
					tabIndex={motion ? undefined : -1}
					className={cn(
						"nb-hand relative mt-0.5 mr-1 shrink-0 px-2 text-[18px] leading-[24px] text-[var(--gb-secondary,#4a545c)] hover:text-[var(--gb-ink)]",
						!motion && "invisible",
					)}
				>
					{playing ? "pause" : "play"}
					<HandFrame
						seed="stages-play"
						color="pencil"
						width={1.1}
						overshoot={4}
					/>
				</button>
			</div>
			<div
				className={cn(
					aside &&
						"grid gap-3 [@container(min-width:720px)]:grid-cols-[minmax(0,1fr)_15rem] [@container(min-width:720px)]:items-start",
				)}
			>
				<div
					key={stageFrameKey(s, i)}
					className="animate-[gipfelbuch-fade_420ms_ease-out] motion-reduce:animate-none"
					// a photo's geo spill keeps off the side map
					data-gb-bleed-bounds={aside ? "right" : undefined}
					// a mouse resting on the frame holds the clock (a hover is not a choice: autoplay resumes)
					onPointerEnter={(e) => e.pointerType === "mouse" && setHeld(true)}
					onPointerLeave={() => setHeld(false)}
				>
					<NoImprint>{s.render()}</NoImprint>
				</div>
				{aside && <NoImprint>{aside}</NoImprint>}
			</div>
			<div className="mt-3 flex items-start gap-3 print:hidden">
				<button
					type="button"
					onClick={() => go(i - 1)}
					aria-label="Previous stage"
					className="p-1 text-[var(--gb-secondary,#4a545c)] hover:text-[var(--gb-ink)]"
				>
					<HandArrowIcon seed="stages-prev" dir={-1} />
				</button>
				<p
					aria-live="polite"
					className="nb-hand min-h-[2.8em] flex-1 text-[19px] leading-[23px] text-[var(--gb-pencil,var(--gb-ink))]"
				>
					{s.caption}
				</p>
				<button
					type="button"
					onClick={() => go(i + 1)}
					aria-label="Next stage"
					className="p-1 text-[var(--gb-secondary,#4a545c)] hover:text-[var(--gb-ink)]"
				>
					<HandArrowIcon seed="stages-next" dir={1} />
				</button>
			</div>
			{/* print: the frame shows the result; every stage's caption follows as a numbered list */}
			<ol className="mt-3 hidden list-decimal space-y-1 pl-6 text-[13px] leading-[18px] text-[var(--gb-ink)] print:block">
				{stages.map((st) => (
					<li key={st.label}>
						<span className="gb-caps">{st.label}</span>: {st.caption}
					</li>
				))}
			</ol>
			<style>
				{"@keyframes gipfelbuch-fade{from{opacity:.25}to{opacity:1}}"}
			</style>
		</div>
	);
}

/** Three (or four) numbered steps side by side, each a small visual over a one-line explanation. */
export function Trio({
	steps,
	className,
}: {
	steps: { title: string; body: ReactNode; visual: ReactNode }[];
	className?: string;
}) {
	const [ref, on] = useInView();
	return (
		<div
			ref={ref}
			className={cn(
				// the wide figure track (as Figure): three visuals need ~240 px each to keep labels legible
				"my-6 grid gap-4 lg:mr-[calc(-66.667%-16px)]",
				steps.length >= 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3",
				className,
			)}
		>
			{steps.map((s, n) => (
				<div
					key={s.title}
					className={cn(
						"flex flex-col transition duration-700 motion-reduce:transition-none",
						on
							? "translate-none opacity-100"
							: "translate-y-4 opacity-0 print:translate-y-0 print:opacity-100",
					)}
					style={{ transitionDelay: `${n * 120}ms` }}
				>
					<div className="overflow-hidden">
						<NoImprint>{s.visual}</NoImprint>
					</div>
					<div className="mt-3 flex items-start gap-2">
						<StepNumber value={String(n + 1)} />
						<div>
							<div className="nb-hand pt-0.5 text-[21px] leading-[24px] font-bold text-[var(--gb-ink)]">
								{s.title}
							</div>
							<div className="mt-0.5 text-[13px] leading-snug text-[var(--gb-secondary,#4a545c)]">
								{s.body}
							</div>
						</div>
					</div>
				</div>
			))}
		</div>
	);
}

/** A row of headline numbers with an optional source line underneath. Space separates; no rules. */
export function Numbers({
	items,
	source,
	className,
}: {
	items: { value: string; label: string }[];
	source?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("my-12 lg:mr-[calc(-66.667%-16px)]", className)}>
			<div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-6">
				{items.map((it) => (
					<div key={it.label} className="min-w-0 [container-type:inline-size]">
						<div className="gb-num whitespace-nowrap text-[clamp(26px,14cqi,40px)] leading-[1.2] font-light text-[var(--gb-ink)] tabular-nums">
							{it.value}
						</div>
						<div className={`${TYPE.caption} mt-1.5`}>{it.label}</div>
					</div>
				))}
			</div>
			{source && <p className={`${TYPE.micro} gb-secondary mt-6`}>{source}</p>}
		</div>
	);
}

/** Small multiples over the demo photos: same view, same scale, one tile each. */
export function Gallery({
	ids = GIPFELBUCH_PHOTO_IDS,
	tile,
	label,
	tone,
	tag,
	cols = 4,
	className,
}: {
	ids?: readonly GipfelbuchPhotoId[];
	tile: (d: GipfelbuchPhotoData) => ReactNode;
	/** A short line under each tile (e.g. "accepted · 2.1 px"). */
	label?: (d: GipfelbuchPhotoData) => ReactNode;
	/** KR10: a caps tag over each label, so a failure reads apart from a result at a glance. */
	tone?: (d: GipfelbuchPhotoData) => GalleryTone;
	/**
	 * The verdict written on the tile, circled: "rejected" by default for a `failure` tone. Return a word
	 * ("ask", "refused", ...) to override it, or undefined for none (a non-failure tone draws no mark).
	 */
	tag?: (d: GipfelbuchPhotoData) => string | undefined;
	cols?: 2 | 3 | 4;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"grid grid-cols-2 gap-x-4 gap-y-6",
				cols === 3 && "sm:grid-cols-3",
				cols === 4 && "sm:grid-cols-3 lg:grid-cols-4",
				className,
			)}
		>
			{ids.map((id) => (
				<GalleryTile
					key={id}
					id={id}
					tile={tile}
					label={label}
					tone={tone}
					tag={tag}
				/>
			))}
		</div>
	);
}

export type GalleryTone = "result" | "failure" | "neutral";

const TONE_TAG: Record<GalleryTone, { text: string; color: string } | null> = {
	result: { text: "result", color: "var(--gb-forest)" },
	failure: { text: "failure", color: "var(--gb-red)" },
	neutral: null,
};

/** The circled hand tag drawn on a tile: a failure tone says "rejected" (or the caller's word); other tones only an explicit word. */
export function galleryVerdict(
	tone: GalleryTone,
	word?: string,
): { text: string; color: string } | undefined {
	if (tone === "failure")
		return { text: word ?? "rejected", color: "var(--gb-red)" };
	return word ? { text: word, color: "var(--gb-pencil)" } : undefined;
}

function GalleryTile({
	id,
	tile,
	label,
	tone,
	tag: verdictOf,
}: {
	id: GipfelbuchPhotoId;
	tile: (d: GipfelbuchPhotoData) => ReactNode;
	label?: (d: GipfelbuchPhotoData) => ReactNode;
	tone?: (d: GipfelbuchPhotoData) => GalleryTone;
	tag?: (d: GipfelbuchPhotoData) => string | undefined;
}) {
	const d = useGipfelbuchPhoto(id);
	const failedId = useLoadFailure(id);
	const kind = d && tone ? tone(d) : "neutral";
	const tag = d && tone ? TONE_TAG[kind] : null;
	const verdict = d ? galleryVerdict(kind, verdictOf?.(d)) : undefined;
	return (
		<div>
			{d ? (
				<div className="relative">
					<NoImprint>{tile(d)}</NoImprint>
					{verdict && (
						<span
							className="nb-hand pointer-events-none absolute top-2 right-2 inline-block rounded-full bg-[var(--gb-paper)]/85 px-2.5 text-[17px] leading-[22px]"
							style={{ color: verdict.color }}
						>
							{verdict.text}
							<HandLoop
								seed={`gallery-verdict-${id}`}
								color={kind === "failure" ? "red" : "pencil"}
								width={1.5}
								inset={-2}
							/>
						</span>
					)}
				</div>
			) : (
				<FigureSkeleton aspect={4 / 3} failedId={failedId} />
			)}
			{tag && (
				<p
					className="gb-caps relative mt-2 inline-block text-[13px] leading-[16px]"
					style={{ color: tag.color }}
				>
					{tag.text === "result" ? "✓ " : "✗ "}
					{tag.text}
					<HandUnderline
						seed={`gallery-${id}-${tag.text}`}
						color={tag.color}
						width={1.3}
						coverage={1}
						double={tag.text === "result"}
						wavy={tag.text === "failure"}
						offset={-3}
					/>
				</p>
			)}
			{d && label && (
				<div className={`${TYPE.micro} ${tag ? "mt-0.5" : "mt-2"}`}>
					{label(d)}
				</div>
			)}
		</div>
	);
}

/**
 * A numbered marker drawn in photo px (inside RealPhoto children). `k` = crop scale (crop width / photo
 * width) so it keeps a constant on-screen size. Pair with <MarkList> for the explanations.
 */
export function Mark({
	x,
	y,
	n,
	k = 1,
	color = "var(--gb-red, var(--accent))",
}: {
	x: number;
	y: number;
	n: number;
	k?: number;
	color?: string;
}) {
	return (
		<g>
			<HandDot
				x={x}
				y={y}
				r={10.5 * k}
				seed={`mark-blot-${n}`}
				color="var(--gb-paper, #ece6da)"
				opacity={0.92}
			/>
			<SketchPath
				d={`M${x - 9 * k} ${y}a${9 * k} ${9 * k} 0 1 0 ${18 * k} 0a${9 * k} ${9 * k} 0 1 0 ${-18 * k} 0`}
				seed={`mark-${n}-${Math.round(x)}-${Math.round(y)}`}
				color={color}
				width={1.5 * k}
				passes={1}
				tolerance={0.8 * k}
			/>
			<text
				x={x}
				y={y + 4.6 * k}
				textAnchor="middle"
				fontSize={15 * k}
				fontWeight={700}
				className="nb-hand"
				style={{ fill: "var(--gb-ink, #131313)" }}
			>
				{n}
			</text>
		</g>
	);
}

const numbered = (items: ReactNode[]) =>
	items.map((it, i) => [String(i + 1), it] as const);

/** Numbered notes that go with <Mark>s on a figure. */
export function MarkList({
	items,
	className,
}: {
	items: ReactNode[];
	className?: string;
}) {
	return (
		<ol className={cn("mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2", className)}>
			{numbered(items).map(([num, it]) => (
				<li
					key={num}
					className="flex gap-2.5 text-[13px] leading-snug text-[var(--gb-ink)]"
				>
					<span className="nb-hand relative mt-px flex size-6 shrink-0 items-center justify-center text-[17px] font-bold text-[var(--gb-ink,inherit)]">
						<svg
							viewBox="0 0 24 24"
							className="absolute inset-0 overflow-visible"
							aria-hidden="true"
						>
							<PenCircle
								center={[12, 12]}
								radiusX={9.5}
								radiusY={9}
								seed={`marklist-${num}`}
								color="red"
								width={1.3}
							/>
						</svg>
						{num}
					</span>
					<span>{it}</span>
				</li>
			))}
		</ol>
	);
}

/**
 * Inline colour key for a figure, written as part of the caption. Name a `layer` (a figure layer such as
 * "prior" or "solved") and the swatch is drawn exactly like that layer's line on a photo (its photo ink,
 * the same dash and under-stroke) while the words take the layer's paper ink. A raw `color` that is a
 * layer's ink finds its layer; any other colour keeps the plain swatch.
 */
export function Key({
	color,
	layer: layerProp,
	dashed,
	children,
}: {
	color?: string;
	layer?: PhotoLayer;
	dashed?: boolean;
	children: ReactNode;
}) {
	const layer = layerProp ?? (color ? layerOfColor(color) : undefined);
	const dash =
		dashed === undefined
			? layer
				? dashFor(layer, 0.6)
				: undefined
			: dashed
				? "4 3"
				: undefined;
	const swatch = layer ? inkFor(layer, "photo") : (color ?? "var(--gb-ink)");
	return (
		<span className="inline-flex items-center gap-1.5 whitespace-nowrap">
			<svg
				width="16"
				height="6"
				className="overflow-visible"
				aria-hidden="true"
			>
				{layer ? (
					<CrispLine
						d="M1 3L15 3"
						color={swatch}
						width={2.2}
						dash={dash}
						seed={`key-${layer}`}
					/>
				) : (
					<SketchPath
						d="M1 3L15 3"
						seed={`key-${swatch}-${dash ? "d" : "s"}`}
						color={swatch}
						width={2.2}
						dash={dash}
						passes={1}
						tolerance={0.5}
					/>
				)}
			</svg>
			<span
				style={{
					color: layer
						? inkFor(layer, "paper")
						: `color-mix(in oklab, ${swatch} 55%, var(--gb-ink, ${swatch}))`,
				}}
			>
				{children}
			</span>
		</span>
	);
}

/**
 * Crop [x0, y0, x1, y1] (working px) to the photo's skyline band: full width, the detected skyline's 2–98 %
 * row range plus margins, at least `minH` tall. Use it to keep people out of frame and the ridge large.
 */
export function skylineBand(
	d: GipfelbuchPhotoData,
	minH = 300,
): [number, number, number, number] {
	const { width: W, height: H } = d.photo;
	const ys = d.skyline.rows
		.filter((v): v is number => v != null)
		.sort((a, b) => a - b);
	if (!ys.length) return [0, 0, W, H];
	const lo = ys[Math.floor(ys.length * 0.02)];
	const hi = ys[Math.floor(ys.length * 0.98)];
	const bh = Math.min(H, Math.max(minH, hi - lo + 140));
	const y0 = Math.max(0, Math.min(H - bh, lo - 90));
	return [0, Math.round(y0), W, Math.round(y0 + bh)];
}
