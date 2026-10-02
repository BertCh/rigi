// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { BRAND, brandAlpha } from "#/brand/khipu";
import {
	type Angles,
	azEl,
	camera,
	dirENU,
	type Obs,
	project,
	smooth,
} from "#/components/site/how/model";
import {
	fullSweep,
	horizonDist,
	horizonEl,
	type RollPhoto,
	rollMismatch,
	rollObservations,
	useRoll,
	wrap180,
	wrap360,
} from "./data";

// "Where does this skyline fit?": the full 360° DEM skyline from where the photo was taken,
// unrolled into a panorama (N E S W N), with the photo's own skyline as an amber stencil on it.
// Directly under it, on the same heading axis, the photo's mismatch at every heading. The stencil
// starts at the solved heading with the compass tick beside it; drag it along the band and it
// glides into the nearest notch on release. Every number is computed here from public/demo/meta.

const DEFAULT_ID = "demo-09";
/** Mismatch cap (px at full size), as in rollMismatch. */
const CAP = 60;
/** A runner-up must lie at least this far from the best heading. */
const APART = 10;
/** The app's coarse search window either side of the compass (solve.ts). */
const SEARCH = 30;
/** Mismatch shown in the "good" tone. */
const GOOD_PX = 8;
const MONO = "var(--font-mono, ui-monospace)";
const DEG = Math.PI / 180;
const f1 = (v: number) => v.toFixed(1);

type Sweep = ReturnType<typeof fullSweep>;

type Stats = {
	sweep: Sweep;
	best: Sweep[number];
	runner: Sweep[number];
	/** Mismatch at the app's solved pose (px). */
	solvedCost: number;
	/** The sweep's global minimum is far from where the photo was actually taken. */
	decoy: boolean;
	elLo: number;
	elHi: number;
	hfov: number;
};

/**
 * Elevation angle → 0..1 up the panorama band, on an asinh scale so the few degrees round eye
 * level, where distant skylines sit, get most of the height.
 */
const stretch = (el: number) => Math.asinh(el / 0.7);
const heightOfEl = (s: Stats, el: number) =>
	(stretch(Math.min(s.elHi, Math.max(s.elLo, el))) - stretch(s.elLo)) /
	(stretch(s.elHi) - stretch(s.elLo));

function statsOf(p: RollPhoto, obs: Obs[]): Stats {
	const sweep = fullSweep(p);
	const best = sweep.reduce((a, b) => (b.cost < a.cost ? b : a));
	const runner = sweep
		.filter((s) => Math.abs(wrap180(s.yaw - best.yaw)) > APART)
		.reduce((a, b) => (b.cost < a.cost ? b : a));
	const solvedCost = rollMismatch(
		p,
		camera(p.solved, p.width, p.height),
		obs,
		CAP,
	);
	// percentiles, not extremes: a steep slope underfoot or a ridge right above the eye would
	// flatten the distant skyline that matters
	const sorted = [...p.horizon.elevation].sort((a, b) => a - b);
	const hfov =
		(2 *
			Math.atan(Math.tan((p.solved.vfov * DEG) / 2) * (p.width / p.height))) /
		DEG;
	return {
		sweep,
		best,
		runner,
		solvedCost,
		decoy: Math.abs(wrap180(best.yaw - p.solved.yaw)) > 5,
		elLo: sorted[Math.floor(sorted.length * 0.05)] - 0.3,
		elHi: sorted[Math.floor(sorted.length * 0.98)] + 0.3,
		hfov,
	};
}

/**
 * The camera at a dragged heading: the sweep's best pitch at that yaw with the phone's roll and
 * focal length, blending into the solved pose within a few degrees of it.
 */
function anglesAt(p: RollPhoto, s: Stats, yaw: number): Angles {
	const i = Math.round(wrap360(yaw)) % 360;
	const coarse: Angles = { ...p.prior, yaw, pitch: s.sweep[i].pitch };
	const w = smooth(1 - Math.abs(wrap180(yaw - p.solved.yaw)) / 3);
	return {
		yaw,
		pitch: coarse.pitch + (p.solved.pitch - coarse.pitch) * w,
		roll: coarse.roll + (p.solved.roll - coarse.roll) * w,
		vfov: coarse.vfov + (p.solved.vfov - coarse.vfov) * w,
	};
}

