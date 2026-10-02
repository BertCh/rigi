// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useEffect, useState } from "react";
import type { GipfelbuchPhotoId } from "../viz/real";
import type { TafelCamera } from "./project";

// The bake JSON written by scripts/gipfelbuch/data-tafel.ts (public/demo/gipfelbuch/tafel).
export interface TafelBake {
	id: GipfelbuchPhotoId;
	generated: string;
	script: "scripts/gipfelbuch/data-tafel.ts";
	/** White strokes, coverage in alpha, transparent elsewhere. */
	src: string;
	width: number;
	height: number;
	/** Where the full working-frame photo (800 x h) sits in the canvas, as fractions. */
	photo: { x: number; y: number; w: number; h: number };
	camera: TafelCamera & { source: "solved" | "app" };
	/** Suggested photo band, working rows [top, bottom]. */
	band: [number, number];
	ticks: { az: number; x: number; label?: string; cardinal?: boolean }[];
	peaks: {
		name: string;
		ele: number;
		km: number;
		az: number;
		x: number;
		y: number;
	}[];
	minContrast: number;
}

const cache = new Map<string, Promise<TafelBake | null>>();
function loadBake(id: string): Promise<TafelBake | null> {
	let p = cache.get(id);
	if (!p) {
		p = fetch(`/demo/gipfelbuch/tafel/${id}.json`)
			.then((r) => {
				if (!r.ok) return null;
				// a dev server answers a missing file with index.html
				if (!(r.headers.get("content-type") ?? "").includes("json"))
					return null;
				return r.json() as Promise<TafelBake>;
			})
			.catch(() => null);
		cache.set(id, p);
	}
	return p;
}

/** The Tafel bake for a photo: null while loading, with no id, or when the file is missing. */
export function useTafelBake(id: GipfelbuchPhotoId | null): TafelBake | null {
	const [bake, setBake] = useState<TafelBake | null>(null);
	useEffect(() => {
		setBake(null);
		if (!id) return;
		let live = true;
		loadBake(id).then((b) => live && setBake(b));
		return () => {
			live = false;
		};
	}, [id]);
	return bake;
}
