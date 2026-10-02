// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Roll building at camera-roll scale: the same rolls, viewpoints and capture order as roll.ts
// (clusterPhotos, groupViewpoints, makeRoll, uploadRolls), from a spatial index instead of O(n^2)
// loops and Array.sort. See neighbours.ts for the index and sort.ts for the capture-time order.
import type { Device } from "@luma.gl/core";
import type { PhotoMeta } from "../../photos";
import {
	centroid,
	makeRoll,
	ROLL_LINK_M,
	uploadRollId,
	VIEWPOINT_RADIUS_M,
	type ViewpointGrouping,
} from "../roll";
import type { Roll } from "../types";
import {
	forEachNeighbourPairCpu,
	MAX_GPU_PAIRS,
	type NeighbourPairs,
	neighbourPairsGpu,
} from "./neighbours";
import { sortGroupsByTime } from "./sort";

const isFinitePhoto = (m: PhotoMeta) =>
	Number.isFinite(m.lat) && Number.isFinite(m.lon);

/** Union-find over `count` items. */
function makeUnionFind(count: number) {
	const parent = Array.from({ length: count }, (_, i) => i);
	const size = new Array<number>(count).fill(1);
	const find = (i: number): number => {
		let root = i;
		while (parent[root] !== root) root = parent[root];
		while (parent[i] !== root) {
			const next = parent[i];
			parent[i] = root;
			i = next;
		}
		return root;
	};
	const union = (i: number, j: number) => {
		let a = find(i);
		let b = find(j);
		if (a === b) return;
		if (size[a] < size[b]) [a, b] = [b, a];
		parent[b] = a;
		size[a] += size[b];
	};
	return { find, union };
}

/**
 * The groups clusterPhotos returns, from a visitor over the confirmed pairs: only the partition
 * matters, so the order rule is clusterPhotos' own (members in input order, groups by first member,
 * then a stable sort by size, largest first).
 */
function groupsFromComponents(
	ok: PhotoMeta[],
	find: (i: number) => number,
): PhotoMeta[][] {
	const groups = new Map<number, PhotoMeta[]>();
	ok.forEach((m, i) => {
		const r = find(i);
		const g = groups.get(r);
		if (g) g.push(m);
		else groups.set(r, [m]);
	});
	return [...groups.values()].sort((a, b) => b.length - a.length);
}

/** CPU twin of clusterPhotos: hashed-grid pairs streamed into a union-find (no pair list kept). */
export function clusterPhotosHashed(
	ms: PhotoMeta[],
	linkM = ROLL_LINK_M,
): PhotoMeta[][] {
	const ok = ms.filter(isFinitePhoto);
	const { find, union } = makeUnionFind(ok.length);
	forEachNeighbourPairCpu(ok, linkM, union);
	return groupsFromComponents(ok, find);
}

/**
 * clusterPhotos at scale: the confirmed neighbour pairs from the GPU grid index (when `device` is
 * given and the pair list stays bounded), else streamed from the CPU hashed grid. Returns what
 * clusterPhotos returns.
 */
export async function clusterPhotosAsync(
	ms: PhotoMeta[],
	linkM = ROLL_LINK_M,
	device: Device | null = null,
): Promise<PhotoMeta[][]> {
	const ok = ms.filter(isFinitePhoto);
	let pairs: NeighbourPairs | null = null;
	if (device && ok.length > 1) {
		try {
			pairs = await neighbourPairsGpu(device, ok, linkM);
		} catch {
			pairs = null;
		}
	}
	if (!pairs) return clusterPhotosHashed(ms, linkM);
	const { find, union } = makeUnionFind(ok.length);
	for (let k = 0; k < pairs.length; k += 2) union(pairs[k], pairs[k + 1]);
	return groupsFromComponents(ok, find);
}

/**
 * The greedy viewpoint rule over neighbour lists: photo `p` (capture order) joins the first
 * viewpoint, in creation order, whose SEED is a neighbour of it, else it seeds a new one.
 * `neighboursOf(p)` lists capture positions within the viewpoint radius (any order, any
 * superset-free exact list; positions at or after `p` are ignored).
 */
