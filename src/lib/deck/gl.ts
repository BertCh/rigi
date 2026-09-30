import type { Device } from "@luma.gl/core";

/** The WebGL2 context behind a luma.gl WebGL device (deck.gl's device; not for WebGPU devices). */
export const glOf = (device: Device): WebGL2RenderingContext =>
	(device as unknown as { gl: WebGL2RenderingContext }).gl;
