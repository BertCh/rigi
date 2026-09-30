// The one submit for core/** users: finishes the encoder, submits it, then lets the pool destroy
// grown-out buffers and the profiler collect pass timestamps. Use it instead of
// device.submit(enc.finish()) wherever pooled buffers or profiled passes were recorded.
import type { CommandEncoder, Device } from "@luma.gl/core";
import { afterSubmit as poolAfterSubmit } from "./pool";
import { afterSubmit as profileAfterSubmit } from "./profile";

/** Finish `enc` and submit it on `device`'s queue. */
export function submit(device: Device, enc: CommandEncoder): void {
	device.submit(enc.finish());
	poolAfterSubmit(device);
	profileAfterSubmit(device);
}
