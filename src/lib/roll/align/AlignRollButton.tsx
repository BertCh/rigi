// "Align N photos": runs alignRoll over the roll's prior-only photos, with progress, cancel and a
// summary. Styled for the dark roll page (src/routes/roll.$id.tsx); the page mounts it and
// re-resolves its poses on onChanged.
import { AlertTriangle, Check, Crosshair, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Roll } from "../types";
import {
	type AlignProgress,
	type AlignSummary,
	alignRoll,
	alignTargets,
} from "./align";

type State =
	| { kind: "idle" }
	| { kind: "running"; progress: AlignProgress | null }
	| { kind: "done"; summary: AlignSummary };

export function AlignRollButton({
	roll,
	onChanged,
	className = "",
}: {
	roll: Roll;
	onChanged?: () => void;
	className?: string;
}) {
	const [state, setState] = useState<State>({ kind: "idle" });
	const ctl = useRef<AbortController | null>(null);
	const n = alignTargets(roll).length;

	// leaving the page (or switching roll) stops the run: a worker solving for a roll nobody sees
	// would only hold the CPU
	useEffect(() => () => ctl.current?.abort(), []);
	// another roll on the same page instance (the route reuses the component): drop the old run
	const [rollId, setRollId] = useState(roll.id);
	if (rollId !== roll.id) {
		setRollId(roll.id);
		ctl.current?.abort();
		ctl.current = null;
		setState({ kind: "idle" });
	}

	const start = async () => {
		const c = new AbortController();
		ctl.current = c;
		setState({ kind: "running", progress: null });
		const summary = await alignRoll(roll, {
			signal: c.signal,
			onProgress: (p) =>
				!c.signal.aborted && setState({ kind: "running", progress: p }),
		});
		// superseded by another roll: its accepts are stored, but this button now shows the new roll
		if (ctl.current !== c && c.signal.aborted) return;
		ctl.current = null;
		if (c.signal.aborted && summary.results.length === 0) {
			setState({ kind: "idle" });
			return;
		}
		setState({ kind: "done", summary });
		onChanged?.();
	};

	if (state.kind === "running") {
		const p = state.progress;
		const frac = p?.total ? p.done / p.total : 0;
		return (
			<div
				className={`inline-flex min-w-[240px] items-center gap-3 rounded-lg bg-white/[0.04] px-3 py-1.5 ring-1 ring-white/10 ${className}`}
				data-testid="align-roll"
				aria-live="polite"
			>
				<Loader2 className="size-3.5 shrink-0 animate-spin text-[var(--rigi-glow)]" />
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline justify-between gap-2 text-xs">
						<span className="truncate text-white/80">
							{p?.phase === "retry" ? "Retrying " : "Aligning "}
							<span className="font-mono">{p?.current?.meta.id ?? "…"}</span>
						</span>
						<span className="shrink-0 font-mono text-[11px] text-white/45">
							{Math.min(
								(p?.done ?? 0) + (p?.phase === "solve" ? 1 : 0),
								p?.total ?? n,
							)}
							/{p?.total ?? n}
							{p && p.accepted > 0 && ` · ${p.accepted} ok`}
						</span>
					</div>
					<div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
						<div
							className="h-full rounded-full bg-[var(--rigi-glow)] transition-[width] duration-500"
							style={{ width: `${Math.max(3, frac * 100)}%` }}
						/>
					</div>
				</div>
				<button
					type="button"
					onClick={() => ctl.current?.abort()}
					aria-label="Cancel alignment"
					title="Cancel (poses accepted so far are kept)"
					className="flex size-6 shrink-0 items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white"
				>
					<X className="size-3.5" />
				</button>
			</div>
		);
	}

	const button = (
		<button
			type="button"
			onClick={start}
			disabled={n === 0}
			title={
				n === 0
					? "Every photo already has a saved, fitted or solved pose"
					: "Match each photo’s skyline to the terrain. Only confident matches are kept; the rest stay on their compass prior for review."
			}
			className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--rigi-glow)] px-3 py-1.5 text-xs font-semibold text-[var(--rigi-ink)] hover:brightness-110 disabled:cursor-default disabled:bg-white/[0.06] disabled:text-white/40 disabled:hover:brightness-100"
			data-testid="align-roll"
		>
			<Crosshair className="size-3.5" />
			{n === 0 ? "All photos aligned" : `Align ${n} photo${n === 1 ? "" : "s"}`}
		</button>
	);

	if (state.kind === "done") {
		const s = state.summary;
		const review = s.results
			.filter((r) => r.status !== "accepted")
			.map((r) => r.id);
		return (
			<div className={`inline-flex flex-wrap items-center gap-2 ${className}`}>
				<div
					className="inline-flex items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-1.5 text-xs ring-1 ring-white/10"
					data-testid="align-roll-summary"
					title={
						review.length ? `Needs review: ${review.join(", ")}` : undefined
					}
				>
					<span className="inline-flex items-center gap-1 text-violet-200">
						<Check className="size-3.5" /> {s.accepted} aligned
					</span>
					{s.needsReview + s.failed > 0 && (
						<span className="inline-flex items-center gap-1 text-amber-200">
							<AlertTriangle className="size-3.5" /> {s.needsReview + s.failed}{" "}
							need{s.needsReview + s.failed === 1 ? "s" : ""} review
						</span>
					)}
					{s.aborted && <span className="text-white/45">· cancelled</span>}
					<button
						type="button"
						onClick={() => setState({ kind: "idle" })}
						aria-label="Dismiss"
						className="-mr-1 flex size-5 items-center justify-center rounded text-white/45 hover:bg-white/10 hover:text-white"
					>
						<X className="size-3" />
					</button>
				</div>
				{n > 0 && button}
			</div>
		);
	}

	return <div className={`inline-flex ${className}`}>{button}</div>;
}
