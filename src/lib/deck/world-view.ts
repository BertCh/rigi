// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// World view ("In map", settings.mode === 'world') for the deck backend: engine.ts enterWorld /
// renderWorld / buildFrustum / flyToPhoto, 1:1.
//   WorldCamera: a THREE.PerspectiveCamera driven by three's own OrbitControls (the same damping,
//     polar limit, pan and dolly as three's world view) and three's fly-in tween. Nothing is drawn
//     with three; the camera only feeds WorldView.
//   WorldView / WorldViewport: a deck view built from that camera (position, orientation, vfov).
//   WorldGizmoLayer: the photo camera (photo plane 150 m out, white frustum edges, red pin), with
//     the terrain's logarithmic depth so the terrain occludes it, and kept out of the offscreen
//     terrain passes (three hides the frustum for its geometry pass).
import {
	COORDINATE_SYSTEM,
	CompositeLayer,
	Layer,
	LayerExtension,
	type LayerProps,
	View,
	Viewport,
} from "@deck.gl/core";
import { BitmapLayer, LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import { Matrix4 } from "@math.gl/core";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { hfovFromAspect, type Pose } from "../camera";
import type { AtmValues } from "../look/atmosphere";
import {
	ATM_BLOCK,
	ATM_LUMA_MODULE,
	SKY_BLOCK,
	SKY_FS_DECK,
	SKY_VS,
	skyRayMatrix,
} from "../look/glsl/atmosphere";
import { poseBasis } from "../pose";
import { LOG_DEPTH_FAR } from "./terrain-layer";

/** engine.ts renderWorld: scene.background (the sky behind the world view), classic style. */
export const WORLD_SKY = "#a9c2da";

export type WorldViewState = {
	eye: [number, number, number];
	forward: [number, number, number];
	up: [number, number, number];
	/** Vertical field of view, degrees. */
	camFov: number;
	/**
	 * Distance (m) at which deck's pixel sizes (LineLayer widths, billboards) are exact: deck scales
	 * them relative to one focal distance. The gizmo's distance, so its 1 px edges stay 1 px.
	 */
	focalDistance: number;
};

type WorldViewportProps = WorldViewState & {
	id?: string;
	x?: number;
	y?: number;
	width: number;
	height: number;
	near?: number;
	far?: number;
};

export class WorldViewport extends Viewport {
	static displayName = "WorldViewport";
	readonly eye: [number, number, number];

	constructor(props: WorldViewportProps) {
		const {
			eye,
			forward,
			up,
			camFov,
			focalDistance,
			near = 1,
			far = 600_000,
		} = props;
		// rotation only; Viewport translates by -position itself (as PhotoViewport)
		const viewMatrix = new Matrix4().lookAt({
			eye: [0, 0, 0],
			center: forward,
			up,
		});
		super({
			...props,
			position: eye,
			viewMatrix,
			fovy: camFov,
			near,
			far,
			focalDistance: Math.max(1, focalDistance),
		});
		this.eye = eye;
	}
}

// driven by WorldCamera (three's OrbitControls), not by a deck controller
// biome-ignore lint/suspicious/noExplicitAny: see PhotoView
export class WorldView extends View<any, any> {
	static displayName = "WorldView";

	constructor(props: { id?: string; near?: number; far?: number } = {}) {
		super(props);
	}

	getViewportType() {
		return WorldViewport as never;
	}

	get ControllerType(): never {
		throw new Error("WorldView has no deck controller (see WorldCamera)");
	}
}

type Flight = {
	t0: number;
	dur: number;
	fromPos: THREE.Vector3;
	fromQ: THREE.Quaternion;
	fromFov: number;
	toQ: THREE.Quaternion;
	held?: boolean;
};

/** Photo camera orientation as three's applyPose sets it (engine.ts this.cam). */
export function poseQuaternion(p: Pose) {
	const { forward, right, up } = poseBasis(p);
	const m = new THREE.Matrix4().makeBasis(right, up, forward.clone().negate());
	return new THREE.Quaternion().setFromRotationMatrix(m);
}

/**
 * engine.ts's world camera: OrbitControls on the canvas, three's initial framing (2.5 km behind
 * and 1.4 km above the photographer, looking 3 km along the photo), and the fly-in tween.
 * `tick()` advances damping / the flight; it returns true when the camera moved.
 */
export class WorldCamera {
	readonly cam = new THREE.PerspectiveCamera(55, 1, 5, 600000);
	controls?: OrbitControls;
	flight?: Flight;
	/** style.world.frame.planeOpacity (classic 0.95): the photo plane's opacity at rest. */
	planeOpacity = 0.95;
	/** engine.ts photoPlane opacity (planeOpacity, fading out during the flight). */
	photoPlaneOpacity = 0.95;
	private last = new Float64Array(8);

	constructor(
		private canvas: HTMLCanvasElement,
		private onChange: () => void,
	) {}

	setAspect(a: number) {
		this.cam.aspect = a;
		this.cam.updateProjectionMatrix();
	}

	/** engine.ts enterWorld (camera + controls part). */
	enter(pose: Pose, eye: THREE.Vector3) {
		this.flight = undefined;
		this.photoPlaneOpacity = this.planeOpacity;
		const y = (pose.yaw * Math.PI) / 180;
		const forward = new THREE.Vector3(Math.sin(y), Math.cos(y), 0);
		// start behind and above the photographer, looking along the photo direction
		this.cam.fov = 55;
		this.cam.updateProjectionMatrix();
		this.cam.up.set(0, 0, 1);
		this.cam.position
			.copy(eye)
			.addScaledVector(forward, -2500)
			.add(new THREE.Vector3(0, 0, 1400));
		const target = eye.clone().addScaledVector(forward, 3000);
		target.z = eye.z - 200;
		this.controls?.dispose();
		const c = new OrbitControls(this.cam, this.canvas);
		c.target.copy(target);
		c.enableDamping = true;
		c.maxPolarAngle = Math.PI * 0.495;
		c.screenSpacePanning = false;
		c.addEventListener("change", this.onChange);
		c.update();
		this.controls = c;
	}

	exit() {
		this.controls?.dispose();
		this.controls = undefined;
		this.flight = undefined;
	}

	/** engine.ts flyToPhoto. */
	flyTo(pose: Pose, dur: number) {
		if (!this.controls) return;
		this.controls.enabled = false;
		this.flight = {
			t0: performance.now(),
			dur,
			fromPos: this.cam.position.clone(),
			fromQ: this.cam.quaternion.clone(),
			fromFov: this.cam.fov,
			toQ: poseQuaternion(pose),
		};
	}

	get isFlying() {
		return !!this.flight;
	}

	/** engine.ts renderWorld's camera update; true when the camera changed since the last tick. */
	tick(pose: Pose, eye: THREE.Vector3, photoAspect: number) {
		const f = this.flight;
		if (f && !f.held) {
			const t = Math.min((performance.now() - f.t0) / f.dur, 1);
			const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
			// arc over the terrain on the way in
			const pos = f.fromPos.clone().lerp(eye, e);
			pos.z += Math.sin(e * Math.PI) * 600;
			this.cam.position.copy(pos);
			this.cam.quaternion.slerpQuaternions(f.fromQ, f.toQ, e);
			// viewport aspect may differ from the photo: fit the photo's frame inside it
			const fitV = pose.vfov;
			const vfovForWidth = hfovFromAspect(
				pose.vfov,
				photoAspect / this.cam.aspect,
			);
			this.cam.fov = f.fromFov + (Math.max(fitV, vfovForWidth) - f.fromFov) * e;
			this.cam.updateProjectionMatrix();
			this.photoPlaneOpacity = this.planeOpacity * (1 - e);
			if (t >= 1) {
				f.held = true;
				this.photoPlaneOpacity = 0;
			}
		} else if (!f) {
			this.controls?.update();
		}
		const p = this.cam.position;
		const q = this.cam.quaternion;
		const now = [p.x, p.y, p.z, q.x, q.y, q.z, q.w, this.cam.fov];
		let moved = false;
		for (let i = 0; i < 8; i++)
			if (now[i] !== this.last[i]) {
				moved = true;
				this.last[i] = now[i];
			}
		return moved;
	}

	/** `focusOn`: the point whose pixel sizes should be exact (the photo camera). */
	viewState(focusOn?: THREE.Vector3): WorldViewState {
		const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.cam.quaternion);
		const u = new THREE.Vector3(0, 1, 0).applyQuaternion(this.cam.quaternion);
		const p = this.cam.position;
		return {
			eye: [p.x, p.y, p.z],
			forward: [f.x, f.y, f.z],
			up: [u.x, u.y, u.z],
			camFov: this.cam.fov,
			focalDistance: focusOn ? p.distanceTo(focusOn) : 1,
		};
	}

	dispose() {
		this.exit();
	}
}

