// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Justified-rows photo grid (aspect-preserving rows of equal height, like Google Photos),
// grouped by viewpoint, by time (a new group per day, or after a two-hour break) or by look (k-means
// over each photo's colour embedding, read lazily from its thumbnail; time grouping until it is ready).
import { useEffect, useMemo, useRef, useState } from "react";
import type { PaletteColor } from "#/lib/gpu/palette";
import { useLookGroups } from "../look/useLookGroups";
import type { Roll, RollPhoto } from "../types";
import { HeadingChip, PoseBadge } from "./badges";
import { aspectOf, dayKey, fmtDay, fmtTime, vpColor } from "./style";

export type GroupBy = "viewpoint" | "time" | "look";

/** A break longer than this (s) starts a new time group. */
const SESSION_GAP_S = 2 * 3600;

type Group = {
	key: string;
	title: string;
	sub: string;
	color?: string;
	/** the group's colours (look grouping), shown as dots in the header */
	palette?: PaletteColor[];
	photos: RollPhoto[];
};

export function groupPhotos(
	roll: Roll,
	photos: RollPhoto[],
	by: GroupBy,
): Group[] {
	// "look" groups come from useLookGroups (RollGrid); until they exist it reads as time
	if (by === "viewpoint") {
		const plural = (n: number) => `${n} photo${n === 1 ? "" : "s"}`;
		const multi: Group[] = [];
		const single: RollPhoto[] = [];
		roll.viewpoints.forEach((v, i) => {
			const ps = photos.filter((p) => p.viewpoint === i);
			if (ps.length === 1 && v.photoIds.length === 1) single.push(ps[0]);
			else if (ps.length)
				multi.push({
					key: `vp${i}`,
					title: `Viewpoint ${i + 1}`,
					sub: `${plural(ps.length)} · ${v.lat.toFixed(4)}°, ${v.lon.toFixed(4)}° · ${fmtDay(ps[0].meta)} ${fmtTime(ps[0].meta)}`,
					color: vpColor(i),
					photos: ps,
				});
		});
		// one-photo viewpoints share a group so the grid doesn't become a column of singletons
		if (single.length)
			multi.push({
				key: "single",
				title: multi.length ? "Other viewpoints" : "Viewpoints",
				sub: `${plural(single.length)}, one per spot`,
				photos: single,
			});
		return multi;
	}
	const groups: Group[] = [];
	let prev: RollPhoto | null = null;
	for (const p of photos) {
		if (
			!prev ||
			dayKey(prev.meta) !== dayKey(p.meta) ||
			p.t - prev.t > SESSION_GAP_S
		)
			groups.push({
				key: `t${p.meta.id}`,
				title: fmtDay(p.meta),
				sub: "",
				photos: [],
			});
		groups[groups.length - 1].photos.push(p);
		prev = p;
	}
	for (const g of groups) {
		const a = g.photos[0].meta;
		const b = g.photos[g.photos.length - 1].meta;
		g.sub = `${fmtTime(a)}${g.photos.length > 1 ? `–${fmtTime(b)}` : ""} · ${g.photos.length} photo${g.photos.length === 1 ? "" : "s"}`;
	}
	return groups;
}

type Row = { h: number; items: RollPhoto[] };

/** Pack items into rows of height ≤ maxH whose widths fill the container. */
export function justify(
	items: RollPhoto[],
	width: number,
	target: number,
	gap: number,
): Row[] {
	const rows: Row[] = [];
	let cur: RollPhoto[] = [];
	let sum = 0;
	for (const p of items) {
		cur.push(p);
		sum += aspectOf(p);
		const h = (width - gap * (cur.length - 1)) / sum;
		if (h <= target) {
			rows.push({ h, items: cur });
			cur = [];
			sum = 0;
		}
	}
	// last row keeps the target height instead of stretching
	if (cur.length)
		rows.push({
			h: Math.min(target, (width - gap * (cur.length - 1)) / sum),
			items: cur,
		});
	return rows;
}

type Props = {
	roll: Roll;
	photos: RollPhoto[];
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	groupBy: GroupBy;
	rowHeight?: number;
	/** False for a selection that should not scroll its tile into view. */
	followSelection?: (id: string) => boolean;
};

