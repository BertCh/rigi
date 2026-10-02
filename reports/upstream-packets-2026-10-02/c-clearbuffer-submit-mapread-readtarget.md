# (c) `clearBuffer`, `Device.submit` extras, `mapAndReadAsync` without the wait, `readAsync` into a target

Status: **local packet, nothing posted** (owner decides). Rank 5, 6, 8 and 9 (c1 to c4) of 11 in [README.md](README.md). Base: luma master `00aab0f91` (2026-10-02, "fix(examples): refine architectural charcoal strokes (#3349)").

Kind: four small API additions, to be sent as four PRs in this order. c1 and c2 are independent of any open PR (c2's spec uses c1). c3 and c4 edit `WebGPUBuffer.readAsync` / `Buffer` in the same places as open PR #3330 (`fix(webgpu): stage only the requested range in buffer readback`) and were built on top of it: send them after #3330 merges, or as a stack on it.

## Why these four

Rigi's compute layer (`src/lib/gpu/core`) used raw handles or luma privates for each of them until the vendored patches existed:

| Need | Before | After the patch |
|---|---|---|
| zero a buffer range on the caller's encoder | raw `GPUCommandEncoder.clearBuffer` through the native handle (`core/pool.ts` `clear()`) | `enc.clearBuffer(buffer, offset, size)` |
| submit the default encoder plus extra, already finished command buffers in one `queue.submit` | private `WebGPUDevice._finalizeDefaultCommandEncoderForSubmit()` plus raw `queue.submit` (`core/queue.ts`) | `device.submit(undefined, [extra, ...])` |
| read a `MAP_READ` staging slot as soon as its own copy is done | `mapAndReadAsync` always awaits `queue.onSubmittedWorkDone()` first, so a read also waits for everything submitted after it (raw `mapAsync` in `core/readback.ts`) | `mapAndReadAsync(cb, off, len, {waitForSubmittedWork: false})` |
| read into a caller-owned array (no allocation per read) | allocate a new `Uint8Array` per read | `readAsync(off, len, {target})` |

## c1 `CommandEncoder.clearBuffer`

### Problem

There is no portable way to zero a buffer range in command order: apps reach into `device.handle` on WebGPU and have nothing on WebGL. Transients in a command graph are not zeroed, so any accumulating node needs it.

### Minimal repro

```ts
const encoder = device.createCommandEncoder();
encoder.clearBuffer(buffer, 0, 8); // TypeError on master: not a function
```

### Proposed patch

`patches/c1-clear-buffer.patch` (189 lines, `git am` format, authored as the owner).

`````diff
From d86a1a6aa2d3a5d5a5477daea53b80044a4c049e Mon Sep 17 00:00:00 2001
From: Robert Christie <rgcgeog@gmail.com>
Date: Fri, 2 Oct 2026 14:52:40 -0400
Subject: [PATCH] feat(core): CommandEncoder.clearBuffer(buffer, byteOffset?,
 byteLength?)

WebGPU records the native clearBuffer; WebGL queues a zero write through the buffer write path, flushed in command order. The null encoder queues it too. Offset and length must be multiples of four.
---
 .../src/adapter/resources/command-encoder.ts  |  9 ++++++
 .../adapter/resources/command-encoder.spec.ts | 31 +++++++++++++++++++
 .../resources/null-command-encoder.ts         |  5 +++
 .../adapter/resources/webgl-command-buffer.ts | 14 +++++++++
 .../resources/webgl-command-encoder.ts        |  7 +++++
 .../resources/webgpu-command-encoder.ts       |  9 ++++++
 6 files changed, 75 insertions(+)

diff --git a/modules/core/src/adapter/resources/command-encoder.ts b/modules/core/src/adapter/resources/command-encoder.ts
index bb9d62b55..dd7644b9f 100644
--- a/modules/core/src/adapter/resources/command-encoder.ts
+++ b/modules/core/src/adapter/resources/command-encoder.ts
@@ -182,6 +182,15 @@ export abstract class CommandEncoder extends Resource<CommandEncoderProps> {
   /** Add a command that copies data from a sub-region of one or multiple contiguous texture subresources to another sub-region of one or multiple continuous texture subresources. */
   abstract copyTextureToTexture(options: CopyTextureToTextureOptions): void;
 
+  /**
+   * Add a command that fills a sub-region of a Buffer with zeros.
+   * @param buffer Buffer to clear. Requires `Buffer.COPY_DST` usage on WebGPU.
+   * @param byteOffset Offset in bytes of the cleared region (default 0).
+   * @param byteLength Size in bytes of the cleared region (default: the rest of the buffer).
+   * @note On WebGPU, both must be multiples of 4.
+   */
+  abstract clearBuffer(buffer: Buffer, byteOffset?: number, byteLength?: number): void;
+
   /** Add a command that clears a texture mip level. */
   // abstract clearTexture(options: ClearTextureOptions): void;
 
diff --git a/modules/core/test/adapter/resources/command-encoder.spec.ts b/modules/core/test/adapter/resources/command-encoder.spec.ts
index b21fd725a..416247124 100644
--- a/modules/core/test/adapter/resources/command-encoder.spec.ts
+++ b/modules/core/test/adapter/resources/command-encoder.spec.ts
@@ -105,6 +105,10 @@ class TestCommandEncoder extends CommandEncoder {
     throw new Error('not implemented');
   }
 
+  clearBuffer(): void {
+    throw new Error('not implemented');
+  }
+
   copyBufferToTexture(): void {
     throw new Error('not implemented');
   }
@@ -1133,3 +1137,30 @@ function testBlit(t: Test, device: Device) {
   t.end();
 }
 /* eslint-disable max-statements */
+
+it('CommandEncoder.clearBuffer zeroes a buffer region', async () => {
+  for (const device of await getTestDevices(['webgl', 'webgpu', 'null'])) {
+    const buffer = device.createBuffer({
+      usage: Buffer.COPY_DST | Buffer.COPY_SRC | Buffer.STORAGE,
+      data: new Uint32Array([1, 2, 3, 4])
+    });
+
+    const commandEncoder = device.createCommandEncoder();
+    commandEncoder.clearBuffer(buffer, 4, 8);
+    device.submit(commandEncoder.finish());
+    expect(
+      Array.from(new Uint32Array((await buffer.readAsync()).slice().buffer)),
+      `${device.type} clearBuffer(offset, size) clears only that range`
+    ).toEqual([1, 0, 0, 4]);
+
+    const wholeBufferEncoder = device.createCommandEncoder();
+    wholeBufferEncoder.clearBuffer(buffer);
+    device.submit(wholeBufferEncoder.finish());
+    expect(
+      Array.from(new Uint32Array((await buffer.readAsync()).slice().buffer)),
+      `${device.type} clearBuffer(buffer) clears the whole buffer`
+    ).toEqual([0, 0, 0, 0]);
+
+    buffer.destroy();
+  }
+});
diff --git a/modules/test-utils/src/null-device/resources/null-command-encoder.ts b/modules/test-utils/src/null-device/resources/null-command-encoder.ts
index de1748815..fe35bf198 100644
--- a/modules/test-utils/src/null-device/resources/null-command-encoder.ts
+++ b/modules/test-utils/src/null-device/resources/null-command-encoder.ts
@@ -8,6 +8,7 @@ import type {
   ComputePass,
   ComputePassProps,
   QuerySet,
+  Buffer,
   CopyBufferToBufferOptions,
   CopyBufferToTextureOptions,
   CopyTextureToBufferOptions,
@@ -61,6 +62,10 @@ export class NullCommandEncoder extends CommandEncoder {
     );
   }
 
+  clearBuffer(buffer: Buffer, byteOffset: number = 0, byteLength?: number): void {
+    buffer.write(new Uint8Array(byteLength ?? buffer.byteLength - byteOffset), byteOffset);
+  }
+
   copyBufferToTexture(_options: CopyBufferToTextureOptions) {
     throw new Error('copyBufferToTexture is not supported on NullDevice');
   }
diff --git a/modules/webgl/src/adapter/resources/webgl-command-buffer.ts b/modules/webgl/src/adapter/resources/webgl-command-buffer.ts
index 0572b60ce..68f5f586e 100644
--- a/modules/webgl/src/adapter/resources/webgl-command-buffer.ts
+++ b/modules/webgl/src/adapter/resources/webgl-command-buffer.ts
@@ -11,6 +11,7 @@ import {
   type TextureReadOptions,
   // type ClearTextureOptions,
   CommandBuffer,
+  Buffer,
   Texture,
   Framebuffer,
   assertDefined
@@ -43,6 +44,11 @@ type CopyTextureToTextureCommand = {
   options: CopyTextureToTextureOptions;
 };
 
+type ClearBufferCommand = {
+  name: 'clear-buffer';
+  options: {buffer: Buffer; byteOffset: number; byteLength: number};
+};
+
 type ClearTextureCommand = {
   name: 'clear-texture';
   options: {}; // ClearTextureOptions;
@@ -58,6 +64,7 @@ type Command =
   | CopyBufferToTextureCommand
   | CopyTextureToBufferCommand
   | CopyTextureToTextureCommand
+  | ClearBufferCommand
   | ClearTextureCommand
   | ReadTextureCommand;
 
@@ -86,6 +93,13 @@ export class WEBGLCommandBuffer extends CommandBuffer {
         case 'copy-texture-to-texture':
           _copyTextureToTexture(this.device, command.options);
           break;
+        case 'clear-buffer':
+          // WebGL has no native clearBuffer: write zeros through the buffer write path
+          command.options.buffer.write(
+            new Uint8Array(command.options.byteLength),
+            command.options.byteOffset
+          );
+          break;
         // case 'clear-texture':
         //   _clearTexture(this.device, command.options);
         //   break;
diff --git a/modules/webgl/src/adapter/resources/webgl-command-encoder.ts b/modules/webgl/src/adapter/resources/webgl-command-encoder.ts
index bc70c28fc..ccdeb85d2 100644
--- a/modules/webgl/src/adapter/resources/webgl-command-encoder.ts
+++ b/modules/webgl/src/adapter/resources/webgl-command-encoder.ts
@@ -58,6 +58,13 @@ export class WEBGLCommandEncoder extends CommandEncoder {
     this.commandBuffer.commands.push({name: 'copy-buffer-to-buffer', options});
   }
 
+  clearBuffer(buffer: Buffer, byteOffset: number = 0, byteLength?: number): void {
+    this.commandBuffer.commands.push({
+      name: 'clear-buffer',
+      options: {buffer, byteOffset, byteLength: byteLength ?? buffer.byteLength - byteOffset}
+    });
+  }
+
   copyBufferToTexture(options: CopyBufferToTextureOptions) {
     this.commandBuffer.commands.push({name: 'copy-buffer-to-texture', options});
   }
diff --git a/modules/webgpu/src/adapter/resources/webgpu-command-encoder.ts b/modules/webgpu/src/adapter/resources/webgpu-command-encoder.ts
index e6492c157..69fbb40c8 100644
--- a/modules/webgpu/src/adapter/resources/webgpu-command-encoder.ts
+++ b/modules/webgpu/src/adapter/resources/webgpu-command-encoder.ts
@@ -113,6 +113,15 @@ export class WebGPUCommandEncoder extends CommandEncoder {
     );
   }
 
+  clearBuffer(buffer: Buffer, byteOffset: number = 0, byteLength?: number): void {
+    const webgpuBuffer = buffer as WebGPUBuffer;
+    this.handle.clearBuffer(
+      webgpuBuffer.handle,
+      byteOffset,
+      byteLength ?? buffer.byteLength - byteOffset
+    );
+  }
+
   copyBufferToTexture(options: CopyBufferToTextureOptions): void {
     const webgpuSourceBuffer = options.sourceBuffer as WebGPUBuffer;
     const webgpuDestinationTexture = options.destinationTexture as WebGPUTexture;
`````

Semantics: `clearBuffer(buffer, byteOffset = 0, byteLength = rest)`, abstract on `CommandEncoder`. WebGPU records the native `clearBuffer` (offset and length multiples of 4, as the API requires). WebGL queues a zero `buffer.write` in command order. `NullCommandEncoder` queues it as well. Anyone who subclasses `CommandEncoder` outside luma must implement it (review item: make it non-abstract with a throwing default if that is a concern).

### Test plan

- In the patch: `command-encoder.spec.ts` "CommandEncoder.clearBuffer zeroes a buffer region" over the webgl, webgpu and null test devices (browser tier for the first two; the null leg runs in node).
- Done here: the null-device leg through `yarn vitest run --project node modules/core modules/webgpu modules/webgl modules/test-utils modules/gpgpu modules/engine`.
- Not run: the WebGL and WebGPU legs of the spec (needs a browser).

### PR description (luma template)

```markdown
For # (open an issue first per the template; none filed)

#### Background

Applications that accumulate into a buffer (atomics, partial writes, GPU counters) need to zero a range at a defined point of a command stream. `CommandEncoder` has copies but no clear, so apps use native handles on WebGPU and have no WebGL path.

#### Rationale

A clear is the same kind of command as `copyBufferToBuffer`: it belongs on the encoder so it is ordered with the other commands. WebGPU has the native `clearBuffer`; WebGL gets the equivalent zero write queued in command order.

#### Change List

- Add abstract `CommandEncoder.clearBuffer(buffer, byteOffset?, byteLength?)`
- Implement for WebGPU (native), WebGL (queued zero write) and the null device
- Spec over the webgl, webgpu and null devices
```

## c2 `Device.submit(commandBuffer?, additionalCommandBuffers?)`

### Problem

`Device.submit(commandBuffer?)` submits one buffer. An application with its own encoders (a compute graph, a render pass built elsewhere) that wants them in the same queue submission, after luma's default encoder, has to call the private `_finalizeDefaultCommandEncoderForSubmit()` and `queue.submit` itself, and then also take care of the default encoder's GPU time resolve and of transient upload buffers.

### Minimal repro

```ts
device.commandEncoder.clearBuffer(buffer, 0, 8);         // work on the default encoder (needs c1)
const mine = device.createCommandEncoder();
mine.clearBuffer(buffer, 8, 8);
device.submit(undefined, [mine.finish()]);              // 2nd argument is ignored on master
```

### Proposed patch

`patches/c2-device-submit-additional-buffers.patch` (187 lines, `git am` format, authored as the owner).

`````diff
From d844a2ba1fac36dff3ae76f44a13361c31fa7688 Mon Sep 17 00:00:00 2001
From: Robert Christie <rgcgeog@gmail.com>
Date: Fri, 2 Oct 2026 14:52:40 -0400
Subject: [PATCH] feat(core): Device.submit(commandBuffer?,
 additionalCommandBuffers?)

Submit extra finished command buffers after the default encoder (or after the given buffer) in one queue.submit, so applications can batch their own encoders without private API. Every submitted buffer is consumed (destroyed).
---
 modules/core/src/adapter/device.ts            | 15 ++++++++--
 .../adapter/resources/command-encoder.spec.ts | 29 +++++++++++++++++++
 .../test-utils/src/null-device/null-device.ts |  8 ++++-
 modules/webgl/src/adapter/webgl-device.ts     | 14 +++++++--
 modules/webgpu/src/adapter/webgpu-device.ts   | 16 +++++++---
 5 files changed, 72 insertions(+), 10 deletions(-)

diff --git a/modules/core/src/adapter/device.ts b/modules/core/src/adapter/device.ts
index 5aa2863fc..fe3a2a571 100644
--- a/modules/core/src/adapter/device.ts
+++ b/modules/core/src/adapter/device.ts
@@ -765,8 +765,19 @@ or create a device with the 'debug: true' prop.`;
   /** Creates a presentation context for a destination canvas. WebGL requires the default canvas context to use an OffscreenCanvas. */
   abstract createPresentationContext(props?: PresentationContextProps): PresentationContext;
 
-  /** Call after rendering a frame (necessary e.g. on WebGL OffscreenCanvas) */
-  abstract submit(commandBuffer?: CommandBuffer): void;
+  /**
+   * Call after rendering a frame (necessary e.g. on WebGL OffscreenCanvas).
+   * @param commandBuffer Command buffer to submit first. When omitted, the default command
+   * encoder is finished and submitted in its place.
+   * @param additionalCommandBuffers Further finished command buffers, submitted after
+   * `commandBuffer` (or after the default encoder) in the same queue submission, in array order.
+   * Lets an application batch its own encoders with the default encoder without private API.
+   * All submitted command buffers are consumed (destroyed).
+   */
+  abstract submit(
+    commandBuffer?: CommandBuffer,
+    additionalCommandBuffers?: readonly CommandBuffer[]
+  ): void;
 
   // Resource creation
 
diff --git a/modules/core/test/adapter/resources/command-encoder.spec.ts b/modules/core/test/adapter/resources/command-encoder.spec.ts
index 416247124..8eec447e0 100644
--- a/modules/core/test/adapter/resources/command-encoder.spec.ts
+++ b/modules/core/test/adapter/resources/command-encoder.spec.ts
@@ -1164,3 +1164,32 @@ it('CommandEncoder.clearBuffer zeroes a buffer region', async () => {
     buffer.destroy();
   }
 });
