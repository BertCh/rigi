// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	createRootRoute,
	HeadContent,
	retainSearchParams,
	Scripts,
} from "@tanstack/react-router";
import { BRAND } from "#/brand/khipu";
import { FLAG_NAMES, type FlagSearch, flagSearch } from "#/lib/flags";
import { THEME_BOOT_SCRIPT } from "#/lib/flags/theme-boot";
import { ThemeSync } from "#/lib/theme/react";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
	// the app's flags (?renderer, ?gpu, ?tiles3d, …; src/lib/flags) are validated here and carried
	// across in-app navigation, so a switch set on one page stays on for the next
	validateSearch: flagSearch,
	search: {
		middlewares: [retainSearchParams<FlagSearch>(FLAG_NAMES)],
	},
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "Rigi",
			},
			{
				name: "description",
				content: "Mountain photos aligned to a terrain model, in the browser.",
			},
			{
				name: "theme-color",
				content: BRAND.ink,
			},
		],
		links: [
			// fonts are self-hosted (src/styles/fonts.css); preload the body face so first text paints in it
			{
				rel: "preload",
				href: "/fonts/gipfelbuch/fira-sans-normal-400-latin.woff2",
				as: "font",
				type: "font/woff2",
				crossOrigin: "anonymous",
			},
			{
				rel: "stylesheet",
				href: appCss,
			},
			{
				rel: "icon",
				type: "image/svg+xml",
				href: "/favicon.svg",
			},
		],
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				{/* first in <head>: sets data-theme before first paint (src/lib/flags/theme-boot.ts) */}
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant string literal, no user input */}
				<script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
				<HeadContent />
			</head>
			<body>
				<ThemeSync />
				{children}
				<Scripts />
			</body>
		</html>
	);
}