export function RollGrid({
	roll,
	photos,
	selectedId,
	onSelect,
	groupBy,
	rowHeight = 190,
	followSelection,
}: Props) {
	const ref = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(([e]) =>
			setWidth(Math.floor(e.contentRect.width)),
		);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const lookPhotos = useMemo(
		() => photos.map((p) => ({ id: p.meta.id, src: p.meta.src })),
		[photos],
	);
	const look = useLookGroups(lookPhotos, groupBy === "look");
	const groups = useMemo(() => {
		if (groupBy === "look" && look.groups) {
			const byId = new Map(photos.map((p) => [p.meta.id, p]));
			const placed = new Set<string>();
			const made: Group[] = look.groups.map((g, i) => {
				const members = g.photoIds.flatMap((id) => {
					const photo = byId.get(id);
					if (!photo) return [];
					placed.add(id);
					return [photo];
				});
				return {
					key: `look${i}`,
					title: `Look ${i + 1}`,
					sub: `${members.length} photo${members.length === 1 ? "" : "s"}`,
					palette: g.palette,
					photos: members,
				};
			});
			// photos whose thumbnail could not be read keep a place at the end
			const unread = photos.filter((p) => !placed.has(p.meta.id));
			if (unread.length)
				made.push({
					key: "look-unread",
					title: "Colours not read",
					sub: `${unread.length} photo${unread.length === 1 ? "" : "s"}`,
					photos: unread,
				});
			return made;
		}
		return groupPhotos(roll, photos, groupBy === "look" ? "time" : groupBy);
	}, [roll, photos, groupBy, look.groups]);
	const gap = 4;
	const target = width < 520 ? Math.round(rowHeight * 0.66) : rowHeight;

	// keep the selected tile on screen when it's selected elsewhere (map)
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs per selection, not per callback
	useEffect(() => {
		if (!selectedId || followSelection?.(selectedId) === false) return;
		ref.current
			?.querySelector(`[data-photo="${CSS.escape(selectedId)}"]`)
			?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, [selectedId]);

	return (
		<div ref={ref} className="space-y-6" data-testid="roll-grid">
			{!photos.length && (
				<p className="py-10 text-center text-xs text-white/40">
					No photos in the selected time range.
				</p>
			)}
			{groupBy === "look" && !look.groups && look.pending > 0 && (
				<p className="text-[11px] text-white/40">reading colours…</p>
			)}
			{groupBy === "look" && look.unavailable && (
				<p className="text-[11px] text-white/40">
					Could not read colours; grouped by time.
				</p>
			)}
			{width > 0 &&
				groups.map((g) => (
					<section key={g.key}>
						<h3 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-white/80">
							{g.color && (
								<span
									className="size-2.5 translate-y-px self-center rounded-full"
									style={{ background: g.color }}
								/>
							)}
							{g.title}
							{g.palette && (
								<span className="inline-flex gap-1 self-center">
									{g.palette.map((c) => (
										<span
											key={c.rgb.join(",")}
											className="size-2.5 rounded-full"
											style={{ background: `rgb(${c.rgb.join(",")})` }}
											title={`rgb(${c.rgb.join(", ")}) · ${Math.round(c.share * 100)}%`}
										/>
									))}
								</span>
							)}
							<span className="text-xs font-normal text-white/40">{g.sub}</span>
						</h3>
						<div className="flex flex-col" style={{ gap }}>
							{justify(g.photos, width - 1, target, gap).map((row) => (
								<div
									key={row.items[0].meta.id}
									className="flex"
									style={{ gap, height: row.h }}
								>
									{row.items.map((p) => (
										<Tile
											key={p.meta.id}
											p={p}
											w={aspectOf(p) * row.h}
											selected={p.meta.id === selectedId}
											onSelect={onSelect}
										/>
									))}
								</div>
							))}
						</div>
					</section>
				))}
		</div>
	);
}

function Tile({
	p,
	w,
	selected,
	onSelect,
}: {
	p: RollPhoto;
	w: number;
	selected: boolean;
	onSelect: (id: string | null) => void;
}) {
	return (
		<button
			type="button"
			data-photo={p.meta.id}
			data-theme="dark"
			onClick={() => onSelect(selected ? null : p.meta.id)}
			aria-pressed={selected}
			className={`group relative shrink-0 overflow-hidden rounded-md bg-black text-left outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
				selected
					? "ring-2 ring-[var(--rigi-glow)] ring-offset-2 ring-offset-[var(--rigi-ink)]"
					: ""
			}`}
			style={{ width: w }}
			title={`${p.meta.id} · ${fmtDay(p.meta)} ${fmtTime(p.meta)}`}
		>
			{p.meta.src ? (
				<img
					src={p.meta.src}
					alt={p.meta.id}
					loading="lazy"
					decoding="async"
					draggable={false}
					className="size-full object-cover transition duration-500 group-hover:scale-[1.03]"
				/>
			) : (
				<span className="flex size-full items-center justify-center text-[10px] text-white/30">
					{p.meta.id}
				</span>
			)}
			<span
				className="pointer-events-none absolute inset-x-0 top-0 h-0.5"
				style={{ background: vpColor(p.viewpoint) }}
			/>
			<PoseBadge photo={p} className="absolute top-1.5 left-1.5" />
			<HeadingChip photo={p} className="absolute right-1.5 bottom-1.5" />
			<span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1 font-mono text-[10px] text-white/80 opacity-0 transition group-hover:opacity-100">
				{fmtTime(p.meta)}
			</span>
		</button>
	);
}
