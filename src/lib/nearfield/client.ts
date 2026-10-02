// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Client for the optional near-field service (tools/nearfield, default http://127.0.0.1:8767).
// Like matcher-client.ts: everything degrades to `false` / `null` when the service isn't running; it never throws.
import { parseSplatSync } from "./splat-loaders";
import {
	type GaussianCloud,
	type MultiViewWire,
	NEARFIELD_URL_DEFAULT,
	type NearFieldDepth,
	type NearFieldDepthWire,
} from "./types";

const ENV_URL: string | undefined = import.meta.env?.VITE_NEARFIELD_URL;
const HEALTH_TIMEOUT_MS = 800;
const HEALTH_TTL_OK_MS = 60_000;
const HEALTH_TTL_DOWN_MS = 15_000;

export type NearFieldHealth = {
	ok: boolean;
	models: string[];
	device: string;
	/** Service build id (absent on older services). */
	version?: string;
};
export type DepthModel = "moge2" | "da3";
export type GaussianModel = "sharp" | "lift";
export type RequestOpts = { signal?: AbortSignal; timeoutMs?: number };
/** /gaussians X-NearField-Meta (service-defined; only the fields the client relies on are typed). */
type GaussianMeta = {
	width?: number;
	height?: number;
	intrinsicsNorm?: { fx: number; fy: number; cx: number; cy: number };
	[k: string]: unknown;
};

/** /multiview decoded: per-image depth (camera frame of each image) plus relative cameras. */
export type NearFieldMultiView = {
	model: string;
	cameras: MultiViewWire["cameras"];
	depths: NearFieldDepth[];
	seconds: number;
};

// ---- decoding ----

/** IEEE 754 half → float. */
export function halfToFloat(h: number): number {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const f = h & 0x3ff;
	if (e === 0) return s * f * 2 ** -24;
	if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY;
	return s * (1 + f / 1024) * 2 ** (e - 15);
}

let HALF_LUT: Float32Array | null = null;
/** Little-endian float16 bytes → Float32Array (lookup table). */
export function f16ToF32(bytes: Uint8Array): Float32Array {
	if (!HALF_LUT) {
		HALF_LUT = new Float32Array(65536);
		for (let i = 0; i < 65536; i++) HALF_LUT[i] = halfToFloat(i);
	}
	const n = bytes.length >> 1;
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++)
		out[i] = HALF_LUT[bytes[2 * i] | (bytes[2 * i + 1] << 8)];
	return out;
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Decode the /depth JSON (also each /multiview depth). Throws on inconsistent sizes. */
export function decodeDepthWire(
	w: Omit<NearFieldDepthWire, "model" | "seconds"> &
		Partial<Pick<NearFieldDepthWire, "model" | "seconds">>,
): NearFieldDepth {
	const n = w.width * w.height;
	const depth = f16ToF32(base64ToBytes(w.depthF16));
	const valid = base64ToBytes(w.validU8);
	if (depth.length !== n || valid.length !== n)
		throw new Error("nearfield: depth wire size mismatch");
	const d: NearFieldDepth = {
		width: w.width,
		height: w.height,
		depth,
		valid,
		model: w.model ?? "unknown",
		seconds: w.seconds ?? 0,
	};
	if (w.intrinsicsNorm) d.intrinsicsNorm = w.intrinsicsNorm;
	if (w.normalF16) {
		const nrm = f16ToF32(base64ToBytes(w.normalF16));
		if (nrm.length === 3 * n) d.normal = nrm;
	}
	return d;
}

/** A /gaussians body: .splat-v1 (magic RIGISPL1) or a standard 3DGS binary .ply. Throws if neither. */
const decodeGaussianBody = (buf: ArrayBuffer): GaussianCloud =>
	parseSplatSync(buf);

// ---- transport ----

function linkedSignal(timeoutMs: number, outer?: AbortSignal) {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	const onAbort = () => ctl.abort();
	if (outer?.aborted) ctl.abort();
	else outer?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: ctl.signal,
		done: () => {
			clearTimeout(timer);
			outer?.removeEventListener("abort", onAbort);
		},
	};
}

export class NearFieldClient {
	readonly base: string;
	private cache: { h: NearFieldHealth | null; at: number } | null = null;
	private inFlight: Promise<NearFieldHealth | null> | null = null;

	constructor(base: string = ENV_URL ?? NEARFIELD_URL_DEFAULT) {
		this.base = base.replace(/\/+$/, "");
	}

	/** Cached GET /health (800 ms timeout; ok cached 60 s, down 15 s). null when down. */
	health(force = false): Promise<NearFieldHealth | null> {
		const now = Date.now();
		const c = this.cache;
		if (
			!force &&
			c &&
			now - c.at < (c.h?.ok ? HEALTH_TTL_OK_MS : HEALTH_TTL_DOWN_MS)
		)
			return Promise.resolve(c.h);
		if (this.inFlight) return this.inFlight;
		this.inFlight = (async () => {
			const l = linkedSignal(HEALTH_TIMEOUT_MS);
			let h: NearFieldHealth | null = null;
			try {
				const r = await fetch(`${this.base}/health`, { signal: l.signal });
				const j = r.ok ? await r.json() : null;
				if (j?.ok === true)
					h = {
						ok: true,
						models: Array.isArray(j.models) ? j.models : [],
						device: String(j.device ?? ""),
						...(typeof j.version === "string" ? { version: j.version } : {}),
					};
			} catch {
				h = null;
			} finally {
				l.done();
			}
			this.cache = { h, at: Date.now() };
			this.inFlight = null;
			return h;
		})();
		return this.inFlight;
	}

