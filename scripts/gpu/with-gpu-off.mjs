#!/usr/bin/env node
// Run a playwright script with the app's GPU compute kill switch on in every page it opens
// (globalThis.__RIGI_FLAGS__.gpu = "off", which survives the scripts' localStorage.clear()).
// Usage: node scripts/gpu/with-gpu-off.mjs scripts/eval-app.mjs IMG_6958 …
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const [script, ...rest] = process.argv.slice(2);
if (!script) {
	console.error("usage: with-gpu-off.mjs <script.mjs> [args…]");
	process.exit(2);
}
const launch = chromium.launch.bind(chromium);
chromium.launch = async (...a) => {
	const browser = await launch(...a);
	const newContext = browser.newContext.bind(browser);
	browser.newContext = async (...b) => {
		const ctx = await newContext(...b);
		await ctx.addInitScript(() => {
			globalThis.__RIGI_FLAGS__ = { ...globalThis.__RIGI_FLAGS__, gpu: "off" };
		});
		return ctx;
	};
	const newPage = browser.newPage.bind(browser);
	browser.newPage = async (...b) => {
		const page = await newPage(...b);
		await page.addInitScript(() => {
			globalThis.__RIGI_FLAGS__ = { ...globalThis.__RIGI_FLAGS__, gpu: "off" };
		});
		return page;
	};
	return browser;
};
process.argv = [process.argv[0], resolve(script), ...rest];
await import(pathToFileURL(resolve(script)).href);
