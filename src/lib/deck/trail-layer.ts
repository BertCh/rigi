// Hiking trails for the deck photo view: the port of engine.ts buildTrails() + three's
// LineSegments2/LineMaterial (screen-space width in target pixels, vertex colours, opacity 0.95).
// Drawn ONLY in the offscreen colour pass (composite.ts), after the terrain tiles, with the same
// logarithmic gl_FragDepth as terrain-layer.ts so the terrain occludes them, and blended into the
// linear, straight-alpha colour target like three's trails in layerRT.
import {
	COORDINATE_SYSTEM,
	Layer,
	type LayerProps,
	project32,
	type UpdateParameters,
} from "@deck.gl/core";
import type { Buffer } from "@luma.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import { distanceM, type EnuFrame } from "../geodesy";
import type { RegionData } from "../photos";
import { trailClass, trailPalette } from "../style/deck-apply";
import { CLASSIC } from "../style/defaults";
import { currentTerrainPass, LOG_DEPTH_FAR } from "./terrain-layer";

export type TrailSegments = {
	/** 6 floats per segment: start xyz, end xyz (ENU metres). */
	positions: Float32Array;
	/** 3 floats per segment (linear rgb, as three's vertex colours). */
	colors: Float32Array;
	/** Trail class per segment (deck-apply.ts trailClass: hiking, mountain, alpine, other). */
	classes: Uint8Array;
	count: number;
};

type Palette = [number, number, number][];
/** engine.ts buildTrails colours per trail class (style.trails.colors; classic here). */
const CLASSIC_PALETTE = trailPalette(CLASSIC);

/** The same segments re-coloured from a palette (style.trails.colors): no re-sampling of heights. */
export function recolorTrailSegments(
	seg: TrailSegments,
	palette: Palette,
): TrailSegments {
	const colors = new Float32Array(seg.count * 3);
	for (let i = 0; i < seg.count; i++)
		colors.set(palette[seg.classes[i]], i * 3);
	return { ...seg, colors };
}

/**
 * engine.ts buildTrails: every trail densified to ≤ 40 m steps, draped at DEM + 2 m + 0.06 % of
 * the distance, segments within 80 m (horizontally) of the camera dropped.
 */
export function buildTrailSegments(
	region: RegionData,
	frame: EnuFrame,
	at: { lat: number; lon: number },
	heightAt: (lat: number, lon: number) => number | null | undefined,
	palette: Palette = CLASSIC_PALETTE,
): TrailSegments {
	const pos: number[] = [];
	const col: number[] = [];
	const cls: number[] = [];
	const tmp = [0, 0, 0];
	const place = (lon: number, lat: number) => {
		const h = heightAt(lat, lon);
		if (h == null) return null;
		const d = distanceM(at, { lat, lon });
		return frame.fromGeo(lat, lon, h + 2 + d * 0.0006, tmp).slice();
	};
	for (const tr of region.trails) {
		const k = trailClass(tr.sac);
		const c = palette[k];
		let prev: number[] | null = null;
		for (let i = 0; i < tr.coords.length; i++) {
			const [lon, lat] = tr.coords[i];
			if (i > 0) {
				const [plon, plat] = tr.coords[i - 1];
				const seg = distanceM({ lat: plat, lon: plon }, { lat, lon });
				const n = Math.max(1, Math.ceil(seg / 40));
				for (let k = 1; k <= n; k++) {
					const q = place(
						plon + ((lon - plon) * k) / n,
						plat + ((lat - plat) * k) / n,
					);
					if (
						q &&
						prev &&
						Math.hypot(q[0], q[1]) > 80 &&
						Math.hypot(prev[0], prev[1]) > 80
					) {
						pos.push(prev[0], prev[1], prev[2], q[0], q[1], q[2]);
						col.push(c[0], c[1], c[2]);
						cls.push(k);
					}
					prev = q;
				}
			} else prev = place(lon, lat);
		}
	}
	return {
		positions: new Float32Array(pos),
		colors: new Float32Array(col),
		classes: new Uint8Array(cls),
		count: col.length / 3,
	};
}

const uniformBlock = /* glsl */ `\
layout(std140) uniform trailUniforms {
  float width;
  float opacity;
  float logDepthFC;
  float srgbOut;
} trail;
`;

const trailModule = {
	name: "trail",
	vs: uniformBlock,
	fs: uniformBlock,
	uniformTypes: {
		width: "f32",
		opacity: "f32",
		logDepthFC: "f32",
		srgbOut: "f32",
	},
} as const satisfies ShaderModule;

const vs = /* glsl */ `#version 300 es
#define SHADER_NAME trail-vs
in vec2 positions;
in vec3 instanceStart;
in vec3 instanceEnd;
in vec3 instanceColor;
out vec3 vColor;
out float vLogW;
void main() {
  vec4 pc;
  vec4 a = project_position_to_clipspace(instanceStart, vec3(0.0), vec3(0.0), pc);
  vec4 b = project_position_to_clipspace(instanceEnd, vec3(0.0), vec3(0.0), pc);
  vColor = instanceColor;
  // trim at the near plane (LineSegments2 does the same) so behind-camera ends don't flip
  const float NEAR = 1.0;
  if (a.w < NEAR && b.w < NEAR) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vLogW = 1.0;
    return;
  }
  if (a.w < NEAR) a = mix(a, b, (NEAR - a.w) / (b.w - a.w));
  else if (b.w < NEAR) b = mix(b, a, (NEAR - b.w) / (a.w - b.w));
  vec2 half_res = 0.5 * project.viewportSize;
  vec2 sa = a.xy / a.w * half_res;
  vec2 sb = b.xy / b.w * half_res;
  vec2 dir = sb - sa;
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 p = positions.x < 0.5 ? a : b;
  // width in target pixels (three: LineMaterial linewidth at resolution = the render target)
  p.xy += nrm * positions.y * trail.width * 0.5 / half_res * p.w;
  gl_Position = p;
  vLogW = 1.0 + max(p.w, 1e-6);
}
`;

