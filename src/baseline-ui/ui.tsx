// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/** Small presentational pieces for the baseline side panel. */
import type { ReactNode } from "react";

export function Section({
	title,
	children,
	right,
}: {
	title: string;
	children: ReactNode;
	right?: ReactNode;
}) {
	return (
		<section className="border-b border-neutral-200 px-4 py-3 last:border-b-0">
			<div className="mb-2 flex items-center justify-between gap-2">
				<h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
					{title}
				</h2>
				{right}
			</div>
			{children}
		</section>
	);
}

export function Notice({
	tone = "warn",
	children,
}: {
	tone?: "warn" | "error" | "info";
	children: ReactNode;
}) {
	const cls =
		tone === "error"
			? "border-red-200 bg-red-50 text-red-800"
			: tone === "info"
				? "border-sky-200 bg-sky-50 text-sky-900"
				: "border-amber-200 bg-amber-50 text-amber-900";
	return (
		<div className={`rounded-md border px-3 py-2 text-sm ${cls}`}>
			{children}
		</div>
	);
}

export function Button({
	children,
	onClick,
	disabled,
	primary,
	active,
	title,
}: {
	children: ReactNode;
	onClick: () => void;
	disabled?: boolean;
	primary?: boolean;
	active?: boolean;
	title?: string;
}) {
	const cls = primary
		? "bg-neutral-900 text-white hover:bg-neutral-700 border-neutral-900"
		: active
			? "bg-amber-100 border-amber-400 text-amber-900"
			: "bg-white hover:bg-neutral-100 border-neutral-300 text-neutral-800";
	return (
		<button
			type="button"
			title={title}
			onClick={onClick}
			disabled={disabled}
			className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${cls}`}
		>
			{children}
		</button>
	);
}

export function Slider({
	label,
	value,
	display,
	min,
	max,
	step,
	onChange,
}: {
	label: string;
	value: number;
	display: string;
	min: number;
	max: number;
	step: number;
	onChange: (v: number) => void;
}) {
	return (
		<label className="block">
			<div className="flex justify-between text-sm">
				<span className="text-neutral-600">{label}</span>
				<span className="font-mono tabular-nums text-neutral-900">
					{display}
				</span>
			</div>
			<input
				type="range"
				className="w-full accent-neutral-900"
				min={min}
				max={max}
				step={step}
				value={Math.min(max, Math.max(min, value))}
				onChange={(e) => onChange(Number(e.target.value))}
			/>
		</label>
	);
}

export function Toggle({
	label,
	checked,
	onChange,
	swatch,
}: {
	label: string;
	checked: boolean;
	onChange: (v: boolean) => void;
	swatch?: ReactNode;
}) {
	return (
		<label className="flex items-center gap-2 text-sm">
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
				className="accent-neutral-900"
			/>
			{swatch}
			{label}
		</label>
	);
}