+
+it('Device.submit submits the default encoder plus additional buffers', async () => {
+  for (const device of await getTestDevices(['webgl', 'webgpu', 'null'])) {
+    const buffer = device.createBuffer({
+      usage: Buffer.COPY_DST | Buffer.COPY_SRC | Buffer.STORAGE,
+      data: new Uint32Array([1, 2, 3, 4])
+    });
+    const beforeStats = getResourceStats(device);
+
+    // The default encoder's work runs first, then each additional buffer in array order.
+    device.commandEncoder.clearBuffer(buffer, 0, 8);
+    const secondEncoder = device.createCommandEncoder();
+    secondEncoder.clearBuffer(buffer, 4, 12);
+    const thirdEncoder = device.createCommandEncoder();
+    thirdEncoder.clearBuffer(buffer, 12, 4);
+    device.submit(undefined, [secondEncoder.finish(), thirdEncoder.finish()]);
+
+    expect(
+      Array.from(new Uint32Array((await buffer.readAsync()).slice().buffer)),
+      `${device.type} submit(undefined, [...]) runs the default encoder, then the extras`
+    ).toEqual([0, 0, 0, 0]);
+    expect(
+      getResourceStats(device).commandBuffersActive,
+      `${device.type} submit consumes the additional command buffers`
+    ).toBe(beforeStats.commandBuffersActive);
+
+    buffer.destroy();
+  }
+});
diff --git a/modules/test-utils/src/null-device/null-device.ts b/modules/test-utils/src/null-device/null-device.ts
index 6d54a8024..d678bca8c 100644
--- a/modules/test-utils/src/null-device/null-device.ts
+++ b/modules/test-utils/src/null-device/null-device.ts
@@ -160,7 +160,10 @@ export class NullDevice extends Device {
     return new NullCommandEncoder(this, props);
   }
 
