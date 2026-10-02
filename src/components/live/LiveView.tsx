// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	Camera,
	Compass,
	Crosshair,
	LocateFixed,
	Lock,
	Square,
	Unlock,
} from "lucide-react";
import { useRef } from "react";
import { cn } from "#/lib/utils";
import {
	type LiveStatus,
	type StepState,
	useLiveSession,
} from "./useLiveSession";

// The live view: permission steps, then a viewfinder canvas (the engine draws the camera frame and the
// terrain overlay) with peak labels as DOM chips and a status chip. The pose is a SUGGESTION from the sensors
// and the tracker; it has not passed the verification gate that still photos do, and the page says so.

const STEP_LABEL: Record<StepState, string> = {
	idle: "Not asked yet",
	asking: "Asking",
	ok: "On",
	denied: "Blocked",
	unavailable: "Not available",
};

function StepRow({
	icon,
	title,
	why,
	state,
}: {
	icon: React.ReactNode;
	title: string;
	why: string;
	state: StepState;
}) {
	return (
		<li className="flex items-start gap-3 py-2">
			<span className="mt-0.5 text-white/60">{icon}</span>
			<span className="min-w-0 flex-1">
				<span className="block text-sm font-medium">{title}</span>
				<span className="block text-xs text-white/55">{why}</span>
			</span>
			<span
				className={cn(
					"text-xs",
					state === "ok"
						? "text-[var(--rigi-result)]"
						: state === "denied"
							? "text-[var(--rigi-ember)]"
							: "text-white/45",
				)}
			>
				{STEP_LABEL[state]}
			</span>
		</li>
	);
}

function StatusChip({ s }: { s: LiveStatus }) {
	const phaseLabel =
		s.trackerPhase === "track"
			? "tracking"
			: s.trackerPhase === "lost"
				? "lost"
				: "finding";
	return (
		<div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1">
			<div
				className="rounded-full bg-black/55 px-3 py-1 text-xs backdrop-blur"
				data-testid="live-status"
				data-phase={s.trackerPhase}
			>
				<span
					className={cn(
						"mr-1.5 inline-block size-1.5 rounded-full align-middle",
						s.trackerPhase === "track"
							? "bg-[var(--rigi-result)]"
							: s.trackerPhase === "lost"
								? "bg-[var(--rigi-ember)]"
								: "bg-[var(--rigi-glow)]",
					)}
				/>
				{phaseLabel} · {s.fps.toFixed(0)} fps
				{s.compassAccuracy != null
					? ` · compass ±${s.compassAccuracy.toFixed(0)}°`
					: ""}
				{s.thermal ? " · throttled" : ""}
			</div>
			<div
				className="w-fit rounded-full bg-black/55 px-3 py-1 text-[11px] text-[var(--rigi-glow)] backdrop-blur"
				data-testid="live-suggestion"
			>
				Suggested pose, not verified
			</div>
		</div>
	);
}

