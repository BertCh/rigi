// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Small hand-made pack for node checks (not served). Around Niederhorn / Thunersee.
import { makeGrid } from "../pack";
import type { TerroirPack } from "../types";

export const FIXTURE_PACK: TerroirPack = {
	v: 1,
	id: "fixture",
	name: "Fixture",
	bbox: [7.6, 46.6, 7.9, 46.8],
	created: "2026-09-30",
	sources: [
		{
			id: "x",
			label: "x",
			licence: "x",
			url: "",
			credit: "© swisstopo (fixture)",
		},
	],
	names: [
		{
			name: "Niederhorn",
			cls: "peak",
			lat: 46.7,
			lon: 7.77,
			ele: 1963,
			lang: "de",
			status: "official",
			src: "swissnames3d",
		},
		{
			name: "Thunersee",
			cls: "lake",
			lat: 46.69,
			lon: 7.7,
			ele: 558,
			lang: "de",
			status: "official",
			src: "swissnames3d",
		},
	],
	glaciers: [
		{
			year: 1850,
			source: "fixture",
			polygons: [
				[
					[
						[7.7, 46.7],
						[7.72, 46.7],
						[7.72, 46.72],
						[7.7, 46.72],
						[7.7, 46.7],
					],
				],
			],
			heights: [[[2000, 2010, 2020, 2030, 2000]]],
		},
		{ year: 2023, source: "fixture", polygons: [], heights: [] },
	],
	cover: null,
	lithology: [
		{
			label: "Limestone",
			cls: "limestone",
			polygons: [
				[
					[
						[7.6, 46.6],
						[7.9, 46.6],
						[7.9, 46.8],
						[7.6, 46.8],
						[7.6, 46.6],
					],
				],
			],
		},
	],
};

/** 4×4 cover grid over the fixture bbox: row 0 = north. */
export const FIXTURE_COVER = makeGrid(
	FIXTURE_PACK.bbox,
	4,
	4,
	new Uint8Array([5, 5, 8, 3, 5, 12, 8, 3, 9, 12, 8, 1, 9, 9, 13, 1]),
);
