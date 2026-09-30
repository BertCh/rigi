// PhotoEngine: renders a georeferenced photo against DEM terrain.
//   photo views ("overlay" / "replace") render from the photo's camera:
//     geometry pass → float ENU/range buffer (read back for labels, hover, occlusion)
//     layer pass    → styled terrain (contours / map / hillshade) + trails
//     composite     → photo ⊕ layer with ridge lines, depth tint and blend masks
//   "world" view orbits freely over the terrain with the photo projected onto it.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import {
	type AlignResult,
	autoAlign,
	buildEdgeMap,
	type EdgeMap,
	type Pin,
	solvePins,
} from "./align";
import type { Pose } from "./camera";
import type { ResidualField } from "./concord/core";
import { WARP_GLSL, WarpState } from "./concord/field";
import { startLakeFloor } from "./geocam/lakes/fetch";
import { priorHeading } from "./geocam/priors/heading";
import { distanceM, EnuFrame } from "./geodesy";
import { autoAlignAsync, warmAlignGpu } from "./gpu/align";
import { lookIdle } from "./gpu/look/opt-in";
import {
	type FastHorizon,
	startFastHorizon,
} from "./integration/horizon-fast-app";
import { photoUnknowns, type Unknowns } from "./integration/unknown-pose";
import {
	blendCut,
	blendCutKey,
	CompositeLook,
	compositeValues,
	gridSize,
	harmonizeValues,
	type RangeGrid,
	STATS_LONG_SIDE,
	trustedRange,
} from "./look/composite";
import { skyRayMatrix } from "./look/glsl/atmosphere";
import { TURBO_GLSL } from "./look/glsl/common";
import {
	COMP_BLOCK,
	COMPOSITE_DEFINES,
	compositeChunk,
	HARM_BLOCK,
} from "./look/glsl/composite";
import { HazeController } from "./look/haze-controller";
import type { SkyMask } from "./look/haze-fit";
import {
	declutterClassic,
	drawExportLabels,
	peakRank,
	rankPeaks,
	skylineAt,
} from "./look/labels";
import { lookKey, terrainDefines, withSlopeLayer } from "./look/look-key";
import { ReliefController } from "./look/relief/field";
import {
	makeSharedUniforms,
	makeSkyMesh,
	makeTerrainMaterial,
	RAMP_GLSL,
	STYLE,
} from "./materials";
import {
	buildMeasureGrid,
	type MeasurableScene,
	type NearFieldSample,
	nearFieldSampleAt,
} from "./nearfield/measure";
import {
	loadNearDem,
	type NearDem,
	nearFieldDemRangeFrom,
} from "./nearfield/near-dem";
import { PROVENANCE_COLORS, PROVENANCE_TINT_MIX } from "./nearfield/provenance";
import {
	makePhotoSky,
	type PhotoSky,
	StepCamera,
	type StepInsideOpts,
	type StepView,
} from "./nearfield/step-camera";
import { ThreeSplats } from "./nearfield/three-splats";
import {
	type NearFieldScene,
	type NearFieldViewOpts,
	PixelClass,
} from "./nearfield/types";
import type { PhotoMeta, RegionData, RegionTrail } from "./photos";
import { applyPose, projectPoint, unprojectDir } from "./pose";
import type { RevealUniforms } from "./reveal/config";
import { REVEAL_GLSL } from "./reveal/glsl";
import { CLASSIC } from "./style/defaults";
import {
	applyAtmosphereLook,
	applyCompositeStyle,
	applyLayerStyle,
	applyReliefLook,
	applySlopeLook,
	applyTerrainLook,
	makeCompositeStyleUniforms,
	type StyleMode,
	setColor,
	trailColor,
} from "./style/three-apply";
import type { ViewStyle } from "./style/types";
import { heightFromTile, type ImagerySource, Terrain } from "./terrain";
import { ThreeTiles3D } from "./tiles3d/three-tiles";
import { TILES3D_LAYER } from "./tiles3d/tiles";

export type ViewMode = "overlay" | "replace" | "world";

/**
 * THREE layer of the Step Inside splats (src/lib/nearfield). Only the world / step-inside camera enables
 * it, so the geometry, layer, normal, stats, silhouette and horizon passes (layer 0 cameras) never draw
 * or re-sort them.
 */
export const NEARFIELD_LAYER = 7;
/** The world camera's near plane (m) without a near-field scene. */
const WORLD_NEAR = 5;
type NearFieldMasks = {
	worldFg: THREE.DataTexture;
	worldObj: THREE.DataTexture;
	step: THREE.DataTexture;
	sky: THREE.DataTexture;
};
export type LayerStyle =
	| "contours"
	| "bands"
	| "satellite"
	| "topo"
	| "hillshade";
export type BlendMethod = "swipe" | "lens" | "range" | "brush";

export type Settings = {
	mode: ViewMode;
	// overlay
	overlayStyle: "contours" | "bands" | "slope" | "none";
	contourInterval: number;
	layerOpacity: number;
	ridges: number;
	depthTint: number;
	trails: boolean;
	// replace
	mapStyle: "satellite" | "topo" | "hillshade" | "bands";
	method: BlendMethod;
	swipe: number;
	lens: [number, number];
	lensR: number;
	rangeKm: number;
	keepSky: boolean;
	feather: number;
	// world
	projectOpacity: number;
	minProjectRange: number;
	worldStyle: "satellite" | "topo" | "hillshade";
	protectPeople: boolean;
	/** fade overlay terrain closer than this (m); unreliable within the GPS error */
	nearFade: number;
};

export const defaultSettings: Settings = {
	mode: "overlay",
	overlayStyle: "contours",
	contourInterval: 50,
	layerOpacity: 0.9,
	ridges: 0.8,
	depthTint: 0,
	// off by default: uploads fetch their paths from Overpass only when switched on
	trails: false,
	mapStyle: "satellite",
	method: "lens",
	swipe: 0.5,
	lens: [0.5, 0.4],
	lensR: 0.18,
	rangeKm: 3,
	keepSky: true,
	feather: 0.03,
	projectOpacity: 1,
	minProjectRange: 80,
	worldStyle: "satellite",
	protectPeople: true,
	nearFade: 60,
};

export type PeakLabel = {
	name: string;
	ele: number | null;
	/** OSM prominence (m), null if unknown */
	prominence?: number | null;
	u: number;
	v: number;
	distKm: number;
	rank: number;
	visible: boolean;
	world: [number, number, number];
};

export type Sample = {
	lat: number;
	lon: number;
	h: number;
	range: number;
	world: [number, number, number];
};

const quadVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const compositeFrag = /* glsl */ `
uniform sampler2D tPhoto;
uniform sampler2D tLayer;
uniform sampler2D tGeo;
uniform sampler2D tBrush;
uniform sampler2D tFg;
uniform float uFgOn;
uniform vec2 uGeoTexel;
uniform int uMode;
uniform float uLayerOpacity;
uniform float uRidges;
uniform float uDepthTint;
uniform int uMethod;
uniform float uSwipe;
uniform vec2 uLens;
uniform float uLensR;
uniform float uRange;
uniform float uKeepSky;
uniform float uFeather;
uniform float uAspect;
uniform float uNearFade;
// overlay reveal (src/lib/reveal): read only while uReveal.w > 0
uniform vec4 uReveal;
uniform vec4 uRevealWin;
uniform vec4 uRevealQD;
uniform vec4 uRevealQE;
uniform vec4 uRevealShape;
uniform vec4 uRevealFocus;
uniform vec4 uRevealGlow;
uniform vec3 uRevealF;
uniform vec3 uRevealR;
uniform vec3 uRevealU;
// view style (style/three-apply.ts applyCompositeStyle); defaults = the classic literals
${RAMP_GLSL}
uniform vec3 uRidgeInner;
uniform vec3 uRidgeSky;
uniform vec2 uRidgeThr;
uniform float uRidgeGainO;
uniform vec3 uRidgeInnerR;
uniform float uRidgeGainR;
uniform vec3 uHairCol;
uniform float uHairAlpha;
uniform vec2 uDepthLog;
uniform float uDepthGain;
uniform vec2 uDepthLuma;
uniform int uDepthRampKind;
uniform vec3 uDepthRampC[RAMP_MAX];
uniform float uDepthRampT[RAMP_MAX];
uniform float uDepthRampD[RAMP_MAX];
uniform float uDepthRampE[RAMP_MAX];
uniform int uDepthRampN;
// concord display warp (?concord=warp; src/lib/concord/field): off (uWarpOn = 0) ⇒ uvG == vUv exactly
uniform sampler2D tWarp;
uniform float uWarpScale;
uniform float uWarpOn;
// concord DSM occluder (?concord=occl; src/lib/concord/occl): dim mask, row 0 = top like tFg; off ⇒ no read
uniform sampler2D tOccl;
uniform float uOcclOn;
varying vec2 vUv;

${TURBO_GLSL}
${REVEAL_GLSL}
${WARP_GLSL}
${compositeChunk(`uniform sampler2D tCompMask;
uniform sampler2D tCompNormal;
#define GEO_RANGE(p) texelFetch(tGeo, p, 0).a
#define GEO_SIZE textureSize(tGeo, 0)
#define LAYER(uv) texture2D(tLayer, uv)
#define MASK(uv) texture2D(tCompMask, uv)
#define NORMAL(p) texelFetch(tCompNormal, p, 0)
#define NORMAL_SIZE textureSize(tCompNormal, 0)
${COMP_BLOCK.threeDecl}${HARM_BLOCK.threeDecl}`)}

float lr(vec2 uv) {
  float r = texture2D(tGeo, uv).a;
  return r > 0.0 ? log(r) : 13.5; // sky ≈ 700 km
}

void main() {
  vec4 photo = texture2D(tPhoto, vUv);
  // render-space reads (tLayer, tGeo) at uvG; photo-space reads (tPhoto, tFg, tBrush, masks) at vUv
  vec2 uvG = warpUV(tWarp, uWarpScale, uWarpOn, vUv);
#ifdef LOOK_REFINE
  vec4 layer = layerAt(uvG);
#else
  vec4 layer = texture2D(tLayer, uvG);
#endif
  float range = texture2D(tGeo, uvG).a;
  vec3 col = photo.rgb;
  // people & other foreground: keep the photo untouched there
  float fg = uFgOn * texture2D(tFg, vUv).r;
  // terrain coverage (look composite: snapped to the photo's edges while the refined masks are fresh)
  float cov = layer.a;
#ifdef LOOK_REFINE
  if (comp_refine > 0.5) {
    vec4 ref = MASK(vUv);
    cov = softMask(ref.r);
    fg = uFgOn * softMask(ref.b);
  }
#endif
  // concord DSM occluder: a tree / hut in front of the terrain this pixel shows dims it (dim, don't hide)
  if (uOcclOn > 0.5) fg = max(fg, 0.8 * texture2D(tOccl, vUv).r);

  // silhouettes: discontinuities in log-range
  float c = lr(uvG);
  vec2 o = uGeoTexel * 1.25;
  float e = max(max(abs(c - lr(uvG + vec2(o.x, 0.0))), abs(c - lr(uvG - vec2(o.x, 0.0)))),
                max(abs(c - lr(uvG + vec2(0.0, o.y))), abs(c - lr(uvG - vec2(0.0, o.y)))));
  float isSkyline = (range > 0.0 && texture2D(tGeo, uvG + vec2(0.0, o.y)).a == 0.0) ? 1.0 : 0.0;
  float ridge = smoothstep(uRidgeThr.x, uRidgeThr.y, e);
  if (uNearFade > 0.0) ridge *= range > 0.0 ? smoothstep(uNearFade * 0.5, uNearFade, range) : 1.0;
#ifdef LOOK_INK
  vec2 ink = inkLines(uvG, range, uNearFade, cov);
#endif
#ifdef LOOK_OUTPUT
  float grainA = 0.0;
#endif
  // reveal: x = overlay alpha, y = light band, z = ridge alpha (1, 0, 1 when off)
  vec3 rv = vec3(1.0, 0.0, 1.0);
  if (uReveal.w > 0.0) rv = revealAt(uvG, range, uReveal, uRevealWin, uRevealQD, uRevealQE, uRevealShape, uRevealFocus, uRevealF, uRevealR, uRevealU, uAspect);

  if (uMode == 0) {
    if (uDepthTint > 0.0 && range > 0.0 && fg < 0.5) {
      float t = clamp((log(range) - uDepthLog.x) * uDepthLog.y, 0.0, 1.0);
      vec3 dc = uDepthRampKind == 0 ? turbo(t) : pow(rampEval(uDepthRampC, uDepthRampT, uDepthRampD, uDepthRampE, uDepthRampN, t), vec3(2.2));
      col = mix(col, dc * (uDepthLuma.x + uDepthLuma.y * dot(col, vec3(0.333)) * 1.4), uDepthTint * uDepthGain * rv.x);
    }
    col = mix(col, layer.rgb, layer.a * uLayerOpacity * (1.0 - fg) * rv.x);
#ifdef LOOK_INK
    col = applyInk(col, ink, uRidges * (1.0 - fg) * rv.z);
#else
    vec3 ridgeCol = mix(uRidgeInner, uRidgeSky, isSkyline);
    col = mix(col, ridgeCol, ridge * uRidges * uRidgeGainO * (1.0 - fg) * rv.z);
#endif
    if (uReveal.w > 0.0) col = revealLight(col, rv, range, layer.a * uLayerOpacity, ridge * uRidges, uRevealGlow, uRevealShape.w, 1.0 - fg);
  } else {
    float m = 0.0;
    float f = max(uFeather, 0.001);
    if (uMethod == 0) m = smoothstep(uSwipe - f * 0.5, uSwipe + f * 0.5, vUv.x);
    else if (uMethod == 1) {
      float d = length((vUv - uLens) * vec2(uAspect, 1.0));
      m = 1.0 - smoothstep(uLensR - f, uLensR + f, d);
    } else if (uMethod == 2) {
      float rr = range > 0.0 ? range : 1e9;
      m = smoothstep(uRange * (1.0 - f * 4.0), uRange * (1.0 + f * 4.0), rr);
    } else m = texture2D(tBrush, vUv).r;
#ifdef LOOK_REFINE
    // the range / brush cut snapped to the photo's edges
    if (comp_cut > 0.5 && uMethod >= 2) m = softMask(MASK(vUv).g);
#endif
    // hairline where the user's mask edge crosses (not around sky or people)
    float edgeLine = (1.0 - abs(m - 0.5) * 2.0) * cov * (1.0 - fg);
    if (uKeepSky > 0.5) m *= cov;
    m *= 1.0 - fg;
    float m0 = m;
    m *= rv.x;
#if defined(LOOK_REFINE) || defined(LOOK_HARMONIZE) || defined(LOOK_OUTPUT)
    float a = m * (LAYER_PREMUL ? 1.0 : max(layer.a, 1.0 - uKeepSky));
    col = mix(col, lookLayer(layer.rgb, range), a);
#else
    col = mix(col, layer.rgb, m * max(layer.a, 1.0 - uKeepSky));
#endif
#ifdef LOOK_OUTPUT
    grainA = a;
#endif
    if (uMethod != 3) col = mix(col, uHairCol, smoothstep(0.7, 1.0, edgeLine) * uHairAlpha);
#ifdef LOOK_INK
    col = applyInk(col, ink, uRidges * m);
#else
    col = mix(col, uRidgeInnerR, ridge * uRidges * uRidgeGainR * m);
#endif
    if (uReveal.w > 0.0) col = revealLight(col, rv, range, m0, ridge * uRidges * m0, uRevealGlow, uRevealShape.w * m0, 1.0 - fg);
  }
#ifdef LOOK_OUTPUT
  gl_FragColor = vec4(lookOutput(col, grainA, gl_FragCoord.xy), 1.0);
#else
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
#endif
}
`;

