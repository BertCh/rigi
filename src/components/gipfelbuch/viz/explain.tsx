// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Pause,
	Play,
} from "lucide-react";
import {
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { cn } from "#/lib/utils";
import { PenCircle, SketchPath, StepNumber } from "../notebook/Ink";
import { TYPE } from "../swiss/type";
import { useInView, useReducedMotion } from "./hooks";
import {
	GIPFELBUCH_PHOTO_IDS,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	NoImprint,
	useGipfelbuchPhoto,
} from "./real";

// Explainer kit: the building blocks of a concise, visual-first concept page.
// The recipe (see README "Explainer pages"): a hero figure on a real photo whose caption is the claim,
// then 2-4 short beats (headline = claim, 1-3 sentences, one figure each), and the engineering detail
// folded into <Details>. Copy in beats stays plain: no code identifiers, one number per sentence.

/** Short beat: a headline that states the claim, up to three sentences, then its figure. */
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
			{kicker && (
				<p className="gb-caps mb-2 text-[11px] leading-[12px] text-[var(--gb-contour,var(--accent))]">
					{kicker}
				</p>
			)}
			<h2 className={`${TYPE.claim} max-w-2xl text-[var(--gb-ink)]`}>
				{title}
			</h2>
			{children && (
				<div className="mt-3 max-w-[66ch] space-y-3 text-[16px] leading-[24px] text-[var(--gb-ink)] [&_strong]:font-semibold [&_strong]:text-[var(--gb-ink)] [&_em]:text-[var(--gb-ink)] [&_a]:text-[var(--gb-water,var(--accent))] hover:[&_a]:underline">
					{children}
				</div>
			)}
			{figure}
		</section>
	);
}

/** Collapsed "for engineers" detail. Keeps the precise mechanism on the page without making everyone read it. */
export function Details({
	title = "Details for engineers",
	children,
	className,
}: {
	title?: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<details
			className={cn(
				"group mt-12 bg-[var(--gb-paper-deep,transparent)]/50 open:bg-[var(--gb-paper-deep,transparent)]",
				className,
			)}
		>
			<summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 select-none [&::-webkit-details-marker]:hidden">
				<ChevronDown
					className="size-4 text-[var(--gb-red,var(--accent))] transition group-open:rotate-180 motion-reduce:transition-none"
					strokeWidth={1.8}
				/>
				<span className="gb-caps text-[11px] text-[var(--gb-ink)]">
					{title}
				</span>
			</summary>
			<div className="space-y-4 px-5 pb-6 text-[13px] leading-[1.7] text-[var(--gb-ink)] [&_a]:text-[var(--gb-water,var(--accent))] [&_code]:bg-[var(--gb-paper-deep)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-[var(--gb-ink)] [&_kbd]:bg-[var(--gb-paper-deep)] [&_kbd]:px-1.5 [&_kbd]:font-mono [&_kbd]:text-[13px] [&_h3]:mt-6 [&_h3]:font-semibold [&_h3]:text-[var(--gb-ink)] [&_li]:pl-1 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5 [&_strong]:text-[var(--gb-ink)] [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
				{children}
			</div>
		</details>
	);
}

/**
 * Before/after on the same frame: drag (or arrow keys) to wipe between two renderings. Sweeps once on first
 * view unless reduced motion. Touch keeps vertical page scroll (touch-action: pan-y).
 */
