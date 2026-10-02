// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Display tables for the terroir pack: land-cover classes (label, natural colour, contour ink) and
// name classes (typography, reach, priority). One place so the legend, the labels, the place card
// and the shaders agree. Colours are sRGB hex; contour inks follow the Swiss three-colour rule
// (brown on soil, black on rock, blue on ice and water).
import { COVER_INK } from "../style/palette";
import type { CoverClassId, NameClass } from "./types";

export type ContourInk = "soil" | "rock" | "ice";

export type CoverClassInfo = {
	id: CoverClassId;
	key: string;
	label: string;
	/** natural-colour tint for Blend / In map (Patterson-style, muted) */
	color: `#${string}`;
	ink: ContourInk;
};

export const COVER_CLASSES: readonly CoverClassInfo[] = [
	{ id: 0, key: "none", label: "No data", color: "#000000", ink: "soil" },
	{ id: 1, key: "glacier", label: "Glacier", color: "#e6eef4", ink: "ice" },
	{ id: 2, key: "firn", label: "Firn / snow", color: "#f4f6f7", ink: "ice" },
	{ id: 3, key: "rock", label: "Bare rock", color: "#a39a8f", ink: "rock" },
	{ id: 4, key: "scree", label: "Scree", color: "#bdb4a6", ink: "rock" },
	{
		id: 5,
		key: "conifer",
		label: "Conifer forest",
		color: "#4f6a4a",
		ink: "soil",
	},
	{
		id: 6,
		key: "broadleaf",
		label: "Broadleaf / mixed forest",
		color: "#6b7f4c",
		ink: "soil",
	},
	{
		id: 7,
		key: "shrub",
		label: "Shrub / dwarf pine",
		color: "#7d8a5a",
		ink: "soil",
	},
	{
		id: 8,
		key: "pasture",
		label: "Alpine pasture",
		color: "#a9b277",
		ink: "soil",
	},
	{
		id: 9,
		key: "meadow",
		label: "Meadow / farmland",
		color: "#b7c08a",
		ink: "soil",
	},
	{ id: 10, key: "vineyard", label: "Vineyard", color: "#a88a5c", ink: "soil" },
	{ id: 11, key: "orchard", label: "Orchard", color: "#9aa866", ink: "soil" },
	{ id: 12, key: "water", label: "Water", color: "#7fa3b8", ink: "ice" },
	{ id: 13, key: "built", label: "Built-up", color: "#b9aaa0", ink: "soil" },
	{ id: 14, key: "wetland", label: "Wetland", color: "#8fa58f", ink: "soil" },
];

export const coverInfo = (id: number): CoverClassInfo =>
	COVER_CLASSES[id] ?? COVER_CLASSES[0];

/** Contour ink colours (sRGB) per the Swiss national map convention (style/palette.ts COVER_INK). */
export const CONTOUR_INK: Record<ContourInk, `#${string}`> = COVER_INK;

export type NameTypography = {
	/** relative size to the base label px */
	size: number;
	weight: number;
	italic: boolean;
	/** letter-spacing in em (spaced caps for massifs and regions) */
	tracking: number;
	upper: boolean;
	color: `#${string}`;
	/** max distance (m) at which the class is labelled under reach 'near' (Infinity = any) */
	nearReachM: number;
	/** placement priority, higher first */
	priority: number;
};

const WATER = "#bfe3ff";
const LAND = "#ffffff";
const SOFT = "#efe6d6";

