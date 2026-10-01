// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Draws a subset of a live Deck's layers into an offscreen luma.gl framebuffer through one viewport,
// with public deck.gl / luma.gl API only (no `_LayersPass`). The offscreen terrain passes
// (geometry-pass.ts) and the splat colour pass (nearfield/deck-splat-layer.ts) use it.
//
// It issues the same GL calls, in the same order, as deck.gl 9.4's LayersPass.render() for one
// viewport on a WebGL device (layers-pass.ts _render / _getDrawLayerParams / _drawLayersInViewport
// and layer.ts _drawLayer), so the pixels are the same:
//   one render pass on `target` (clears per clearColor / clearCanvas; its initial viewport is the
//   canvas drawing buffer, as deck's), the viewport set to the target, then per drawn layer:
//   shader module props (layer, picking off, project + the deck default modules + overrides) on
//   every model, polygon offset from getPolygonOffset({ layerIndex }), the layer parameters on every
//   model, and draw() (extensions first) inside withParametersWebGL(parameters); then submit().
// Not reproduced, as no layer drawn here uses them: prop / attribute transitions (a layer's
// propsInTransition is its props without uniform transitions) and the private `_offset` prop
// (layerIndex is the draw order, which is what deck's resolver yields without `_offset`).
// WebGL only: the callers render into WebGL framebuffers and read them with GL calls.
import type {
	CompositeLayer,
	FilterContext,
	Layer,
	Viewport,
} from "@deck.gl/core";
import type { Device, Framebuffer, RenderPass } from "@luma.gl/core";
import type { WebGLDevice } from "@luma.gl/webgl";

export type OffscreenLayersOptions = {
	/** The layers to consider, in the Deck's order (LayerManager.getLayers()). */
	layers: Layer[];
	viewport: Viewport;
	target: Framebuffer;
	/** The pass name layers see in filterSubLayer({ renderPass }). */
	pass: string;
	/** RGBA 0..1, or false to keep the colour. Default [0, 0, 0, 0] when clearCanvas, else false. */
	clearColor?: number[] | false;
	/** Clear depth (to 1) and stencil (to 0) too. Default true. */
	clearCanvas?: boolean;
	/** Which layers this pass draws (a visible layer whose parents all let it through). */
	shouldDrawLayer: (layer: Layer) => boolean;
	/** The draw parameters of a drawn layer (merged over the Deck's `parameters` prop). */
	getLayerParameters: (layer: Layer) => Record<string, unknown>;
	/** Merged over each layer's shader module props, e.g. { project: { devicePixelRatio: 1 } }. */
	shaderModuleProps?: Record<string, Record<string, unknown>>;
};

type ModuleProps = Record<string, Record<string, unknown>>;

