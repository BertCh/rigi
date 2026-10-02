// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Sidebar section for the terroir layers (reports/terroir-cartography.md). Every switch writes a
// style override (getStyleStore().patch), so it works on top of any preset and survives preset
// switches; the `terroir` preset turns them all on. Collapsed by default: additive, out of the way.
import { Mountain } from "lucide-react";
import { Section, Segmented, Slider, Toggle } from "#/components/controls";
import { getStyleStore } from "#/lib/style/store";
import type { DeepPartial, TerroirStyle, ViewStyle } from "#/lib/style/types";

const patch = (t: DeepPartial<TerroirStyle>) =>
	getStyleStore().patch({ terroir: t } as DeepPartial<ViewStyle>);

export function TerroirPanel({
	style,
	mode,
}: {
	style: ViewStyle;
	mode: "overlay" | "replace" | "world";
}) {
	const t = style.terroir;
	const on = Object.values({
		n: t.names.on,
		p: t.peakTiers,
		c: t.contours.adaptive || t.contours.swissIndex || t.contours.inkByCover,
		v: t.cover.on,
		h: t.hatch,
		g: t.glacier.on,
		s: t.sunPath,
		l: t.legend,
		pc: t.placeCard,
		f: t.furniture,
	}).filter(Boolean).length;
	return (
		<Section
			title="Terroir"
			icon={<Mountain className="size-3.5 text-white/40" />}
			collapse={{ id: "terroir", defaultOpen: false }}
			summary={on ? `${on} on` : "off"}
		>
			<p className="text-[11px] leading-relaxed text-white/45">
				The place, not the GIS: local names, real land cover, former glaciers,
				the day's sun. Drawn from swisstopo / Copernicus / OSM where a terroir
				pack covers the photo; display only.
			</p>
			<Toggle
				label="Place names"
				checked={t.names.on}
				onChange={(v) => patch({ names: { on: v } })}
			/>
			{t.names.on && (
				<>
					<Segmented
						size="sm"
						value={t.names.reach}
						options={[
							{
								value: "near",
								label: "Landscape",
								title: "Small places only nearby",
							},
							{ value: "all", label: "Everything" },
						]}
						onChange={(reach) => patch({ names: { reach } })}
					/>
					<Segmented
						size="sm"
						value={t.names.language}
						options={[
							{ value: "local", label: "Official" },
							{
								value: "local+usual",
								label: "+ usual form",
								title: "Second line: the usual / bilingual name",
							},
						]}
						onChange={(language) => patch({ names: { language } })}
					/>
					<Slider
						label="Max names"
						value={t.names.maxLabels}
						min={4}
						max={60}
						step={1}
						format={(v) => `${v}`}
						onChange={(maxLabels) => patch({ names: { maxLabels } })}
					/>
				</>
			)}
			<Toggle
				label="Peaks sized by prominence"
				checked={t.peakTiers}
				onChange={(v) => patch({ peakTiers: v })}
			/>
			<Toggle
				label="Legible elevation line"
				checked={t.subPill}
				onChange={(v) => patch({ subPill: v })}
			/>
			{mode !== "world" && (
				<>
					<Toggle
						label="Contours thin with distance"
						checked={t.contours.adaptive}
						onChange={(v) => patch({ contours: { adaptive: v } })}
					/>
					<Toggle
						label="Index contour every 100 m"
						checked={t.contours.swissIndex}
						onChange={(v) => patch({ contours: { swissIndex: v } })}
					/>
				</>
			)}
			<Toggle
				label="Contour ink by ground (soil · rock · ice)"
				checked={t.contours.inkByCover}
				onChange={(v) => patch({ contours: { inkByCover: v } })}
			/>
			<Toggle
				label="Rock hatching and scree dots (from slope)"
				checked={t.hatch}
				onChange={(v) => patch({ hatch: v })}
			/>
			<Toggle
				label="Real land cover (Blend, In map)"
				checked={t.cover.on}
				onChange={(v) => patch({ cover: { on: v } })}
			/>
			{t.cover.on && (
				<Segmented
					size="sm"
					value={t.cover.snow}
					options={[
						{ value: "none", label: "No snow" },
						{ value: "date", label: "Snow for the date" },
					]}
					onChange={(snow) => patch({ cover: { snow } })}
				/>
			)}
			<Toggle
				label="Former glacier extent"
				checked={t.glacier.on}
				onChange={(v) => patch({ glacier: { on: v } })}
			/>
			{t.glacier.on && (
				<>
					<Slider
						label="Glacier year"
						value={t.glacier.year}
						min={1850}
						max={2023}
						step={1}
						format={(v) => `${v}`}
						onChange={(year) => patch({ glacier: { year } })}
					/>
					<Segmented
						size="sm"
						value={t.glacier.style}
						options={[
							{ value: "outline", label: "Outline" },
							{ value: "fill", label: "Fill" },
						]}
						onChange={(s) => patch({ glacier: { style: s } })}
					/>
				</>
			)}
			<Toggle
				label="Sun path for the day"
				checked={t.sunPath}
				onChange={(v) => patch({ sunPath: v })}
			/>
			<Toggle
				label="Legend"
				checked={t.legend}
				onChange={(v) => patch({ legend: v })}
			/>
			<Toggle
				label="Tap to read the view"
				checked={t.placeCard}
				onChange={(v) => patch({ placeCard: v })}
			/>
			<Toggle
				label="Scale, north, sun & time"
				checked={t.furniture}
				onChange={(v) => patch({ furniture: v })}
			/>
			<Toggle
				label="Soften marks while unverified"
				checked={t.uncertainty}
				onChange={(v) => patch({ uncertainty: v })}
			/>
		</Section>
	);
}