function blankTexture() {
	const t = new THREE.DataTexture(new Uint8Array(4), 1, 1);
	t.needsUpdate = true;
	return t;
}

type PeakPoint = {
	name: string;
	ele: number | null;
	prominence: number | null;
	world: THREE.Vector3;
	dist: number;
};

/**
 * Eye height (m MSL) from the photo's altitude and the DEM at the camera. iPhone altitude (barometer-aided)
 * is usually better than the horizontal fix: near summits a few metres of horizontal error put the DEM
 * point far down the slope. Never go underground.
 */
const eyeAltitude = (alt: number | null | undefined, dem: number) =>
	alt != null ? Math.max(alt, dem + 1.6) : dem + 1.8;

export class PhotoEngine {
	readonly renderer: THREE.WebGLRenderer;
	readonly photo: PhotoMeta;
	readonly aspect: number;
	settings: Settings = { ...defaultSettings };
	/** How the views look (src/lib/style). Global per user, unlike `settings`; see setStyle(). */
	style: ViewStyle = CLASSIC;
	pose: Pose;
	readonly prior: Pose;
	/** Sensor values the photo lacks (uploads): the prior is a placeholder there, see PhotoWorkspace. */
	readonly unknowns: Unknowns;
	terrain?: Terrain;
	frame: EnuFrame;
	eye = new THREE.Vector3();
	eyeAlt = 0;
	demAtCamera = 0;

	private shared = makeSharedUniforms();
	/** The style's LOOK_* defines (look-key.ts) on every terrain material; {} = classic. */
	private lookDefines: Record<string, string> = {};
	/** The terrain materials' share of them (look-key.ts terrainDefines). */
	private terrainDefines: Record<string, string> = {};
	/** Fitted haze (airlight 'fitted'), refit after fresh readbacks. */
	private haze = new HazeController();
	/** The Swiss relief's field (LOOK_RELIEF), rebuilt at pose settle when the sun, yaw or tiles change. */
	private relief = new ReliefController();
	/** The look composite's CPU side (refined masks, band stats, photo noise), made at pose settle. */
	private look = new CompositeLook();
	private lookVersion = -1;
	private maskTex?: THREE.DataTexture;
	/** The normal pass (LOOK_INK creases) and the geometry generation it holds. */
	private normalRT?: THREE.WebGLRenderTarget;
	private normalGen = -1;
	/** The layer at ≤ 256 px for the band stats (LOOK_HARMONIZE). */
	private statsRT?: THREE.WebGLRenderTarget;
	private imageryDone = 0;
	/** Bumps whenever the layer's look changes without a pose change (style, haze fit, relief field): the band stats' key. */
	private layerGen = 0;
	/** Brush strokes so far (the refined cut's key) and the debounce for re-refining after an edit. */
	private brushVersion = 0;
	private lookTimer = 0;
	/** World view atmospheric sky (world.sky.mode 'atmosphere'), made on first use. */
	private skyMesh?: ReturnType<typeof makeSkyMesh>;
	private scene = new THREE.Scene();
	private cam = new THREE.PerspectiveCamera(50, 1, 1, 400000);
	private worldCam = new THREE.PerspectiveCamera(55, 1, WORLD_NEAR, 600000);
	/** Step Inside 3D Tiles (src/lib/tiles3d); null unless ?tiles3d= is on. */
	private tiles3d: ThreeTiles3D | null = null;
	private controls?: OrbitControls;
	private geoRT: THREE.WebGLRenderTarget;
	private layerRT: THREE.WebGLRenderTarget;
	private geoBuf: Float32Array;
	private geoDirty = true;
	/**
	 * Geometry generations. `geoGen` bumps on every change that alters the geometry pass (pose,
	 * terrain); `geoRTGen` is the generation drawn into geoRT and `geoBufGen` the one in the CPU copy
	 * (geoBuf) that sampleAt()/peakLabels() read. geoBuf is only valid for the current pose when
	 * geoBufGen === geoGen: the timed readback lags a pose change by ≥90 ms.
	 */
	private geoGen = 0;
	private geoRTGen = -1;
	private geoBufGen = -1;
	private readbackWaiters: ((ok: boolean) => void)[] = [];
	/** Occlusion verdicts from the last fresh geometry buffer (eye-dependent only, not rotation). */
	private peakVis = new Map<PeakPoint, boolean>();
	private composite: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
	private compScene = new THREE.Scene();
	private orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
	private photoTex?: THREE.Texture;
	private photoImg?: HTMLImageElement;
	private edge?: EdgeMap;
	private horizonDirs?: Float32Array;
	private peaks: PeakPoint[] = [];
	private region: RegionData | null = null;
	private readbackTimer = 0;
	private trails?: LineSegments2;
	private trailMat?: LineMaterial;
	/** SAC difficulty per trail vertex (0 hiking, 1 mountain, 2 alpine, 3 other), for recolorTrails() */
	private trailSac?: string[];
	private frustum?: THREE.Group;
	private photoPlane?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
	private frustumLines?: THREE.LineSegments<
		THREE.BufferGeometry,
		THREE.LineBasicMaterial
	>;
	private frustumPin?: THREE.Mesh<
		THREE.SphereGeometry,
		THREE.MeshBasicMaterial
	>;
	/** Local elevation range for the colour ramps (init), unless the style fixes an absolute one. */
	private localElevRange?: [number, number];
	readonly brushCanvas: HTMLCanvasElement;
	private brushTex: THREE.CanvasTexture;
	private fgTex: THREE.DataTexture = new THREE.DataTexture(
		new Uint8Array([0, 0, 0, 255]),
		1,
		1,
	);
	hasForeground = false;
	private fgMask: { width: number; height: number; data: Uint8Array } | null =
		null;
	private raf = 0;
	private listeners = new Set<() => void>();
	private flight?: {
		t0: number;
		dur: number;
		fromPos: THREE.Vector3;
		fromQ: THREE.Quaternion;
		fromFov: number;
		toQ: THREE.Quaternion;
		held?: boolean;
	};
	private disposed = false;
	/** Aborted on dispose: a superseded engine (StrictMode, fast navigation) stops loading tiles. */
	private loadAbort = new AbortController();
	/** Step Inside (src/lib/nearfield): splats, drape masks and the step camera; all null when off. */
	private nf: {
		scene: NearFieldScene;
		splats: ThreeSplats;
		opts: NearFieldViewOpts;
		masks: NearFieldMasks | null;
	} | null = null;
	private step: {
		cam: StepCamera;
		sky: PhotoSky;
		fromWorld: boolean;
		/** 'step': Step Inside (splats, photo sky, full drape); 'map': the In-map view's own style. */
		view: StepView;
	} | null = null;
	/** The last setSkyMask() mask (P(sky) 0..255), for Step Inside's split. */
	private skyMaskStore: SkyMask | null = null;
	cssSize = { w: 1, h: 1 };

	constructor(canvas: HTMLCanvasElement, photo: PhotoMeta) {
		this.photo = photo;
		this.aspect = photo.width / photo.height;
		this.renderer = new THREE.WebGLRenderer({
			canvas,
			antialias: true,
			logarithmicDepthBuffer: true,
			alpha: false,
			preserveDrawingBuffer: true,
		});
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.prior = {
			yaw: priorHeading(photo) ?? 0,
			pitch: photo.pitch ?? 0,
			roll: photo.roll ?? 0,
			vfov: photo.vfov,
		};
		this.pose = { ...this.prior };
		this.unknowns = photoUnknowns(photo);
		this.frame = new EnuFrame(photo.lat, photo.lon, 0);
		// opt-in look passes on the GPU (gpu/look, ?lookgpu=1): results land after the settle frame
		this.haze.onAsync = this.relief.onAsync = () => {
			if (this.disposed) return;
			this.layerGen++;
			this.requestRender();
		};
		this.look.onAsync = () => this.requestRender();
		const gw = this.aspect >= 1 ? 1024 : Math.round(1024 * this.aspect);
		const gh = this.aspect >= 1 ? Math.round(1024 / this.aspect) : 1024;
		this.geoRT = new THREE.WebGLRenderTarget(gw, gh, {
			type: THREE.FloatType,
			format: THREE.RGBAFormat,
			minFilter: THREE.NearestFilter,
			magFilter: THREE.NearestFilter,
			depthBuffer: true,
		});
		this.geoBuf = new Float32Array(gw * gh * 4);
		this.layerRT = new THREE.WebGLRenderTarget(4, 4, {
			type: THREE.HalfFloatType,
			depthBuffer: true,
			samples: 4,
		});
		this.brushCanvas = document.createElement("canvas");
		this.brushCanvas.width = 512;
		this.brushCanvas.height = Math.round(512 / this.aspect);
		this.brushTex = new THREE.CanvasTexture(this.brushCanvas);
		this.composite = new THREE.Mesh(
			new THREE.PlaneGeometry(2, 2),
			new THREE.ShaderMaterial({
				vertexShader: quadVert,
				fragmentShader: compositeFrag,
				depthTest: false,
				depthWrite: false,
				uniforms: {
					tPhoto: { value: null },
					tLayer: { value: this.layerRT.texture },
					tGeo: { value: this.geoRT.texture },
					tBrush: { value: this.brushTex },
					tFg: { value: this.fgTex },
					uFgOn: { value: 1 },
					uGeoTexel: { value: new THREE.Vector2(1 / gw, 1 / gh) },
					uMode: { value: 0 },
					uLayerOpacity: { value: 1 },
					uRidges: { value: 1 },
					uDepthTint: { value: 0 },
					uMethod: { value: 1 },
					uSwipe: { value: 0.5 },
					uLens: { value: new THREE.Vector2(0.5, 0.5) },
					uLensR: { value: 0.2 },
					uRange: { value: 3000 },
					uKeepSky: { value: 1 },
					uFeather: { value: 0.02 },
					uAspect: { value: this.aspect },
					uNearFade: { value: 0 },
					uReveal: { value: new THREE.Vector4(0, 0, 0, 0) },
					uRevealWin: { value: new THREE.Vector4() },
					uRevealQD: { value: new THREE.Vector4() },
					uRevealQE: { value: new THREE.Vector4() },
					uRevealShape: { value: new THREE.Vector4() },
					uRevealFocus: { value: new THREE.Vector4() },
					uRevealGlow: { value: new THREE.Vector4() },
					uRevealF: { value: new THREE.Vector3() },
					uRevealR: { value: new THREE.Vector3() },
					uRevealU: { value: new THREE.Vector3() },
					tWarp: { value: blankTexture() },
					uWarpScale: { value: 0 },
					uWarpOn: { value: 0 },
					tOccl: { value: blankTexture() },
					uOcclOn: { value: 0 },
					...makeCompositeStyleUniforms(),
					// the look composite (read only under its LOOK_* defines)
					...COMP_BLOCK.threeUniforms(),
					...HARM_BLOCK.threeUniforms(),
					tCompMask: { value: blankTexture() },
					tCompNormal: { value: blankTexture() },
				},
			}),
		);
		this.compScene.add(this.composite);
		this.shared.uPhotoFg.value = this.fgTex;
		this.scene.background = null;
		// Step Inside splats live on their own layer: only the world / step camera draws them
		this.worldCam.layers.enable(NEARFIELD_LAYER);
		// Step Inside 3D Tiles (?tiles3d=, off by default): their own layer too, shown only while stepping;
		// the drape's photo projection decides where they fill (tiles3d/material.ts)
		this.tiles3d = ThreeTiles3D.create(
			this.scene,
			{
				uPhotoViewProj: this.shared.uPhotoViewProj,
				uPhotoPos: this.shared.uPhotoPos,
				uPhotoRange: this.shared.uPhotoRange as { value: THREE.Texture | null },
				uPhotoFg: this.shared.uPhotoFg as { value: THREE.Texture | null },
				uPhotoFgOn: this.shared.uPhotoFgOn,
			},
			() => this.requestRender(),
		);
		if (this.tiles3d) this.worldCam.layers.enable(TILES3D_LAYER);
	}

