// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";

export interface SignpostProps {
	direction: "prev" | "next";
	/** Small caps line, e.g. "Vorher" / "Next". */
	kicker: string;
	title: string;
	/** Secondary "time"-style line, e.g. "ca. 4 min". */
	subtitle?: string;
	/** Extra content below the subtitle. */
	children?: ReactNode;
	className?: string;
}

const CLIP = {
	next: "polygon(0 0, calc(100% - 22px) 0, 100% 50%, calc(100% - 22px) 100%, 0 100%)",
	prev: "polygon(22px 0, 100% 0, 100% 100%, 22px 100%, 0 50%)",
} as const;

/**
 * Wegweiser-style yellow signpost. Presentational: callers wrap it in a
 * Link. Arrow end points left (prev) or right (next).
 */
export function Signpost({
	direction,
	kicker,
	title,
	subtitle,
	children,
	className,
}: SignpostProps) {
	const next = direction === "next";
	return (
		<div className={`relative block px-0 py-0 ${className ?? ""}`}>
			<div
				className={`flex flex-col justify-center gap-0.5 py-2.5 ${next ? "items-start pl-4 pr-9 text-left" : "items-end pl-9 pr-4 text-right"}`}
				style={{
					background: "var(--gb-sign)",
					color: "var(--gb-ink)",
					clipPath: CLIP[direction],
				}}
			>
				<span className="gb-caps text-[11px] tracking-[0.16em]">{kicker}</span>
				<span
					className="gb-caps text-[16px] leading-tight tracking-[0.04em]"
					style={{ fontWeight: 600 }}
				>
					{title}
				</span>
				{subtitle ? (
					<span
						className={`gb-coord text-[11px] ${next ? "self-end text-right" : "self-start text-left"}`}
						style={{ color: "var(--gb-ink)" }}
					>
						{subtitle}
					</span>
				) : null}
				{children}
			</div>
		</div>
	);
}
