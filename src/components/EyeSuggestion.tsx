// "Check camera position": the pose6dof eye search as an opt-in, unverified SUGGESTION (matching-v2
// policy, reports/matching-v2.md). Hidden unless ?eyesearch=on|auto (src/lib/flags)
// (#/lib/gpu/eye/client.ts). It never applies anything by itself: only the Apply button calls onApply.
import { Crosshair, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Pose } from "#/lib/camera";
import { useFlag } from "#/lib/flags/react";
import {
	type EyeSearchProgress,
	type EyeSearchResult,
	eyeSearchInput,
	startEyeSearch,
} from "#/lib/gpu/eye/client";
import type { PhotoMeta } from "#/lib/photos";
import { Button } from "./controls";

type Phase =
	| { kind: "idle" }
	| { kind: "running"; progress: EyeSearchProgress | null }
	| { kind: "result"; result: EyeSearchResult; pose: Pose }
	| { kind: "error"; error: string };

const samePose = (a: Pose | null, b: Pose | null) =>
	!!a &&
	!!b &&
	a.yaw === b.yaw &&
	a.pitch === b.pitch &&
	a.roll === b.roll &&
	a.vfov === b.vfov;

const sgn = (x: number, d = 1) =>
	`${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;

function progressText(p: EyeSearchProgress | null) {
	if (!p || p.stage === "skyline") return "Detecting the photo skyline…";
	if (p.stage === "terrain") return "Loading terrain around the camera…";
	return `Testing nearby eyes: ${p.eyes} horizons (${p.gpu ? "GPU" : "CPU"}) · ${(p.ms / 1000).toFixed(0)} s`;
}

export function EyeSuggestion({
	photo,
	pose,
	ready,
	applied,
	onApply,
	onRevert,
}: {
	photo: PhotoMeta;
	pose: Pose | null;
	/** A final pose exists (load and second opinion settled). */
	ready: boolean;
	/** An eye move is applied this session. */
	applied: boolean;
	onApply: (r: EyeSearchResult) => void;
	onRevert: () => void;
}) {
	const flag = useFlag("eyesearch");
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const abort = useRef<AbortController | null>(null);
	const autoRan = useRef(false);

	const run = useCallback(() => {
		if (!pose) return;
		abort.current?.abort();
		const ctl = new AbortController();
		abort.current = ctl;
		const start = { ...pose };
		setPhase({ kind: "running", progress: null });
		startEyeSearch(
			eyeSearchInput(photo, start),
			(progress) => {
				if (!ctl.signal.aborted) setPhase({ kind: "running", progress });
			},
			ctl.signal,
		)
			.then((result) => {
				if (ctl.signal.aborted) return;
				console.debug("[eye-search]", result);
				if (import.meta.env.DEV) window.__eyeSearch = result;
				setPhase({ kind: "result", result, pose: start });
			})
			.catch((e) => {
				if (ctl.signal.aborted || e?.name === "AbortError") return;
				setPhase({ kind: "error", error: String(e?.message ?? e) });
			});
	}, [photo, pose]);

	// the camera moved (Apply / Revert): an old suggestion no longer applies
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on a position change only
	useEffect(() => {
		abort.current?.abort();
		setPhase({ kind: "idle" });
	}, [photo.lat, photo.lon, photo.alt]);

	useEffect(() => () => abort.current?.abort(), []);

	// ?eyesearch=auto: once per page, after the pose is final; the result is still only a suggestion
	useEffect(() => {
		if (flag !== "auto" || !ready || autoRan.current || applied) return;
		autoRan.current = true;
		run();
	}, [flag, ready, applied, run]);

	if (flag === "off") return null;

	const dismiss = () => {
		abort.current?.abort();
		setPhase({ kind: "idle" });
	};

	return (
		<div className="space-y-2" data-eye-search={phase.kind}>
			<div className="flex flex-wrap gap-2">
				<Button
					onClick={run}
					disabled={!ready || !pose || phase.kind === "running"}
					title="Search eyes within the GPS error for a better skyline fit (a suggestion only)"
				>
					<Crosshair className="size-3.5" /> Check camera position
				</Button>
				{applied && (
					<Button onClick={onRevert} title="Back to the GPS position">
						Revert position
					</Button>
				)}
			</div>
			{phase.kind === "running" && (
				<div className="flex items-center gap-2 text-[11px] text-white/55">
					<Loader2 className="size-3 animate-spin" />
					<span className="flex-1">{progressText(phase.progress)}</span>
					<button
						type="button"
						className="text-cyan-300 hover:underline"
						onClick={dismiss}
					>
						Cancel
					</button>
				</div>
			)}
			{phase.kind === "error" && (
				<p className="text-[11px] text-red-300">
					Camera position check failed: {phase.error}
				</p>
			)}
			{phase.kind === "result" && (
				<ResultCard
					r={phase.result}
					stale={!samePose(phase.pose, pose)}
					onApply={() => {
						onApply(phase.result);
						setPhase({ kind: "idle" });
					}}
					onDismiss={dismiss}
				/>
			)}
		</div>
	);
}

function ResultCard({
	r,
	stale,
	onApply,
	onDismiss,
}: {
	r: EyeSearchResult;
	stale: boolean;
	onApply: () => void;
	onDismiss: () => void;
}) {
	const [dE, dN, dU] = r.shift;
	const px = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");
	const how = `${r.gpu ? "GPU" : "CPU"} · ${r.eyesMarched} horizons · ${(r.ms / 1000).toFixed(1)} s`;
	return (
		<div
			className="relative space-y-1.5 rounded-lg bg-amber-400/8 p-2.5 text-[11px] leading-snug text-white/75 ring-1 ring-amber-300/25"
			data-eye-moved={r.moved ? "1" : "0"}
		>
			<button
				type="button"
				title="Dismiss"
				className="absolute top-1.5 right-1.5 text-white/40 hover:text-white/80"
				onClick={onDismiss}
			>
				<X className="size-3.5" />
			</button>
			<p className="pr-4 text-[10px] font-semibold tracking-wide text-amber-200/90 uppercase">
				Unverified suggestion
			</p>
			{r.moved ? (
				<>
					<p>
						Suggested camera position: moved{" "}
						<b className="font-mono">{r.distanceM.toFixed(1)} m</b> (E {sgn(dE)}
						, N {sgn(dN)}, Up {sgn(dU)} m)
					</p>
					<p>
						Skyline error {px(r.before.meanClippedPx)} →{" "}
						{px(r.after.meanClippedPx)} px · fit cost {r.before.cost.toFixed(0)}{" "}
						→ {r.after.cost.toFixed(0)}
					</p>
				</>
			) : (
				<p>
					No better position nearby:{" "}
					{r.distanceM < 0.5
						? "the GPS position fits the skyline best"
						: `the best eye (${r.distanceM.toFixed(1)} m away) does not beat the GPS position by the search's 2σ margin`}{" "}
					(fit cost {r.before.cost.toFixed(0)} → {r.after.cost.toFixed(0)}).
				</p>
			)}
			<p className="text-white/40">
				Skyline fit only; it often cannot tell nearby eyes apart. Check the
				overlay before keeping it. {how}
			</p>
			{stale && (
				<p className="text-amber-200/80">
					The pose changed since this check: run it again to apply.
				</p>
			)}
			<div className="flex gap-2 pt-0.5">
				{r.moved && (
					<Button onClick={onApply} disabled={stale}>
						Apply
					</Button>
				)}
				<Button onClick={onDismiss}>Dismiss</Button>
			</div>
		</div>
	);
}
