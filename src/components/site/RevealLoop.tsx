// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Landing-page beat: the overlay export blooms out over its photo from the foreground to the far
// skyline, with a bright band on the front, then stays lit. It is deliberate rather than ambient:
// it fires the moment three quarters of the frame is on screen, starts from the bare photo, lunges in
// from the foreground and slows onto the skyline. Scroll away
// (frame mostly gone) and it resets to the bare photo, so every return plays it again; hovering
// the finished frame for a moment replays it too. A rAF drives the masks' radius only while it
// sweeps; the engine isn't needed, so it stays light on the page.

import { useEffect, useRef } from "react";

const CSS = `
.rigi-reveal-fill {
	-webkit-mask-image: radial-gradient(ellipse 140% 120% at 50% 115%, #000 calc(var(--rigi-reveal) - 6%), transparent var(--rigi-reveal));
	mask-image: radial-gradient(ellipse 140% 120% at 50% 115%, #000 calc(var(--rigi-reveal) - 6%), transparent var(--rigi-reveal));
}
.rigi-reveal-front {
	-webkit-mask-image: radial-gradient(ellipse 140% 120% at 50% 115%, transparent calc(var(--rigi-reveal) - 9%), #000 calc(var(--rigi-reveal) - 3%), transparent calc(var(--rigi-reveal) + 1%));
	mask-image: radial-gradient(ellipse 140% 120% at 50% 115%, transparent calc(var(--rigi-reveal) - 9%), #000 calc(var(--rigi-reveal) - 3%), transparent calc(var(--rigi-reveal) + 1%));
	filter: brightness(1.8) saturate(1.3);
	mix-blend-mode: screen;
}
`;

/** Share of the frame (or of the viewport, if the frame is taller) on screen that fires it. */
const ARM = 0.75;
/** Below this share the beat resets to the bare photo, ready to play again. */
const RESET = 0.2;
/** Pointer must rest on the finished frame this long (ms) to replay. */
const HOVER = 350;
/** Timeline (ms): fade a lit frame out (replays only), hold the bare photo, sweep. */
const FADE_OUT = 450;
const LEAD = 80;
const SWEEP = 4200;
/** Mask radius (%) where the front band reaches the bottom edge (the centre sits below the frame),
 * so the sweep starts already in view rather than spending its first beat off-screen. */
const START = 10;
/** Mask radius (%) at which the whole frame is lit and the front band is past the corners. */
const FULL = 135;

// ease-out: lunges in from the foreground, then settles slowly onto the far skyline
const ease = (t: number) => 1 - (1 - t) ** 3;

type State = "idle" | "playing" | "done";

export function RevealLoop({
	photo,
	overlay,
	alt,
	aspect,
	className,
}: {
	photo: string;
	overlay: string;
	alt: string;
	aspect: number;
	className?: string;
}) {
	const frame = useRef<HTMLDivElement>(null);
	const layer = useRef<HTMLDivElement>(null);
	const over = useRef<HTMLImageElement>(null);
	useEffect(() => {
		const root = frame.current;
		const el = layer.current;
		const img = over.current;
		if (!root || !el || !img) return;
		const set = (r: number, o: number) => {
			el.style.setProperty("--rigi-reveal", `${r}%`);
			el.style.opacity = String(o);
		};
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			set(FULL, 1);
			return;
		}
		set(0, 1);

		let state: State = "idle";
		let raf = 0;
		let hover = 0;
		// the sweep should never run over a half-loaded overlay
		const ready = img.decode().catch(() => undefined);

		const stopSweep = () => {
			cancelAnimationFrame(raf);
			raf = 0;
		};
		const play = (fromLit: boolean) => {
			state = "playing";
			stopSweep();
			let t0 = 0;
			const lead = (fromLit ? FADE_OUT : 0) + LEAD;
			const step = (now: number) => {
				t0 ||= now;
				const t = now - t0;
				if (fromLit && t < FADE_OUT) set(FULL, 1 - t / FADE_OUT);
				else if (t < lead) set(0, 1);
				else if (t < lead + SWEEP)
					set(START + (FULL - START) * ease((t - lead) / SWEEP), 1);
				else {
					set(FULL, 1);
					raf = 0;
					state = "done";
					return;
				}
				raf = requestAnimationFrame(step);
			};
			raf = requestAnimationFrame(step);
		};

		const io = new IntersectionObserver(
			([e]) => {
				const viewH = e.rootBounds?.height ?? window.innerHeight;
				const span = Math.min(e.boundingClientRect.height, viewH) || 1;
				const shown = e.isIntersecting ? e.intersectionRect.height / span : 0;
				if (shown >= ARM && state === "idle") {
					state = "playing";
					ready.then(() => {
						if (state === "playing" && !raf) play(false);
					});
				}
				if (shown < RESET && (state === "playing" || state === "done")) {
					stopSweep();
					set(0, 1);
					state = "idle";
				}
			},
			{ threshold: Array.from({ length: 21 }, (_, i) => i / 20) },
		);
		io.observe(root);

		// a deliberate hover on the finished frame plays it again
		const enter = () => {
			clearTimeout(hover);
			hover = window.setTimeout(() => {
				if (state === "done") play(true);
			}, HOVER);
		};
		const leave = () => clearTimeout(hover);
		root.addEventListener("pointerenter", enter);
		root.addEventListener("pointerleave", leave);

		return () => {
			io.disconnect();
			stopSweep();
			clearTimeout(hover);
			root.removeEventListener("pointerenter", enter);
			root.removeEventListener("pointerleave", leave);
		};
	}, []);
	return (
		<div
			ref={frame}
			className={`relative overflow-hidden bg-black ${className ?? ""}`}
			style={{ aspectRatio: aspect }}
			data-testid="reveal-loop"
		>
			<style>{CSS}</style>
			<img
				src={photo}
				alt={alt}
				className="absolute inset-0 size-full object-cover"
				loading="lazy"
				decoding="async"
			/>
			<div ref={layer} className="absolute inset-0">
				<img
					ref={over}
					src={overlay}
					alt=""
					className="rigi-reveal-fill absolute inset-0 size-full object-cover"
					loading="lazy"
					decoding="async"
				/>
				<img
					src={overlay}
					alt=""
					className="rigi-reveal-front absolute inset-0 size-full object-cover"
					loading="lazy"
					decoding="async"
				/>
			</div>
		</div>
	);
}
