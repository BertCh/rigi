// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Byte-range support of the tile cache (WAG W2.5). Run: npx tsx src/lib/cache/range.check.ts
//  - each range is its own entry (key = url + range), separate from the whole-file entry
//  - repeats are served from memory, concurrent equal ranges share one request
//  - a server that ignores Range (200, whole file) is sliced to the range; 206 bodies pass through
//  - the Range header is sent; non-2xx makes cachedFetchRange throw
import { cachedFetchRange, configureTileCache, rangeKey, TileCache } from ".";

let failures = 0;
const ok = (c: boolean, m: string) => {
	console.log(`${c ? "PASS" : "FAIL"}  ${m}`);
	if (!c) failures++;
};

const FILE = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 255);
const calls: { url: string; range: string | null }[] = [];
/** A server: honours Range on /ranged, ignores it on /plain (200 + whole file), 404 elsewhere. */
const server = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	const range = new Headers(init?.headers).get("Range");
	calls.push({ url, range });
	if (!url.endsWith("/ranged") && !url.endsWith("/plain"))
		return new Response(null, { status: 404 });
	const m = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
	if (url.endsWith("/ranged") && m) {
		const a = Number(m[1]);
		const b = Math.min(Number(m[2]), FILE.length - 1);
		return new Response(FILE.slice(a, b + 1), {
			status: 206,
			headers: { "Content-Range": `bytes ${a}-${b}/${FILE.length}` },
		});
	}
	return new Response(FILE.slice(), { status: 200 });
}) as typeof fetch;

const same = (a: Uint8Array, b: Uint8Array) =>
	a.length === b.length && a.every((v, i) => v === b[i]);

const cache = new TileCache({ fetch: server, backend: "memory" });
const R = "https://example.test/ranged";
const P = "https://example.test/plain";

{
	const r = await cache.get(R, { range: [10, 19] });
	ok(
		r.source === "network" && same(new Uint8Array(r.body), FILE.slice(10, 20)),
		"206: body is bytes 10–19",
	);
	ok(calls.at(-1)?.range === "bytes=10-19", "Range header sent");
	const again = await cache.get(R, { range: [10, 19] });
	ok(
		again.source === "memory" && calls.length === 1,
		"repeat range: memory hit, no request",
	);
	const other = await cache.get(R, { range: [20, 29] });
	ok(
		other.source === "network" &&
			same(new Uint8Array(other.body), FILE.slice(20, 30)),
		"another range of the same url: its own entry",
	);
	const whole = await cache.get(R);
	ok(
		whole.source === "network" &&
			whole.body.byteLength === FILE.length &&
			calls.at(-1)?.range === null,
		"whole file: separate entry, no Range header",
	);
	ok(
		rangeKey(R, 1, 2) === `${R} bytes=1-2` && rangeKey(R, 1, 2) !== R,
		"rangeKey distinct from the url",
	);
}
{
	const before = calls.length;
	const [a, b] = await Promise.all([
		cache.get(R, { range: [100, 199] }),
		cache.get(R, { range: [100, 199] }),
	]);
	ok(
		calls.length === before + 1 &&
			same(new Uint8Array(a.body), new Uint8Array(b.body)),
		"concurrent equal ranges share one request",
	);
}
{
	const r = await cache.get(P, { range: [990, 1009] });
	ok(
		r.status === 200 && same(new Uint8Array(r.body), FILE.slice(990, 1000)),
		"server ignoring Range (200): sliced to the range (short at end of file)",
	);
}
{
	configureTileCache({ fetch: server, backend: "memory" });
	const b = await cachedFetchRange(R, 0, 3);
	ok(same(b, FILE.slice(0, 4)), "cachedFetchRange returns the range bytes");
	let threw = false;
	try {
		await cachedFetchRange("https://example.test/missing", 0, 3);
	} catch {
		threw = true;
	}
	ok(threw, "cachedFetchRange throws on 404");
}

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\ncache range check: ok");
process.exit(0);
