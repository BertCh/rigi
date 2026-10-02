// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The pre-paint boot script and resolveTheme() must agree in every precedence case.
import { THEME_BOOT_SCRIPT } from "#/lib/flags/theme-boot";
import { resolveTheme } from "../index";

type Env = {
	flag?: string;
	url?: string;
	stored?: string;
	webdriver?: boolean;
	light?: boolean;
};

const g = globalThis as Record<string, unknown>;
const KEYS = [
	"document",
	"location",
	"localStorage",
	"navigator",
	"matchMedia",
	"__RIGI_FLAGS__",
] as const;

function setup(env: Env) {
	for (const k of KEYS)
		Object.defineProperty(g, k, {
			value: undefined,
			configurable: true,
			writable: true,
		});
	const root = { dataset: {} as Record<string, string> };
	g.document = {
		documentElement: root,
		querySelector: () => null,
	};
	g.location = { search: env.url ? `?theme=${env.url}` : "" };
	g.localStorage = {
		getItem: (k: string) => (k === "rigi.theme" ? (env.stored ?? null) : null),
	};
	g.navigator = { webdriver: !!env.webdriver };
	g.matchMedia = () => ({ matches: !!env.light });
	if (env.flag) g.__RIGI_FLAGS__ = { theme: env.flag };
	return root;
}

const cases: [string, Env, "light" | "dark"][] = [
	["default is dark", {}, "dark"],
	["OS light", { light: true }, "light"],
	["OS dark", { light: false }, "dark"],
	["webdriver beats OS light", { webdriver: true, light: true }, "dark"],
	[
		"stored light beats webdriver",
		{ stored: "light", webdriver: true },
		"light",
	],
	["stored dark beats OS light", { stored: "dark", light: true }, "dark"],
	["bad stored ignored", { stored: "blue", light: true }, "light"],
	["url light beats stored dark", { url: "light", stored: "dark" }, "light"],
	["url dark beats OS light", { url: "dark", light: true }, "dark"],
	["url auto falls through", { url: "auto", light: true }, "light"],
	["override beats url", { flag: "dark", url: "light" }, "dark"],
	[
		"override light under webdriver",
		{ flag: "light", webdriver: true },
		"light",
	],
	["override auto falls through", { flag: "auto", stored: "light" }, "light"],
];

let failed = 0;
for (const [name, env, want] of cases) {
	const root = setup(env);
	const fn = new Function(THEME_BOOT_SCRIPT);
	fn();
	const boot = root.dataset.theme;
	const resolved = resolveTheme();
	const ok = boot === want && resolved === want;
	if (!ok) failed++;
	console.log(
		`${ok ? "PASS" : "FAIL"} ${name}: boot=${boot} resolve=${resolved} want=${want}`,
	);
}
if (failed) {
	console.error(`${failed} theme case(s) failed`);
	process.exit(1);
}
console.log(`theme.check: ${cases.length} cases ok`);
