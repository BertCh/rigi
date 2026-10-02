// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import {
	type GipfelbuchIndex,
	type GipfelbuchPhotoData,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
} from "#/components/gipfelbuch/viz/real";
import { byId } from "#/lib/gipfelbuch/graph-utils";
import { type NotebookStep, STEP_NUMBER, stepAnchor } from "./entries";
import { useNotebookPhoto } from "./useNotebookPhoto";

// Measured notes for notebook steps, shared by the index notebook and the concept pages. Each note is
// written from the selected demo photo's JSON (public/demo/gipfelbuch), so switching photos rewrites it.

export interface RollData {
	viewpointRadiusM: number;
	spanS: number;
	rows: { id: string }[];
}
export interface TerrainData {
	levels: Record<
		string,
		{ z: number; tiles: number; mPerPx: number; from: number; to: number }[]
	>;
}

const jsonCache = new Map<string, Promise<unknown>>();
export function useStaticJson<T>(url: string): T | null {
	const [value, setValue] = useState<T | null>(null);
	useEffect(() => {
		let live = true;
		let request = jsonCache.get(url);
		if (!request) {
			request = fetch(url).then((response) =>
				response.ok ? response.json() : null,
			);
			jsonCache.set(url, request);
		}
		request.then(
			(result) => live && setValue(result as T),
			() => jsonCache.delete(url),
		);
		return () => {
			live = false;
		};
	}, [url]);
	return value;
}

export const degrees = (value: number, digits = 1) =>
	`${value.toFixed(digits)}°`;
export const signedDegrees = (value: number) =>
	`${value > 0 ? "+" : value < 0 ? "−" : "±"}${Math.abs(value).toFixed(1)}°`;

/** A measured value: monospace digits so numbers line up and read as data, not handwriting. */
export const Value = ({ children }: { children: ReactNode }) => (
	<span className="nb-num text-[13px] text-[var(--nb-ink)]">{children}</span>
);
/**
 * A guess the notebook corrected: struck through in red, the measured value written after it.
 * `by` is the run id or check id that signs the correction.
 */
export const Struck = ({
	children,
	by,
}: {
	children: ReactNode;
	by?: string;
}) => (
	<>
		<s className="nb-num text-[13px] text-[var(--nb-ink)]/70 decoration-[var(--nb-red)] decoration-1">
			{children}
		</s>
		{by ? (
			<sup className="nb-num ml-0.5 text-[11px] text-[var(--gb-secondary,#4a545c)]">
				{by}
			</sup>
		) : null}
	</>
);

export function Term({ id, children }: { id: string; children?: ReactNode }) {
	const node = byId.get(id);
	return (
		<Link
			to="/gipfelbuch/$concept"
			params={{ concept: id }}
			className="nb-term"
			title={node?.tagline}
		>
			{children ?? node?.title ?? id}
		</Link>
	);
}

/** "needs ⑪ DEM horizon" — a margin cross-reference standing in for a graph edge. */
export function NeedsNote({ need }: { need: { id: string; what: string } }) {
	const number = STEP_NUMBER.get(need.id);
	return (
		<a
			href={`#${stepAnchor(need.id)}`}
			className="nb-hand text-[16px] leading-tight text-[var(--nb-blue)] hover:underline"
		>
			← {need.what} from {number ? `(${number})` : ""}{" "}
			{byId.get(need.id)?.title ?? need.id}
		</a>
	);
}

