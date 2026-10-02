// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type ReactNode, useEffect, useState } from "react";
import { cn } from "#/lib/utils";
import { KrokiTitle } from "../notebook/carto";
import { HandDot, PenArrow, PenCircle, SketchPath } from "../notebook/Ink";
import { Struck, signedDegrees } from "../notebook/notes";
import { useNotebookPhoto } from "../notebook/useNotebookPhoto";
import { Figure } from "./Figure";
import { HandFrame, HandLoop } from "./hand";
import { revealsImmediately, useInView } from "./hooks";
import { HandLabel } from "./labels";
import {
	type GipfelbuchPeak,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	LAYER_STYLE,
	type PhotoLayer,
	RealPhoto,
	useGipfelbuchPhoto,
} from "./real";
import { AlignmentStoryProvider, useAlignmentStory, useTween } from "./story";

// The story on the photo: one real demo photo with its alignment written on it by hand, in four
// steps. Guess: the DEM skyline and peak names at the phone's prior pose. Measure: the skyline the eye
// traced. Correct: the turn from the guess to the solve, a red hand arc with its numbers, while the
// guessed names are struck through in red. Snap: the names at their solved summits. Every line and
// point drawn on the photo is measured (public/demo/gipfelbuch/<id>.json, at the working size); the
// arc and the strikes are the hand's furniture between measured endpoints. The photo spills its
// world onto the margins (RealPhoto bleed → GeoSpill), and the spill follows the story's t.
// Static (reduced motion, webdriver, print): the final step, with the struck guess still visible.

const STEPS = ["guess", "measure", "correct", "snap"] as const;
type Step = 0 | 1 | 2 | 3;
const LAST: Step = 3;

const LAYERS: Record<Step, PhotoLayer[]> = {
	0: ["prior"],
	1: ["prior", "skyline"],
	2: ["prior", "skyline", "solved"],
	3: ["prior", "skyline", "solved", "peaks"],
};

const PRIOR_INK = LAYER_STYLE.priorPeaks.color;
const RED = "var(--gb-red, #bf2233)";
const INK = "var(--gb-ink, #131313)";
/** Label size in working px (800 wide): about 13–17 CSS px across the wide track. */
const LABEL = 14;
const MAX_GUESSES = 4;
const GUESS_GAP = 130;

const inFrame = (d: GipfelbuchPhotoData, q: [number, number] | null) =>
	!!q &&
	q[0] >= 0 &&
	q[0] <= d.photo.width &&
	q[1] >= 0 &&
	q[1] <= d.photo.height;

/** Rough hand-capitals width (px) of a name at `size`, for strikes and edge clamping. */
const nameWidth = (name: string, size: number) => name.length * size * 0.66;

/** Up to four guessed names, the most prominent first, kept apart along x. */
function pickGuesses(d: GipfelbuchPhotoData): GipfelbuchPeak[] {
	const out: GipfelbuchPeak[] = [];
	const candidates = d.peaks
		.filter((p) => p.labelled && inFrame(d, p.prior))
		.sort((a, b) => b.el - a.el);
	for (const p of candidates) {
		const x = (p.prior as [number, number])[0];
		if (
			out.every(
				(q) => Math.abs((q.prior as [number, number])[0] - x) >= GUESS_GAP,
			)
		)
			out.push(p);
		if (out.length >= MAX_GUESSES) break;
	}
	return out;
}

/** The peak whose prior and solved marks are both in frame, highest first: the arc's endpoints. */
function pickAnchor(d: GipfelbuchPhotoData): GipfelbuchPeak | null {
	return (
		d.peaks
			.filter((p) => p.labelled && inFrame(d, p.prior) && inFrame(d, p.solved))
			.sort((a, b) => b.el - a.el)[0] ?? null
	);
}

/** The most confident traced column in the left part of the frame, for the "traced" note. */
function pickTraced(d: GipfelbuchPhotoData): [number, number] | null {
	const { rows, weight } = d.skyline;
	let best = -1;
	for (let x = Math.round(d.photo.width * 0.06); x < d.photo.width * 0.4; x++)
		if (rows[x] != null && (best < 0 || weight[x] > weight[best])) best = x;
	return best < 0 ? null : [best + 0.5, rows[best] as number];
}