// ---------- the atmospheric sky (style.world.sky.mode 'atmosphere') ----------

/** engine.ts makeSkyMesh: look/glsl atmSky on a fullscreen triangle, drawn first, no depth. */
export class AtmSkyLayer extends Layer<LayerProps & { atm: AtmValues }> {
	static layerName = "AtmSkyLayer";
	declare state: { model?: Model };

	initializeState() {
		this.setState({
			model: new Model(this.context.device, {
				id: this.props.id,
				vs: `#version 300 es\n${SKY_VS}`,
				fs: SKY_FS_DECK,
				modules: [ATM_LUMA_MODULE, SKY_BLOCK.lumaModule],
				topology: "triangle-list",
				vertexCount: 3,
				bufferLayout: [],
				parameters: { depthCompare: "always", depthWriteEnabled: false },
			}),
		});
	}

	finalizeState(context: Parameters<Layer["finalizeState"]>[0]) {
		super.finalizeState(context);
		this.state.model?.destroy();
	}

	draw() {
		const { model } = this.state;
		const vp = this.context.viewport;
		if (!model) return;
		model.shaderInputs.setProps({
			atmosphere: ATM_BLOCK.pack({ ...this.props.atm, eye: vp.cameraPosition }),
			sky: SKY_BLOCK.pack({
				ray: skyRayMatrix(vp.projectionMatrix, vp.viewMatrix),
			}),
		});
		model.draw(this.context.renderPass);
	}
}

