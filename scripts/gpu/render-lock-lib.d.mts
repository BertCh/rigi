// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

export function isStaleOwner(args: {
	pid: number;
	alive: boolean;
	recorded: string;
	current: string;
}): boolean;
