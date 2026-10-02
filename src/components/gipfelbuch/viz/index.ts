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
