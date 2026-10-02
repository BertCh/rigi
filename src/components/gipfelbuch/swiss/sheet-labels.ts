// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Label layout for SheetMap (design book N1 to N8): towns, then summits by height, each placed up and to the right of
 * its point, skipped when it would collide with a more important label. Sizes have a minimum on-screen size, so on a
 * phone fewer labels fit but none shrinks below readable.
 */
import type { SheetData } from "./useSheet";

export interface LabelBox {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}
const overlaps = (a: LabelBox, b: LabelBox) =>
	a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

export interface SheetLabelSizes {
	peak: number;
	spot: number;
	place: number;
	lake: number;
	contour: number;
	credit: number;
}

/** Sheet-unit font sizes with a floor in on-screen pixels (`scale` is rendered px per sheet unit). */
export function labelSizes(scale: number): SheetLabelSizes {
	const f = (units: number, floorPx: number) =>
		Math.max(units, floorPx / scale);
	return {
		peak: f(28, 11),
		spot: f(20, 10),
		place: f(22, 10.5),
		lake: f(62, 14),
		contour: f(17, 9),
		credit: f(17, 9),
	};
}

export interface PlacedPeak {
	name: string;
	ele: number;
	x: number;
	y: number;
	flip: boolean;
}
export interface PlacedPlace {
	name: string;
	x: number;
	y: number;
}

export function layoutLabels(sheet: SheetData, sizes: SheetLabelSizes) {
	const taken: LabelBox[] = [];
	const lakeWidth = sheet.lake.name.length * sizes.lake * 0.95;
	taken.push({
		x0: sheet.lake.label[0] - lakeWidth / 2,
		x1: sheet.lake.label[0] + lakeWidth / 2,
		y0: sheet.lake.label[1] - sizes.lake,
		y1: sheet.lake.label[1] + sizes.lake * 0.3,
	});
	const tryPlace = (box: LabelBox) => {
		if (box.x0 < 8 || box.x1 > sheet.width - 8) return false;
		if (box.y0 < 8 || box.y1 > sheet.height - 8) return false;
		if (taken.some((t) => overlaps(t, box))) return false;
		taken.push(box);
		return true;
	};
	const places: PlacedPlace[] = [];
	const towns = [...sheet.places].sort(
		(a, b) => (a.cls === "town" ? 0 : 1) - (b.cls === "town" ? 0 : 1),
	);
	for (const p of towns) {
		const w = p.name.length * sizes.place * 0.62;
		if (
			tryPlace({
				x0: p.x - 8,
				x1: p.x + 14 + w,
				y0: p.y - sizes.place,
				y1: p.y + 10,
			})
		)
			places.push(p);
	}
	const peaks: PlacedPeak[] = [];
	const ordered = [...sheet.peaks].sort((a, b) => b.ele - a.ele);
	for (const p of ordered) {
		const flipDefault = p.x > sheet.width - 360;
		const w = Math.max(
			p.name.length * sizes.peak * 0.64,
			String(p.ele).length * sizes.spot * 0.6,
		);
		for (const flip of [flipDefault, !flipDefault]) {
			const box: LabelBox = flip
				? {
						x0: p.x - 16 - w,
						x1: p.x + 10,
						y0: p.y - 8 - sizes.peak,
						y1: p.y - 8 + sizes.spot * 1.25,
					}
				: {
						x0: p.x - 10,
						x1: p.x + 16 + w,
						y0: p.y - 8 - sizes.peak,
						y1: p.y - 8 + sizes.spot * 1.25,
					};
			if (tryPlace(box)) {
				peaks.push({ ...p, flip });
				break;
			}
		}
	}
	return { peaks, places };
}
