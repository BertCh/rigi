// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { CSSProperties } from "react";
import { SheetContourRuns } from "./sheet-contour-runs";
import { useSheet } from "./useSheet";

export interface ContourFieldProps {
	className?: string;
	/** Picks a repeatable crop of the sheet, so each page shows a different part. */
	seed?: string | number;
	/** Crop centre in 0..1 sheet coordinates; overrides `seed`. */
	focus?: { x: number; y: number };
	/** Fraction of the sheet width shown (smaller is more zoomed). Default 0.5. */
	zoom?: number;
	/** Line opacity. Default 0.3. */
	opacity?: number;
}

/** Small string hash to two stable numbers in 0..1. */
function seedFocus(seed: string | number) {
	let h = 2166136261;
	for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
	return {
		x: (h >>> 0) / 4294967296,
		y: ((Math.imul(h, 2246822519) >>> 0) % 4096) / 4096,
	};
}

const FADE: CSSProperties = {
	maskImage: "linear-gradient(to bottom, #000 35%, transparent 100%)",
	WebkitMaskImage: "linear-gradient(to bottom, #000 35%, transparent 100%)",
};

/** Decorative brown contour background; place inside a positioned parent. Fades out towards the bottom. */
export function ContourField({
	className,
	seed = 0,
	focus,
	zoom = 0.5,
	opacity = 0.3,
}: ContourFieldProps) {
	const { status, sheet } = useSheet();
	if (status !== "ready") return null;
	const f = focus ?? seedFocus(seed);
	const cw = sheet.width * zoom;
	const ch = cw * 0.62;
	const x = Math.max(0, Math.min(sheet.width - cw, f.x * sheet.width - cw / 2));
	const y = Math.max(
		0,
		Math.min(sheet.height - ch, f.y * sheet.height - ch / 2),
	);
	return (
		<svg
			className={className}
			aria-hidden="true"
			focusable="false"
			viewBox={`${x.toFixed(0)} ${y.toFixed(0)} ${cw.toFixed(0)} ${ch.toFixed(0)}`}
			preserveAspectRatio="xMidYMin slice"
			style={{
				position: "absolute",
				inset: 0,
				width: "100%",
				height: "100%",
				pointerEvents: "none",
				opacity,
				...FADE,
			}}
		>
			{/* same Tanaka runs and surface colours as SheetMap; no filter (bake, do not filter) */}
			<SheetContourRuns sheet={sheet} weight={1.1} />
		</svg>
	);
}