function Annotations({ d, step }: { d: GipfelbuchPhotoData; step: Step }) {
	const W = d.photo.width;
	const H = d.photo.height;
	const guesses = pickGuesses(d);
	const anchor = pickAnchor(d);
	const traced = pickTraced(d);
	const struck = step >= 2;
	return (
		<g>
			{/* 1. guess: names at the phone's pose, struck in red once the turn is known */}
			{guesses.map((p) => {
				const [x, y] = p.prior as [number, number];
				const w = nameWidth(p.name, LABEL);
				const tx = Math.min(W - w / 2 - 6, Math.max(w / 2 + 6, x));
				const ty = Math.min(y + 40, H - 10);
				return (
					<g key={p.name} opacity={struck ? 0.85 : 1}>
						<HandDot
							x={x}
							y={y}
							r={3.2}
							seed={`story-guess-${p.name}`}
							color={PRIOR_INK}
							opacity={1}
							data
						/>
						<SketchPath
							d={`M${x} ${y + 5}L${tx} ${ty - 15}`}
							seed={`story-guess-leader-${p.name}`}
							color={PRIOR_INK}
							width={1.1}
						/>
						<HandLabel
							x={tx}
							y={ty}
							anchor="middle"
							size={LABEL}
							color={PRIOR_INK}
							caps
						>
							{p.name}
						</HandLabel>
						{struck && (
							<SketchPath
								d={`M${tx - w / 2 - 4} ${ty - 3}L${tx + w / 2 + 4} ${ty - 6}`}
								seed={`story-strike-${p.name}`}
								color={RED}
								width={2}
								passes={1}
							/>
						)}
					</g>
				);
			})}
			{step <= 1 && guesses.length > 0 && (
				<HandLabel x={8} y={H - 12} size={LABEL - 1} color={PRIOR_INK}>
					{`phone's guess: yaw ${d.prior.yaw.toFixed(1)}°, pitch ${d.prior.pitch.toFixed(1)}°`}
				</HandLabel>
			)}
			{/* 2. measure: a note on the traced skyline (the line itself is RealPhoto's measured layer) */}
			{step >= 1 && traced && (
				<g>
					<HandDot
						x={traced[0]}
						y={traced[1]}
						r={3}
						seed="story-traced"
						color={LAYER_STYLE.skyline.color}
						opacity={1}
						data
					/>
					<HandLabel
						x={traced[0] + 8}
						y={traced[1] - 10}
						size={LABEL - 1}
						color={INK}
					>
						traced by the eye
					</HandLabel>
				</g>
			)}
			{/* 3. correct: a red hand arc from the guessed mark to the solved one, with the turn */}
			{step >= 2 && <Correction d={d} anchor={anchor} />}
			{/* 4. snap: the anchor summit ringed where it really is (names: RealPhoto's peaks layer) */}
			{step >= 3 && anchor?.solved && (
				<PenCircle
					center={anchor.solved}
					radiusX={11}
					radiusY={10}
					seed="story-snap-ring"
					color={RED}
					width={1.6}
				/>
			)}
		</g>
	);
}

