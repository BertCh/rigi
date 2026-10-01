// What every terroir overlay receives from TerroirLayer (one mount point in PhotoWorkspace).
import type { Renderer } from "#/lib/renderer";
import type { ViewStyle } from "#/lib/style/types";
import type { CoverGrid } from "../pack";
import type { TerroirPack } from "../types";

export type TerroirCtx = {
	engine: Renderer;
	pack: TerroirPack | null;
	cover: CoverGrid | null;
	style: ViewStyle;
	mode: "overlay" | "replace" | "world";
	/** stage size in CSS px */
	w: number;
	h: number;
	/** bumps on every engine frame (pose / geometry changed) */
	frame: number;
	/** the pose is a guess (unverified / prior): soften marks when style.terroir.uncertainty */
	uncertain: boolean;
	/** capture instant (UTC ISO) */
	takenAt: string | null;
	/** the stage element (for click listeners: the place card) */
	stageEl: HTMLElement | null;
};
