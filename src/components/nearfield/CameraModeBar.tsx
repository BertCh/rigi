// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Camera modes for the 3D views (bottom-centre): Photo / Orbit / Fly / Top-down. Step Inside opens in
// Photo; the In-map view opens in Orbit (its orbit controller) and hands the world camera to the step
// camera for the others (step-camera.ts). Keys 1–4 switch too, Esc goes back to the photo.
import { Camera, Map as MapIcon, Orbit, Plane } from "lucide-react";
import type { StepMode } from "#/lib/nearfield/step-camera";
import { cn } from "#/lib/utils";
import type { StepInside } from "./useStepInside";

const MODES: {
	mode: StepMode;
	label: string;
	icon: typeof Camera;
	hint: string;
}[] = [
	{
		mode: "photo",
		label: "Photo",
		icon: Camera,
		hint: "From the photographer’s viewpoint: drag to look around a little, right-drag to shift (1)",
	},
	{
		mode: "orbit",
		label: "Orbit",
		icon: Orbit,
		hint: "Rotate freely around a point: drag to rotate, right-drag to pan, scroll to zoom (2)",
	},
	{
		mode: "fly",
		label: "Fly",
		icon: Plane,
		hint: "Free flight: drag to look, WASD to move, Q / E down / up, Shift faster (3)",
	},
	{
		mode: "map",
		label: "Top-down",
		icon: MapIcon,
		hint: "Map view, north up: drag to pan, right-drag to rotate (and tilt), scroll to zoom (4)",
	},
];

export function CameraModeBar({ si }: { si: StepInside }) {
	if (!si.camModesAllowed) return null;
	return (
		<fieldset
			className="pointer-events-auto m-0 flex gap-0.5 border-0 rounded-lg bg-black/55 p-0.5 backdrop-blur"
			aria-label="Camera"
			data-camera-mode={si.camMode}
		>
			{MODES.map(({ mode, label, icon: Icon, hint }) => {
				const on = si.camMode === mode;
				return (
					<button
						key={mode}
						type="button"
						aria-pressed={on}
						title={hint}
						onClick={() => si.setCamMode(mode)}
						data-camera-mode-option={mode}
						className={cn(
							"flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold",
							on
								? "bg-[var(--rigi-ember)] text-[var(--khipu-w)]"
								: "text-white/80 hover:bg-white/10 hover:text-white",
						)}
					>
						<Icon className="size-3.5" />
						<span className="max-sm:hidden">{label}</span>
					</button>
				);
			})}
		</fieldset>
	);
}
