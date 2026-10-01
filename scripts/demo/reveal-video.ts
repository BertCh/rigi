// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Looping clip of the overlay reveal (src/lib/reveal) over one demo photo, for the landing page:
// public/demo/video/reveal.{mp4,webm,jpg}. Frames are stepped with the DEV hook __reveal.seek, so
// the timing is exact even though canvas screenshots stall the GPU.
//   APP_URL=http://localhost:3161 node scripts/gpu/with-render-lock.mjs -- npx tsx scripts/demo/reveal-video.ts demo-01 bloom
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE = process.env.APP_URL ?? "http://localhost:3161";
const [photo = "demo-01", preset = "bloom"] = process.argv.slice(2);
const OUT = "public/demo/video";
const FPS = 30;
const REVEAL = 90; // frames of the reveal itself
const HOLD = 60; // final frame held
const FADE = 20; // cross-fade back to the first frame, so the loop is seamless
const frames = join(tmpdir(), `rigi-reveal-${photo}-${preset}`);
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const page = await browser.newPage({
	viewport: { width: 1600, height: 1200 },
	deviceScaleFactor: 1,
});
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto(`${BASE}/photo/${photo}?reveal=${preset}`);
await page.waitForSelector("[data-ready]", {
	state: "attached",
	timeout: 180_000,
});
await page.waitForFunction(
	() =>
		document.querySelector("[data-ready]")?.getAttribute("data-verify") !==
		"pending",
	null,
	{ timeout: 180_000 },
);
await page.waitForTimeout(4000); // the on-load reveal finishes
await page.addStyleTag({
	content: "header, [data-testid=tour-bar] { display: none !important }",
});

const cfg = {
	onLoad: true,
	preset,
	duration: null,
	glow: 1,
	soft: 1,
	grain: 1,
	color: null,
	reverse: false,
	dim: 0.2,
	labels: true,
};
const clip = await page.evaluate(() => {
	const r = document
		.querySelector("[data-ready] canvas")
		?.getBoundingClientRect();
	return r && { x: r.x, y: r.y, width: r.width, height: r.height };
});
if (!clip) throw new Error("no canvas");
console.log("clip", clip);

const seek = (k: number | null, remeasure = false) =>
	page.evaluate(
		async ([c, k, re]) => {
			await window.__reveal?.seek(
				c as never,
				k as number | null,
				re as boolean,
			);
			await new Promise((r) =>
				requestAnimationFrame(() => requestAnimationFrame(r)),
			);
		},
		[cfg, k, remeasure] as const,
	);

await seek(0, true);
for (let i = 0; i < REVEAL; i++) {
	await seek(i / REVEAL);
	await page.waitForTimeout(40); // label layer re-render
	await page.screenshot({
		path: join(frames, `f${String(i).padStart(4, "0")}.png`),
		clip,
	});
}
await seek(null);
await page.waitForTimeout(300);
await page.screenshot({ path: join(frames, "final.png"), clip });
await browser.close();

const ff = (args: string[]) =>
	execFileSync(
		"/opt/homebrew/bin/ffmpeg",
		["-y", "-loglevel", "error", ...args],
		{
			stdio: "inherit",
		},
	);
const W = Math.min(1600, Math.round(clip.width / 2) * 2);
// reveal → hold → cross-fade back to frame 0
const filter = [
	`[0:v]fps=${FPS}[rev]`,
	`[1:v]loop=${HOLD + FADE}:1:0,setpts=N/${FPS}/TB,fps=${FPS}[hold]`,
	`[2:v]loop=${FADE}:1:0,setpts=N/${FPS}/TB,fps=${FPS}[first]`,
	`[hold][first]xfade=transition=fade:duration=${FADE / FPS}:offset=${HOLD / FPS}[tail]`,
	`[rev][tail]concat=n=2:v=1:a=0,scale=${W}:-2,format=yuv420p[v]`,
].join(";");
const inputs = [
	"-framerate",
	String(FPS),
	"-i",
	join(frames, "f%04d.png"),
	"-i",
	join(frames, "final.png"),
	"-i",
	join(frames, "f0000.png"),
	"-filter_complex",
	filter,
	"-map",
	"[v]",
];
ff([
	...inputs,
	"-c:v",
	"libx264",
	"-crf",
	"24",
	"-preset",
	"slow",
	"-movflags",
	"+faststart",
	join(OUT, "reveal.mp4"),
]);
ff([
	...inputs,
	"-c:v",
	"libvpx-vp9",
	"-crf",
	"36",
	"-b:v",
	"0",
	"-row-mt",
	"1",
	join(OUT, "reveal.webm"),
]);
ff([
	"-i",
	join(frames, "final.png"),
	"-vf",
	`scale=${W}:-2`,
	"-q:v",
	"3",
	join(OUT, "reveal.jpg"),
]);
console.log(
	"frames in",
	frames,
	"aspect",
	(clip.width / clip.height).toFixed(4),
);
