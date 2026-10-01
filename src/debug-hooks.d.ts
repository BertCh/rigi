// window.__* debug / harness hooks (dev probes, Playwright scripts, the console). All optional: most are
// set only under import.meta.env.DEV. Hooks whose payload is an ad-hoc object are typed unknown.
import type { Pose } from "./lib/camera";
import type { PickerLogEntry } from "./lib/picker/log";
import type { Renderer } from "./lib/renderer";
import type { RevealController } from "./lib/reveal/controller";
import type { RollMapEngine } from "./lib/roll/map/roll-map";
import type { tiles3dDeckStats } from "./lib/tiles3d/deck-layer";

declare global {
	interface Window {
		__engine?: Renderer;
		__reveal?: RevealController;
		__poseAtReady?: Pose;
		/** /photo on WebGPU: destroy the device (the engine rebuilds); `true` skips the rebuild and switches to WebGL deck. */
		__RIGI_FORCE_DEVICE_LOSS__?: (unrecoverable?: boolean) => void;
		__secondOpinion?: unknown;
		__eyeSearch?: unknown;
		__nearfield?: unknown;
		__concord?: unknown;
		__picker?: unknown;
		__pickerTap?: unknown;
		__pickerLog?: PickerLogEntry[];
		__roll?: RollMapEngine;
		__rollSpotLast?: unknown;
		__rollPanoTerrain?: unknown;
		__tiles3dDeck?: typeof tiles3dDeckStats;
		__genLab?: unknown;
		__splatLab?: unknown;
	}
}
