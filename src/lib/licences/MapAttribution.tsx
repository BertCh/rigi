// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The data credit for map and render surfaces (roadmap N2): one compact line generated from the
// attribution table (./attribution.ts), never a literal. An ink fill separates it from the map; no
// border. `compact` collapses it to an "i" button that opens on click or focus, for small embeds.
// Classic mode (?attrib=classic, the default) names Mapterhorn for the terrain; ?attrib=full also
// lists the national DEM producers. Each name links to its terms.
import { Info } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useFlag } from "#/lib/flags/react";
import { cn } from "#/lib/utils";
import {
	type AttributionQuery,
	attributionFor,
	type Credit,
	fullAttribution,
	groupCredits,
} from "./attribution";

/** The credit parts in display order: [prefix, credits] per group (pure; the component renders it). */
export function creditParts(
	credits: readonly Credit[],
	o: { full: boolean },
): { prefix: string; credits: Credit[] }[] {
	const g = groupCredits(credits);
	const dem = o.full ? g.dem : g.dem.slice(0, 1);
	const parts: { prefix: string; credits: Credit[] }[] = [];
	if (dem.length) parts.push({ prefix: "Terrain ©", credits: dem });
	if (g.imagery.length)
		parts.push({ prefix: `${g.imageryNoun} ©`, credits: g.imagery });
	if (g.osm) parts.push({ prefix: "©", credits: [g.osm] });
	if (g.tiles3d.length) parts.push({ prefix: "3D ©", credits: g.tiles3d });
	return parts;
}

function CreditLink({ c }: { c: Credit }) {
	return c.href ? (
		<a
			href={c.href}
			target="_blank"
			rel="noreferrer"
			title={c.licence}
			className="underline decoration-white/25 underline-offset-2 hover:text-white"
			onPointerDown={(e) => e.stopPropagation()}
		>
			{c.label}
		</a>
	) : (
		<span>{c.label}</span>
	);
}

export function MapAttribution({
	compact = false,
	position = "overlay",
	className,
	...q
}: AttributionQuery & {
	/** Collapse to an "i" button (small embeds). */
	compact?: boolean;
	/** "overlay": absolute, bottom-right of the nearest positioned parent. "inline": in the flow. */
	position?: "overlay" | "inline";
	className?: string;
}) {
	const attrib = useFlag("attrib");
	const [open, setOpen] = useState(false);
	const { lat, lon, radiusKm, imagery, provider, osm, tiles3d } = q;
	// biome-ignore lint/correctness/useExhaustiveDependencies: attrib re-reads the setting when ?attrib changes
	const parts = useMemo(
		() =>
			creditParts(
				attributionFor({ lat, lon, radiusKm, imagery, provider, osm, tiles3d }),
				{ full: fullAttribution() },
			),
		[attrib, lat, lon, radiusKm, imagery, provider, osm, tiles3d],
	);
	const line: ReactNode = parts.map((p, i) => (
		<span key={p.prefix + p.credits[0]?.id}>
			{i ? " · " : ""}
			{p.prefix}{" "}
			{p.credits.map((c, j) => (
				<span key={c.id}>
					{j ? ", " : ""}
					<CreditLink c={c} />
				</span>
			))}
		</span>
	));
	const shell = cn(
		position === "overlay" &&
			"absolute right-2 bottom-2 z-20 max-w-[calc(100%-1rem)]",
		className,
	);
	if (compact && !open)
		return (
			<div className={shell} data-map-attribution="collapsed">
				<button
					type="button"
					aria-label="Map data credits"
					aria-expanded={false}
					onClick={() => setOpen(true)}
					onFocus={() => setOpen(true)}
					onPointerDown={(e) => e.stopPropagation()}
					className="flex size-5 items-center justify-center rounded-full bg-black/55 text-white/75 backdrop-blur hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--rigi-glow)] focus-visible:outline-none"
				>
					<Info className="size-3" />
				</button>
			</div>
		);
	return (
		<div className={shell} data-map-attribution={compact ? "open" : "line"}>
			<p
				className={cn(
					"rounded bg-black/55 px-1.5 py-0.5 text-[10px] leading-snug text-white/70 backdrop-blur",
					position === "overlay" && "text-right",
				)}
			>
				{line}
				{compact && (
					<button
						type="button"
						aria-label="Hide map data credits"
						onClick={() => setOpen(false)}
						className="ml-1.5 text-white/50 hover:text-white focus-visible:ring-2 focus-visible:ring-[var(--rigi-glow)] focus-visible:outline-none"
					>
						×
					</button>
				)}
			</p>
		</div>
	);
}
