// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

export { Callout } from "./Callout";
export { CodeRef } from "./CodeRef";
export { DEMO_IMAGES, DemoImage, type DemoName } from "./DemoImage";
export { Figure, type FigureImprint } from "./Figure";
export { FigureSkeleton } from "./FigureSkeleton";
export type { SpillCursor, SpillEcho } from "./GeoSpill";
export {
	contrastRatio,
	ensureContrast,
	GROUND_BASE,
	GROUND_CONTRAST,
	type GroundPalette,
	type GroundSurface,
	type GroundVar,
	groundPalette,
	groundVars,
	mixHex,
} from "./ground";
export {
	scrubValue,
	useAutoScrub,
	useDrawOn,
	useInView,
	useRaf,
	useReducedMotion,
	useTime,
} from "./hooks";
export {
	dashFor,
	inkFor,
	isPhotoLayer,
	LAYER_INKS,
	layerOfColor,
} from "./inks";
export { HandLabel, HandNote, HandRange } from "./labels";
export {
	LIVE_REVEAL_SETS,
	LiveCompare,
	LiveDrape,
	LiveHowItWorks,
	type LiveMotion,
	type LiveNote,
	LivePanorama,
	LivePlate,
	type LivePlateProps,
	LiveReveal,
	type LiveRevealId,
	LiveStepInside,
	LiveTopoBoard,
	PaperSurround,
} from "./live";
export { MarginNote } from "./MarginNote";
export { Eq, Frac, Op, Sym } from "./math";
export {
	ARM,
	ARM_SEQUENCE,
	BEAT_ORDER,
	type BeatClock,
	type BeatKind,
	type BeatSpec,
	type Beats,
	beatScriptProblem,
	buildTimeline,
	EASE,
	type EaseName,
	ease,
	MOTION,
	type Playback,
	RESET,
	rampAt,
	sampleTimeline,
	smooth,
	spillTAt,
	stagger,
	startOf,
	type Timeline,
	transitionOf,
	useArmedInView,
	useBeatClock,
	useBeats,
	useMotionAllowed,
} from "./motion";
export {
	GHOST_OPACITY,
	type LayerState,
	layerOpacity,
	OVERLAY_ROLES,
	OVERLAY_STACK,
	OverlayLayer,
	type OverlayRole,
	overlayStyle,
	sortByStack,
} from "./overlay";
export { PhotoStory, type PhotoStoryProps } from "./PhotoStory";
export { Plot, type PlotScale } from "./Plot";
export { Reveal } from "./Reveal";
export {
	CrispLine,
	coneWedge,
	DemPatch,
	GIPFELBUCH_PHOTO_IDS,
	type GipfelbuchIndex,
	type GipfelbuchPeak,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	imprintFor,
	isStaleData,
	LAYER_STYLE,
	layoutPeakLabels,
	Measured,
	type PeakLabelItem,
	type PhotoLayer,
	PhotoPicker,
	type PlacedPeakLabel,
	RealPhoto,
	rowsPath,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
	useLoadFailure,
} from "./real";
export { PROSE, Section, Stat } from "./Section";
export { Flow, type FlowNode, type StepItem, Steps } from "./Steps";
export { StoryMap } from "./StoryMap";
export {
	AlignmentStoryProvider,
	poseAt,
	useAlignmentStory,
} from "./story";