function greedyViewpoints(
	sorted: PhotoMeta[],
	neighboursOf: (position: number) => Iterable<number>,
): ViewpointGrouping {
	const viewpointOfSeed = new Map<number, number>();
	const viewpoints: ViewpointGrouping["viewpoints"] = [];
	const memberViewpoint = new Array<number>(sorted.length);
	for (let p = 0; p < sorted.length; p++) {
		// seeds are created in capture order, so the first viewpoint is the lowest seed position
		let best = -1;
		for (const q of neighboursOf(p))
			if (q < p && viewpointOfSeed.has(q) && (best < 0 || q < best)) best = q;
		let vi: number;
		if (best >= 0) vi = viewpointOfSeed.get(best) as number;
		else {
			vi = viewpoints.length;
			viewpointOfSeed.set(p, vi);
			viewpoints.push({ lat: sorted[p].lat, lon: sorted[p].lon, photoIds: [] });
		}
		viewpoints[vi].photoIds.push(sorted[p].id);
		memberViewpoint[p] = vi;
	}
	// re-centre each viewpoint on its members (capture order, like groupViewpoints)
	const members = viewpoints.map(() => [] as PhotoMeta[]);
	sorted.forEach((m, p) => {
		members[memberViewpoint[p]].push(m);
	});
	viewpoints.forEach((v, vi) => {
		const c = centroid(members[vi]);
		v.lat = c.lat;
		v.lon = c.lon;
	});
	const index = new Map<string, number>();
	sorted.forEach((m, p) => {
		index.set(m.id, memberViewpoint[p]);
	});
	return { viewpoints, index };
}

/**
 * groupViewpoints (same greedy first-seed semantics, same output) with the neighbour lists of a
 * hashed grid instead of a scan of every viewpoint per photo. Photo ids are assumed unique.
 */
export function groupViewpointsFast(
	sorted: PhotoMeta[],
	radiusM = VIEWPOINT_RADIUS_M,
): ViewpointGrouping {
	const lists: number[][] = sorted.map(() => []);
	forEachNeighbourPairCpu(sorted, radiusM, (i, j) => {
		lists[i].push(j);
		lists[j].push(i);
	});
	return greedyViewpoints(sorted, (p) => lists[p]);
}

/** Adjacency (CSR) of a pair list over `count` items. */
function adjacencyOf(pairs: NeighbourPairs, count: number) {
	const degree = new Uint32Array(count + 1);
	for (let k = 0; k < pairs.length; k++) degree[pairs[k] + 1]++;
	for (let i = 0; i < count; i++) degree[i + 1] += degree[i];
	const fill = degree.slice(0, count);
	const neighbours = new Uint32Array(pairs.length);
	for (let k = 0; k < pairs.length; k += 2) {
		neighbours[fill[pairs[k]]++] = pairs[k + 1];
		neighbours[fill[pairs[k + 1]]++] = pairs[k];
	}
	return { offsets: degree, neighbours };
}

/**
 * Rolls from uploaded photos on the GPU when `device` is given (grid-indexed cluster and viewpoint
 * neighbours, segmented capture-time sort), else the same pipeline on the CPU twins. Deep-equal to
 * uploadRolls(ms) (photo ids unique). Callers that are already async and may see thousands of
 * photos use this instead of uploadRolls.
 */
export async function uploadRollsAsync(
	ms: PhotoMeta[],
	device: Device | null = null,
): Promise<Roll[]> {
	const ok = ms.filter(isFinitePhoto);
	const groups = await clusterPhotosAsync(ms, ROLL_LINK_M, device);
	const sortedGroups = await sortGroupsByTime(groups, device);
	// ONE viewpoint-radius query over all photos (a viewpoint never spans two rolls: 250 m < link)
	let adjacency: ReturnType<typeof adjacencyOf> | null = null;
	if (device && ok.length > 1) {
		try {
			const pairs = await neighbourPairsGpu(device, ok, VIEWPOINT_RADIUS_M);
			if (pairs && pairs.length / 2 <= MAX_GPU_PAIRS)
				adjacency = adjacencyOf(pairs, ok.length);
		} catch {
			adjacency = null;
		}
	}
	const globalIndex = adjacency
		? new Map(ok.map((m, i) => [m, i] as const))
		: null;
	return sortedGroups.map((sorted, groupIndex) => {
		// name, id and region come from the cluster's own order, as uploadRolls takes them
		const group = groups[groupIndex];
		const c = centroid(group);
		let viewpoints: ViewpointGrouping;
		if (adjacency && globalIndex) {
			const globalOf = sorted.map((m) => globalIndex.get(m) as number);
			const positionOf = new Map<number, number>();
			globalOf.forEach((g, p) => {
				positionOf.set(g, p);
			});
			const { offsets, neighbours } = adjacency;
			viewpoints = greedyViewpoints(sorted, function* (p) {
				const g = globalOf[p];
				for (let k = offsets[g]; k < offsets[g + 1]; k++) {
					const q = positionOf.get(neighbours[k]);
					if (q !== undefined) yield q;
				}
			});
		} else viewpoints = groupViewpointsFast(sorted);
		return makeRoll(
			uploadRollId(group),
			`Your photos near ${c.lat.toFixed(3)}°, ${c.lon.toFixed(3)}°`,
			group,
			group[0].region ?? null,
			{},
			{ sorted, viewpoints },
		);
	});
}
