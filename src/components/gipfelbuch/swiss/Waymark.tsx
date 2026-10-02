// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import type { GipfelbuchStatus } from "../../../lib/gipfelbuch/types";
import { PenLine, SketchPolyline } from "../notebook/Ink";
import type { Point } from "../notebook/sketch";
import { paintPolygon } from "./paint";

export type WaymarkVariant = "hike" | "mountain" | "alpine" | "closed";

export interface WaymarkProps {
	variant: WaymarkVariant;
	children?: ReactNode;
	className?: string;
}

/**
 * Paint on rock (S18): two coats of an irregular polygon, the second a little off and thinner, and a
 * pencilled edge only along the top and left (where the painter's brush started), never a full outline.
 */
function Painted({
	points,
	seed,
	fill,
	edge = 0.45,
}: {
	points: Point[];
	seed: string;
	fill: string;
	edge?: number;
}) {
	const [first, second] = points;
	const last = points[points.length - 1];
	return (
		<>
			<path d={paintPolygon(points, seed, 0.7)} fill={fill} />
			<path
				d={paintPolygon(points, `${seed}-coat`, 0.9)}
				fill={fill}
				fillOpacity={0.55}
				transform="translate(0.4 0.3)"
			/>
			{edge > 0 ? (
				<SketchPolyline
					points={[last, first, second]}
					seed={`${seed}-edge`}
					color="ink"
					width={0.7}
					opacity={edge}
					tolerance={0.5}
					passes={1}
				/>
			) : null}
		</>
	);
}

function Blaze({ variant }: { variant: WaymarkVariant }) {
	if (variant === "hike") {
		return (
			<svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true">
				<Painted
					seed="blaze-hike"
					fill="var(--gb-sign)"
					edge={0.8}
					points={[
						[6, 1],
						[11, 8],
						[6, 15],
						[1, 8],
					]}
				/>
			</svg>
		);
	}
	if (variant === "closed") {
		return (
			<svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true">
				<PenLine
					from={[1.5, 3.5]}
					to={[10.5, 12.5]}
					seed="blaze-x1"
					width={1.2}
				/>
				<PenLine
					from={[10.5, 3.5]}
					to={[1.5, 12.5]}
					seed="blaze-x2"
					width={1.2}
				/>
			</svg>
		);
	}
	// PB stands in for RAL 5015 (no Brezine match)
	const mid = variant === "mountain" ? "var(--gb-red)" : "var(--gb-navy)";
	return (
		<svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true">
			<Painted
				seed={`blaze-${variant}-paper`}
				fill="var(--gb-paper)"
				edge={0.8}
				points={[
					[1, 1],
					[11, 1],
					[11, 15],
					[1, 15],
				]}
			/>
			<Painted
				seed={`blaze-${variant}-bar`}
				fill={mid}
				edge={0.3}
				points={[
					[1, 5.67],
					[11, 5.67],
					[11, 10.33],
					[1, 10.33],
				]}
			/>
		</svg>
	);
}

/** SAC / Swiss hiking waymark blaze as an inline chip. */
export function Waymark({ variant, children, className }: WaymarkProps) {
	return (
		<span
			className={`nb-label inline-flex items-center gap-1.5 whitespace-nowrap align-middle text-[12px] leading-none tracking-[0.1em] ${className ?? ""}`}
		>
			<Blaze variant={variant} />
			{children}
		</span>
	);
}

/**
 * Status to blaze, following the SAC difficulty scale as a metaphor for
 * how well-trodden a concept is:
 * live (shipping) is a yellow hiking-trail diamond, signed and safe to follow;
 * flagged (built, behind a flag) is white-red-white, a mountain trail that
 * needs care; research (open question) is white-blue-white, an alpine route
 * with no waymarked path; killed (measured negative) is a crossed-out blaze,
 * a closed trail.
 */
export function waymarkForStatus(status: GipfelbuchStatus): WaymarkVariant {
	switch (status) {
		case "live":
			return "hike";
		case "flagged":
			return "mountain";
		case "research":
			return "alpine";
		case "killed":
			return "closed";
	}
}
