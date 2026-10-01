#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared helpers of the WAG baseline probes (longtask-probe, vram-probe, haze-overflow-probe).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { GPU_ARGS } from "../deck-webgpu/gpu-args.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function makeArg(argv = process.argv) {
	return (k, d) => {
		const i = argv.indexOf(`--${k}`);
		return i > 0 ? argv[i + 1] : d;
	};
}

/** The 19 ground-truth ("dev") photos, or the ids given on the command line. */
export function photoIds(argv = process.argv) {
	const explicit = argv.filter(
		(a, i) => a.startsWith("IMG_") && !argv[i - 1]?.startsWith("--"),
	);
	if (explicit.length) return explicit;
	return Object.keys(
		JSON.parse(readFileSync(resolve(ROOT, "data/control-points.json"), "utf8")),
	);
}

export const median = (xs) => {
	const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
	return s.length ? s[s.length >> 1] : Number.NaN;
};
export const p90Of = (xs) => {
	const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
	return s.length
		? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]
		: Number.NaN;
};

export async function launch() {
	return chromium.launch({ headless: true, args: GPU_ARGS });
}

/** Navigate to /photo/<id>?renderer=<r> and wait for data-ready and the verify pass; returns ms. */
export async function openPhoto(page, base, id, renderer, extraQuery = "") {
	const t0 = Date.now();
	await page.goto(`${base}/photo/${id}?renderer=${renderer}${extraQuery}`);
	let ready = true;
	await page
		.waitForSelector("[data-ready]", { state: "attached", timeout: 180_000 })
		.catch(() => {
			ready = false;
		});
	const readyMs = Date.now() - t0;
	if (ready)
		await page
			.waitForFunction(
				() =>
					document
						.querySelector("[data-ready]")
						?.getAttribute("data-verify") !== "pending",
				null,
				{ timeout: 120_000 },
			)
			.catch(() => {});
	return { ready, readyMs, settledMs: Date.now() - t0 };
}
