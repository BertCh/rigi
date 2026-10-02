// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Upstream drift report for the luma.gl / deck.gl watch list (roadmap LF8). Read-only: GitHub
// GET calls through `gh api` and one npm registry GET. Needs network and a logged-in `gh`, so it is
// NOT a CI check. Always exits 0 (a failed lookup prints "?" and a note).
//
//   node scripts/upstream/luma-watch.mjs [--json]
//
// Sections:
// - npm dist-tags of @luma.gl/core and @deck.gl/core;
// - luma master HEAD vs the "Base: luma master `<sha>`" line of vendor/luma/README.md;
// - each vendored PR (the "#N head `<sha>`" lines of that README): state, merged, live head vs the
//   recorded head (head moved = the PR changed since we vendored it);
// - the watch PRs / issues (state, merged, last update).
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = new URL("../../", import.meta.url);
const asJson = process.argv.includes("--json");

const LUMA = "visgl/luma.gl";
const DECK = "visgl/deck.gl";
const VENDORED_PRS = [3313, 3302, 3287, 3328, 3333, 3334, 3330];
const WATCH = [
	{ repo: LUMA, kind: "pull", numbers: [3340, 3326, 3286, 3288] },
	{ repo: LUMA, kind: "issues", numbers: [3329] },
	{
		repo: DECK,
		kind: "pull",
		numbers: [10752, 10627, 10778, 10782, 10751, 10783],
	},
];

const notes = [];
const gh = async (path, jq) => {
	try {
		const { stdout } = await run("gh", ["api", path, "--jq", jq], {
			timeout: 30000,
		});
		return JSON.parse(stdout);
	} catch (error) {
		notes.push(
			`gh api ${path}: ${
				String(error.stderr || error.message)
					.trim()
					.split("\n")[0]
			}`,
		);
		return null;
	}
};
const distTags = async (name) => {
	try {
		const response = await fetch(
			`https://registry.npmjs.org/-/package/${name}/dist-tags`,
		);
		return await response.json();
	} catch (error) {
		notes.push(`npm ${name}: ${error.message}`);
		return null;
	}
};
const short = (sha) => (sha ? sha.slice(0, 8) : "?");

const readme = await readFile(new URL("vendor/luma/README.md", root), "utf8");
const baseSha = readme.match(/Base: luma master `([0-9a-f]{40})`/)?.[1] ?? null;
const recordedHeads = Object.fromEntries(
	[...readme.matchAll(/#(\d+) head `([0-9a-f]{40})`/g)].map((m) => [
		Number(m[1]),
		m[2],
	]),
);

const PR_JQ =
	"{state: .state, merged: (.merged // false), head: (.head.sha // null), title: .title, updated: .updated_at}";
const ISSUE_JQ =
	"{state: .state, merged: false, head: null, title: .title, updated: .updated_at}";

const [lumaTags, deckTags, master, vendored, watch] = await Promise.all([
	distTags("@luma.gl/core"),
	distTags("@deck.gl/core"),
	gh(
		`repos/${LUMA}/commits/master`,
		'{sha: .sha, date: .commit.committer.date, subject: (.commit.message | split("\\n")[0])}',
	),
	Promise.all(
		VENDORED_PRS.map(async (number) => {
			const pr = await gh(`repos/${LUMA}/pulls/${number}`, PR_JQ);
			const recorded = recordedHeads[number] ?? null;
			return {
				number,
				state: pr ? (pr.merged ? "merged" : pr.state) : "?",
				title: pr?.title ?? null,
				recordedHead: recorded,
				liveHead: pr?.head ?? null,
				headMoved: pr && recorded ? pr.head !== recorded : null,
				updated: pr?.updated ?? null,
			};
		}),
	),
	Promise.all(
		WATCH.flatMap(({ repo, kind, numbers }) =>
			numbers.map(async (number) => {
				const item = await gh(
					`repos/${repo}/${kind === "pull" ? "pulls" : "issues"}/${number}`,
					kind === "pull" ? PR_JQ : ISSUE_JQ,
				);
				return {
					repo,
					number,
					kind: kind === "pull" ? "pr" : "issue",
					state: item ? (item.merged ? "merged" : item.state) : "?",
					title: item?.title ?? null,
					updated: item?.updated ?? null,
				};
			}),
		),
	),
]);

const report = {
	npm: { "@luma.gl/core": lumaTags, "@deck.gl/core": deckTags },
	lumaMaster: {
		base: baseSha,
		head: master?.sha ?? null,
		behind: master && baseSha ? master.sha !== baseSha : null,
		headDate: master?.date ?? null,
		headSubject: master?.subject ?? null,
	},
	vendoredPrs: vendored,
	watch,
	notes,
};

if (asJson) {
	console.log(JSON.stringify(report, null, 2));
} else {
	const day = (iso) => (iso ? iso.slice(0, 10) : "?");
	const clip = (text, n) =>
		text && text.length > n ? `${text.slice(0, n - 1)}~` : (text ?? "");
	console.log("npm dist-tags");
	for (const [name, tags] of Object.entries(report.npm))
		console.log(
			`  ${name.padEnd(16)} ${
				tags
					? Object.entries(tags)
							.map(([t, v]) => `${t}=${v}`)
							.join("  ")
					: "?"
			}`,
		);
	const m = report.lumaMaster;
	console.log("\nluma master");
	console.log(
		`  base ${short(m.base)}  head ${short(m.head)} (${day(m.headDate)})  ${m.behind === null ? "?" : m.behind ? "MOVED" : "same"}  ${clip(m.headSubject, 60)}`,
	);
	console.log("\nvendored luma PRs (recorded head vs live)");
	for (const p of vendored)
		console.log(
			`  #${String(p.number).padEnd(5)} ${p.state.padEnd(7)} ${short(p.recordedHead)} -> ${short(p.liveHead)}  ${p.headMoved === null ? "?" : p.headMoved ? "HEAD MOVED" : "unchanged"}  ${clip(p.title, 50)}`,
		);
	console.log("\nwatch list");
	for (const w of watch)
		console.log(
			`  ${w.repo.split("/")[0] === "visgl" ? w.repo.split("/")[1].padEnd(8) : w.repo} ${w.kind === "pr" ? "#" : "i#"}${String(w.number).padEnd(6)} ${w.state.padEnd(7)} ${day(w.updated)}  ${clip(w.title, 60)}`,
		);
	for (const note of notes) console.log(`note: ${note}`);
}
process.exit(0);