function Correction({
	d,
	anchor,
}: {
	d: GipfelbuchPhotoData;
	anchor: GipfelbuchPeak | null;
}) {
	const yaw = `${signedDegrees(d.solved.delta.yaw)} yaw`;
	const pitch = `${signedDegrees(d.solved.delta.pitch)} pitch`;
	if (!anchor?.prior || !anchor.solved)
		return (
			<g>
				<HandLabel
					x={d.photo.width / 2}
					y={30}
					anchor="middle"
					size={LABEL + 2}
					color={RED}
				>
					{yaw}
				</HandLabel>
				<HandLabel
					x={d.photo.width / 2}
					y={48}
					anchor="middle"
					size={LABEL - 1}
					color={RED}
				>
					{pitch}
				</HandLabel>
			</g>
		);
	const from = anchor.prior;
	const to = anchor.solved;
	const mx = (from[0] + to[0]) / 2;
	const top = Math.max(34, Math.min(from[1], to[1]) - 26);
	return (
		<g>
			<PenArrow
				seed="story-correct-halo"
				from={from}
				to={to}
				bend={0.42}
				head={8}
				color="var(--gb-paper, #f6f4ef)"
				width={4.4}
				opacity={0.7}
			/>
			<PenArrow
				seed="story-correct-halo"
				from={from}
				to={to}
				bend={0.42}
				head={8}
				color={RED}
				width={2}
			/>
			<HandLabel x={mx} y={top} anchor="middle" size={LABEL + 2} color={RED}>
				{yaw}
			</HandLabel>
			<HandLabel
				x={mx}
				y={top + 17}
				anchor="middle"
				size={LABEL - 1}
				color={RED}
			>
				{pitch}
			</HandLabel>
		</g>
	);
}

/** The hand caption for each step, written from the measured JSON. */
function stepCaption(d: GipfelbuchPhotoData, step: Step): ReactNode {
	const named = d.peaks.filter((p) => p.labelled && p.solved).length;
	const traced = d.skyline.rows.filter((r) => r != null).length;
	switch (step) {
		case 0:
			return `The phone's guess: yaw ${d.prior.yaw.toFixed(1)}°, pitch ${d.prior.pitch.toFixed(1)}°. The DEM skyline (dashed) and the names are drawn where that pose puts them.`;
		case 1:
			return `The eye traces the real skyline across ${traced} columns. Against the guess the gap is ${d.residual.prior.median.toFixed(1)} px (median).`;
		case 2:
			return (
				<>
					Turn{" "}
					<Struck
						correction={`${d.solved.yaw.toFixed(1)}°`}
						plain
						seed="story-yaw"
					>
						{`${d.prior.yaw.toFixed(1)}°`}
					</Struck>{" "}
					({signedDegrees(d.solved.delta.yaw)} yaw,{" "}
					{signedDegrees(d.solved.delta.pitch)} pitch): the DEM line drops onto
					the trace.
				</>
			);
		default:
			return `Snapped: the gap is ${d.residual.solved.median.toFixed(1)} px (was ${d.residual.prior.median.toFixed(1)}), and ${named} peaks are named at their summits. ${
				d.solved.accepted
					? `Accepted at confidence ${d.solved.confidence.toFixed(2)}.`
					: `Not accepted (${d.solved.rejectReason ?? "low confidence"}): the app asks instead.`
			}`;
	}
}

/** Mirrors the step's pose into the enclosing alignment story (guess 0 → solved 1), tweened. */
function StorySync({ target }: { target: number }) {
	const story = useAlignmentStory();
	const t = useTween(target, 1100);
	const setT = story?.setT;
	useEffect(() => setT?.(t), [setT, t]);
	return null;
}

export interface PhotoStoryProps {
	/** A demo photo; default: the one the reader picked anywhere in the Gipfelbuch. */
	photoId?: GipfelbuchPhotoId;
	number?: string;
	/** The hand Kroki title. */
	title?: string;
	/** Replaces the default caption. */
	caption?: ReactNode;
	/** Geo spill onto the margins (RealPhoto bleed); false for a plain photo. */
	bleed?: boolean | number;
	/** ms per step while auto-advancing. */
	interval?: number;
	/** `crop` in working px, passed to RealPhoto. */
	crop?: [number, number, number, number];
	date?: string;
	className?: string;
}

/**
 * "The story on the photo": guess, measure, correct, snap, written by hand on one real photo. Steps
 * advance on their own once the figure is in view (until the reader takes the stepper) and freeze on
 * the last step under reduced motion, webdriver and print.
 */
export function PhotoStory(props: PhotoStoryProps) {
	return (
		<AlignmentStoryProvider initial={1}>
			<PhotoStoryInner {...props} />
		</AlignmentStoryProvider>
	);
}

