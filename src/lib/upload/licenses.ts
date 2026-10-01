// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Third-party notices for the upload path. libheif (and the libde265 HEVC decoder it embeds)
// are LGPL-3.0: we ship them unmodified as a separate, replaceable file (decode.ts LIBHEIF_URL)
// and must give prominent notice plus the licence text. The text is imported raw from the
// installed package so it always matches the shipped version.
import lgplText from "libheif-js/libheif-wasm/LICENSE?raw";
import { LIBHEIF_URL } from "./decode";

export type Notice = {
	name: string;
	version: string;
	license: string;
	source: string;
	note: string;
};

export const THIRD_PARTY: Notice[] = [
	{
		name: "libheif (via libheif-js)",
		version: "1.23.2",
		license: "LGPL-3.0",
		source: "https://github.com/strukturag/libheif",
		note: "HEIC/HEIF container decoding. Emscripten build from https://github.com/catdad-experiments/libheif-js, used unmodified.",
	},
	{
		name: "libde265 (bundled inside libheif-js)",
		version: "as shipped by libheif-js 1.23.2",
		license: "LGPL-3.0",
		source: "https://github.com/strukturag/libde265",
		note: "HEVC (H.265) image decoding.",
	},
];

/** Full GNU LGPL v3 + GNU GPL v3 text, as shipped in libheif-js. */
export const LGPL_TEXT: string = lgplText;

/** URL of the separate libheif file; replace it with your own build to relink (LGPL §4). */
export const LIBHEIF_FILE_URL = LIBHEIF_URL;