export function LiveView() {
	const session = useLiveSession();
	const { status: s, labels, refs } = session;
	const drag = useRef<number | null>(null);
	const running = s.phase === "running";
	const frameAspect = s.frame ? s.frame.width / s.frame.height : 9 / 16;

	return (
		<div
			data-theme="dark"
			className="flex min-h-dvh flex-col bg-[var(--rigi-ink)] text-[var(--rigi-paper)]"
		>
			<video ref={refs.videoRef} playsInline muted className="hidden" />
			{!running && (
				<div className="mx-auto w-full max-w-md px-4 pb-6 pt-10">
					<h1 className="text-2xl font-semibold">Live</h1>
					<p className="mt-2 text-sm text-white/65">
						Point your phone at the mountains. Rigi lays the peak names over the
						camera picture, using the compass, your location and the terrain.
					</p>
					<ul className="mt-5">
						<StepRow
							icon={<Camera className="size-4" />}
							title="Camera"
							why="The picture the labels sit on. It never leaves the phone."
							state={s.camera}
						/>
						<StepRow
							icon={<Compass className="size-4" />}
							title="Motion and compass"
							why="Which way you are facing and how you hold the phone."
							state={s.motion}
						/>
						<StepRow
							icon={<LocateFixed className="size-4" />}
							title="Location"
							why="Where the terrain is drawn from."
							state={s.location}
						/>
					</ul>
					<button
						type="button"
						onClick={session.start}
						disabled={s.phase === "starting"}
						className="mt-5 w-full rounded-lg bg-[var(--rigi-paper)] px-4 py-3 text-sm font-medium text-[var(--rigi-ink)] disabled:opacity-60"
					>
						{s.phase === "starting"
							? "Starting"
							: s.phase === "error"
								? "Try again"
								: "Start"}
					</button>
					{s.message && (
						<output
							className={cn(
								"block",
								"mt-3 text-sm",
								s.phase === "error"
									? "text-[var(--rigi-ember)]"
									: "text-white/65",
							)}
						>
							{s.message}
						</output>
					)}
					<p className="mt-6 text-xs text-white/45">
						The pose and the labels are suggestions from the phone's sensors and
						the skyline; they are not checked the way still photos are.
					</p>
				</div>
			)}
			<div
				className={cn(
					"relative mx-auto w-full flex-1",
					running ? "" : "hidden",
				)}
				style={{ maxHeight: "100dvh" }}
			>
				<div
					ref={refs.stageRef}
					className="relative mx-auto h-full max-h-dvh touch-none overflow-hidden bg-black"
					style={{ aspectRatio: frameAspect }}
					onPointerDown={(e) => {
						if (s.calibrating) drag.current = e.clientX;
					}}
					onPointerMove={(e) => {
						if (!s.calibrating || drag.current == null) return;
						// dragging right turns the scene right, so the heading offset goes the other way
						session.nudgeYaw(-(e.clientX - drag.current) * 0.1);
						drag.current = e.clientX;
					}}
					onPointerUp={() => {
						drag.current = null;
					}}
				>
					<canvas
						key={session.canvasKey}
						ref={refs.canvasRef}
						className="absolute inset-0 size-full touch-none"
					/>
					<div className="pointer-events-none absolute inset-0">
						{labels.map((l) => (
							<span
								key={l.name}
								className="absolute -translate-x-1/2 -translate-y-full whitespace-nowrap text-xs font-medium text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.85)]"
								style={{ left: `${l.u * 100}%`, top: `${l.v * 100}%` }}
							>
								{l.name}
								{l.ele != null ? (
									<span className="ml-1 text-white/70">
										{Math.round(l.ele)} m
									</span>
								) : null}
							</span>
						))}
					</div>
					{running && <StatusChip s={s} />}
					{s.calibrating && (
						<div className="pointer-events-none absolute inset-x-0 top-14 text-center text-xs text-white/85 [text-shadow:0_1px_3px_rgba(0,0,0,0.85)]">
							Drag sideways until the labels sit on their peaks · offset{" "}
							{s.yawOffset.toFixed(1)}°
						</div>
					)}
				</div>
				{running && (
					<div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-gradient-to-t from-black/60 to-transparent p-4">
						<button
							type="button"
							className={btn(s.calibrating)}
							onClick={() => session.setCalibrating(!s.calibrating)}
						>
							<Crosshair className="size-4" />{" "}
							{s.calibrating ? "Done" : "Calibrate"}
						</button>
						{s.yawOffset !== 0 && (
							<button
								type="button"
								className={btn(false)}
								onClick={session.resetCalibration}
							>
								Reset offset
							</button>
						)}
						<button
							type="button"
							className={btn(s.locked)}
							onClick={session.toggleLock}
						>
							{s.locked ? (
								<Unlock className="size-4" />
							) : (
								<Lock className="size-4" />
							)}{" "}
							{s.locked ? "Unlock pose" : "Lock pose"}
						</button>
						<button
							type="button"
							className={btn(false)}
							onClick={session.relocalise}
						>
							<LocateFixed className="size-4" /> Re-find
						</button>
						<button
							type="button"
							className={btn(false)}
							onClick={session.stop}
							aria-label="Stop"
						>
							<Square className="size-4" />
						</button>
					</div>
				)}
			</div>
		</div>
	);
}

const btn = (on: boolean) =>
	cn(
		"flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-medium backdrop-blur",
		on
			? "bg-[var(--rigi-paper)] text-[var(--rigi-ink)]"
			: "bg-white/12 text-[var(--rigi-paper)]",
	);