function PhotoStoryInner({
	photoId,
	number,
	title = "Guess, measure, correct, snap",
	caption,
	bleed = true,
	interval = 2800,
	crop,
	date,
	className,
}: PhotoStoryProps) {
	const [picked] = useNotebookPhoto();
	const id = photoId ?? picked;
	const loaded = useGipfelbuchPhoto(id);
	// keep the previous photo while the next one loads, so the figure does not collapse
	const [data, setData] = useState<GipfelbuchPhotoData | null>(null);
	useEffect(() => {
		if (loaded) setData(loaded);
	}, [loaded]);

	const [ref, inView] = useInView({ once: false });
	const [step, setStep] = useState<Step>(LAST);
	const [playing, setPlaying] = useState(false);
	// static by default (server, first paint); the stepper starts from the guess only where motion is fine
	useEffect(() => {
		if (revealsImmediately()) return;
		setStep(0);
		setPlaying(true);
	}, []);
	useEffect(() => {
		if (!playing || !inView || step >= LAST) return;
		const timer = window.setTimeout(() => {
			const next = (step + 1) as Step;
			setStep(next);
			if (next >= LAST) setPlaying(false);
		}, interval);
		return () => window.clearTimeout(timer);
	}, [playing, inView, step, interval]);
	const go = (n: number) => {
		setPlaying(false);
		setStep(Math.max(0, Math.min(LAST, n)) as Step);
	};
	const replay = () => {
		setStep(0);
		setPlaying(true);
	};

	const seed = `photo-story-${id}`;
	const defaultCaption = data
		? `${data.id}: the alignment written on the photo. The phone's guess is struck in red; the skyline and the summits are measured (${data.solved.stage}, ${data.dem} DEM).`
		: "The alignment written on the photo …";
	return (
		<Figure
			number={number}
			caption={caption ?? defaultCaption}
			bleed
			className={className}
		>
			<StorySync target={step >= 2 ? 1 : 0} />
			<div ref={ref}>
				<svg
					viewBox="0 0 640 56"
					className="mb-2 block h-auto w-full max-w-[640px] overflow-visible"
					aria-hidden="true"
				>
					<KrokiTitle
						x={4}
						y={26}
						title={title}
						size={22}
						date={date}
						seed={`${seed}-title`}
					/>
				</svg>
				<div className="mb-3 flex items-start gap-1.5">
					<div className="grid min-w-0 flex-1 grid-cols-2 gap-x-1.5 sm:grid-cols-4">
						{STEPS.map((label, n) => (
							<button
								key={label}
								type="button"
								onClick={() => go(n)}
								aria-pressed={n === step}
								className={cn(
									"gb-caps relative min-w-0 px-3 pt-1.5 pb-2 text-left text-[13px] leading-[16px] transition-colors motion-reduce:transition-none",
									n === step
										? "text-[var(--gb-ink)]"
										: "text-[var(--gb-secondary,#4a545c)] hover:text-[var(--gb-ink)]",
								)}
							>
								<span className="nb-num mr-1.5 text-[var(--gb-contour,inherit)] normal-case">
									{n + 1}.
								</span>
								{label}
								{n === step && (
									<HandLoop
										seed={`story-tab-${label}`}
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
						onClick={replay}
						className="nb-hand relative mt-0.5 mr-1 shrink-0 px-2 text-[18px] leading-[24px] text-[var(--gb-secondary,#4a545c)] hover:text-[var(--gb-ink)] print:hidden"
					>
						again
						<HandFrame
							seed="story-again"
							color="pencil"
							width={1.1}
							overshoot={4}
						/>
					</button>
				</div>
				<RealPhoto
					data={data}
					layers={LAYERS[step]}
					bleed={bleed}
					crop={crop}
					labelInfo={step >= LAST}
				>
					{(d) => <Annotations d={d} step={step} />}
				</RealPhoto>
				<p
					className="nb-hand mt-3 min-h-[2.8em] text-[19px] leading-[23px] text-[var(--gb-pencil,var(--gb-ink))]"
					aria-live="polite"
				>
					{data ? stepCaption(data, step) : "…"}
				</p>
			</div>
		</Figure>
	);
}
