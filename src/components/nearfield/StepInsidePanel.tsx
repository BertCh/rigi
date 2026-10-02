// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside controls on the stage (bottom-left): the 'Step inside' button (disabled with a reason),
// the status chip ([data-nearfield-status]), the Truth toggle and, while stepping, 'Back to photo'.
// Renders nothing while the near-field service is down, so the classic view is untouched.
import { Box, Eye, Loader2, Undo2 } from "lucide-react";
import { SPLAT_PROVENANCE_COLORS } from "#/lib/nearfield/provenance";
import { cn } from "#/lib/utils";
import type { StepInside } from "./useStepInside";

const rgb = (c: readonly [number, number, number]) =>
	`rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)})`;

export function StepInsidePanel({ si }: { si: StepInside }) {
	if (!si.visible) return null;
	const { state } = si;
	const status = si.stepping
		? "stepping"
		: !si.accepted
			? "not-accepted"
			: state.phase;
	const loading = state.phase === "loading";
	const q = state.quality;
	const chip =
		status === "stepping"
			? "3D view"
			: status === "not-accepted"
				? "pose not accepted"
				: state.phase === "ready"
					? state.lowTrust
						? "low trust"
						: "ready"
					: state.phase === "low-quality"
						? "anchoring too weak"
						: state.phase === "error"
							? "failed"
							: loading
								? (state.message ?? "working")
								: "near field";
	return (
		<div
			className="pointer-events-none absolute bottom-4 left-3 z-20 flex max-w-[min(22rem,calc(100%-1.5rem))] flex-col items-start gap-1.5"
			data-nearfield-status={status}
			data-nearfield-quality={q != null ? q.toFixed(3) : undefined}
		>
			<div
				className={cn(
					"flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 backdrop-blur",
					status === "stepping" || (state.phase === "ready" && !state.lowTrust)
						? "bg-[var(--rigi-glow)]/20 text-white/85 ring-[var(--rigi-glow)]/30"
						: state.phase === "ready" && state.lowTrust
							? "bg-[var(--rigi-lesson)]/25 text-white/90 ring-[var(--rigi-lesson)]/40"
							: state.phase === "error" || state.phase === "low-quality"
								? "bg-[var(--rigi-trap)]/20 text-white/90 ring-[var(--rigi-trap)]/30"
								: "bg-black/50 text-white/70 ring-white/10",
				)}
				data-status={status}
				title={[
					state.message,
					q != null ? `anchor quality ${q.toFixed(2)}` : "",
					state.splats != null ? `${state.splats.toLocaleString()} splats` : "",
					state.confidenceRadius != null
						? `move radius ${Math.round(state.confidenceRadius)} m`
						: "",
					state.depthModel ? `depth ${state.depthModel}` : "",
					state.gaussians ? `splats ${state.gaussians}` : "",
				]
					.filter(Boolean)
					.join(" · ")}
			>
				{loading && <Loader2 className="size-3 animate-spin" />}
				<span>Step inside · {chip}</span>
				{q != null && state.phase !== "loading" && (
					<span className="font-mono opacity-70">q {q.toFixed(2)}</span>
				)}
				{state.researchOnly && (
					<span className="rounded bg-fuchsia-500/30 px-1 text-fuchsia-100">
						SHARP research-only
					</span>
				)}
			</div>
			<div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
				{si.stepping ? (
					<button
						type="button"
						onClick={si.back}
						data-nearfield-back=""
						className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-[var(--rigi-ink)] hover:bg-white/90"
					>
						<Undo2 className="size-3.5" /> Back to photo
					</button>
				) : (
					<button
						type="button"
						onClick={si.enter}
						disabled={!!si.disabledReason}
						title={
							si.disabledReason ??
							"Walk a few metres into the photo: near objects in 3D on the true terrain"
						}
						data-nearfield-enter=""
						className="flex items-center gap-1.5 rounded-lg bg-black/55 px-3 py-1.5 text-xs font-semibold text-white/90 ring-1 ring-white/15 backdrop-blur hover:bg-black/75 disabled:cursor-not-allowed disabled:opacity-45"
					>
						{loading ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<Box className="size-3.5" />
						)}
						Step inside
					</button>
				)}
				{(si.stepping || state.phase === "ready") && (
					<button
						type="button"
						onClick={() => si.setTruth(!si.truth)}
						aria-pressed={si.truth}
						data-nearfield-truth={si.truth ? "on" : "off"}
						title="Tint surfaces by where they came from: observed, reconstructed, DEM, generated"
						className={cn(
							"flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold ring-1 backdrop-blur",
							si.truth
								? "bg-[var(--rigi-ember)] text-[var(--khipu-w)] ring-[var(--rigi-ember)]"
								: "bg-black/55 text-white/85 ring-white/15 hover:bg-black/75",
						)}
					>
						<Eye className="size-3.5" /> Truth
					</button>
				)}
			</div>
			{si.disabledReason && !si.stepping && !loading && (
				<div className="max-w-xs rounded-md bg-black/55 px-2 py-1 text-[10px] leading-snug text-white/70 backdrop-blur">
					{si.disabledReason}
				</div>
			)}
			{si.truth && (
				<div className="flex items-center gap-2 rounded-md bg-black/55 px-2 py-1 text-[10px] text-white/75 backdrop-blur">
					{(["observed", "reconstructed", "DEM", "generated"] as const).map(
						(n, i) => (
							<span key={n} className="flex items-center gap-1">
								<span
									className="inline-block size-2 rounded-sm"
									style={{ backgroundColor: rgb(SPLAT_PROVENANCE_COLORS[i]) }}
								/>
								{n}
							</span>
						),
					)}
				</div>
			)}
		</div>
	);
}
