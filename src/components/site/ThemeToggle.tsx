// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useNavigate } from "@tanstack/react-router";
import { Monitor, Moon, Sun } from "lucide-react";
import { flagSet } from "#/lib/flags";
import type { ThemeChoice } from "#/lib/theme";
import { useTheme } from "#/lib/theme/react";
import { cn } from "#/lib/utils";

const NEXT: Record<ThemeChoice, ThemeChoice> = {
	auto: "light",
	light: "dark",
	dark: "auto",
};
const LABEL: Record<ThemeChoice, string> = {
	auto: "Theme: follow system",
	light: "Theme: light",
	dark: "Theme: dark",
};

/** One button that cycles Auto, Light, Dark. A ?theme= in the URL is cleared so the choice takes effect. */
export function ThemeToggle({ className }: { className?: string }) {
	const { choice, setChoice } = useTheme();
	const navigate = useNavigate();
	const Icon = choice === "light" ? Sun : choice === "dark" ? Moon : Monitor;
	const cycle = () => {
		setChoice(NEXT[choice]);
		if (flagSet("theme")) {
			void navigate({
				to: ".",
				search: ((s: Record<string, unknown>) => ({
					...s,
					theme: undefined,
				})) as never,
				replace: true,
			});
		}
	};
	return (
		<button
			type="button"
			data-testid="theme-toggle"
			aria-label={`${LABEL[choice]} (click for ${LABEL[NEXT[choice]].slice(7)})`}
			title={LABEL[choice]}
			onClick={cycle}
			className={cn(
				"rounded-lg px-2 py-1.5 text-white/55 hover:text-[var(--rigi-paper)]",
				className,
			)}
		>
			<Icon className="size-4" aria-hidden />
		</button>
	);
}
