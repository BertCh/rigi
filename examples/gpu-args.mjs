// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Chromium flags for real-GPU WebGPU runs on this Mac (Metal). Headless Chromium exposes
// navigator.gpu with these.
export const GPU_ARGS = [
  '--use-angle=metal',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,WebGPU'
];
