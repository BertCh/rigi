// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Top-3 picker + tap-a-peak (roadmap R4), behind ?picker=on (PickerMount). Renderer-agnostic: it only
// uses the Renderer interface plus the read-only accessors in engine-access.ts, so three and
// ?renderer=deck behave the same.
//
// Flow: once the load has settled (no status, second opinion not pending) the picker asks the app's own
// solver for its ranked hypotheses (full metadata: engine.autoAlign alternatives; missing compass /
// gravity / lens: the unknown-pose cascade's candidates), keeps the top 3 distinct (> 0.5°) and shows
// them as skyline thumbnails. When the result is not an automatic HIGH the panel opens by itself;
// otherwise it is a collapsed chip. Clicking a thumbnail previews it (not saved); "Use this" confirms.
// "Tap a peak": tap a summit in the photo, choose its name from the nearby OSM peaks, and the pose is
// re-solved from every candidate with that constraint (the engine's pin solver) and re-ranked by the
// skyline score. A confirmed pick goes through PhotoWorkspace's setPose (align state "manual"): it is
// user-confirmed provenance and never becomes an automatic HIGH. Every step is logged (log.ts).
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { Pose } from "#/lib/camera";
import type {
	UnknownPoseSolver,
	Unknowns,
} from "#/lib/integration/unknown-pose";
import type { AlignState, Verify } from "#/lib/ontology/crosswalk/pose";
import type { PhotoMeta } from "#/lib/photos";
import type { Renderer } from "#/lib/renderer";
import {
	type Candidate,
	indexNear,
	isAutoHigh,
	type NearbyPeak,
	nearbyPeaks,
	poseSepDeg,
	rerankWithTaps,
	TAP_MAX_PX,
	type TapSolved,
	topDistinct,
} from "./candidates";
import { eyeOf, peakPool, skylineOf, skylineScore } from "./engine-access";
import type { PickerMode } from "./flags";
import {
	downloadPickerLog,
	type LoggedTap,
	logPickerEvent,
	type PickerEvent,
	readPickerLog,
} from "./log";

export type PickerPanelProps = {
	mode: PickerMode;
	engineRef: RefObject<Renderer | null>;
	photo: PhotoMeta;
	pose: Pose | null;
	alignState: AlignState | null;
	verify: Verify;
	/** load finished, no error, second opinion not pending */
	ready: boolean;
	stage: { w: number; h: number; left: number; top: number };
	unknownSolverRef?: RefObject<UnknownPoseSolver | null>;
	/** show a pose without saving it (PhotoWorkspace setPose(p, false)) */
	onPreview: (p: Pose) => void;
	/** the user confirmed a pose (PhotoWorkspace setPose(p) + note): user-confirmed, never auto-HIGH */
	onConfirm: (p: Pose, note: string) => void;
};

type Tap = LoggedTap;
type Preview = { kind: "cand" | "tap"; idx: number };

const THUMB_W = 132;
const USER_STATES = new Set(["manual", "pinned", "saved"]);

/** The solver's ranked hypotheses for this engine's photo (never HIGH; suggestions only). */
async function findCandidates(
	eng: Renderer,
	solver: UnknownPoseSolver | null | undefined,
	signal: AbortSignal,
): Promise<Candidate[]> {
	if (eng.unknowns.any) {
		const img = eng.photoElement;
		if (!solver || !img) return [];
		const r = await solver.solve(
			img,
			eng.prior,
			eng.unknowns as Unknowns,
			signal,
		);
		return [...r.candidates]
			.sort(
				(a, b) =>
					Number(b.accepted) - Number(a.accepted) ||
					b.confidence - a.confidence,
			)
			.map((c, i) => ({
				pose: c.pose,
				score: c.confidence,
				source: "cascade" as const,
				sourceRank: i,
			}));
	}
	const res = await eng.autoAlign(true);
	if (!res) return [];
	const alts = res.alternatives?.length
		? res.alternatives
		: [{ pose: res.pose, score: res.score }];
	return alts.map((a, i) => ({
		pose: a.pose,
		score: (a as { total?: number }).total ?? a.score,
		source: "align" as const,
		sourceRank: i,
	}));
}

