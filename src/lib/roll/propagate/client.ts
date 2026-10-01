// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Client for the relative-rotation service (tools/nearfield/propagate/service.py, default :8769).
// Like matcher-client.ts: degrades to `false` / an error string when the service isn't running; never throws.
//
// Why a service and not the browser: the only estimator that passed the study (REPORT.txt) is
// ALIKED+LightGlue with a pure-rotation RANSAC; there is no in-browser ALIKED/LightGlue here, and DA3
// /multiview on the near-field service (:8767) has no usable confidence and is gated out by method.
import type { RelRotResult } from "./plan";

const BASE = (
	(import.meta.env?.VITE_PROPAGATE_URL as string | undefined) ??
	"http://127.0.0.1:8769"
).replace(/\/+$/, "");

let health: { ok: boolean; at: number } | null = null;

export async function propagateServiceUp(force = false): Promise<boolean> {
	if (
		!force &&
		health &&
		Date.now() - health.at < (health.ok ? 60_000 : 10_000)
	)
		return health.ok;
	let ok = false;
	try {
		const c = new AbortController();
		const t = setTimeout(() => c.abort(), 800);
		const r = await fetch(`${BASE}/health`, { signal: c.signal });
		clearTimeout(t);
		ok = r.ok && (await r.json())?.method === "rot";
	} catch {
		ok = false;
	}
	health = { ok, at: Date.now() };
	return ok;
}

export const propagateServiceUrl = () => BASE;

const b64Cache = new Map<string, Promise<string>>();
function imageB64(src: string): Promise<string> {
	let p = b64Cache.get(src);
	if (!p) {
		p = fetch(src)
			.then((r) => {
				if (!r.ok) throw new Error(`image ${r.status}`);
				return r.blob();
			})
			.then(
				(b) =>
					new Promise<string>((res, rej) => {
						const fr = new FileReader();
						fr.onload = () => res(String(fr.result).split(",", 2)[1] ?? "");
						fr.onerror = () => rej(fr.error);
						fr.readAsDataURL(b);
					}),
			);
		p.catch(() => b64Cache.delete(src));
		b64Cache.set(src, p);
		if (b64Cache.size > 24)
			b64Cache.delete(b64Cache.keys().next().value as string);
	}
	return p;
}

/**
 * Relative rotation A-camera → B-camera. vfovA = the anchor's ACCEPTED vfov, vfovB = the target's EXIF vfov.
 * Returns an error string instead of throwing.
 */
export async function relRot(
	a: { src: string; vfov: number },
	b: { src: string; vfov: number },
	signal?: AbortSignal,
): Promise<RelRotResult | string> {
	try {
		const [ia, ib] = await Promise.all([imageB64(a.src), imageB64(b.src)]);
		const r = await fetch(`${BASE}/relrot`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ a: ia, b: ib, vfovA: a.vfov, vfovB: b.vfov }),
			signal,
		});
		const j = await r.json().catch(() => null);
		if (!r.ok)
			return `service ${r.status}: ${j?.message ?? j?.error ?? "error"}`;
		return j as RelRotResult;
	} catch (e) {
		if (signal?.aborted) return "aborted";
		health = { ok: false, at: Date.now() };
		return `service unreachable (${(e as Error)?.message ?? e})`;
	}
}
