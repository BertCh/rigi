#!/usr/bin/env node
// Run a command while holding the machine-wide "one playwright/render job at a time" lock
// (see the 2026-09-26 crash notes: 19 GB swap + full disk). The lock is a directory, created
// atomically with mkdir; a lock whose owner pid is dead is stolen.
// It also waits for memory headroom before starting (see tm_locks.py).
// Usage: node scripts/gpu/with-render-lock.mjs -- node scripts/eval-app.mjs IMG_6958
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const LOCK = resolve(import.meta.dirname, "../../out/.render-lock");
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

let waited = 0;
for (;;) {
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
			console.error(`[render-lock] waiting for: ${owner || "?"}`);
		await new Promise((r) => setTimeout(r, 2000));
		waited += 2;
	}
}
const release = () => rmSync(LOCK, { recursive: true, force: true });
process.on("SIGINT", () => {
	release();
	process.exit(130);
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