export function Compare({
	before,
	after,
	beforeLabel,
	afterLabel,
	start = 0.5,
	className,
}: {
	before: ReactNode;
	after: ReactNode;
	beforeLabel: string;
	afterLabel: string;
	start?: number;
	className?: string;
}) {
	const [ref, inView] = useInView();
	const reduce = useReducedMotion();
	const [x, setX] = useState(start);
	const touched = useRef(false);
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!inView || reduce || touched.current) return;
		let raf = 0;
		const t0 = performance.now();
		const tick = (now: number) => {
			if (touched.current) return;
			const t = (now - t0) / 2600;
			if (t >= 1) return setX(start);
			// out to the right, back past the left, settle at `start`
			setX(start + 0.4 * Math.sin(t * Math.PI * 2) * (1 - t));
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [inView, reduce, start]);
	const move = (e: PointerEvent) => {
		const r = box.current?.getBoundingClientRect();
		if (!r) return;
		touched.current = true;
		setX(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
	};
	const key = (e: KeyboardEvent) => {
		const d = e.key === "ArrowLeft" ? -0.05 : e.key === "ArrowRight" ? 0.05 : 0;
		if (!d) return;
		e.preventDefault();
		touched.current = true;
		setX((v) => Math.min(1, Math.max(0, v + d)));
	};
	return (
		<div ref={ref} className={className}>
			<NoImprint>
				<div
					ref={box}
					className="relative cursor-ew-resize touch-pan-y select-none"
					onPointerDown={(e) => {
						(e.target as Element).setPointerCapture?.(e.pointerId);
						move(e);
					}}
					onPointerMove={(e) => e.buttons && move(e)}
				>
					{before}
					<div
						className="pointer-events-none absolute inset-0"
						style={{ clipPath: `inset(0 0 0 ${x * 100}%)` }}
					>
						{after}
					</div>
					<div
						className="absolute inset-y-0 w-0"
						style={{ left: `${x * 100}%` }}
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
							role="slider"
							tabIndex={0}
							aria-label={`${beforeLabel} / ${afterLabel}`}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={Math.round(x * 100)}
							onKeyDown={key}
							className="absolute top-1/2 left-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--gb-paper,var(--rigi-ink))] text-[var(--gb-ink,currentColor)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--gb-red,var(--accent))]"
						>
							<svg
								viewBox="0 0 36 36"
								className="pointer-events-none absolute inset-0 overflow-visible"
								aria-hidden="true"
							>
								<PenCircle
									center={[18, 18]}
									radiusX={14}
									seed="compare-handle"
									color="red"
									width={1.6}
								/>
							</svg>
							<ChevronLeft className="size-3.5" />
							<ChevronRight className="-ml-1 size-3.5" />
						</div>
					</div>
					<span className="pointer-events-none absolute top-2 left-2 bg-[var(--gb-paper,#ece6da)]/90 px-2 py-0.5 text-[11px] tracking-[0.1em] text-[var(--gb-ink,#131313)] gb-caps">
						{beforeLabel}
					</span>
					<span className="pointer-events-none absolute top-2 right-2 bg-[var(--gb-paper,#ece6da)]/90 px-2 py-0.5 text-[11px] tracking-[0.1em] text-[var(--gb-ink,#131313)] gb-caps">
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
}

/**
 * Step through stages of one process on the same frame (tabs + prev/next). Auto-advances while on screen
 * until the reader touches it; frozen on the last stage under reduced motion.
 */
export function Stages({
	stages,
	interval = 3200,
	className,
}: {
	stages: Stage[];
	interval?: number;
	className?: string;
}) {
	const [ref, inView] = useInView({ once: false });
	const reduce = useReducedMotion();
	const [i, setI] = useState(reduce ? stages.length - 1 : 0);
	const [playing, setPlaying] = useState(!reduce);
	useEffect(() => {
		if (!playing || !inView || reduce) return;
		const id = window.setTimeout(
			() => setI((v) => (v + 1) % stages.length),
			i === stages.length - 1 ? interval * 1.6 : interval,
		);
		return () => window.clearTimeout(id);
	}, [playing, inView, reduce, i, interval, stages.length]);
	const go = (n: number) => {
		setPlaying(false);
		setI((n + stages.length) % stages.length);
	};
	const s = stages[i];
	return (
		<div
			ref={ref}
			className={cn(
				"bg-[var(--gb-paper-deep,transparent)] p-4 [container-type:inline-size]",
				className,
			)}
		>
			<div className="mb-3 flex items-start gap-1.5">
				{/* one row of equal tabs from 560 px of container width, two columns below */}
				<div className="grid min-w-0 flex-1 grid-cols-2 gap-x-1.5 [@container(min-width:560px)]:auto-cols-fr [@container(min-width:560px)]:grid-flow-col [@container(min-width:560px)]:grid-cols-none">
					{stages.map((st, n) => (
						<button
							key={st.label}
							type="button"
							onClick={() => go(n)}
							aria-pressed={n === i}
							className={cn(
								"gb-caps relative min-w-0 px-2.5 pt-1 pb-2 text-left text-[11px] tracking-[0.08em] transition",
								n === i
									? "text-[var(--gb-ink)]"
									: "text-[var(--gb-secondary,#4a545c)] hover:text-[var(--gb-ink)]",
							)}
						>
							<span className="gb-coord mr-1.5 text-[var(--gb-contour,inherit)]">
								Bl.{String(n + 1).padStart(2, "0")}
							</span>
							{st.label}
							{n === i && (
								<svg
									viewBox="0 0 100 4"
									preserveAspectRatio="none"
									className="absolute inset-x-1 bottom-0.5 h-1 w-[calc(100%-8px)] overflow-visible [&_path]:[vector-effect:non-scaling-stroke]"
									aria-hidden="true"
								>
									<SketchPath
										d="M0 2L100 2"
										seed={`stage-tab-${st.label}`}
										color="red"
										width={1.8}
										passes={1}
										tolerance={0.6}
									/>
								</svg>
							)}
						</button>
					))}
				</div>
				<button
					type="button"
					onClick={() => setPlaying((p) => !p)}
					aria-label={playing ? "Pause" : "Play"}
					className="shrink-0 p-1.5 text-[var(--gb-secondary,#4a545c)] hover:text-[var(--gb-ink)] focus-visible:ring-2 focus-visible:ring-[var(--gb-red,var(--accent))]"
				>
					{playing ? <Pause className="size-3" /> : <Play className="size-3" />}
				</button>
			</div>
			<div key={i} className="animate-[gipfelbuch-fade_420ms_ease-out]">
				<NoImprint>{s.render()}</NoImprint>
			</div>
			<div className="mt-3 flex items-start gap-3">
				<button
					type="button"
					onClick={() => go(i - 1)}
					aria-label="Previous stage"
					className="p-1 text-[var(--gb-secondary,#4a545c)] hover:text-[var(--gb-ink)] focus-visible:ring-2 focus-visible:ring-[var(--gb-red,var(--accent))]"
				>
					<ChevronLeft className="size-4" />
				</button>
				<p className="min-h-[2.8em] flex-1 text-[13px] leading-snug text-[var(--gb-ink)]">
					{s.caption}
				</p>
				<button
					type="button"
					onClick={() => go(i + 1)}
					aria-label="Next stage"
					className="p-1 text-[var(--gb-secondary,#4a545c)] hover:text-[var(--gb-ink)] focus-visible:ring-2 focus-visible:ring-[var(--gb-red,var(--accent))]"
				>
					<ChevronRight className="size-4" />
				</button>
			</div>
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
							<div className="pt-1 text-[13px] font-semibold text-[var(--gb-ink)]">
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
	cols = 4,
	className,
}: {
	ids?: readonly GipfelbuchPhotoId[];
	tile: (d: GipfelbuchPhotoData) => ReactNode;
	/** A short line under each tile (e.g. "accepted · 2.1 px"). */
	label?: (d: GipfelbuchPhotoData) => ReactNode;
	/** KR10: a caps tag over each label, so a failure reads apart from a result at a glance. */
	tone?: (d: GipfelbuchPhotoData) => GalleryTone;
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
				<GalleryTile key={id} id={id} tile={tile} label={label} tone={tone} />
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

function GalleryTile({
	id,
	tile,
	label,
	tone,
}: {
	id: GipfelbuchPhotoId;
	tile: (d: GipfelbuchPhotoData) => ReactNode;
	label?: (d: GipfelbuchPhotoData) => ReactNode;
	tone?: (d: GipfelbuchPhotoData) => GalleryTone;
}) {
	const d = useGipfelbuchPhoto(id);
	const tag = d && tone ? TONE_TAG[tone(d)] : null;
	return (
		<div>
			{d ? (
				<NoImprint>{tile(d)}</NoImprint>
			) : (
				<div className="aspect-[4/3] animate-pulse bg-[var(--gb-paper-deep)] motion-reduce:animate-none" />
			)}
			{tag && (
				<p
					className={`${TYPE.kicker} mt-2 tracking-[0.14em]`}
					style={{ color: tag.color }}
				>
					{tag.text}
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
			<circle
				cx={x}
				cy={y}
				r={10 * k}
				fill="var(--gb-paper, #ece6da)"
				fillOpacity={0.92}
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
				y={y + 3.6 * k}
				textAnchor="middle"
				fontSize={10.5 * k}
				fontWeight={700}
				fill="var(--gb-ink, #131313)"
				fontFamily="var(--gb-font-mono, 'Fira Mono'), ui-monospace, monospace"
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
					<span className="relative mt-px flex size-6 shrink-0 items-center justify-center font-mono text-[11px] font-bold text-[var(--gb-ink,inherit)]">
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

/** Inline colour key for a figure: a dot (or dash) per series, written as part of the caption. */
export function Key({
	color,
	dashed,
	children,
}: {
	color: string;
	dashed?: boolean;
	children: ReactNode;
}) {
	return (
		<span className="inline-flex items-center gap-1.5 whitespace-nowrap">
			<svg
				width="16"
				height="6"
				className="overflow-visible"
				aria-hidden="true"
			>
				<SketchPath
					d="M1 3L15 3"
					seed={`key-${color}-${dashed ? "d" : "s"}`}
					color={`color-mix(in oklab, ${color} 82%, var(--gb-ink, transparent))`}
					width={2.2}
					dash={dashed ? "4 3" : undefined}
					passes={1}
					tolerance={0.5}
				/>
			</svg>
			<span
				style={{
					color: `color-mix(in oklab, ${color} 55%, var(--gb-ink, ${color}))`,
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
