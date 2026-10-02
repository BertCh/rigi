// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// When Step Inside may fetch its depth model before the user asks for it: the weights download in the
// background once a pose is accepted, so pressing Step Inside usually finds them in Cache Storage. Not
// on metered or slow connections (Network Information API, where the browser has it).

/** The parts of navigator.connection read here (absent in Firefox / Safari: prefetch allowed). */
export type ConnectionHint = {
	saveData?: boolean;
	effectiveType?: string;
};

/** Seconds after an accepted pose before the prefetch starts (the matcher's own work goes first). */
export const PREFETCH_DELAY_MS = 2500;

const SLOW = new Set(["slow-2g", "2g", "3g"]);

/** False when the user asked to save data or the connection is slow. */
export function prefetchAllowed(
	connection: ConnectionHint | undefined,
): boolean {
	if (!connection) return true;
	if (connection.saveData) return false;
	return !SLOW.has(connection.effectiveType ?? "");
}

/** navigator.connection, where the browser exposes it. */
export function currentConnection(): ConnectionHint | undefined {
	if (typeof navigator === "undefined") return undefined;
	return (navigator as { connection?: ConnectionHint }).connection;
}
