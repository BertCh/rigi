// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type ReactNode, useId } from "react";

/** LK spot height: a 1.6 px ink dot and the elevation in tabular mono figures. */
export function SpotHeight({
	value,
	prefix = "",
	unit,
	className,
}: {
	value: string | number;
	prefix?: "P." | "";
	unit?: string;
	className?: string;
}) {
	return (
		<span className={`inline-flex items-center gap-[3px] ${className ?? ""}`}>
			<svg width="4" height="4" viewBox="0 0 4 4" aria-hidden="true">
				<circle cx="2" cy="2" r="1.6" fill="var(--gb-ink)" />
			</svg>
			<span
				className="nb-num text-[11px]"
				style={{ fontVariantNumeric: "tabular-nums" }}
			>
				{prefix ? `${prefix} ` : ""}
				{value}
				{unit ? ` ${unit}` : ""}
			</span>
		</span>
	);
}

/** LK trigonometric point inline: an open equilateral triangle with a centre dot. */
export function TrigPoint({
	size = 9,
	filled = false,
}: {
	size?: number;
	filled?: boolean;
}) {
	const height = (size * Math.sqrt(3)) / 2;
	const pad = 1;
	const cy = pad + (height * 2) / 3;
	return (
		<svg
			width={size + pad * 2}
			height={height + pad * 2}
			viewBox={`0 0 ${size + pad * 2} ${height + pad * 2}`}
			aria-hidden="true"
			className="inline-block align-[-1px]"
		>
			<path
				d={`M${pad + size / 2} ${pad}L${pad + size} ${pad + height}H${pad}Z`}
				fill={filled ? "var(--gb-ink)" : "none"}
				stroke="var(--gb-ink)"
				strokeWidth={0.9}
				strokeLinejoin="round"
			/>
			<circle
				cx={pad + size / 2}
				cy={cy}
				r={Math.min(1.2, size / 8)}
				fill={filled ? "var(--gb-paper)" : "var(--gb-ink)"}
			/>
		</svg>
	);
}

/** Hut bullet: a 6x5 square with a 2 px roof chevron. Ink; red only for the current hut. */
export function HutBullet({ current = false }: { current?: boolean }) {
	const color = current ? "var(--gb-red)" : "var(--gb-ink)";
	return (
		<svg
			width="8"
			height="9"
			viewBox="0 0 8 9"
			aria-hidden="true"
			className="inline-block align-[-1px]"
		>
			<path
				d="M0.5 2.5L4 0.5L7.5 2.5"
				fill="none"
				stroke={color}
				strokeWidth={1}
			/>
			<rect x="1" y="3" width="6" height="5" fill={color} />
		</svg>
	);
}

/** SAC grade token (T1-T6, L/WS/ZS/S/SS/AS/EX): text only. */
export function Grade({ children }: { children: ReactNode }) {
	return (
		<span
			className="gb-caps text-[11px] tracking-[0.04em]"
			style={{ fontWeight: 600 }}
		>
			{children}
		</span>
	);
}

function rotationOf(seed: string | number): number {
	let hash = 2166136261;
	for (const char of String(seed)) {
		hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	}
	return ((((hash >>> 0) % 1000) / 1000) * 2 - 1) * 4;
}

/**
 * Station stamp: a 44 px round rubber stamp for frozen or verified results only,
 * double ring in navy with the place around the rim and the date in the centre.
 * At most one per page.
 */
export function StationStamp({
	place,
	date,
	seed,
}: {
	place: string;
	date: string;
	seed: string | number;
}) {
	const id = useId().replace(/:/g, "");
	return (
		<svg
			width="44"
			height="44"
			viewBox="0 0 44 44"
			role="img"
			aria-label={`${place}, ${date}`}
			style={{
				mixBlendMode: "multiply",
				opacity: 0.85,
				transform: `rotate(${rotationOf(seed).toFixed(2)}deg)`,
				color: "var(--gb-navy)",
			}}
		>
			<defs>
				<path
					id={id}
					d="M22 22m-15.5 0a15.5 15.5 0 1 1 31 0a15.5 15.5 0 1 1 -31 0"
				/>
			</defs>
			<circle
				cx="22"
				cy="22"
				r="21"
				fill="none"
				stroke="currentColor"
				strokeWidth="1"
			/>
			<circle
				cx="22"
				cy="22"
				r="18.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="1"
			/>
			<text className="gb-caps" fontSize="6" fill="currentColor">
				<textPath href={`#${id}`} startOffset="50%" textAnchor="middle">
					{place}
				</textPath>
			</text>
			<text
				x="22"
				y="24"
				textAnchor="middle"
				fontSize="6.5"
				fill="currentColor"
				className="nb-num"
			>
				{date}
			</text>
		</svg>
	);
}
