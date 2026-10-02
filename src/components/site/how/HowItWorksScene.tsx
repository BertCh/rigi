// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Pause, Play, RotateCcw } from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type Angles,
	camera,
	demSkyline,
	dirENU,
	lerpAngles,
	mismatch,
	observations,
	project,
	residuals,
	type Scene,
	signedDelta,
	smooth,
	yawSweep,
} from "./model";
import { type WorldState, WorldView } from "./WorldView";

// "How it works" as one animated scene: a real demo photo (public/demo/how/scene.json, baked by
// scripts/howitworks/bake.ts) goes from the phone's guess to an accepted pose, in six beats.
// The photo skyline, the DEM skyline, the gaps between them, the yaw sweep and the final pose
// are all computed from real data; only the timing is staged. When it has played, the terrain
// line can be dragged off and springs back.

const SCENE_URL = "/demo/how/scene.json";
/** Fraction of the photo height shown: the skyline band, not the foreground. */
const CROP = 0.5;
const SWEEP = 30;

const C = {
	photo: "#e59e1f", // --rigi-lesson
	terrain: "#f4f4f4", // --rigi-paper
	glow: "#bb8b54",
	bad: "#ee9086", // --rigi-trap
	good: "#8d917a", // --rigi-result
};

type BeatKey = "guess" | "skyline" | "terrain" | "measure" | "correct" | "snap";
const BEATS: { key: BeatKey; title: string; t0: number }[] = [
	{ key: "guess", title: "Guess", t0: 0 },
	{ key: "skyline", title: "Photo skyline", t0: 4.5 },
	{ key: "terrain", title: "Terrain skyline", t0: 8 },
	{ key: "measure", title: "Measure", t0: 12.5 },
	{ key: "correct", title: "Correct", t0: 15.5 },
	{ key: "snap", title: "Snap", t0: 23 },
];
const END = 28;
// Inside "correct": out to the left edge, sweep across, settle on the coarse minimum, fine solve.
const T_SWEEP0 = 16.1;
const T_SWEEP1 = 19.1;
const T_COARSE = 20.2;
const T_FINE = 22.4;

/** Leader length (px) for a label at stack level k. */
const stemPx = (small: boolean, k: number) =>
	(small ? 12 : 22) + k * (small ? 19 : 24);

const beatAt = (t: number) =>
	BEATS.reduce((cur, b, i) => (t >= b.t0 ? i : cur), 0);

const ramp = (t: number, t0: number, dur: number) => smooth((t - t0) / dur);

