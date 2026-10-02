// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useRef } from "react";

/** Before / after stills of the same frame with a draggable divider (pointer + keyboard). */
export function Compare({
	before,
	after,
	alt,
	aspect,
	className,
	onMove,
	beforeSet,
	afterSet,
	sizes,
	priority = false,
}: {
	before: string;
	after: string;
	alt: string;
	/** width / height of both images */
	aspect: number;
	className?: string;
	/** Called with the divider position (0 = all after, 1 = all before) whenever it moves. */
	onMove?: (v: number) => void;
	/** `srcset` of each image; give both the same width candidates (and `sizes`) so they line up. */
	beforeSet?: string;
	afterSet?: string;
	sizes?: string;
	/** Above the fold: the "before" image is fetched at high priority too (never lazy either way). */
	priority?: boolean;
}) {
	// the divider position lives in refs and is written straight to the DOM: a drag moves a clip
	// and a CSS left, with no React render per pointer move
	const x = useRef(0.42);
	const ref = useRef<HTMLDivElement>(null);
	const clip = useRef<HTMLImageElement>(null);
	const handle = useRef<HTMLDivElement>(null);
	const drag = useRef(false);
	const apply = (v: number) => {
		x.current = v;
		if (clip.current)
			clip.current.style.clipPath = `inset(0 ${(1 - v) * 100}% 0 0)`;
		if (handle.current) {
			handle.current.style.left = `${v * 100}%`;
			handle.current.setAttribute("aria-valuenow", String(Math.round(v * 100)));
		}
		onMove?.(v);
	};
	const move = (clientX: number) => {
		const r = ref.current?.getBoundingClientRect();
		if (r) apply(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
	};
	return (
		<div
			ref={ref}
			data-theme="dark"
			className={`relative cursor-ew-resize touch-pan-y overflow-hidden select-none ${className ?? ""}`}
			style={{ aspectRatio: aspect }}
			onPointerDown={(e) => {
				drag.current = true;
				e.currentTarget.setPointerCapture(e.pointerId);
				move(e.clientX);
			}}
			onPointerMove={(e) => drag.current && move(e.clientX)}
			onPointerUp={() => {
				drag.current = false;
			}}
			onPointerCancel={() => {
				drag.current = false;
			}}
		>
			<img
				src={after}
				srcSet={afterSet}
				sizes={sizes}
				alt={alt}
				className="absolute inset-0 size-full object-cover"
				fetchPriority="high"
				decoding="async"
				draggable={false}
			/>
			<img
				ref={clip}
				src={before}
				srcSet={beforeSet}
				sizes={sizes}
				fetchPriority={priority ? "high" : undefined}
				alt=""
				className="absolute inset-0 size-full object-cover"
				style={{ clipPath: "inset(0 58% 0 0)" }}
				decoding="async"
				draggable={false}
			/>
			<div
				ref={handle}
				role="slider"
				tabIndex={0}
				aria-label="Compare the original photo with the overlay"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={42}
				onKeyDown={(e) => {
					if (e.key === "ArrowLeft") apply(Math.max(0, x.current - 0.05));
					if (e.key === "ArrowRight") apply(Math.min(1, x.current + 0.05));
				}}
				className="absolute inset-y-0 -ml-px w-0.5 bg-white/90 shadow-[0_0_12px_rgba(0,0,0,0.5)] outline-none focus-visible:bg-[var(--rigi-glow)]"
				style={{ left: "42%" }}
			>
				<span className="absolute top-1/2 left-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-[11px] font-semibold text-black shadow-lg">
					⇆
				</span>
			</div>
			<span className="pointer-events-none absolute top-3 left-3 rounded-md bg-black/55 px-2 py-1 font-mono text-[10px] tracking-wide text-white/85 uppercase backdrop-blur">
				Photo
			</span>
			<span className="pointer-events-none absolute top-3 right-3 rounded-md bg-black/55 px-2 py-1 font-mono text-[10px] tracking-wide text-white/85 uppercase backdrop-blur">
				Rigi
			</span>
		</div>
	);
}
