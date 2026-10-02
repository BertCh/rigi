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
// - luma master HEAD vs the first "base: luma master `<sha>`" line of vendor/luma/README.md;
// - each vendored luma PR (the numbers in VENDORED_PRS, heads recorded in vendor/luma/README.md):
//   state, merged, live head vs the recorded head (head moved = the PR changed since we vendored it);
// - the same for each vendored deck.gl PR (DECK_VENDORED_PRS, heads recorded in vendor/deck/README.md);
// - the watch PRs / issues (state, merged, last update).
//
// A "recorded head" is every sha (7-40 hex chars) that a README quotes within 60 characters after
// "#<number>" (not counting a note that says the head "moved to" a sha); a head counts as moved when
// the live head starts with none of them (so a README that quotes both an old and a new head, as for
// luma #3345, reads as unchanged once it names the new one).
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = new URL("../../", import.meta.url);
const asJson = process.argv.includes("--json");

const LUMA = "visgl/luma.gl";
const DECK = "visgl/deck.gl";
// PRs merged into the vendored builds (vendor/luma/README.md, "Source")
const VENDORED_PRS = [
	3313, 3302, 3287, 3328, 3333, 3334, 3330, 3345, 3340, 3338, 3332, 3326, 3331,
	3286, 3288, 3351, 3346, 3132, 3337,
];
// PRs merged into the vendored deck.gl build (vendor/deck/README.md, "Source")
const DECK_VENDORED_PRS = [
	10752, 10780, 10779, 10778, 10782, 10753, 10776, 10751, 10783,
];
// looked at, not vendored
const WATCH = [
	{ repo: LUMA, kind: "issues", numbers: [3329] },
	{ repo: DECK, kind: "pull", numbers: [10627] },
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
const deckReadme = await readFile(
	new URL("vendor/deck/README.md", root),
	"utf8",
);
// the first "base: luma master `<sha>`" line (the newest build's base)
const baseSha =
	readme.match(/base: luma master `([0-9a-f]{40})`/i)?.[1] ?? null;
// every sha a README quotes within 60 characters after "#<number>", in order of appearance; a quote
// whose gap says "moved" (a note that the live head moved on, as in "#3346's head moved to `sha`")
// is an acknowledgement, not the head that was vendored, so it does not count
const recordedHeadsIn = (text, number) =>
	[
		...text.matchAll(
			new RegExp(`#${number}\\b([^\`]{0,60})\`([0-9a-f]{7,40})\``, "g"),
		),
	]
		.filter((m) => !/moved/i.test(m[1]))
		.map((m) => m[2]);
const checkVendored = async (repo, readmeText, number) => {
	const pr = await gh(`repos/${repo}/pulls/${number}`, PR_JQ);
	const recorded = recordedHeadsIn(readmeText, number);
	const live = pr?.head ?? null;
	// the recorded head to show: the one the live head matches, else the first quoted
	const shown =
		recorded.find((sha) => live?.startsWith(sha)) ?? recorded[0] ?? null;
	return {
		number,
		state: pr ? (pr.merged ? "merged" : pr.state) : "?",
		title: pr?.title ?? null,
		recordedHead: shown,
		liveHead: live,
		headMoved:
			pr && recorded.length
				? !recorded.some((sha) => live.startsWith(sha))
				: null,
		updated: pr?.updated ?? null,
	};
};

const PR_JQ =
	"{state: .state, merged: (.merged // false), head: (.head.sha // null), title: .title, updated: .updated_at}";
const ISSUE_JQ =
	"{state: .state, merged: false, head: null, title: .title, updated: .updated_at}";

const [lumaTags, deckTags, master, vendored, deckVendored, watch] =
	await Promise.all([
		distTags("@luma.gl/core"),
		distTags("@deck.gl/core"),
		gh(
			`repos/${LUMA}/commits/master`,
			'{sha: .sha, date: .commit.committer.date, subject: (.commit.message | split("\\n")[0])}',
		),
		Promise.all(VENDORED_PRS.map((n) => checkVendored(LUMA, readme, n))),
		Promise.all(
			DECK_VENDORED_PRS.map((n) => checkVendored(DECK, deckReadme, n)),
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
	vendoredDeckPrs: deckVendored,
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
	const printVendored = (title, list) => {
		console.log(`\n${title} (recorded head vs live)`);
		for (const p of list)
			console.log(
				`  #${String(p.number).padEnd(5)} ${p.state.padEnd(7)} ${short(p.recordedHead)} -> ${short(p.liveHead)}  ${p.headMoved === null ? "?" : p.headMoved ? "HEAD MOVED" : "unchanged"}  ${clip(p.title, 50)}`,
			);
	};
	printVendored("vendored luma PRs", vendored);
	printVendored("vendored deck PRs", deckVendored);
	console.log("\nwatch list");
	for (const w of watch)
		console.log(
			`  ${w.repo.split("/")[0] === "visgl" ? w.repo.split("/")[1].padEnd(8) : w.repo} ${w.kind === "pr" ? "#" : "i#"}${String(w.number).padEnd(6)} ${w.state.padEnd(7)} ${day(w.updated)}  ${clip(w.title, 60)}`,
		);
	for (const note of notes) console.log(`note: ${note}`);
}
process.exit(0);
