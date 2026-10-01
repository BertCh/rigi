// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Light of the day behind the roll scrubber's time track (terroir T3.4): a thin band coloured by
// the sun's elevation at the roll's location (night navy, blue hour, golden hour amber, pale day),
// sunrise / sunset / solar-noon ticks where they fall inside the span, and readable labels on the
// compressed breaks ("2 h"). Mounted inside TimeScrubber's track; purely additive, pointer-events
// none except the tick tooltips.
import { useMemo } from "react";
import { sunPosition } from "../../look/sun";
import type { RollPhoto } from "../../roll/types";
import { lightPhase, sunBandColor, sunEvents } from "./logic";

const SAMPLES = 240;

type Props = {
	photos: RollPhoto[];
	/** Compressed axis position (s) of each photo, as TimeScrubber's `pos`. */
	pos: number[];
	total: number;
	/** The cap above which a gap is compressed (s). */
	gapCap: number;
	lat: number;
	lon: number;
};

const fmtGap = (s: number) =>
	s >= 86400 ? `${Math.round(s / 86400)} d` : `${Math.round(s / 3600)} h`;

function offsetMin(tz: string | null | undefined) {
	const m = tz?.match(/([+-])(\d\d):(\d\d)/);
	return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

const KIND_COLOR = {
	sunrise: "#ffd27a",
	sunset: "#ff9a6a",
	noon: "#ffffff",
} as const;
const KIND_LABEL = {
	sunrise: "Sunrise",
	sunset: "Sunset",
	noon: "Solar noon",
} as const;

export function LightBand({ photos, pos, total, gapCap, lat, lon }: Props) {
	const model = useMemo(() => {
		if (photos.length < 2 || !total || !Number.isFinite(lat)) return null;
		const ms = photos.map((p) => Date.parse(p.meta.takenAt));
		if (ms.some((m) => !Number.isFinite(m))) return null;
		const off = offsetMin(photos[0].meta.tzOffset);
		const fr: number[] = [];
		const el: number[] = [];
		const tm: number[] = [];
		let seg = 1;
		for (let k = 0; k <= SAMPLES; k++) {
			const f = k / SAMPLES;
			const x = f * total;
			while (seg < pos.length - 1 && pos[seg] < x) seg++;
			const span = pos[seg] - pos[seg - 1];
			const u =
				span > 0 ? Math.min(1, Math.max(0, (x - pos[seg - 1]) / span)) : 0;
			const t = ms[seg - 1] + (ms[seg] - ms[seg - 1]) * u;
			fr.push(f);
			tm.push(t);
			el.push(sunPosition(new Date(t), lat, lon).elevation);
		}
		const stops = fr
			.map((f, k) => {
				const [r, g, b] = sunBandColor(el[k]);
				return `rgb(${r} ${g} ${b}) ${(f * 100).toFixed(2)}%`;
			})
			.join(",");
		const fmtT = (t: number) =>
			new Date(t + off * 60000).toLocaleTimeString(undefined, {
				hour: "2-digit",
				minute: "2-digit",
				timeZone: "UTC",
			});
		const events = sunEvents(el, fr).map((e) => {
			const k = Math.min(SAMPLES, Math.round(e.at * SAMPLES));
			return {
				...e,
				label: `${KIND_LABEL[e.kind]} ≈ ${fmtT(tm[k])} (local, computed from the roll's position)`,
			};
		});
		const gaps = photos
			.map((p, i) => ({ i, gap: i ? Math.max(0, p.t - photos[i - 1].t) : 0 }))
			.filter((g) => g.gap > gapCap)
			.map((g) => ({
				from: pos[g.i - 1] / total,
				to: pos[g.i] / total,
				gap: g.gap,
			}));
		const lo = Math.min(...el);
		const hi = Math.max(...el);
		const phases = [...new Set(el.map(lightPhase))];
		return { stops, events, gaps, lo, hi, phases };
	}, [photos, pos, total, gapCap, lat, lon]);

	if (!model) return null;
	const title = `Light of the day: sun ${Math.round(model.lo)}° to ${Math.round(model.hi)}° (${model.phases.join(", ")}). Navy night, blue hour, amber golden hour, pale day. Hatched = compressed break.`;
	return (
		<>
			<div
				className="pointer-events-none absolute inset-x-0 top-[11px] h-[10px] overflow-hidden rounded-[3px] opacity-80"
				style={{ background: `linear-gradient(to right, ${model.stops})` }}
				title={title}
				data-testid="roll-lightband"
				aria-hidden="true"
			>
				{model.gaps.map((g) => (
					<span
						key={g.from}
						className="absolute inset-y-0"
						style={{
							left: `${g.from * 100}%`,
							width: `${(g.to - g.from) * 100}%`,
							backgroundImage:
								"repeating-linear-gradient(135deg, rgba(10,14,24,0.55) 0 2px, transparent 2px 5px)",
						}}
					/>
				))}
			</div>
			{model.events.map((e) => (
				<span
					key={`${e.kind}${e.at}`}
					className="absolute top-[9px] h-[14px] w-[3px] -translate-x-1/2 cursor-help"
					style={{ left: `${e.at * 100}%` }}
					title={e.label}
				>
					<span
						className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2"
						style={{ background: KIND_COLOR[e.kind] }}
					/>
				</span>
			))}
			{model.gaps.map((g) => (
				<span
					key={`gap${g.from}`}
					className="pointer-events-none absolute -top-1.5 -translate-x-1/2 font-mono text-[10px] leading-none text-white/65"
					style={{ left: `${((g.from + g.to) / 2) * 100}%` }}
				>
					{fmtGap(g.gap)}
				</span>
			))}
		</>
	);
}