	async available(force = false): Promise<boolean> {
		const h = await this.health(force);
		// The app always calls /depth with moge2: a service without it is not usable. Old services report no models.
		return (
			h?.ok === true && (h.models.length === 0 || h.models.includes("moge2"))
		);
	}

	/** POST /depth. null when the service is down, times out (default 60 s), is aborted or errors. */
	async depth(
		image: Blob,
		opts: RequestOpts & { model?: DepthModel; maxSide?: number } = {},
	): Promise<NearFieldDepth | null> {
		const fd = new FormData();
		fd.append("image", image, "photo.jpg");
		if (opts.model) fd.append("model", opts.model);
		if (opts.maxSide) fd.append("maxSide", String(opts.maxSide));
		const r = await this.post("/depth", fd, opts, 60_000);
		if (!r) return null;
		try {
			return decodeDepthWire((await r.json()) as NearFieldDepthWire);
		} catch (e) {
			console.warn("[nearfield] bad /depth reply", e);
			return null;
		}
	}

	/** POST /gaussians → camera-frame cloud (.splat-v1 or .ply). null on any failure. Default timeout 120 s. */
	async gaussians(
		image: Blob,
		opts: RequestOpts & { model?: GaussianModel } = {},
	): Promise<GaussianCloud | null> {
		return (await this.gaussiansWithMeta(image, opts))?.cloud ?? null;
	}

	/**
	 * POST /gaussians plus the X-NearField-Meta header. `meta.intrinsicsNorm` is the camera the service built
	 * the cloud with: pass it as buildNearFieldScene({ cloudIntrinsics }) so the Gaussians land on the photo's
	 * rays. null on any failure; meta is {} when the header is missing or malformed.
	 */
	async gaussiansWithMeta(
		image: Blob,
		opts: RequestOpts & { model?: GaussianModel } = {},
	): Promise<{ cloud: GaussianCloud; meta: GaussianMeta } | null> {
		const fd = new FormData();
		fd.append("image", image, "photo.jpg");
		if (opts.model) fd.append("model", opts.model);
		const r = await this.post("/gaussians", fd, opts, 120_000);
		if (!r) return null;
		try {
			const cloud = decodeGaussianBody(await r.arrayBuffer());
			let meta: GaussianMeta = {};
			try {
				const h = r.headers.get("X-NearField-Meta");
				if (h) meta = JSON.parse(h) as GaussianMeta;
			} catch {
				meta = {};
			}
			return { cloud, meta };
		} catch (e) {
			console.warn("[nearfield] bad /gaussians reply", e);
			return null;
		}
	}

	/** POST /multiview (camera-roll, P2). `poses` is sent as poses.json when given. Default timeout 300 s. */
	async multiview(
		images: Blob[],
		opts: RequestOpts & { poses?: unknown } = {},
	): Promise<NearFieldMultiView | null> {
		const fd = new FormData();
		images.forEach((b, i) => {
			fd.append("images", b, `img${i}.jpg`);
		});
		if (opts.poses !== undefined)
			fd.append(
				"poses",
				new Blob([JSON.stringify(opts.poses)], { type: "application/json" }),
				"poses.json",
			);
		const r = await this.post("/multiview", fd, opts, 300_000);
		if (!r) return null;
		try {
			const w = (await r.json()) as MultiViewWire;
			return {
				model: w.model,
				cameras: w.cameras,
				depths: w.depths.map((d) => decodeDepthWire({ ...d, model: w.model })),
				seconds: w.seconds,
			};
		} catch (e) {
			console.warn("[nearfield] bad /multiview reply", e);
			return null;
		}
	}

	/** POST with health gate + timeout; the Response when ok, else null (never throws). */
	async post(
		path: string,
		body: FormData,
		opts: RequestOpts,
		defaultTimeout: number,
	): Promise<Response | null> {
		if (opts.signal?.aborted || !(await this.available())) return null;
		const l = linkedSignal(opts.timeoutMs ?? defaultTimeout, opts.signal);
		try {
			const r = await fetch(`${this.base}${path}`, {
				method: "POST",
				body,
				signal: l.signal,
			});
			if (!r.ok) {
				const j = await r.json().catch(() => null);
				console.warn("[nearfield]", path, r.status, j?.error ?? "");
				return null;
			}
			// read the body before the timeout is cleared so a stalled body still aborts
			const buf = await r.arrayBuffer();
			return new Response(buf, { status: r.status, headers: r.headers });
		} catch (e) {
			if (!(e instanceof DOMException && e.name === "AbortError"))
				this.cache = { h: null, at: Date.now() };
			return null;
		} finally {
			l.done();
		}
	}
}

/** Shared default client (VITE_NEARFIELD_URL, else NEARFIELD_URL_DEFAULT). */
export const nearField = new NearFieldClient();