const fs = /* glsl */ `#version 300 es
#define SHADER_NAME trail-fs
precision highp float;
in vec3 vColor;
in float vLogW;
out vec4 fragColor;
void main() {
  gl_FragDepth = log2(vLogW) * trail.logDepthFC;
  // linear rgb, straight alpha: the colour pass target (composite.ts); sRGB-encoded when drawn
  // straight to the canvas (the world view, like three's LineMaterial colorspace_fragment)
  vec3 c = vColor;
  if (trail.srgbOut > 0.5) {
    c = max(c, vec3(0.0));
    c = mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
  }
  fragColor = vec4(c, trail.opacity);
}
`;

export type TrailLayerProps = LayerProps & {
	segments: TrailSegments | null;
	/** Line width in render-target pixels (three: 2.2). */
	widthPx?: number;
	/** three: 0.95 */
	lineOpacity?: number;
	/**
	 * Draw in the normal canvas pass (sRGB output) instead of the offscreen colour pass: the world
	 * view, where the terrain goes straight to the canvas.
	 */
	onCanvas?: boolean;
};

/** Trails for the offscreen colour pass only (or, with onCanvas, the canvas pass only). */
export class TrailLayer extends Layer<TrailLayerProps> {
	static layerName = "TrailLayer";
	declare state: { model?: Model; buffers?: Buffer[] };

	getShaders() {
		return super.getShaders({ vs, fs, modules: [project32, trailModule] });
	}

	initializeState() {
		this.rebuild();
	}

	updateState({ props, oldProps }: UpdateParameters<this>) {
		if (props.segments !== oldProps.segments) this.rebuild();
	}

	private rebuild() {
		this.state.model?.destroy();
		for (const b of this.state.buffers ?? []) b.destroy();
		const seg = this.props.segments;
		if (!seg || !seg.count) {
			this.setState({ model: undefined, buffers: [] });
			return;
		}
		const device = this.context.device;
		const n = seg.count;
		const starts = new Float32Array(n * 3);
		const ends = new Float32Array(n * 3);
		for (let i = 0; i < n; i++) {
			starts.set(seg.positions.subarray(i * 6, i * 6 + 3), i * 3);
			ends.set(seg.positions.subarray(i * 6 + 3, i * 6 + 6), i * 3);
		}
		const buffers = [starts, ends, seg.colors].map((data) =>
			device.createBuffer({ data }),
		);
		const model = new Model(device, {
			...this.getShaders(),
			id: this.props.id,
			geometry: new Geometry({
				topology: "triangle-list",
				attributes: {
					positions: {
						size: 2,
						value: new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]),
					},
				},
			}),
			bufferLayout: [
				{ name: "instanceStart", format: "float32x3", stepMode: "instance" },
				{ name: "instanceEnd", format: "float32x3", stepMode: "instance" },
				{ name: "instanceColor", format: "float32x3", stepMode: "instance" },
			],
			instanceCount: n,
		});
		model.setAttributes({
			instanceStart: buffers[0],
			instanceEnd: buffers[1],
			instanceColor: buffers[2],
		});
		this.setState({ model, buffers });
	}

	finalizeState(context: Parameters<Layer["finalizeState"]>[0]) {
		super.finalizeState(context);
		this.state.model?.destroy();
		for (const b of this.state.buffers ?? []) b.destroy();
	}

	draw() {
		const { model } = this.state;
		const pass = currentTerrainPass();
		if (!model || pass !== (this.props.onCanvas ? null : "color")) return;
		// deck resets instanceCount from getNumInstances() (no `data` here): set it per draw
		model.setInstanceCount(this.props.segments?.count ?? 0);
		model.shaderInputs.setProps({
			trail: {
				width: this.props.widthPx ?? 2.2,
				opacity: this.props.lineOpacity ?? 0.95,
				logDepthFC: 1 / Math.log2(LOG_DEPTH_FAR + 1),
				srgbOut: this.props.onCanvas ? 1 : 0,
			},
		});
		model.draw(this.context.renderPass);
	}
}

TrailLayer.defaultProps = {
	coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
	pickable: false,
	parameters: {
		cullMode: "none",
		depthWriteEnabled: false,
		depthCompare: "less-equal",
		blend: true,
		blendColorOperation: "add",
		blendColorSrcFactor: "src-alpha",
		blendColorDstFactor: "one-minus-src-alpha",
		blendAlphaOperation: "add",
		blendAlphaSrcFactor: "one",
		blendAlphaDstFactor: "one-minus-src-alpha",
	},
} as never;

export function isTrailLayer(layer: unknown): layer is TrailLayer {
	return layer instanceof TrailLayer;
}
