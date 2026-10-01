// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { Cpu, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RollMapEngine, RollMapStatus } from "#/lib/roll/map/roll-map";

// Landing-page live map: the sample trip draped on 3D terrain by the real roll engine, started only
// once the section scrolls into view, slowly orbiting until someone grabs it. Clicking a camera pin
// flies into that photo. Until the engine is ready the poster still shows.

/** First overview distance (m): close enough that the drapes fill the frame. */
const OVERVIEW_M = 3200;
/** No distance limit on the drapes: every photo paints everything it saw (finite for the shader). */
const NO_REACH_M = 1e6;

const STAGE_LABEL: Record<RollMapStatus["stage"], string> = {
	terrain: "Streaming terrain",
	photos: "Loading photos",
	ranges: "Working out what each photo sees",
	people: "Masking people",
	ready: "Ready",
};

export function LiveRollMap({
	poster,
	className,
}: {
	poster?: string;
	className?: string;
}) {
	const box = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [visible, setVisible] = useState(false);
	const [status, setStatus] = useState<RollMapStatus | null>(null);
	const [shown, setShown] = useState(false);
	const [inPhoto, setInPhoto] = useState<string | null>(null);
	const eng = useRef<RollMapEngine | null>(null);

	// no wheel zoom on the landing page: the wheel scrolls on down the page. A capture listener on the
	// box keeps the wheel from reaching OrbitControls (which would preventDefault it); drag still orbits.
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const stop = (e: WheelEvent) => e.stopPropagation();
		el.addEventListener("wheel", stop, { capture: true, passive: true });
		return () => el.removeEventListener("wheel", stop, { capture: true });
	}, []);

	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const io = new IntersectionObserver(
			([e]) => e.isIntersecting && setVisible(true),
			{ rootMargin: "200px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, []);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!visible || !canvas) return;
		let live = true;
		let engine: RollMapEngine | null = null;
		(async () => {
			const [{ loadDemoRoll }, { RollMapEngine }] = await Promise.all([
				import("#/lib/demo"),
				import("#/lib/roll/map/roll-map"),
			]);
			const roll = await loadDemoRoll();
			if (!live) return;
			engine = new RollMapEngine(canvas, roll, {
				overviewM: OVERVIEW_M,
				onSelect: (id) => id && engine?.flyTo(id),
				onView: (id) => live && setInPhoto(id),
				onStatus: (s) => {
					if (!live) return;
					setStatus(s);
					// show the canvas once the terrain is in; photos drape in live from there
					if (s.stage !== "terrain") {
						setShown(true);
						engine?.setAutoRotate(0.5);
					}
				},
			});
			engine.setSettings({
				basemap: "muted",
				gizmos: true,
				reachM: NO_REACH_M,
			});
			eng.current = engine;
			void engine.init();
		})();
		const ro = new ResizeObserver(() => engine?.resize());
		ro.observe(canvas);
		return () => {
			live = false;
			ro.disconnect();
			engine?.dispose();
			eng.current = null;
		};
	}, [visible]);

	const busy = status && status.stage !== "ready";
	return (
		<div
			ref={box}
			className={`relative overflow-hidden bg-[var(--rigi-slate)] ${className ?? ""}`}
			data-testid="live-roll-map"
		>
			{poster && (
				<img
					src={poster}
					alt="The sample trip's photos draped on the 3D terrain"
					className={`absolute inset-0 size-full object-cover transition-opacity duration-700 ${shown ? "opacity-0" : "opacity-100"}`}
				/>
			)}
			<canvas
				ref={canvasRef}
				className={`absolute inset-0 size-full !touch-pan-y transition-opacity duration-700 ${shown ? "opacity-100" : "opacity-0"}`}
			/>
			<div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-lg bg-black/55 px-2.5 py-1.5 text-[11px] text-white/80 backdrop-blur">
				<Cpu className="size-3.5 text-[var(--rigi-glow)]" />
				{!status
					? "Live 3D, rendered locally"
					: busy
						? `${STAGE_LABEL[status.stage]}${status.note ? ` · ${status.note}` : ""}`
						: "Live · drag to orbit · click a pin"}
			</div>
			{inPhoto && (
				<button
					type="button"
					onClick={() => {
						eng.current?.frameOverview(OVERVIEW_M);
						eng.current?.setAutoRotate(0.5);
					}}
					className="absolute top-3 right-3 flex items-center gap-1.5 rounded-lg bg-black/55 px-2.5 py-1.5 text-[11px] font-medium text-white/85 backdrop-blur hover:text-white"
				>
					<Undo2 className="size-3.5" /> Back to overview
				</button>
			)}
			<Link
				to="/roll/$id"
				params={{ id: "demo" }}
				search={{ view: "map" }}
				className="absolute right-3 bottom-3 rounded-lg bg-black/55 px-2.5 py-1.5 text-[11px] font-medium text-white/85 backdrop-blur hover:text-white"
			>
				Open the full roll →
			</Link>
		</div>
	);
}
