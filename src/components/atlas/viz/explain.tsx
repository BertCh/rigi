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
import { useInView, useReducedMotion } from "./hooks";
import {
	ATLAS_PHOTO_IDS,
	type AtlasPhotoData,
	type AtlasPhotoId,
	useAtlasPhoto,
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
		<section className={cn("mt-16 first:mt-2", className)}>
			{kicker && (
				<p className="mb-2 font-mono text-[10.5px] tracking-[0.18em] text-[var(--accent)] uppercase">
					{kicker}
				</p>
			)}
			<h2 className="display-title max-w-2xl text-[1.7rem] leading-[1.15] font-bold tracking-[-0.01em] text-[var(--rigi-paper)] sm:text-[1.95rem]">
				{title}
			</h2>
			{children && (
				<div className="mt-3 max-w-2xl space-y-3 text-[16.5px] leading-[1.65] text-white/72 [&_strong]:font-semibold [&_strong]:text-[var(--rigi-paper)] [&_em]:text-white/90 [&_a]:text-[var(--accent)] hover:[&_a]:underline">
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
				"group mt-14 rounded-2xl bg-white/[0.025] ring-1 ring-white/8 open:bg-white/[0.035]",
				className,
			)}
		>
			<summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 select-none [&::-webkit-details-marker]:hidden">
				<ChevronDown
					className="size-4 text-[var(--accent)] transition group-open:rotate-180"
					strokeWidth={1.8}
				/>
				<span className="font-mono text-[11px] tracking-[0.16em] text-white/70 uppercase">
					{title}
				</span>
			</summary>
			<div className="space-y-4 px-5 pb-6 text-[14.5px] leading-[1.7] text-white/62 [&_code]:rounded [&_code]:bg-white/8 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12.5px] [&_code]:text-white/80 [&_h3]:mt-6 [&_h3]:font-semibold [&_h3]:text-[var(--rigi-paper)] [&_li]:pl-1 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5 [&_strong]:text-[var(--rigi-paper)] [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
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
					className="absolute inset-y-0 w-px bg-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
					style={{ left: `${x * 100}%` }}
				>
					<div
						role="slider"
						tabIndex={0}
						aria-label={`${beforeLabel} / ${afterLabel}`}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.round(x * 100)}
						onKeyDown={key}
						className="absolute top-1/2 left-1/2 flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--rigi-ink)]/85 text-white ring-1 ring-white/60 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
					>
						<ChevronLeft className="size-3.5" />
						<ChevronRight className="-ml-1 size-3.5" />
					</div>
				</div>
				<span className="pointer-events-none absolute top-2 left-2 rounded-full bg-black/55 px-2 py-0.5 font-mono text-[10.5px] text-white/85">
					{beforeLabel}
				</span>
				<span className="pointer-events-none absolute top-2 right-2 rounded-full bg-black/55 px-2 py-0.5 font-mono text-[10.5px] text-white/85">
					{afterLabel}
				</span>
			</div>
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
		<div ref={ref} className={className}>
			<div className="mb-3 flex flex-wrap items-center gap-1.5">
				{stages.map((st, n) => (
					<button
						key={st.label}
						type="button"
						onClick={() => go(n)}
						className={cn(
							"rounded-full px-2.5 py-1 font-mono text-[10.5px] ring-1 transition",
							n === i
								? "bg-[var(--accent)]/15 text-[var(--rigi-paper)] ring-[var(--accent)]"
								: "text-white/50 ring-white/12 hover:text-white/80",
						)}
					>
						<span className="mr-1 text-white/35">{n + 1}</span>
						{st.label}
					</button>
				))}
				<button
					type="button"
					onClick={() => setPlaying((p) => !p)}
					aria-label={playing ? "Pause" : "Play"}
					className="ml-auto rounded-full p-1.5 text-white/50 ring-1 ring-white/12 hover:text-white/80"
				>
					{playing ? <Pause className="size-3" /> : <Play className="size-3" />}
				</button>
			</div>
			<div key={i} className="animate-[atlas-fade_420ms_ease-out]">
				{s.render()}
			</div>
			<div className="mt-3 flex items-start gap-3">
				<button
					type="button"
					onClick={() => go(i - 1)}
					aria-label="Previous stage"
					className="rounded-full p-1 text-white/50 ring-1 ring-white/12 hover:text-white"
				>
					<ChevronLeft className="size-4" />
				</button>
				<p className="min-h-[2.8em] flex-1 text-[14px] leading-snug text-white/75">
					{s.caption}
				</p>
				<button
					type="button"
					onClick={() => go(i + 1)}
					aria-label="Next stage"
					className="rounded-full p-1 text-white/50 ring-1 ring-white/12 hover:text-white"
				>
					<ChevronRight className="size-4" />
				</button>
			</div>
			<style>{"@keyframes atlas-fade{from{opacity:.25}to{opacity:1}}"}</style>
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
				"my-8 grid gap-4",
				steps.length >= 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3",
				className,
			)}
		>
			{steps.map((s, n) => (
				<div
					key={s.title}
					className={cn(
						"flex flex-col rounded-2xl bg-white/[0.03] p-3 ring-1 ring-white/10 transition duration-700 motion-reduce:transition-none",
						on ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
					)}
					style={{ transitionDelay: `${n * 120}ms` }}
				>
					<div className="overflow-hidden rounded-xl bg-black/20">
						{s.visual}
					</div>
					<div className="mt-3 flex gap-2.5 px-1 pb-1">
						<span className="display-title text-[1.3rem] leading-none font-bold text-[var(--accent)]">
							{n + 1}
						</span>
						<div>
							<div className="text-[14px] font-semibold text-[var(--rigi-paper)]">
								{s.title}
							</div>
							<div className="mt-0.5 text-[13px] leading-snug text-white/58">
								{s.body}
							</div>
						</div>
					</div>
				</div>
			))}
		</div>
	);
}

