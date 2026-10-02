// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { Cpu, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MapAttribution } from "#/lib/licences/MapAttribution";
import {
	failBackend,
	initialBackendState,
	type RollBackendState,
	rendererAttrFor,
} from "#/lib/roll/map/backend-select";
import type { RollMapEngine, RollMapStatus } from "#/lib/roll/map/roll-map";
import { LiveLines } from "./LiveLines";
import { type Lines, viewOfCamera } from "./lineArt";
import { useLiveEmbed } from "./liveSlot";

// Landing-page live map: the sample trip draped on 3D terrain by the real roll engine, started only
// once the section scrolls into view, slowly orbiting until someone grabs it. Clicking a camera pin
// flies into that photo. Until the engine is ready the poster still shows.

/** First overview distance (m): close enough that the drapes fill the frame. */
const OVERVIEW_M = 3200;
/** No distance limit on the drapes: every photo paints everything it saw (finite for the shader). */
const NO_REACH_M = 1e6;
/** Landing frame cap and pixel ratio: the orbit is slow, so 30 fps at <=1.5x reads the same for much less GPU. */
const LANDING_FPS = 30;
const LANDING_PIXEL_RATIO = 1.5;
/** autoRotate steps per tick, so the pace is scaled by 60 / fps. */
const ROTATE_SPEED = 0.5 * (60 / LANDING_FPS);

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
	// the first sighting starts the load (small margin: the heavy load shouldn't begin while the topo
	// board above is still on screen); far away for a few seconds, or off screen while another live
	// embed is on screen (liveSlot), the engine is disposed (its GPU context freed) and the poster
	// shows again
	const box = useRef<HTMLDivElement>(null);
	const { live, onScreen: inView } = useLiveEmbed("rollmap", 50, { ref: box });
	const canvasRef = useRef<HTMLCanvasElement>(null);
	// a fresh <canvas> per engine: a released canvas keeps its old context type
	const [generation, setGeneration] = useState(0);
	// the backend follows the app's renderer selection, resolved on the first sighting; a WebGPU
	// failure switches this mount to WebGL2 for good (and takes a fresh canvas, see generation)
	const [backendState, setBackendState] = useState<RollBackendState | null>(
		null,
	);
	const backendRef = useRef<RollBackendState | null>(null);
	backendRef.current = backendState;
	const backendKind = backendState?.kind;
	const started = useRef(false);
	const [status, setStatus] = useState<RollMapStatus | null>(null);
	const [shown, setShown] = useState(false);
	const [inPhoto, setInPhoto] = useState<string | null>(null);
	// the roll's centre, for the data credit (src/lib/licences)
	const [center, setCenter] = useState<{ lat: number; lon: number } | null>(
		null,
	);
	const eng = useRef<RollMapEngine | null>(null);
	const onScreen = useRef(false);

	// no wheel zoom on the landing page: the wheel scrolls on down the page. A capture listener on the
	// box keeps the wheel from reaching the OrbitController (which would preventDefault it); drag still orbits.
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const stop = (e: WheelEvent) => e.stopPropagation();
		el.addEventListener("wheel", stop, { capture: true, passive: true });
		return () => el.removeEventListener("wheel", stop, { capture: true });
	}, []);

	// the render loop follows visibility
	useEffect(() => {
		onScreen.current = inView;
		if (inView) eng.current?.resume();
		else eng.current?.pause();
	}, [inView]);

	useEffect(() => {
		if (!live || backendState) return;
		let alive = true;
		void import("#/lib/renderer-select")
			.then((m) => m.resolveRenderer())
			.then((choice) => {
				if (alive) setBackendState((cur) => cur ?? initialBackendState(choice));
			});
		return () => {
			alive = false;
		};
	}, [live, backendState]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!live || !canvas || !backendKind) return;
		let alive = true;
		let engine: RollMapEngine | null = null;
		(async () => {
			const [
				{ loadDemoRoll },
				{ loadDemoPeopleMasks },
				{ demoRollMapSeed },
				{ RollMapEngine },
			] = await Promise.all([
				import("#/lib/demo"),
				import("#/lib/demo/people-masks"),
				import("#/lib/demo/roll-map-seed"),
				import("#/lib/roll/map/roll-map"),
			]);
			// the landing's 1024 px copies (the engine works at 1024 px anyway), no trails
			const roll = await loadDemoRoll({ core: true, smallPhotos: true });
			if (!alive) return;
			setCenter(roll.center);
			engine = new RollMapEngine(canvas, roll, {
				backend: backendKind,
				onBackendFailed: (e) => {
					if (!alive) return;
					// one-way: the failed canvas may hold a WebGPU context, so remount on a new one
					const cur = backendRef.current;
					const next = cur && failBackend(cur, e);
					if (!next || next === cur) return;
					backendRef.current = next;
					setBackendState(next);
					setGeneration((g) => g + 1);
					setShown(false);
					setStatus(null);
					setInPhoto(null);
				},
				overviewM: OVERVIEW_M,
				// baked people masks (scripts/demo/bake-people-masks.mjs): no MediaPipe download
				peopleMasks: loadDemoPeopleMasks,
				// baked terrain, basemap, range grids and clear-air fits (scripts/demo/bake-roll-map.mjs):
				// no Mapterhorn / WMTS downloads, no readbacks; any part that fails loads live
				seed: demoRollMapSeed,
				onSelect: (id) => id && engine?.flyTo(id),
				onView: (id) => alive && setInPhoto(id),
				onStatus: (s) => {
					if (!alive) return;
					setStatus(s);
					// show the canvas once the terrain is in; photos drape in live from there
					if (s.stage !== "terrain") {
						setShown(true);
						engine?.setAutoRotate(ROTATE_SPEED);
					}
				},
			});
			engine.setSettings({
				basemap: "muted",
				gizmos: true,
				reachM: NO_REACH_M,
			});
			engine.setFrameCap(LANDING_FPS);
			engine.setPixelRatio(
				Math.min(window.devicePixelRatio || 1, LANDING_PIXEL_RATIO),
			);
			if (!onScreen.current) engine.pause();
			eng.current = engine;
			void engine.init();
		})();
		const ro = new ResizeObserver(() => engine?.resize());
		ro.observe(canvas);
		return () => {
			alive = false;
			ro.disconnect();
			engine?.dispose();
			eng.current = null;
		};
	}, [live, backendKind]);

	useEffect(() => {
		if (live) {
			started.current = true;
		} else if (started.current) {
			started.current = false;
			setGeneration((g) => g + 1);
			setShown(false);
			setStatus(null);
			setInPhoto(null);
		}
	}, [live]);

	const busy = status && status.stage !== "ready";
	// the sides: contour lines through the orbiting camera, once the terrain is in; the engine's frame
	// is centred on the roll, the bake's on the demo viewpoint, so the camera is shifted onto the bake's
	const linesView = (lines: Lines) => {
		const e = shown ? eng.current : null;
		if (!e) return null;
		const c = e.world.cam;
		return viewOfCamera(
			c.position,
			c.quaternion,
			c.fov,
			e.frame.fromGeo(lines.origin.lat, lines.origin.lon, 0),
		);
	};
	return (
		<div className="relative isolate">
			<LiveLines
				src="/demo/surround/live3d-lines.bin"
				getView={linesView}
				className="-z-10"
			/>
			<div
				ref={box}
				data-theme="dark"
				className={`relative overflow-hidden bg-[var(--rigi-slate)] ${className ?? ""}`}
				data-testid="live-roll-map"
				data-renderer={backendKind && rendererAttrFor(backendKind)}
				data-renderer-reason={backendState?.reason}
			>
				{poster && (
					<img
						src={poster}
						alt="The sample trip's photos draped on the 3D terrain"
						className={`absolute inset-0 size-full object-cover transition-opacity duration-700 ${shown ? "opacity-0" : "opacity-100"}`}
					/>
				)}
				<canvas
					key={generation}
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
							eng.current?.setAutoRotate(ROTATE_SPEED);
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
				{center && (
					<MapAttribution
						lat={center.lat}
						lon={center.lon}
						radiusKm={30}
						imagery="satellite"
						compact
						className="right-auto bottom-3 left-3"
					/>
				)}
			</div>
		</div>
	);
}
