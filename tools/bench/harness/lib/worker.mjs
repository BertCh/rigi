// Client for tools/matcher/server/render_worker.mjs (one JSON line per request/reply).
// The harness spawns its own worker (own headless Chromium), independent of the :8765 service.
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

export const ROOT = path.resolve(import.meta.dirname, "../../../..");

export class Worker {
	constructor({ maxPages = 2, port = "0" } = {}) {
		this.seq = 0;
		this.waiting = new Map();
		this.proc = spawn(
			"node",
			[path.join(ROOT, "tools/matcher/server/render_worker.mjs")],
			{
				cwd: ROOT,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					MATCHER_MAX_PAGES: String(maxPages),
					MATCHER_PORT: String(process.env.MATCHER_PORT ?? 8765),
				},
			},
		);
		this.stderr = [];
		readline.createInterface({ input: this.proc.stderr }).on("line", (l) => {
			this.stderr.push(l);
			if (this.stderr.length > 200) this.stderr.shift();
			if (process.env.HARNESS_VERBOSE) console.error(l);
		});
		readline.createInterface({ input: this.proc.stdout }).on("line", (l) => {
			let m;
			try {
				m = JSON.parse(l);
			} catch {
				return;
			}
			const w = this.waiting.get(m.id);
			if (w) {
				this.waiting.delete(m.id);
				clearTimeout(w.timer);
				w.resolve(m);
			}
		});
		this.proc.on("exit", (code) => {
			for (const w of this.waiting.values())
				w.reject(
					new Error(
						`render worker exited (${code}): ${this.stderr.slice(-5).join(" | ")}`,
					),
				);
			this.waiting.clear();
			this.dead = true;
		});
	}

	call(req, timeoutMs = 300000) {
		if (this.dead) return Promise.reject(new Error("render worker is dead"));
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				reject(new Error(`worker ${req.cmd} timed out after ${timeoutMs} ms`));
			}, timeoutMs);
			this.waiting.set(id, { resolve, reject, timer });
			this.proc.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
		});
	}

	async close() {
		if (this.dead) return;
		this.proc.stdin.end();
		await new Promise((r) => {
			const t = setTimeout(() => {
				this.proc.kill();
				r();
			}, 10000);
			this.proc.on("exit", () => {
				clearTimeout(t);
				r();
			});
		});
	}
}
