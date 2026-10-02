// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check for the frame-timings ring, pass cap and aggregation (frame-timings-core.ts), no GPU.
// Run: npx tsx src/lib/deck-webgpu/frame-timings-core.check.ts
//   1. the ring creates at most `size` sets, returns null while all are in flight (frame dropped),
//      and reuses a released set
//   2. the pass cap: 32 passes fit (indices 0..63), the 33rd overflows and the lease stays overflowed
//   3. a discarded set is destroyed and its slot is free to be created again
//   4. buildFrameTimings sums per pass and zeroes bad durations
//   5. RollingFrameMean: window eviction, per-name mean, repeated names summed per frame
import {
	buildFrameTimings,
	MAX_TIMED_PASSES,
	QUERY_RING_SIZE,
	QueryRing,
	RollingFrameMean,
} from "./frame-timings-core";

let failures = 0;
const check = (ok: boolean, msg: string) => {
	if (!ok) {
		failures++;
		console.log(`FAIL ${msg}`);
	}
};

// ---------- 1. ring ----------
let made = 0;
let destroyed = 0;
const ring = new QueryRing<number>(
	() => made++,
	() => destroyed++,
);
const leases = [];
for (let i = 0; i < QUERY_RING_SIZE; i++) {
	const l = ring.begin(i);
	check(l !== null, `lease ${i} available`);
	if (l) leases.push(l);
}
check(made === QUERY_RING_SIZE, "created exactly the ring size");
check(ring.begin(99) === null, "all in flight: the frame is dropped");
check(made === QUERY_RING_SIZE, "no set created past the ring size");
check(ring.inFlight === QUERY_RING_SIZE, "inFlight counts the claimed sets");
ring.release(leases[1]);
const again = ring.begin(100);
check(
	again?.querySet === leases[1].querySet,
	"a released set is reused, not recreated",
);
check(made === QUERY_RING_SIZE, "reuse creates nothing");

// ---------- 2. pass cap ----------
const capRing = new QueryRing<number>(
	() => 0,
	() => {},
);
const capLease = capRing.begin(0);
if (!capLease) throw new Error("no lease");
let last = null;
for (let i = 0; i < MAX_TIMED_PASSES; i++) {
	last = capRing.nextPass(capLease, `p${i}`);
	check(
		last?.beginIndex === i * 2 && last.endIndex === i * 2 + 1,
		`pass ${i} indices`,
	);
}
check(
	last?.endIndex === MAX_TIMED_PASSES * 2 - 1,
	"last slot is the set's last",
);
check(
	capRing.nextPass(capLease, "extra") === null,
	"pass past the cap is refused",
);
check(capLease.overflowed, "lease marked overflowed");
check(capLease.passNames.length === MAX_TIMED_PASSES, "overflow adds no name");

// ---------- 3. discard ----------
const before = destroyed;
const l0 = leases[0];
ring.discard(l0);
check(destroyed === before + 1, "discard destroys the set");
check(ring.begin(7) !== null, "a discarded slot can be created again");

// ---------- 4. build ----------
const t = buildFrameTimings(
	{ frame: 5, passNames: ["geometry", "color", "screen"] },
	[1.5, Number.NaN, -2],
);
check(t.frame === 5, "frame number carried");
check(t.passes.length === 3, "one entry per pass");
check(t.totalGpuMs === 1.5, "bad durations count 0");
check(
	t.passes[1].gpuMs === 0 && t.passes[2].gpuMs === 0,
	"NaN and negative zeroed",
);

// ---------- 5. mean ----------
const mean = new RollingFrameMean(3);
for (const v of [10, 1, 2, 3])
	mean.add({
		frame: 0,
		passes: [{ name: "geometry", gpuMs: v }],
		totalGpuMs: v,
	});
const m = mean.mean();
check(m.frames === 3, "window keeps 3 frames");
check(Math.abs(m.totalGpuMs - 2) < 1e-12, "mean over the window (10 evicted)");
check(Math.abs(m.passes[0].gpuMs - 2) < 1e-12, "per-pass mean");
const dup = new RollingFrameMean(4);
dup.add({
	frame: 0,
	passes: [
		{ name: "a", gpuMs: 1 },
		{ name: "a", gpuMs: 2 },
	],
	totalGpuMs: 3,
});
check(dup.mean().passes[0].gpuMs === 3, "repeated names are summed per frame");
dup.reset();
check(dup.mean().frames === 0, "reset clears");

if (failures) {
	console.log(`${failures} failure(s)`);
	process.exit(1);
}
console.log("frame-timings-core: ok");
