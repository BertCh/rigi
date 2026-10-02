// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";

/** Standortfeld: place name, altitude in mono, and a 24 px ink rule under the altitude only. */
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
			<p className="m-0 text-[16px] font-semibold">{place}</p>
			<p className="nb-num m-0 text-[11px]">{altitude} m</p>
			<span className="mt-1 block h-px w-6 bg-[var(--gb-ink)]" />
			{note ? (
				<p className="m-0 mt-1 text-[11px] text-[var(--gb-secondary,#4a545c)]">
					{note}
				</p>
			) : null}
		</div>
	);
}

/** Summit-register line of about 1900: sober facts on one line, separated by a bar. */
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
		<p className="nb-num m-0 text-[11px]">
			{shown.map((item, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static ordered line
				<span key={i}>
					{i > 0 ? (
						<span style={{ color: "var(--gb-secondary,#4a545c)" }}>
							{" | "}
						</span>
					) : null}
					{item.label ? `${item.label} ` : null}
					{item.value}
				</span>
			))}
		</p>
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
		<p className="m-0 text-[11px]">
			<span className="nb-num">
				{date} · {check} ·{" "}
				<span
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
