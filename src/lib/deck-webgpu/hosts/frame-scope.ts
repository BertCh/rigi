// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Which parts of a frame a request invalidates. "all" re-renders geometry + colour + screen;
// "color" re-renders colour + screen on the cached geometry (only the view / time moved: the
// geometry pass reads the photo camera and has no time input); "screen" re-runs the screen pass
// alone (composite-only changes). Shared by both hosts and the engine's frame scheduler.

export type FrameScope = "all" | "color" | "screen";

const RANK: Record<FrameScope, number> = { screen: 0, color: 1, all: 2 };

/** The wider of two scopes (a pending request upgraded by a later one). */
export function mergeScope(a: FrameScope, b: FrameScope): FrameScope {
	return RANK[b] > RANK[a] ? b : a;
}

/** The host's offscreen invalidation state: which passes the next frame must re-run. */
export class OffscreenDirty {
	private geometry = true;
	private color = true;

	/** A request of `scope`: "all" dirties both passes, "color" the colour pass, "screen" none. */
	request(scope: FrameScope) {
		if (scope === "all") this.geometry = this.color = true;
		else if (scope === "color") this.color = true;
	}

	/** Both passes (interactive switch, first frame). */
	markAll() {
		this.geometry = this.color = true;
	}

	/** The colour target changed (resize): geometry is unaffected. */
	markColor() {
		this.color = true;
	}

	/** The geometry target was recreated (photo aspect): it is empty until re-rendered. */
	markGeometry() {
		this.geometry = true;
		this.color = true; // colour reads the geometry target (drape / fill)
	}

	/** What the frame about to render must run; clears the flags. */
	take(): { geometry: boolean; color: boolean } {
		const r = { geometry: this.geometry, color: this.color };
		this.geometry = this.color = false;
		return r;
	}
}