function Thumb({
	eng,
	pose,
	active,
	label,
	sub,
	onClick,
	testId,
}: {
	eng: Renderer;
	pose: Pose;
	active: boolean;
	label: string;
	sub: string;
	onClick: () => void;
	testId: string;
}) {
	const ref = useRef<HTMLCanvasElement>(null);
	const h = Math.round(THUMB_W / eng.aspect);
	useEffect(() => {
		const c = ref.current;
		const g = c?.getContext("2d");
		if (!c || !g) return;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		c.width = THUMB_W * dpr;
		c.height = h * dpr;
		g.scale(dpr, dpr);
		const img = eng.photoElement;
		if (img) g.drawImage(img, 0, 0, THUMB_W, h);
		else {
			g.fillStyle = "#1e293b";
			g.fillRect(0, 0, THUMB_W, h);
		}
		const sky = skylineOf(eng, pose, THUMB_W);
		if (!sky) return;
		g.lineWidth = 1.6;
		g.strokeStyle = "rgba(0,0,0,0.6)";
		const stroke = () => {
			g.beginPath();
			let pen = false;
			for (let x = 0; x < sky.length; x++) {
				const v = sky[x];
				if (!Number.isFinite(v) || v < -0.05 || v > 1.05) {
					pen = false;
					continue;
				}
				if (pen) g.lineTo(x + 0.5, v * h);
				else g.moveTo(x + 0.5, v * h);
				pen = true;
			}
			g.stroke();
		};
		g.lineWidth = 3;
		stroke();
		g.lineWidth = 1.4;
		g.strokeStyle = "#22d3ee";
		stroke();
	}, [eng, pose, h]);
	return (
		<button
			type="button"
			data-picker-thumb={testId}
			onClick={onClick}
			className={`flex flex-col gap-0.5 rounded-md p-0.5 text-left ring-1 transition ${
				active
					? "bg-cyan-400/20 ring-cyan-300"
					: "bg-black/30 ring-white/15 hover:ring-white/40"
			}`}
		>
			<canvas
				ref={ref}
				style={{ width: THUMB_W, height: h }}
				className="rounded"
			/>
			<span className="px-0.5 text-[10px] leading-tight font-semibold text-white/90">
				{label}
			</span>
			<span className="px-0.5 text-[9px] leading-tight text-white/55">
				{sub}
			</span>
		</button>
	);
}

