// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Landing-page frame: the terrain carries on past a photo's edges in the roll panorama's look
// (depth-faded ridgelines, peak names over their summits, a compass ruler). Everything is baked by
// scripts/demo/bake-surround.ts: one transparent WebP of strokes traced from the photo's eye and
// projected through its solved camera, plus a small JSON of geometry, ticks and names imported into
// the bundle, so it lays out with the page and starts no work. The photo (children) keeps its own
// size and place; the surround spills around it, fading out at the outer edges.

import {
	type CSSProperties,
	type MutableRefObject,
	type ReactNode,
	type Ref,
	useEffect,
	useRef,
} from "react";

export type SurroundBake = {
	id: string;
	src: string;
	width: number;
	height: number;
	/** The photo's rectangle, as fractions of the canvas. */
	photo: { x: number; y: number; w: number; h: number };
	/** The ruler's height, as a fraction of the canvas. */
	ruler: number;
	ticks: { x: number; label?: string }[];
	peaks: { name: string; ele: number; km: number; x: number; y: number }[];
	/** A fixed CSS size centred on the frame instead of scaling with it (the topo board's plan, drawn
	 * at the board's own map scale); `photo` is then the board's usual rectangle. */
	fixed?: { w: number; h: number };
	/** `src` is a grey coverage mask over a paper fill, not a colour image. */
	mask?: boolean;
};

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

export function Surround({
	bake,
	eager = false,
	className,
	layerRef,
	rootRef,
	style,
	children,
}: {
	bake: SurroundBake;
	/** Load the strokes with the page (the hero) rather than when scrolled near. */
	eager?: boolean;
	className?: string;
	/** The layer element, for a frame that moves its content (the topo board's pan). */
	layerRef?: Ref<HTMLDivElement>;
	/** The outer frame, for a child that steers the surround through CSS variables. */
	rootRef?: Ref<HTMLDivElement>;
	style?: CSSProperties;
	children: ReactNode;
}) {
	const root = useRef<HTMLDivElement | null>(null);
	// A frame that pans the layer (layerRef) gets it promoted only while a pointer is down in the
	// frame, so the drag moves a compositor layer and nothing stays allocated at rest.
	useEffect(() => {
		const el = root.current;
		if (!el || !layerRef) return;
		const layer = el.querySelector<HTMLElement>("[data-surround-layer]");
		if (!layer) return;
		const release = () => {
			layer.style.willChange = "";
			window.removeEventListener("pointerup", release);
			window.removeEventListener("pointercancel", release);
		};
		const press = () => {
			layer.style.willChange = "transform";
			window.addEventListener("pointerup", release);
			window.addEventListener("pointercancel", release);
		};
		// capture: the board stops the event's propagation
		el.addEventListener("pointerdown", press, true);
		return () => {
			el.removeEventListener("pointerdown", press, true);
			release();
		};
	}, [layerRef]);
	const setRoot = (el: HTMLDivElement | null) => {
		root.current = el;
		if (typeof rootRef === "function") rootRef(el);
		else if (rootRef)
			(rootRef as MutableRefObject<HTMLDivElement | null>).current = el;
	};
	return (
		<div
			ref={setRoot}
			className={`relative isolate ${className ?? ""}`}
			style={style}
		>
			<SurroundLayer
				bake={bake}
				eager={eager}
				className="-z-10"
				layerRef={layerRef}
			/>
			{children}
		</div>
	);
}

/**
 * The surround alone, for a frame it cannot wrap (the how-it-works viewport sits inside a clipped
 * card). With `frame` (px, in the positioned parent's box) it is laid around that rectangle; without,
 * the parent is the frame.
 */
