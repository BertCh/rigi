// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	ContourSymbol,
	type LegendItem,
	PeakSymbol,
	RockSymbol,
	RouteSymbol,
	TrigPointSymbol,
	ViewpointSymbol,
	WaterSymbol,
} from "./swiss";

// F1: a page's legend lists only the symbols that page draws. A page's symbols are declared here by
// concept id; a concept with no entry shows no legend.

export type LegendKey =
	| "contour"
	| "water"
	| "route"
	| "peak"
	| "trig"
	| "viewpoint"
	| "rock";

const LEGEND_SYMBOLS: Record<LegendKey, LegendItem> = {
	contour: { symbol: <ContourSymbol />, label: "Contour: terrain height" },
	water: { symbol: <WaterSymbol />, label: "Water: lakes and rivers" },
	route: { symbol: <RouteSymbol />, label: "Route: solved camera" },
	peak: { symbol: <PeakSymbol />, label: "Spot height: peak" },
	trig: {
		symbol: <TrigPointSymbol />,
		label: "Station: known camera position",
	},
	viewpoint: {
		symbol: <ViewpointSymbol />,
		label: "Viewpoint: photo camera",
	},
	rock: { symbol: <RockSymbol />, label: "Rock: skyline" },
};

/** Symbols drawn on each concept's page. */
export const LEGEND_BY_CONCEPT: Record<string, LegendKey[]> = {
	rigi: ["rock", "peak"],
	"viewport-inference": ["rock", "peak"],
	"terrain-snapping": ["peak", "viewpoint"],
	photo: ["viewpoint", "rock"],
	skyline: ["rock"],
	"accept-rule": ["rock", "route"],
	"pose-estimate": ["rock", "peak"],
	"tap-a-peak": ["peak", "rock"],
	"dem-source": [],
	"dem-horizon": ["contour", "rock"],
	"eye-rule": ["viewpoint", "contour"],
	peak: ["peak", "rock"],
	"dem-anchoring": ["contour", "peak"],
	"photo-workspace": ["rock", "route", "peak"],
	"camera-roll": ["viewpoint", "rock"],
	"step-inside": ["viewpoint", "contour"],
};

export const legendItemsFor = (keys: LegendKey[] | undefined): LegendItem[] =>
	(keys ?? []).map((key) => LEGEND_SYMBOLS[key]);
