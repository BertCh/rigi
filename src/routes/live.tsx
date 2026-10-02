// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute } from "@tanstack/react-router";
import { LiveView } from "#/components/live/LiveView";

// /live: the real-time camera view (src/lib/live, components/live). Browser-only (camera, sensors, GPU).
// ?liveSource=<video url> drives it from a recorded clip, with <url>.sensors.json replaying the sensors.
export const Route = createFileRoute("/live")({
	ssr: false,
	head: () => ({ meta: [{ title: "Live · Rigi" }] }),
	component: LiveView,
});
