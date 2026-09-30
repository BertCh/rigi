// Roadmap R5 UI (behind ?propagate=on | dev): suggest poses for a selected anchor's neighbours, and let the
// user accept or dismiss a suggestion on a target. SUGGESTIONS ONLY: nothing is auto-accepted, nothing is
// marked high-confidence, and the dev rows say why each neighbour was skipped or rejected by the gate.
import { ChevronDown, ChevronUp, Waypoints } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PROPAGATE_GATE } from "../../nearfield/propagate";
import { loadSolvedPose } from "../roll";
import type { Roll, RollPhoto } from "../types";
import { propagateServiceUp, propagateServiceUrl } from "./client";
import { anchorKind, type PropagateMode } from "./plan";
import { type PropagateRun, persistRun, runPropagation } from "./run";
import {
	acceptSuggestion,
	dismissSuggestion,
	revertAccepted,
	type StoredSuggestion,
	suggestionsFor,
} from "./store";

const f1 = (x: number | null | undefined, d = 1) =>
	x == null || !Number.isFinite(x) ? "?" : x.toFixed(d);
const fmtM = (m: number) =>
	m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
const fmtDt = (s: number) =>
	s < 90
		? `${Math.round(s)} s`
		: s < 5400
			? `${Math.round(s / 60)} min`
			: `${(s / 3600).toFixed(1)} h`;

const STATUS_CLASS: Record<string, string> = {
	suggested: "bg-sky-400/20 text-sky-200",
	rejected: "bg-white/10 text-white/60",
	skipped: "bg-white/5 text-white/40",
	error: "bg-red-400/15 text-red-200",
	running: "bg-amber-300/20 text-amber-100",
	queued: "bg-white/5 text-white/45",
};

