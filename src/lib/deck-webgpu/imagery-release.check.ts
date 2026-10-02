// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check for the imagery release timer (imagery.ts ReleaseTimer / ImageryArray.hold), fake timers.
// Run: npx tsx src/lib/deck-webgpu/imagery-release.check.ts
//   1. releaseWhenIdle fires after IMAGERY_RELEASE_IDLE_MS without a hold
//   2. a hold defers the firing to its deadline (holdDeferrals counts), hold never shortens
//   3. sync() cancels the pending release; repeated releaseWhenIdle keeps the first deadline
//   4. release() stays immediate under a hold
import type { Device } from "@luma.gl/core";
import {
	IMAGERY_POSE_VIEW_HOLD_MS,
	IMAGERY_RELEASE_IDLE_MS,
	ImageryArray,
	ReleaseTimer,
	type ReleaseTimerHost,
} from "./imagery";

let fails = 0;
const ok = (cond: boolean, msg: string) => {
	if (!cond) {
		fails++;
		console.error(`FAIL ${msg}`);
	}
};

/** A clock with a timer queue. */
function fakeHost() {
	let t = 0;
	let nextId = 1;
	const queue = new Map<number, { at: number; fn: () => void }>();
	const host: ReleaseTimerHost = {
		now: () => t,
		setTimeout: (fn, ms) => {
			const id = nextId++;
			queue.set(id, { at: t + ms, fn });
			return id;
		},
		clearTimeout: (h) => void queue.delete(h as number),
	};
	const advance = (ms: number) => {
		const end = t + ms;
		for (;;) {
			let best: [number, { at: number; fn: () => void }] | null = null;
			for (const e of queue)
				if (e[1].at <= end && (!best || e[1].at < best[1].at)) best = e;
			if (!best) break;
			queue.delete(best[0]);
			t = best[1].at;
			best[1].fn();
		}
		t = end;
	};
	return { host, advance, pending: () => queue.size };
}

function makeArray() {
	const f = fakeHost();
	const device = {
		limits: { maxTextureArrayLayers: 256 },
	} as unknown as Device;
	const a = new ImageryArray(device, f.host);
	let releases = 0;
	// one live layer so releaseWhenIdle arms; the arrays are null, so release() touches no GPU object
	(a as unknown as { layers: Map<string, unknown> }).layers.set("t", {
		tier: 512,
		layer: 0,
	});
	const real = a.release.bind(a);
	a.release = () => {
		releases++;
		real();
	};
	return { a, f, releases: () => releases };
}

// ReleaseTimer alone
{
	const f = fakeHost();
	let fired = 0;
	const r = new ReleaseTimer(() => fired++, f.host);
	r.arm(100);
	r.arm(500); // keeps the first deadline
	f.advance(99);
	ok(fired === 0, "timer: not yet at 99");
	f.advance(1);
	ok(fired === 1 && !r.armed, "timer: fires at the first deadline");
	r.arm(100);
	r.holdUntil(f.host.now() + 350);
	r.holdUntil(f.host.now() + 10); // never shortens
	f.advance(100);
	ok(fired === 1 && r.armed && r.deferrals === 1, "timer: hold defers");
	f.advance(249);
	ok(fired === 1, "timer: still held at 349");
	f.advance(1);
	ok(fired === 2 && r.deferrals === 1, "timer: fires at the hold deadline");
	r.arm(100);
	r.cancel();
	f.advance(1000);
	ok(fired === 2 && f.pending() === 0, "timer: cancel disarms");
}

// 1. no hold
{
	const { a, f, releases } = makeArray();
	a.releaseWhenIdle();
	f.advance(IMAGERY_RELEASE_IDLE_MS - 1);
	ok(releases() === 0, "idle: not released at 10 s − 1 ms");
	f.advance(1);
	ok(releases() === 1 && a.stats.layers === 0, "idle: released at 10 s");
}
// 2. hold defers to heldUntil
{
	const { a, f, releases } = makeArray();
	a.hold(IMAGERY_POSE_VIEW_HOLD_MS);
	a.releaseWhenIdle();
	f.advance(IMAGERY_RELEASE_IDLE_MS + 1000);
	ok(releases() === 0, "hold: 11 s after the view, still resident");
	f.advance(IMAGERY_POSE_VIEW_HOLD_MS - IMAGERY_RELEASE_IDLE_MS - 1000 - 1);
	ok(releases() === 0, "hold: still resident just before the hold ends");
	f.advance(1);
	ok(releases() === 1, "hold: released at the hold deadline");
	ok(
		a.stats.holdDeferrals === 1,
		`hold: holdDeferrals ${a.stats.holdDeferrals}`,
	);
}
// 3. sync cancels; repeated releaseWhenIdle keeps the first deadline
{
	const { a, f, releases } = makeArray();
	a.releaseWhenIdle();
	f.advance(6000);
	a.releaseWhenIdle(); // keeps the first deadline (4 s left)
	f.advance(4000);
	ok(releases() === 1, "repeat: fired at the first deadline");
	const b = makeArray();
	b.a.releaseWhenIdle();
	b.f.advance(5000);
	b.a.sync(new Map(), ["t"]);
	ok(
		b.f.pending() <= 1,
		"sync: release timer cancelled (only idle compaction may remain)",
	);
	b.f.advance(60_000);
	ok(b.releases() === 0, "sync: no release after sync()");
}
// 4. release() immediate under hold
{
	const { a, releases } = makeArray();
	a.hold(IMAGERY_POSE_VIEW_HOLD_MS);
	a.release();
	ok(releases() === 1 && a.stats.layers === 0, "release() ignores the hold");
}

console.log(
	`imagery-release.check: ${fails ? `${fails} FAILED` : "all passed"}`,
);
process.exit(fails ? 1 : 0);
