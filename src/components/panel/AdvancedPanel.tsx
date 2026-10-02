// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The sidebar's "Experimental & dev" section: every app flag (src/lib/flags) as a control, grouped by
// concern (./flags.ts). A change is a router navigation: the URL is the only store, the root route
// carries it to the next page, and the photo route remounts the workspace, so the engine and workers
// start over with the new values. No page reload.
import { useRouter, useRouterState } from "@tanstack/react-router";
import { Check, FlaskConical, Link2, RotateCcw } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	FLAG_NAMES,
	type FlagName,
	type FlagSearch,
	flagDef,
	flagSearchValue,
	flagSet,
	getFlag,
} from "#/lib/flags";
import { googleTilesKey } from "#/lib/tiles3d/config";
import { cn } from "#/lib/utils";
import { Button, Section, Segmented } from "../controls";
import { FLAG_GROUPS, FLAG_UI, type FlagUI } from "./flags";

type SetValue = (value: string | readonly string[] | undefined) => void;

const optLabel = (ui: FlagUI, v: string) => {
	const o = ui.options?.[v];
	return typeof o === "string"
		? { label: o, title: undefined }
		: (o ?? { label: v, title: undefined });
};

/** Google tiles need a key; without one the option is shown but dimmed. */
const noGoogle = (ui: FlagUI, v: string) =>
	ui.name === "tiles3d" && (v === "google" || v === "all") && !googleTilesKey();

const codeCls = "bg-transparent p-0 font-mono text-white/50";

function FlagRow({
	ui,
	onSet,
	disabledReason,
}: {
	ui: FlagUI;
	onSet: SetValue;
	disabledReason?: string;
}) {
	const def = flagDef(ui.name);
	const value = getFlag(ui.name);
	const [num, setNum] = useState(value == null ? "" : String(value));

	let body: ReactNode = null;
	if (def.kind === "enum")
		body = (
			<Segmented
				size="sm"
				value={value as string}
				onChange={(v) => onSet(v)}
				options={def.values.map((v) => {
					const o = optLabel(ui, v);
					return {
						value: v,
						label: noGoogle(ui, v) ? (
							<span className="opacity-40">{o.label}</span>
						) : (
							o.label
						),
						title: noGoogle(ui, v)
							? "No VITE_GOOGLE_TILES_KEY: Google tiles are skipped"
							: o.title,
					};
				})}
			/>
		);
	else if (def.kind === "set") {
		const on = value as readonly string[];
		body = (
			<div className="flex flex-wrap gap-1">
				{def.values.map((v) => {
					const active = on.includes(v);
					const o = optLabel(ui, v);
					return (
						<button
							key={v}
							type="button"
							title={o.title}
							aria-pressed={active}
							onClick={() =>
								onSet(
									def.values.filter((x) =>
										x === v ? !active : on.includes(x),
									),
								)
							}
							className={cn(
								"flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] ring-1 transition-colors",
								active
									? "bg-[var(--rigi-ember)] text-[var(--khipu-w)] ring-[var(--rigi-ember)]"
									: "bg-white/5 text-white/60 hover:text-white",
							)}
						>
							{active && <Check className="size-2.5" />}
							{o.label}
						</button>
					);
				})}
			</div>
		);
	} else if (def.kind === "number") {
		const submit = () => onSet(num.trim() === "" ? undefined : num.trim());
		body = (
			<form
				className="flex gap-1.5"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<input
					type="number"
					step={ui.step}
					value={num}
					placeholder={ui.placeholder}
					onChange={(e) => setNum(e.target.value)}
					className="min-w-0 flex-1 rounded-md bg-white/6 px-2 py-1 font-mono text-[11px] text-white/85 outline-none placeholder:text-white/25 focus:ring-1 focus:ring-[var(--rigi-ember)]/60"
				/>
				<Button className="px-2 py-1" onClick={submit}>
					Set
				</Button>
			</form>
		);
	}

	return (
		<div
			className={cn(
				"space-y-1.5",
				disabledReason && "pointer-events-none opacity-40",
			)}
			data-flag={ui.name}
			title={disabledReason}
		>
			<div className="flex items-center justify-between gap-2">
				<span
					className="cursor-help text-[11px] text-white/70 underline decoration-white/15 decoration-dotted underline-offset-2"
					title={`${ui.help}\n\n?${ui.name}=`}
				>
					{ui.label}
				</span>
				{flagSet(ui.name) && (
					<span className="rounded bg-[var(--rigi-glow)]/15 px-1 py-px font-mono text-[9px] text-[var(--rigi-glow)]">
						set
					</span>
				)}
			</div>
			{body}
		</div>
	);
}

