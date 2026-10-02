// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cli = join(__dirname, "..", "summarize-log.ts");
const run = (...args: string[]) =>
	spawnSync("npx", ["tsx", cli, ...args], { encoding: "utf8" });

describe("summarize-log CLI", () => {
	it("prints a summary of an exported file and exits 2 without args", () => {
		const dir = mkdtempSync(join(tmpdir(), "picker-"));
		const f = join(dir, "log.json");
		const e = {
			t: "2026-10-02T00:00:00Z",
			photoId: "p",
			renderer: "deck",
			alignState: null,
			verify: null,
			session: "s",
		};
		writeFileSync(
			f,
			JSON.stringify({
				schema: "rigi.picker.log.v1",
				version: 1,
				events: [
					{ kind: "shown", candidates: [], shownIndex: 0, ...e },
					{ kind: "dismiss", ...e },
					{ junk: 1 },
				],
			}),
		);
		const ok = run(f);
		expect(ok.status).toBe(0);
		expect(ok.stdout).toContain("episodes (picker opened on a photo): 1");
		expect(ok.stdout).toContain("dropped 1 unreadable");
		expect(run().status).toBe(2);
	});
});
