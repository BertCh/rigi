// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Location coaching for the upload page (roadmap R7: the target input is an iPhone photo with GPS,
// compass heading and the gravity vector). Pure: which sensors a file carried, a one-line headline,
// and the steps that would have recorded the missing ones next time. iOS gets the exact settings
// path; other devices get the generic version. Copy rules: plain, second person, no exclamation marks.

export type SensorId = "position" | "heading" | "tilt";

export interface CoachSensor {
	id: SensorId;
	label: "Position" | "Heading" | "Tilt";
	present: boolean;
}

export interface LocationCoaching {
	status: "complete" | "partial" | "none";
	headline: string;
	/** Why the position is missing, when it is (EXIF stripped vs no EXIF at all); else null. */
	note: string | null;
	sensors: CoachSensor[];
	steps: { id: string; text: string }[];
}

/** The fields of exifDiagnostics() the coach reads. */
export interface CoachInput {
	hasExif: boolean;
	hasGps: boolean;
	hasHeading: boolean;
	hasGravity: boolean;
}

export const COACH_HEADLINE = {
	complete: "Position, heading and tilt are all in the file.",
	partial: "Some sensor data is missing, so alignment searches wider.",
	none: "This photo carries no position, heading or tilt.",
} as const;

const STEPS_IOS: Record<SensorId, { id: string; text: string }[]> = {
	position: [
		{
			id: "ios-camera-location",
			text: "Turn on Location for the Camera: Settings, Privacy & Security, Location Services, Camera, While Using, with Precise Location on.",
		},
		{
			id: "ios-picker-options",
			text: "In the photo picker, tap Options and turn Location on, or choose the file from Files.",
		},
	],
	heading: [
		{
			id: "ios-compass",
			text: "Turn on Compass Calibration (Location Services, System Services) so the photo records which way you faced.",
		},
	],
	tilt: [
		{
			id: "ios-camera-app",
			text: "Take the photo with the iPhone Camera app and upload the original; edited or re-saved copies can lose the motion data.",
		},
	],
};

const STEPS_OTHER: Record<SensorId, { id: string; text: string }[]> = {
	position: [
		{
			id: "camera-location",
			text: "Allow your camera app to use location, with precise location on.",
		},
		{
			id: "original-file",
			text: "Upload the original file; screenshots, messaging apps and some exports remove the location.",
		},
	],
	heading: [
		{
			id: "compass",
			text: "Phones record the compass heading when location is on and the compass is calibrated.",
		},
	],
	tilt: [
		{
			id: "tilt-iphone",
			text: "Tilt (the gravity vector) is read from iPhone photos today; other cameras leave pitch and roll to the alignment.",
		},
	],
};

export const PLACE_ON_MAP = {
	id: "place-on-map",
	text: "For now, click the map to place where you stood.",
};

/** What the file carried and how to record the rest next time. */
export function coachLocation(
	diag: CoachInput,
	o: { ios: boolean },
): LocationCoaching {
	const sensors: CoachSensor[] = [
		{ id: "position", label: "Position", present: diag.hasGps },
		{ id: "heading", label: "Heading", present: diag.hasHeading },
		{ id: "tilt", label: "Tilt", present: diag.hasGravity },
	];
	const present = sensors.filter((s) => s.present).length;
	const status =
		present === sensors.length ? "complete" : present ? "partial" : "none";
	const table = o.ios ? STEPS_IOS : STEPS_OTHER;
	const steps = sensors.filter((s) => !s.present).flatMap((s) => table[s.id]);
	if (!diag.hasGps) steps.push(PLACE_ON_MAP);
	const note = diag.hasGps
		? null
		: diag.hasExif
			? "The file has EXIF metadata, but its location was removed."
			: "The file has no EXIF metadata at all; screenshots, messaging apps and some exports remove it.";
	return { status, headline: COACH_HEADLINE[status], note, sensors, steps };
}

/** iPhone, iPad or iPod. iPadOS reports a Macintosh UA, so a Mac UA with touch points counts too. */
export function isIosUserAgent(ua: string, maxTouchPoints = 0): boolean {
	if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return true;
	return /\bMacintosh\b/.test(ua) && maxTouchPoints > 1;
}