	/** concord display warp (src/lib/concord/field WarpState); null = off. */
	private warp: WarpState | null = null;

	/**
	 * Display-only residual warp (?concord=warp): render-space composite reads and peak labels move by
	 * W; nothing else (pose, pins, exports of measurements) sees it. null = off: the composite is
	 * bit-identical to no warp. Callers get the field from concord/field displayField (null at LOW).
	 */
	setWarp(field: ResidualField | null) {
		const u = this.composite.material.uniforms;
		if (!field && !this.warp) return;
		const old = u.tWarp.value as THREE.Texture;
		if (!field) {
			this.warp = null;
			u.tWarp.value = blankTexture();
			u.uWarpScale.value = 0;
			u.uWarpOn.value = 0;
		} else {
			this.warp = new WarpState(field);
			const t = this.warp.texture;
			const tex = new THREE.DataTexture(t.data, t.width, t.height);
			tex.flipY = false; // row 0 = top; warpUV samples at (x, 1 − y)
			tex.minFilter = tex.magFilter = THREE.NearestFilter;
			tex.generateMipmaps = false;
			tex.needsUpdate = true;
			u.tWarp.value = tex;
			u.uWarpScale.value = t.scale;
			u.uWarpOn.value = 1;
		}
		old.dispose();
		this.requestRender();
	}

	/** Photo uv (as shown) → the render uv whose terrain is drawn there (hover / geo readback). */
	renderUVOf(u: number, v: number): [number, number] {
		return this.warp ? this.warp.renderOf(u, v) : [u, v];
	}

	/**
	 * concord DSM occluder (?concord=occl, src/lib/concord/occl): photo-space dim mask (row 0 = top,
	 * 255 = a surface-model object stands in front of the terrain there); null = off (bit-identical).
	 * Display-only, like setWarp.
	 */
	setOccluder(m: { width: number; height: number; data: Uint8Array } | null) {
		const u = this.composite.material.uniforms;
		if (!m && u.uOcclOn.value === 0) return;
		(u.tOccl.value as THREE.Texture).dispose();
		if (!m) {
			u.tOccl.value = blankTexture();
			u.uOcclOn.value = 0;
		} else {
			const rgba = new Uint8Array(m.width * m.height * 4);
			for (let i = 0; i < m.data.length; i++) rgba[i * 4] = m.data[i];
			const tex = new THREE.DataTexture(rgba, m.width, m.height);
			tex.flipY = true; // like fgTex: sampled at vUv
			tex.minFilter = tex.magFilter = THREE.LinearFilter;
			tex.needsUpdate = true;
			u.tOccl.value = tex;
			u.uOcclOn.value = 1;
		}
		this.requestRender();
	}

	/** One frame of the overlay reveal (src/lib/reveal); null = off. */
	setReveal(r: RevealUniforms | null) {
		const u = this.composite.material.uniforms;
		if (!r) {
			if (u.uReveal.value.w === 0) return;
			u.uReveal.value.set(0, 0, 0, 0);
		} else {
			u.uReveal.value.fromArray(r.a);
			u.uRevealWin.value.fromArray(r.win);
			u.uRevealQD.value.fromArray(r.qD);
			u.uRevealQE.value.fromArray(r.qE);
			u.uRevealShape.value.fromArray(r.shape);
			u.uRevealFocus.value.fromArray(r.focus);
			u.uRevealGlow.value.fromArray(r.glow);
			u.uRevealF.value.fromArray(r.F);
			u.uRevealR.value.fromArray(r.R);
			u.uRevealU.value.fromArray(r.U);
		}
		this.requestRender();
	}

