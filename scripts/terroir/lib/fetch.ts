// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Cached downloads for the terroir build (reruns never re-download).
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CACHE =
	process.env.TERROIR_CACHE ?? join(homedir(), ".cache", "rigi", "terroir");
export const UA =
	"rigi-terroir-build/1.0 (https://github.com; contact rgcgeog@gmail.com)";
mkdirSync(CACHE, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getBuf(
	url: string,
	init: RequestInit = {},
	tries = 4,
): Promise<Buffer> {
	let err: unknown;
	for (let i = 0; i < tries; i++) {
		try {
			const r = await fetch(url, {
				...init,
				headers: {
					"User-Agent": UA,
					Accept: "*/*",
					...(init.headers as object),
				},
			});
			if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 120)}`);
			return Buffer.from(await r.arrayBuffer());
		} catch (e) {
			err = e;
			await sleep(1500 * (i + 1));
		}
	}
	throw err;
}

/** Download `url` to CACHE/<rel> unless present. */
export async function cached(
	rel: string,
	url: string,
	init?: RequestInit,
): Promise<string> {
	const f = join(CACHE, rel);
	if (!existsSync(f)) {
		mkdirSync(dirname(f), { recursive: true });
		console.log("  download", url.slice(0, 110));
		writeFileSync(f, await getBuf(url, init));
	}
	return f;
}

/** Download a zip, extract (optionally only `members`) into CACHE/<dir>, delete the zip. Marker file avoids repeats. */
export async function cachedZip(
	dir: string,
	url: string,
	members: string[] = [],
): Promise<string> {
	const out = join(CACHE, dir);
	const marker = join(out, ".done");
	if (!existsSync(marker)) {
		mkdirSync(out, { recursive: true });
		const zip = join(CACHE, `${dir.replace(/\//g, "_")}.zip`);
		console.log("  download", url.slice(0, 110));
		writeFileSync(zip, await getBuf(url));
		execFileSync("unzip", ["-o", "-q", zip, ...members, "-d", out]);
		rmSync(zip);
		writeFileSync(marker, "ok");
	}
	return out;
}

export const readJsonCache = <T>(rel: string): T | null => {
	const f = join(CACHE, rel);
	return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : null;
};
