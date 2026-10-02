// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// createIdleRelease with fake timers: fires once after the idle window, a begin() inside the window
// postpones it, nothing fires while a request is in flight, a rejected release is swallowed.
// Run: npx tsx src/lib/sky/graph-idle.check.ts
import { createIdleRelease, type IdleTimers } from "./graph-idle";

let now = 0;
let nextId = 1;
const pending = new Map<number, { at: number; fn: () => void }>();
const timers: IdleTimers = {
	setTimeout: (fn, ms) => {
		const id = nextId++;
		pending.set(id, { at: now + ms, fn });
		return id;
	},
	clearTimeout: (h) => {
		pending.delete(h as number);
	},
};
const advance = (ms: number) => {
	const to = now + ms;
	for (;;) {
		const due = [...pending.entries()]
			.filter(([, t]) => t.at <= to)
			.sort((a, b) => a[1].at - b[1].at)[0];
		if (!due) break;
		pending.delete(due[0]);
		now = due[1].at;
		due[1].fn();
	}
	now = to;
};

let fails = 0;
const expect = (name: string, got: unknown, want: unknown) => {
	const ok = Object.is(got, want);
	if (!ok) fails++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${got}, want ${want})`}`,
	);
};

let releases = 0;
const idle = createIdleRelease(
	30_000,
	async () => {
		releases++;
	},
	timers,
);

idle.begin();
idle.end();
advance(29_999);
expect("not yet at 29.999 s", releases, 0);
advance(1);
expect("fires at 30 s", releases, 1);
advance(300_000);
expect("fires once", releases, 1);

idle.begin();
idle.end();
advance(20_000);
idle.begin();
advance(100_000);
expect("nothing fires while in flight", releases, 1);
idle.end();
advance(29_999);
expect("touch postponed the release", releases, 1);
advance(1);
expect("fires 30 s after the last end", releases, 2);

idle.begin();
idle.begin();
idle.end();
advance(100_000);
expect("one of two still in flight", releases, 2);
idle.end();
advance(30_000);
expect("fires after the last one ends", releases, 3);

idle.begin();
idle.end();
idle.cancel();
advance(100_000);
expect("cancel drops it", releases, 3);

const bad = createIdleRelease(10, () => Promise.reject(new Error("x")), timers);
bad.begin();
bad.end();
advance(10);
await new Promise((r) => setImmediate(r));
expect("rejected release swallowed", true, true);

console.log(fails ? `${fails} failing` : "all ok");
process.exit(fails ? 1 : 0);
