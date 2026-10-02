// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import { PenRule } from "../notebook/Ink";

/** Standortfeld: place name in hand capitals, altitude in hand figures, a short pen rule under the altitude. */
export function Standortfeld({
	place,
	altitude,
	note,
}: {
	place: string;
	altitude: number | string;
	note?: string;
}) {
	return (
		<div className="text-left">
			<p className="nb-label m-0 text-[16px] leading-[20px]">{place}</p>
			<p className="nb-num m-0 text-[12px] italic">{altitude} m</p>
			<span className="mt-1 block w-7">
				<PenRule seed={`standort-${place}`} color="ink" width={1.1} />
			</span>
			{note ? (
				<p className="nb-hand m-0 mt-1 text-[16px] leading-[18px] text-[var(--gb-secondary)]">
					{note}
				</p>
			) : null}
		</div>
	);
}

/** Summit-register line of about 1900: sober facts written on one line, separated by a dot. */
export function RegisterLine({
	items,
}: {
	items: { label?: string; value: ReactNode }[];
}) {
	const shown = items.filter(
		(item) =>
			item.value !== null && item.value !== undefined && item.value !== "",
	);
	return (
		<p className="nb-hand-small m-0 text-[13px] leading-[20px]">
			{shown.map((item, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static ordered line
				<span key={i}>
					{i > 0 ? (
						<span className="text-[var(--gb-secondary)]">{" · "}</span>
					) : null}
					{item.label ? `${item.label} ` : null}
					{item.value}
				</span>
			))}
		</p>
	);
}

export interface RegisterEntryProps {
	/** Date as written in the register, e.g. "7.9.2026". */
	date?: string;
	/** 24 h time, e.g. "15:28". */
	time?: string;
	/** Place, e.g. "Niederhorn". */
	place?: string;
	/** Altitude in metres (measured), written after the place. */
	altitude?: number;
	/** Weather as recorded ("klar", "Nebel"); omitted when nothing was recorded. */
	weather?: string;
	/** The writer's initials. */
	initials?: string;
	/** The route: here the pipeline step this sheet records. */
	route?: ReactNode;
	className?: string;
}

/**
 * A summit-register entry (sketch-style §2, §7 move 4): one hand-written line of date, time,
 * place and altitude, weather and initials, then "Route:", ruled off from the sheet by a hand line.
 * Every value is passed in from measured data; a missing value is left out, never invented.
 */
export function RegisterEntry({
	date,
	time,
	place,
	altitude,
	weather,
	initials,
	route,
	className,
}: RegisterEntryProps) {
	const parts: ReactNode[] = [];
	if (date) parts.push(<span key="date">{date}</span>);
	if (time) parts.push(<span key="time">{time}</span>);
	if (place)
		parts.push(
			<span key="place">
				<span className="nb-label">{place}</span>
				{altitude !== undefined ? (
					<span className="nb-num italic"> {Math.round(altitude)} m</span>
				) : null}
			</span>,
		);
	if (weather) parts.push(<span key="weather">{weather}</span>);
	if (initials) parts.push(<span key="initials">{initials}</span>);
	return (
		<div className={`relative ${className ?? ""}`}>
			<p className="nb-hand m-0 text-[20px] leading-[26px] text-[var(--gb-pencil)]">
				{parts.map((part, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed register order
					<span key={i}>
						{i > 0 ? <span aria-hidden="true"> · </span> : null}
						{part}
					</span>
				))}
				{route ? (
					<>
						{parts.length ? <span aria-hidden="true"> · </span> : null}
						<span className="text-[var(--gb-ink)]">Route: </span>
						<span className="text-[var(--gb-red)]">{route}</span>
					</>
				) : null}
			</p>
			<div className="mt-1.5">
				<PenRule
					seed={`register-${date ?? ""}-${place ?? ""}`}
					color="ink"
					width={1.1}
					opacity={0.75}
				/>
			</div>
		</div>
	);
}

/** Führerbuch-style testimony: date, check, verdict, signer, and an optional short remark. */
export function TestimonyLine({
	date,
	check,
	verdict,
	signer,
	remark,
}: {
	date: string;
	check: string;
	verdict: "pass" | "fail";
	signer: string;
	remark?: string;
}) {
	return (
		<p className="m-0 text-[13px]">
			<span className="nb-hand-small">
				{date} · {check} ·{" "}
				<span
					className="nb-label"
					style={{
						color: verdict === "pass" ? "var(--gb-forest)" : "var(--gb-red)",
					}}
				>
					{verdict === "pass" ? "PASS" : "FAIL"}
				</span>{" "}
				· {signer}
			</span>
			{remark ? (
				<span className="nb-hand ml-2 text-[18px] leading-[24px]">
					{remark}
				</span>
			) : null}
		</p>
	);
}
