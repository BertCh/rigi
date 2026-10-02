# (g) Error scopes without `debug`: `debugGPUErrorScopes`

Status: **local packet, nothing posted** (owner decides). Rank 7 of 11 in [README.md](README.md). Base: luma master `00aab0f91` (2026-10-02, "fix(examples): refine architectural charcoal strokes (#3349)").

Kind: small feature. Size: 4 files, +about 70. Depends on nothing.

## Title

`feat(webgpu): debugGPUErrorScopes device prop enables error scopes without debug`

## Problem

`WebGPUDevice.pushErrorScope()` / `popErrorScope()` are public, but return immediately unless `props.debug` is true, and luma's own validation scopes (around submits, passes, shader and resource creation) are gated the same way. An application that wants WebGPU validation and out-of-memory errors reported from its own submits cannot get them without turning on all of `debug` (debugger breaks via `device.debug()`, the debug UI path, extra checks). The public `pushErrorScope` silently doing nothing is easy to trip over: `popErrorScope`'s handler is simply never called.

Rigi opens native scopes on the raw `device.handle` for this (`src/lib/gpu/core/queue.ts` `openErrorScopes`), with a comment about luma's methods being no-ops without `debug`.

There is precedent for the shape of the fix: `debugGPUTime` turns on timestamp collection "without enabling all debug validation paths".

## Minimal repro

```ts
const device = await luma.createDevice({type: 'webgpu', adapters: [webgpuAdapter] /* debug left off */});
device.pushErrorScope('validation');
// ... a call that produces a validation error ...
await device.popErrorScope(error => console.log('never called on master', error));
```

## Proposed patch

`patches/g-error-scopes-without-debug.patch` (130 lines, `git am` format, authored as the owner).

`````diff
From aa514f20df91a2a0423c06523f3778ddb77e1747 Mon Sep 17 00:00:00 2001
From: Robert Christie <rgcgeog@gmail.com>
Date: Fri, 2 Oct 2026 15:00:03 -0400
Subject: [PATCH] feat(webgpu): debugGPUErrorScopes device prop enables error
 scopes without debug

WebGPUDevice.pushErrorScope() / popErrorScope() and the validation scopes luma wraps around submits, passes and resource creation are no-ops unless debug is true. debugGPUErrorScopes turns them on without the other debug behaviour, like debugGPUTime does for timestamps.
---
 modules/core/src/adapter/device-defaults.ts   |  1 +
 modules/core/src/adapter/device.ts            |  6 +++
 modules/webgpu/src/adapter/webgpu-device.ts   |  9 +++-
 .../adapter/webgpu-error-scopes.node.spec.ts  | 52 +++++++++++++++++++
 4 files changed, 66 insertions(+), 2 deletions(-)
 create mode 100644 modules/webgpu/test/adapter/webgpu-error-scopes.node.spec.ts

diff --git a/modules/core/src/adapter/device-defaults.ts b/modules/core/src/adapter/device-defaults.ts
index 3caf23605..4cd58f6f3 100644
--- a/modules/core/src/adapter/device-defaults.ts
+++ b/modules/core/src/adapter/device-defaults.ts
@@ -36,6 +36,7 @@ export const DEVICE_DEFAULT_PROPS: Required<DeviceProps> = {
   // Debug flags
   debug: getDefaultDebugValue(),
   debugGPUTime: false,
+  debugGPUErrorScopes: false,
   debugShaders: log.get('debug-shaders') || undefined!,
   debugFramebuffers: Boolean(log.get('debug-framebuffers')),
   debugFactories: Boolean(log.get('debug-factories')),
diff --git a/modules/core/src/adapter/device.ts b/modules/core/src/adapter/device.ts
index 5aa2863fc..ce5f37c90 100644
--- a/modules/core/src/adapter/device.ts
+++ b/modules/core/src/adapter/device.ts
@@ -435,6 +435,12 @@ export type DeviceProps = {
   debug?: boolean;
   /** Enable GPU timestamp collection without enabling all debug validation paths. */
   debugGPUTime?: boolean;
+  /**
+   * Wrap WebGPU submissions, passes and resource creation in validation error scopes (and make
+   * `WebGPUDevice.pushErrorScope()` / `popErrorScope()` active) without enabling all debug paths.
+   * `debug: true` implies it.
+   */
+  debugGPUErrorScopes?: boolean;
   /** Show shader source in browser? The default is `'error'`, meaning that logs are shown when shader compilation has errors */
   debugShaders?: 'never' | 'errors' | 'warnings' | 'always';
   /** Renders a small version of updated Framebuffers into the primary canvas context. Can be set in console luma.log.set('debug-framebuffers', true) */
diff --git a/modules/webgpu/src/adapter/webgpu-device.ts b/modules/webgpu/src/adapter/webgpu-device.ts
index 133b13a28..93714fd0a 100644
--- a/modules/webgpu/src/adapter/webgpu-device.ts
+++ b/modules/webgpu/src/adapter/webgpu-device.ts
@@ -496,8 +496,13 @@ export class WebGPUDevice extends Device {
 
   // WebGPU specific
 
+  /** Error scopes are active in debug mode or when `debugGPUErrorScopes` is set. */
+  private _isErrorScopeEnabled(): boolean {
+    return Boolean(this.props.debug || this.props.debugGPUErrorScopes);
+  }
+
   pushErrorScope(scope: 'validation' | 'out-of-memory'): void {
-    if (!this.props.debug) {
+    if (!this._isErrorScopeEnabled()) {
       return;
     }
     const profiler = getWebGPUCpuHotspotProfiler(this);
@@ -510,7 +515,7 @@ export class WebGPUDevice extends Device {
   }
 
   popErrorScope(handler: (error: GPUError) => void): Promise<void> {
-    if (!this.props.debug) {
+    if (!this._isErrorScopeEnabled()) {
       return Promise.resolve();
     }
     const profiler = getWebGPUCpuHotspotProfiler(this);
diff --git a/modules/webgpu/test/adapter/webgpu-error-scopes.node.spec.ts b/modules/webgpu/test/adapter/webgpu-error-scopes.node.spec.ts
new file mode 100644
index 000000000..6d90c4e02
--- /dev/null
+++ b/modules/webgpu/test/adapter/webgpu-error-scopes.node.spec.ts
@@ -0,0 +1,52 @@
+// luma.gl
+// SPDX-License-Identifier: MIT
+// SPDX-FileCopyrightText: Copyright (c) vis.gl contributors
+
+import {describe, expect, test, vi} from 'vitest';
+import {WebGPUDevice} from '../../src/adapter/webgpu-device';
+
+/** A WebGPUDevice shell with a recording native handle; no GPU is involved. */
+function makeDevice(props: {debug?: boolean; debugGPUErrorScopes?: boolean}) {
+  const handle = {
+    pushErrorScope: vi.fn(),
+    popErrorScope: vi.fn(async () => ({message: 'boom'}) as unknown as GPUError)
+  };
+  const device = Object.create(WebGPUDevice.prototype) as WebGPUDevice;
+  Object.assign(device, {
+    props,
+    handle,
+    _moduleData: {},
+    userData: {},
+    reportError: () => () => {},
+    debug: () => {}
+  });
+  return {device, handle};
+}
+
+describe('WebGPUDevice error scopes', () => {
+  test('are inactive by default', async () => {
+    const {device, handle} = makeDevice({});
+    device.pushErrorScope('validation');
+    const handler = vi.fn();
+    await device.popErrorScope(handler);
+    expect(handle.pushErrorScope).not.toHaveBeenCalled();
+    expect(handle.popErrorScope).not.toHaveBeenCalled();
+    expect(handler).not.toHaveBeenCalled();
+  });
+
+  test('are active with debugGPUErrorScopes alone', async () => {
+    const {device, handle} = makeDevice({debugGPUErrorScopes: true});
+    device.pushErrorScope('validation');
+    const handler = vi.fn();
+    await device.popErrorScope(handler);
+    expect(handle.pushErrorScope).toHaveBeenCalledWith('validation');
+    expect(handle.popErrorScope).toHaveBeenCalledOnce();
+    expect(handler).toHaveBeenCalledWith(expect.objectContaining({message: 'boom'}));
+  });
+
+  test('stay active with debug: true', () => {
+    const {device, handle} = makeDevice({debug: true});
+    device.pushErrorScope('out-of-memory');
+    expect(handle.pushErrorScope).toHaveBeenCalledWith('out-of-memory');
+  });
+});
`````

