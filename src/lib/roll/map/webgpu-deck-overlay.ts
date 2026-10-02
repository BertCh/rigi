// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// A deck.gl overlay on the roll map's WebGPU device: draws RollFrame.extras (terroir names, camera
// halos, prior fans: ScatterplotLayer / PathLayer / PolygonLayer / TextLayer, WGSL in the vendored
// @deck.gl/layers) in deck's "world" view on top of the frame the luma-direct host just presented.
//
//   - The Deck is built on the SAME device (deck's `device` prop), so it shares the canvas context,
//     the compute adoption and the lifetime of the backend; deck.finalize() never destroys it.
//   - It is created on the first non-empty extras set (the landing has none: no deck cost).
//   - deck's own animation loop never draws: `_customRender` is the only way a frame happens. A draw
//     inside our frame (draw(), called right after the host submitted its screen pass) paints with
//     clearCanvas false, so deck loads the presented colour instead of wiping it; a deck-initiated
//     redraw (an icon atlas arrived, a canvas resize) asks the host for a frame instead (onNeedFrame),
//     which paints everything again, this overlay last.
//   - Deck's canvas pass has a depth attachment that is never cleared here and standard-Z projection,
//     so every extras layer must use depthCompare "always" (roll-map-extras.ts DEPTH_OFF does).
//   - No picking, no controllers: display only, like the WebGL path.
//
// Frame order consequence: the host draws terrain, drape, gizmos, extra cores (Spot 3D splats), pins,
// then this overlay, so deck extras end up OVER the pins (on WebGL the pins come last).
import { Deck } from "@deck.gl/core";
import type { Device } from "@luma.gl/core";
import { WorldView } from "#/lib/deck/world-view";

/** The slice of Deck this overlay drives (a fake in the spec). */
export interface OverlayDeck {
	setProps(p: Record<string, unknown>): void;
	redraw(reason?: string): void;
	finalize(): void;
	layerManager?: { updateLayers(): void } | null;
	/** Private deck API: draw with render options (clearCanvas: false keeps the host's frame). */
	_drawLayers?(reason: string, options?: Record<string, unknown>): void;
}

export type OverlayDeckProps = {
	device: Device;
	useDevicePixels: number;
	onLoad: () => void;
	onError: (e: Error) => void;
	customRender: (reason: string) => void;
};

export type DeckOverlayOptions = {
	pixelRatio: number;
	/** The overlay needs the host to draw a frame (deck redrew on its own, or its deck just loaded). */
	onNeedFrame: () => void;
	/** Test seam: how the Deck is built. */
	createDeck?: (p: OverlayDeckProps) => OverlayDeck;
};

/** near / far of the roll map's world view (backend-webgl.ts uses the same). */
export const OVERLAY_NEAR = 0.5;
export const OVERLAY_FAR = 600_000;

function createWorldDeck(p: OverlayDeckProps): OverlayDeck {
	return new Deck({
		device: p.device,
		width: null,
		height: null,
		// a number, so deck never resets the shared context to its default (true)
		useDevicePixels: p.useDevicePixels,
		views: [
			new WorldView({ id: "world", near: OVERLAY_NEAR, far: OVERLAY_FAR }),
		],
		layers: [],
		controller: false,
		_customRender: p.customRender,
		onLoad: p.onLoad,
		onError: p.onError,
	} as never) as unknown as OverlayDeck;
}

export class DeckExtrasOverlay {
	private deck: OverlayDeck | null = null;
	private loaded = false;
	private destroyed = false;
	private inFrame = false;
	private layers: readonly unknown[] = [];
	private layersDirty = false;
	private viewState: unknown = null;
	/** Frames this overlay painted (diagnostics / spec). */
	paints = 0;

	constructor(
		private device: Device,
		private opts: DeckOverlayOptions,
	) {}

	/** True once there is something to draw (and so a deck exists). */
	get active() {
		return this.layers.length > 0;
	}

	/** Set the layers for the next frame; an empty list stops drawing (the deck is kept). */
	setLayers(layers: readonly unknown[]) {
		if (this.destroyed) return;
		if (
			layers.length === this.layers.length &&
			layers.every((l, i) => l === this.layers[i])
		)
			return;
		this.layers = layers;
		this.layersDirty = true;
		if (layers.length) this.ensureDeck();
	}

	setViewState(viewState: unknown) {
		this.viewState = viewState;
	}

	setPixelRatio(ratio: number) {
		this.opts.pixelRatio = ratio;
		this.deck?.setProps({ useDevicePixels: ratio });
	}

	private ensureDeck() {
		if (this.deck || this.destroyed) return;
		const create = this.opts.createDeck ?? createWorldDeck;
		this.deck = create({
			device: this.device,
			useDevicePixels: this.opts.pixelRatio,
			customRender: (reason) => {
				if (this.inFrame) this.paint(reason);
				else this.opts.onNeedFrame();
			},
			onLoad: () => {
				this.loaded = true;
				this.opts.onNeedFrame();
			},
			onError: (e) => console.error("[roll-map overlay]", e),
		});
	}

	/**
	 * Draw the extras onto the canvas frame the host just submitted. Call it in the same task as that
	 * submit (a microtask after the screen pass), while the canvas texture is still the current one.
	 */
	draw() {
		const deck = this.deck;
		// an emptied list is pushed once (layersDirty), so deck drops the old layers
		if (!deck || !this.loaded || this.destroyed) return;
		if (!this.layers.length && !this.layersDirty) return;
		if (this.viewState == null) return;
		this.inFrame = true;
		try {
			const props: Record<string, unknown> = {
				viewState: { world: this.viewState },
			};
			if (this.layersDirty) {
				props.layers = this.layers;
				this.layersDirty = false;
			}
			deck.setProps(props);
			// apply the layers now: deck's own loop would do it a frame late
			deck.layerManager?.updateLayers();
			// redraw(reason) paints even when deck sees no change: the host cleared the canvas
			deck.redraw("rigi");
		} finally {
			this.inFrame = false;
		}
	}

	private paint(reason: string) {
		const deck = this.deck;
		if (!deck) return;
		if (deck._drawLayers) deck._drawLayers(reason, { clearCanvas: false });
		else
			console.warn(
				"[roll-map overlay] deck._drawLayers is missing: extras not drawn",
			);
		this.paints++;
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.layers = [];
		const deck = this.deck;
		this.deck = null;
		try {
			deck?.finalize();
		} catch {}
	}
}
