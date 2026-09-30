// Google Earth PhotoOverlay (KML 2.2) + KMZ packaging.
// Reference: https://developers.google.com/kml/documentation/kmlreference#photooverlay
//            https://developers.google.com/kml/documentation/cameras
import {
	buildCameraModel,
	type CameraInput,
	type CameraModel,
	fixedAzimuth,
	kmlCameraAngles,
} from "./camera";
import { zipStore } from "./zip";

export function xmlEscape(s: string) {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export type KmlOptions = {
	/** Image href inside the KML. Default `files/<imageName>` (the KMZ layout). */
	href?: string;
	name?: string;
	description?: string;
	/** Distance (m) from the eye at which the photo rectangle is placed. Default 50. */
	near?: number;
};

const n6 = (v: number) => Number(v.toFixed(6)).toString();
const n9 = (v: number) => Number(v.toFixed(9)).toString();

/** A KML document with a single PhotoOverlay viewed from the solved camera. */
export function buildPhotoOverlayKml(
	input: CameraInput | CameraModel,
	opts: KmlOptions = {},
): string {
	const m = "K" in input ? input : buildCameraModel(input);
	const { heading, tilt, roll } = kmlCameraAngles(m.input.pose);
	const href = opts.href ?? `files/${m.imageName}`;
	const name = opts.name ?? m.input.photoId;
	const near = opts.near ?? 50;
	const hh = m.hfov / 2;
	const vh = m.vfov / 2;
	const when = m.input.takenAt
		? `\n      <TimeStamp><when>${xmlEscape(m.input.takenAt)}</when></TimeStamp>`
		: "";
	const desc =
		opts.description ??
		`Solved with Rigi. heading ${fixedAzimuth(heading, 2)}°, pitch ${m.input.pose.pitch.toFixed(2)}°, roll ${m.input.pose.roll.toFixed(2)}°, vfov ${m.vfov.toFixed(2)}°.`;
	// altitudeMode absolute = metres above sea level (Google Earth's EGM96 geoid) — matches the DEM datum.
	const alt = n6(m.altMsl);
	return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>${xmlEscape(name)}</name>
    <PhotoOverlay>
      <name>${xmlEscape(name)}</name>
      <description>${xmlEscape(desc)}</description>${when}
      <Camera>
        <longitude>${n9(m.lon)}</longitude>
        <latitude>${n9(m.lat)}</latitude>
        <altitude>${alt}</altitude>
        <heading>${fixedAzimuth(heading, 6)}</heading>
        <tilt>${n6(tilt)}</tilt>
        <roll>${n6(roll)}</roll>
        <altitudeMode>absolute</altitudeMode>
      </Camera>
      <Icon>
        <href>${xmlEscape(href)}</href>
      </Icon>
      <rotation>0</rotation>
      <ViewVolume>
        <leftFov>${n6(-hh)}</leftFov>
        <rightFov>${n6(hh)}</rightFov>
        <bottomFov>${n6(-vh)}</bottomFov>
        <topFov>${n6(vh)}</topFov>
        <near>${n6(near)}</near>
      </ViewVolume>
      <Point>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>${n9(m.lon)},${n9(m.lat)},${alt}</coordinates>
      </Point>
      <shape>rectangle</shape>
    </PhotoOverlay>
  </Document>
</kml>
`;
}

/** KMZ = zip(doc.kml, files/<image>). `jpeg` is the photo bytes. */
export function buildKmz(
	input: CameraInput | CameraModel,
	jpeg: Uint8Array,
	opts: Omit<KmlOptions, "href"> = {},
): Uint8Array {
	const m = "K" in input ? input : buildCameraModel(input);
	const path = `files/${m.imageName}`;
	const kml = buildPhotoOverlayKml(m, { ...opts, href: path });
	return zipStore([
		{ name: "doc.kml", data: kml },
		{ name: path, data: jpeg },
	]);
}

/** Browser convenience: KMZ as a Blob (application/vnd.google-earth.kmz). */
export function kmzBlob(bytes: Uint8Array) {
	return new Blob([bytes as BlobPart], {
		type: "application/vnd.google-earth.kmz",
	});
}