/** Per-step measured note, written for the selected photo. */
export function stepNote(
	step: NotebookStep,
	context: {
		data: GipfelbuchPhotoData;
		index: GipfelbuchIndex | null;
		roll: RollData | null;
		terrain: TerrainData | null;
	},
): ReactNode {
	const { data, index, roll, terrain } = context;
	const solved = data.solved;
	switch (step.id) {
		case "photo": {
			const taken = new Date(data.photo.takenAt);
			return (
				<>
					{data.photo.fullWidth}×{data.photo.fullHeight}, taken{" "}
					<Value>
						{taken.toLocaleTimeString("en-GB", {
							hour: "2-digit",
							minute: "2-digit",
							timeZone: "Europe/Zurich",
						})}
					</Value>{" "}
					at <Value>{data.gps.lat.toFixed(4)}</Value>,{" "}
					<Value>{data.gps.lon.toFixed(4)}</Value>
				</>
			);
		}
		case "camera-prior":
			return (
				<>
					compass <Value>{degrees(data.sensor.heading)}</Value>, tilt{" "}
					<Value>{degrees(data.sensor.pitch)}</Value>, roll{" "}
					<Value>{degrees(data.sensor.roll)}</Value>, lens{" "}
					<Value>{data.sensor.f35} mm</Value>
				</>
			);
		case "skyline": {
			const traced = data.skyline.rows.filter((row) => row != null).length;
			return (
				<>
					traced in <Value>{traced}</Value> of{" "}
					<Value>{data.skyline.rows.length}</Value> columns;{" "}
					<Value>{data.residual.solved.n}</Value> confident enough to score
				</>
			);
		}
		case "baseline-pipeline":
			return (
				<>
					slide the terrain's skyline onto the photo's: median miss{" "}
					<Value>{data.residual.prior.median.toFixed(1)} px</Value> →{" "}
					<Value>{data.residual.solved.median.toFixed(1)} px</Value>
					{solved.search === "full" ? " (after a full 360° retry)" : ""}
				</>
			);
		case "accept-rule":
			return solved.accepted ? (
				<>
					confidence <Value>{solved.confidence.toFixed(2)}</Value> ·{" "}
					<span className="nb-mark">shown as solved</span>
					{solved.stage === "refine" ? " after a refine pass" : ""}
				</>
			) : (
				<>
					confidence <Value>{solved.confidence.toFixed(2)}</Value> ·{" "}
					<span className="nb-mark">
						refused ({solved.rejectReason ?? "below the bar"})
					</span>
					: never shown as certain
				</>
			);
		case "pose-estimate":
			return solved.accepted ? (
				<>
					yaw <Struck>{degrees(data.prior.yaw)}</Struck>{" "}
					<Value>{degrees(solved.yaw)}</Value> (
					{signedDegrees(solved.delta.yaw)}), pitch{" "}
					<Value>{degrees(solved.pitch)}</Value>, roll{" "}
					<Value>{degrees(solved.roll)}</Value>, field{" "}
					<Value>{degrees(solved.hfov)}</Value>
				</>
			) : (
				<>
					<Struck>
						yaw {degrees(solved.yaw)}, pitch {degrees(solved.pitch)}
					</Struck>{" "}
					stays the sensor guess until a person helps
				</>
			);
		case "tap-a-peak":
			return solved.accepted ? (
				<>not needed here: only when the gate refuses</>
			) : (
				<>
					<span className="nb-mark">needed for this photo</span>: tap one known
					peak for the direction, three for the lens too
				</>
			);
		case "dem-source": {
			const levels = terrain?.levels[data.dem];
			return levels ? (
				<>
					{data.dem} tiles,{" "}
					<Value>{levels.reduce((sum, level) => sum + level.tiles, 0)}</Value>{" "}
					of them at zooms{" "}
					<Value>{levels.map((level) => level.z).join("/")}</Value>;{" "}
					<Value>{levels[0].mPerPx.toFixed(0)} m</Value> pixels near the eye,{" "}
					<Value>{levels[levels.length - 1].mPerPx.toFixed(0)} m</Value> far out
				</>
			) : (
				<>{data.dem} height tiles</>
			);
		}
		case "terrain-sampler":
			return (
				<>
					one question, asked everywhere: the ground under the camera is{" "}
					<Value>{data.gps.ground.toFixed(1)} m</Value>
				</>
			);
		case "eye-rule":
			return (
				<>
					GPS says <Value>{data.gps.alt.toFixed(1)} m</Value> (±
					<Value>{data.gps.hAccuracy.toFixed(0)} m</Value> across); eye ={" "}
					max(GPS, ground + 1.6 m) = <Value>{data.gps.eye.toFixed(1)} m</Value>
				</>
			);
		case "dem-horizon": {
			const yaw = ((solved.yaw % 360) + 360) % 360;
			const sample = data.horizon.profile.reduce((best, entry) =>
				Math.abs(entry.az - yaw) < Math.abs(best.az - yaw) ? entry : best,
			);
			return (
				<>
					<Value>{data.horizon.profile.length}</Value> directions every{" "}
					<Value>{data.horizon.step}°</Value>; straight ahead the skyline is a
					ridge <Value>{(sample.d / 1000).toFixed(1)} km</Value> away
				</>
			);
		}
		case "peak": {
			const visible = data.peaks.filter((peak) => peak.visible).length;
			const labelled = data.peaks.filter((peak) => peak.labelled).length;
			return (
				<>
					<Value>{data.peaks.length}</Value> mapped summits nearby →{" "}
					<Value>{visible}</Value> actually visible → <Value>{labelled}</Value>{" "}
					labelled
				</>
			);
		}
		case "dem-anchoring":
			return (
				<>
					a photo's depth has no scale; the terrain is the ruler that turns it
					into metres
				</>
			);
		case "photo-workspace": {
			const names = data.peaks
				.filter((peak) => peak.labelled)
				.sort((a, b) => a.distance - b.distance)
				.slice(0, 4)
				.map((peak) => peak.name);
			return (
				<>
					names{" "}
					<Value>{data.peaks.filter((peak) => peak.labelled).length}</Value>{" "}
					peaks: {names.join(", ")}…
				</>
			);
		}
		case "camera-roll":
			return roll ? (
				<>
					<Value>{roll.rows.length}</Value> photos, one viewpoint (within{" "}
					<Value>{roll.viewpointRadiusM} m</Value>), over{" "}
					<Value>{Math.round(roll.spanS / 60)} min</Value>;{" "}
					{index
						? `${index.photos.filter((photo) => photo.accepted).length} posed`
						: ""}
				</>
			) : (
				<>a day of photos becomes a place</>
			);
		case "step-inside":
			return (
				<>
					walk into the photo: near ground rebuilt from the image, far mountains
					from the DEM
				</>
			);
		default:
			return null;
	}
}

export interface NotebookContext {
	data: GipfelbuchPhotoData | null;
	index: GipfelbuchIndex | null;
	roll: RollData | null;
	terrain: TerrainData | null;
}

/** Everything a step note reads, for the photo selected anywhere in the Gipfelbuch. */
export function useNotebookContext(): NotebookContext {
	const [photoId] = useNotebookPhoto();
	const index = useGipfelbuchIndex();
	const loaded = useGipfelbuchPhoto(photoId);
	// Keep showing the previous photo while the next one loads, so the page does not collapse.
	const [data, setData] = useState<GipfelbuchPhotoData | null>(null);
	useEffect(() => {
		if (loaded) setData(loaded);
	}, [loaded]);
	const roll = useStaticJson<RollData>(
		"/demo/gipfelbuch/camera-roll/roll.json",
	);
	const terrain = useStaticJson<TerrainData>(
		"/demo/gipfelbuch/terrain/terrain.json",
	);
	return { data, index, roll, terrain };
}

/** The measured note for one step, or an ellipsis while the photo loads. */
export function noteFor(
	step: NotebookStep,
	context: NotebookContext,
): ReactNode {
	const { data, index, roll, terrain } = context;
	return data ? stepNote(step, { data, index, roll, terrain }) : "…";
}
