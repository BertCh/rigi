// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// FUND E5 ray-cast oracle. Not imported by the app. CPU f64 reference in ./cpu, WGSL twin in ./gpu.
export * from "./cpu";
export { createGpuRayScene, type GpuRayScene, packScene, RAYCAST } from "./gpu";
