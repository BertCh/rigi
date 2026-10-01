#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Dev launcher: the frontend (vite, :3100) plus, optionally, the Python backends.
//   node scripts/dev.mjs                      # frontend only (same as `npm run dev`)
//   node scripts/dev.mjs --be                 # + matcher (:8765) + near-field (:8767)
//   node scripts/dev.mjs --be=nearfield       # + just the named backends (matcher,nearfield)
// A service whose port is already listening is reused, not restarted (several sessions share this tree).
// A backend whose venv is missing is skipped with a warning: the app runs without it.
// Ctrl-C stops every process this script started.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENV_PY = `${ROOT}tools/matcher/.venv/bin/python`;

const SERVICES = {
	fe: {
		port: 3100,
		cmd: `${ROOT}node_modules/.bin/vite`,
		args: ["dev", "--port", "3100", "--strictPort"],
		color: 36,
	},
	matcher: {
		port: 8765,
		cmd: `${ROOT}tools/matcher/server/run.sh`,
		args: ["--port", "8765"],
		needs: VENV_PY,
		color: 35,
	},
	nearfield: {
		port: 8767,
		cmd: `${ROOT}tools/nearfield/run.sh`,
		args: ["--port", "8767"],
		needs: VENV_PY,
		color: 33,
	},
};
const BACKENDS = ["matcher", "nearfield"];

const beArg = process.argv
	.slice(2)
	.find((a) => a === "--be" || a.startsWith("--be="));
const backends = !beArg
	? []
	: beArg === "--be"
		? BACKENDS
		: beArg.slice(5).split(",").filter(Boolean);
for (const b of backends) {
	if (!BACKENDS.includes(b)) {
		console.error(`unknown backend "${b}" (expected: ${BACKENDS.join(", ")})`);
		process.exit(2);
	}
}

// vite binds [::1] only, the Python services 127.0.0.1 only: probe both.
const probe = (port, host) =>
	new Promise((resolve) => {
		const s = createConnection({ port, host });
		s.once("connect", () => {
			s.destroy();
			resolve(true);
		});
		s.once("error", () => resolve(false));
	});
const listening = async (port) =>
	(await Promise.all([probe(port, "127.0.0.1"), probe(port, "::1")])).some(Boolean);

const tag = (name, color) => `\x1b[${color}m[${name.padEnd(9)}]\x1b[0m `;
const pipe = (stream, out, prefix) => {
	let buf = "";
	stream.on("data", (d) => {
		buf += d;
		const lines = buf.split("\n");
		buf = lines.pop();
		for (const l of lines) out.write(`${prefix}${l}\n`);
	});
};

const children = [];
let stopping = false;
const stopAll = (code = 0) => {
	if (stopping) return;
	stopping = true;
	for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
	setTimeout(() => process.exit(code), 1500).unref();
};
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

for (const name of ["fe", ...backends]) {
	const svc = SERVICES[name];
	const prefix = tag(name, svc.color);
	if (await listening(svc.port)) {
		console.log(`${prefix}:${svc.port} already listening, reusing it`);
		continue;
	}
	if (svc.needs && !existsSync(svc.needs)) {
		console.log(
			`${prefix}skipped: ${svc.needs} missing (the app runs without ${name})`,
		);
		continue;
	}
	const child = spawn(svc.cmd, svc.args, {
		cwd: ROOT,
		stdio: ["ignore", "pipe", "pipe"],
	});
	pipe(child.stdout, process.stdout, prefix);
	pipe(child.stderr, process.stderr, prefix);
	child.on("exit", (code, sig) => {
		console.log(`${prefix}exited (${sig ?? code})`);
		// The frontend is the point of this script; a backend dying leaves the app usable.
		if (name === "fe" && !stopping) stopAll(code ?? 1);
	});
	children.push(child);
	console.log(`${prefix}started on :${svc.port} (pid ${child.pid})`);
}

if (children.length === 0) {
	console.log("everything requested is already running; nothing to do");
	process.exit(0);
}
