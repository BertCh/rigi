// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// View settings and the small shared engine types, free of any engine so that the UI and the engines
// can all import them.

export type ViewMode = "overlay" | "replace" | "world";

export type BlendMethod = "swipe" | "lens" | "range" | "brush";

export type Settings = {
	mode: ViewMode;
	// overlay
	overlayStyle: "contours" | "bands" | "slope" | "none";
	contourInterval: number;
	layerOpacity: number;
	ridges: number;
	depthTint: number;
	trails: boolean;
	// replace
	mapStyle: "satellite" | "topo" | "hillshade" | "bands";
	method: BlendMethod;
	swipe: number;
	lens: [number, number];
	lensR: number;
	rangeKm: number;
	keepSky: boolean;
	feather: number;
	// world
	projectOpacity: number;
	minProjectRange: number;
	worldStyle: "satellite" | "topo" | "hillshade";
	protectPeople: boolean;
	/** fade overlay terrain closer than this (m); unreliable within the GPS error */
	nearFade: number;
};

export const defaultSettings: Settings = {
	mode: "overlay",
	overlayStyle: "contours",
	contourInterval: 50,
	layerOpacity: 0.9,
	ridges: 0.8,
	depthTint: 0,
	// off by default: uploads fetch their paths from Overpass only when switched on
	trails: false,
	mapStyle: "satellite",
	method: "lens",
	swipe: 0.5,
	lens: [0.5, 0.4],
	lensR: 0.18,
	rangeKm: 3,
	keepSky: true,
	feather: 0.03,
	projectOpacity: 1,
	minProjectRange: 80,
	worldStyle: "satellite",
	protectPeople: true,
	nearFade: 60,
};

export type PeakLabel = {
	name: string;
	ele: number | null;
	/** OSM prominence (m), null if unknown */
	prominence?: number | null;
	u: number;
	v: number;
	distKm: number;
	rank: number;
	visible: boolean;
	world: [number, number, number];
};

export type Sample = {
	lat: number;
	lon: number;
	h: number;
	range: number;
	world: [number, number, number];
};