/** A row of headline numbers with an optional source line underneath. */
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
		<div className={cn("my-8", className)}>
			<div className="grid grid-cols-2 gap-x-6 gap-y-6 border-y border-white/8 py-6 sm:grid-cols-4">
				{items.map((it) => (
					<div key={it.label}>
						<div className="display-title text-[2rem] leading-none font-bold text-[var(--accent)]">
							{it.value}
						</div>
						<div className="mt-1.5 text-[12px] leading-snug text-white/52">
							{it.label}
						</div>
					</div>
				))}
			</div>
			{source && (
				<p className="mt-2 font-mono text-[10.5px] text-white/38">{source}</p>
			)}
		</div>
	);
}

/** Small multiples over the demo photos: same view, same scale, one tile each. */
export function Gallery({
	ids = ATLAS_PHOTO_IDS,
	tile,
	label,
	cols = 4,
	className,
}: {
	ids?: readonly AtlasPhotoId[];
	tile: (d: AtlasPhotoData) => ReactNode;
	/** A short line under each tile (e.g. "accepted · 2.1 px"). */
	label?: (d: AtlasPhotoData) => ReactNode;
	cols?: 2 | 3 | 4;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"grid grid-cols-2 gap-2.5",
				cols === 3 && "sm:grid-cols-3",
				cols === 4 && "sm:grid-cols-3 lg:grid-cols-4",
				className,
			)}
		>
			{ids.map((id) => (
				<GalleryTile key={id} id={id} tile={tile} label={label} />
			))}
		</div>
	);
}

function GalleryTile({
	id,
	tile,
	label,
}: {
	id: AtlasPhotoId;
	tile: (d: AtlasPhotoData) => ReactNode;
	label?: (d: AtlasPhotoData) => ReactNode;
}) {
	const d = useAtlasPhoto(id);
	return (
		<div>
			{d ? (
				tile(d)
			) : (
				<div className="aspect-[4/3] animate-pulse rounded-lg bg-white/[0.04]" />
			)}
			{d && label && (
				<div className="mt-1 font-mono text-[10.5px] leading-snug text-white/50">
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
	color = "var(--accent)",
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
				r={9 * k}
				fill="#0e1012"
				fillOpacity={0.8}
				stroke={color}
				strokeWidth={1.5 * k}
			/>
			<text
				x={x}
				y={y + 3.6 * k}
				textAnchor="middle"
				fontSize={10.5 * k}
				fontWeight={700}
				fill={color}
				fontFamily="ui-sans-serif, system-ui"
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
					className="flex gap-2.5 text-[13.5px] leading-snug text-white/68"
				>
					<span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[10.5px] font-bold text-[var(--accent)] ring-1 ring-[var(--accent)]">
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
			<svg width="16" height="6" aria-hidden="true">
				<line
					x1="1"
					x2="15"
					y1="3"
					y2="3"
					stroke={color}
					strokeWidth="2.2"
					strokeDasharray={dashed ? "4 3" : undefined}
					strokeLinecap="round"
				/>
			</svg>
			<span style={{ color }}>{children}</span>
		</span>
	);
}

/**
 * Crop [x0, y0, x1, y1] (working px) to the photo's skyline band: full width, the detected skyline's 2–98 %
 * row range plus margins, at least `minH` tall. Use it to keep people out of frame and the ridge large.
 */
export function skylineBand(
	d: AtlasPhotoData,
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
