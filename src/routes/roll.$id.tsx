// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	createFileRoute,
	Link,
	notFound,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import {
	ArrowLeft,
	ChevronLeft,
	ChevronRight,
	Columns2,
	Download,
	ExternalLink,
	LayoutGrid,
	Map as MapIcon,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ThemeToggle } from "#/components/site/ThemeToggle";
import { AlignRollButton } from "#/lib/roll/align";
import { downloadRollGeoJSON } from "#/lib/roll/export";
import { RollMap } from "#/lib/roll/map/RollMap";
import {
	aspectOf,
	fmtDateSpan,
	fmtDay,
	fmtDistance,
	fmtTime,
	HeadingChip,
	POSE_SOURCE_LABEL,
	POSE_SOURCES,
	PoseBadge,
	RollMosaic,
	TimeScrubber,
	vpColor,
} from "#/lib/roll/mosaic";
import {
	deleteUploadRoll,
	getUploadThumb,
	isLocalRollId,
} from "#/lib/roll/mosaic/loadRoll";
import { PropagatePanel, propagateMode } from "#/lib/roll/propagate";
import { hfovOf } from "#/lib/roll/roll";
import type { Roll, RollPhoto } from "#/lib/roll/types";

type View = "mosaic" | "map" | "split";
type Search = { photo?: string; view?: View };

export const Route = createFileRoute("/roll/$id")({
	ssr: false,
	validateSearch: (s: Record<string, unknown>): Search => ({
		photo: typeof s.photo === "string" && s.photo ? s.photo : undefined,
		view: s.view === "map" || s.view === "split" ? s.view : undefined,
	}),
	loader: async ({ params }) => {
		// dynamic: a static import here lands the mosaic barrel in the entry chunk every route pays
		const { loadRoll } = await import("#/lib/roll/mosaic/loadRoll");
		const roll = await loadRoll(params.id);
		if (!roll) throw notFound();
		return roll;
	},
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.name ?? "Roll"} · Rigi` }],
	}),
	component: RollPage,
});

const VIEWS = [
	["mosaic", "Mosaic", LayoutGrid],
	["map", "Map", MapIcon],
	["split", "Split", Columns2],
] as const;

function RollPage() {
	const roll = Route.useLoaderData();
	const search = Route.useSearch();
	const view: View = search.view ?? "mosaic";
	const navigate = useNavigate({ from: Route.fullPath });
	const router = useRouter();
	const selected = roll.photos.find((p) => p.meta.id === search.photo) ?? null;
	const selectedId = selected?.meta.id ?? null;

	const onSelect = useCallback(
		(id: string | null) =>
			navigate({
				search: (s: Search) => ({ ...s, photo: id ?? undefined }),
				replace: true,
				resetScroll: false,
			}),
		[navigate],
	);
	const setView = (v: View) =>
		navigate({
			search: (s: Search) => ({ ...s, view: v === "mosaic" ? undefined : v }),
			replace: true,
			resetScroll: false,
		});

	// R5 pose propagation (suggestions only), off unless ?propagate=on|dev
	const [propagate] = useState(propagateMode);
	const [visibleIds, setVisibleIds] = useState<
		ReadonlySet<string> | undefined
	>();
	// ← → step through the (visible) photos, Esc clears the selection
	const visible = useMemo(
		() =>
			visibleIds
				? roll.photos.filter((p) => visibleIds.has(p.meta.id))
				: roll.photos,
		[roll, visibleIds],
	);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (
				e.target instanceof HTMLElement &&
				e.target.closest('input, textarea, [role="slider"]')
			)
				return;
			if (e.key === "Escape") onSelect(null);
			else if (
				(e.key === "ArrowRight" || e.key === "ArrowLeft") &&
				visible.length
			) {
				const i = visible.findIndex((p) => p.meta.id === selectedId);
				const d = e.key === "ArrowRight" ? 1 : -1;
				const next =
					i < 0
						? d > 0
							? 0
							: visible.length - 1
						: (i + d + visible.length) % visible.length;
				onSelect(visible[next].meta.id);
				e.preventDefault();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [visible, selectedId, onSelect]);

	const map = (
		<RollMap
			roll={roll}
			selectedId={selectedId}
			onSelect={onSelect}
			visibleIds={visibleIds}
			className="size-full"
		/>
	);

	return (
		<main
			className="min-h-dvh bg-[var(--rigi-ink)] text-[var(--rigi-paper)]"
			data-testid="roll-page"
		>
			<header className="mx-auto flex max-w-[1600px] flex-wrap items-end gap-x-6 gap-y-3 px-4 pt-6 pb-4 sm:px-8">
				<div className="min-w-0 flex-1">
					<Link
						to="/roll"
						className="mb-3 inline-flex items-center gap-1.5 text-xs text-white/55 hover:text-[var(--rigi-paper)]"
					>
						<ArrowLeft className="size-3.5" /> Camera rolls
					</Link>
					<h1 className="truncate text-2xl font-semibold tracking-[-0.02em]">
						{roll.name}
					</h1>
					<RollStats roll={roll} />
				</div>
				<AlignRollButton roll={roll} onChanged={() => router.invalidate()} />
				<button
					type="button"
					onClick={() => downloadRollGeoJSON(roll)}
					data-testid="export-roll"
					title="Download cameras, view wedges and the track as GeoJSON"
					className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.05] px-3 py-1.5 text-xs font-medium text-white/55 hover:bg-white/10 hover:text-[var(--rigi-paper)]"
				>
					<Download className="size-3.5" /> GeoJSON
				</button>
				{isLocalRollId(roll.id) && <DeleteLocalRoll roll={roll} />}
				<div
					className="inline-flex rounded-lg bg-white/[0.04] p-0.5"
					role="tablist"
					aria-label="View"
				>
					{VIEWS.map(([k, label, Icon]) => (
						<button
							key={k}
							type="button"
							role="tab"
							aria-selected={view === k}
							onClick={() => setView(k)}
							className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
								view === k
									? "bg-[var(--rigi-glow)] text-[var(--rigi-ink)]"
									: "text-white/60 hover:text-white"
							} ${k === "split" ? "hidden lg:inline-flex" : ""}`}
						>
							<Icon className="size-3.5" /> {label}
						</button>
					))}
				</div>
				<ThemeToggle />
			</header>
			<div className="mx-auto max-w-[1600px] px-4 pb-4 sm:px-8">
				<TimeScrubber
					roll={roll}
					selectedId={selectedId}
					onSelect={onSelect}
					onChange={setVisibleIds}
				/>
				{/* with the map on screen the strip sits inline, clear of the map's own bottom controls */}
				{selected && view !== "mosaic" && (
					<DetailStrip
						roll={roll}
						photo={selected}
						visible={visible}
						onSelect={onSelect}
						inline
					/>
				)}
			</div>
			<div
				className={`mx-auto max-w-[1600px] px-4 sm:px-8 ${selected && view === "mosaic" ? "pb-40" : "pb-16"}`}
			>
				{view === "mosaic" && (
					<RollMosaic
						roll={roll}
						selectedId={selectedId}
						onSelect={onSelect}
						visibleIds={visibleIds}
					/>
				)}
				{view === "map" && (
					<div className="h-[calc(100dvh-220px)] min-h-[420px] overflow-hidden rounded-md bg-black/40">
						{map}
					</div>
				)}
				{view === "split" && (
					<div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
						<div className="min-w-0 lg:h-[calc(100dvh-220px)] lg:overflow-y-auto lg:pr-2">
							<RollMosaic
								roll={roll}
								selectedId={selectedId}
								onSelect={onSelect}
								visibleIds={visibleIds}
								compact
							/>
						</div>
						<div className="h-[60dvh] min-h-[360px] overflow-hidden rounded-md bg-black/40 lg:sticky lg:top-4 lg:h-[calc(100dvh-220px)]">
							{map}
						</div>
					</div>
				)}
			</div>
			{propagate !== "off" && (
				<PropagatePanel
					roll={roll}
					mode={propagate}
					selectedId={selectedId}
					onSelect={onSelect}
					onChanged={() => router.invalidate()}
				/>
			)}
			{selected && view === "mosaic" && (
				<DetailStrip
					roll={roll}
					photo={selected}
					visible={visible}
					onSelect={onSelect}
				/>
			)}
		</main>
	);
}

