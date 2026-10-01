import {
	createRootRoute,
	HeadContent,
	retainSearchParams,
	Scripts,
} from "@tanstack/react-router";
import { BRAND } from "#/brand/khipu";
import { FLAG_NAMES, type FlagSearch, flagSearch } from "#/lib/flags";

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
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	);
}
