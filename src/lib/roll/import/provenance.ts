// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Where an imported photo's position came from, when it was not EXIF GPS. LocalPhotoMeta only
// knows 'exif' | 'pin', so interpolation provenance lives here (localStorage, per photo id).

import { storageKey } from "#/lib/ontology/core/storage";
import type { EstimatedPosition } from "./interpolate";

export type PositionProvenance = {
	method: "interpolated" | "nearest" | "pin";
	accuracyM: number | null;
	/** Photo ids the estimate came from (interpolated / nearest). */
	from: string[];
	gapS: number | null;
	/** Unix ms. */
	at: number;
};

const KEY = (id: string) => storageKey("importPosition", id);

export function loadProvenance(id: string): PositionProvenance | null {
	try {
		const raw =
			typeof localStorage === "undefined"
				? null
				: localStorage.getItem(KEY(id));
		return raw ? (JSON.parse(raw) as PositionProvenance) : null;
	} catch {
		return null;
	}
}

export function saveProvenance(id: string, p: PositionProvenance | null) {
	try {
		if (p) localStorage.setItem(KEY(id), JSON.stringify(p));
		else localStorage.removeItem(KEY(id));
	} catch {
		// storage unavailable: provenance just isn't kept
	}
}

export const provenanceFromEstimate = (
	e: EstimatedPosition,
): PositionProvenance => ({
	method: e.method,
	accuracyM: e.accuracyM,
	from: e.from,
	gapS: e.gapS,
	at: Date.now(),
});