/** Fetch scene.json (and mount the stage) only once the placeholder is within `margin` of the viewport. */
function useScene(holder: RefObject<HTMLElement | null>, immediate: boolean) {
	const [scene, setScene] = useState<Scene | null>(null);
	const [near, setNear] = useState(immediate);
	useEffect(() => {
		const el = holder.current;
		if (near || !el) return;
		if (typeof IntersectionObserver === "undefined") {
			setNear(true);
			return;
		}
		const io = new IntersectionObserver(
			([e]) => {
				if (e.isIntersecting) setNear(true);
			},
			{ rootMargin: "600px 0px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [near, holder]);
	useEffect(() => {
		if (!near) return;
		let live = true;
		fetch(SCENE_URL)
			.then((r) => (r.ok ? (r.json() as Promise<Scene>) : null))
			.then((s) => live && setScene(s))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [near]);
	return scene;
}

export function HowItWorksScene({
	className,
	at,
}: {
	className?: string;
	/** Freeze the scene at this time (s), e.g. for screenshots. */
	at?: number;
}) {
	const holder = useRef<HTMLDivElement>(null);
	const scene = useScene(holder, at !== undefined);
	if (!scene)
		return (
			<div
				ref={holder}
				className={`aspect-[16/11] animate-pulse rounded-2xl bg-white/5 ring-1 ring-white/8 ${className ?? ""}`}
			/>
		);
	return <Stage scene={scene} className={className} at={at} />;
}

function Stage({
	scene,
	className,
	at,
}: {
	scene: Scene;
	className?: string;
	at?: number;
}) {
	const W = scene.width;
	const H = scene.height;
	const VH = Math.round(H * CROP);
	const obs = useMemo(() => observations(scene), [scene]);
	const sweep = useMemo(() => yawSweep(scene, obs, SWEEP), [scene, obs]);
	const coarse = useMemo(
		() => sweep.reduce((a, b) => (b.cost < a.cost ? b : a)),
		[sweep],
	);
	const score = useMemo(() => {
		const at = (a: Angles) =>
			mismatch(residuals(scene, camera(a, W, H), obs), obs);
		return { prior: at(scene.prior), solved: at(scene.solved) };
	}, [scene, obs, W, H]);

	// ---- playback ----
	const reduced = useReducedMotionOnce();
	const [t, setT] = useState(() => at ?? (reduced ? END : 0));
	const [playing, setPlaying] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	const viewport = useRef<HTMLDivElement>(null);
	const [viewW, setViewW] = useState(1000);
	useEffect(() => {
		const el = viewport.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setViewW(el.clientWidth));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const started = useRef(false);
	// In view (any pixel): the clock only runs, and the stage only re-renders, while this is true.
	const [inView, setInView] = useState(true);
	useEffect(() => {
		const el = box.current;
		if (!el || reduced || at !== undefined) return;
		const io = new IntersectionObserver(
			([e]) => {
				setInView(e.isIntersecting);
				if (e.intersectionRatio >= 0.45 && !started.current) {
					started.current = true;
					setPlaying(true);
				}
			},
			{ threshold: [0, 0.45] },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [reduced, at]);
	const tRef = useRef(t);
	tRef.current = t;
	useEffect(() => {
		if (!playing || !inView) return;
		let raf = 0;
		let last = performance.now();
		const tick = (now: number) => {
			raf = requestAnimationFrame(tick);
			// ~30 commits/s: the clock is slow, each commit re-renders SVG, labels and two canvases.
			if (now - last < 28) return;
			const dt = Math.min(0.05, (now - last) / 1000);
			last = now;
			const n = tRef.current + dt;
			tRef.current = n;
			if (n >= END) {
				cancelAnimationFrame(raf);
				setT(END);
				setPlaying(false);
				return;
			}
			setT(n);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [playing, inView]);

	// ---- drag the terrain line off, it springs back ----
	const [nudge, setNudge] = useState({ yaw: 0, pitch: 0 });
	const drag = useRef<{ x: number; y: number; w: number } | null>(null);
	const spring = useRef(0);
	const done = t >= END;
	const hfov =
		(2 *
			Math.atan(Math.tan((scene.solved.vfov * Math.PI) / 360) * (W / H)) *
			180) /
		Math.PI;
	const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (!done) return;
		cancelAnimationFrame(spring.current);
		const r = e.currentTarget.getBoundingClientRect();
		drag.current = { x: e.clientX, y: e.clientY, w: r.width };
		e.currentTarget.setPointerCapture(e.pointerId);
	};
	const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d) return;
		const k = hfov / d.w;
		setNudge({
			yaw: Math.max(-SWEEP, Math.min(SWEEP, -(e.clientX - d.x) * k)),
			pitch: Math.max(-6, Math.min(6, (e.clientY - d.y) * k)),
		});
	};
	const onUp = useCallback(() => {
		if (!drag.current) return;
		drag.current = null;
		const from = { ...nudgeRef.current };
		const t0 = performance.now();
		const step = (now: number) => {
			const x = Math.min(1, (now - t0) / 900);
			// ease-out with a little overshoot: the snap
			const k = 1 - (1 + 2.2 * x) * (1 - x) ** 2.2;
			setNudge({ yaw: from.yaw * (1 - k), pitch: from.pitch * (1 - k) });
			if (x < 1) spring.current = requestAnimationFrame(step);
		};
		spring.current = requestAnimationFrame(step);
	}, []);
	const nudgeRef = useRef(nudge);
	nudgeRef.current = nudge;
	useEffect(() => () => cancelAnimationFrame(spring.current), []);

	// ---- the state at time t ----
	const pose: Angles = useMemo(() => {
		const p = scene.prior;
		let a: Angles;
		if (t < BEATS[4].t0) a = p;
		else if (t < T_SWEEP0) {
			const k = ramp(t, BEATS[4].t0, T_SWEEP0 - BEATS[4].t0);
			a = { ...p, yaw: p.yaw - SWEEP * k };
		} else if (t < T_SWEEP1) {
			const k = (t - T_SWEEP0) / (T_SWEEP1 - T_SWEEP0);
			a = { ...p, yaw: p.yaw - SWEEP + 2 * SWEEP * k };
		} else if (t < T_COARSE) {
			const k = ramp(t, T_SWEEP1, T_COARSE - T_SWEEP1);
			a = lerpAngles(
				{ ...p, yaw: p.yaw + SWEEP },
				{ ...p, yaw: coarse.yaw, pitch: coarse.pitch },
				k,
			);
		} else {
			const k = ramp(t, T_COARSE, T_FINE - T_COARSE);
			a = lerpAngles(
				{ ...p, yaw: coarse.yaw, pitch: coarse.pitch },
				scene.solved,
				k,
			);
		}
		return {
			...a,
			yaw: a.yaw + nudge.yaw,
			pitch: a.pitch + nudge.pitch,
		};
	}, [t, scene, coarse, nudge]);

	const cam = useMemo(() => camera(pose, W, H), [pose, W, H]);
	const res = useMemo(() => residuals(scene, cam, obs), [scene, cam, obs]);
	const now = mismatch(res, obs);
	const runs = useMemo(() => demSkyline(scene, cam), [scene, cam]);
	const photoPath = useMemo(() => {
		let d = "";
		let pen = false;
		scene.skyline.rows.forEach((r, i) => {
			if (r === null) {
				pen = false;
				return;
			}
			const x = (i + 0.5) * scene.skyline.step * W;
			d += `${pen ? "L" : "M"}${x.toFixed(1)} ${(r * H).toFixed(1)}`;
			pen = true;
		});
		return d;
	}, [scene, W, H]);

	const beat = beatAt(t);
	const vis = {
		photoLine: ramp(t, BEATS[1].t0 + 0.4, 2),
		demLine: ramp(t, BEATS[2].t0 + 1.6, 1.8),
		ticks: ramp(t, BEATS[3].t0 + 0.2, 1.4),
		eyeSnap: ramp(t, BEATS[2].t0 + 0.3, 1.2),
		labelsSolid: ramp(t, BEATS[5].t0 + 0.2, 0.8),
		accepted: ramp(t, BEATS[5].t0 + 2.2, 0.6),
		curve:
			t < T_SWEEP0 ? 0 : Math.min(1, (t - T_SWEEP0) / (T_SWEEP1 - T_SWEEP0)),
	};
	const labelsAlpha =
		beat === 0
			? ramp(t, 1.2, 0.8)
			: beat >= 5
				? 1
				: 0.32 + 0.68 * (1 - ramp(t, BEATS[1].t0, 0.6));
	const off = Math.abs(nudge.yaw) + Math.abs(nudge.pitch) > 0.6;

	const world: WorldState = {
		pose,
		fan: Math.abs(signedDelta(scene.solved.yaw - scene.prior.yaw)) + 2,
		uncertainty: ramp(t, 0.8, 1.2) * (1 - ramp(t, T_COARSE, 1.4)),
		wedge: ramp(t, 0.3, 0.9),
		footprint: ramp(t, BEATS[2].t0 + 1.8, 1.6),
		peaks: ramp(t, BEATS[5].t0 + 0.4, 1),
		eyeSnap: vis.eyeSnap,
	};

	const seek = (b: number) => {
		cancelAnimationFrame(spring.current);
		setNudge({ yaw: 0, pitch: 0 });
		tRef.current = BEATS[b].t0;
		setT(BEATS[b].t0);
		setPlaying(true);
	};
	const dYaw = signedDelta(scene.solved.yaw - scene.prior.yaw);
	const captions: Record<BeatKey, string> = {
		guess: `The phone records GPS, tilt and a compass heading of ${scene.prior.yaw.toFixed(1)}°. The compass is ${Math.abs(dYaw).toFixed(0)}° off here, enough to put names on the wrong summits.`,
		skyline:
			"Rigi traces the skyline in the photo, the edge between sky and mountain, column by column.",
		terrain:
			scene.gpsAlt !== null && scene.ground - scene.gpsAlt > 20
				? `GPS altitude reads ${Math.round(scene.gpsAlt)} m, ${Math.round(scene.ground - scene.gpsAlt)} m inside the mountain, so the eye snaps to the ground. From there the elevation model predicts the skyline in every direction.`
				: "The eye is placed on the elevation model, and the terrain is traced outwards in every direction to predict the skyline.",
		measure:
			"Wherever the two skylines disagree, the gap is measured. Their average is the mismatch to drive down.",
		correct:
			"A wide sweep over heading finds the dip in mismatch. A fine solve then adjusts heading, tilt, roll and focal length together.",
		snap: `Mismatch falls from ${score.prior.toFixed(0)} px to ${score.solved.toFixed(0)} px and the pose is accepted. The peaks now sit on their summits.`,
	};

	// Peak labels at the current pose, staggered when they crowd.
	const labels = useMemo(() => {
		const out: {
			name: string;
			ele: number;
			x: number;
			y: number;
			lift: number;
		}[] = [];
		const placed = scene.peaks
			.map((p) => ({ p, q: project(cam, dirENU(p.az, p.el)) }))
			.filter(
				(v) =>
					v.q && v.q[0] > 20 && v.q[0] < W - 20 && v.q[1] > 0 && v.q[1] < VH,
			)
			.sort((a, b) => (a.q?.[0] ?? 0) - (b.q?.[0] ?? 0));
		// Place each label box in screen pixels at the lowest of three stem heights where it overlaps
		// no box already placed and stays inside the frame; otherwise leave it out (narrow screens).
		const px = viewW / W;
		const small = viewW < 640;
		const boxes: [number, number, number, number][] = [];
		// Highest first, so the big names win when space is short.
		for (const { p, q } of [...placed].sort((a, b) => b.p.ele - a.p.ele)) {
			if (!q) continue;
			const name = p.name.split(" / ")[0];
			const w = name.length * (small ? 5.6 : 6.6) + (small ? 14 : 44);
			const h = small ? 17 : 20;
			const x = q[0] * px;
			const y = q[1] * px;
			const lift = [0, 1, 2].findIndex((k) => {
				const bottom = y - stemPx(small, k) - 2;
				const r: [number, number, number, number] = [
					x - w / 2,
					bottom - h,
					x + w / 2,
					bottom,
				];
				if (r[1] < 2) return false;
				if (
					boxes.some(
						(o) =>
							r[0] < o[2] + 4 &&
							r[2] > o[0] - 4 &&
							r[1] < o[3] + 2 &&
							r[3] > o[1] - 2,
					)
				)
					return false;
				boxes.push(r);
				return true;
			});
			if (lift < 0) continue;
			out.push({ name, ele: p.ele, x: q[0], y: q[1], lift });
		}
		return out.sort((a, b) => a.x - b.x);
	}, [scene, cam, W, VH, viewW]);

	const [sweepMin, sweepMax] = useMemo(() => {
		const costs = sweep.map((s) => s.cost);
		return [Math.min(...costs), Math.max(...costs)];
	}, [sweep]);

	return (
		<div
			ref={box}
			className={`overflow-hidden rounded-2xl bg-black/30 ring-1 ring-white/10 ${className ?? ""}`}
		>
			{/* chapters */}
			<div className="flex items-center gap-1 border-b border-white/8 px-2 py-2 sm:px-3">
				<div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]">
					{BEATS.map((b, i) => {
						const t1 = BEATS[i + 1]?.t0 ?? END;
						const p = Math.max(0, Math.min(1, (t - b.t0) / (t1 - b.t0)));
						return (
							<button
								key={b.key}
								type="button"
								onClick={() => seek(i)}
								className={`group relative shrink-0 rounded-md px-2.5 pt-1.5 pb-2 text-left transition ${i === beat ? "bg-white/8" : "hover:bg-white/5"}`}
							>
								<span className="block font-mono text-[9.5px] tracking-[0.14em] text-white/35">
									0{i + 1}
								</span>
								<span
									className={`block text-[12px] font-medium whitespace-nowrap ${i <= beat ? "text-[var(--rigi-paper)]" : "text-white/40"}`}
								>
									{b.title}
								</span>
								<span className="absolute inset-x-2.5 bottom-1 h-px bg-white/10">
									<span
										className="block h-full bg-[var(--rigi-glow)]"
										style={{ width: `${p * 100}%` }}
									/>
								</span>
							</button>
						);
					})}
				</div>
				<button
					type="button"
					aria-label={done ? "Replay" : playing ? "Pause" : "Play"}
					onClick={() => (done ? seek(0) : setPlaying((v) => !v))}
					className="grid size-8 shrink-0 place-items-center rounded-lg text-white/60 hover:bg-white/8 hover:text-[var(--rigi-paper)]"
				>
					{done ? (
						<RotateCcw className="size-4" />
					) : playing ? (
						<Pause className="size-4" />
					) : (
						<Play className="size-4" />
					)}
				</button>
			</div>

			{/* the viewport */}
			<div className="relative">
				<div
					ref={viewport}
					className={`relative overflow-hidden select-none ${done ? "cursor-grab active:cursor-grabbing" : ""}`}
					style={{ aspectRatio: `${W} / ${VH}`, touchAction: "pan-y" }}
					onPointerDown={onDown}
					onPointerMove={onMove}
					onPointerUp={onUp}
					onPointerCancel={onUp}
				>
					{/* brightness(b) = a black overlay at 1 - b (b <= 1), and it commutes with the
					    saturate: the photo is filtered once, only the overlay's opacity animates */}
					<div className="absolute inset-x-0 top-0">
						<img
							src={scene.photo}
							alt="Looking south-east from Niederhorn towards the Eiger, Mönch and Jungfrau"
							draggable={false}
							className="block w-full"
							style={{ filter: "saturate(0.9)" }}
						/>
						<div
							className="absolute inset-0 bg-black"
							style={{ opacity: 0.08 + 0.2 * vis.photoLine }}
						/>
					</div>
					<svg
						viewBox={`0 0 ${W} ${VH}`}
						preserveAspectRatio="none"
						className="absolute inset-0 size-full"
						aria-hidden="true"
					>
						<defs>
							<clipPath id="how-photo-clip">
								<rect x="0" y="0" width={W * vis.photoLine} height={VH} />
							</clipPath>
							<clipPath id="how-dem-clip">
								<rect x="0" y="0" width={W * vis.demLine} height={VH} />
							</clipPath>
						</defs>

						{/* gaps between the skylines */}
						{vis.ticks > 0 &&
							obs.map((o, i) => {
								if (i % 3) return null;
								const r = res[i];
								if (!Number.isFinite(r)) return null;
								const a = Math.min(1, Math.abs(r) / 40);
								return (
									<line
										key={o.x}
										x1={o.x}
										x2={o.x}
										y1={o.y}
										y2={o.y + r * vis.ticks}
										stroke={Math.abs(r) < 8 ? C.good : C.bad}
										strokeOpacity={0.35 + 0.6 * a}
										strokeWidth={1.4}
										vectorEffect="non-scaling-stroke"
									/>
								);
							})}

						{/* the photo's skyline */}
						<g clipPath="url(#how-photo-clip)">
							<path
								d={photoPath}
								fill="none"
								stroke="black"
								strokeOpacity={0.35}
								strokeWidth={5}
								vectorEffect="non-scaling-stroke"
							/>
							<path
								d={photoPath}
								fill="none"
								stroke={C.photo}
								strokeWidth={2.4}
								strokeLinejoin="round"
								vectorEffect="non-scaling-stroke"
							/>
						</g>

						{/* the terrain's skyline at the current pose */}
						<g clipPath="url(#how-dem-clip)">
							{runs.map((run) => {
								const d = run
									.map(
										(p, k) =>
											`${k ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`,
									)
									.join("");
								return (
									<g key={`${run[0][0].toFixed(0)}`}>
										<path
											d={d}
											fill="none"
											stroke="black"
											strokeOpacity={0.4}
											strokeWidth={4.5}
											vectorEffect="non-scaling-stroke"
										/>
										<path
											d={d}
											fill="none"
											stroke={C.terrain}
											strokeWidth={1.8}
											strokeDasharray={done && !off ? undefined : "7 5"}
											vectorEffect="non-scaling-stroke"
										/>
									</g>
								);
							})}
						</g>
					</svg>

					{/* peak labels */}
					{labels.map((l) => {
						const solid = vis.labelsSolid > 0.5 && !off;
						const stem = stemPx(viewW < 640, l.lift);
						return (
							<div
								key={l.name}
								className="pointer-events-none absolute"
								style={{
									left: `${(l.x / W) * 100}%`,
									top: `${(l.y / VH) * 100}%`,
									opacity: labelsAlpha,
								}}
							>
								<span
									className="absolute left-0 w-px -translate-x-1/2"
									style={{
										bottom: 0,
										height: stem,
										background: solid ? C.glow : "rgba(244,244,244,0.5)",
									}}
								/>
								<span
									className="absolute left-0 size-1.5 -translate-x-1/2 translate-y-1/2 rounded-full"
									style={{
										bottom: 0,
										background: solid ? C.glow : "transparent",
										border: solid ? "none" : "1px solid rgba(244,244,244,0.7)",
										boxShadow: solid
											? `0 0 0 ${4 * (1 - vis.labelsSolid) + 2}px rgba(187,139,84,${0.5 * (1 - vis.labelsSolid) + 0.15})`
											: "none",
									}}
								/>
								<span
									className={`absolute left-0 -translate-x-1/2 rounded px-1.5 py-0.5 text-[10.5px] leading-tight font-medium whitespace-nowrap sm:text-[12px] ${solid ? "bg-black/55 text-[var(--rigi-paper)]" : "border border-dashed border-white/40 bg-black/25 text-white/75"}`}
									style={{ bottom: stem + 2 }}
								>
									{l.name}
									{solid ? (
										<span className="ml-1 hidden font-mono text-[9.5px] text-white/50 sm:inline">
											{l.ele}
										</span>
									) : (
										<span className="ml-1 text-white/45">?</span>
									)}
								</span>
							</div>
						);
					})}

					{/* legend + mismatch */}
					<div className="pointer-events-none absolute top-2.5 right-2.5 hidden flex-col items-end gap-1.5 sm:top-3 sm:right-3 sm:flex">
						{vis.ticks > 0 && (
							<div className="rounded-lg bg-black/60 px-2.5 py-1.5 text-right backdrop-blur-sm">
								<div className="font-mono text-[9px] tracking-[0.14em] text-white/45 uppercase">
									mismatch
								</div>
								<div
									className="font-mono text-[17px] leading-none font-semibold tabular-nums"
									style={{ color: now < 8 ? C.good : C.bad }}
								>
									{now.toFixed(1)}
									<span className="ml-0.5 text-[10px] text-white/45">px</span>
								</div>
							</div>
						)}
					</div>

					{/* legend */}
					{vis.photoLine > 0 && (
						<div className="pointer-events-none absolute top-2.5 left-2.5 hidden flex-col items-start gap-0.5 sm:top-3 sm:left-3 rounded-lg bg-black/45 px-2 py-1 font-mono text-[9.5px] text-white/70 backdrop-blur-sm sm:flex">
							{vis.photoLine > 0 && (
								<span className="flex items-center gap-1.5">
									<i className="h-0.5 w-4" style={{ background: C.photo }} />
									photo skyline
								</span>
							)}
							{vis.demLine > 0 && (
								<span className="flex items-center gap-1.5">
									<i
										className="h-0.5 w-4"
										style={{
											background: `repeating-linear-gradient(90deg, ${C.terrain} 0 4px, transparent 4px 7px)`,
										}}
									/>
									terrain skyline
								</span>
							)}
						</div>
					)}
				</div>
				{/* caption */}
				<div className="pointer-events-none border-t border-white/8 bg-black/40 px-3 py-3 sm:absolute sm:inset-x-0 sm:bottom-0 sm:border-0 sm:bg-transparent sm:bg-gradient-to-t sm:from-black/80 sm:via-black/45 sm:to-transparent sm:px-4 sm:pt-10 sm:pb-4">
					<p
						key={beat}
						className="max-w-2xl animate-[how-in_500ms_ease-out] text-[12.5px] leading-snug text-white/90 sm:text-[14.5px]"
					>
						<span className="mr-2 font-mono text-[10px] tracking-[0.16em] text-[var(--rigi-glow)] uppercase">
							{BEATS[beat].title}
						</span>
						{captions[BEATS[beat].key]}
					</p>
					{done && (
						<p className="mt-1.5 font-mono text-[10px] text-white/45">
							Drag the photo sideways to knock the terrain line off. It snaps
							back.
						</p>
					)}
				</div>
			</div>

			{/* world + numbers */}
			<div className="grid gap-px bg-white/8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
				<div className="relative bg-[var(--rigi-ink)]">
					<WorldView
						scene={scene}
						state={world}
						className="aspect-[16/11] w-full sm:aspect-[16/7.4]"
					/>
					<div className="pointer-events-none absolute top-2.5 left-3 font-mono text-[9.5px] tracking-[0.14em] text-white/40 uppercase">
						The camera in the terrain
					</div>
					<div className="pointer-events-none absolute right-3 bottom-2 left-3 hidden flex-wrap justify-between gap-x-4 font-mono text-[9.5px] text-white/35 sm:flex">
						<span>
							<i
								className="mr-1 inline-block h-2 w-3 align-middle"
								style={{ background: "rgba(187,139,84,0.5)" }}
							/>
							view
							{world.uncertainty > 0.05 && (
								<>
									<i
										className="mr-1 ml-3 inline-block h-2 w-3 border border-dashed align-middle"
										style={{ borderColor: C.bad }}
									/>
									compass doubt
								</>
							)}
							{world.footprint > 0.05 && (
								<>
									<i
										className="mr-1 ml-3 inline-block h-0.5 w-3 align-middle"
										style={{ background: C.terrain }}
									/>
									ridges that form the skyline
								</>
							)}
						</span>
						<span>{scene.dem}</span>
					</div>
				</div>
				<Readout
					scene={scene}
					pose={pose}
					sweep={sweep}
					coarse={coarse}
					curve={vis.curve}
					range={[sweepMin, sweepMax]}
					accepted={vis.accepted * (off ? 0.25 : 1)}
					eyeSnap={vis.eyeSnap}
					mismatch={vis.ticks > 0 ? now : null}
				/>
			</div>
			<style>
				{
					"@keyframes how-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}"
				}
			</style>
		</div>
	);
}

function Readout({
	scene,
	pose,
	sweep,
	coarse,
	curve,
	range,
	accepted,
	eyeSnap,
	mismatch: gap,
}: {
	scene: Scene;
	pose: Angles;
	sweep: { yaw: number; cost: number }[];
	coarse: { yaw: number };
	curve: number;
	range: [number, number];
	accepted: number;
	eyeSnap: number;
	mismatch: number | null;
}) {
	const rows: { k: string; a: number; b: number; unit: string }[] = [
		{ k: "Heading", a: scene.prior.yaw, b: pose.yaw, unit: "°" },
		{ k: "Tilt", a: scene.prior.pitch, b: pose.pitch, unit: "°" },
		{ k: "Roll", a: scene.prior.roll, b: pose.roll, unit: "°" },
		{ k: "Field of view", a: scene.prior.vfov, b: pose.vfov, unit: "°" },
	];
	const eyeA = scene.gpsAlt ?? scene.eye;
	const eyeNow = eyeA + (scene.eye - eyeA) * eyeSnap;

	// cost curve geometry
	const VW = 300;
	const VHc = 74;
	const y0 = sweep[0].yaw;
	const y1 = sweep[sweep.length - 1].yaw;
	const X = (y: number) => ((y - y0) / (y1 - y0)) * VW;
	const Y = (c: number) =>
		8 + (1 - (c - range[0]) / (range[1] - range[0])) * (VHc - 20);
	// biome-ignore lint/correctness/useExhaustiveDependencies: X and Y derive from sweep and range
	const d = useMemo(
		() =>
			sweep
				.map(
					(s, i) =>
						`${i ? "L" : "M"}${X(s.yaw).toFixed(1)} ${Y(s.cost).toFixed(1)}`,
				)
				.join(""),
		[sweep, range[0], range[1]],
	);
	const cursor = signedDelta(pose.yaw - scene.prior.yaw);

	return (
		<div className="flex flex-col gap-4 bg-[var(--rigi-ink)] p-4 sm:p-5">
			<table className="w-full font-mono text-[11.5px] tabular-nums">
				<thead>
					<tr className="text-[9.5px] tracking-[0.12em] text-white/35 uppercase">
						<th className="pb-1.5 text-left font-normal">Camera</th>
						<th className="pb-1.5 text-right font-normal">Phone</th>
						<th className="pb-1.5 text-right font-normal">Now</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => {
						const delta = signedDelta(r.b - r.a);
						return (
							<tr key={r.k} className="border-t border-white/6">
								<td className="py-1 text-white/55">{r.k}</td>
								<td className="py-1 text-right text-white/45">
									{r.a.toFixed(1)}
									{r.unit}
								</td>
								<td
									className="py-1 text-right"
									style={{
										color:
											Math.abs(delta) > 0.05
												? "#e59e1f"
												: "rgba(244,244,244,0.8)",
									}}
								>
									{r.b.toFixed(1)}
									{r.unit}
								</td>
							</tr>
						);
					})}
					<tr className="border-t border-white/6">
						<td className="py-1 text-white/55">Eye height</td>
						<td className="py-1 text-right text-white/45">
							{Math.round(eyeA)} m
						</td>
						<td
							className="py-1 text-right"
							style={{
								color:
									eyeSnap > 0.02 && eyeSnap < 1
										? "#e59e1f"
										: "rgba(244,244,244,0.8)",
							}}
						>
							{Math.round(eyeNow)} m
						</td>
					</tr>
					{gap !== null && (
						<tr className="border-t border-white/6 sm:hidden">
							<td className="py-1 text-white/55">Mismatch</td>
							<td />
							<td
								className="py-1 text-right"
								style={{ color: gap < 8 ? C.good : C.bad }}
							>
								{gap.toFixed(1)} px
							</td>
						</tr>
					)}
				</tbody>
			</table>

			<div>
				<div className="mb-1 flex justify-between font-mono text-[9.5px] tracking-[0.12em] text-white/35 uppercase">
					<span>Mismatch over heading</span>
					<span>±{Math.round((y1 - y0) / 2)}°</span>
				</div>
				<svg
					viewBox={`0 0 ${VW} ${VHc}`}
					className="w-full overflow-visible"
					aria-hidden="true"
				>
					<defs>
						<clipPath id="how-curve-clip">
							<rect x="0" y="0" width={VW * curve} height={VHc} />
						</clipPath>
					</defs>
					<line
						x1="0"
						x2={VW}
						y1={VHc - 10}
						y2={VHc - 10}
						stroke="rgba(255,255,255,0.12)"
					/>
					<line
						x1={X(scene.prior.yaw)}
						x2={X(scene.prior.yaw)}
						y1="2"
						y2={VHc - 10}
						stroke={C.bad}
						strokeDasharray="2 3"
						strokeOpacity={0.8}
					/>
					<text
						x={X(scene.prior.yaw) + 4}
						y="10"
						fill={C.bad}
						fontSize="9"
						fontFamily="ui-monospace, monospace"
					>
						compass
					</text>
					<path
						d={d}
						fill="none"
						stroke={C.terrain}
						strokeWidth="1.5"
						clipPath="url(#how-curve-clip)"
					/>
					{curve >= 1 && (
						<g>
							<line
								x1={X(coarse.yaw)}
								x2={X(coarse.yaw)}
								y1="2"
								y2={VHc - 10}
								stroke={C.glow}
								strokeOpacity={0.9}
							/>
							<text
								x={X(coarse.yaw) - 4}
								y="10"
								fill={C.glow}
								fontSize="9"
								textAnchor="end"
								fontFamily="ui-monospace, monospace"
							>
								found
							</text>
						</g>
					)}
					{curve > 0 && Math.abs(cursor) <= (y1 - y0) / 2 + 0.01 && (
						<circle
							cx={X(scene.prior.yaw + cursor)}
							cy={VHc - 10}
							r="3"
							fill="#e59e1f"
						/>
					)}
					<text
						x="0"
						y={VHc}
						fill="rgba(255,255,255,0.35)"
						fontSize="9"
						fontFamily="ui-monospace, monospace"
					>
						{y0.toFixed(0)}°
					</text>
					<text
						x={VW}
						y={VHc}
						fill="rgba(255,255,255,0.35)"
						fontSize="9"
						textAnchor="end"
						fontFamily="ui-monospace, monospace"
					>
						{y1.toFixed(0)}°
					</text>
				</svg>
			</div>

			<div
				className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 ring-1 transition"
				style={{
					opacity: 0.25 + 0.75 * accepted,
					background: `rgba(141,145,122,${0.16 * accepted})`,
					boxShadow: `inset 0 0 0 1px rgba(141,145,122,${0.2 + 0.5 * accepted})`,
				}}
			>
				<span
					className="text-[12.5px] font-semibold"
					style={{ color: accepted > 0.5 ? C.good : "rgba(244,244,244,0.5)" }}
				>
					{accepted > 0.5 ? "Pose accepted" : "Not yet accepted"}
				</span>
				<span className="font-mono text-[10.5px] text-white/50">
					confidence {scene.confidence.toFixed(2)}
				</span>
			</div>
		</div>
	);
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
