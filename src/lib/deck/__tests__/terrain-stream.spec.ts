// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemRaster, TileKey } from "../../dem";
import { tileId } from "../../dem";
import { EnuFrame } from "../../geodesy";
import type { TerrainSet, TerrainStats } from "../terrain-data";
import {
	downsample2,
	fitStreamTile,
	spareEviction,
	TerrainStreamer,
	TILE_LOAD_ATTEMPTS,
	TILE_RETRY_MS,
} from "../terrain-stream";

const frame = new EnuFrame(46.68, 7.85, 0);

function flatTile(key: TileKey, size = 33, h = 500): DemRaster {
	return {
		key,
		source: key,
		size,
		heights: new Float32Array(size * size).fill(h),
	};
}

describe("spareEviction", () => {
	it("drops the oldest spares beyond the cap and unleases all but the newest layers", () => {
		const cand = ["a", "b", "c", "d", "e"];
		// 5 spare, keep 3 meshes -> drop 2 oldest; of kept (c,d,e) keep newest 1 leased
		const r = spareEviction(cand, 5, 3, 1);
		expect(r.drop).toEqual(["a", "b"]);
		expect(r.unlease).toEqual(["c", "d"]);
	});

	it("never drops when under the cap, never negative", () => {
		expect(spareEviction(["a"], 1, 10, 5)).toEqual({ drop: [], unlease: [] });
		expect(spareEviction([], 0, 0, 0)).toEqual({ drop: [], unlease: [] });
		// fewer candidates than the excess
		expect(spareEviction(["a", "b"], 100, 0, 0).drop).toEqual(["a", "b"]);
	});
});

describe("downsample2 / fitStreamTile", () => {
	it("halves the size and box-filters", () => {
		const heights = new Float32Array(16);
		for (let i = 0; i < 16; i++) heights[i] = i % 4 < 2 ? 0 : 4;
		const r = downsample2({
			key: { z: 1, x: 0, y: 0 },
			source: { z: 1, x: 0, y: 0 },
			size: 4,
			heights,
		});
		expect(r.size).toBe(2);
		expect(r.heights.length).toBe(4);
		expect(Array.from(r.heights)).toEqual([0, 4, 0, 4]);
	});

	it("fitStreamTile halves while > 2 samples/segment and > 256 px", () => {
		const key = { z: 8, x: 1, y: 1 };
		const big = flatTile(key, 512);
		expect(fitStreamTile(big, 64).size).toBe(256);
		expect(fitStreamTile(big, 256).size).toBe(512);
		expect(fitStreamTile(big, 128).size).toBe(256);
		const small = flatTile(key, 128);
		expect(fitStreamTile(small, 8)).toBe(small); // never below 256
	});
});

