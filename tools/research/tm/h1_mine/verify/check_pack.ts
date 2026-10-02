// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * npx tsx tools/research/tm/h1_mine/verify/check_pack.ts [--pack ../pack] [--index ../pack_index.json]
 *     [--folders 27] [--overlays 120] [--key <key.json>]
 * Exit 0 = pack matches its index. --key is for AFTER verification only (it reads the key).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { KeyFile } from "./lib";
import { checkPack, crossCheckKey, type PackIndex } from "./pack";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n: string): string | undefined => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const pack = path.resolve(opt("pack") ?? path.join(HERE, "..", "pack"));
const indexFile = path.resolve(
	opt("index") ?? path.join(HERE, "..", "pack_index.json"),
);
const index = JSON.parse(fs.readFileSync(indexFile, "utf8")) as PackIndex;
const n = (k: string) => (opt(k) === undefined ? undefined : Number(opt(k)));
const rep = checkPack(pack, index, {
	folders: n("folders") ?? 27,
	overlays: n("overlays") ?? 120,
});
const problems = [...rep.problems];
const keyFile = opt("key");
if (keyFile)
	problems.push(
		...crossCheckKey(
			rep,
			JSON.parse(fs.readFileSync(path.resolve(keyFile), "utf8")) as KeyFile,
		),
	);
console.log(
	`pack ${pack}: ${rep.nFolders} folders, ${rep.nOverlays} overlays; index ${index.nFolders}/${index.nImages}`,
);
for (const p of problems) console.log("PROBLEM:", p);
console.log(problems.length ? "FAIL" : "OK");
process.exit(problems.length ? 1 : 0);