function RollStats({ roll }: { roll: Roll }) {
	const counts = POSE_SOURCES.map(
		(s) => [s, roll.photos.filter((p) => p.poseSource === s).length] as const,
	).filter(([, c]) => c);
	return (
		<p className="mt-1 text-xs text-white/50">
			{roll.photos.length} photos · {roll.viewpoints.length} viewpoints ·{" "}
			{fmtDateSpan(roll.photos)}
			{roll.radiusM > 0 && ` · ${fmtDistance(2 * roll.radiusM)} across`}
			<span className="text-white/35">
				{" "}
				· poses:{" "}
				{counts.map(([s, c]) => `${c} ${POSE_SOURCE_LABEL[s]}`).join(", ")}
			</span>
		</p>
	);
}

/** Bottom strip for the selected photo: thumbnail, pose, prev/next and a link to the workspace. */
function DetailStrip({
	roll,
	photo,
	visible,
	onSelect,
	inline = false,
}: {
	roll: Roll;
	photo: RollPhoto;
	visible: RollPhoto[];
	onSelect: (id: string | null) => void;
	inline?: boolean;
}) {
	const list = visible.some((p) => p.meta.id === photo.meta.id)
		? visible
		: roll.photos;
	const i = list.findIndex((p) => p.meta.id === photo.meta.id);
	const step = (d: number) =>
		onSelect(list[(i + d + list.length) % list.length].meta.id);
	const { pose } = photo;
	const vp = roll.viewpoints[photo.viewpoint];
	return (
		<div
			className={
				inline ? "mt-3" : "fixed inset-x-0 bottom-0 z-30 px-3 pb-3 sm:px-6"
			}
			data-testid="roll-detail"
		>
			<div
				className={`flex items-center gap-3 rounded-md bg-[var(--rigi-slate)]/95 p-2.5 ${inline ? "" : "mx-auto max-w-4xl shadow-2xl backdrop-blur"}`}
			>
				<div
					data-theme="dark"
					className="h-16 shrink-0 overflow-hidden rounded-md bg-black"
					style={{ width: 64 * aspectOf(photo) }}
				>
					{photo.meta.src && (
						<img
							src={getUploadThumb(photo.meta.id) ?? photo.meta.src}
							alt={photo.meta.id}
							decoding="async"
							loading="lazy"
							className="size-full object-cover"
						/>
					)}
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-mono text-sm font-semibold">
							{photo.meta.id}
						</span>
						<PoseBadge photo={photo} />
						<HeadingChip photo={photo} />
					</div>
					<div className="mt-1 truncate font-mono text-[11px] text-white/50">
						{fmtDay(photo.meta)} {fmtTime(photo.meta)} · pitch{" "}
						{pose.pitch.toFixed(1)}° · roll {pose.roll.toFixed(1)}° · FOV{" "}
						{hfovOf(pose, aspectOf(photo)).toFixed(0)}°×{pose.vfov.toFixed(0)}°
						<span className="ml-1 inline-flex items-center gap-1">
							·{" "}
							<span
								className="size-2 rounded-full"
								style={{ background: vpColor(photo.viewpoint) }}
							/>{" "}
							viewpoint {photo.viewpoint + 1}
							{vp &&
								vp.photoIds.length > 1 &&
								` (${vp.photoIds.length} photos)`}
						</span>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<IconBtn label="Previous photo" onClick={() => step(-1)}>
						<ChevronLeft className="size-4" />
					</IconBtn>
					<span className="w-10 text-center font-mono text-[11px] text-white/45">
						{i + 1}/{list.length}
					</span>
					<IconBtn label="Next photo" onClick={() => step(1)}>
						<ChevronRight className="size-4" />
					</IconBtn>
					<Link
						to="/photo/$id"
						params={{ id: photo.meta.id }}
						className="ml-1 inline-flex items-center gap-1.5 rounded-lg bg-[var(--rigi-glow)] px-3 py-1.5 text-xs font-semibold text-[var(--rigi-ink)] hover:brightness-110"
						data-testid="open-workspace"
					>
						<span className="hidden sm:inline">Open in workspace</span>
						<span className="sm:hidden">Open</span>
						<ExternalLink className="size-3.5" />
					</Link>
					<IconBtn label="Clear selection" onClick={() => onSelect(null)}>
						<X className="size-4" />
					</IconBtn>
				</div>
			</div>
		</div>
	);
}