// ---------- the photo camera gizmo ----------

const LOG_FC = (1 / Math.log2(LOG_DEPTH_FAR + 1)).toFixed(12);

/** Per-fragment log depth, matching the terrain's (one module object, like terrainLogDepthModule). */
const logDepthModule = {
	name: "logDepth",
	inject: {
		"vs:#decl": "out float vLogDepthW;",
		"vs:#main-end": "vLogDepthW = 1.0 + max(gl_Position.w, 1e-6);",
		"fs:#decl": "in float vLogDepthW;",
		"fs:#main-end": `gl_FragDepth = log2(vLogDepthW) * ${LOG_FC};`,
	},
} as const satisfies ShaderModule;

/** Writes the terrain's logarithmic depth (terrain-layer.ts) so the terrain occludes the layer. */
export class LogDepthExtension extends LayerExtension {
	static extensionName = "LogDepthExtension";
	getShaders() {
		return { modules: [logDepthModule] };
	}
}

type GizmoProps = LayerProps & {
	pose: Pose;
	eye: [number, number, number];
	aspect: number;
	image: HTMLImageElement | null;
	/** Photo plane opacity (three: 0.95, fading during the flight). */
	planeOpacity: number;
	/** Frustum edges, 0..255 sRGB RGBA (style.world.frame lineColor × lineOpacity). */
	lineColor?: [number, number, number, number];
	/** Pin colour, 0..255 sRGB RGBA, and radius in metres (style.world.frame). */
	pinColor?: [number, number, number, number];
	pinRadiusM?: number;
};

