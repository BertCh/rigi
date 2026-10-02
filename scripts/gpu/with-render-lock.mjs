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
// It also waits for memory headroom before starting (free memory >= RENDER_LOCK_MEM_MIN_FREE %,
// default 25; bounded by RENDER_LOCK_MEM_WAIT_S, default 600, after which the job starts anyway
// with a warning).
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
import { join } from "node:path";
import { isStaleOwner } from "./render-lock-lib.mjs";

const DIR =
	process.env.RIGI_RENDER_LOCK_DIR || join(homedir(), ".cache", "rigi");
const QUEUE = join(DIR, "render-queue");
const LAST_START = join(DIR, "render-last-start");
const SLOTS = Math.max(1, Number(process.env.RENDER_LOCK_SLOTS) || 3);
const MIN_FREE = Number(process.env.RENDER_LOCK_MIN_FREE) || 40;
// CR-52: a lock dir without a parseable owner pid is reclaimed once it is this old (a live owner
// writes `owner` within milliseconds of the mkdir, so a fresh ownerless dir is left alone)
const OWNERLESS_GRACE_MS = Number(
	process.env.RENDER_LOCK_OWNERLESS_GRACE_MS ?? 10_000,
);
const SETTLE_MS = Number(process.env.RENDER_LOCK_SETTLE_MS ?? 20_000);
const MEM_MIN_FREE = Number(process.env.RENDER_LOCK_MEM_MIN_FREE) || 25;
const MEM_WAIT_S = Number(process.env.RENDER_LOCK_MEM_WAIT_S ?? 600);
const MEM_POLL_S = Number(process.env.RENDER_LOCK_MEM_POLL_S ?? 5);
const slotDir = (i) => join(DIR, `render-lock-${i}`);

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

/** Process start time of `pid` (ps lstart), or "" when unknown. Pairs with the pid to detect recycling. */
const startTime = (pid) => {
	try {
		return (
			spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
				encoding: "utf8",
			}).stdout ?? ""
		).trim();
	} catch {
		return "";
	}
};
const ownStart = startTime(process.pid);

/** Live owner line of lock dir `dir`, or null when it is free (a dead owner's lock is removed). */
const holder = (dir) => {
	if (!existsSync(dir)) return null;
	let held = "";
	try {
		held = readFileSync(`${dir}/owner`, "utf8");
	} catch {}
	const pid = Number(held.split(" ")[0]);
	if (!Number.isInteger(pid) || pid <= 0) {
		// CR-52: ownerless (owner file missing/empty/malformed): stale once past the grace period
		let age = 0;
		try {
			age = Date.now() - statSync(dir).mtimeMs;
		} catch {
			return null; // vanished meanwhile
		}
		if (age < OWNERLESS_GRACE_MS) return held || "?";
		rmSync(dir, { recursive: true, force: true });
		return null;
	}
	// CR-52: a recycled pid is alive but started at another time than the one that took the lock.
	// The start time lives in a separate `start` file next to `owner`; a lock without one keeps the
	// pid-only check.
	let recorded = "";
	try {
		recorded = readFileSync(`${dir}/start`, "utf8").trim();
	} catch {}
	// An unknown current start time (ps failed) never counts as a mismatch: see isStaleOwner.
	const isAlive = alive(pid);
	const current = recorded && isAlive ? startTime(pid) : "";
	if (isStaleOwner({ pid, alive: isAlive, recorded, current })) {
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
			if (ownStart) writeFileSync(`${dir}/start`, ownStart);
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
// CR-02: the job runs in its own process group (spawned detached below). A signal to this wrapper is
// forwarded to that whole group and the lock is released only once the child has exited, so a killed
// wrapper never leaves a job running outside the lock. A second signal, or KILL_GRACE_MS of ignoring
// the first, escalates to SIGKILL. (SIGKILL of the wrapper itself cannot be caught.)
let child = null;
let childGone = false;
let exitCodeFromSignal = null;
const KILL_GRACE_MS = Number(process.env.RENDER_LOCK_KILL_GRACE_MS ?? 10_000);
/** Signal the job's process group (the child is its leader, so its pid is the group id). */
const signalChildGroup = (sig) => {
	if (!child?.pid || childGone) return;
	try {
		process.kill(-child.pid, sig);
	} catch {
		try {
			child.kill(sig);
		} catch {}
	}
};
for (const [sig, code] of [
	["SIGINT", 130],
	["SIGTERM", 143],
	["SIGHUP", 129],
]) {
	process.on(sig, () => {
		dropTicket();
		if (!child || childGone) {
			release();
			process.exit(code);
		}
		if (exitCodeFromSignal !== null) {
			signalChildGroup("SIGKILL");
			return;
		}
		exitCodeFromSignal = code;
		signalChildGroup(sig);
		setTimeout(() => signalChildGroup("SIGKILL"), KILL_GRACE_MS).unref();
	});
}
// last resort (uncaught error): do not leave the job running unlocked
process.on("exit", () => signalChildGroup("SIGKILL"));

/** At the head of the queue: try to start. Returns a reason string while we must keep waiting. */
const tryStart = () => {
	if (exclusive) {
		// hold every slot we get (so later jobs can't refill them) until we have them all
		for (let i = 0; i < SLOTS; i++)
			if (!held.includes(slotDir(i)) && tryLock(slotDir(i)))
				held.push(slotDir(i));
		if (held.length < SLOTS) return `exclusive, ${held.length}/${SLOTS} slots`;
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
// Then wait for memory headroom. The wait is bounded because we already hold a slot: an unbounded
// wait would stall every queued job behind a machine that never frees memory. Swap use is not
// checked: it stays high long after pressure is gone, and gating on it deadlocked the queue.
const memoryWaitStart = Date.now();
let lastMemoryNotice = 0;
while (freeMemory() < MEM_MIN_FREE) {
	if (Date.now() - memoryWaitStart >= MEM_WAIT_S * 1000) {
		console.error(
			`[render-lock] memory headroom wait timed out after ${MEM_WAIT_S.toFixed(0)}s (free ${freeMemory()}%); starting anyway`,
		);
		break;
	}
	if (Date.now() - lastMemoryNotice > 60_000) {
		console.error(
			`[render-lock] waiting for memory headroom (free ${freeMemory()}%)`,
		);
		lastMemoryNotice = Date.now();
	}
	await sleep(MEM_POLL_S * 1000);
}
child = spawn(argv[0], argv.slice(1), { stdio: "inherit", detached: true });
child.on("error", (error) => {
	console.error(`[render-lock] cannot start the job: ${error.message}`);
	childGone = true;
	release();
	process.exit(1);
});
child.on("exit", (code) => {
	// a grandchild that outlived the group leader is stopped before the lock goes
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {}
	childGone = true;
	release();
	process.exit(exitCodeFromSignal ?? code ?? 1);
});
