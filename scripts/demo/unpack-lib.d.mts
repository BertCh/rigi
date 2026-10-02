// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

export function poseEntry(photo: {
	pose?: unknown;
	poseSource?: string;
	confidence?: number;
}): { pose: unknown; source: string | undefined; confidence?: number } | null;