export function AdvancedPanel() {
	const router = useRouter();
	// re-render on every URL change: getFlag reads the page URL, which the router keeps current
	const searchStr = useRouterState({ select: (s) => s.location.searchStr });
	const [copied, setCopied] = useState(false);

	const go = (patch: FlagSearch) =>
		router.navigate({
			to: ".",
			search: ((prev: FlagSearch) => ({ ...prev, ...patch })) as never,
			replace: true,
		});
	const set = (name: FlagName, value: Parameters<SetValue>[0]) =>
		go({ [name]: flagSearchValue(name, value) });
	const resetAll = () =>
		go(Object.fromEntries(FLAG_NAMES.map((k) => [k, undefined])));

	const active = FLAG_UI.filter((ui) => flagSet(ui.name));

	return (
		<Section
			title="Experimental & dev"
			icon={
				<FlaskConical className="size-3 text-amber-200/60 light:text-[var(--rigi-lesson)]" />
			}
			collapse={{ id: "advanced", defaultOpen: false }}
			summary={
				active.length
					? `${active.length} on: ${active.map((f) => f.name).join(", ")}`
					: "all defaults"
			}
			aside={
				active.length > 0 && (
					<span className="rounded-full bg-amber-300/15 px-1.5 text-[10px] font-semibold text-amber-200 light:text-[var(--rigi-lesson)]">
						{active.length} on
					</span>
				)
			}
		>
			<p className="text-[10px] leading-snug text-white/40">
				Page switches, kept in the address bar and carried to every page you
				open from here. Render, data and 3D-tile switches restart the view; the
				rest apply live.
			</p>
			{FLAG_GROUPS.map((g) => {
				const rows = FLAG_UI.filter((ui) => ui.group === g.id);
				if (!rows.length) return null;
				return (
					<div
						key={g.id}
						className="space-y-2.5 rounded-lg bg-white/[0.025] p-2.5"
						data-flag-group={g.id}
					>
						<div className="space-y-0.5">
							<div className="text-[10px] font-semibold tracking-[0.12em] whitespace-nowrap text-white/45 uppercase">
								{g.label}
							</div>
							<div className="text-[10px] leading-snug text-white/25">
								{g.blurb}
							</div>
						</div>
						{rows.map((ui) => (
							<FlagRow
								// keyed on the URL so the number inputs pick up outside changes
								key={`${ui.name}:${searchStr}`}
								ui={ui}
								onSet={(v) => set(ui.name, v)}
							/>
						))}
					</div>
				);
			})}
			<div className="flex gap-2">
				<Button
					className="flex-1"
					title="Copy this page's address, switches included"
					onClick={() => {
						navigator.clipboard?.writeText(window.location.href).then(() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 1500);
						});
					}}
				>
					{copied ? (
						<Check className="size-3.5" />
					) : (
						<Link2 className="size-3.5" />
					)}
					{copied ? "Copied" : "Copy link"}
				</Button>
				<Button
					className="flex-1"
					disabled={!active.length}
					onClick={resetAll}
					title="Clear every switch"
				>
					<RotateCcw className="size-3.5" /> Reset all
				</Button>
			</div>
			<p className="text-[10px] leading-snug text-white/30">
				Also: <code className={codeCls}>?style=</code> (Look theme),{" "}
				<code className={codeCls}>?reveal=</code> (Reveal preset or off),{" "}
				<code className={codeCls}>?propagate=</code> on /roll.
			</p>
		</Section>
	);
}
