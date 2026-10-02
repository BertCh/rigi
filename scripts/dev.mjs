#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Dev launcher: `vite dev --port 3100 --strictPort`, reused when something already listens on :3100
// (several sessions share this tree). Everything the app computes runs in the browser; there is no
// backend to start. Ctrl-C stops the server this script started.
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 3100;

// vite may bind [::1] or 127.0.0.1: probe both.
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
	(await Promise.all([probe(port, "127.0.0.1"), probe(port, "::1")])).some(
		Boolean,
	);

if (await listening(PORT)) {
	console.log(`:${PORT} already listening, reusing it`);
	process.exit(0);
}
const child = spawn(
	`${ROOT}node_modules/.bin/vite`,
	["dev", "--port", String(PORT), "--strictPort"],
	{ cwd: ROOT, stdio: "inherit" },
);
const stop = () => {
	if (child.exitCode === null) child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
