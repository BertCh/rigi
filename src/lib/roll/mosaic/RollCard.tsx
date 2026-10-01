// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { POSE_GLYPH } from "../../terroir/roll/logic";
import type { Roll } from "../types";
import {
	fmtDateSpan,
	fmtDistance,
	POSE_SOURCE_COLOR,
	POSE_SOURCE_LABEL,
	POSE_SOURCES,
} from "./style";

/** A roll in a list: a strip of its first photos, counts and the pose-source mix. */
export function RollCard({
	roll,
	thumb,
}: {
	roll: Roll;
	thumb: (id: string) => string | null;
}) {
	const n = roll.photos.length;
	const counts = POSE_SOURCES.map(
		(s) => [s, roll.photos.filter((p) => p.poseSource === s).length] as const,
	).filter(([, c]) => c);
	const strip = roll.photos.slice(0, 6);
	return (
		<Link
			to="/roll/$id"
			params={{ id: roll.id }}
			data-testid="roll-card"
			className="group overflow-hidden rounded-xl bg-white/[0.04] ring-1 ring-white/8 transition hover:ring-[var(--rigi-glow)]/50"
		>
			<div className="flex h-28 gap-px overflow-hidden bg-black">
				{strip.map((p) => {
					const src = thumb(p.meta.id);
					return (
						<div
							key={p.meta.id}
							className="h-full min-w-0 flex-1 overflow-hidden"
							style={{ flexGrow: p.meta.width / p.meta.height }}
						>
							{src && (
								<img
									src={src}
									alt=""
									loading="lazy"
									className="size-full object-cover transition duration-500 group-hover:scale-[1.04]"
								/>
							)}
						</div>
					);
				})}
				{n > strip.length && (
					<div className="flex w-12 shrink-0 items-center justify-center bg-white/[0.05] text-xs text-white/55">
						+{n - strip.length}
					</div>
				)}
			</div>
			<div className="px-4 py-3">
				<div className="flex items-baseline justify-between gap-3">
					<span className="truncate text-sm font-semibold">{roll.name}</span>
					<span className="shrink-0 font-mono text-[11px] text-white/40">
						{fmtDateSpan(roll.photos)}
					</span>
				</div>
				<div className="mt-1 text-xs text-white/55">
					{n} photo{n === 1 ? "" : "s"} · {roll.viewpoints.length} viewpoint
					{roll.viewpoints.length === 1 ? "" : "s"}
					{roll.radiusM > 0 && ` · ${fmtDistance(2 * roll.radiusM)} across`}
				</div>
				<div
					className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-white/8"
					aria-hidden="true"
				>
					{counts.map(([s, c]) => (
						<span
							key={s}
							style={{
								width: `${(c / n) * 100}%`,
								background: POSE_SOURCE_COLOR[s],
							}}
						/>
					))}
				</div>
				<div className="mt-1.5 flex flex-wrap gap-x-3 text-[10.5px] text-white/45">
					{counts.map(([s, c]) => (
						<span key={s} className="inline-flex items-center gap-1">
							<span
								className="size-1.5 rounded-full"
								style={{ background: POSE_SOURCE_COLOR[s] }}
							/>
							{c}{" "}
							<span aria-hidden="true" style={{ color: POSE_SOURCE_COLOR[s] }}>
								{POSE_GLYPH[s]}
							</span>{" "}
							{POSE_SOURCE_LABEL[s]}
						</span>
					))}
				</div>
			</div>
		</Link>
	);
}
