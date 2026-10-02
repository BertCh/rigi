// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type RefObject, useEffect, useState } from "react";
import { publicUrl } from "#/lib/public-url";

/** Baked by scripts/gipfelbuch/data-sheet.ts. Coordinates are integer sheet units (y down). */
export interface SheetData {
	width: number;
	height: number;
	bbox: { west: number; east: number; south: number; north: number };
	lv95: Record<"sw" | "ne" | "nw" | "se", [number, number]>;
	interval: number;
	indexInterval: number;
	relief: {
		src: string;
		/** Sun-tone and cool-shade masks (greyscale, luminance = strength). */
		sun: string;
		shade: string;
		/** Elevation over the land normalised 0..255 (lake 0), low resolution; tintRange is its metre range. */
		tint?: string;
		tintRange?: [number, number];
		source: string;
		width: number;
		height: number;
	};
	/** URL of the rock hachure and scree layers (rock.json). */
	rock: string;
	contours: {
		/**
		 * Tanaka runs merged per class: m = earth minor, i = earth index, r = rock index (LK: minor contours stop at
		 * rock); the digit is 0 lit, 1 middle, 2 shaded against the NW light.
		 */
		runs: Record<SheetContourKey, string>;
		labels: { ele: number; d: string }[];
	};
	lake: { name: string; level: number; d: string; label: [number, number] };
	peaks: { name: string; ele: number; x: number; y: number }[];
	places: {
		name: string;
		x: number;
		y: number;
		ele: number | null;
		cls: string;
	}[];
	viewpoints: {
		id: string;
		x: number;
		y: number;
		lat: number;
		lon: number;
		yaw: number;
		hfov: number;
		solved: boolean;
	}[];
	credit: string;
}

export type SheetContourKey =
	| "m0"
	| "m1"
	| "m2"
	| "i0"
	| "i1"
	| "i2"
	| "r0"
	| "r1"
	| "r2";

/** Rock hachures (tier 0 lit .. 3 shaded) and scree dots (tier 0 .. 2) as integer paths in quarter sheet units. */
export interface SheetRock {
	quantum: number;
	hachures: string[];
	scree: string[];
}

export const SHEET_URL = publicUrl("/demo/gipfelbuch/sheet/sheet.json");
/** Aspect of the baked sheet, used for loading placeholders so nothing shifts. */
export const SHEET_ASPECT = 2400 / 1640;

let pending: Promise<SheetData> | undefined;
function fetchSheet(): Promise<SheetData> {
	if (!pending) {
		pending = fetch(SHEET_URL).then((response) => {
			if (!response.ok) throw new Error(`sheet.json ${response.status}`);
			return response.json() as Promise<SheetData>;
		});
		// Allow a retry on the next mount after a failure.
		pending.catch(() => {
			pending = undefined;
		});
	}
	return pending;
}

export type SheetState =
	| { status: "loading"; sheet?: undefined }
	| { status: "error"; sheet?: undefined }
	| { status: "ready"; sheet: SheetData };

/** Shared, module-cached fetch of the baked map sheet. */
export function useSheet(): SheetState {
	const [state, setState] = useState<SheetState>({ status: "loading" });
	useEffect(() => {
		let live = true;
		fetchSheet().then(
			(sheet) => live && setState({ status: "ready", sheet }),
			() => live && setState({ status: "error" }),
		);
		return () => {
			live = false;
		};
	}, []);
	return state;
}

let pendingRock: Promise<SheetRock> | undefined;
/** Loads the baked rock hachures and scree once `url` is known; undefined until then (and on failure). */
export function useSheetRock(url: string | undefined): SheetRock | undefined {
	const [rock, setRock] = useState<SheetRock>();
	useEffect(() => {
		if (!url) return;
		let live = true;
		pendingRock ??= fetch(url).then((response) => {
			if (!response.ok) throw new Error(`rock.json ${response.status}`);
			return response.json() as Promise<SheetRock>;
		});
		pendingRock.then(
			(value) => live && setRock(value),
			() => {
				pendingRock = undefined;
			},
		);
		return () => {
			live = false;
		};
	}, [url]);
	return rock;
}

/** Rendered CSS width of an element, kept in state (for labels with a minimum on-screen size). */
export function useElementWidth(ref: RefObject<Element | null>, initial = 800) {
	const [width, setWidth] = useState(initial);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		setWidth(el.getBoundingClientRect().width || initial);
		const observer = new ResizeObserver((entries) => {
			const next = entries[0]?.contentRect.width;
			if (next) setWidth(next);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [ref, initial]);
	return width;
}
