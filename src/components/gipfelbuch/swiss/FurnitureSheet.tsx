// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { SketchDefs } from "../notebook/Ink";
import {
	Cartouche,
	ContourSymbol,
	GlacierSymbol,
	Grade,
	HachureRule,
	HutBullet,
	Legend,
	PeakSymbol,
	RegisterLine,
	RockSymbol,
	RouteSymbol,
	ScaleBar,
	SheetFrame,
	Signpost,
	SpotHeight,
	Standortfeld,
	StationStamp,
	TestimonyLine,
	TrigPoint,
	TrigPointSymbol,
	ViewpointSymbol,
	WaterSymbol,
	Waymark,
} from "./index";

/** Renders every swiss furniture component once, for screenshots. */
export function FurnitureSheet() {
	return (
		<>
			<SketchDefs />
			<SheetFrame
				sheet="07"
				total="19"
				title="Niederhorn"
				corners={{ east: "2627000", north: "1171000" }}
				imprint="Rigi Gipfelbuch · Blatt 07 · Daten © swisstopo, Mapterhorn"
				stand="2026-10"
				edition="2026"
				crossRefs={{ prev: "← 06", next: "08 →" }}
			>
				<div className="flex flex-col gap-8 p-6 sm:p-10">
					<Cartouche
						kicker="Topographisches Gipfelbuch der Rigi"
						title="Gipfelbuch"
						subtitle="A register of the ideas behind the app"
						edition="Ausgabe 2026 · LV95 · 1 : 25 000"
					/>
					<HachureRule />
					<div className="flex flex-wrap gap-4">
						<Waymark variant="hike">Live</Waymark>
						<Waymark variant="mountain">Flagged</Waymark>
						<Waymark variant="alpine">Research</Waymark>
						<Waymark variant="closed">Killed</Waymark>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<Signpost
							direction="prev"
							kicker="Vorher"
							title="Horizon"
							subtitle="ca. 4 min"
						/>
						<Signpost
							direction="next"
							kicker="Weiter"
							title="Pose solver"
							subtitle="ca. 6 min"
						/>
					</div>
					<div className="flex flex-wrap items-center gap-6">
						<SpotHeight value="1963" />
						<SpotHeight value="1950" unit="m" />
						<TrigPoint />
						<TrigPoint size={12} filled />
						<span className="inline-flex items-center gap-1">
							<HutBullet /> <span className="text-[13px]">Hut</span>
						</span>
						<span className="inline-flex items-center gap-1">
							<HutBullet current /> <span className="text-[13px]">Current</span>
						</span>
						<Grade>T3</Grade>
						<Grade>WS</Grade>
						<StationStamp
							place="Niederhorn"
							date="26-09-14"
							seed="niederhorn"
						/>
					</div>
					<div className="flex flex-col gap-3">
						<Standortfeld place="Niederhorn" altitude={1963} />
						<RegisterLine
							items={[
								{ value: "2026-09-14 · 10:42" },
								{ value: "2 627 000 / 1 171 000" },
								{ value: "horizon match" },
								{ value: "haze 0.31 · f 27 mm" },
								{ value: "accepted" },
							]}
						/>
						<TestimonyLine
							date="2026-09-14"
							check="horizon fit"
							verdict="pass"
							signer="R.C."
							remark="clear view, ridge matched"
						/>
					</div>
					<ScaleBar metresPerPixel={12.5} label="Specimen: 12.5 m per pixel" />
					<Legend
						items={[
							{ symbol: <ContourSymbol />, label: "Höhenkurve · Contour" },
							{ symbol: <WaterSymbol />, label: "Gewässer · Water" },
							{ symbol: <RouteSymbol />, label: "Route" },
							{ symbol: <PeakSymbol />, label: "Kote · Spot height" },
							{ symbol: <TrigPointSymbol />, label: "Station · Trig point" },
							{
								symbol: <ViewpointSymbol />,
								label: "Aussichtspunkt · Viewpoint",
							},
							{ symbol: <RockSymbol />, label: "Fels · Rock" },
							{ symbol: <GlacierSymbol />, label: "Gletscher · Glacier" },
						]}
					/>
				</div>
			</SheetFrame>
		</>
	);
}
