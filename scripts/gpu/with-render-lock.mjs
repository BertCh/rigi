#!/usr/bin/env node
// Run a command while holding the machine-wide "one playwright/render job at a time" lock
// (see the 2026-09-26 crash notes: 19 GB swap + full disk). The lock is a directory, created
// atomically with mkdir; a lock whose owner pid is dead is stolen.
// Waiters queue FIFO: each takes a ticket in out/.render-queue and only tries the lock when its
// ticket is the oldest live one, so nobody loses a polling race or has to ask peers to pause.
// RENDER_LOCK_PRIORITY=1 (a job the user is waiting on) queues ahead of normal tickets.
// It also waits for memory headroom before starting (see tm_locks.py).
// Usage: node scripts/gpu/with-render-lock.mjs -- node scripts/eval-app.mjs IMG_6958
import { spawn } from "node:child_process";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const LOCK = resolve(import.meta.dirname, "../../out/.render-lock");
const QUEUE = resolve(import.meta.dirname, "../../out/.render-queue");
const argv = process.argv.slice(process.argv.indexOf("--") + 1);
if (!argv.length) {
	console.error("usage: with-render-lock.mjs -- <cmd> [args…]");
	process.exit(2);
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
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

const onSignal = (code) => () => {
	dropTicket();
	process.exit(code);
};
process.on("SIGINT", onSignal(130));
process.on("SIGTERM", onSignal(143));

let waited = 0;
for (;;) {
	if (atHead()) {
		try {
			mkdirSync(LOCK, { recursive: false });
			writeFileSync(`${LOCK}/owner`, `${process.pid} ${argv.join(" ")}`);
			break;
		} catch {
			let owner = "";
			try {
				owner = readFileSync(`${LOCK}/owner`, "utf8");
			} catch {}
			const pid = Number(owner.split(" ")[0]);
			if (pid && !alive(pid)) {
				rmSync(LOCK, { recursive: true, force: true });
				continue;
			}
			if (waited % 30 === 0)
				console.error(`[render-lock] next in line; running: ${owner || "?"}`);
		}
	} else if (waited % 30 === 0) {
		const ahead = readdirSync(QUEUE).sort().indexOf(ticket);
		console.error(`[render-lock] queued (${ahead} ahead)`);
	}
	await new Promise((r) => setTimeout(r, 1000));
	waited += 1;
}
dropTicket();
const release = () => rmSync(LOCK, { recursive: true, force: true });
process.removeAllListeners("SIGINT");
process.removeAllListeners("SIGTERM");
for (const [sig, code] of [
	["SIGINT", 130],
	["SIGTERM", 143],
])
	process.on(sig, () => {
		release();
		process.exit(code);
	});
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
