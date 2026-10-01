// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Maximize2, Minimize2, Smartphone } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

// Wide content (the panorama) on a phone held upright: suggest turning it, and where the browser
// allows it (Android Chrome; not iPhone Safari) offer full screen locked to landscape. The hint
// goes away on its own once the phone is turned.

const PORTRAIT_PHONE =
	"(orientation: portrait) and (max-width: 640px) and (pointer: coarse)";

function useMedia(query: string) {
	const [on, setOn] = useState(false);
	useEffect(() => {
		const m = window.matchMedia(query);
		const update = () => setOn(m.matches);
		update();
		m.addEventListener("change", update);
		return () => m.removeEventListener("change", update);
	}, [query]);
	return on;
}

type LockableOrientation = ScreenOrientation & {
	lock?: (o: "landscape") => Promise<void>;
};

export function LandscapeView({ children }: { children: ReactNode }) {
	const box = useRef<HTMLDivElement>(null);
	const portraitPhone = useMedia(PORTRAIT_PHONE);
	const [canFull, setCanFull] = useState(false);
	const [full, setFull] = useState(false);

	useEffect(() => {
		setCanFull(!!document.fullscreenEnabled);
		const onChange = () =>
			setFull(!!box.current && document.fullscreenElement === box.current);
		document.addEventListener("fullscreenchange", onChange);
		return () => document.removeEventListener("fullscreenchange", onChange);
	}, []);

	const enter = async () => {
		try {
			await box.current?.requestFullscreen();
			await (screen.orientation as LockableOrientation).lock?.("landscape");
		} catch {
			// no fullscreen or no orientation lock: the user can still rotate by hand
		}
	};
	const exit = () => {
		document.exitFullscreen().catch(() => {});
	};

	return (
		<div>
			{portraitPhone && !full && (
				<div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-white/[0.04] px-3 py-2 ring-1 ring-white/10">
					<span className="flex items-center gap-2 text-xs text-white/60">
						<Smartphone className="size-4 shrink-0 rotate-90 text-[var(--rigi-glow)]" />
						Turn your phone sideways for a wider view.
					</span>
					{canFull && (
						<button
							type="button"
							onClick={enter}
							className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-[var(--rigi-paper)] ring-1 ring-white/20 hover:ring-white/40"
						>
							<Maximize2 className="size-3.5" /> Full screen
						</button>
					)}
				</div>
			)}
			<div
				ref={box}
				className={
					full
						? "relative flex h-full w-full items-center bg-[var(--rigi-ink)]"
						: "relative"
				}
			>
				<div className="w-full">{children}</div>
				{full && (
					<button
						type="button"
						onClick={exit}
						aria-label="Exit full screen"
						className="absolute top-3 right-3 rounded-md bg-black/50 p-2 text-white/80 ring-1 ring-white/20"
					>
						<Minimize2 className="size-4" />
					</button>
				)}
			</div>
		</div>
	);
}