/** The deepest notch within ±win° of a heading: where a released wedge settles. */
function nearestNotch(p: RollPhoto, s: Stats, yaw: number, win = 9) {
	if (Math.abs(wrap180(yaw - p.solved.yaw)) < win) return p.solved.yaw;
	let best = { yaw, cost: Number.POSITIVE_INFINITY };
	for (let d = -win; d <= win; d++) {
		const e = s.sweep[Math.round(wrap360(yaw + d)) % 360];
		if (e.cost < best.cost) best = e;
	}
	return best.yaw;
}

function useReducedMotionOnce() {
	const [r] = useState(
		() =>
			typeof window !== "undefined" &&
			(window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
				navigator.webdriver === true),
	);
	return r;
}

export function FingerprintRing({ className }: { className?: string }) {
	const roll = useRoll();
	const [id, setId] = useState(DEFAULT_ID);
	if (!roll)
		return (
			<div
				className={`aspect-[16/10] animate-pulse rounded-md bg-white/5 ${className ?? ""}`}
			/>
		);
	const photo = roll.photos.find((p) => p.id === id) ?? roll.photos[0];
	return (
		<div className={className}>
			<Fingerprint key={photo.id} p={photo}>
				<Picker photos={roll.photos} id={photo.id} onPick={setId} />
			</Fingerprint>
		</div>
	);
}

/** Width of an element in CSS pixels, tracked. */
function useWidth<T extends HTMLElement>(fallback: number) {
	const ref = useRef<T>(null);
	const [w, setW] = useState(fallback);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setW(el.clientWidth));
		ro.observe(el);
		setW(el.clientWidth);
		return () => ro.disconnect();
	}, []);
	return [ref, w] as const;
}

