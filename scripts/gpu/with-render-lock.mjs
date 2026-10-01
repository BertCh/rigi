#!/usr/bin/env node
// Run a command while holding the machine-wide "one playwright/render job at a time" lock
// (see the 2026-09-26 crash notes: 19 GB swap + full disk). The lock is a directory, created
// atomically with mkdir; a lock whose owner pid is dead is stolen.
// Waiters queue FIFO: each takes a ticket and only tries the lock when its ticket is the oldest
// live one, so nobody loses a polling race or has to ask peers to pause.
// RENDER_LOCK_PRIORITY=1 (a job the user is waiting on) queues ahead of normal tickets.
// The lock and queue live outside any tree (RIGI_RENDER_LOCK_DIR, default ~/.cache/rigi), so
// sandbox clones and copies of this script all share one queue.
// It also waits for memory headroom before starting (see tm_locks.py).
// Usage: node scripts/gpu/with-render-lock.mjs -- node scripts/eval-app.mjs IMG_6958
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DIR =
	process.env.RIGI_RENDER_LOCK_DIR || join(homedir(), ".cache", "rigi");
const LOCK = join(DIR, "render-lock");
const QUEUE = join(DIR, "render-queue");
// Transition (remove after 2026-10): scripts from before the shared dir lock <real tree>/out/.render-lock.
// We take it too, after our own lock, so old-script jobs and new ones exclude each other. It must be
// the real tree's absolute path: a sandbox copy's out/ holds a private (possibly stale, cloned) lock.
const LEGACY =
	process.env.RIGI_LEGACY_RENDER_LOCK ??
	join(homedir(), "Documents/GitHub/mt-image/out/.render-lock");

const argv = process.argv.slice(process.argv.indexOf("--") + 1);
if (!argv.length) {
	console.error("usage: with-render-lock.mjs -- <cmd> [args…]");
	process.exit(2);
}
const owner = `${process.pid} ${argv.join(" ")}`;

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** One mkdir attempt on lock dir `dir`. Returns true when we own it; steals a dead owner's lock. Otherwise returns the holder. */
const tryLock = (dir) => {
	for (;;) {
		try {
			mkdirSync(dir, { recursive: false });
			writeFileSync(`${dir}/owner`, owner);
			return true;
		} catch {
			let held = "";
			try {
				held = readFileSync(`${dir}/owner`, "utf8");
			} catch {}
			const pid = Number(held.split(" ")[0]);
			if (pid && !alive(pid)) {
				rmSync(dir, { recursive: true, force: true });
				continue;
			}
			return held || "?";
		}
	}
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let waited = 0;
for (;;) {
	if (atHead()) {
		const got = tryLock(LOCK);
		if (got === true) break;
		if (waited % 30 === 0)
			console.error(`[render-lock] next in line; running: ${got}`);
	} else if (waited % 30 === 0) {
		const ahead = readdirSync(QUEUE).sort().indexOf(ticket);
		console.error(`[render-lock] queued (${ahead} ahead)`);
	}
	await sleep(1000);
	waited += 1;
}
held.push(LOCK);
dropTicket();
if (existsSync(dirname(LEGACY)))
	for (waited = 0; ; waited += 1) {
		const got = tryLock(LEGACY);
		if (got === true) {
			held.push(LEGACY);
			break;
		}
		if (waited % 30 === 0)
			console.error(`[render-lock] waiting for legacy lock: ${got}`);
		await sleep(1000);
	}
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