export function SurroundLayer({
	bake,
	eager = false,
	frame,
	className,
	style,
	layerRef,
	reveal,
}: {
	bake: SurroundBake;
	eager?: boolean;
	frame?: { left: number; top: number; width: number; height: number };
	className?: string;
	style?: CSSProperties;
	layerRef?: Ref<HTMLDivElement>;
	/** Bloom masks (RevealLoop's, driven by an ancestor's `--rigi-reveal`): the strokes wait faint
	 * and the names hidden until the front passes, as over the photo. */
	reveal?: { fill: string; front: string };
}) {
	const { photo } = bake;
	// fade the outer half of each side's spill; the top keeps the ruler crisp
	const fl = pct(photo.x * 0.6);
	const fr = pct(1 - (1 - photo.x - photo.w) * 0.6);
	// a frame flush with the canvas bottom (the how-it-works band) fades over its own lower part
	const bottom = photo.y + photo.h;
	const fb = pct(bottom > 0.98 ? 0.55 : bottom);
	// a plan runs on the board's sides and under it, never up into the heading above
	const vertical = bake.fixed
		? `linear-gradient(to bottom, transparent ${pct(photo.y)}, #000 ${pct(photo.y + 0.06)}, #000 ${pct(1 - (1 - photo.y - photo.h) * 0.6)}, transparent)`
		: `linear-gradient(to bottom, #000 ${fb}, transparent)`;
	// the left spill's strength is `--surround-left` (default 1) from an ancestor: beside a before/after
	// slider it shows only once the divider reaches the far left, so the plain photo has no terrain
	const left = "rgb(0 0 0 / var(--surround-left, 1))";
	const mask = `linear-gradient(to right, transparent, ${left} ${fl}, ${left} ${pct(photo.x)}, #000 ${pct(photo.x)}, #000 ${fr}, transparent), ${vertical}`;
	const box = bake.fixed
		? {
				left: `calc(50% - ${bake.fixed.w / 2}px)`,
				width: bake.fixed.w,
				top: `calc(50% - ${bake.fixed.h / 2}px)`,
				height: bake.fixed.h,
			}
		: frame
			? {
					left: frame.left - (photo.x / photo.w) * frame.width,
					width: frame.width / photo.w,
					top: frame.top - (photo.y / photo.h) * frame.height,
					height: frame.height / photo.h,
				}
			: {
					left: pct(-photo.x / photo.w),
					width: pct(1 / photo.w),
					top: pct(-photo.y / photo.h),
					height: pct(1 / photo.h),
				};
	const strokes = bake.mask ? (
		// a browser without luminance masks would paint the whole fill: it shows nothing instead
		<div
			className="absolute inset-0 hidden bg-[var(--rigi-paper)] supports-[mask-mode:luminance]:block"
			style={{
				maskImage: `url(${bake.src})`,
				maskSize: "100% 100%",
				maskMode: "luminance",
			}}
		/>
	) : (
		<img
			src={bake.src}
			alt=""
			width={bake.width}
			height={bake.height}
			className="absolute inset-0 size-full light:invert"
			loading={eager ? "eager" : "lazy"}
			decoding="async"
			draggable={false}
		/>
	);
	const labels = (
		<div className="absolute inset-0 hidden font-mono md:block">
			{bake.ticks.map((t) => (
				<span
					key={t.x}
					className="absolute top-0"
					style={{ left: pct(t.x), height: pct(bake.ruler) }}
				>
					<span
						className={`absolute bottom-0 w-px ${t.label ? "h-1.5 bg-white/40" : "h-1 bg-white/20"}`}
					/>
					{t.label && (
						<span
							className={`absolute top-0.5 -translate-x-1/2 text-[10px] ${
								t.label.endsWith("°")
									? "text-white/45"
									: "font-semibold text-[var(--rigi-glow)]"
							}`}
						>
							{t.label}
						</span>
					)}
				</span>
			))}
			{bake.peaks.map((p) => (
				<span
					key={p.name}
					className="absolute inset-y-0"
					style={{ left: pct(p.x) }}
				>
					<span
						className="absolute h-3.5 w-px bg-[rgba(236,230,218,0.3)] light:bg-[var(--rigi-paper)]/30"
						style={{ top: `calc(${pct(p.y)} - 16px)` }}
					/>
					<span
						className="absolute -ml-[2px] size-[4px] rounded-full bg-[rgba(236,230,218,0.8)] light:bg-[var(--rigi-paper)]/80"
						style={{ top: `calc(${pct(p.y)} - 2px)` }}
					/>
					<span
						className="absolute left-1 leading-none whitespace-nowrap"
						style={{ top: `calc(${pct(p.y)} - 42px)` }}
					>
						<span className="block font-sans text-[10.5px] font-semibold text-[rgba(236,230,218,0.8)] light:text-[var(--rigi-paper)]/80">
							{p.name}
						</span>
						<span className="mt-0.5 block text-[9.5px] text-[rgba(236,230,218,0.45)] light:text-[var(--rigi-paper)]/45">
							{p.ele} m · {p.km < 10 ? p.km.toFixed(1) : Math.round(p.km)} km
						</span>
					</span>
				</span>
			))}
		</div>
	);
	return (
		<div
			aria-hidden
			className={`pointer-events-none absolute select-none ${className ?? ""}`}
			style={{
				...box,
				maskImage: mask,
				WebkitMaskImage: mask,
				maskComposite: "intersect",
				WebkitMaskComposite: "source-in",
				...style,
			}}
			data-testid="photo-surround"
		>
			{/* the mask above stays put; a moving frame (the board's pan) moves only what is inside */}
			<div ref={layerRef} data-surround-layer className="absolute inset-0">
				{reveal ? (
					<>
						<div className="absolute inset-0 opacity-25">{strokes}</div>
						<div
							className="absolute inset-0"
							style={{
								opacity: "var(--rigi-reveal-opacity)",
								maskImage: reveal.fill,
								WebkitMaskImage: reveal.fill,
							}}
						>
							{strokes}
							{labels}
						</div>
						<div
							className="absolute inset-0 brightness-[1.8] mix-blend-screen light:mix-blend-normal"
							style={{
								opacity: "var(--rigi-reveal-opacity)",
								maskImage: reveal.front,
								WebkitMaskImage: reveal.front,
							}}
						>
							{strokes}
						</div>
					</>
				) : (
					<>
						{strokes}
						{labels}
					</>
				)}
			</div>
		</div>
	);
}