/**
 * engine.ts buildFrustum: the photo on a plane 150 m in front of the photo camera, its frustum
 * edges (white, 0.9) and an 18 m red pin at the eye; depth-tested against the terrain.
 */
export class WorldGizmoLayer extends CompositeLayer<GizmoProps> {
	static layerName = "WorldGizmoLayer";

	/** The pin's pixel radius follows the camera distance (see renderLayers). */
	shouldUpdateState({
		changeFlags,
	}: {
		changeFlags: { propsOrDataChanged: unknown; viewportChanged: boolean };
	}) {
		return !!changeFlags.propsOrDataChanged || changeFlags.viewportChanged;
	}

	/** Never in the offscreen terrain passes: the gizmo would occlude the drape's range map. */
	filterSubLayer({ renderPass }: { renderPass: string }) {
		return !renderPass.startsWith("terrain-");
	}

	renderLayers() {
		const { pose, eye, aspect, image, planeOpacity } = this.props;
		const lineColor = this.props.lineColor ?? [255, 255, 255, 230];
		const pinColor = this.props.pinColor ?? [255, 85, 51, 255];
		const pinR = this.props.pinRadiusM ?? 18;
		const { forward, right, up } = poseBasis(pose);
		const dist = 150;
		const hh = Math.tan((pose.vfov * Math.PI) / 360) * dist;
		const hw = hh * aspect;
		const corner = (sx: number, sy: number): [number, number, number] => [
			eye[0] + forward.x * dist + right.x * sx * hw + up.x * sy * hh,
			eye[1] + forward.y * dist + right.y * sx * hw + up.y * sy * hh,
			eye[2] + forward.z * dist + right.z * sx * hw + up.z * sy * hh,
		];
		const [tl, tr, br, bl] = [
			corner(-1, 1),
			corner(1, 1),
			corner(1, -1),
			corner(-1, -1),
		];
		const segs: [number[], number[]][] = [
			[eye, tl],
			[eye, tr],
			[eye, br],
			[eye, bl],
			[tl, tr],
			[tr, br],
			[br, bl],
			[bl, tl],
		];
		// three's 18 m sphere as a billboard disc: deck's pixel sizes hold at the viewport's focal
		// distance (WorldViewState.focalDistance = the camera's distance to the pin)
		const vp = this.context.viewport as Viewport & { focalDistance?: number };
		const pxPerM =
			(vp.projectionMatrix[5] * vp.height) /
			2 /
			Math.max(1, vp.focalDistance ?? 1);
		const ext = [new LogDepthExtension()];
		const common = {
			coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
			extensions: ext,
			pickable: false,
		};
		return [
			image &&
				new BitmapLayer({
					...this.getSubLayerProps({ id: "photo" }),
					...common,
					image,
					bounds: [bl, tl, tr, br] as never,
					opacity: planeOpacity,
					parameters: { cullMode: "none" },
				}),
			new LineLayer({
				...this.getSubLayerProps({ id: "edges" }),
				...common,
				data: segs,
				getSourcePosition: (d: [number[], number[]]) =>
					d[0] as [number, number, number],
				getTargetPosition: (d: [number[], number[]]) =>
					d[1] as [number, number, number],
				getColor: lineColor,
				updateTriggers: { getColor: lineColor.join() },
				getWidth: 1,
				widthUnits: "pixels",
			}),
			new ScatterplotLayer({
				...this.getSubLayerProps({ id: "pin" }),
				...common,
				data: [eye],
				getPosition: (d: number[]) => d as [number, number, number],
				getRadius: pinR * pxPerM,
				radiusUnits: "pixels",
				billboard: true,
				updateTriggers: {
					getRadius: pinR * pxPerM,
					getFillColor: pinColor.join(),
				},
				getFillColor: pinColor,
			}),
		].filter(Boolean);
	}
}
