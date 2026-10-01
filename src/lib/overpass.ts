// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Overpass API transport, shared by the upload regions, the /baseline worker, scripts/ and the bench
 * harness. Queries and tag parsing stay with each caller (their `ele` parsers differ on purpose).
 */
export const OVERPASS = {
	main: "https://overpass-api.de/api/interpreter",
	coffee: "https://overpass.private.coffee/api/interpreter",
	kumi: "https://overpass.kumi.systems/api/interpreter",
	mailru: "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
} as const;

export type OsmElement = {
	type: string;
	lat?: number;
	lon?: number;
	tags?: Record<string, string>;
	geometry?: { lat: number; lon: number }[];
	members?: { geometry?: { lat: number; lon: number }[] }[];
};

export class OverpassError extends Error {}

export interface OverpassOptions {
	/** Tried in order; list an endpoint twice to retry it. */
	endpoints?: readonly string[];
	/** Per-request timeout (none by default). */
	timeoutMs?: number;
	signal?: AbortSignal;
	userAgent?: string;
	/** Wait `backoffMs × n` before the n-th retry. */
	backoffMs?: number;
	/** Retry the first endpoint once, after 3 s, when it sheds load quickly (429/504 within 20 s). */
	retryQuickFail?: boolean;
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((res, rej) => {
		const onAbort = () => {
			clearTimeout(t);
			rej(signal?.reason);
		};
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			res();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/** POSTs `query`, returning the first well-formed `{elements: [...]}` answer. */
export async function overpass(
	query: string,
	o: OverpassOptions = {},
): Promise<{ elements: OsmElement[] }> {
	const {
		endpoints = [OVERPASS.main, OVERPASS.coffee, OVERPASS.kumi],
		timeoutMs,
		signal,
	} = o;
	let last = "";
	let quickFail = false;
	const plan = o.retryQuickFail ? [endpoints[0], ...endpoints] : endpoints;
	for (const [i, url] of plan.entries()) {
		if (o.retryQuickFail && i === 1) {
			// never after a timeout: only a fast 429/504 (load shedding) is worth a second try
			if (!quickFail) continue;
			await sleep(3000, signal);
		} else if (i > 0 && o.backoffMs) await sleep(o.backoffMs * i, signal);
		const t0 = Date.now();
		const ctl = new AbortController();
		const timer =
			timeoutMs === undefined
				? undefined
				: setTimeout(
						() => ctl.abort(new DOMException("timeout", "TimeoutError")),
						timeoutMs,
					);
		const onAbort = () => ctl.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort);
		try {
			const res = await fetch(url, {
				method: "POST",
				body: new URLSearchParams({ data: query }),
				headers: o.userAgent ? { "User-Agent": o.userAgent } : undefined,
				signal: ctl.signal,
			});
			if (res.ok) {
				const json = await res.json();
				if (Array.isArray(json?.elements)) return json;
				last = `${url}: malformed response`;
			} else {
				last = `${url}: HTTP ${res.status}`;
				quickFail =
					i === 0 &&
					(res.status === 429 || res.status === 504) &&
					Date.now() - t0 < 20_000;
			}
		} catch (e) {
			if (signal?.aborted) throw e;
			const name = (e as Error).name;
			last = `${url}: ${name === "AbortError" || name === "TimeoutError" ? `timed out after ${(timeoutMs ?? 0) / 1000}s` : (e as Error).message}`;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}
	throw new OverpassError(`Overpass failed (${last})`);
}

const memo = new Map<string, ReturnType<typeof overpass>>();

/** overpass() memoised per query for the life of the module (failed requests are not kept). */
export function overpassMemo(query: string, o?: OverpassOptions) {
	let p = memo.get(query);
	if (!p) {
		p = overpass(query, o);
		p.catch(() => memo.delete(query));
		memo.set(query, p);
	}
	return p;
}