export function PropagatePanel({
	roll,
	mode,
	selectedId,
	onSelect,
	onChanged,
}: {
	roll: Roll;
	mode: PropagateMode;
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	onChanged: () => void;
}) {
	const [open, setOpen] = useState(true);
	const [up, setUp] = useState<boolean | null>(null);
	const [run, setRun] = useState<PropagateRun | null>(null);
	const [rev, setRev] = useState(0);
	const abort = useRef<AbortController | null>(null);
	const selected = roll.photos.find((p) => p.meta.id === selectedId) ?? null;
	const kind = selected
		? anchorKind(
				selected,
				mode,
				loadSolvedPose(selected.meta.id)?.method ?? null,
			)
		: null;
	const anchors = useMemo(
		() =>
			roll.photos
				.map(
					(p) =>
						[
							p,
							anchorKind(p, mode, loadSolvedPose(p.meta.id)?.method ?? null),
						] as const,
				)
				.filter(([, k]) => k),
		[roll, mode],
	);

	useEffect(() => {
		let live = true;
		propagateServiceUp(true).then((ok) => live && setUp(ok));
		return () => {
			live = false;
		};
	}, []);
	// a run belongs to its anchor: drop it when the selection moves to another anchor
	useEffect(() => {
		if (run && selectedId && run.anchorId !== selectedId && kind) {
			abort.current?.abort();
			setRun(null);
		}
	}, [selectedId, kind, run]);
	useEffect(() => () => abort.current?.abort(), []);

	const start = useCallback(async () => {
		if (!selected || !kind) return;
		abort.current?.abort();
		const ac = new AbortController();
		abort.current = ac;
		const r = await runPropagation(
			roll,
			selected,
			kind,
			mode,
			setRun,
			ac.signal,
		);
		setUp(r.serviceUp);
		if (!ac.signal.aborted) {
			persistRun(r);
			setRev((x) => x + 1);
		}
	}, [roll, selected, kind, mode]);

	const targetSuggestions = useMemo(() => {
		void rev;
		if (!selected) return [];
		return suggestionsFor(selected.meta.id).filter(
			(s) => mode === "dev" || s.anchorKind !== "ground-truth",
		);
	}, [selected, rev, mode]);

	const act = (fn: (s: StoredSuggestion) => void, s: StoredSuggestion) => {
		fn(s);
		setRev((x) => x + 1);
		onChanged();
	};

	return (
		<aside
			className="fixed top-36 right-3 z-40 w-[380px] max-w-[calc(100vw-24px)] rounded-xl bg-[#15181c]/95 text-[11.5px] shadow-2xl ring-1 ring-white/12 backdrop-blur"
			data-testid="propagate-panel"
		>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex w-full items-center gap-2 px-3 py-2 text-left"
			>
				<Waypoints className="size-3.5 text-sky-300" />
				<span className="font-semibold">Pose propagation</span>
				<span className="rounded bg-white/10 px-1 font-mono text-[9.5px] uppercase">
					{mode === "dev" ? "dev" : "suggest only"}
				</span>
				<span
					className={`ml-auto font-mono text-[10px] ${up ? "text-emerald-300" : up === false ? "text-red-300" : "text-white/40"}`}
					data-testid="propagate-service"
				>
					{up == null ? "…" : up ? "service up" : "service down"}
				</span>
				{open ? (
					<ChevronUp className="size-3.5" />
				) : (
					<ChevronDown className="size-3.5" />
				)}
			</button>
			{open && (
				<div className="max-h-[calc(100dvh-220px)] space-y-3 overflow-y-auto border-t border-white/10 px-3 py-2.5">
					{up === false && (
						<p className="text-amber-200/90">
							Relative-rotation service not reachable at {propagateServiceUrl()}
							. Start it with{" "}
							<code className="font-mono">
								tools/nearfield/propagate/run_service.sh
							</code>
							. Poses are unchanged.
						</p>
					)}
					{!selected && (
						<div>
							<p className="text-white/55">
								Select an anchor (a photo with an accepted pose) to suggest
								poses for the photos next to it.
							</p>
							<ul className="mt-1.5 flex flex-wrap gap-1">
								{anchors.length === 0 && (
									<li className="text-white/40">
										No anchors yet: save a pose in the workspace or align the
										roll.
									</li>
								)}
								{anchors.map(([p, k]) => (
									<li key={p.meta.id}>
										<button
											type="button"
											onClick={() => onSelect(p.meta.id)}
											className="rounded bg-white/8 px-1.5 py-0.5 font-mono hover:bg-white/15"
										>
											{p.meta.id} <span className="text-white/40">{k}</span>
										</button>
									</li>
								))}
							</ul>
						</div>
					)}
					{selected && targetSuggestions.length > 0 && (
						<TargetSuggestions
							photo={selected}
							items={targetSuggestions}
							onAccept={(s) => act(acceptSuggestion, s)}
							onDismiss={(s) => act(dismissSuggestion, s)}
							onRevert={(s) => act(revertAccepted, s)}
						/>
					)}
					{selected && kind && (
						<div data-testid="propagate-anchor">
							<div className="flex items-center gap-2">
								<span className="text-white/60">
									Anchor{" "}
									<span className="font-mono text-white">
										{selected.meta.id}
									</span>{" "}
									({kind}
									{kind === "ground-truth" && ", dev only"})
								</span>
								<button
									type="button"
									disabled={up === false || (run != null && !run.done)}
									onClick={start}
									data-testid="propagate-run"
									className="ml-auto rounded-md bg-sky-300 px-2 py-1 font-semibold text-black hover:brightness-110 disabled:opacity-40"
								>
									{run && !run.done ? "Working…" : "Suggest neighbours"}
								</button>
							</div>
							{run && run.anchorId === selected.meta.id && (
								<RunRows run={run} mode={mode} onSelect={onSelect} />
							)}
						</div>
					)}
					{selected && !kind && targetSuggestions.length === 0 && (
						<p className="text-white/50">
							{selected.meta.id} has no accepted pose ({selected.poseSource})
							and no pending suggestion. Anchors: saved or solved photos
							{mode === "dev" ? ", or fitted (dev)" : ""}.
						</p>
					)}
					<p className="border-t border-white/8 pt-2 text-[10px] leading-snug text-white/35">
						Gate: rot only, ≥{PROPAGATE_GATE.minInliers} inliers, rms ≤
						{PROPAGATE_GATE.maxRmsPx} px, overlap ≥{PROPAGATE_GATE.minOverlap},
						fwd/bwd & cycle ≤{PROPAGATE_GATE.maxCycleDeg}°, gravity ≤
						{PROPAGATE_GATE.maxGravityPitchDeg}°, baseline ≤
						{PROPAGATE_GATE.maxBaselineM} m. Passing is still a suggestion (not
						validated on held-out data).
					</p>
				</div>
			)}
		</aside>
	);
}