## Test plan

- In the patch: `webgpu-error-scopes.node.spec.ts` (node, no GPU: a `WebGPUDevice` shell with a recording native handle): scopes inactive by default, active with `debugGPUErrorScopes` alone (push forwarded, pop forwarded, handler called with the error), still active with `debug: true`. Verified here that the second case fails without the source change.
- Done here: that spec and `yarn vitest run --project node modules/core modules/webgpu modules/webgl modules/test-utils modules/gpgpu modules/engine`.
- Not run: a real device producing a real validation error (browser). Not measured: the per-submit cost of the extra scopes (luma's CPU hotspot profiler already counts them, `errorScopePushCount`).

## Verification run for this packet

With all packets applied together on the base (plus `#3330` merged for c3/c4): `yarn vitest run --project node modules/core modules/webgpu modules/webgl modules/test-utils modules/gpgpu modules/engine` gave 158 files passed, 1 skipped; 1392 tests passed, 7 skipped; `biome check` on every touched `.ts` file: 0 errors, 29 warnings (the same 29 on the unpatched base). Browser-tier specs (`*.spec.ts` without `.node`) were not run, no browser here. Root `tsc --noEmit` prints about 3,650 errors on the unpatched base (the luma workspace is not built here); none of the patches adds an error outside the spec mocks that already fail the same way.

## PR description (luma template)

```markdown
For # (open an issue first per the template; none filed)

#### Background

`WebGPUDevice.pushErrorScope()` / `popErrorScope()` and luma's internal validation scopes do nothing unless the device was created with `debug: true`, which also enables breakpoints and other checks. Applications cannot ask for just the error reporting.

#### Rationale

A dedicated prop follows the existing `debugGPUTime` precedent, keeps the default unchanged, and keeps `debug: true` implying it. The alternative (making the public methods unconditional and gating only luma's internal use) touches about fifteen call sites and changes what existing code observes.

#### Change List

- `DeviceProps.debugGPUErrorScopes` (default `false`) and its default
- `WebGPUDevice` push / pop check `debug || debugGPUErrorScopes`
- Node spec
```

## Notes

- Vendored patch that disappears: none. App code that shrinks: `openErrorScopes` could be built on the public `pushErrorScope('out-of-memory')`, `pushErrorScope('validation')` and two `popErrorScope(handler)` calls once the Rigi device is created with the prop under its checks flag (`__RIGI_GPU_CHECKS__`), instead of the raw handle. With the prop on, luma's own scopes around each submit add to Rigi's, so Rigi would only set it in checked runs, as now.
- Risk: low. Behaviour with the prop off is identical.
