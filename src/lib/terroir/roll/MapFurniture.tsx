// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Map furniture for the north-up plan maps (terroir T0.9): a scale bar and a north arrow, bottom
// left, in the same chip style as the maps' credit lines. Used by RollMiniMap and the landing
// TopoBoard (both web-mercator, north up). `bearing` rotates the arrow for a map that can turn.
import { scaleBar } from "./logic";

export function MapFurniture({
	mPerPx,
	bearing = 0,
	note,
	className = "",
}: {
	/** Metres per CSS pixel at the map's centre. */
	mPerPx: number;
	/** Camera bearing, degrees clockwise from north (0 = north up). */
	bearing?: number;
	/** A one-line key shown under the bar (for example the dashed-wedge caption). */
	note?: string;
	className?: string;
}) {
	const bar = mPerPx > 0 && Number.isFinite(mPerPx) ? scaleBar(mPerPx) : null;
	return (
		<div
			className={`pointer-events-none absolute bottom-0 left-0 flex items-end gap-1.5 bg-white/80 px-1.5 py-0.5 text-[10px] leading-tight text-black/80 ${className}`}
			data-testid="map-furniture"
		>
			<svg
				viewBox="-8 -9 16 18"
				className="size-[18px] shrink-0"
				role="img"
				aria-label="North is up"
			>
				<title>North is up</title>
				<g transform={`rotate(${-bearing})`}>
					<path d="M0,-8 L4,6 L0,3 L-4,6 Z" fill="#1c1c1c" />
					<path d="M0,-8 L4,6 L0,3 Z" fill="#8a8a8a" />
				</g>
			</svg>
			<div>
				{note && <div className="mb-0.5 text-black/60">{note}</div>}
				{bar && bar.px >= 8 && (
					<div className="flex items-end gap-1">
						<span
							className="block h-1.5 border-x border-b border-black/80"
							style={{ width: bar.px }}
						/>
						<span className="font-medium">{bar.label}</span>
					</div>
				)}
			</div>
		</div>
	);
}
