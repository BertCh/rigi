// WP-F node helpers: a disk-caching RangeFetcher / JsonFetcher for swiss-cog.ts (probe + eval scripts only).
// Cache: tools/concord/occl/cache (keep ≤ 50 MB; `du -sh` it). Set OCCL_NOCACHE=1 to bypass reads + writes.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
	JsonFetcher,
	RangeFetcher,
} from "../../../src/lib/concord/occl/swiss-cog";
import {
	httpJsonFetcher,
	httpRangeFetcher,
} from "../../../src/lib/concord/occl/swiss-cog";

export const CACHE_DIR = path.join(import.meta.dirname, "cache");
export const CACHE_LIMIT = 50 * 1024 * 1024;

const h = (s: string) =>
	createHash("sha1").update(s).digest("hex").slice(0, 20);
const noCache = () => process.env.OCCL_NOCACHE === "1";

export function cacheBytes(): number {
	if (!fs.existsSync(CACHE_DIR)) return 0;
	let n = 0;
	for (const f of fs.readdirSync(CACHE_DIR))
		n += fs.statSync(path.join(CACHE_DIR, f)).size;
	return n;
}

/** Counts real network bytes separately from cache hits. */
export const netStats = { requests: 0, bytes: 0, hits: 0, hitBytes: 0 };

export const cachedRangeFetcher: RangeFetcher = async (url, a, b, signal) => {
	const f = path.join(CACHE_DIR, `${h(`${url}|${a}|${b}`)}.bin`);
	if (!noCache() && fs.existsSync(f)) {
		const buf = new Uint8Array(fs.readFileSync(f));
		netStats.hits++;
		netStats.hitBytes += buf.length;
		return buf;
	}
	const buf = await httpRangeFetcher(url, a, b, signal);
	netStats.requests++;
	netStats.bytes += buf.length;
	if (!noCache() && cacheBytes() + buf.length <= CACHE_LIMIT) {
		fs.mkdirSync(CACHE_DIR, { recursive: true });
		fs.writeFileSync(f, buf);
	}
	return buf;
};

export const cachedJsonFetcher: JsonFetcher = async (url, signal) => {
	const f = path.join(CACHE_DIR, `${h(url)}.json`);
	if (!noCache() && fs.existsSync(f))
		return JSON.parse(fs.readFileSync(f, "utf8"));
	const j = await httpJsonFetcher(url, signal);
	const txt = JSON.stringify(j);
	if (!noCache() && cacheBytes() + txt.length <= CACHE_LIMIT) {
		fs.mkdirSync(CACHE_DIR, { recursive: true });
		fs.writeFileSync(f, txt);
	}
	return j;
};
