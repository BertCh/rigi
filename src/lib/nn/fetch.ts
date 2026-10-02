// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Weight bytes for nn.loadWeights: src/lib/models fetchModel (public/models, Cache Storage backed,
// download progress; node reads the file), with an override hook for tests and harnesses.

import {
	type FetchModelOptions,
	fetchModel as fetchFromModels,
} from "#/lib/models/fetch";

type Fetcher = (file: string, o?: FetchModelOptions) => Promise<ArrayBuffer>;

let override: Fetcher | null = null;

/** Tests / harnesses: replace the byte source (null restores src/lib/models). */
export function setModelFetcher(f: Fetcher | null) {
	override = f;
}

export function fetchModel(
	file: string,
	o: FetchModelOptions = {},
): Promise<ArrayBuffer> {
	return (override ?? fetchFromModels)(file, o);
}
