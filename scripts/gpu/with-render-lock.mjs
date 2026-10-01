#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Run a command under the machine-wide playwright/render lock (see the 2026-09-26 crash notes:
// 19 GB swap + full disk). Each slot is a directory, created atomically with mkdir; a slot whose
// owner pid is dead is stolen.
// Waiters queue FIFO: each takes a ticket and only the oldest live ticket may start, so nobody
// loses a polling race or has to ask peers to pause. RENDER_LOCK_PRIORITY=1 (a job a person is
// waiting on) queues ahead of normal tickets.
// Up to RENDER_LOCK_SLOTS jobs (default 3) run at once: a job only joins running ones while free
// memory is at least RENDER_LOCK_MIN_FREE % (default 40) and the last start has had 20 s to grow.
// Timing benches must run alone: RENDER_LOCK_EXCLUSIVE=1 (automatic when the command mentions
// "bench"; RENDER_LOCK_EXCLUSIVE=0 opts out) takes every slot.
// The lock and queue live outside any tree (RIGI_RENDER_LOCK_DIR, default ~/.cache/rigi), so
// sandbox clones and copies of this script all share one queue.
// It also waits for memory headroom before starting (see tm_locks.py).
// Usage: node scripts/gpu/with-render-lock.mjs -- node scripts/eval-app.mjs IMG_6958
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DIR =
	process.env.RIGI_RENDER_LOCK_DIR || join(homedir(), ".cache", "rigi");
const QUEUE = join(DIR, "render-queue");
const LAST_START = join(DIR, "render-last-start");
const SLOTS = Math.max(1, Number(process.env.RENDER_LOCK_SLOTS) || 3);
const MIN_FREE = Number(process.env.RENDER_LOCK_MIN_FREE) || 40;
const SETTLE_MS = Number(process.env.RENDER_LOCK_SETTLE_MS ?? 20_000);
// slot 0 keeps the single-lock name, so a holder from the one-slot script still blocks slot 0
const slotDir = (i) => join(DIR, i ? `render-lock-${i}` : "render-lock");
// Transition (remove after 2026-10): scripts from before the shared dir lock <real tree>/out/.render-lock.
// No job starts while an old-script job holds it, and exclusive jobs take it too. It must be the real
// tree's absolute path: a sandbox copy's out/ holds a private (possibly stale, cloned) lock.
const LEGACY =
	process.env.RIGI_LEGACY_RENDER_LOCK ??
	join(homedir(), "Documents/GitHub/mt-image/out/.render-lock");