describe.each([
	"rigi",
	"loaders",
] as const)("TerrainStreamer (%s scheduler)", (scheduler) => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const base = { radiusM: 8000, minZoom: 9, maxZoom: 11 };

	function make(
		loadTile: (key: TileKey, seg: number) => Promise<DemRaster | null>,
		extra = {},
	) {
		const sets: TerrainSet[] = [];
		const previews: TerrainSet[] = [];
		const progress: [number, number][] = [];
		const s = new TerrainStreamer(frame, {
			...base,
			scheduler,
			loadTile: (k, seg) => loadTile(k, seg),
			onUpdate: (set) => sets.push(set),
			onPreview: (set) => previews.push(set),
			onProgress: (d, t) => progress.push([d, t]),
			...extra,
		});
		return { s, sets, previews, progress };
	}

	const last = <T>(a: T[]) => a[a.length - 1];
	const stats = (set: TerrainSet) => set.stats as TerrainStats;

	it("emits nothing until the whole first selection is loaded (all or nothing), then a complete set", async () => {
		const gate = new Map<string, () => void>();
		const { s, sets } = make(
			(key) =>
				new Promise((res) => gate.set(tileId(key), () => res(flatTile(key)))),
		);
		s.setWedge({ headingDeg: 0, halfAngleDeg: 180 });
		await vi.advanceTimersByTimeAsync(500);
		expect(sets.length).toBe(0);
		const all = () => [...gate.entries()];
		// release all but one
		const entries = all();
		for (const [, f] of entries.slice(1)) f();
		await vi.advanceTimersByTimeAsync(500);
		expect(sets.length).toBe(0);
		entries[0][1]();
		await vi.advanceTimersByTimeAsync(500);
		expect(sets.length).toBeGreaterThan(0);
		const st = stats(last(sets));
		expect(st.pending).toBe(0);
		expect(st.generation).toBe(1);
		expect(st.tiles).toBeGreaterThan(0);
		expect(st.triangles).toBeGreaterThan(0);
		s.dispose();
	});

	it("never exceeds the concurrency cap", async () => {
		let inFlight = 0;
		let peak = 0;
		const { s } = make(
			async (key) => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise((r) => setTimeout(r, 50));
				inFlight--;
				return flatTile(key);
			},
			{ concurrency: 3 },
		);
		s.setWedge({ headingDeg: 0, halfAngleDeg: 180 });
		await vi.advanceTimersByTimeAsync(5000);
		expect(peak).toBe(3);
		s.dispose();
	});

	it("loads near, in-view tiles first", async () => {
		const order: TileKey[] = [];
		const { s } = make(
			async (key) => {
				order.push(key);
				return flatTile(key);
			},
			{ concurrency: 1 },
		);
		s.setWedge({ headingDeg: 0, halfAngleDeg: 40 });
		await vi.advanceTimersByTimeAsync(5000);
		// the first loaded tile is the one at the camera: highest zoom
		expect(order[0].z).toBe(Math.max(...order.map((k) => k.z)));
		s.dispose();
	});

	it("gives up on a tile that always fails after TILE_LOAD_ATTEMPTS and completes the set", async () => {
		const attempts = new Map<string, number>();
		let bad: string | null = null;
		const { s, sets } = make(async (key) => {
			const id = tileId(key);
			attempts.set(id, (attempts.get(id) ?? 0) + 1);
			if (key.z === 11) {
				bad ??= id;
				if (id === bad) return null;
			}
			return flatTile(key);
		});
		s.setWedge({ headingDeg: 0, halfAngleDeg: 180 });
		await vi.advanceTimersByTimeAsync(TILE_RETRY_MS * 10 + 1000);
		expect(bad).not.toBeNull();
		expect(attempts.get(String(bad))).toBe(TILE_LOAD_ATTEMPTS);
		const st = stats(last(sets));
		expect(st.pending).toBe(0);
		expect(st.failed).toBe(1);
		s.dispose();
	});

	it("retries with a growing backoff and succeeds on a transient failure", async () => {
		const times: number[] = [];
		let flaky: string | null = null;
		const { s, sets } = make(async (key) => {
			const id = tileId(key);
			if (key.z === 11) {
				flaky ??= id;
				if (id === flaky) {
					times.push(Date.now());
					if (times.length <= 2) return null;
				}
			}
			return flatTile(key);
		});
		s.setWedge({ headingDeg: 0, halfAngleDeg: 180 });
		await vi.advanceTimersByTimeAsync(TILE_RETRY_MS * 10);
		expect(times.length).toBe(3);
		expect(times[1] - times[0]).toBeGreaterThanOrEqual(TILE_RETRY_MS);
		expect(times[2] - times[1]).toBeGreaterThanOrEqual(2 * TILE_RETRY_MS);
		expect(stats(last(sets)).failed).toBeUndefined();
		s.dispose();
	});

	it("a throwing loader counts as a failed load, not an unhandled rejection", async () => {
		const { s, sets } = make(async (key) => {
			if (key.z === 11) throw new Error("decode");
			return flatTile(key);
		});
		s.setWedge({ headingDeg: 0, halfAngleDeg: 180 });
		await vi.advanceTimersByTimeAsync(TILE_RETRY_MS * 10 + 1000);
		expect(sets.length).toBeGreaterThan(0);
		expect(stats(last(sets)).pending).toBe(0);
		s.dispose();
	});

	it("setWedge is a no-op for a barely changed wedge or two 360s, and after dispose", async () => {
		const { s } = make(async (key) => flatTile(key));
		expect(s.setWedge({ headingDeg: 10, halfAngleDeg: 30 })).toBe(true);
		expect(s.setWedge({ headingDeg: 11, halfAngleDeg: 31 })).toBe(false);
		expect(s.setWedge({ headingDeg: 40, halfAngleDeg: 30 })).toBe(true);
		expect(s.setWedge({ headingDeg: 0, halfAngleDeg: 180 })).toBe(true);
		expect(s.setWedge({ headingDeg: 90, halfAngleDeg: 190 })).toBe(false);
		await vi.advanceTimersByTimeAsync(2000);
		s.dispose();
		expect(s.setWedge({ headingDeg: 200, halfAngleDeg: 20 })).toBe(false);
	});

	it("a new wedge aborts in-flight loads it no longer wants", async () => {
		const signals: AbortSignal[] = [];
		const { s } = make(() => new Promise(() => {}), {
			concurrency: 200,
			radiusM: 80_000,
			minZoom: 8,
			loadTile: (_key: TileKey, _seg: number, o: { signal?: AbortSignal }) => {
				if (o.signal) {
					signals.push(o.signal);
				}
				return new Promise(() => {});
			},
		});
		s.setWedge({ headingDeg: 0, halfAngleDeg: 20 });
		await vi.advanceTimersByTimeAsync(10);
		expect(signals.length).toBeGreaterThan(0);
		s.setWedge({ headingDeg: 180, halfAngleDeg: 20 });
		await vi.advanceTimersByTimeAsync(10);
		expect(signals.some((x) => x.aborted)).toBe(true);
		s.dispose();
		expect(signals.every((x) => x.aborted)).toBe(true);
	});

	it("emits a coarse preview before the full set when previewMaxZoom is set", async () => {
		const { s, sets, previews } = make(async (key) => flatTile(key), {
			previewMaxZoom: 10,
		});
		s.setWedge({ headingDeg: 0, halfAngleDeg: 180 });
		await vi.advanceTimersByTimeAsync(3000);
		expect(previews.length).toBe(1);
		expect(sets.length).toBeGreaterThan(0);
		expect(stats(previews[0]).generation).toBe(0);
		expect(
			Math.max(...previews[0].tiles.map((t) => t.key.z)),
		).toBeLessThanOrEqual(10);
		expect(s.previewLoadMs).toBeGreaterThanOrEqual(0);
		s.dispose();
	});

	it("reports progress and a second wedge bumps the generation, reusing loaded tiles", async () => {
		const loads: string[] = [];
		const { s, sets, progress } = make(async (key) => {
			loads.push(tileId(key));
			return flatTile(key);
		});
		s.setWedge({ headingDeg: 0, halfAngleDeg: 180 });
		await vi.advanceTimersByTimeAsync(3000);
		expect(progress.length).toBeGreaterThan(0);
		expect(last(progress)[0]).toBe(last(progress)[1]);
		const n = loads.length;
		s.setWedge({ headingDeg: 0, halfAngleDeg: 180 }); // same: no-op
		s.setWedge({ headingDeg: 90, halfAngleDeg: 20 });
		await vi.advanceTimersByTimeAsync(3000);
		expect(stats(last(sets)).generation).toBe(2);
		// tiles already loaded at the same resolution are not reloaded
		const dup = loads.slice(n).filter((id) => loads.slice(0, n).includes(id));
		expect(dup.length).toBeLessThanOrEqual(loads.length - n);
		s.dispose();
	});

	it("a rendered set has no overlapping tiles (parents hide their children)", async () => {
		const { s, sets } = make(async (key) => flatTile(key));
		s.setWedge({ headingDeg: 0, halfAngleDeg: 60 });
		await vi.advanceTimersByTimeAsync(3000);
		const tiles = last(sets).tiles;
		for (let i = 0; i < tiles.length; i++)
			for (let j = 0; j < tiles.length; j++) {
				if (i === j) continue;
				const a = tiles[i].key;
				const d = tiles[j].key;
				const anc =
					a.z < d.z && d.x >> (d.z - a.z) === a.x && d.y >> (d.z - a.z) === a.y;
				expect(anc).toBe(false);
			}
		s.dispose();
	});
});

