// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Terrain loads that never complete (the wave-3 precision gate's loadFullTerrain timeouts).
// Run: npx tsx src/lib/deck/terrain-stream.check.ts
//  - streamer: a tile whose load keeps coming back empty is retried (TILE_LOAD_ATTEMPTS), then given
//    up on, so the 360° set still completes (pending 0, stats.failed 1); before, pending stayed 1 and
//    loadFullTerrain waited out its 300 s; a transient failure loads on retry; a failed tile in the
//    first selection no longer blocks the first set
//    (run for both terrainScheduler strategies; load order parity is in __tests__/terrain-stream.spec.ts)
//  - tile cache: a stalled network fetch fails as a TimeoutError after fetchTimeoutMs (counted), a
//    caller's abort is still an AbortError, and the DEM loader falls back to the ancestor tile
import { configureTileCache, TileCache } from "../cache";
import { fetchDemBytes } from "../dem";
import { MAPTERHORN } from "../dem/sources";
import { EnuFrame } from "../geodesy";
import type { TerrainStats } from "./terrain-data";
import { TerrainStreamer, TILE_LOAD_ATTEMPTS } from "./terrain-stream";

let failures = 0;
let label = "";
const ok = (c: boolean, m: string) => {
	console.log(`${c ? "PASS" : "FAIL"}  ${label}${m}`);
	if (!c) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const warn = console.warn;
console.warn = () => {};

/**
 * One streamer over a synthetic flat DEM: a 30° wedge, then 360° (loadFullTerrain's switch).
 * `fails(id, attempt, phase)` = true makes that load come back empty.
 */
async function stream(
	fails: (id: string, attempt: number, phase: 1 | 2) => boolean,
	scheduler: "rigi" | "loaders",
) {
	const frame = new EnuFrame(46.68, 7.85, 0);
	const attempts = new Map<string, number>();
	let phase: 1 | 2 = 1;
	const sets: TerrainStats[] = [];
	const s = new TerrainStreamer(frame, {
		radiusM: 30_000,
		scheduler,
		onUpdate: (set) => set.stats && sets.push(set.stats),
		loadTile: async (key) => {
			const id = `${key.z}/${key.x}/${key.y}`;
			// attempts per phase (a tile of both selections loads once per resolution)
			const k = `${phase}:${id}`;
			const n = (attempts.get(k) ?? 0) + 1;
			attempts.set(k, n);
			if (fails(id, n, phase)) return null;
			const size = 33;
			return {
				key,
				source: key,
				size,
				heights: new Float32Array(size * size).fill(500),
			};
		},
	});
	/** Waits until `done` (polled) or `ms`, then a little longer for stray emits. */
	const until = async (done: () => boolean, ms: number) => {
		const t0 = performance.now();
		while (!done() && performance.now() - t0 < ms) await sleep(20);
		await sleep(200);
	};
	s.setWedge({ headingDeg: 0, halfAngleDeg: 30 });
	await until(() => sets.length > 0, 3000);
	const first = sets.length;
	phase = 2;
	s.setWedge({ headingDeg: 0, halfAngleDeg: 180 });
	await until(
		() => sets.some((x) => x.generation === 2 && x.pending === 0),
		5000,
	);
	s.dispose();
	return { sets, first, attempts };
}

for (const scheduler of ["rigi", "loaders"] as const) {
	label = `[${scheduler}] `;
	// the first z ≥ 12 tile loaded in the 360° phase fails every time
	{
		let bad: string | null = null;
		const r = await stream((id, _n, phase) => {
			if (phase !== 2 || Number(id.split("/")[0]) < 12) return false;
			bad ??= id;
			return id === bad;
		}, scheduler);
		const last = r.sets.at(-1);
		ok(r.first > 0, "30° selection completes");
		ok(
			last?.generation === 2 && last.pending === 0 && last.failed === 1,
			`360°: a tile that always fails is given up on, the set completes (pending ${last?.pending}, failed ${last?.failed})`,
		);
		ok(
			bad !== null && r.attempts.get(`2:${bad}`) === TILE_LOAD_ATTEMPTS,
			`the failing tile was tried ${TILE_LOAD_ATTEMPTS}× (${bad && r.attempts.get(`2:${bad}`)})`,
		);
	}
	// transient: fails twice, then loads
	{
		let flaky: string | null = null;
		const r = await stream((id, n, phase) => {
			if (phase !== 2 || Number(id.split("/")[0]) < 12) return false;
			flaky ??= id;
			return id === flaky && n <= 2;
		}, scheduler);
		const last = r.sets.at(-1);
		ok(
			last?.generation === 2 && last.pending === 0 && !last.failed,
			"360°: a tile that fails twice loads on its retry (nothing given up)",
		);
	}
	// a failed tile in the very first selection (all-or-nothing first set)
	{
		let bad: string | null = null;
		const r = await stream((id, _n, phase) => {
			if (phase !== 1 || Number(id.split("/")[0]) < 12) return false;
			bad ??= id;
			return id === bad;
		}, scheduler);
		ok(r.first > 0, "first selection with an always-failing tile still emits");
	}
}

label = "";
// ---- tile cache stall timeout ----
/** A server where `/stall` never answers (until aborted, like fetch), anything else is 200. */
const stallServer = (stall: (url: string) => boolean) =>
	(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (stall(url))
			return new Promise<Response>((_res, rej) => {
				const sig = init?.signal;
				sig?.addEventListener("abort", () => rej(sig.reason), { once: true });
			});
		return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
	}) as typeof fetch;
{
	const cache = new TileCache({
		fetch: stallServer((u) => u.endsWith("/stall")),
		backend: "memory",
		fetchTimeoutMs: 100,
	});
	let name = "";
	const t0 = performance.now();
	try {
		await cache.get("https://example.test/stall");
	} catch (e) {
		name = (e as Error).name;
	}
	const ms = performance.now() - t0;
	ok(
		name === "TimeoutError" && ms < 1000,
		`stalled fetch fails as TimeoutError after the timeout (${name}, ${ms.toFixed(0)} ms)`,
	);
	ok(cache.stats().network.timeouts === 1, "the timeout is counted");
	const ac = new AbortController();
	const p = cache.get("https://example.test/stall", { signal: ac.signal });
	setTimeout(() => ac.abort(), 10);
	let aname = "";
	try {
		await p;
	} catch (e) {
		aname = (e as Error).name;
	}
	ok(
		aname === "AbortError" && cache.stats().network.timeouts === 1,
		`a caller's abort stays an AbortError, no timeout counted (${aname})`,
	);
	const fine = await cache.get("https://example.test/ok");
	ok(fine.status === 200, "other requests unaffected");
}
{
	// the DEM loader: a stalled tile is retried once, then its ancestor stands in
	const key = { z: 12, x: 2136, y: 1446 };
	const stalled = MAPTERHORN.url(key);
	configureTileCache({
		fetch: stallServer((u) => u === stalled),
		backend: "memory",
		fetchTimeoutMs: 100,
	});
	const r = await Promise.race([
		fetchDemBytes(key, { minZoom: 5 }),
		sleep(3000).then(() => "hung" as const),
	]);
	ok(
		r !== "hung" && r !== null && r.source.z === 11,
		`fetchDemBytes falls back to the ancestor after a stall (source z ${r && r !== "hung" ? r.source.z : r})`,
	);
}

console.warn = warn;
if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nterrain stall check: ok");
process.exit(0);