function Fingerprint({ p, children }: { p: RollPhoto; children: ReactNode }) {
	const obs = useMemo(() => rollObservations(p), [p]);
	const s = useMemo(() => statsOf(p, obs), [p, obs]);
	const reduced = useReducedMotionOnce();
	const [yaw, setYaw] = useState(p.solved.yaw);
	const [dragging, setDragging] = useState(false);
	const grab = useRef<number | null>(null);
	const glide = useRef(0);
	useEffect(() => () => cancelAnimationFrame(glide.current), []);
	const [box, W] = useWidth<HTMLDivElement>(1000);

	const angles = useMemo(() => anglesAt(p, s, yaw), [p, s, yaw]);
	const cam = useMemo(
		() => camera(angles, p.width, p.height),
		[angles, p.width, p.height],
	);
	const cost = useMemo(() => rollMismatch(p, cam, obs, CAP), [p, cam, obs]);

	// ---- layout, in CSS pixels (the svg is drawn at its own width) ----
	const narrow = W < 560;
	const L = narrow ? 30 : 44;
	const R = narrow ? 8 : 14;
	const PT = 30; // room for the compass bracket
	const PH = Math.round(Math.min(210, Math.max(120, W * 0.19)));
	const PB = PT + PH;
	const MT = PB + 40;
	const MH = Math.round(Math.min(170, Math.max(110, W * 0.15)));
	const MB = MT + MH;
	const H = MB + 26;
	const X = (az: number) => L + ((W - L - R) * az) / 360;
	const pxPerDeg = (W - L - R) / 360;
	const yEl = (el: number) => PB - PH * heightOfEl(s, el);
	const yCost = (c: number) => MB - (MH * Math.min(c, CAP)) / CAP;

	// ---- dragging the stencil along the band ----
	const azAt = (e: ReactPointerEvent<SVGSVGElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		return ((e.clientX - r.left - L) / (W - L - R)) * 360;
	};
	const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
		cancelAnimationFrame(glide.current);
		const az = azAt(e);
		// grabbing inside the stencil keeps its offset; anywhere else jumps it there
		const off = wrap180(az - yaw);
		const keep = Math.abs(off) < s.hfov / 2;
		grab.current = keep ? off : 0;
		if (!keep) setYaw(wrap360(az));
		setDragging(true);
		e.currentTarget.setPointerCapture(e.pointerId);
	};
	const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
		if (grab.current === null) return;
		setYaw(wrap360(azAt(e) - grab.current));
	};
	const yawRef = useRef(yaw);
	yawRef.current = yaw;
	const onUp = useCallback(() => {
		if (grab.current === null) return;
		grab.current = null;
		setDragging(false);
		const from = yawRef.current;
		const to = from + wrap180(nearestNotch(p, s, from) - from);
		if (reduced) {
			setYaw(wrap360(to));
			return;
		}
		const t0 = performance.now();
		const step = (now: number) => {
			const k = smooth((now - t0) / 650);
			setYaw(wrap360(from + (to - from) * k));
			if (k < 1) glide.current = requestAnimationFrame(step);
		};
		glide.current = requestAnimationFrame(step);
	}, [p, s, reduced]);

	// ---- the panorama ----
	const { land, ridge } = (() => {
		const { step, elevation } = p.horizon;
		let d = "";
		for (let i = 0; i <= elevation.length; i++) {
			const x = X(i * step);
			const y = yEl(elevation[i % elevation.length]);
			d += `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
		}
		return { ridge: d, land: `${d}L${X(360)},${PB}L${X(0)},${PB}Z` };
	})();

	// The photo skyline as a stencil, unwrapped round the current heading.
	const stencil = (() => {
		let d = "";
		let prev: Obs | null = null;
		for (const o of obs) {
			const [az, el] = azEl(cam, o.x, o.y);
			// outside the band's range: break the stroke rather than clamp it flat
			if (el < s.elLo || el > s.elHi) {
				prev = null;
				continue;
			}
			const x = X(yaw + wrap180(az - yaw));
			const y = yEl(el);
			const jump = !prev || o.x - prev.x > p.width / 60;
			d += `${jump ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
			prev = o;
		}
		return d;
	})();
	// copies shifted a full turn, so a stencil across north shows at both ends
	const turn = X(360) - X(0);
	const copies =
		yaw - s.hfov / 2 < 0
			? [0, turn]
			: yaw + s.hfov / 2 > 360
				? [0, -turn]
				: [0];

	// ---- the mismatch curve ----
	const curve = (() => {
		let d = "";
		for (const e of [...s.sweep, { ...s.sweep[0], yaw: 360 }])
			d += `${d ? "L" : "M"}${X(e.yaw).toFixed(1)},${yCost(e.cost).toFixed(1)}`;
		return d;
	})();
	const searchRects = (() => {
		const lo = wrap360(p.prior.yaw - SEARCH);
		const hi = wrap360(p.prior.yaw + SEARCH);
		return lo < hi
			? [[lo, hi]]
			: [
					[lo, 360],
					[0, hi],
				];
	})();

	const delta = wrap180(p.solved.yaw - p.prior.yaw);
	const good = cost < GOOD_PX;
	const atSolved = Math.abs(wrap180(yaw - p.solved.yaw)) < 0.5;
	const ratio = s.runner.cost / s.best.cost;
	const fs = narrow ? 10 : 11.5;

	const text = (
		x: number,
		y: number,
		t: string,
		color: string,
		anchor: "start" | "middle" | "end" = "middle",
		size = fs,
	) => {
		// keep labels inside the card
		const a =
			anchor === "middle" && x < L + 40
				? "start"
				: anchor === "middle" && x > W - R - 40
					? "end"
					: anchor;
		return (
			<text
				x={x}
				y={y}
				textAnchor={a}
				fill={color}
				fontSize={size}
				fontFamily={MONO}
				stroke={BRAND.ink}
				strokeWidth={3.5}
				paintOrder="stroke"
			>
				{t}
			</text>
		);
	};

	// compass → solved bracket above the panorama
	const xc = X(p.prior.yaw);
	const xs = xc + delta * pxPerDeg;
	const yb = PT - 12;

	return (
		<figure className="overflow-hidden rounded-md bg-[var(--rigi-ink)]">
			{/* readout */}
			<div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-white/8 px-4 py-3 font-mono text-[11px] sm:px-6">
				<span className="flex items-center gap-2 text-white/45">
					<CompassGlyph yaw={yaw} prior={p.prior.yaw} />
					HEADING
					<span className="text-[13px] text-[var(--rigi-lesson)]">
						{f1(yaw)}°
					</span>
				</span>
				<span className="text-white/45">
					MISMATCH{" "}
					<span
						className={`text-[13px] ${good ? "text-[var(--rigi-result)]" : "text-[var(--rigi-trap)]"}`}
					>
						{f1(cost)} px
					</span>
				</span>
				<span className="ml-auto hidden text-white/30 sm:inline">
					drag the photo along the horizon
				</span>
				{!atSolved && (
					<button
						type="button"
						onClick={() => setYaw(p.solved.yaw)}
						className="text-[var(--rigi-glow)]/80 hover:text-[var(--rigi-glow)]"
					>
						← solved heading
					</button>
				)}
			</div>

			{/* the two bands, one heading axis */}
			<div className="px-1 pt-2 sm:px-3">
				<div ref={box}>
					<svg
						width={W}
						height={H}
						viewBox={`0 0 ${W} ${H}`}
						className={`block max-w-full select-none ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
						style={{ touchAction: "pan-y" }}
						role="img"
						aria-label={`The skyline all round the camera for ${p.id}, unrolled, with the photo's skyline placed at ${f1(yaw)}° and its mismatch at every heading below`}
						onPointerDown={onDown}
						onPointerMove={onMove}
						onPointerUp={onUp}
						onPointerCancel={onUp}
					>
						<defs>
							<clipPath id={`fp-band-${p.id}`}>
								<rect x={X(0)} y={0} width={turn} height={MB} />
							</clipPath>
						</defs>

						{/* panorama: land below the DEM skyline, eye level dotted */}
						<path d={land} fill={brandAlpha("paper", 0.07)} />
						<line
							x1={X(0)}
							x2={X(360)}
							y1={yEl(0)}
							y2={yEl(0)}
							stroke={brandAlpha("paper", 0.25)}
							strokeDasharray="1 4"
						/>
						{text(
							X(0) - 4,
							yEl(0) + 3.5,
							"eye",
							brandAlpha("paper", 0.4),
							"end",
							fs - 1,
						)}
						<path
							d={ridge}
							fill="none"
							stroke={brandAlpha("paper", 0.8)}
							strokeWidth={1.2}
							strokeDasharray="4 2"
						/>

						{/* the photo: its field of view and skyline stencil */}
						<g clipPath={`url(#fp-band-${p.id})`}>
							{copies.map((dx) => (
								<g key={dx} transform={`translate(${dx},0)`}>
									<rect
										x={X(yaw - s.hfov / 2)}
										y={PT}
										width={s.hfov * pxPerDeg}
										height={PH}
										fill={brandAlpha("lesson", 0.08)}
										stroke={brandAlpha("lesson", 0.35)}
									/>
									<path
										d={stencil}
										fill="none"
										stroke={BRAND.lesson}
										strokeWidth={2.4}
										strokeLinejoin="round"
									/>
								</g>
							))}
						</g>

						{/* compass tick and the bracket to where the skyline put it */}
						<line
							x1={xc}
							x2={xc}
							y1={yb - 6}
							y2={PB}
							stroke={brandAlpha("paper", 0.7)}
							strokeDasharray="4 3"
						/>
						{Math.abs(delta) > 1 && (
							<path
								d={`M${xc},${yb - 5}V${yb}H${xs}V${yb - 5}`}
								fill="none"
								stroke={BRAND.glow}
								strokeWidth={1.5}
							/>
						)}
						{text(
							xc + (delta > 0 ? -5 : 5),
							yb - 1,
							"compass",
							brandAlpha("paper", 0.7),
							delta > 0 ? "end" : "start",
						)}
						{Math.abs(delta) > 1 &&
							text(
								xs + (delta > 0 ? 5 : -5),
								yb - 1,
								`${f1(Math.abs(delta))}° off`,
								BRAND.glow,
								delta > 0 ? "start" : "end",
							)}

						{/* mismatch at every heading, same axis */}
						{text(
							L,
							MT - 14,
							"MISMATCH AT EVERY HEADING",
							brandAlpha("paper", 0.4),
							"start",
							fs - 1.5,
						)}
						{searchRects.map(([lo, hi]) => (
							<rect
								key={lo}
								x={X(lo)}
								y={MT}
								width={X(hi) - X(lo)}
								height={MH}
								fill={brandAlpha("glow", 0.1)}
							/>
						))}
						{text(
							X(p.prior.yaw),
							MT + 13,
							`searched ±${SEARCH}°`,
							brandAlpha("glow", 0.9),
						)}
						{[10, 30, 60].map((c) => (
							<g key={c}>
								<line
									x1={X(0)}
									x2={X(360)}
									y1={yCost(c)}
									y2={yCost(c)}
									stroke={brandAlpha("paper", c === CAP ? 0.12 : 0.07)}
								/>
								{text(
									X(0) - 5,
									yCost(c) + 3.5,
									`${c}`,
									brandAlpha("paper", 0.4),
									"end",
									fs - 1.5,
								)}
							</g>
						))}
						<line
							x1={X(0)}
							x2={X(360)}
							y1={MB}
							y2={MB}
							stroke={brandAlpha("paper", 0.25)}
						/>
						{text(
							X(0) - 5,
							MB + 3.5,
							"0 px",
							brandAlpha("paper", 0.4),
							"end",
							fs - 1.5,
						)}
						<path
							d={curve}
							fill="none"
							stroke={brandAlpha("trap", 0.85)}
							strokeWidth={1.5}
							strokeLinejoin="round"
						/>
						<line
							x1={xc}
							x2={xc}
							y1={MT}
							y2={MB}
							stroke={brandAlpha("paper", 0.55)}
							strokeDasharray="4 3"
						/>

						{/* best, runner-up, and (for a decoy) where the photo was really taken */}
						<circle
							cx={X(s.best.yaw)}
							cy={yCost(s.best.cost)}
							r={4}
							fill={s.decoy ? BRAND.trap : BRAND.result}
						/>
						{text(
							X(s.best.yaw) + (s.decoy ? -7 : 7),
							yCost(s.best.cost) + (s.decoy ? 15 : 4),
							`${s.decoy ? "decoy" : "best"} ${f1(s.best.cost)}`,
							s.decoy ? BRAND.trap : BRAND.result,
							s.decoy ? "end" : "start",
						)}
						{!s.decoy && (
							<>
								<circle
									cx={X(s.runner.yaw)}
									cy={yCost(s.runner.cost)}
									r={3.5}
									fill={BRAND.ink}
									stroke={brandAlpha("paper", 0.8)}
								/>
								{text(
									X(s.runner.yaw) + (narrow ? -6 : 0),
									yCost(s.runner.cost) + (narrow ? 4 : 17),
									`next ${f1(s.runner.cost)}`,
									brandAlpha("paper", 0.75),
									narrow ? "end" : "middle",
								)}
							</>
						)}

						{/* the cursor through both bands */}
						<line
							x1={X(wrap360(yaw))}
							x2={X(wrap360(yaw))}
							y1={PT}
							y2={MB}
							stroke={BRAND.lesson}
							strokeWidth={1.4}
						/>
						<circle
							cx={X(wrap360(yaw))}
							cy={yCost(cost)}
							r={3.5}
							fill={BRAND.lesson}
						/>

						{s.decoy && (
							<>
								{/* the fine solve also refines tilt, roll and lens, so it sits below the
								    heading-only curve: a hollow marker with a leader, not a curve point */}
								<line
									x1={X(p.solved.yaw)}
									x2={X(p.solved.yaw)}
									y1={yCost(
										s.sweep[Math.round(wrap360(p.solved.yaw)) % 360].cost,
									)}
									y2={yCost(s.solvedCost)}
									stroke={BRAND.result}
									strokeDasharray="1.5 2.5"
								/>
								<circle
									cx={X(p.solved.yaw)}
									cy={yCost(s.solvedCost)}
									r={5.5}
									fill="none"
									stroke={BRAND.result}
									strokeWidth={1.8}
								/>
								{text(
									X(p.solved.yaw) + 7,
									yCost(s.solvedCost) + 15,
									`fine solve ${f1(s.solvedCost)}`,
									BRAND.result,
									"start",
								)}
							</>
						)}

						{/* heading axis */}
						{Array.from({ length: 13 }, (_, i) => i * 30).map((az) => (
							<g key={az}>
								<line
									x1={X(az)}
									x2={X(az)}
									y1={MB}
									y2={MB + (az % 90 === 0 ? 6 : 3)}
									stroke={brandAlpha("paper", 0.35)}
								/>
								{az % 90 === 0
									? text(
											X(az),
											MB + 18,
											"NESWN"[az / 90],
											brandAlpha("paper", 0.55),
											"middle",
											fs,
										)
									: !narrow &&
										text(
											X(az),
											MB + 18,
											`${az}°`,
											brandAlpha("paper", 0.3),
											"middle",
											fs - 2,
										)}
							</g>
						))}
					</svg>
				</div>
			</div>

			{/* the real photo, the numbers, the claim */}
			<div className="flex flex-col gap-4 border-t border-white/8 p-4 sm:p-6">
				<PhotoStrip p={p} cam={cam} obs={obs} />
				<dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg bg-white/8 font-mono text-[11px] sm:grid-cols-6">
					<Stat k="compass" v={`${f1(p.prior.yaw)}°`} />
					<Stat
						k="skyline"
						v={`${f1(p.solved.yaw)}°`}
						tone="text-[var(--rigi-lesson)]"
					/>
					<Stat
						k="off by"
						v={`${f1(Math.abs(delta))}°`}
						tone="text-[var(--rigi-glow)]"
					/>
					{s.decoy ? (
						<>
							<Stat
								k={`sweep low, ${Math.round(s.best.yaw)}°`}
								v={`${f1(s.best.cost)} px`}
								tone="text-[var(--rigi-trap)]"
							/>
							<Stat
								k={`taken here, ${Math.round(p.solved.yaw)}°`}
								v={`${f1(s.solvedCost)} px`}
								tone="text-[var(--rigi-result)]"
							/>
						</>
					) : (
						<>
							<Stat
								k="best, 1° sweep"
								v={`${f1(s.best.cost)} px`}
								tone="text-[var(--rigi-result)]"
							/>
							<Stat
								k={`next, ${Math.round(Math.abs(wrap180(s.runner.yaw - s.best.yaw)))}° away`}
								v={`${f1(s.runner.cost)} px`}
							/>
						</>
					)}
					<Stat
						k="solver"
						v={p.accepted ? "accepted" : "rejected"}
						tone={
							p.accepted
								? "text-[var(--rigi-result)]"
								: "text-[var(--rigi-trap)]"
						}
					/>
				</dl>
				<figcaption className="max-w-3xl text-[13.5px] leading-relaxed text-white/60">
					<Claim p={p} s={s} delta={delta} ratio={ratio} />
				</figcaption>
				{children}
			</div>
		</figure>
	);
}

/** A tiny compass: north up, the photo's heading in amber, the phone's compass dashed. */
function CompassGlyph({ yaw, prior }: { yaw: number; prior: number }) {
	const tip = (az: number, r: number) => [
		9 + r * Math.sin(az * DEG),
		9 - r * Math.cos(az * DEG),
	];
	const [ax, ay] = tip(yaw, 7);
	const [bx, by] = tip(prior, 7);
	return (
		<svg viewBox="0 0 18 18" className="size-[18px]" aria-hidden="true">
			<circle
				cx={9}
				cy={9}
				r={8}
				fill="none"
				stroke={brandAlpha("paper", 0.25)}
			/>
			<line x1={9} y1={1} x2={9} y2={3} stroke={brandAlpha("paper", 0.5)} />
			<line
				x1={9}
				y1={9}
				x2={bx}
				y2={by}
				stroke={brandAlpha("paper", 0.6)}
				strokeDasharray="1.5 1.5"
			/>
			<line
				x1={9}
				y1={9}
				x2={ax}
				y2={ay}
				stroke={BRAND.lesson}
				strokeWidth={1.6}
			/>
		</svg>
	);
}

function Claim({
	p,
	s,
	delta,
	ratio,
}: {
	p: RollPhoto;
	s: Stats;
	delta: number;
	ratio: number;
}) {
	const verdict = p.accepted
		? null
		: " The solver rejects this photo instead of guessing.";
	if (s.decoy)
		return (
			<>
				<span className="text-[var(--rigi-paper)]">
					For this photo, heading alone points the wrong way.
				</span>{" "}
				Turning only the heading, the lowest mismatch round the circle is at{" "}
				{f1(s.best.yaw)}° ({f1(s.best.cost)} px), a decoy. The photo was taken
				facing {f1(p.solved.yaw)}°, which fits better ({f1(s.solvedCost)} px)
				once tilt, roll and lens are refined too. That is why Rigi searches only
				about ±{SEARCH}° around the compass, and checks that no other heading
				comes close.{verdict}
			</>
		);
	return (
		<>
			<span className="text-[var(--rigi-paper)]">
				The compass said {f1(p.prior.yaw)}°; the skyline says {f1(p.solved.yaw)}
				°, {f1(Math.abs(delta))}° {delta > 0 ? "clockwise" : "anticlockwise"}.
			</span>{" "}
			For this photo, the skyline fits best there of all 360 headings:{" "}
			{f1(s.best.cost)} px on the 1° sweep, {f1(s.solvedCost)} px after the fine
			solve. The next-best heading, at {f1(s.runner.yaw)}°, is{" "}
			{f1(s.runner.cost)} px:{" "}
			{ratio >= 1.6
				? `${ratio.toFixed(1)}× worse, a clear fingerprint.`
				: `only ${ratio.toFixed(1)}× worse, so the compass is still needed to pick the right notch.`}
			{verdict}
		</>
	);
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: string }) {
	return (
		<div className="bg-[var(--rigi-ink)] px-3 py-2">
			<dt className="truncate text-[9.5px] tracking-[0.12em] text-white/35 uppercase">
				{k}
			</dt>
			<dd
				className={`mt-0.5 text-[13px] ${tone ?? "text-[var(--rigi-paper)]"}`}
			>
				{v}
			</dd>
		</div>
	);
}