export const NAME_TYPO: Record<NameClass, NameTypography> = {
	"peak-major": {
		size: 1.25,
		weight: 700,
		italic: false,
		tracking: 0,
		upper: false,
		color: LAND,
		nearReachM: Infinity,
		priority: 100,
	},
	peak: {
		size: 1.0,
		weight: 600,
		italic: false,
		tracking: 0,
		upper: false,
		color: LAND,
		nearReachM: Infinity,
		priority: 80,
	},
	"peak-minor": {
		size: 0.86,
		weight: 500,
		italic: false,
		tracking: 0,
		upper: false,
		color: LAND,
		nearReachM: 15000,
		priority: 50,
	},
	massif: {
		size: 0.95,
		weight: 600,
		italic: false,
		tracking: 0.22,
		upper: true,
		color: SOFT,
		nearReachM: Infinity,
		priority: 70,
	},
	region: {
		size: 0.9,
		weight: 500,
		italic: false,
		tracking: 0.24,
		upper: true,
		color: SOFT,
		nearReachM: Infinity,
		priority: 45,
	},
	ridge: {
		size: 0.82,
		weight: 500,
		italic: false,
		tracking: 0.16,
		upper: true,
		color: SOFT,
		nearReachM: 20000,
		priority: 40,
	},
	valley: {
		size: 0.86,
		weight: 500,
		italic: true,
		tracking: 0.12,
		upper: false,
		color: SOFT,
		nearReachM: 25000,
		priority: 42,
	},
	pass: {
		size: 0.86,
		weight: 500,
		italic: false,
		tracking: 0,
		upper: false,
		color: LAND,
		nearReachM: 25000,
		priority: 55,
	},
	glacier: {
		size: 0.9,
		weight: 500,
		italic: true,
		tracking: 0.14,
		upper: false,
		color: WATER,
		nearReachM: Infinity,
		priority: 65,
	},
	lake: {
		size: 1.05,
		weight: 500,
		italic: true,
		tracking: 0.04,
		upper: false,
		color: WATER,
		nearReachM: Infinity,
		priority: 90,
	},
	river: {
		size: 0.82,
		weight: 500,
		italic: true,
		tracking: 0.08,
		upper: false,
		color: WATER,
		nearReachM: 15000,
		priority: 35,
	},
	waterfall: {
		size: 0.78,
		weight: 500,
		italic: true,
		tracking: 0,
		upper: false,
		color: WATER,
		nearReachM: 6000,
		priority: 25,
	},
	city: {
		size: 1.05,
		weight: 600,
		italic: false,
		tracking: 0.02,
		upper: false,
		color: LAND,
		nearReachM: Infinity,
		priority: 85,
	},
	town: {
		size: 0.95,
		weight: 600,
		italic: false,
		tracking: 0,
		upper: false,
		color: LAND,
		nearReachM: 40000,
		priority: 60,
	},
	village: {
		size: 0.86,
		weight: 500,
		italic: false,
		tracking: 0,
		upper: false,
		color: LAND,
		nearReachM: 20000,
		priority: 48,
	},
	hamlet: {
		size: 0.78,
		weight: 500,
		italic: false,
		tracking: 0,
		upper: false,
		color: LAND,
		nearReachM: 6000,
		priority: 20,
	},
	alp: {
		size: 0.78,
		weight: 500,
		italic: true,
		tracking: 0,
		upper: false,
		color: SOFT,
		nearReachM: 6000,
		priority: 22,
	},
	hut: {
		size: 0.78,
		weight: 600,
		italic: false,
		tracking: 0,
		upper: false,
		color: LAND,
		nearReachM: 12000,
		priority: 30,
	},
	field: {
		size: 0.74,
		weight: 400,
		italic: true,
		tracking: 0,
		upper: false,
		color: SOFT,
		nearReachM: 3000,
		priority: 10,
	},
	lift: {
		size: 0.74,
		weight: 500,
		italic: false,
		tracking: 0,
		upper: false,
		color: SOFT,
		nearReachM: 5000,
		priority: 12,
	},
	other: {
		size: 0.74,
		weight: 400,
		italic: false,
		tracking: 0,
		upper: false,
		color: SOFT,
		nearReachM: 3000,
		priority: 5,
	},
};

/** Peak class from prominence (m) with an elevation fallback when prominence is unknown. */
export function peakTier(
	prominence: number | null | undefined,
	ele: number | null,
): NameClass {
	if (prominence != null && Number.isFinite(prominence)) {
		if (prominence >= 600) return "peak-major";
		if (prominence >= 150) return "peak";
		return "peak-minor";
	}
	if (ele != null && ele >= 3900) return "peak-major";
	return "peak";
}