/** Draws the layers `opts.shouldDrawLayer` picks into `opts.target`. */
export function drawLayersOffscreen(
	device: Device,
	opts: OffscreenLayersOptions,
) {
	if (device.type !== "webgl")
		throw new Error("drawLayersOffscreen: WebGL devices only");
	const gl = device as unknown as WebGLDevice;
	const { layers, viewport, target, pass } = opts;
	const canvasContext = device.getDefaultCanvasContext();
	const [width, height] = canvasContext.getDrawingBufferSize();
	const clearCanvas = opts.clearCanvas ?? true;
	const clearColor = opts.clearColor ?? (clearCanvas ? [0, 0, 0, 0] : false);

	// which layers draw, with their index, module props and parameters (deck: _getDrawLayerParams)
	const drawContext: FilterContext = {
		layer: layers[0],
		viewport,
		isPicking: false,
		renderPass: pass,
	};
	const draws: {
		layer: Layer;
		layerIndex: number;
		moduleProps: ModuleProps;
		parameters: Record<string, unknown>;
	}[] = [];
	for (const layer of layers) {
		if (!shouldDraw(layer, drawContext, opts.shouldDrawLayer)) continue;
		draws.push({
			layer,
			layerIndex: draws.length,
			moduleProps: moduleProps(
				layer,
				canvasContext.cssToDeviceRatio(),
				opts.shaderModuleProps,
			),
			parameters: {
				...layer.context.deck?.props.parameters,
				...opts.getLayerParameters(layer),
			},
		});
	}

	const renderPass = device.beginRenderPass({
		framebuffer: target,
		parameters: { viewport: [0, 0, width, height] },
		clearColor,
		clearDepth: clearCanvas ? 1 : false,
		clearStencil: clearCanvas ? 0 : false,
	} as never);
	try {
		// viewport top-left CSS pixels → bottom-up GL pixels of the target (deck: getGLViewport)
		const ratio =
			(opts.shaderModuleProps?.project?.devicePixelRatio as
				| number
				| undefined) ?? canvasContext.cssToDeviceRatio();
		renderPass.setParameters({
			viewport: [
				viewport.x * ratio,
				target.height - (viewport.y + viewport.height) * ratio,
				viewport.width * ratio,
				viewport.height * ratio,
			],
		});
		for (const d of draws) {
			if (!d.layer.isDrawable) continue;
			d.moduleProps.project.viewport = viewport;
			d.layer.context.renderPass = renderPass;
			try {
				drawLayer(
					gl,
					d.layer,
					renderPass,
					d.moduleProps,
					d.layerIndex,
					d.parameters,
				);
			} catch (err) {
				d.layer.raiseError(err as Error, `drawing ${d.layer} to ${pass}`);
			}
		}
	} finally {
		renderPass.end();
		device.submit();
	}
}

/** Visible, picked by the pass, and let through by every (visible) parent's filterSubLayer. */
function shouldDraw(
	layer: Layer,
	drawContext: FilterContext,
	pick: (layer: Layer) => boolean,
) {
	if (!layer.props.visible || !pick(layer)) return false;
	drawContext.layer = layer;
	for (let parent = layer.parent; parent; parent = parent.parent) {
		if (
			!parent.props.visible ||
			!(parent as CompositeLayer).filterSubLayer(drawContext)
		)
			return false;
		drawContext.layer = parent;
	}
	// a drawn layer's viewportChanged flag follows the viewport it is drawn in, as in deck's passes
	layer.activateViewport(drawContext.viewport);
	return true;
}

/** deck's per-layer shader module props: layer, picking (off), project, the default modules. */
function moduleProps(
	layer: Layer,
	devicePixelRatio: number,
	overrides: ModuleProps | undefined,
): ModuleProps {
	const props = layer.props;
	const out: ModuleProps = {
		layer: props as unknown as Record<string, unknown>,
		picking: { isActive: false },
		project: {
			viewport: layer.context.viewport,
			devicePixelRatio,
			modelMatrix: props.modelMatrix,
			coordinateSystem: props.coordinateSystem,
			coordinateOrigin: props.coordinateOrigin,
			autoWrapLongitude: layer.wrapLongitude,
		},
	};
	for (const module of layer.context.defaultShaderModules)
		out[module.name] ??= {};
	for (const key in overrides) {
		if (out[key]) Object.assign(out[key], overrides[key]);
		else out[key] = overrides[key];
	}
	return out;
}

/** One layer's draw (deck: Layer._drawLayer on WebGL). */
function drawLayer(
	device: WebGLDevice,
	layer: Layer,
	renderPass: RenderPass,
	shaderModuleProps: ModuleProps,
	layerIndex: number,
	parameters: Record<string, unknown>,
) {
	const uniforms = { layerIndex };
	layer.setShaderModuleProps(shaderModuleProps);
	const { getPolygonOffset } = layer.props;
	device.setParametersWebGL({
		polygonOffset: getPolygonOffset?.(uniforms) || [0, 0],
	});
	for (const model of layer.getModels()) model.setParameters(parameters);
	device.withParametersWebGL(parameters, () => {
		const drawOpts = {
			renderPass,
			shaderModuleProps,
			uniforms,
			parameters,
			context: layer.context,
		};
		for (const extension of layer.props.extensions)
			extension.draw.call(layer, drawOpts, extension);
		layer.draw(drawOpts);
	});
}