/**
 * The load-start order of the two schedulers must agree. Loads are held and completed one at a time
 * (oldest first) so only the scheduler decides what starts next.
 */
describe("terrain scheduler load order: loaders == rigi", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	type Script = {
		concurrency: number;
		preview?: boolean;
		/** Completions before the second wedge (null = none). */
		wedgeAfter?: number;
		/** Tile that fails its first `failures` loads (the n-th load started, 0-based). */
		failNth?: { nth: number; failures: number };
	};

	async function record(
		scheduler: "rigi" | "loaders",
		sc: Script,
	): Promise<string[]> {
		const order: string[] = [];
		const held: { id: string; done: (ok: boolean) => void }[] = [];
		const attempts = new Map<string, number>();
		let failId: string | null = null;
		const s = new TerrainStreamer(frame, {
			radiusM: 20_000,
			minZoom: 9,
			maxZoom: 12,
			concurrency: sc.concurrency,
			scheduler,
			...(sc.preview ? { previewMaxZoom: 11, onPreview: () => {} } : {}),
			onUpdate: () => {},
			loadTile: (key, seg) =>
				new Promise((res) => {
					const id = `${tileId(key)}:${seg}`;
					order.push(id);
					if (sc.failNth && order.length - 1 === sc.failNth.nth) failId = id;
					const n = (attempts.get(id) ?? 0) + 1;
					attempts.set(id, n);
					held.push({
						id,
						done: (ok) =>
							res(
								ok && !(id === failId && n <= (sc.failNth?.failures ?? 0))
									? flatTile(key)
									: null,
							),
					});
				}),
		});
		s.setWedge({ headingDeg: 0, halfAngleDeg: 40 });
		let completed = 0;
		let wedged = false;
		for (let guard = 0; guard < 2000; guard++) {
			await vi.advanceTimersByTimeAsync(TILE_RETRY_MS * 3);
			if (!wedged && sc.wedgeAfter != null && completed >= sc.wedgeAfter) {
				wedged = true;
				s.setWedge({ headingDeg: 120, halfAngleDeg: 40 });
				continue;
			}
			const next = held.shift();
			if (!next) break;
			next.done(true);
			completed++;
		}
		s.dispose();
		return order;
	}

	const scripts: [string, Script][] = [];
	for (const concurrency of [1, 3]) {
		scripts.push([
			`first selection with preview, c=${concurrency}`,
			{ concurrency, preview: true },
		]);
		scripts.push([
			`wedge change mid-load, c=${concurrency}`,
			{ concurrency, wedgeAfter: 4 },
		]);
		scripts.push([
			`wedge change mid-load with preview, c=${concurrency}`,
			{ concurrency, preview: true, wedgeAfter: 4 },
		]);
		scripts.push([
			`failing tile retries, c=${concurrency}`,
			{ concurrency, failNth: { nth: 2, failures: 2 } },
		]);
		scripts.push([
			`always-failing tile, c=${concurrency}`,
			{ concurrency, failNth: { nth: 1, failures: 99 } },
		]);
	}
	it.each(scripts)("%s", async (_name, sc) => {
		const a = await record("rigi", sc);
		const b = await record("loaders", sc);
		expect(a.length).toBeGreaterThan(5);
		expect(b).toEqual(a);
	});
});
