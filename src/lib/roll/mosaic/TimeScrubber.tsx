// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Range slider over capture time. The axis compresses long breaks (overnight, drives) to
// GAP_CAP_S so bursts of photos stay readable; breaks are marked on the track. Emits the ids of
// the photos inside the range (undefined = everything, so the map drapes all).
import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { LightBand } from "../../terroir/roll/LightBand";
import type { Roll } from "../types";
import { dayKey, fmtDay, fmtTime, vpColor } from "./style";

const GAP_CAP_S = 3600;

type Props = {
	roll: Roll;
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	onChange: (visible: ReadonlySet<string> | undefined) => void;
	className?: string;
};

function fmtGap(s: number) {
	return s >= 86400
		? `${Math.round(s / 86400)} d`
		: `${Math.round(s / 3600)} h`;
}

export function TimeScrubber({
	roll,
	selectedId,
	onSelect,
	onChange,
	className = "",
}: Props) {
	const ps = roll.photos;
	// axis position (compressed seconds) of each photo, and marked breaks
	const { pos, total, breaks } = useMemo(() => {
		const pos: number[] = [];
		const breaks: { at: number; gap: number }[] = [];
		let acc = 0;
		ps.forEach((p, i) => {
			if (i) {
				const gap = Math.max(0, p.t - ps[i - 1].t);
				if (gap > GAP_CAP_S) breaks.push({ at: acc + GAP_CAP_S / 2, gap });
				acc += Math.min(gap, GAP_CAP_S);
			}
			pos.push(acc);
		});
		return { pos, total: acc, breaks };
	}, [ps]);

	const [range, setRange] = useState<[number, number]>([0, 1]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset the range for a new roll
	useEffect(() => setRange([0, 1]), [roll.id]);
	const [lo, hi] = range;
	const inRange = (i: number) => {
		const f = total ? pos[i] / total : 0.5;
		return f >= lo - 1e-9 && f <= hi + 1e-9;
	};
	const full = lo <= 0 && hi >= 1;
	const visibleKey = ps.map((_, i) => (inRange(i) ? 1 : 0)).join("");

	const emit = useRef(onChange);
	emit.current = onChange;
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the membership string
	useEffect(() => {
		emit.current(
			full
				? undefined
				: new Set(ps.filter((_, i) => inRange(i)).map((p) => p.meta.id)),
		);
	}, [visibleKey, full]);

	const track = useRef<HTMLDivElement>(null);
	const active = useRef<0 | 1 | null>(null);
	const fracAt = (clientX: number) => {
		const r = track.current?.getBoundingClientRect();
		return r ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0;
	};
	const onPointerDown = (e: React.PointerEvent) => {
		const f = fracAt(e.clientX);
		active.current = Math.abs(f - lo) <= Math.abs(f - hi) && !(f > hi) ? 0 : 1;
		e.currentTarget.setPointerCapture(e.pointerId);
		move(f);
	};
	const move = (f: number) => {
		setRange(([a, b]) =>
			active.current === 0 ? [Math.min(f, b), b] : [a, Math.max(f, a)],
		);
	};
	// keyboard: arrows step the handle to the next/previous photo
	const step = (which: 0 | 1, dir: 1 | -1) => {
		const fs = total ? pos.map((p) => p / total) : [0, 1];
		const cur = range[which];
		const next =
			dir > 0
				? (fs.find((f) => f > cur + 1e-6) ?? 1)
				: ([...fs].reverse().find((f) => f < cur - 1e-6) ?? 0);
		setRange(([a, b]) =>
			which === 0 ? [Math.min(next, b), b] : [a, Math.max(next, a)],
		);
	};

	const nIn = ps.filter((_, i) => inRange(i)).length;
	const first = ps.find((_, i) => inRange(i));
	const last = [...ps].reverse().find((_, i) => inRange(ps.length - 1 - i));
	const days = ps
		.map((p, i) => ({ p, i }))
		.filter(({ p, i }) => !i || dayKey(p.meta) !== dayKey(ps[i - 1].meta));

	if (ps.length < 2 || !total) return null;

	return (
		<div
			className={`rounded-xl bg-white/[0.03] px-4 pt-2.5 pb-2 ring-1 ring-white/8 ${className}`}
			data-testid="roll-time"
		>
			<div className="flex items-center gap-3 text-[11px] text-white/55">
				<span className="font-semibold text-white/75">Time</span>
				<span className="truncate font-mono">
					{first && last
						? `${fmtDay(first.meta)} ${fmtTime(first.meta)} → ${fmtDay(last.meta)} ${fmtTime(last.meta)}`
						: "no photos"}
				</span>
				<span className="ml-auto shrink-0">
					{nIn} of {ps.length} photos
				</span>
				{!full && (
					<button
						type="button"
						onClick={() => setRange([0, 1])}
						className="inline-flex shrink-0 items-center gap-1 text-white/55 hover:text-white"
					>
						<RotateCcw className="size-3" /> All
					</button>
				)}
			</div>
			<div
				ref={track}
				className="relative mx-2 mt-2 h-8 cursor-pointer touch-none select-none"
				onPointerDown={onPointerDown}
				onPointerMove={(e) => active.current != null && move(fracAt(e.clientX))}
				onPointerUp={() => {
					active.current = null;
				}}
			>
				<LightBand
					photos={ps}
					pos={pos}
					total={total}
					gapCap={GAP_CAP_S}
					lat={roll.center.lat}
					lon={roll.center.lon}
				/>
				<div className="absolute inset-x-0 top-3.5 h-1 rounded-full bg-white/10" />
				<div
					className="absolute top-3.5 h-1 rounded-full bg-[var(--rigi-glow)]/60"
					style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }}
				/>
				{breaks.map((b) => (
					<span
						key={b.at}
						className="absolute top-2 -translate-x-1/2 font-mono text-[8.5px] leading-none text-white/35"
						style={{ left: `${(b.at / total) * 100}%` }}
						title={`${fmtGap(b.gap)} break`}
					>
						⋯
					</span>
				))}
				{ps.map((p, i) => (
					<button
						key={p.meta.id}
						type="button"
						title={`${p.meta.id} · ${fmtTime(p.meta)}`}
						onPointerDown={(e) => e.stopPropagation()}
						onClick={() =>
							onSelect(p.meta.id === selectedId ? null : p.meta.id)
						}
						className={`absolute top-[18px] h-3 w-1.5 -translate-x-1/2 rounded-sm transition ${inRange(i) ? "" : "opacity-25"} ${
							p.meta.id === selectedId ? "ring-2 ring-white" : ""
						}`}
						style={{
							left: `${(pos[i] / total) * 100}%`,
							background: vpColor(p.viewpoint),
						}}
					/>
				))}
				{([0, 1] as const).map((w) => (
					<div
						key={w}
						role="slider"
						tabIndex={0}
						aria-label={w ? "End of time range" : "Start of time range"}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.round(range[w] * 100)}
						onKeyDown={(e) => {
							if (e.key === "ArrowRight" || e.key === "ArrowUp") step(w, 1);
							else if (e.key === "ArrowLeft" || e.key === "ArrowDown")
								step(w, -1);
							else return;
							e.preventDefault();
						}}
						className="absolute top-1.5 size-5 -translate-x-1/2 rounded-full border-2 border-[var(--rigi-glow)] bg-[var(--rigi-ink)] shadow outline-none focus-visible:ring-2 focus-visible:ring-white/70"
						style={{ left: `${range[w] * 100}%` }}
					/>
				))}
			</div>
			<div className="relative mx-2 h-3.5 font-mono text-[9.5px] text-white/35">
				{days.map(({ p, i }) => (
					<span
						key={p.meta.id}
						className={`absolute whitespace-nowrap ${pos[i] / total > 0.85 ? "-translate-x-full" : ""}`}
						style={{ left: `${(pos[i] / total) * 100}%` }}
					>
						{fmtDay(p.meta)}
					</span>
				))}
			</div>
		</div>
	);
}