function IconBtn({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={onClick}
			className="flex size-8 items-center justify-center rounded-md text-white/65 hover:bg-white/10 hover:text-white"
		>
			{children}
		</button>
	);
}

/** Local (uploaded) rolls only: delete every photo in the roll from this device, after a confirm step. */
function DeleteLocalRoll({ roll }: { roll: Roll }) {
	const router = useRouter();
	const navigate = useNavigate();
	const [state, setState] = useState<"idle" | "confirm" | "deleting">("idle");
	const [error, setError] = useState<string | null>(null);
	const del = async () => {
		setState("deleting");
		try {
			await deleteUploadRoll(roll);
			await router.invalidate();
			navigate({ to: "/roll" });
		} catch (e) {
			setError((e as Error).message);
			setState("idle");
		}
	};
	if (state === "idle")
		return (
			<button
				type="button"
				onClick={() => setState("confirm")}
				data-testid="delete-roll"
				title={error ?? "Delete this roll from this device"}
				className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.05] px-3 py-1.5 text-xs font-medium text-white/55 hover:text-red-300 light:hover:text-[var(--rigi-trap)]"
			>
				<Trash2 className="size-3.5" />{" "}
				{error ? "Delete failed, retry" : "Delete roll"}
			</button>
		);
	return (
		<div
			className="inline-flex items-center gap-2 rounded-lg bg-red-500/10 px-2.5 py-1 text-xs"
			data-testid="delete-roll-confirm"
		>
			<span className="text-red-200 light:text-[var(--rigi-trap)]">
				Delete {roll.photos.length} photo{roll.photos.length === 1 ? "" : "s"}{" "}
				from this device?
			</span>
			<button
				type="button"
				disabled={state === "deleting"}
				onClick={del}
				data-testid="delete-roll-yes"
				className="rounded-md bg-red-400 px-2 py-1 font-semibold text-black light:text-[var(--rigi-paper)] hover:brightness-110 disabled:opacity-50"
			>
				{state === "deleting" ? "Deleting…" : "Delete"}
			</button>
			<button
				type="button"
				disabled={state === "deleting"}
				onClick={() => setState("idle")}
				className="px-1 text-white/60 hover:text-white"
			>
				Cancel
			</button>
		</div>
	);
}