	onRender(cb: () => void) {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	async init(
		/** May be a promise: the region JSON (≈2 MB) loads in parallel with the photo and the tiles. */
		region: RegionData | null | Promise<RegionData | null>,
		onProgress?: (msg: string, frac: number) => void,
		segment?: (
			img: HTMLImageElement,
		) => Promise<{ width: number; height: number; data: Uint8Array } | null>,
	) {
		onProgress?.("Loading photo", 0);
		// ?geoLakeFloor (null when off): lake outlines load in parallel; eye ≥ lake level, fail-open
		const lakeFloor = startLakeFloor(this.photo, region, this.loadAbort.signal);
		// CPU skyline (horizon-fast in a worker): its tiles stream in with the photo decode and the terrain
		if (!this.fastHorizon) {
			const fast = this.startFastHorizon();
			this.fastHorizon = fast;
			// the camera's z14 tile is the terrain's first (dedupe'd through the tile cache): the exact eye
			// height is known long before Terrain.load resolves, so the worker can march in the meantime
			if (fast)
				heightFromTile(
					this.photo.lat,
					this.photo.lon,
					14,
					this.loadAbort.signal,
				)
					.then(
						(dem) =>
							dem != null && fast.setEye(eyeAltitude(this.photo.alt, dem)),
					)
					.catch(() => {});
		}
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.src = this.photo.src;
		await img.decode();
		this.photoImg = img;
		const tex = new THREE.Texture(img);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.generateMipmaps = true;
		tex.minFilter = THREE.LinearMipmapLinearFilter;
		tex.anisotropy = 8;
		tex.needsUpdate = true;
		this.photoTex = tex;
		this.composite.material.uniforms.tPhoto.value = tex;
		// people segmentation runs while terrain streams in; alignment needs the mask
		const fgPromise = segment
			? segment(img).catch(() => null)
			: Promise.resolve(null);

		// only the viewing wedge (+ the yaw search range) up front; the rest loads for the 3D view.
		// Without a trustworthy prior (no compass / gravity / focal) the view can face anywhere: load 360°.
		const hfov =
			(2 *
				Math.atan(Math.tan((this.prior.vfov * Math.PI) / 360) * this.aspect) *
				180) /
			Math.PI;
		const terrain = await Terrain.load(
			this.frame,
			this.shared,
			(u) => makeTerrainMaterial(u, this.terrainDefines),
			{
				onProgress: (d, t) => onProgress?.(`Loading terrain ${d}/${t}`, d / t),
				wedge: this.unknowns.any
					? undefined
					: { center: this.prior.yaw, halfWidth: hfov / 2 + 32 },
				signal: this.loadAbort.signal,
			},
		);
		if (this.disposed) {
			terrain.dispose();
			return;
		}
		this.terrain = terrain;
		this.scene.add(terrain.group);
		const dem =
			terrain.heightAt(this.photo.lat, this.photo.lon) ?? this.photo.alt ?? 0;
		this.demAtCamera = dem;
		const alt = this.photo.alt;
		this.eyeAlt = eyeAltitude(alt, dem);
		this.eye.set(0, 0, this.eyeAlt);
		this.fastHorizon?.setEye(this.eyeAlt);
		// elevation range for colour ramps: local relief within ~25 km
		let lo = Number.POSITIVE_INFINITY;
		let hi = Number.NEGATIVE_INFINITY;
		for (const t of terrain.tiles) {
			if (t.distance > 25000) continue;
			for (let i = 0; i < t.heights.length; i += 7) {
				lo = Math.min(lo, t.heights[i]);
				hi = Math.max(hi, t.heights[i]);
			}
		}
		this.localElevRange = [lo, Math.max(hi, lo + 500)];
		this.applyTerrainStyle();
		this.updateRelief();

		// usually resolved long ago: its latency overlapped the photo decode and the tile phase
		let regionData = await region;
		if (this.disposed) return;
		if (regionData && this.pendingTrails)
			regionData = { ...regionData, trails: this.pendingTrails };
		this.pendingTrails = undefined;
		this.region = regionData;
		if (regionData) {
			onProgress?.("Placing peaks and trails", 1);
			this.buildPeaks(regionData);
			this.buildTrails(regionData);
		}
		if (lakeFloor) {
			const floor = await lakeFloor(dem, (la, lo) => terrain.heightAt(la, lo));
			if (this.disposed) return;
			if (floor != null && floor > this.eyeAlt) {
				this.eyeAlt = floor;
				this.eye.set(0, 0, floor);
				this.fastHorizon?.setEye(floor);
			}
		}
		const fg = await fgPromise;
		if (this.disposed) return;
		if (fg) this.setForegroundMask(fg);
		this.edge = buildEdgeMap(img, 512, fg);
		void warmAlignGpu(); // W2: compute device + pose-grid kernel ready before autoAlign
		onProgress?.("Tracing horizon", 1);
		// usually already marched in the worker (no await, so no yield to queued frames before [data-ready])
		const horizonDirs = this.takeFastHorizon() ?? (await this.traceHorizon());
		if (this.disposed) return;
		this.horizonDirs = horizonDirs;
		this.requestRender();
	}

	private buildPeaks(region: RegionData) {
		const t = this.terrain as Terrain;
		const out: PeakPoint[] = [];
		for (const p of region.peaks) {
			const dist = distanceM(this.photo, p);
			if (dist > 110000 || dist < 150) continue;
			const snap = t.localMax(p.lat, p.lon, Math.min(250, 60 + dist * 0.004));
			if (!Number.isFinite(snap.h)) continue;
			const w = this.frame.fromGeo(snap.lat, snap.lon, snap.h);
			out.push({
				name: p.name,
				ele: p.ele,
				prominence: p.prominence,
				world: new THREE.Vector3(w[0], w[1], w[2]),
				dist,
			});
		}
		this.peaks = out;
		this.peakVis.clear();
	}

	private buildTrails(region: RegionData) {
		const t = this.terrain as Terrain;
		const pos: number[] = [];
		const col: number[] = [];
		// colours per SAC difficulty from style.trails (classic: engine.ts:423–439 before chunk 3)
		const sacs: string[] = [];
		const palette = new Map<string, [number, number, number]>();
		const tmp = [0, 0, 0];
		const place = (lon: number, lat: number) => {
			const h = t.heightAt(lat, lon);
			if (h == null) return null;
			const d = distanceM(this.photo, { lat, lon });
			return this.frame.fromGeo(lat, lon, h + 2 + d * 0.0006, tmp).slice();
		};
		for (const tr of region.trails) {
			const sac = tr.sac ?? "";
			let c = palette.get(sac);
			if (!c) {
				c = trailColor(this.style, sac);
				palette.set(sac, c);
			}
			let prev: number[] | null = null;
			for (let i = 0; i < tr.coords.length; i++) {
				const [lon, lat] = tr.coords[i];
				if (i > 0) {
					// densify so the ribbon follows the DEM
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
							pos.push(...prev, ...q);
							col.push(...c, ...c);
							sacs.push(sac);
						}
						prev = q;
					}
				} else prev = place(lon, lat);
			}
		}
		const geo = new LineSegmentsGeometry();
		geo.setPositions(pos);
		geo.setColors(col);
		this.trailSac = sacs;
		const ts = this.style.trails;
		this.trailMat = new LineMaterial({
			linewidth: ts.width,
			vertexColors: true,
			worldUnits: false,
			transparent: true,
			opacity: ts.opacity,
		});
		this.trails = new LineSegments2(geo, this.trailMat);
		this.trails.frustumCulled = false;
		this.scene.add(this.trails);
	}

	private pendingTrails?: RegionTrail[];

	setTrails(trails: RegionTrail[]) {
		if (!this.region || !this.terrain) {
			this.pendingTrails = trails; // init() applies them once the region arrives
			return;
		}
		this.region = { ...this.region, trails };
		if (this.trails) {
			this.scene.remove(this.trails);
			this.trails.geometry.dispose();
			this.trailMat?.dispose();
		}
		this.buildTrails(this.region);
		this.trailMat?.resolution.set(
			this.renderer.domElement.width,
			this.renderer.domElement.height,
		);
		if (this.trails) this.trails.visible = this.settings.trails;
		this.requestRender();
	}

	/** Re-colour the trail segments from style.trails.colors (no re-sampling of heights). */
	private recolorTrails() {
		const geo = this.trails?.geometry;
		const sacs = this.trailSac;
		if (!geo || !sacs) return;
		const cache = new Map<string, [number, number, number]>();
		const col = new Float32Array(sacs.length * 6);
		for (let i = 0; i < sacs.length; i++) {
			let c = cache.get(sacs[i]);
			if (!c) {
				c = trailColor(this.style, sacs[i]);
				cache.set(sacs[i], c);
			}
			col.set(c, i * 6);
			col.set(c, i * 6 + 3);
		}
		geo.setColors(col);
	}

	private fastHorizon?: FastHorizon;

	/**
	 * Skyline sector for horizon-fast: the terrain wedge (yaw search ±25° + half the frame, with margin),
	 * or the full circle when the prior can't be trusted (uploads without compass / gravity / focal).
	 */
	private startFastHorizon(): FastHorizon | undefined {
		if (typeof Worker === "undefined") return undefined;
		try {
			const hfov =
				(2 *
					Math.atan(Math.tan((this.prior.vfov * Math.PI) / 360) * this.aspect) *
					180) /
				Math.PI;
			const half = hfov / 2 + 34;
			const full = this.unknowns.any || half >= 180;
			return startFastHorizon({
				lat: this.photo.lat,
				lon: this.photo.lon,
				az0: full ? 0 : this.prior.yaw - half,
				az1: full ? 360 : this.prior.yaw + half,
				signal: this.loadAbort.signal,
			});
		} catch (e) {
			console.warn(
				"[horizon] horizon-fast unavailable, using the GPU horizon",
				e,
			);
			return undefined;
		}
	}

	/** The horizon-fast skyline if the worker has already delivered it for this eye height (no await). */
	private takeFastHorizon() {
		const r = this.fastHorizon?.take(this.eyeAlt);
		if (!r || r.dirs.length < 300) return null;
		this.fastHorizon = undefined;
		return r.dirs;
	}

	/** Skyline directions: horizon-fast (worker) first; the GPU renders if it fails, is too sparse or takes > 10 s. */
	private async traceHorizon(): Promise<Float32Array> {
		const fast = this.fastHorizon;
		this.fastHorizon = undefined;
		if (fast) {
			let timer = 0;
			try {
				const timeout = new Promise<never>((_, reject) => {
					timer = window.setTimeout(
						() => reject(new Error("timed out")),
						10_000,
					);
				});
				const r = await Promise.race([fast.dirs(this.eyeAlt), timeout]);
				if (r.dirs.length >= 300) return r.dirs;
				console.warn(
					`[horizon] horizon-fast returned ${r.dirs.length / 3} directions, using the GPU horizon`,
				);
			} catch (e) {
				if (this.disposed) return new Float32Array(0);
				console.warn("[horizon] horizon-fast failed, using the GPU horizon", e);
			} finally {
				clearTimeout(timer);
				fast.dispose();
			}
		}
		return this.computeHorizon();
	}

	/** 360° DEM skyline from the camera position as ENU unit directions (rotation-independent). Fallback path. */
	private computeHorizon() {
		const W = 1024;
		const H = 1536;
		const rt = new THREE.WebGLRenderTarget(W, H, {
			type: THREE.FloatType,
			minFilter: THREE.NearestFilter,
			magFilter: THREE.NearestFilter,
		});
		const buf = new Float32Array(W * H * 4);
		const cam = new THREE.PerspectiveCamera(1, W / H, 1, 400000);
		const hfov = 50;
		const vfov =
			(2 * Math.atan(Math.tan((hfov * Math.PI) / 360) / (W / H)) * 180) /
			Math.PI;
		const dirs: number[] = [];
		this.shared.uStyle.value = STYLE.geometry;
		if (this.trails) this.trails.visible = false;
		const prevTarget = this.renderer.getRenderTarget();
		for (let k = 0; k < 8; k++) {
			applyPose(cam, { yaw: k * 45, pitch: 0, roll: 0, vfov }, W / H, this.eye);
			this.renderer.setRenderTarget(rt);
			this.renderer.setClearColor(0x000000, 0);
			this.renderer.clear();
			this.renderer.render(this.scene, cam);
			this.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
			for (let x = 0; x < W; x++) {
				// readback row 0 is the bottom — scan from the top row down
				for (let y = H - 1; y >= 0; y--) {
					const i = (y * W + x) * 4;
					if (buf[i + 3] > 0) {
						const dx = buf[i] - this.eye.x;
						const dy = buf[i + 1] - this.eye.y;
						const dz = buf[i + 2] - this.eye.z;
						const l = Math.hypot(dx, dy, dz);
						if (y < H - 1) dirs.push(dx / l, dy / l, dz / l);
						break;
					}
				}
			}
		}
		this.renderer.setRenderTarget(prevTarget);
		if (this.trails) this.trails.visible = true;
		rt.dispose();
		return new Float32Array(dirs);
	}

	resize(w: number, h: number) {
		this.cssSize = { w, h };
		this.renderer.setSize(w, h, false);
		const pr = this.renderer.getPixelRatio();
		this.layerRT.setSize(Math.round(w * pr), Math.round(h * pr));
		this.trailMat?.resolution.set(Math.round(w * pr), Math.round(h * pr));
		this.worldCam.aspect = w / h;
		this.worldCam.updateProjectionMatrix();
		this.requestRender();
	}

	setPose(p: Pose) {
		this.pose = { ...p };
		this.invalidateGeometry();
		this.requestRender();
	}

	/** The geometry pass no longer matches geoRT / geoBuf (pose or terrain changed). */
	private invalidateGeometry() {
		this.geoGen++;
		this.geoDirty = true;
	}

	/** True when the CPU geometry buffer (sampleAt, peak occlusion, hover) describes the current pose. */
	geometryReady() {
		return !this.disposed && !this.geoDirty && this.geoBufGen === this.geoGen;
	}

	/** Generation counter of the geometry pass (bumps on every pose / terrain change). */
	get geometryGeneration() {
		return this.geoGen;
	}

	/**
	 * Resolves once the CPU geometry buffer describes the current pose (true), or false if the engine
	 * is disposed first. With terrain loaded it renders + reads back synchronously instead of waiting
	 * for the debounced readback, so `setPose(p); await engine.readback()` always gives a fresh buffer.
	 */
	readback(): Promise<boolean> {
		if (this.geometryReady()) return Promise.resolve(true);
		if (this.disposed) return Promise.resolve(false);
		if (this.terrain) {
			if (this.geoDirty) this.renderGeometry();
			this.readGeometryNow();
			return Promise.resolve(this.geometryReady());
		}
		// before init() has the terrain: resolved by the first readback
		return new Promise((res) => this.readbackWaiters.push(res));
	}

	private readGeometryNow() {
		clearTimeout(this.readbackTimer);
		this.readbackTimer = 0;
		if (this.disposed) return;
		this.renderer.readRenderTargetPixels(
			this.geoRT,
			0,
			0,
			this.geoRT.width,
			this.geoRT.height,
			this.geoBuf,
		);
		this.geoBufGen = this.geoRTGen;
		if (this.geoBufGen === this.geoGen) {
			this.fitHaze();
			this.updateRelief();
			this.updateLook();
			const w = this.readbackWaiters;
			this.readbackWaiters = [];
			for (const r of w) r(true);
		}
		for (const cb of this.listeners) cb();
	}

	setSettings(s: Partial<Settings>) {
		const prev = this.settings;
		this.settings = { ...prev, ...s };
		const cur = this.settings;
		this.syncDefines();
		this.scheduleLook();
		if (this.step && cur.mode !== prev.mode) this.exitStepInside();
		if (cur.mode === "world" && prev.mode !== "world") this.enterWorld();
		if (cur.mode !== "world" && prev.mode === "world") this.exitWorld();
		const wantImagery: ImagerySource =
			cur.mode === "replace" &&
			(cur.mapStyle === "satellite" || cur.mapStyle === "topo")
				? cur.mapStyle
				: cur.mode === "world" && cur.worldStyle !== "hillshade"
					? cur.worldStyle
					: (this.terrain?.imagery ?? "none");
		if (this.terrain && wantImagery !== this.terrain.imagery) {
			this.terrain.loadImagery(
				wantImagery,
				(done) => {
					this.imageryDone = done;
					this.requestRender();
				},
				this.renderer.capabilities.getMaxAnisotropy(),
			);
		}
		this.requestRender();
	}

	/**
	 * Apply a view style (src/lib/style). Uniform / material writes and a trail recolour; the terrain
	 * program recompiles only when the look's LOOK_* set changes (a preset, never a slider). No geometry
	 * rebuild. The geometry pass reads none of it (align.ts is unaffected).
	 */
	setStyle(style: ViewStyle) {
		if (style === this.style) return;
		const prev = this.style;
		this.style = style;
		this.syncDefines();
		this.fitHaze();
		this.applyTerrainStyle();
		this.updateRelief();
		applyCompositeStyle(this.composite.material.uniforms, style);
		this.lookVersion = -1;
		this.layerGen++;
		this.updateLook();
		if (this.trailMat) {
			this.trailMat.linewidth = style.trails.width;
			this.trailMat.opacity = style.trails.opacity;
		}
		if (prev.trails.colors !== style.trails.colors) this.recolorTrails();
		this.styleFrustum();
		this.requestRender();
	}

	/** The LOOK_* defines of the style and the slope layer; a change recompiles the terrain program (never a slider drag). */
	private syncDefines() {
		const slope = this.settings.overlayStyle === "slope";
		const set = (d: string[]) => Object.fromEntries(d.map((k) => [k, ""]));
		const defines = set(withSlopeLayer(lookKey(this.style), slope));
		const terrain = set(withSlopeLayer(terrainDefines(this.style), slope));
		const key = (d: Record<string, string>) => Object.keys(d).join();
		if (
			key(defines) === key(this.lookDefines) &&
			key(terrain) === key(this.terrainDefines)
		)
			return;
		this.lookDefines = defines;
		if (key(terrain) !== key(this.terrainDefines)) {
			this.terrainDefines = terrain;
			for (const t of this.terrain?.tiles ?? []) {
				t.mesh.material.defines = terrain;
				t.mesh.material.needsUpdate = true;
			}
		}
		const m = this.composite.material;
		m.defines = Object.fromEntries(
			COMPOSITE_DEFINES.filter((d) => d in defines).map((d) => [d, ""]),
		);
		m.needsUpdate = true;
	}

	/** Whether the look composite (look/glsl/composite.ts) is compiled in. */
	private get compositeLook() {
		return COMPOSITE_DEFINES.some((d) => d in this.lookDefines);
	}

	/** The geometry buffer as a range grid (row 0 = top). */
	private rangeGrid(): RangeGrid {
		const { width: w, height: h } = this.geoRT;
		return { w, h, at: (x, y) => this.geoBuf[((h - 1 - y) * w + x) * 4 + 3] };
	}

	/** The look composite's CPU side after a fresh geometry buffer: refined masks, the photo's noise. */
	private updateLook() {
		if (!this.compositeLook || !this.geometryReady()) return;
		const geo = () => this.rangeGrid();
		const cut =
			this.settings.mode === "replace"
				? blendCut(this.settings, this.brushCanvas, this.brushVersion)
				: null;
		this.look.updateMasks({
			style: this.style,
			gen: this.geoBufGen,
			img: this.photoImg,
			fg: this.fgMask,
			cut,
			geo,
		});
		this.look.updateNoise(this.style, this.photoImg, geo);
		// the creases' normal pass, once per settled pose (not per drag frame)
		if (
			"LOOK_INK" in this.lookDefines &&
			this.style.composite.ink.crease > 0 &&
			this.normalGen !== this.geoGen
		)
			this.renderNormals();
		// the settle frame: refined masks switch on, band stats are due
		this.requestRender();
	}

	/** updateLook once a blend edit (range, feather, brush) settles: the refined cut follows it. */
	private scheduleLook() {
		if (!this.style.composite.refine || !this.compositeLook) return;
		clearTimeout(this.lookTimer);
		this.lookTimer = window.setTimeout(() => this.updateLook(), 150);
	}

	/** Look composite uniforms for this frame; new masks / stats are uploaded when they change. */
	private applyCompositeLook(cu: Record<string, THREE.IUniform>) {
		const L = this.look;
		if (L.version !== this.lookVersion) {
			this.lookVersion = L.version;
			const m = L.masks;
			if (m && this.maskTex?.image.data !== m.data) {
				this.maskTex?.dispose();
				const t = new THREE.DataTexture(m.data, m.w, m.h);
				t.flipY = true;
				t.minFilter = t.magFilter = THREE.LinearFilter;
				t.needsUpdate = true;
				this.maskTex = t;
				cu.tCompMask.value = t;
			}
			HARM_BLOCK.write(
				cu,
				harmonizeValues(L.stats, this.style.composite.harmonize),
			);
			HARM_BLOCK.write(
				this.shared,
				harmonizeValues(L.stats, this.style.world.drapeHarmonize),
			);
		}
		const s = this.settings;
		const c = this.renderer.domElement;
		COMP_BLOCK.write(
			cu,
			compositeValues(this.style, {
				outW: c.width,
				outH: c.height,
				refine: L.masks?.gen === this.geoGen,
				crease: this.normalGen === this.geoGen,
				cut:
					!!L.masks?.cut && L.masks.cut === blendCutKey(s, this.brushVersion),
				premul: s.mode === "replace" && s.mapStyle !== "bands",
				noise: L.noise,
				photoW: this.photo.width,
				visibility: this.haze.fit?.visibility,
			}),
		);
		if (this.normalRT) cu.tCompNormal.value = this.normalRT.texture;
	}

	/** The normal pass (style 7) for the ink creases, at the geometry pass's size and pose. */
	private renderNormals() {
		const { width, height } = this.geoRT;
		this.normalRT ??= new THREE.WebGLRenderTarget(width, height, {
			type: THREE.HalfFloatType,
			minFilter: THREE.NearestFilter,
			magFilter: THREE.NearestFilter,
		});
		applyPose(this.cam, this.pose, this.aspect, this.eye);
		this.shared.uStyle.value = STYLE.normal;
		const tv = this.trails?.visible;
		if (this.trails) this.trails.visible = false;
		this.renderer.setRenderTarget(this.normalRT);
		this.renderer.setClearColor(0x000000, 0);
		this.renderer.clear();
		this.renderer.render(this.scene, this.cam);
		this.renderer.setRenderTarget(null);
		if (this.trails) this.trails.visible = !!tv;
		this.normalGen = this.geoGen;
	}

	/**
	 * Band stats (LOOK_HARMONIZE) of the layer as the uniforms stand, rendered at ≤ 256 px from the
	 * photo camera once the pose settles (and again as imagery streams in).
	 */
	private layerStats(amount: number) {
		const s = this.settings;
		const key = `${this.geoBufGen}|${this.layerGen}|${s.mode}|${s.mapStyle}|${s.worldStyle}|${this.imageryDone}`;
		if (
			!this.photoImg ||
			!this.geometryReady() ||
			!this.look.wantsStats(amount, key)
		)
			return;
		const [w, h] = gridSize(this.aspect, STATS_LONG_SIDE);
		this.statsRT ??= new THREE.WebGLRenderTarget(w, h, {
			type: THREE.FloatType,
		});
		const buf = new Float32Array(w * h * 4);
		const tv = this.trails?.visible;
		const fv = this.frustum?.visible;
		if (this.trails) this.trails.visible = false;
		if (this.frustum) this.frustum.visible = false;
		this.renderer.setRenderTarget(this.statsRT);
		this.renderer.setClearColor(0x000000, 0);
		this.renderer.clear();
		this.renderer.render(this.scene, this.cam);
		this.renderer.readRenderTargetPixels(this.statsRT, 0, 0, w, h, buf);
		this.renderer.setRenderTarget(null);
		if (this.trails) this.trails.visible = !!tv;
		if (this.frustum) this.frustum.visible = !!fv;
		this.look.setStats({
			key,
			img: this.photoImg,
			layer: buf,
			w,
			h,
			geo: this.rangeGrid(),
			fg: this.fgMask,
			minRange: trustedRange(this.photo.hAccuracy),
		});
	}

	private applyTerrainStyle() {
		applyTerrainLook(this.shared, this.style.terrain, {
			...this.sunCtx,
			localRange: this.localElevRange,
		});
	}

	private get sunCtx() {
		return {
			takenAt: this.photo.takenAt,
			lat: this.photo.lat,
			lon: this.photo.lon,
		};
	}

	/** The physical atmosphere's uniforms for a view seen from `eye` (no-op for the classic haze). */
	private applyAtmosphere(mode: StyleMode, eye: THREE.Vector3) {
		if (
			"LOOK_ATMOSPHERE" in this.lookDefines ||
			(mode === "world" && this.style.world.sky.mode === "atmosphere")
		)
			applyAtmosphereLook(
				this.shared,
				this.style,
				mode,
				[eye.x, eye.y, eye.z],
				this.sunCtx,
				this.haze.fit,
			);
	}

	/** The Swiss relief's block values for a view (no-op without LOOK_RELIEF). */
	private applyRelief(mode: StyleMode) {
		if ("LOOK_RELIEF" in this.lookDefines)
			applyReliefLook(this.shared, this.style, mode, this.relief.field);
	}

	private updateRelief() {
		if (!("LOOK_RELIEF" in this.lookDefines) || !this.terrain) return;
		if (
			this.relief.update({
				tiles: this.terrain.tiles,
				frame: this.frame,
				sunDir: this.shared.uSunDir.value.toArray(),
				yawDeg: this.pose.yaw,
			})
		) {
			this.layerGen++;
			this.requestRender();
		}
	}

	/** P(sky) of the photo (#/lib/sky segmentSky, row 0 = top): the haze fit's sky. */
	setSkyMask(mask: SkyMask | null) {
		this.skyMaskStore = mask;
		this.haze.setSky(mask);
		this.look.setSky(mask);
		this.fitHaze();
		this.updateLook();
	}

	/** The haze fit (look/haze-controller), for the atmosphere and dev tools. */
	get hazeFit() {
		return this.haze.fit;
	}

	private fitHaze() {
		if (!this.geometryReady()) return;
		const fitted = this.haze.update({
			style: this.style,
			pose: this.pose,
			img: this.photoImg,
			eyeAlt: this.eyeAlt,
			sunDir: this.shared.uSunDir.value.toArray(),
			fg: this.fgMask,
			geo: () => ({
				geo: { kind: "xyzr", data: this.geoBuf },
				w: this.geoRT.width,
				h: this.geoRT.height,
			}),
		});
		if (fitted) {
			this.layerGen++;
			this.requestRender();
		}
	}

	// ---------------- rendering ----------------

	requestRender() {
		if (this.raf || this.disposed) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			this.renderNow();
		});
	}

	private renderGeometry() {
		applyPose(this.cam, this.pose, this.aspect, this.eye);
		this.shared.uStyle.value = STYLE.geometry;
		// the world drape samples geoRT: left bound, this pass is a feedback loop WebGL refuses to draw
		this.shared.uPhotoRange.value = null;
		const trailsVisible = this.trails?.visible;
		if (this.trails) this.trails.visible = false;
		// the world view's photo-plane / frustum gizmo sits in front of this camera: it would occlude
		// every terrain pixel in the range buffer and wipe the drape
		const frustumVisible = this.frustum?.visible;
		if (this.frustum) this.frustum.visible = false;
		this.renderer.setRenderTarget(this.geoRT);
		this.renderer.setClearColor(0x000000, 0);
		this.renderer.clear();
		this.renderer.render(this.scene, this.cam);
		this.renderer.setRenderTarget(null);
		if (this.trails) this.trails.visible = !!trailsVisible;
		if (this.frustum) this.frustum.visible = !!frustumVisible;
		this.geoDirty = false;
		this.geoRTGen = this.geoGen;
		// the 12 MB CPU readback (labels, hover) waits until the pose stops changing; readback() forces it
		clearTimeout(this.readbackTimer);
		this.readbackTimer = window.setTimeout(() => this.readGeometryNow(), 90);
	}

	renderNow() {
		if (!this.terrain || this.disposed) return;
		const s = this.settings;
		const u = this.shared;
		if (this.geoDirty) this.renderGeometry();
		const L = this.style.composite;

		if (s.mode === "world" || this.step) {
			this.renderWorld();
		} else {
			applyPose(this.cam, this.pose, this.aspect, this.eye);
			// layer pass
			let style: number = STYLE.contours;
			let showLayer = true;
			if (s.mode === "overlay") {
				if (s.overlayStyle === "none") showLayer = false;
				style =
					s.overlayStyle === "bands"
						? STYLE.elevation
						: s.overlayStyle === "slope"
							? STYLE.slopeClass
							: STYLE.contours;
			} else {
				style =
					s.mapStyle === "satellite" || s.mapStyle === "topo"
						? STYLE.imagery
						: s.mapStyle === "bands"
							? STYLE.elevation
							: STYLE.hillshade;
			}
			u.uStyle.value = style;
			u.uContourInterval.value = s.contourInterval;
			u.uProjectPhoto.value = 0;
			applyLayerStyle(
				u,
				this.style,
				s.mode === "replace" ? "replace" : "overlay",
				style === STYLE.elevation,
			);
			if (s.mode === "replace") this.applyAtmosphere("replace", this.eye);
			this.applyRelief(s.mode === "replace" ? "replace" : "overlay");
			if ("LOOK_SLOPE" in this.lookDefines) applySlopeLook(u, this.style);
			// a hidden layer still renders (alpha 0) so trails keep terrain occlusion
			u.uContourOpacity.value = showLayer ? 1 : 0;
			if (this.trails) this.trails.visible = s.trails;
			this.renderer.setRenderTarget(this.layerRT);
			this.renderer.setClearColor(0x000000, 0);
			this.renderer.clear();
			this.renderer.render(this.scene, this.cam);
			this.renderer.setRenderTarget(null);
			if (s.mode === "replace" && "LOOK_HARMONIZE" in this.lookDefines)
				this.layerStats(L.harmonize);
			const cu = this.composite.material.uniforms;
			cu.uMode.value = s.mode === "overlay" ? 0 : 1;
			cu.uLayerOpacity.value = s.layerOpacity;
			cu.uRidges.value = s.ridges;
			cu.uDepthTint.value = s.depthTint;
			cu.uMethod.value = { swipe: 0, lens: 1, range: 2, brush: 3 }[s.method];
			cu.uSwipe.value = s.swipe;
			cu.uLens.value.set(s.lens[0], 1 - s.lens[1]);
			cu.uLensR.value = s.lensR;
			cu.uRange.value = s.rangeKm * 1000;
			cu.uKeepSky.value = s.keepSky ? 1 : 0;
			cu.uFeather.value = s.feather;
			cu.uNearFade.value = s.nearFade;
			u.uNearFade.value = s.mode === "overlay" ? s.nearFade : 0;
			cu.uFgOn.value = s.protectPeople ? 1 : 0;
			this.brushTex.needsUpdate = true;
			if (this.compositeLook) this.applyCompositeLook(cu);
			this.renderer.render(this.compScene, this.orthoCam);
		}
		for (const cb of this.listeners) cb();
	}

	// ---------------- world view ----------------

	private enterWorld() {
		if (this.terrain?.hasPending)
			this.terrain
				.loadPending(() => this.requestRender())
				.then(() => {
					// peaks and trails behind the camera need the newly loaded heights; so does the geometry pass
					this.invalidateGeometry();
					if (this.region) {
						this.buildPeaks(this.region);
						if (this.trails) {
							this.scene.remove(this.trails);
							this.trails.geometry.dispose();
						}
						this.buildTrails(this.region);
						this.trailMat?.resolution.set(
							this.renderer.domElement.width,
							this.renderer.domElement.height,
						);
					}
					this.requestRender();
				})
				.catch(() => {}); // aborted by dispose()
		const canvas = this.renderer.domElement;
		const { forward } = {
			forward: new THREE.Vector3(
				Math.sin((this.pose.yaw * Math.PI) / 180),
				Math.cos((this.pose.yaw * Math.PI) / 180),
				0,
			),
		};
		// start behind and above the photographer, looking along the photo direction
		this.worldCam.up.set(0, 0, 1);
		this.worldCam.position
			.copy(this.eye)
			.addScaledVector(forward, -2500)
			.add(new THREE.Vector3(0, 0, 1400));
		const target = this.eye.clone().addScaledVector(forward, 3000);
		target.z = this.eye.z - 200;
		this.controls?.dispose();
		this.controls = new OrbitControls(this.worldCam, canvas);
		this.controls.target.copy(target);
		this.controls.enableDamping = true;
		this.controls.maxPolarAngle = Math.PI * 0.495;
		this.controls.screenSpacePanning = false;
		this.controls.addEventListener("change", () => this.requestRender());
		this.controls.update();
		this.buildFrustum();
	}

	private exitWorld() {
		this.controls?.dispose();
		this.controls = undefined;
		this.flight = undefined;
		if (this.frustum) this.scene.remove(this.frustum);
		this.frustum = undefined;
	}

	private buildFrustum() {
		if (this.frustum) this.scene.remove(this.frustum);
		const g = new THREE.Group();
		applyPose(this.cam, this.pose, this.aspect, this.eye);
		const dist = 150;
		const hh = Math.tan((this.pose.vfov * Math.PI) / 360) * dist;
		const hw = hh * this.aspect;
		const plane = new THREE.Mesh(
			new THREE.PlaneGeometry(hw * 2, hh * 2),
			new THREE.MeshBasicMaterial({
				map: this.photoTex,
				transparent: true,
				opacity: this.style.world.frame.planeOpacity,
				side: THREE.DoubleSide,
				depthTest: true,
			}),
		);
		plane.position.set(0, 0, -dist);
		const corners = [
			[-hw, -hh],
			[hw, -hh],
			[hw, hh],
			[-hw, hh],
		].map(([x, y]) => new THREE.Vector3(x, y, -dist));
		const pts: THREE.Vector3[] = [];
		for (let i = 0; i < 4; i++)
			pts.push(
				new THREE.Vector3(),
				corners[i],
				corners[i],
				corners[(i + 1) % 4],
			);
		const lines = new THREE.LineSegments(
			new THREE.BufferGeometry().setFromPoints(pts),
			new THREE.LineBasicMaterial({ transparent: true }),
		);
		const holder = new THREE.Group();
		holder.add(plane, lines);
		holder.position.copy(this.cam.position);
		holder.quaternion.copy(this.cam.quaternion);
		const pin = new THREE.Mesh(
			new THREE.SphereGeometry(18, 16, 12),
			new THREE.MeshBasicMaterial(),
		);
		pin.position.copy(this.eye);
		g.add(holder, pin);
		this.photoPlane = plane;
		this.frustumLines = lines;
		this.frustumPin = pin;
		this.frustum = g;
		this.styleFrustum();
		this.scene.add(g);
	}

	/** Frame colours and pin size from style.world.frame (plane opacity is set per frame in renderWorld). */
	private styleFrustum() {
		const f = this.style.world.frame;
		if (this.frustumLines) {
			setColor(this.frustumLines.material.color, f.lineColor);
			this.frustumLines.material.opacity = f.lineOpacity;
		}
		if (this.frustumPin) {
			setColor(this.frustumPin.material.color, f.pinColor);
			// the sphere is built with r = 18 (classic): scale 1 keeps it exact
			this.frustumPin.scale.setScalar(f.pinRadiusM / 18);
		}
	}

	/** Animate the free camera into the photographer's exact viewpoint. */
	flyToPhoto(dur = 2600) {
		if (!this.controls) return;
		applyPose(this.cam, this.pose, this.aspect, this.eye);
		this.controls.enabled = false;
		this.flight = {
			t0: performance.now(),
			dur,
			fromPos: this.worldCam.position.clone(),
			fromQ: this.worldCam.quaternion.clone(),
			fromFov: this.worldCam.fov,
			toQ: this.cam.quaternion.clone(),
		};
		this.requestRender();
	}

	flyOut() {
		if (!this.controls) return;
		this.flight = undefined;
		this.enterWorld();
		this.requestRender();
	}

	private renderWorld() {
		const s = this.settings;
		const u = this.shared;
		const terrain = this.terrain as Terrain;
		const w = this.style.world;
		let photoPlaneOpacity = w.frame.planeOpacity;
		const step = this.step;
		/** Step Inside proper (not the In-map view driven by the step camera). */
		const stepView = step?.view === "step";
		if (step) {
			// Step Inside: the step camera drives worldCam; the frustum gizmo would sit on the eye (the
			// In-map view fades it in as the camera leaves the eye)
			if (step.cam.update()) this.requestRender();
			photoPlaneOpacity = stepView
				? 0
				: photoPlaneOpacity *
					Math.max(
						0,
						Math.min(
							1,
							(this.worldCam.position.distanceTo(this.eye) - 30) / 300,
						),
					);
		} else if (this.flight?.held) {
			photoPlaneOpacity = 0;
		} else if (this.flight) {
			const f = this.flight;
			const t = Math.min((performance.now() - f.t0) / f.dur, 1);
			const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
			// arc over the terrain on the way in
			const pos = f.fromPos.clone().lerp(this.eye, e);
			pos.z += Math.sin(e * Math.PI) * 600;
			this.worldCam.position.copy(pos);
			this.worldCam.quaternion.slerpQuaternions(f.fromQ, f.toQ, e);
			// viewport aspect may differ from the photo: fit the photo's frame inside it
			const fitV = this.pose.vfov;
			const vfovForWidth =
				(2 *
					Math.atan(
						Math.tan((this.pose.vfov * Math.PI) / 360) *
							(this.aspect / this.worldCam.aspect),
					) *
					180) /
				Math.PI;
			this.worldCam.fov =
				f.fromFov + (Math.max(fitV, vfovForWidth) - f.fromFov) * e;
			this.worldCam.updateProjectionMatrix();
			photoPlaneOpacity = w.frame.planeOpacity * (1 - e);
			if (t < 1) this.requestRender();
			else f.held = true;
		} else {
			this.controls?.update();
		}
		if (this.photoPlane) this.photoPlane.material.opacity = photoPlaneOpacity;
		if (this.frustum) this.frustum.visible = photoPlaneOpacity > 0.02;
		u.uStyle.value =
			s.worldStyle === "hillshade" || terrain.imagery === "none"
				? STYLE.hillshade
				: STYLE.imagery;
		applyLayerStyle(u, this.style, "world");
		this.applyAtmosphere("world", this.worldCam.position);
		this.applyRelief("world");
		// drape harmonisation (LOOK_HARMONIZE): this render seen from the photo camera vs the photo
		if (w.drapeHarmonize > 0 && "LOOK_HARMONIZE" in this.lookDefines) {
			u.uProjectPhoto.value = 0;
			applyPose(this.cam, this.pose, this.aspect, this.eye);
			this.layerStats(w.drapeHarmonize);
			if (this.look.version !== this.lookVersion)
				this.applyCompositeLook(this.composite.material.uniforms);
		}
		// Step Inside: the full photo on the drape, at every incidence (materials.ts: > 1.5)
		u.uProjectPhoto.value = stepView ? 2 : s.projectOpacity;
		u.uPhoto.value = this.photoTex;
		u.uPhotoRange.value = this.geoRT.texture;
		u.uPhotoMinRange.value = s.minProjectRange;
		u.uPhotoFgOn.value = s.protectPeople ? 1 : 0;
		const nf = this.nf;
		if (nf?.masks && nf.opts.maskDrape !== false) {
			// Object pixels (huts, people, trees) must not smear across the terrain behind them: the split's
			// Object mask OR'd into the people-mask path of the drape
			u.uPhotoFg.value = stepView
				? nf.masks.step
				: s.protectPeople
					? nf.masks.worldFg
					: nf.masks.worldObj;
			u.uPhotoFgOn.value = 1;
		}
		// Truth toggle: the terrain tinted by provenance too (materials.ts uTruth; splats: ThreeSplats.setTruth)
		u.uTruth.value = nf?.opts.truth ? PROVENANCE_TINT_MIX : 0;
		if (nf?.opts.truth) {
			const [o, d] = [PROVENANCE_COLORS.observed, PROVENANCE_COLORS.dem];
			u.uTruthObs.value.set(o[0] / 255, o[1] / 255, o[2] / 255);
			u.uTruthDem.value.set(d[0] / 255, d[1] / 255, d[2] / 255);
		}
		// splats stand metres from the eye: the world camera's 5 m near plane would cut them
		const near = step ? 0.3 : nf ? 1 : WORLD_NEAR;
		if (this.worldCam.near !== near) {
			this.worldCam.near = near;
			this.worldCam.updateProjectionMatrix();
		}
		// from the photo camera the near terrain drapes exactly: no grazing-angle cut-off
		if (stepView) u.uPhotoMinRange.value = 1;
		u.uPhotoPos.value.copy(this.eye);
		applyPose(this.cam, this.pose, this.aspect, this.eye);
		u.uPhotoViewProj.value.multiplyMatrices(
			this.cam.projectionMatrix,
			this.cam.matrixWorldInverse,
		);
		if (this.trails) this.trails.visible = s.trails;
		if (step && stepView) {
			const su = step.sky.material.uniforms;
			su.uPhoto.value = this.photoTex;
			su.uPhotoViewProj.value.copy(u.uPhotoViewProj.value);
			su.uPhotoPos.value.copy(this.eye);
			su.uSkyMask.value = nf?.masks?.sky ?? null;
			su.uSkyOn.value = nf?.masks ? 1 : 0;
			setColor(su.uBg.value, w.sky.clear);
			step.sky.position.copy(this.worldCam.position);
			this.scene.add(step.sky);
		}
		this.renderer.setRenderTarget(null);
		this.renderer.setClearColor(setColor(new THREE.Color(), w.sky.clear), 1);
		if (w.sky.mode === "atmosphere") this.skyMesh ??= makeSkyMesh(this.shared);
		const sky = w.sky.mode === "atmosphere" ? this.skyMesh : null;
		if (sky) {
			this.worldCam.updateMatrixWorld();
			sky.material.uniforms.uSkyRay.value.fromArray(
				skyRayMatrix(
					this.worldCam.projectionMatrix.elements,
					this.worldCam.matrixWorldInverse.elements,
				),
			);
			this.scene.add(sky);
		} else
			this.scene.background = setColor(new THREE.Color(), w.sky.background);
		if (stepView)
			this.tiles3d?.beforeRender(
				this.worldCam,
				this.renderer.domElement.width,
				this.renderer.domElement.height,
				{ truth: !!nf?.opts.truth },
			);
		this.renderer.render(this.scene, this.worldCam);
		this.scene.background = null;
		if (sky) this.scene.remove(sky);
		if (step && stepView) this.scene.remove(step.sky);
		if (nf) u.uPhotoFg.value = this.fgTex;
		u.uTruth.value = 0;
		u.uProjectPhoto.value = 0;
		u.uPhotoRange.value = null;
	}

	get isFlying() {
		return !!this.flight;
	}

	// ---------------- queries ----------------

	/** Terrain under a normalised photo coordinate (u right, v down). */
	sampleAt(u: number, v: number): Sample | null {
		const w = this.geoRT.width;
		const h = this.geoRT.height;
		const x = Math.floor(u * w);
		const y = Math.floor((1 - v) * h);
		if (x < 0 || y < 0 || x >= w || y >= h) return null;
		const i = (y * w + x) * 4;
		const range = this.geoBuf[i + 3];
		if (!(range > 0)) return null;
		const world: [number, number, number] = [
			this.geoBuf[i],
			this.geoBuf[i + 1],
			this.geoBuf[i + 2],
		];
		const g = this.frame.toGeo(world[0], world[1], world[2]);
		return { lat: g.lat, lon: g.lon, h: g.h, range, world };
	}

	/**
	 * Peaks projected into the photo, occlusion-tested and decluttered by rank (prominence, elevation,
	 * distance). Occlusion comes from the geometry buffer only when it matches the current pose; while
	 * it lags (drag, right after setPose, before the first readback) a peak keeps the verdict from the
	 * last fresh buffer (occlusion depends on the eye, not the rotation), and a peak never tested is
	 * unknown and gets no label. Deterministic: ties break by prominence, elevation, then name
	 * (look/labels rank.ts). `declutter: false`: every visible peak, ranked, for the panorama / inline layouts.
	 */
	peakLabels(
		max = this.style.labels.maxLabels,
		{ declutter = true } = {},
	): PeakLabel[] {
		const fresh = this.geometryReady();
		const out: PeakLabel[] = [];
		for (const p of this.peaks) {
			const pr = projectPoint(this.pose, this.aspect, this.eye, p.world);
			if (!pr || pr.u < 0 || pr.u > 1 || pr.v < 0 || pr.v > 1) continue;
			const range = p.world.distanceTo(this.eye);
			let visible: boolean | undefined;
			if (fresh) {
				// look a couple of pixels below the summit: the summit pixel itself often reads as sky
				visible = false;
				for (const dv of [0.004, 0.009]) {
					const s = this.sampleAt(pr.u, pr.v + dv);
					if (!s || s.range > range * 0.97 - 50) visible = true;
				}
				this.peakVis.set(p, visible);
			} else visible = this.peakVis.get(p);
			if (visible === undefined) continue; // unknown: no buffer for this pose has tested it yet
			// display warp: the label goes where the render point is SHOWN (visibility stays in render space)
			const [lu, lv] = this.warp ? this.warp.photoOf(pr.u, pr.v) : [pr.u, pr.v];
			if (this.settings.protectPeople && this.isForeground(lu, lv))
				visible = false;
			if (!visible) continue;
			const rank = peakRank(p.prominence, p.ele, range);
			out.push({
				name: p.name,
				ele: p.ele,
				prominence: p.prominence,
				u: lu,
				v: lv,
				distKm: range / 1000,
				rank,
				visible,
				world: [p.world.x, p.world.y, p.world.z],
			});
		}
		rankPeaks(out);
		return declutter ? declutterClassic(out, max) : out.slice(0, max);
	}

	private skyCache?: { gen: number; sky: Float32Array };

	/** Per-column skyline (fraction of the height from the top) of the fresh geometry buffer, else null. */
	skyline(): Float32Array | null {
		if (!this.geometryReady()) return null;
		if (this.skyCache?.gen !== this.geoBufGen)
			this.skyCache = {
				gen: this.geoBufGen,
				sky: skylineAt(this.geoBuf, this.geoRT.width, this.geoRT.height),
			};
		return this.skyCache.sky;
	}

	get hasPeople() {
		return !!this.fgMask?.data.some((v) => v > 128);
	}

	isForeground(u: number, v: number) {
		const m = this.fgMask;
		if (!m) return false;
		const x = Math.min(m.width - 1, Math.max(0, Math.floor(u * m.width)));
		const y = Math.min(m.height - 1, Math.max(0, Math.floor(v * m.height)));
		return m.data[y * m.width + x] > 128;
	}

	/** All candidate peaks in frame (for pinning), visible or not. */
	peaksInFrame() {
		const out: PeakLabel[] = [];
		for (const p of this.peaks) {
			const pr = projectPoint(this.pose, this.aspect, this.eye, p.world);
			if (!pr || pr.u < -0.1 || pr.u > 1.1 || pr.v < -0.1 || pr.v > 1.1)
				continue;
			out.push({
				name: p.name,
				ele: p.ele,
				u: pr.u,
				v: pr.v,
				distKm: pr.depth / 1000,
				rank: 0,
				visible: true,
				world: [p.world.x, p.world.y, p.world.z],
			});
		}
		return out;
	}

	/**
	 * Control points (x,y on a `basis`-px-wide image; either an OSM `peak` name or az/el in degrees)
	 * → pins in this engine's frame. Used for evaluation against hand-labelled ground truth.
	 */
	controlPins(cp: {
		basis: number;
		points: { x: number; y: number; peak?: string; az?: number; el?: number }[];
	}): Pin[] {
		const D = Math.PI / 180;
		const hBasis = (cp.basis * this.photo.height) / this.photo.width;
		const pins: Pin[] = [];
		for (const pt of cp.points) {
			let world: [number, number, number] | null = null;
			if (pt.peak) {
				// OSM has duplicate names: take the one whose direction is nearest the clicked ray (prior pose)
				const ray = unprojectDir(
					this.prior,
					this.aspect,
					pt.x / cp.basis,
					pt.y / hBasis,
				);
				let best: PeakPoint | null = null;
				let bestDot = -2;
				for (const pk of this.peaks) {
					if (pk.name !== pt.peak) continue;
					const d = pk.world.clone().sub(this.eye).normalize().dot(ray);
					if (d > bestDot) {
						bestDot = d;
						best = pk;
					}
				}
				if (best) world = [best.world.x, best.world.y, best.world.z];
			} else if (pt.az != null && pt.el != null) {
				const r = 50000;
				world = [
					this.eye.x + r * Math.sin(pt.az * D) * Math.cos(pt.el * D),
					this.eye.y + r * Math.cos(pt.az * D) * Math.cos(pt.el * D),
					this.eye.z + r * Math.sin(pt.el * D),
				];
			}
			if (world) pins.push({ world, u: pt.x / cp.basis, v: pt.y / hBasis });
		}
		return pins;
	}

	/** Reprojection error (px on a basis-wide image) of `pose` at the given pins. */
	pinError(pose: Pose, pins: Pin[], basis: number) {
		const errs = pins.map((p) => {
			const pr = projectPoint(pose, this.aspect, this.eye, p.world);
			if (!pr) return Number.POSITIVE_INFINITY;
			return Math.hypot(
				(pr.u - p.u) * basis,
				((pr.v - p.v) * basis) / this.aspect,
			);
		});
		return {
			mean: errs.reduce((a, b) => a + b, 0) / Math.max(errs.length, 1),
			max: Math.max(...errs),
		};
	}

	/**
	 * autoAlign with the coarse grid on the WebGPU compute device (src/lib/gpu/align; CPU when
	 * unavailable or ?gpu=off), then the same silhouette re-rank. Same result as autoAlign();
	 * PhotoWorkspace prefers it. autoAlign() itself stays synchronous for the tools that call it.
	 */
	async autoAlignAsync(fromPrior = true): Promise<AlignResult | null> {
		if (!this.horizonDirs || !this.edge) return null;
		const res = await autoAlignAsync(
			fromPrior ? this.prior : this.pose,
			this.aspect,
			this.horizonDirs,
			this.edge,
			fromPrior ? 25 : 6,
		);
		if (this.disposed) return null;
		return this.autoAlign(fromPrior, res);
	}

	/** `pre`: the skyline search's result, already computed (autoAlignAsync). */
	autoAlign(fromPrior = true, pre?: AlignResult): AlignResult | null {
		if (!this.horizonDirs || !this.edge) return null;
		const res =
			pre ??
			autoAlign(
				fromPrior ? this.prior : this.pose,
				this.aspect,
				this.horizonDirs,
				this.edge,
				fromPrior ? 25 : 6,
			);
		const alts = res.alternatives;
		if (!alts || alts.length < 2) return res;
		// Re-rank the finalists with inner silhouettes (ridges in front of ridges), which the
		// skyline-only search can't see. Needs a geometry render per hypothesis, so only here.
		const ranked = alts
			.map((a) => ({ ...a, sil: this.silhouetteScore(a.pose) }))
			.map((a) => ({ ...a, total: a.score + 0.5 * a.sil }))
			.sort((a, b) => b.total - a.total);
		const best = ranked[0];
		const second = ranked.find((r) => Math.abs(r.pose.yaw - best.pose.yaw) > 3);
		const margin = second
			? (best.total - second.total) / Math.max(Math.abs(best.total), 1e-3)
			: 1;
		const confidence =
			Math.max(0, Math.min(1, margin * 4)) *
			Math.min(1, Math.max(0, best.score * 2.5));
		return {
			pose: best.pose,
			score: best.total,
			confidence,
			alternatives: ranked,
		};
	}

	private silRT?: THREE.WebGLRenderTarget;
	private silBuf?: Float32Array;

	/** Mean photo edge strength along rendered inner silhouettes (log-range jumps) for a pose. */
	silhouetteScore(pose: Pose) {
		const edge = this.edge;
		if (!edge) return 0;
		const W = 384;
		const H = Math.round(W / this.aspect);
		if (!this.silRT) {
			this.silRT = new THREE.WebGLRenderTarget(W, H, {
				type: THREE.FloatType,
				minFilter: THREE.NearestFilter,
				magFilter: THREE.NearestFilter,
			});
			this.silBuf = new Float32Array(W * H * 4);
		}
		const buf = this.silBuf as Float32Array;
		const cam = new THREE.PerspectiveCamera(1, 1, 1, 400000);
		applyPose(cam, pose, this.aspect, this.eye);
		this.shared.uStyle.value = STYLE.geometry;
		const tv = this.trails?.visible;
		if (this.trails) this.trails.visible = false;
		this.renderer.setRenderTarget(this.silRT);
		this.renderer.setClearColor(0x000000, 0);
		this.renderer.clear();
		this.renderer.render(this.scene, cam);
		this.renderer.readRenderTargetPixels(this.silRT, 0, 0, W, H, buf);
		this.renderer.setRenderTarget(null);
		if (this.trails) this.trails.visible = !!tv;
		const lr = (x: number, y: number) => {
			const r = buf[(y * W + x) * 4 + 3];
			return r > 0 ? Math.log(r) : 13.5;
		};
		let sum = 0;
		let n = 0;
		for (let y = 1; y < H - 1; y++)
			for (let x = 1; x < W - 1; x++) {
				const r = buf[(y * W + x) * 4 + 3];
				if (!(r > 0) || r > 25000) continue;
				const c = lr(x, y);
				// inner silhouette: a nearer surface in front of a much farther one (not the sky)
				const up = lr(x, y + 1);
				const right = lr(x + 1, y);
				const left = lr(x - 1, y);
				const far = Math.max(
					up < 13 ? up : 0,
					right < 13 ? right : 0,
					left < 13 ? left : 0,
				);
				if (far - c < 0.5) continue;
				const u = x / W;
				const v = 1 - y / H;
				const ex = Math.min(edge.w - 1, Math.floor(u * edge.w));
				const ey = Math.min(edge.h - 1, Math.floor(v * edge.h));
				const i = ey * edge.w + ex;
				if (edge.fg[i] > 0.3) continue;
				sum += edge.coarse[i];
				n++;
			}
		return n > 30 ? sum / n : 0;
	}

	solvePins(pins: Pin[], from: Pose = this.pose, solveFov = true) {
		return solvePins(
			from,
			this.aspect,
			[this.eye.x, this.eye.y, this.eye.z],
			pins,
			this.photo.width,
			this.photo.height,
			solveFov,
		);
	}

	/** Foreground (people) mask, row 0 = top. Protects those pixels from overlays and blends. */
	setForegroundMask(
		mask: { width: number; height: number; data: Uint8Array } | null,
	) {
		this.fgTex.dispose();
		this.fgMask = mask;
		if (!mask) {
			this.fgTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
			this.hasForeground = false;
		} else {
			const rgba = new Uint8Array(mask.width * mask.height * 4);
			for (let i = 0; i < mask.data.length; i++) rgba[i * 4] = mask.data[i];
			this.fgTex = new THREE.DataTexture(rgba, mask.width, mask.height);
			this.fgTex.flipY = true;
			this.fgTex.minFilter = this.fgTex.magFilter = THREE.LinearFilter;
			this.hasForeground = true;
		}
		this.fgTex.needsUpdate = true;
		this.composite.material.uniforms.tFg.value = this.fgTex;
		this.shared.uPhotoFg.value = this.fgTex;
		if (this.nf) this.rebuildNearFieldMasks();
		this.updateLook();
		this.requestRender();
	}

	/** Render the current photo view at the photo's full resolution (with labels) as a PNG blob. */
	async exportImage(withLabels = true): Promise<Blob | null> {
		// labels need occlusion for THIS pose, not the debounced previous one
		if (withLabels && this.settings.mode !== "world") await this.readback();
		// GPU look passes (gpu/look) still in flight land before the export draws
		await lookIdle();
		if (this.settings.mode === "world" || this.step) {
			// display-only 3D Tiles (Google) never enter an export (tiles3d/three-tiles.ts)
			const capture = () => {
				this.renderNow();
				return new Promise<Blob | null>((res) =>
					this.renderer.domElement.toBlob(res, "image/png"),
				);
			};
			return this.tiles3d
				? this.tiles3d.withoutDisplayOnly(capture)
				: capture();
		}
		const { w, h } = this.cssSize;
		const pr = this.renderer.getPixelRatio();
		const W = this.photo.width;
		const H = this.photo.height;
		this.renderer.setPixelRatio(1);
		this.renderer.setSize(W, H, false);
		this.layerRT.setSize(W, H);
		this.trailMat?.resolution.set(W, H);
		this.renderNow();
		const out = document.createElement("canvas");
		out.width = W;
		out.height = H;
		const ctx = out.getContext("2d") as CanvasRenderingContext2D;
		ctx.drawImage(this.renderer.domElement, 0, 0);
		// restore the on-screen size
		this.renderer.setPixelRatio(pr);
		this.resize(w, h);
		// labels: the canvas drawer shared with the style (classic reproduces the old drawing exactly)
		if (withLabels) {
			const classic = this.style.labels.layout === "classic";
			drawExportLabels(
				ctx,
				this.peakLabels(classic ? undefined : 100, { declutter: classic }),
				this.style.labels,
				W,
				H,
				W / w,
				this.skyline(),
			);
		}
		return new Promise((res) => out.toBlob(res, "image/jpeg", 0.92));
	}

	/** Paint into the replace-mode brush mask (normalised coords). */
	paint(u: number, v: number, radius: number, erase: boolean) {
		const ctx = this.brushCanvas.getContext("2d") as CanvasRenderingContext2D;
		const x = u * this.brushCanvas.width;
		const y = v * this.brushCanvas.height;
		const r = radius * this.brushCanvas.width;
		const g = ctx.createRadialGradient(x, y, 0, x, y, r);
		const c = erase ? "0,0,0" : "255,255,255";
		g.addColorStop(0, `rgba(${c},0.9)`);
		g.addColorStop(0.6, `rgba(${c},0.5)`);
		g.addColorStop(1, `rgba(${c},0)`);
		ctx.fillStyle = g;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fill();
		this.brushVersion++;
		this.scheduleLook();
		this.requestRender();
	}

	clearBrush(fill = false) {
		const ctx = this.brushCanvas.getContext("2d") as CanvasRenderingContext2D;
		ctx.fillStyle = fill ? "#fff" : "#000";
		ctx.fillRect(0, 0, this.brushCanvas.width, this.brushCanvas.height);
		this.brushVersion++;
		this.scheduleLook();
		this.requestRender();
	}

	dispose() {
		this.disposed = true;
		this.loadAbort.abort();
		this.fastHorizon?.dispose();
		cancelAnimationFrame(this.raf);
		clearTimeout(this.readbackTimer);
		clearTimeout(this.lookTimer);
		for (const r of this.readbackWaiters) r(false);
		this.readbackWaiters = [];
		this.controls?.dispose();
		this.exitStepInside();
		this.setNearField(null);
		this.tiles3d?.dispose();
		this.terrain?.dispose();
		this.skyMesh?.geometry.dispose();
		this.skyMesh?.material.dispose();
		this.geoRT.dispose();
		this.layerRT.dispose();
		this.normalRT?.dispose();
		this.statsRT?.dispose();
		this.maskTex?.dispose();
		this.photoTex?.dispose();
		this.brushTex.dispose();
		this.shared.reliefField.value.dispose();
		this.shared.reliefGen.value.dispose();
		this.renderer.dispose();
		this.listeners.clear();
	}

	get photoElement() {
		return this.photoImg;
	}

	// ---------------- Step Inside (src/lib/nearfield, reports/step-inside-design.md) ----------------

	/** The people / foreground mask (row 0 = top), or null. */
	get foregroundMask() {
		return this.fgMask;
	}

	/** The last P(sky) mask handed to setSkyMask (0..255, row 0 = top), or null. */
	get skyMaskData() {
		return this.skyMaskStore;
	}

	/**
	 * Show a near-field scene (null = remove). The splats draw only in the world view and the step-inside
	 * camera (NEARFIELD_LAYER); in the world view the photo drape skips the scene's Object pixels.
	 */
	setNearField(scene: NearFieldScene | null, opts: NearFieldViewOpts = {}) {
		const cur = this.nf;
		if (!scene) {
			if (!cur) return;
			cur.splats.dispose();
			this.disposeNearFieldMasks(cur.masks);
			this.nf = null;
			this.requestRender();
			return;
		}
		const merged: NearFieldViewOpts = {
			...(cur?.scene === scene ? cur.opts : {}),
			...opts,
		};
		if (cur && cur.scene === scene) {
			cur.opts = merged;
			cur.splats.setTruth(!!merged.truth);
			cur.splats.setOpacity(merged.opacity ?? 1);
			this.requestRender();
			return;
		}
		if (cur) {
			cur.splats.dispose();
			this.disposeNearFieldMasks(cur.masks);
		}
		const splats = new ThreeSplats(scene.splats, {
			truth: !!merged.truth,
			opacity: merged.opacity ?? 1,
		});
		splats.layers.set(NEARFIELD_LAYER);
		// the worker sort lands asynchronously (no event): after a draw, watch a few frames for a new order
		let polling = false;
		splats.onAfterRender = () => {
			if (polling) return;
			polling = true;
			const sorts = splats.stats.sorts;
			let frames = 0;
			const tick = () => {
				if (this.disposed || this.nf?.splats !== splats) return;
				if (splats.stats.sorts !== sorts) {
					polling = false;
					this.requestRender();
				} else if (++frames < 20) requestAnimationFrame(tick);
				else polling = false;
			};
			requestAnimationFrame(tick);
		};
		this.scene.add(splats);
		this.nf = {
			scene,
			splats,
			opts: merged,
			masks: null,
		};
		this.rebuildNearFieldMasks();
		this.requestRender();
	}

	/** The shown near-field scene (the splat export reads it), or null. */
	get nearFieldScene(): NearFieldScene | null {
		return this.nf?.scene ?? null;
	}

	/**
	 * Step Inside's terrain range for the current pose (controller NearFieldHost.nearFieldDemRange): the
	 * shared near-DEM source (nearfield/near-dem.ts, the same in deck/engine.ts), CPU terrain profiles within
	 * NEAR_DEM_CPU_MAX, the geometry buffer (sampleAt) beyond, so the anchor, split and grounding see the same
	 * near terrain in both renderers. Classic queries are unchanged.
	 */
	/** The shared near-camera DEM (nearfield/near-dem.ts), once prepareNearFieldDem() loaded it. */
	private nearDem: NearDem | null = null;

	/** Load the shared near DEM for Step Inside (controller, before it samples nearFieldDemRange). */
	async prepareNearFieldDem() {
		this.nearDem ??= await loadNearDem(
			this.photo.lat,
			this.photo.lon,
			this.photo.alt,
			{ signal: this.loadAbort.signal },
		);
	}

	nearFieldDemRange(
		width: number,
		height: number,
	): (u: number, v: number) => number | null {
		return nearFieldDemRangeFrom(
			this.nearDem ?? this.terrain,
			{ pose: this.pose, aspect: this.aspect, eye: this.eye },
			width,
			height,
			(u, v) => this.sampleAt(u, v)?.range ?? null,
		);
	}

	/** Near-field object under normalised photo coords (Object pixels of the shown scene), else null. */
	nearFieldSampleAt(u: number, v: number): NearFieldSample | null {
		return nearFieldSampleAt(this.nf?.scene, u, v);
	}

	/** Near-field state for dev tools (window.__nearfield). */
	get nearFieldInfo() {
		const nf = this.nf;
		return nf
			? {
					splats: nf.scene.splats.count,
					drawn: nf.splats.stats.drawn,
					sorts: nf.splats.stats.sorts,
					opts: { ...nf.opts },
					stepping: !!this.step,
				}
			: null;
	}

	/**
	 * The scene's drape / sky masks at split resolution (row 0 = top):
	 *   worldFg / worldObj  Object pixels (3×3 dilated), with / without the people mask: the world view
	 *                       never smears an object across the ground (holes show the map instead)
	 *   step                Object pixels that splats actually cover: from the photo camera the rest
	 *                       drapes exactly, so the step view starts identical to the photo
	 *   sky                 Sky pixels (2 cells dilated): where the photo sphere may show the photo
	 */
	private rebuildNearFieldMasks() {
		const nf = this.nf;
		if (!nf) return;
		const { width: W, height: H, cls } = nf.scene.split;
		const dilate = (src: Uint8Array, r: number) => {
			const out = new Uint8Array(W * H);
			for (let j = 0; j < H; j++)
				for (let i = 0; i < W; i++) {
					let hit = 0;
					for (let dj = -r; dj <= r && !hit; dj++) {
						const y = j + dj;
						if (y < 0 || y >= H) continue;
						for (let di = -r; di <= r; di++) {
							const x = i + di;
							if (x >= 0 && x < W && src[y * W + x]) {
								hit = 255;
								break;
							}
						}
					}
					out[j * W + i] = hit;
				}
			return out;
		};
		const isObj = new Uint8Array(W * H);
		const isSky = new Uint8Array(W * H);
		for (let k = 0; k < W * H; k++) {
			isObj[k] = cls[k] === PixelClass.Object ? 1 : 0;
			isSky[k] = cls[k] === PixelClass.Sky ? 1 : 0;
		}
		const obj = dilate(isObj, 1);
		// splat coverage from the photo camera (the measure grid when the controller attached one)
		const grid =
			(nf.scene as MeasurableScene).measure ??
			buildMeasureGrid(nf.scene, {
				pose: this.pose,
				aspect: this.aspect,
				eye: this.eye,
				frame: this.frame,
			});
		// a splat counts only when it stands clearly in front of the terrain there: people-mask halos and
		// ground lifted at (or behind) the DEM surface lose the depth test, so masking them leaves holes
		// (the shared near-DEM source, as deck-step.ts stepMasks in the deck engine)
		const fresh = this.geometryReady();
		const demAt = fresh ? this.nearFieldDemRange(W, H) : null;
		const hasSplat = new Uint8Array(W * H);
		for (let j = 0; j < H; j++)
			for (let i = 0; i < W; i++) {
				const k = j * W + i;
				const r = grid.range[k];
				if (!(r > 0)) continue;
				const dem = demAt?.((i + 0.5) / W, (j + 0.5) / H) ?? 0;
				hasSplat[k] = !(dem > 0) || r < dem * 0.97 - 0.5 ? 1 : 0;
			}
		const covered = dilate(hasSplat, 1);
		const step = new Uint8Array(W * H);
		for (let k = 0; k < W * H; k++) step[k] = isObj[k] && covered[k] ? 255 : 0;
		const sky = dilate(isSky, 2);
		const fg = this.fgMask;
		const tex = (val: (k: number, i: number, j: number) => number) => {
			const rgba = new Uint8Array(W * H * 4);
			for (let j = 0; j < H; j++)
				for (let i = 0; i < W; i++) {
					const k = j * W + i;
					rgba[k * 4] = val(k, i, j);
					rgba[k * 4 + 3] = 255;
				}
			const t = new THREE.DataTexture(rgba, W, H);
			t.flipY = true;
			t.minFilter = t.magFilter = THREE.LinearFilter;
			t.needsUpdate = true;
			return t;
		};
		const fgAt = (i: number, j: number) => {
			if (!fg) return 0;
			const x = Math.min(fg.width - 1, Math.floor(((i + 0.5) / W) * fg.width));
			const y = Math.min(
				fg.height - 1,
				Math.floor(((j + 0.5) / H) * fg.height),
			);
			return fg.data[y * fg.width + x];
		};
		this.disposeNearFieldMasks(nf.masks);
		nf.masks = {
			worldFg: tex((k, i, j) => obj[k] || fgAt(i, j)),
			worldObj: tex((k) => obj[k]),
			step: tex((k) => step[k]),
			sky: tex((k) => sky[k]),
		};
	}

	private disposeNearFieldMasks(m: NearFieldMasks | null) {
		if (!m) return;
		m.worldFg.dispose();
		m.worldObj.dispose();
		m.step.dispose();
		m.sky.dispose();
	}

	/** True while the step-inside camera drives the view. */
	get steppingInside() {
		return !!this.step;
	}

	/** The step-inside camera (dev tools / UI), or null. */
	/** Renderer.tiles3dAttribution: the 3D Tiles credit line while stepping (null = none on screen). */
	tiles3dAttribution(): string | null {
		return this.tiles3d?.attribution() ?? null;
	}

	get stepCamera() {
		return this.step?.cam ?? null;
	}

	/**
	 * Step inside the photo: a camera that starts exactly at the photo camera and may move within
	 * `radius` metres (NearFieldScene.confidenceRadius), drawn with the drape, the near-field splats and
	 * the photo on a far sphere. Works from any mode; `onBack` fires when backToPhoto() arrives.
	 */
	enterStepInside(opts: StepInsideOpts = {}) {
		if (!this.terrain || this.disposed) return;
		this.exitStepInside();
		const view = opts.view ?? "step";
		applyPose(this.cam, this.pose, this.aspect, this.eye);
		const fromWorld = this.settings.mode === "world";
		if (this.controls) this.controls.enabled = false;
		this.flight = undefined;
		const cam = new StepCamera(this.worldCam, this.renderer.domElement, {
			eye: this.eye.clone(),
			quaternion: this.cam.quaternion.clone(),
			vfov: this.pose.vfov,
			aspect: this.aspect,
			radius: opts.radius ?? this.nf?.scene.confidenceRadius ?? 10,
			pivotDist: opts.pivotDist,
			mode: opts.mode,
			easeIn: view === "map" && fromWorld,
			groundAt: (x, y) => {
				const g = this.frame.toGeo(x, y, 0);
				const h = this.terrain?.heightAt(g.lat, g.lon);
				return h == null ? null : this.frame.fromGeo(g.lat, g.lon, h)[2];
			},
			onChange: () => this.requestRender(),
			onBack: opts.onBack,
		});
		this.step = { cam, sky: makePhotoSky(), fromWorld, view };
		if (view === "step")
			this.tiles3d?.enter(this.photo.lat, this.photo.lon, this.eye);
		this.requestRender();
	}

	/** Leave the step camera. In the world view the camera stays on the photo (as after flyToPhoto). */
	exitStepInside() {
		const st = this.step;
		if (!st) return;
		this.step = null;
		this.tiles3d?.exit();
		st.cam.dispose();
		st.sky.geometry.dispose();
		st.sky.material.dispose();
		if (this.settings.mode === "world" && this.controls) {
			applyPose(this.cam, this.pose, this.aspect, this.eye);
			this.flight = {
				t0: 0,
				dur: 1,
				fromPos: this.worldCam.position.clone(),
				fromQ: this.worldCam.quaternion.clone(),
				fromFov: this.worldCam.fov,
				toQ: this.cam.quaternion.clone(),
				held: true,
			};
		}
		this.requestRender();
	}
}
