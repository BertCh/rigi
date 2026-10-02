// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// XMP sidecar (.xmp) carrying GPS + camera orientation.
// - GPS: the standard EXIF-in-XMP schema (http://ns.adobe.com/exif/1.0/), readable by exiftool,
//   Lightroom/Camera Raw, darktable, digiKam.
// - Orientation: Google Photo Sphere pose tags (GPano, http://ns.google.com/photos/1.0/panorama/)
//   PoseHeadingDegrees/PosePitchDegrees/PoseRollDegrees, with UsePanoramaViewer=False so viewers
//   keep treating it as a flat photo. GPano roll: "as roll increases, the horizon rotates
//   counterclockwise in the image" = camera right side down = the app's roll sign.
// - Full model: a custom namespace `slens` (https://summit-lens.app/ns/pose/1.0/) with fov,
//   focal px, ECEF centre and camera→ECEF rotation.
import {
	buildCameraModel,
	type CameraInput,
	type CameraModel,
	fixedAzimuth,
	isTrustedEstimate,
	wrap360,
} from "./camera";
import { xmlEscape } from "./kml";

export const SLENS_NS = "https://summit-lens.app/ns/pose/1.0/";

/** EXIF-XMP GPS coordinate string "DDD,MM.mmmmmmR". */
export function xmpGpsCoord(deg: number, pos: "N" | "E", neg: "S" | "W") {
	// Round the total in micro-minutes first so 59.9999995′ carries into the degrees (never "60.000000").
	const micro = Math.round(Math.abs(deg) * 60 * 1e6);
	const d = Math.floor(micro / 60e6);
	const min = (micro - d * 60e6) / 1e6;
	return `${d},${min.toFixed(6)}${deg >= 0 ? pos : neg}`;
}

export function buildXmp(input: CameraInput | CameraModel): string {
	const m = "K" in input ? input : buildCameraModel(input);
	const p = m.input.pose;
	const heading = wrap360(p.yaw);
	// EXIF GPSImgDirection is 0..359.99: round in hundredths, then wrap 36000 → 0.
	const dirHundredths = Math.round(heading * 100) % 36000;
	const altMm = Math.round(Math.abs(m.altMsl) * 1000);
	const f = (v: number, d = 6) => Number(v.toFixed(d)).toString();
	const est = m.input.estimate;
	// How the pose is known; nothing is written when the exporter did not say (unknown, not "untrusted")
	const estimate = [
		est
			? `\n   slens:PoseTrusted="${isTrustedEstimate(est) ? "True" : "False"}"`
			: "",
		est?.provenance.status
			? `\n   slens:PoseStatus="${xmlEscape(est.provenance.status)}"`
			: "",
		est?.provenance.method
			? `\n   slens:PoseMethod="${xmlEscape(est.provenance.method)}"`
			: "",
		est?.label ? `\n   slens:PoseLabel="${xmlEscape(est.label)}"` : "",
		est?.confidence != null && Number.isFinite(est.confidence)
			? `\n   slens:PoseConfidence="${f(est.confidence)}"`
			: "",
	].join("");
	const ts = m.input.takenAt
		? `\n   exif:GPSTimeStamp="${xmlEscape(m.input.takenAt)}"`
		: "";
	return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Rigi export">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:exif="http://ns.adobe.com/exif/1.0/"
   xmlns:GPano="http://ns.google.com/photos/1.0/panorama/"
   xmlns:slens="${SLENS_NS}"
   exif:GPSVersionID="2.3.0.0"
   exif:GPSLatitude="${xmpGpsCoord(m.lat, "N", "S")}"
   exif:GPSLongitude="${xmpGpsCoord(m.lon, "E", "W")}"
   exif:GPSAltitudeRef="${m.altMsl >= 0 ? 0 : 1}"
   exif:GPSAltitude="${altMm}/1000"
   exif:GPSImgDirectionRef="T"
   exif:GPSImgDirection="${dirHundredths}/100"
   exif:GPSMapDatum="WGS-84"${ts}
   exif:FocalLengthIn35mmFilm="${Math.round(m.f35)}"
   GPano:UsePanoramaViewer="False"
   GPano:PoseHeadingDegrees="${fixedAzimuth(heading, 6)}"
   GPano:PosePitchDegrees="${f(p.pitch)}"
   GPano:PoseRollDegrees="${f(p.roll)}"
   slens:SchemaVersion="1"
   slens:Yaw="${f(p.yaw)}"
   slens:Pitch="${f(p.pitch)}"
   slens:Roll="${f(p.roll)}"
   slens:VerticalFOV="${f(m.vfov)}"
   slens:HorizontalFOV="${f(m.hfov)}"
   slens:FocalLengthPixels="${f(m.f, 4)}"
   slens:ImageWidth="${m.width}"
   slens:ImageHeight="${m.height}"
   slens:AltitudeMSL="${f(m.altMsl, 3)}"
   slens:AltitudeEllipsoid="${f(m.altEllipsoid, 3)}"
   slens:CameraCenterECEF="${m.C_ecef.map((v) => f(v, 4)).join(" ")}"
   slens:RotationCameraToECEF="${m.R_cam2ecef.map((v) => f(v, 12)).join(" ")}"${estimate}
   slens:Convention="yaw clockwise from true north; pitch up +; roll right-side-down +; camera axes x right, y down, z forward; rotation row-major"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}
