// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Loaders for the baked JSON in this folder (see scripts/bake-data.mjs). Each returns an empty
// list when the file is missing or malformed: the map still draws, just without that layer.

import type {Peak, SacScale, Station, TrailWay} from '../types';

async function fetchRows<T>(url: URL, key: string): Promise<T[]> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return [];
    }
    const rows = ((await response.json()) as Record<string, unknown>)[key];
    return Array.isArray(rows) ? (rows as T[]) : [];
  } catch {
    return [];
  }
}

/** The 12 photos of the roll as geometry only, in time order. */
export function loadStations(): Promise<Station[]> {
  return fetchRows<Station>(new URL('./stations.json', import.meta.url), 'stations');
}

/** OSM summits around the Niederhorn, highest first. */
export function loadPeaks(): Promise<Peak[]> {
  return fetchRows<Peak>(new URL('./peaks-niederhorn.json', import.meta.url), 'peaks');
}

/** OSM graded hiking paths inside `NIEDERHORN_BBOX`. */
export async function loadTrails(): Promise<TrailWay[]> {
  const ways = await fetchRows<Partial<TrailWay>>(
    new URL('./trails-niederhorn.json', import.meta.url),
    'trails'
  );
  // The bake omits absent names to save bytes.
  return ways.map(way => ({
    id: way.id as string,
    name: way.name ?? null,
    sac: (way.sac ?? null) as SacScale,
    coords: way.coords as [number, number][]
  }));
}
