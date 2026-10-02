// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * npx tsx tools/research/tm/h1_mine/verify/make_session.ts --verifier va --batch 0 [--out verify/out/session_va_b0.html]
 * Writes one static page (open it from disk: no server, no key). Items are in a seeded order (see lib.ts
 * buildSessionOrder). With --batch omitted all folders are in one session.
 * Give each fresh verifier ONLY the pack folders of their batch plus this page (see HUMAN_RUN.txt).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSessionOrder } from "./lib";
import { checkPack, type PackIndex } from "./pack";
import { renderSessionHtml } from "./session";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n: string) => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const verifier = opt("verifier");
if (!verifier || !/^[A-Za-z0-9_-]{1,16}$/.test(verifier))
	throw new Error("--verifier <id> (letters/digits, <=16) is required");
const pack = path.resolve(opt("pack") ?? path.join(HERE, "..", "pack"));
const index = JSON.parse(
	fs.readFileSync(path.join(HERE, "..", "pack_index.json"), "utf8"),
) as PackIndex;
const rep = checkPack(pack, index);
if (!rep.ok)
	throw new Error(`pack does not match its index:\n${rep.problems.join("\n")}`);
const batch = opt("batch") === undefined ? null : Number(opt("batch"));
const folders = batch === null ? index.folders : index.suggestedBatches[batch];
if (!folders) throw new Error(`no batch ${batch}`);
const out = path.resolve(
	opt("out") ??
		path.join(
			HERE,
			"out",
			`session_${verifier}${batch === null ? "" : `_b${batch}`}.html`,
		),
);
fs.mkdirSync(path.dirname(out), { recursive: true });
let packUrl = path.relative(path.dirname(out), pack).split(path.sep).join("/");
packUrl = `${packUrl}/`;
const items = buildSessionOrder(rep.labelsByFolder, verifier, folders);
fs.writeFileSync(out, renderSessionHtml({ verifier, batch, items, packUrl }));
console.log(`${out}: ${items.length} items in ${folders.length} folders`);
