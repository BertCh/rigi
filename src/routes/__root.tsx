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

const FONTS_HREF =
	"https://fonts.googleapis.com/css2?family=Fira+Sans+Condensed:wght@500;600&family=Fira+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400;1,500&family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,400;1,9..144,500&family=IBM+Plex+Mono:wght@400;500&family=Manrope:wght@400;500;600;700;800&display=swap";

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
			// fonts load from the head, not an @import in the stylesheet (which chains and blocks render)
			{ rel: "preconnect", href: "https://fonts.googleapis.com" },
			{
				rel: "preconnect",
				href: "https://fonts.gstatic.com",
				crossOrigin: "anonymous",
			},
			{ rel: "stylesheet", href: FONTS_HREF },
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
