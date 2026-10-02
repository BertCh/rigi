// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The mosaic view of a roll: panorama strip on top, then the justified grid next to a plan-view
// mini map (stacked when `compact`, e.g. the left half of the split view).
import { Clock, MapPin, Palette } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { Roll } from "../types";
import { PanoramaStrip } from "./PanoramaStrip";
import { type GroupBy, RollGrid } from "./RollGrid";
import { RollMiniMap } from "./RollMiniMap";
import {
	POSE_SOURCE_CLASS,
	POSE_SOURCE_HINT,
	POSE_SOURCE_LABEL,
	POSE_SOURCES,
} from "./style";

type Props = {
	roll: Roll;
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	visibleIds?: ReadonlySet<string>;
	compact?: boolean;
};

export function RollMosaic({
	roll,
	selectedId,
	onSelect,
	visibleIds,
	compact = false,
}: Props) {
	const [groupBy, setGroupBy] = useState<GroupBy>("viewpoint");
	const photos = useMemo(
		() =>
			visibleIds
				? roll.photos.filter((p) => visibleIds.has(p.meta.id))
				: roll.photos,
		[roll, visibleIds],
	);
	// a pick in the panorama is already in view: the grid shouldn't scroll the page to its tile
	const panoPick = useRef<string | null>(null);
	const onPanoSelect = useCallback(
		(id: string | null) => {
			panoPick.current = id;
			onSelect(id);
		},
		[onSelect],
	);
	const followSelection = useCallback((id: string) => {
		const fromPano = panoPick.current === id;
		panoPick.current = null;
		return !fromPano;
	}, []);
	const map = (
		<RollMiniMap
			roll={roll}
			photos={photos}
			selectedId={selectedId}
			onSelect={onSelect}
			height={compact ? 240 : 320}
		/>
	);
	return (
		<div className="space-y-4" data-testid="roll-mosaic">
			<PanoramaStrip
				roll={roll}
				photos={photos}
				selectedId={selectedId}
				onSelect={onPanoSelect}
				height={compact ? 260 : 340}
				resizable
			/>
			<div
				className={
					compact
						? "space-y-4"
						: "grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]"
				}
			>
				{compact && map}
				<div className="min-w-0">
					<div className="mb-3 flex flex-wrap items-center gap-2">
						<div className="inline-flex rounded-lg bg-white/[0.04] p-0.5">
							{(
								[
									["viewpoint", "Viewpoint", MapPin],
									["time", "Time", Clock],
									["look", "Look", Palette],
								] as const
							).map(([k, label, Icon]) => (
								<button
									key={k}
									type="button"
									aria-pressed={groupBy === k}
									onClick={() => setGroupBy(k)}
									className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
										groupBy === k
											? "bg-white/12 text-white"
											: "text-white/50 hover:text-white/80"
									}`}
								>
									<Icon className="size-3" /> {label}
								</button>
							))}
						</div>
						<span className="ml-auto flex flex-wrap gap-2 text-[10.5px] text-white/45">
							{POSE_SOURCES.map((s) => (
								<span
									key={s}
									className="inline-flex items-center gap-1"
									title={POSE_SOURCE_HINT[s]}
								>
									<span
										className={`rounded px-1 py-px text-[9px] font-semibold uppercase ${POSE_SOURCE_CLASS[s]}`}
									>
										{POSE_SOURCE_LABEL[s]}
									</span>
									{POSE_SOURCE_HINT[s].split(" (")[0].toLowerCase()}
								</span>
							))}
						</span>
					</div>
					<RollGrid
						roll={roll}
						photos={photos}
						selectedId={selectedId}
						onSelect={onSelect}
						groupBy={groupBy}
						followSelection={followSelection}
						rowHeight={compact ? 150 : 190}
					/>
				</div>
				{!compact && <aside className="lg:sticky lg:top-4">{map}</aside>}
			</div>
		</div>
	);
}
