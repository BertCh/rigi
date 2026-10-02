// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared helpers for scripts/models (fetch.mjs and the producer scripts).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** sha256 hex of a file (streamed: fine for 100+ MB weights). */
export function sha256File(path) {
	return new Promise((resolve, reject) => {
		const h = createHash("sha256");
		createReadStream(path)
			.on("data", (c) => h.update(c))
			.on("error", reject)
			.on("end", () => resolve(h.digest("hex")));
	});
}

/** Downloads `url` to `out` (via a .part file), printing progress on a TTY. */
export async function download(url, out) {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
	const total = Number(res.headers.get("content-length")) || 0;
	const chunks = [];
	let loaded = 0;
	let last = 0;
	for await (const c of res.body) {
		chunks.push(c);
		loaded += c.byteLength;
		if (process.stderr.isTTY && Date.now() - last > 250) {
			last = Date.now();
			const pct = total ? ` ${((100 * loaded) / total).toFixed(0)}%` : "";
			process.stderr.write(`\r  ${(loaded / 1e6).toFixed(1)} MB${pct}   `);
		}
	}
	if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
	mkdirSync(dirname(out), { recursive: true });
	await writeFile(`${out}.part`, Buffer.concat(chunks));
	renameSync(`${out}.part`, out);
}

/** A Python for producers: $MODELS_PYTHON, then the matcher venv, then python3. */
export function python() {
	if (process.env.MODELS_PYTHON) return process.env.MODELS_PYTHON;
	const venv = join(ROOT, "tools/matcher/.venv/bin/python");
	return existsSync(venv) ? venv : "python3";
}

/** Runs a command, inheriting stdio; throws on a non-zero exit. */
export function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
	if (r.status !== 0)
		throw new Error(`${cmd} ${args.join(" ")} exited ${r.status ?? r.signal}`);
}