const dashAt = process.argv.indexOf("--");
const argv = dashAt < 0 ? [] : process.argv.slice(dashAt + 1);
if (!argv.length) {
	console.error("usage: with-render-lock.mjs -- <cmd> [args…]");
	process.exit(2);
}
const owner = `${process.pid} ${argv.join(" ")}`;
const exclusive =
	process.env.RENDER_LOCK_EXCLUSIVE === "1" ||
	(process.env.RENDER_LOCK_EXCLUSIVE !== "0" && /bench/i.test(argv.join(" ")));

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Live owner line of lock dir `dir`, or null when it is free (a dead owner's lock is removed). */
const holder = (dir) => {
	if (!existsSync(dir)) return null;
	let held = "";
	try {
		held = readFileSync(`${dir}/owner`, "utf8");
	} catch {}
	const pid = Number(held.split(" ")[0]);
	if (pid && !alive(pid)) {
		rmSync(dir, { recursive: true, force: true });
		return null;
	}
	return held || "?";
};

/** One mkdir attempt on lock dir `dir`; true when we now own it. */
const tryLock = (dir) => {
	for (let i = 0; i < 2; i++) {
		try {
			mkdirSync(dir, { recursive: false });
			writeFileSync(`${dir}/owner`, owner);
			return true;
		} catch {
			if (holder(dir) !== null) return false; // live owner; else the dead one was removed: retry
		}
	}
	return false;
};

const freeMemory = () => {
	const out = spawnSync("memory_pressure", { encoding: "utf8" }).stdout ?? "";
	const m = /free percentage: (\d+)%/.exec(out);
	return m ? Number(m[1]) : 100;
};

// Ticket names sort into queue order: class (0 = priority, 1 = normal), enqueue time, pid.
const cls = process.env.RENDER_LOCK_PRIORITY === "1" ? 0 : 1;
const ticket = `${cls}-${String(Date.now()).padStart(15, "0")}-${process.pid}`;
mkdirSync(QUEUE, { recursive: true });
writeFileSync(`${QUEUE}/${ticket}`, argv.join(" "));
const dropTicket = () => rmSync(`${QUEUE}/${ticket}`, { force: true });

/** True when no live ticket is ahead of ours (dead waiters' tickets are pruned). */
const atHead = () => {
	for (const t of readdirSync(QUEUE).sort()) {
		if (t === ticket) return true;
		const pid = Number(t.split("-")[2]);
		if (pid && alive(pid)) return false;
		rmSync(`${QUEUE}/${t}`, { force: true });
	}
	return true;
};

const held = [];
const release = () => {
	for (const dir of held.splice(0).reverse())
		rmSync(dir, { recursive: true, force: true });
};
for (const [sig, code] of [
	["SIGINT", 130],
	["SIGTERM", 143],
])
	process.on(sig, () => {
		dropTicket();
		release();
		process.exit(code);
	});

/** At the head of the queue: try to start. Returns a reason string while we must keep waiting. */
const tryStart = () => {
	const legacy = holder(LEGACY);
	if (legacy) return `old-script job: ${legacy}`;
	if (exclusive) {
		// hold every slot we get (so later jobs can't refill them) until we have them all
		for (let i = 0; i < SLOTS; i++)
			if (!held.includes(slotDir(i)) && tryLock(slotDir(i)))
				held.push(slotDir(i));
		if (held.length < SLOTS) return `exclusive, ${held.length}/${SLOTS} slots`;
		if (existsSync(dirname(LEGACY)) && tryLock(LEGACY)) held.push(LEGACY);
		else if (existsSync(dirname(LEGACY))) return "exclusive, legacy lock";
		return "";
	}
	const busy = [];
	for (let i = 0; i < SLOTS; i++) {
		const h = holder(slotDir(i));
		if (h) busy.push(h);
	}
	if (busy.length) {
		if (busy.length >= SLOTS) return `all ${SLOTS} slots busy: ${busy[0]}`;
		let last = 0;
		try {
			last = statSync(LAST_START).mtimeMs;
		} catch {}
		if (Date.now() - last < SETTLE_MS) return "letting the last start settle";
		const free = freeMemory();
		if (free < MIN_FREE)
			return `${busy.length} running, free memory ${free}% < ${MIN_FREE}%`;
	}
	for (let i = 0; i < SLOTS; i++)
		if (tryLock(slotDir(i))) {
			held.push(slotDir(i));
			return "";
		}
	return "slots raced";
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let waited = 0; ; waited += 1) {
	let why;
	if (atHead()) {
		why = tryStart();
		if (!why) break;
	} else {
		// an exclusive job that lost the head (a priority ticket arrived) must hand back the slots it
		// had gathered, or the new head waits on them forever (deadlock seen 2026-10-01)
		if (held.length) release();
		why = `queued (${readdirSync(QUEUE).sort().indexOf(ticket)} ahead)`;
	}
	if (waited % 30 === 0) console.error(`[render-lock] ${why}`);
	await sleep(1000);
}
writeFileSync(LAST_START, owner);
dropTicket();
// Then wait for memory headroom (tm_locks.py; mt-image-58 runs a long render worker + MPS model).
const child = spawn(
	"python3",
	[resolve(import.meta.dirname, "tm_locks.py"), ...argv],
	{ stdio: "inherit" },
);
child.on("exit", (code) => {
	release();
	process.exit(code ?? 1);
});