export default function PickerPanel(props: PickerPanelProps) {
	const {
		mode,
		engineRef,
		photo,
		pose,
		alignState,
		verify,
		ready,
		stage,
		unknownSolverRef,
		onPreview,
		onConfirm,
	} = props;
	const eng = engineRef.current;
	const [forEngine, setForEngine] = useState<Renderer | null>(null);
	const [cands, setCands] = useState<Candidate[] | null>(null);
	const [phase, setPhase] = useState<"idle" | "finding" | "ready" | "failed">(
		"idle",
	);
	const [shown, setShown] = useState<Pose | null>(null);
	const [open, setOpen] = useState<boolean | null>(null);
	const [preview, setPreview] = useState<Preview | null>(null);
	const basePose = useRef<Pose | null>(null);
	/** the pose object last handed to onPreview (identity: PhotoWorkspace echoes it back as `pose`) */
	const previewed = useRef<Pose | null>(null);
	/** the engine the candidate search ran (or runs) for */
	const started = useRef<Renderer | null>(null);
	const phaseRef = useRef(phase);
	phaseRef.current = phase;
	const [tapMode, setTapMode] = useState(false);
	const [pendingTap, setPendingTap] = useState<{
		u: number;
		v: number;
		offered: NearbyPeak[];
	} | null>(null);
	const [taps, setTaps] = useState<Tap[]>([]);
	const [tapResults, setTapResults] = useState<TapSolved[] | null>(null);
	// a new engine (eye move, renderer switch) is a new session
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the engine
	const session = useMemo(
		() =>
			`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
		[forEngine],
	);
	// a previewed candidate is not the verified pose: never label it HIGH while it is on screen
	const high = !preview && isAutoHigh(alignState, verify);

	const log = (e: PickerEvent) =>
		logPickerEvent({
			...e,
			t: new Date().toISOString(),
			photoId: photo.id,
			renderer:
				(eng as { backend?: string } | null)?.backend === "webgpu"
					? "webgpu"
					: "deck",
			alignState,
			verify,
			session,
		});

	// a new engine: start over
	useEffect(() => {
		if (eng === forEngine) return;
		setForEngine(eng);
		setCands(null);
		setPhase("idle");
		setShown(null);
		setOpen(null);
		setPreview(null);
		basePose.current = null;
		setTapMode(false);
		setPendingTap(null);
		setTaps([]);
		setTapResults(null);
	}, [eng, forEngine]);

	// the app moved the pose itself mid-preview (late matcher upgrade, eye move): the saved "Back" pose is
	// stale and must not overwrite the newer one, so the preview ends without a revert
	// biome-ignore lint/correctness/useExhaustiveDependencies: only on a pose change
	useEffect(() => {
		if (!preview || !pose || !previewed.current || pose === previewed.current)
			return;
		previewed.current = null;
		basePose.current = null;
		setPreview(null);
		log({ kind: "superseded", to: pose });
	}, [pose]);

	// ask the solver for its ranked hypotheses once the load settled (once per engine)
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per engine, after ready
	useEffect(() => {
		if (!ready || !eng || eng !== forEngine || !pose) return;
		if (started.current === eng) return;
		started.current = eng;
		const ctl = new AbortController();
		const at = { ...pose };
		setPhase("finding");
		findCandidates(eng, unknownSolverRef?.current, ctl.signal)
			.then((ranked) => {
				if (ctl.signal.aborted || engineRef.current !== eng) return;
				const top = topDistinct(ranked, 3);
				setCands(top);
				setShown(at);
				setPhase("ready");
				const shownIndex = indexNear(top, at);
				log({
					kind: "shown",
					shownIndex,
					candidates: top.map((c, i) => ({
						rank: i,
						source: c.source,
						sourceRank: c.sourceRank,
						score: c.score,
						pose: c.pose,
						sepFromShownDeg: +poseSepDeg(c.pose, at).toFixed(3),
					})),
				});
				if (import.meta.env.DEV)
					window.__picker = {
						candidates: top,
						shown: at,
						shownIndex,
					};
				// the autoAlign re-run drew silhouette probes: redraw the current pose
				eng.setPose({ ...eng.pose });
			})
			.catch((e) => {
				if (ctl.signal.aborted || (e as Error)?.name === "AbortError") {
					if (started.current === eng) started.current = null;
					setPhase("idle");
					return;
				}
				console.warn("[picker] candidates failed", e);
				setPhase("failed");
			});
		return () => {
			// superseded before it finished: allow a retry once ready again
			if (
				!ctl.signal.aborted &&
				started.current === eng &&
				phaseRef.current === "finding"
			)
				started.current = null;
			ctl.abort();
		};
	}, [ready, eng, forEngine]);

	if (!eng || eng !== forEngine || !ready) return null;

	// open by default when the result is not an automatic HIGH and the user hasn't taken over
	const prominent =
		mode === "always" ||
		(!high && !USER_STATES.has(alignState ?? "") && phase !== "idle");
	const isOpen = open ?? prominent;

	const startPreview = (p: Pose, next: Preview) => {
		if (!preview && pose) basePose.current = { ...pose };
		setPreview(next);
		previewed.current = p;
		onPreview(p);
	};
	const revert = () => {
		const to = basePose.current;
		setPreview(null);
		basePose.current = null;
		previewed.current = null;
		if (to) {
			onPreview(to);
			log({ kind: "revert", to });
		}
	};
	const confirm = () => {
		if (!preview) return;
		const before = basePose.current ?? shown ?? pose;
		if (preview.kind === "cand" && preview.idx < 0 && shown) {
			// the pose the app showed (not among the solver's top 3): keeping it is a confirmation too
			log({
				kind: "pick",
				rank: -1,
				source: "shown",
				before: before as Pose,
				after: shown,
			});
			onConfirm(
				shown,
				"Kept the shown pose after comparing candidates (user-confirmed, not auto-verified)",
			);
		} else if (preview.kind === "cand" && cands) {
			const c = cands[preview.idx];
			log({
				kind: "pick",
				rank: preview.idx,
				source: c.source,
				before: before as Pose,
				after: c.pose,
			});
			onConfirm(
				c.pose,
				`Picked by you: candidate ${preview.idx + 1} of ${cands.length} (user-confirmed, not auto-verified)`,
			);
		} else if (preview.kind === "tap" && tapResults) {
			const r = tapResults[preview.idx];
			log({
				kind: "pick",
				rank: preview.idx,
				source: "tap",
				before: before as Pose,
				after: r.pose,
				taps,
			});
			onConfirm(
				r.pose,
				`Solved from your tapped peak${taps.length > 1 ? "s" : ""} (${taps.map((t) => t.name).join(", ")}): user-confirmed, not auto-verified`,
			);
		}
		setPreview(null);
		basePose.current = null;
		previewed.current = null;
		setOpen(false);
	};

	const startPoses = (): Candidate[] => {
		const base = basePose.current ?? pose;
		const list: Candidate[] = [];
		if (base)
			list.push({ pose: base, score: null, source: "shown", sourceRank: 0 });
		if (shown)
			list.push({ pose: shown, score: null, source: "shown", sourceRank: 1 });
		for (const c of cands ?? []) list.push(c);
		return topDistinct(list, list.length);
	};

	const onTap = (e: React.PointerEvent) => {
		e.stopPropagation();
		e.preventDefault();
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const u = (e.clientX - r.left) / r.width;
		const v = (e.clientY - r.top) / r.height;
		const poses = startPoses().map((c) => c.pose);
		const offered = nearbyPeaks(
			peakPool(eng, poses),
			eyeOf(eng),
			eng.aspect,
			u,
			v,
			poses,
		);
		setPendingTap({ u, v, offered });
	};

	const chooseTapPeak = (pk: NearbyPeak | null) => {
		const pt = pendingTap;
		if (!pt) return;
		setPendingTap(null);
		log({
			kind: "tap",
			u: pt.u,
			v: pt.v,
			offered: pt.offered.map((o) => ({
				name: o.name,
				sepDeg: +o.sepDeg.toFixed(2),
				distKm: +o.distKm.toFixed(2),
			})),
			chosen: pk?.name ?? null,
		});
		if (!pk) return;
		const next = [
			...taps.filter((t) => t.name !== pk.name),
			{ name: pk.name, world: pk.world, u: pt.u, v: pt.v },
		];
		setTaps(next);
		const starts = startPoses();
		const results = rerankWithTaps(
			starts,
			next,
			(from) =>
				eng.solvePins(
					next.map((t) => ({ world: t.world, u: t.u, v: t.v })),
					from,
					next.length >= 3,
				),
			{
				aspect: eng.aspect,
				eye: eyeOf(eng),
				skyline: (p) => skylineScore(eng, p),
			},
		).slice(0, 3);
		setTapResults(results);
		log({
			kind: "tap-solve",
			taps: next,
			before: (basePose.current ?? pose) as Pose,
			results: results.map((r) => ({
				pose: r.pose,
				tapPx: +r.tapPx.toFixed(2),
				skyline: r.skyline,
				from: r.from,
				fromRank: r.fromRank,
			})),
		});
		if (import.meta.env.DEV)
			window.__pickerTap = {
				taps: next,
				results,
			};
		if (results[0]) startPreview(results[0].pose, { kind: "tap", idx: 0 });
	};

	const shownIdx = cands && shown ? indexNear(cands, shown) : -1;
	const fmt = (p: Pose, ref: Pose | null) => {
		if (!ref) return `yaw ${p.yaw.toFixed(1)}°`;
		const d = poseSepDeg(p, ref);
		return d < 0.05 ? "as shown" : `${d.toFixed(1)}° from shown`;
	};

	const tapOverlay = tapMode && (
		<div
			data-picker-tap-layer=""
			className="absolute z-30 cursor-crosshair touch-none"
			style={{
				left: stage.left,
				top: stage.top,
				width: stage.w,
				height: stage.h,
			}}
			onPointerDown={onTap}
		>
			{taps.map((t) => (
				<div
					key={t.name}
					className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
					style={{ left: `${t.u * 100}%`, top: `${t.v * 100}%` }}
				>
					<div className="size-3 rounded-full border-2 border-amber-300 bg-amber-400/40" />
					<div className="absolute top-3 left-1/2 -translate-x-1/2 rounded bg-black/70 px-1 text-[10px] whitespace-nowrap text-amber-200">
						{t.name}
					</div>
				</div>
			))}
			{pendingTap && (
				<div
					className="absolute"
					style={{
						left: `${pendingTap.u * 100}%`,
						top: `${pendingTap.v * 100}%`,
					}}
					onPointerDown={(e) => e.stopPropagation()}
				>
					<div className="pointer-events-none size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-cyan-300 bg-cyan-400/40" />
					<div
						data-picker-peaks=""
						className="absolute top-2 left-2 z-40 flex max-h-64 w-52 flex-col gap-0.5 overflow-auto rounded-lg bg-slate-950/90 p-1.5 text-[11px] ring-1 ring-white/15 backdrop-blur"
					>
						<div className="px-1 pb-0.5 text-[10px] text-white/50">
							Which peak did you tap?
						</div>
						{pendingTap.offered.length === 0 && (
							<div className="px-1 text-white/60">No named peak nearby</div>
						)}
						{pendingTap.offered.map((o) => (
							<button
								type="button"
								key={`${o.name}${o.world[0]}`}
								data-picker-peak={o.name}
								onClick={() => chooseTapPeak(o)}
								className="flex items-baseline justify-between gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10"
							>
								<span className="truncate font-medium text-white/90">
									{o.name}
								</span>
								<span className="shrink-0 text-[9px] text-white/45">
									{o.ele != null ? `${Math.round(o.ele)} m · ` : ""}
									{o.distKm.toFixed(1)} km
								</span>
							</button>
						))}
						<button
							type="button"
							onClick={() => chooseTapPeak(null)}
							className="rounded px-1 py-0.5 text-left text-white/50 hover:bg-white/10"
						>
							None of these
						</button>
					</div>
				</div>
			)}
		</div>
	);

	if (!isOpen)
		return (
			<>
				{tapOverlay}
				<button
					type="button"
					data-picker={phase}
					onClick={() => setOpen(true)}
					className="absolute bottom-3 left-3 z-30 rounded-lg bg-black/60 px-2.5 py-1.5 text-xs font-medium text-white/80 ring-1 ring-white/15 backdrop-blur hover:text-white"
				>
					{phase === "finding"
						? "Finding other candidates…"
						: `Other candidates${cands ? ` (${cands.length})` : ""} · tap a peak`}
				</button>
			</>
		);

	return (
		<>
			{tapOverlay}
			<div
				data-picker={phase}
				data-picker-count={cands?.length ?? 0}
				data-picker-high={high ? "" : undefined}
				className="absolute bottom-3 left-3 z-30 flex max-w-[calc(100%-1.5rem)] flex-col gap-1.5 rounded-xl bg-slate-950/80 p-2 text-white ring-1 ring-white/15 backdrop-blur"
			>
				<div className="flex items-center gap-2 text-xs">
					<span className="font-semibold">
						{high ? "Other candidates" : "Which skyline fits?"}
					</span>
					<span className="text-[10px] text-white/50">
						{high
							? "auto-verified; alternatives for reference"
							: "not verified: pick one or tap a peak you know"}
					</span>
					<button
						type="button"
						onClick={() => {
							if (preview) revert();
							setTapMode(false);
							setPendingTap(null);
							setOpen(false);
							log({ kind: "dismiss" });
						}}
						className="ml-auto rounded px-1.5 text-white/60 hover:text-white"
						aria-label="Close picker"
					>
						×
					</button>
				</div>
				{phase === "finding" && (
					<div className="text-[11px] text-white/60">Finding candidates…</div>
				)}
				{phase === "failed" && (
					<div className="text-[11px] text-white/60">
						No candidates available (tap a peak still works)
					</div>
				)}
				{cands && cands.length > 0 && (
					<div className="flex gap-1.5 overflow-x-auto">
						{shownIdx < 0 && shown && (
							<Thumb
								testId="shown"
								eng={eng}
								pose={shown}
								active={preview?.kind === "cand" && preview.idx === -1}
								label="shown"
								sub="not in the top 3"
								onClick={() => {
									startPreview(shown, { kind: "cand", idx: -1 });
									log({ kind: "preview", rank: -1, source: "shown" });
								}}
							/>
						)}
						{cands.map((c, i) => (
							<Thumb
								key={`c${c.sourceRank}-${c.source}`}
								testId={`cand-${i}`}
								eng={eng}
								pose={c.pose}
								active={preview?.kind === "cand" && preview.idx === i}
								label={`${i + 1}${i === shownIdx ? " · shown" : ""}`}
								sub={fmt(c.pose, shown)}
								onClick={() => {
									startPreview(c.pose, { kind: "cand", idx: i });
									log({ kind: "preview", rank: i, source: c.source });
								}}
							/>
						))}
					</div>
				)}
				{tapResults && tapResults.length > 0 && (
					<>
						<div className="text-[10px] text-white/55">
							From your tap{taps.length > 1 ? "s" : ""} (
							{taps.map((t) => t.name).join(", ")})
						</div>
						<div className="flex gap-1.5 overflow-x-auto">
							{tapResults.map((r, i) => (
								<Thumb
									key={`t${r.fromRank}-${r.from}`}
									testId={`tap-${i}`}
									eng={eng}
									pose={r.pose}
									active={preview?.kind === "tap" && preview.idx === i}
									label={`tap ${i + 1}${r.tapPx > TAP_MAX_PX ? " · poor fit" : ""}`}
									sub={`${fmt(r.pose, shown)} · ${r.tapPx.toFixed(1)} px`}
									onClick={() => {
										startPreview(r.pose, { kind: "tap", idx: i });
										log({ kind: "preview", rank: i, source: "tap" });
									}}
								/>
							))}
						</div>
					</>
				)}
				<div className="flex flex-wrap items-center gap-1.5 text-[11px]">
					<button
						type="button"
						data-picker-confirm=""
						disabled={!preview}
						onClick={confirm}
						className="rounded-md bg-cyan-400 px-2 py-1 font-semibold text-slate-950 disabled:opacity-30"
					>
						Use this
					</button>
					<button
						type="button"
						disabled={!preview}
						onClick={revert}
						className="rounded-md bg-white/10 px-2 py-1 disabled:opacity-30"
					>
						Back
					</button>
					<button
						type="button"
						data-picker-tap=""
						onClick={() => {
							setTapMode((t) => !t);
							setPendingTap(null);
						}}
						className={`rounded-md px-2 py-1 ${tapMode ? "bg-amber-400 text-slate-950" : "bg-white/10"}`}
					>
						{tapMode ? "Tapping… (done)" : "Tap a peak"}
					</button>
					{taps.length > 0 && (
						<button
							type="button"
							onClick={() => {
								setTaps([]);
								setTapResults(null);
								if (preview?.kind === "tap") revert();
							}}
							className="rounded-md bg-white/10 px-2 py-1"
						>
							Clear taps
						</button>
					)}
					<button
						type="button"
						onClick={downloadPickerLog}
						className="ml-auto rounded-md px-1.5 py-1 text-white/45 hover:text-white/80"
						title="Download the local correction log (JSON)"
					>
						log ({readPickerLog().length})
					</button>
				</div>
			</div>
		</>
	);
}