function RunRows({
	run,
	mode,
	onSelect,
}: {
	run: PropagateRun;
	mode: PropagateMode;
	onSelect: (id: string) => void;
}) {
	if (run.rows.length === 0)
		return (
			<p className="mt-1.5 text-white/45">
				No neighbour in this roll is a target.
			</p>
		);
	return (
		<ul className="mt-2 space-y-1.5" data-testid="propagate-rows">
			{run.rows.map((r) => {
				const t = r.candidate.target;
				const res = r.result;
				return (
					<li
						key={t.meta.id}
						className="rounded-md bg-white/[0.03] px-2 py-1.5 ring-1 ring-white/6"
						data-testid="propagate-row"
						data-target={t.meta.id}
						data-status={r.status}
					>
						<div className="flex items-center gap-1.5">
							<button
								type="button"
								onClick={() => onSelect(t.meta.id)}
								className="font-mono font-semibold hover:underline"
							>
								{t.meta.id}
							</button>
							<span
								className={`rounded px-1 text-[9.5px] font-semibold uppercase ${STATUS_CLASS[r.status]}`}
							>
								{r.status}
							</span>
							<span className="ml-auto font-mono text-[10px] text-white/45">
								{fmtM(r.candidate.baselineM)} · {fmtDt(r.candidate.dtS)}
							</span>
						</div>
						{res && (
							<div className="mt-0.5 font-mono text-[10px] text-white/55">
								inl {res.inliers}/{res.n} · rms {f1(res.rmsPx, 2)} px · ovl{" "}
								{f1(r.proposal?.suggestion?.overlap, 2)} · f/b{" "}
								{f1(res.fwdBwdDeg, 2)}°
								{r.cycleWith &&
									` · cycle(${r.cycleWith}) ${f1(r.suggestion?.evidence.cycleDeg ?? null, 2)}°`}
								{mode === "dev" && r.deltaToCurrentDeg != null && (
									<span className="text-sky-200/80">
										{" "}
										· Δ{t.poseSource} {f1(r.deltaToCurrentDeg, 2)}°
									</span>
								)}
							</div>
						)}
						{r.reasons.length > 0 && (
							<div
								className="mt-0.5 text-[10px] text-white/45"
								data-testid="propagate-reasons"
							>
								{r.reasons.join(" · ")}
							</div>
						)}
						{r.status === "suggested" && r.proposal?.cautions.length ? (
							<div className="mt-0.5 text-[10px] text-amber-200/80">
								{r.proposal.cautions.join(" · ")}
							</div>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

function TargetSuggestions({
	photo,
	items,
	onAccept,
	onDismiss,
	onRevert,
}: {
	photo: RollPhoto;
	items: StoredSuggestion[];
	onAccept: (s: StoredSuggestion) => void;
	onDismiss: (s: StoredSuggestion) => void;
	onRevert: (s: StoredSuggestion) => void;
}) {
	// a user accept writes the solved slot; ground truth / a saved pose outranks it in resolvePose, and a
	// measured (aligner) solved pose must not be overwritten by a propagated one (Undo would then delete it)
	const solvedMethod =
		photo.poseSource === "solved"
			? (loadSolvedPose(photo.meta.id)?.method ?? null)
			: null;
	// (and one accepted suggestion must be undone before another replaces it): only a prior-only photo accepts
	const blocked = photo.poseSource !== "prior";
	return (
		<ul className="space-y-1.5" data-testid="propagate-suggestions">
			{items.map((s) => (
				<li
					key={s.anchorId}
					className="rounded-md bg-sky-400/[0.06] px-2 py-1.5 ring-1 ring-sky-300/20"
					data-testid="propagate-suggestion"
					data-status={s.status}
				>
					<div className="text-sky-100">
						Suggested pose from <span className="font-mono">{s.anchorId}</span>
						<span className="text-white/40">
							{" "}
							({s.anchorKind}) · {s.status}
						</span>
					</div>
					<div className="mt-0.5 font-mono text-[10px] text-white/60">
						yaw {f1(s.pose.yaw)}° · pitch {f1(s.pose.pitch)}° · roll{" "}
						{f1(s.pose.roll)}° · ±{s.seedRadiusDeg}° · {s.evidence.inliers} inl
						· {fmtM(s.evidence.baselineM)}
					</div>
					{s.cautions.length > 0 && (
						<div className="mt-0.5 text-[10px] text-amber-200/80">
							{s.cautions.join(" · ")}
						</div>
					)}
					<div className="mt-1 flex gap-1.5">
						{s.status !== "accepted" ? (
							<button
								type="button"
								disabled={blocked}
								title={
									blocked
										? `This photo already has a ${photo.poseSource}${solvedMethod ? ` (${solvedMethod})` : ""} pose`
										: "Use this pose (you confirm it)"
								}
								onClick={() => onAccept(s)}
								data-testid="propagate-accept"
								className="rounded bg-sky-300 px-2 py-0.5 font-semibold text-black disabled:opacity-35"
							>
								Accept
							</button>
						) : (
							<button
								type="button"
								onClick={() => onRevert(s)}
								data-testid="propagate-revert"
								className="rounded px-2 py-0.5 ring-1 ring-white/20 hover:bg-white/10"
							>
								Undo accept
							</button>
						)}
						{s.status === "pending" && (
							<button
								type="button"
								onClick={() => onDismiss(s)}
								data-testid="propagate-dismiss"
								className="rounded px-2 py-0.5 text-white/65 ring-1 ring-white/15 hover:bg-white/10"
							>
								Dismiss
							</button>
						)}
					</div>
				</li>
			))}
		</ul>
	);
}