/** The real photo's skyline band, with both skylines and the gaps at the current camera. */
function PhotoStrip({
	p,
	cam,
	obs,
}: {
	p: RollPhoto;
	cam: ReturnType<typeof camera>;
	obs: Obs[];
}) {
	const W = p.width;
	const H = p.height;
	// crop to the skyline band
	const ys = obs.map((o) => o.y);
	const lo = Math.max(0, Math.min(...ys) - 0.1 * H);
	const hi = Math.min(H, Math.max(...ys) + 0.1 * H);
	// at least a fifth of the height, at most a 4.5:1 strip, so it never turns into a portrait
	const bandH = Math.min(Math.max(hi - lo, 0.2 * H), W / 4.5);
	const y0 = Math.max(0, Math.min(H - bandH, (lo + hi) / 2 - bandH / 2));
	const dem = useMemo(() => {
		const hfovHalf = Math.atan(W / 2 / cam.f) / DEG + 4;
		const runs: string[] = [];
		let run = "";
		const centre = azEl(cam, W / 2, H / 2)[0];
		for (let d = -hfovHalf; d <= hfovHalf; d += p.horizon.step) {
			const az = centre + d;
			const q = project(cam, dirENU(az, horizonEl(p, az)));
			if (q && q[0] > -40 && q[0] < W + 40)
				run += `${run ? "L" : "M"}${q[0].toFixed(1)},${q[1].toFixed(1)}`;
			else if (run) {
				runs.push(run);
				run = "";
			}
		}
		if (run) runs.push(run);
		return runs.join("");
	}, [p, cam, W, H]);
	const gaps = useMemo(
		() =>
			obs.map((o) => {
				const [az, el] = azEl(cam, o.x, o.y);
				const dy = (el - horizonEl(p, az)) * DEG * cam.f;
				return { x: o.x, y: o.y, dy, far: horizonDist(p, az) };
			}),
		[p, cam, obs],
	);
	const photoPath = useMemo(() => {
		let d = "";
		let prev: Obs | null = null;
		for (const o of obs) {
			const jump =
				prev && (o.x - prev.x > W / 60 || Math.abs(o.y - prev.y) > 40);
			d += `${!prev || jump ? "M" : "L"}${o.x.toFixed(1)},${o.y.toFixed(1)}`;
			prev = o;
		}
		return d;
	}, [obs, W]);
	return (
		<div
			className="relative overflow-hidden rounded-lg"
			style={{ aspectRatio: `${W} / ${bandH}` }}
		>
			<svg
				viewBox={`0 ${y0} ${W} ${bandH}`}
				preserveAspectRatio="xMidYMid slice"
				className="absolute inset-0 size-full"
				aria-hidden="true"
			>
				<image
					href={p.photo}
					x={0}
					y={0}
					width={W}
					height={H}
					opacity={0.72}
					preserveAspectRatio="none"
				/>
				{gaps.map(
					(g, i) =>
						i % 2 === 0 &&
						Math.abs(g.dy) > 6 && (
							<line
								// biome-ignore lint/suspicious/noArrayIndexKey: fixed columns
								key={i}
								x1={g.x}
								y1={g.y}
								x2={g.x}
								y2={g.y - g.dy}
								stroke={BRAND.trap}
								strokeOpacity={0.8}
								strokeWidth={3}
							/>
						),
				)}
				<path
					d={dem}
					fill="none"
					stroke={BRAND.paper}
					strokeWidth={5}
					strokeDasharray="14 10"
				/>
				<path d={photoPath} fill="none" stroke={BRAND.lesson} strokeWidth={6} />
			</svg>
			<span className="absolute bottom-1.5 left-2 rounded bg-black/55 px-1.5 py-0.5 font-mono text-[9.5px] text-white/70">
				<span className="text-[var(--rigi-lesson)]">━</span> photo{" "}
				<span className="ml-1 text-white/80">┅</span> terrain
			</span>
		</div>
	);
}

