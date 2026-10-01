// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useRef, useState } from "react";

/** Before / after stills of the same frame with a draggable divider (pointer + keyboard). */
export function Compare({
	before,
	after,
	alt,
	aspect,
	className,
}: {
	before: string;
	after: string;
	alt: string;
	/** width / height of both images */
	aspect: number;
	className?: string;
}) {
	const [x, setX] = useState(0.42);
	const ref = useRef<HTMLDivElement>(null);
	const drag = useRef(false);
	const move = (clientX: number) => {
		const r = ref.current?.getBoundingClientRect();
		if (r) setX(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
	};
	return (
		<div
			ref={ref}
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
				alt={alt}
				className="absolute inset-0 size-full object-cover"
				draggable={false}
			/>
			<img
				src={before}
				alt=""
				className="absolute inset-0 size-full object-cover"
				style={{ clipPath: `inset(0 ${(1 - x) * 100}% 0 0)` }}
				draggable={false}
			/>
			<div
				role="slider"
				tabIndex={0}
				aria-label="Compare the original photo with the overlay"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(x * 100)}
				onKeyDown={(e) => {
					if (e.key === "ArrowLeft") setX((v) => Math.max(0, v - 0.05));
					if (e.key === "ArrowRight") setX((v) => Math.min(1, v + 0.05));
				}}
				className="absolute inset-y-0 -ml-px w-0.5 bg-white/90 shadow-[0_0_12px_rgba(0,0,0,0.5)] outline-none focus-visible:bg-[var(--rigi-glow)]"
				style={{ left: `${x * 100}%` }}
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