-  submit(commandBuffer?: NullCommandBuffer): void {
+  submit(
+    commandBuffer?: NullCommandBuffer,
+    additionalCommandBuffers: readonly NullCommandBuffer[] = []
+  ): void {
     if (!commandBuffer) {
       commandBuffer = this.commandEncoder.finish();
       this.commandEncoder.destroy();
@@ -168,6 +171,9 @@ export class NullDevice extends Device {
     }
 
     commandBuffer.destroy();
+    for (const additionalCommandBuffer of additionalCommandBuffers) {
+      additionalCommandBuffer.destroy();
+    }
   }
 
   override writeBufferViaCommandEncoder(
diff --git a/modules/webgl/src/adapter/webgl-device.ts b/modules/webgl/src/adapter/webgl-device.ts
index cd172c7be..43223bdce 100644
--- a/modules/webgl/src/adapter/webgl-device.ts
+++ b/modules/webgl/src/adapter/webgl-device.ts
@@ -394,14 +394,20 @@ export class WebGLDevice extends Device {
    * https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext/commit
    * Chrome's offscreen canvas does not require gl.commit
    */
-  submit(commandBuffer?: WEBGLCommandBuffer): void {
+  submit(
+    commandBuffer?: WEBGLCommandBuffer,
+    additionalCommandBuffers: readonly WEBGLCommandBuffer[] = []
+  ): void {
     let submittedCommandEncoder: WEBGLCommandEncoder | null = null;
     if (!commandBuffer) {
       ({submittedCommandEncoder, commandBuffer} = this._finalizeDefaultCommandEncoderForSubmit());
     }
 
+    const allCommandBuffers = [commandBuffer, ...additionalCommandBuffers];
     try {
-      commandBuffer._executeCommands();
+      for (const submittedCommandBuffer of allCommandBuffers) {
+        submittedCommandBuffer._executeCommands();
+      }
 
       if (submittedCommandEncoder) {
         submittedCommandEncoder
@@ -412,7 +418,9 @@ export class WebGLDevice extends Device {
           .catch(() => {});
       }
     } finally {
-      commandBuffer.destroy();
+      for (const submittedCommandBuffer of allCommandBuffers) {
+        submittedCommandBuffer.destroy();
+      }
     }
   }
 
diff --git a/modules/webgpu/src/adapter/webgpu-device.ts b/modules/webgpu/src/adapter/webgpu-device.ts
index 133b13a28..0f276601e 100644
--- a/modules/webgpu/src/adapter/webgpu-device.ts
+++ b/modules/webgpu/src/adapter/webgpu-device.ts
@@ -380,7 +380,10 @@ export class WebGPUDevice extends Device {
     );
   }
 
-  submit(commandBuffer?: WebGPUCommandBuffer): void {
+  submit(
+    commandBuffer?: WebGPUCommandBuffer,
+    additionalCommandBuffers: readonly WebGPUCommandBuffer[] = []
+  ): void {
     let submittedCommandEncoder: WebGPUCommandEncoder | null = null;
     if (!commandBuffer) {
       ({submittedCommandEncoder, commandBuffer} = this._finalizeDefaultCommandEncoderForSubmit());
@@ -389,12 +392,15 @@ export class WebGPUDevice extends Device {
     const profiler = getWebGPUCpuHotspotProfiler(this);
     const startTime = profiler ? getTimestamp() : 0;
     const submitReason = getWebGPUCpuHotspotSubmitReason(this);
-    const transientUploadBuffers = commandBuffer.transientUploadBuffers;
+    const allCommandBuffers = [commandBuffer, ...additionalCommandBuffers];
+    const transientUploadBuffers = allCommandBuffers.flatMap(
+      commandBuffer_ => commandBuffer_.transientUploadBuffers
+    );
     let didSubmit = false;
     try {
       this.pushErrorScope('validation');
       const queueSubmitStartTime = profiler ? getTimestamp() : 0;
-      this.handle.queue.submit([commandBuffer.handle]);
+      this.handle.queue.submit(allCommandBuffers.map(commandBuffer_ => commandBuffer_.handle));
       didSubmit = true;
       if (profiler) {
         profiler.queueSubmitCount = (profiler.queueSubmitCount || 0) + 1;
@@ -458,7 +464,9 @@ export class WebGPUDevice extends Device {
         profiler[reasonTimeKey] = (profiler[reasonTimeKey] || 0) + (getTimestamp() - startTime);
       }
       const commandBufferDestroyStartTime = profiler ? getTimestamp() : 0;
-      commandBuffer.destroy();
+      for (const submittedCommandBuffer of allCommandBuffers) {
+        submittedCommandBuffer.destroy();
+      }
       if (profiler) {
         profiler.commandBufferDestroyCount = (profiler.commandBufferDestroyCount || 0) + 1;
         profiler.commandBufferDestroyTimeMs =
`````

Semantics: with `commandBuffer` omitted the default encoder is finished and goes first (as before), then the additional buffers in array order, all in one `queue.submit` on WebGPU (flushed one after another on WebGL, in the same order). Every submitted buffer is consumed (destroyed). The adapter's usual single validation scope around the submit is unchanged. Rigi keeps per-extra error-scope wrapping on its side.

### Test plan

- In the patch: `command-encoder.spec.ts` "Device.submit submits the default encoder plus additional buffers" over webgl, webgpu and null: the default encoder runs first, then each extra in order, and `commandBuffersActive` returns to its starting value (every submitted buffer consumed). Uses c1.
- Done here: null leg in node.
- Not run: webgl / webgpu legs (browser). Not measured: any submit-count or latency effect.

### PR description (luma template)

```markdown
For # (open an issue first per the template; none filed)

#### Background

Applications that build their own command encoders next to luma's default one (compute graphs, offscreen passes) can only batch them into one queue submission through private members.

#### Rationale

An optional second argument keeps `submit(commandBuffer?)` source compatible and makes ordering explicit: default encoder (or the given buffer) first, then the extras in array order. All of them are consumed, which matches what `submit` already does to its single buffer.

#### Change List

- `Device.submit(commandBuffer?, additionalCommandBuffers?)`
- WebGPU: one `queue.submit([...])`; WebGL and null: sequential flush; all buffers destroyed afterwards
- Spec over webgl, webgpu and null devices
```

## c3 `Buffer.mapAndReadAsync(..., {waitForSubmittedWork: false})`

Depends on #3330 (open) for the surrounding `WebGPUBuffer.readAsync` code.

### Problem

`mapAndReadAsync` awaits `device.queue.onSubmittedWorkDone()` before mapping. For a ring of `MAP_READ` staging slots that is more than needed: `mapAsync` on the slot resolves when the work that uses the slot is done, and waiting for the whole queue makes a read also wait for everything submitted after it (in Rigi: horizon chunk c's read waits for chunk c+1).

### Minimal repro

Submit a copy into a `MAP_READ` slot, then a long compute submission; `await slot.mapAndReadAsync(cb)` resolves only after the long submission finishes. With `{waitForSubmittedWork: false}` it resolves when the copy is done. (Not measured in luma; the Rigi behaviour is described in the comment on `stageReads` in `src/lib/gpu/core/readback.ts`.)

### Proposed patch

`patches/c3-map-and-read-no-wait.patch` (173 lines, `git am` format, authored as the owner).

`````diff
From b1acc635d2edc6ff5a1716b5188f93a819565a16 Mon Sep 17 00:00:00 2001
From: Robert Christie <rgcgeog@gmail.com>
Date: Fri, 2 Oct 2026 14:52:40 -0400
Subject: [PATCH] feat(webgpu): Buffer.mapAndReadAsync option
 waitForSubmittedWork: false

mapAndReadAsync(callback, byteOffset?, byteLength?, options?) takes {waitForSubmittedWork?: boolean} (default true). false skips the queue.onSubmittedWorkDone() wait and maps at once, for MAP_READ readback rings. Depends on #3330.
---
 modules/core/src/adapter/resources/buffer.ts  | 15 +++++++++++++-
 modules/core/src/index.ts                     |  7 ++++++-
 .../test/adapter/resources/buffer.spec.ts     | 20 +++++++++++++++++++
 .../src/dynamic-buffer/dynamic-buffer.ts      | 14 ++++++++++---
 .../src/adapter/resources/webgpu-buffer.ts    | 15 +++++++++++---
 5 files changed, 63 insertions(+), 8 deletions(-)

diff --git a/modules/core/src/adapter/resources/buffer.ts b/modules/core/src/adapter/resources/buffer.ts
index 0067fd378..987abdf38 100644
--- a/modules/core/src/adapter/resources/buffer.ts
+++ b/modules/core/src/adapter/resources/buffer.ts
@@ -5,6 +5,18 @@
 import type {Device} from '../device';
 import {Resource, ResourceProps} from './resource';
 
+/** Options for Buffer.mapAndReadAsync */
+export type BufferMapReadOptions = {
+  /**
+   * WebGPU only. When `true` (default), the read first awaits `queue.onSubmittedWorkDone()`, so it
+   * also waits for work submitted after the work that wrote this buffer. Set to `false` to map at
+   * once: `mapAsync` resolves when the work already submitted that uses the buffer is done. Use it
+   * when you know the producing work has been submitted (e.g. a ring of MAP_READ readback slots).
+   * @defaultValue true
+   */
+  waitForSubmittedWork?: boolean;
+};
+
 /** Callback for Buffer.mapAndReadAsync */
 export type BufferMapCallback<T> = (arrayBuffer: ArrayBuffer, lifetime: 'mapped' | 'copied') => T;
 
@@ -110,7 +122,8 @@ export abstract class Buffer extends Resource<BufferProps> {
   abstract mapAndReadAsync<T>(
     onMapped: BufferMapCallback<T>,
     byteOffset?: number,
-    byteLength?: number
+    byteLength?: number,
+    options?: BufferMapReadOptions
   ): Promise<T>;
 
   /** Read data synchronously. @note WebGL2 only */
diff --git a/modules/core/src/index.ts b/modules/core/src/index.ts
index f34bad870..c66ba4dd9 100644
--- a/modules/core/src/index.ts
+++ b/modules/core/src/index.ts
@@ -30,7 +30,12 @@ export {PresentationContext} from './adapter/presentation-context';
 // GPU RESOURCES
 export {Resource, type ResourceProps} from './adapter/resources/resource';
 
-export {Buffer, type BufferProps, type BufferMapCallback} from './adapter/resources/buffer';
+export {
+  Buffer,
+  type BufferProps,
+  type BufferMapCallback,
+  type BufferMapReadOptions
+} from './adapter/resources/buffer';
 
 export {Texture, type TextureProps} from './adapter/resources/texture';
 
diff --git a/modules/core/test/adapter/resources/buffer.spec.ts b/modules/core/test/adapter/resources/buffer.spec.ts
index d99016ca5..9d99c2eed 100644
--- a/modules/core/test/adapter/resources/buffer.spec.ts
+++ b/modules/core/test/adapter/resources/buffer.spec.ts
@@ -778,3 +778,23 @@ it('Buffer#uint8 index buffer conversion', async () => {
   }
   void 0;
 });
+
+it('Buffer#mapAndReadAsync (waitForSubmittedWork: false)', async () => {
+  for (const device of await getTestDevices(DEVICE_TYPES)) {
+    const buffer = device.createBuffer({
+      usage: Buffer.MAP_READ | Buffer.COPY_DST,
+      data: new Uint32Array([5, 6, 7, 8])
+    });
+    // Work already submitted (the creation upload) is visible without the extra wait.
+    const values = await buffer.mapAndReadAsync(
+      arrayBuffer => Array.from(new Uint32Array(arrayBuffer.slice(0))),
+      0,
+      16,
+      {waitForSubmittedWork: false}
+    );
+    expect(values, `${device.type} mapAndReadAsync without waiting reads the data`).toEqual([
+      5, 6, 7, 8
+    ]);
+    buffer.destroy();
+  }
+});
diff --git a/modules/engine/src/dynamic-buffer/dynamic-buffer.ts b/modules/engine/src/dynamic-buffer/dynamic-buffer.ts
index 250446d42..5029b0d6a 100644
--- a/modules/engine/src/dynamic-buffer/dynamic-buffer.ts
+++ b/modules/engine/src/dynamic-buffer/dynamic-buffer.ts
@@ -2,7 +2,13 @@
 // SPDX-License-Identifier: MIT
 // SPDX-FileCopyrightText: Copyright (c) vis.gl contributors
 
-import type {BufferMapCallback, BufferProps, Device, Binding as CoreBinding} from '@luma.gl/core';
+import type {
+  BufferMapCallback,
+  BufferMapReadOptions,
+  BufferProps,
+  Device,
+  Binding as CoreBinding
+} from '@luma.gl/core';
 import {Buffer} from '@luma.gl/core';
 import {uid} from '../utils/uid';
 
@@ -233,7 +239,8 @@ export class DynamicBuffer {
   async mapAndReadAsync<T>(
     callback: BufferMapCallback<T>,
     byteOffset: number = 0,
-    byteLength: number = this.byteLength - byteOffset
+    byteLength: number = this.byteLength - byteOffset,
+    options?: BufferMapReadOptions
   ): Promise<T> {
     let copiedBytes: Uint8Array | null = null;
     const result = await this._buffer.mapAndReadAsync(
@@ -242,7 +249,8 @@ export class DynamicBuffer {
         return await callback(arrayBuffer, lifetime);
       },
       byteOffset,
-      byteLength
+      byteLength,
+      options
     );
     if (copiedBytes && this._writeDebugData(copiedBytes, byteOffset)) {
       this._touch();
diff --git a/modules/webgpu/src/adapter/resources/webgpu-buffer.ts b/modules/webgpu/src/adapter/resources/webgpu-buffer.ts
index 45d17a6e7..f787e9de5 100644
--- a/modules/webgpu/src/adapter/resources/webgpu-buffer.ts
+++ b/modules/webgpu/src/adapter/resources/webgpu-buffer.ts
@@ -2,7 +2,13 @@
 // SPDX-License-Identifier: MIT
 // SPDX-FileCopyrightText: Copyright (c) vis.gl contributors
 
-import {log, Buffer, type BufferProps, type BufferMapCallback} from '@luma.gl/core';
+import {
+  log,
+  Buffer,
+  type BufferProps,
+  type BufferMapCallback,
+  type BufferMapReadOptions
+} from '@luma.gl/core';
 import {type WebGPUDevice} from '../webgpu-device';
 
 /**
@@ -166,7 +172,8 @@ export class WebGPUBuffer extends Buffer {
   async mapAndReadAsync<T>(
     callback: BufferMapCallback<T>,
     byteOffset = 0,
-    byteLength = this.byteLength - byteOffset
+    byteLength = this.byteLength - byteOffset,
+    options?: BufferMapReadOptions
   ): Promise<T> {
     const requestedEnd = byteOffset + byteLength;
     if (requestedEnd > this.byteLength) {
@@ -203,7 +210,9 @@ export class WebGPUBuffer extends Buffer {
     // Map the temp buffer and read the data.
     this.device.pushErrorScope('validation');
     try {
-      await this.device.handle.queue.onSubmittedWorkDone();
+      if (options?.waitForSubmittedWork !== false) {
+        await this.device.handle.queue.onSubmittedWorkDone();
+      }
       if (mappableBuffer) {
         mappableBuffer._copyBuffer(this, mappedByteOffset, mappedByteLength, 0);
       }
`````

Option `type BufferMapReadOptions = {waitForSubmittedWork?: boolean}`, default `true` (old behaviour). WebGL and the null device ignore it. `DynamicBuffer.mapAndReadAsync` forwards it. For a non-`MAP_READ` buffer the staging copy is still submitted first, so ordering stays correct.

### Test plan

- In the patch: `buffer.spec.ts` (all devices) checks that a read with the option returns the data. It cannot observe whether the wait was skipped, and nothing tests that; the claim rests on the code path (`waitForSubmittedWork !== false` guards the `onSubmittedWorkDone()` await). Null device leg runs in node.
- Done here: null leg in node.
- Not run: browser legs. Not measured: latency gain.

### PR description (luma template)

```markdown
For # (open an issue first per the template; none filed)

#### Background

`Buffer.mapAndReadAsync` waits for `queue.onSubmittedWorkDone()` before it maps, which delays a readback by all work submitted after the readback's own copy.

#### Rationale

Mapping a `MAP_READ` buffer already waits for the work that uses it. An opt-out keeps the default behaviour and lets readback rings read as soon as their own copy finished.

#### Change List

- `BufferMapReadOptions.waitForSubmittedWork` (default `true`) on `mapAndReadAsync`
- WebGPU honours it, WebGL and null ignore it, `DynamicBuffer` forwards it
```

## c4 `Buffer.readAsync(byteOffset?, byteLength?, {target?})`

Depends on c3 (shares `BufferMapReadOptions`) and therefore on #3330.

### Problem

`readAsync` always allocates a new `Uint8Array`. Per-frame readbacks (picking, counters, small tables) churn the allocator; WebGL can write straight into a caller array (`getBufferSubData`) and WebGPU can copy the mapped range into one.

### Minimal repro

```ts
const target = new Uint8Array(16);
const bytes = await buffer.readAsync(0, 16, {target}); // option ignored on master: bytes is a new array
```

### Proposed patch

`patches/c4-read-async-target.patch` (351 lines, `git am` format, authored as the owner). Too long to inline; the diffstat is:

```
 modules/core/src/adapter/resources/buffer.ts  | 42 ++++++++++++++++++-
 modules/core/src/index.ts                     |  4 +-
 .../test/adapter/resources/buffer.spec.ts     | 42 +++++++++++++++++++
 .../src/dynamic-buffer/dynamic-buffer.ts      |  7 +++-
 .../src/null-device/resources/null-buffer.ts  | 21 ++++++++--
 .../null-buffer-read-target.spec.ts           | 37 ++++++++++++++++
 .../src/adapter/resources/webgl-buffer.ts     | 23 +++++++---
 .../src/adapter/resources/webgpu-buffer.ts    | 20 +++++++--
 8 files changed, 179 insertions(+), 17 deletions(-)
```

`BufferReadOptions = BufferMapReadOptions & {target?: ArrayBufferView<ArrayBuffer>}`. With a `target` the bytes are copied into it (from its `byteOffset`) and the result is a `Uint8Array` over exactly those bytes of `target`. A too-small target throws a `RangeError` before mapping on WebGPU, so the buffer is not left mapped. Exported helper `getBufferReadTarget` for backends. Anyone subclassing `Buffer` outside luma should accept the third argument.

### Test plan

- In the patch: `buffer.spec.ts` (all devices) and `null-buffer-read-target.spec.ts` (node).
- Done here: node leg. Not run: browser legs.

### PR description (luma template)

```markdown
For # (open an issue first per the template; none filed)

#### Background

`Buffer.readAsync` allocates a result array on every call.

#### Rationale

Callers that read the same small region every frame can supply the destination. WebGL writes into it directly and WebGPU copies the mapped range into it, so no per-call array is created.

#### Change List

- `BufferReadOptions` (`BufferMapReadOptions` plus `target`) for `readAsync`
- WebGL, WebGPU, null and `DynamicBuffer` implementations; `RangeError` for a too-small target
- Export `getBufferReadTarget` for backend implementations
```

## Verification run for this packet

With all packets applied together on the base (plus `#3330` merged for c3/c4): `yarn vitest run --project node modules/core modules/webgpu modules/webgl modules/test-utils modules/gpgpu modules/engine` gave 158 files passed, 1 skipped; 1392 tests passed, 7 skipped; `biome check` on every touched `.ts` file: 0 errors, 29 warnings (the same 29 on the unpatched base). Browser-tier specs (`*.spec.ts` without `.node`) were not run, no browser here. Root `tsc --noEmit` prints about 3,650 errors on the unpatched base (the luma workspace is not built here); none of the patches adds an error outside the spec mocks that already fail the same way.

The four patches were rebuilt for this packet from the vendored rigi.6 commits: c1 and c3 applied unchanged to current master, c2 needed one hand merge (`WebGLDevice.submit` now calls `_executeCommands()` where the patch said `flushCommands()`), c4 applies after c3.

## Notes

- Vendored patches that disappear: `luma-clear-buffer-1998d244.patch` (c1), `luma-device-submit-2f870ee8.patch` (c2), `luma-map-read-no-wait-5727c7ca.patch` (c3), `luma-read-into-target-96133134.patch` (c4). c3 and c4 also need #3330 in the build (it is a vendored PR head).
- App code that can use them with no change in behaviour: `core/pool.ts` `clear()`, `core/queue.ts` `submitWithDefault`, `core/readback.ts`.
- Not covered by this packet but in the same family and vendored: `luma-render-bundle-msaa-4cf1099c.patch` (tiny, `RenderBundleEncoderProps.sampleCount`), `luma-stream-read-2010d9f0.patch` (WebGL `STREAM_READ` hint), `luma-webgl-msaa-resolve-a6af71e5.patch` (575 lines), `luma-compute-hash-c80b7ce6.patch` (pipeline cache hash). Candidates for a next batch.
