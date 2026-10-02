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
import { type SurroundBake, SurroundLayer } from "./Surround";

// The bloom's ellipse in the photo's box: centred below the bottom edge so the front climbs from the
// foreground to the skyline. A surround gets the same ellipse in its own box (see `revealAt`).
const CENTRE = { x: 0.5, y: 1.15 };
const RADIUS = { x: 1.4, y: 1.2 };

/** The fill and front-band masks for an ellipse given as a radial-gradient shape and position. */
export function revealMasks(at: string) {
	const r = "var(--rigi-reveal)";
	return {
		fill: `radial-gradient(${at}, #000 calc(${r} - 6%), transparent ${r})`,
		front: `radial-gradient(${at}, transparent calc(${r} - 9%), #000 calc(${r} - 3%), transparent calc(${r} + 1%))`,
	};
}

const pc = (v: number) => `${(v * 100).toFixed(2)}%`;

/** The photo's ellipse, expressed in a canvas holding the photo at `photo` (fractions of it). */
function revealAt(photo: SurroundBake["photo"]) {
	return `ellipse ${pc(RADIUS.x * photo.w)} ${pc(RADIUS.y * photo.h)} at ${pc(photo.x + CENTRE.x * photo.w)} ${pc(photo.y + CENTRE.y * photo.h)}`;
}

/** Mask radius (%) at which every corner of a canvas around the photo is past the front band. */
function fullRadius(photo: SurroundBake["photo"]) {
	const xs = [-photo.x / photo.w, (1 - photo.x) / photo.w];
	const ys = [-photo.y / photo.h, (1 - photo.y) / photo.h];
	let far = 0;
	for (const x of xs)
		for (const y of ys)
			far = Math.max(
				far,
				Math.hypot((x - CENTRE.x) / RADIUS.x, (y - CENTRE.y) / RADIUS.y),
			);
	return Math.max(FULL, far * 100 + 12);
}

const PHOTO_MASKS = revealMasks(
	`ellipse ${pc(RADIUS.x)} ${pc(RADIUS.y)} at ${pc(CENTRE.x)} ${pc(CENTRE.y)}`,
);

const CSS = `
.rigi-reveal-fill {
	-webkit-mask-image: ${PHOTO_MASKS.fill};
	mask-image: ${PHOTO_MASKS.fill};
}
.rigi-reveal-front {
	-webkit-mask-image: ${PHOTO_MASKS.front};
	mask-image: ${PHOTO_MASKS.front};
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
	surround,
	surroundClassName,
	photoSet,
	overlaySet,
	sizes,
}: {
	photo: string;
	overlay: string;
	alt: string;
	aspect: number;
	className?: string;
	/** Baked terrain around the photo; the bloom carries on across it from the same centre. */
	surround?: SurroundBake;
	/** Classes for the outer box when there is a surround (its margins, say). */
	surroundClassName?: string;
	/** `srcset` of the photo and overlay; same width candidates (and `sizes`) so the masks line up. */
	photoSet?: string;
	overlaySet?: string;
	sizes?: string;
}) {
	const box = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLDivElement>(null);
	const over = useRef<HTMLImageElement>(null);
	const full = surround ? fullRadius(surround.photo) : FULL;
	useEffect(() => {
		const root = frame.current;
		// the radius and fade live on the outer box so the photo and the surround share one front
		const el = box.current ?? frame.current;
		const img = over.current;
		if (!root || !el || !img) return;
		// skip the style write when neither value moved: the radius to 0.1% (about 0.25 px of the
		// box's radius), the opacity to 0.01
		let lastR = Number.NaN;
		let lastO = Number.NaN;
		const set = (r: number, o: number) => {
			const rq = Math.round(r * 10);
			const oq = Math.round(o * 100);
			if (rq !== lastR) {
				lastR = rq;
				el.style.setProperty("--rigi-reveal", `${r}%`);
			}
			if (oq !== lastO) {
				lastO = oq;
				el.style.setProperty("--rigi-reveal-opacity", String(o));
			}
		};
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			set(full, 1);
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
				if (fromLit && t < FADE_OUT) set(full, 1 - t / FADE_OUT);
				else if (t < lead) set(0, 1);
				else if (t < lead + SWEEP)
					set(START + (full - START) * ease((t - lead) / SWEEP), 1);
				else {
					set(full, 1);
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
	}, [full]);
	const photoFrame = (
		<div
			ref={frame}
			data-theme="dark"
			className={`relative overflow-hidden bg-black ${className ?? ""}`}
			style={{ aspectRatio: aspect }}
			data-testid="reveal-loop"
		>
			<style>{CSS}</style>
			<img
				src={photo}
				srcSet={photoSet}
				sizes={sizes}
				alt={alt}
				className="absolute inset-0 size-full object-cover"
				loading="lazy"
				decoding="async"
			/>
			<div
				className="absolute inset-0"
				style={{ opacity: "var(--rigi-reveal-opacity)" }}
			>
				<img
					ref={over}
					src={overlay}
					srcSet={overlaySet}
					sizes={sizes}
					alt=""
					className="rigi-reveal-fill absolute inset-0 size-full object-cover"
					loading="lazy"
					decoding="async"
				/>
				<img
					src={overlay}
					srcSet={overlaySet}
					sizes={sizes}
					alt=""
					className="rigi-reveal-front absolute inset-0 size-full object-cover"
					loading="lazy"
					decoding="async"
				/>
			</div>
		</div>
	);
	if (!surround) return photoFrame;
	return (
		<div ref={box} className={`relative isolate ${surroundClassName ?? ""}`}>
			<SurroundLayer
				bake={surround}
				className="-z-10"
				reveal={revealMasks(revealAt(surround.photo))}
			/>
			{photoFrame}
		</div>
	);
}
