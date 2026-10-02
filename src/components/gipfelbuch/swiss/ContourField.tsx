// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type CSSProperties, useId } from "react";
import { type SheetContourKey, useSheet } from "./useSheet";

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

/**
 * Pencil contours per class (S1): minor lines thin, index lines heavier, rock in graphite. Each is
 * drawn twice, the second pass offset by a fraction of a pixel and lighter, as a pencil goes over a
 * line again (no texture).
 */
const PENCIL: Record<
	SheetContourKey,
	{ width: number; opacity: number; rock: boolean }
> = {
	m0: { width: 0.6, opacity: 0.45, rock: false },
	m1: { width: 0.7, opacity: 0.6, rock: false },
	m2: { width: 0.85, opacity: 0.75, rock: false },
	i0: { width: 1.3, opacity: 0.7, rock: false },
	i1: { width: 1.5, opacity: 0.85, rock: false },
	i2: { width: 1.8, opacity: 0.95, rock: false },
	r0: { width: 1.1, opacity: 0.55, rock: true },
	r1: { width: 1.3, opacity: 0.7, rock: true },
	r2: { width: 1.5, opacity: 0.85, rock: true },
};
const PENCIL_ORDER = Object.keys(PENCIL) as SheetContourKey[];

/**
 * Pencil contour background (S1, S2) behind a sheet header; place inside a positioned parent. Index
 * contours are heavier and carry italic hand figures cut into the line by a paper halo. The line
 * work goes through the #nb-wobble pencil filter (a static header, so the cost is paid once).
 * Fades out towards the bottom.
 */
export function ContourField({
	className,
	seed = 0,
	focus,
	zoom = 0.5,
	opacity = 0.3,
}: ContourFieldProps) {
	const { status, sheet } = useSheet();
	const labelId = `gb-cf-${useId().replace(/:/g, "")}`;
	if (status !== "ready") return null;
	const f = focus ?? seedFocus(seed);
	const cw = sheet.width * zoom;
	const ch = cw * 0.62;
	const x = Math.max(0, Math.min(sheet.width - cw, f.x * sheet.width - cw / 2));
	const y = Math.max(
		0,
		Math.min(sheet.height - ch, f.y * sheet.height - ch / 2),
	);
	const figure = Math.max(16, cw / 60);
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
			<defs>
				{sheet.contours.labels.map((label, i) => (
					<path key={label.ele} id={`${labelId}-${i}`} d={label.d} />
				))}
			</defs>
			<g
				fill="none"
				strokeLinejoin="round"
				strokeLinecap="round"
				filter="url(#nb-wobble)"
			>
				{PENCIL_ORDER.map((key) => {
					const style = PENCIL[key];
					const d = sheet.contours.runs[key];
					if (!d) return null;
					return (
						<g
							key={key}
							stroke={style.rock ? "var(--gb-pencil)" : "var(--gb-contour)"}
						>
							<path
								d={d}
								strokeWidth={style.width}
								opacity={style.opacity}
								vectorEffect="non-scaling-stroke"
							/>
							<path
								d={d}
								transform="translate(0.9 0.6)"
								strokeWidth={style.width * 0.6}
								opacity={style.opacity * 0.45}
								vectorEffect="non-scaling-stroke"
							/>
						</g>
					);
				})}
			</g>
			{/* index figures cut into their line: a paper halo breaks the contour either side */}
			<g
				className="nb-num"
				fill="var(--gb-contour)"
				style={{ fontSize: figure, fontStyle: "italic" }}
			>
				{sheet.contours.labels.map((label, i) => (
					<text
						key={label.ele}
						dy={figure * 0.32}
						stroke="var(--gb-paper)"
						strokeWidth={figure * 0.5}
						strokeLinejoin="round"
						paintOrder="stroke"
					>
						<textPath
							href={`#${labelId}-${i}`}
							startOffset="50%"
							textAnchor="middle"
						>
							{label.ele}
						</textPath>
					</text>
				))}
			</g>
		</svg>
	);
}
