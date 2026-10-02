// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Model weights for in-browser compute: served from public/models (content-hashed filenames, listed
// in scripts/models/manifest.json), cached in Cache Storage and run by src/lib/nn (WGSL on the app's compute
// graph; the CPU reference backend elsewhere). See README.md.

export type { FetchModelOptions, ModelEntry } from "./fetch";
export {
	fetchModel,
	filenameHash,
	MODEL_CACHE,
	modelEntry,
	modelFileName,
	modelUrl,
	verifyModel,
} from "./fetch";
export type { ModelDownload, ModelDownloadState } from "./progress";
export {
	describeModelDownload,
	formatBytes,
	modelDownloads,
	subscribeModelDownloads,
} from "./progress";