function Picker({
	photos,
	id,
	onPick,
}: {
	photos: RollPhoto[];
	id: string;
	onPick: (id: string) => void;
}) {
	// centre each 4:3 thumb's skyline in a 8:3 crop: object-position y = 2·row − ½
	const focus = (q: RollPhoto) => {
		const rows = q.skyline.rows.filter((r): r is number => r !== null).sort();
		const row = rows.length ? rows[Math.floor(rows.length / 2)] : 0.3;
		return `50% ${Math.round(100 * Math.min(1, Math.max(0, 2 * row - 0.5)))}%`;
	};
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<span className="mr-1 font-mono text-[10px] tracking-[0.14em] text-white/35 uppercase">
				Photo
			</span>
			{photos.map((q) => (
				<button
					key={q.id}
					type="button"
					onClick={() => onPick(q.id)}
					aria-label={`${q.id}${q.accepted ? "" : " (rejected)"}`}
					aria-pressed={q.id === id}
					className={`relative h-6 w-16 overflow-hidden rounded ring-1 transition ${q.id === id ? "ring-[var(--rigi-glow)]" : "opacity-55 ring-white/10 hover:opacity-90"}`}
				>
					<img
						src={q.thumb}
						alt=""
						className="size-full object-cover"
						style={{ objectPosition: focus(q) }}
						loading="lazy"
					/>
					{!q.accepted && (
						<span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-[var(--rigi-trap)]" />
					)}
				</button>
			))}
		</div>
	);
}
