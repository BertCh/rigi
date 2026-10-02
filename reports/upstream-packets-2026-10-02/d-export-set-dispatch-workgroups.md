# (d) Export `setGPUComputeDispatchWorkgroups` from `@luma.gl/gpgpu/gpu-core`

Status: **local packet, nothing posted** (owner decides). Rank 3 of 11 in [README.md](README.md). Base: luma master `00aab0f91` (2026-10-02, "fix(examples): refine architectural charcoal strokes (#3349)").

Kind: export. Size: 2 files, +25. Depends on nothing.

## Title

`feat(gpgpu): export setGPUComputeDispatchWorkgroups from gpu-core`

## Problem

`setGPUComputeDispatchWorkgroups(node, [x, y, z])` annotates a compute command node with the direct dispatch geometry its encode callback emits; `GPUProgram` lowering uses that annotation to put the node under a GPU predicate (an indirect dispatch gate). All gpgpu operations use it, but it is not exported from `@luma.gl/gpgpu/gpu-core`, so application-defined nodes cannot take part: Rigi's `ComputeGraph` (`src/lib/gpu/core/graph.ts`) re-implements the validation and writes the `dispatchWorkgroups` field by hand, with a comment that the setter "is not exported from `@luma.gl/gpgpu/gpu-core`".

## Minimal repro

```ts
import {setGPUComputeDispatchWorkgroups} from '@luma.gl/gpgpu/gpu-core'; // not exported on master
```

## Proposed patch

`patches/d-export-dispatch-workgroups.patch` (57 lines, `git am` format, authored as the owner).

`````diff
From a78642d5844022bc3f3cab976b4a19dc4b437f7c Mon Sep 17 00:00:00 2001
From: Robert Christie <rgcgeog@gmail.com>
Date: Fri, 2 Oct 2026 15:00:03 -0400
Subject: [PATCH] feat(gpgpu): export setGPUComputeDispatchWorkgroups from
 gpu-core

Application-defined command nodes can annotate their direct dispatch geometry the same way gpgpu operations do, so GPUProgram lowering can put them under a GPU predicate. Also exports the GPUComputeDispatchWorkgroups type.
---
 modules/gpgpu/src/gpu-core/index.ts           |  2 ++
 ...gpu-command-dispatch-metadata.node.spec.ts | 25 +++++++++++++++++++
 2 files changed, 27 insertions(+)
 create mode 100644 modules/gpgpu/test/gpu-core/gpu-command-dispatch-metadata.node.spec.ts

diff --git a/modules/gpgpu/src/gpu-core/index.ts b/modules/gpgpu/src/gpu-core/index.ts
index 3594c1779..13a917d41 100644
--- a/modules/gpgpu/src/gpu-core/index.ts
+++ b/modules/gpgpu/src/gpu-core/index.ts
@@ -123,6 +123,8 @@ export type {
   GraphDataViewBinding,
   GraphDataViewBindingRange
 } from './graph-data-view-utils';
+export {setGPUComputeDispatchWorkgroups} from './gpu-command-dispatch-metadata';
+export type {GPUComputeDispatchWorkgroups} from './gpu-command-dispatch-metadata';
 export {
   getBoundedDispatchLayout,
   getBoundedInvocationIndexSource,
diff --git a/modules/gpgpu/test/gpu-core/gpu-command-dispatch-metadata.node.spec.ts b/modules/gpgpu/test/gpu-core/gpu-command-dispatch-metadata.node.spec.ts
new file mode 100644
index 000000000..f7574f727
--- /dev/null
+++ b/modules/gpgpu/test/gpu-core/gpu-command-dispatch-metadata.node.spec.ts
@@ -0,0 +1,25 @@
+// luma.gl
+// SPDX-License-Identifier: MIT
+// SPDX-FileCopyrightText: Copyright (c) vis.gl contributors
+
+import {expect, it} from 'vitest';
+import {setGPUComputeDispatchWorkgroups} from '@luma.gl/gpgpu/gpu-core';
+
+it('setGPUComputeDispatchWorkgroups is exported from gpu-core and annotates a node copy', () => {
+  const node = {id: 'node'};
+  const annotated = setGPUComputeDispatchWorkgroups(node, [4, 2, 1]);
+  expect(annotated).not.toBe(node);
+  expect(annotated).toMatchObject({id: 'node', dispatchWorkgroups: [4, 2, 1]});
+  expect(Object.isFrozen((annotated as {dispatchWorkgroups: unknown}).dispatchWorkgroups)).toBe(
+    true
+  );
+  expect('dispatchWorkgroups' in node).toBe(false);
+});
+
+it('setGPUComputeDispatchWorkgroups rejects negative and non-integer counts', () => {
+  expect(() => setGPUComputeDispatchWorkgroups({}, [-1, 1, 1])).toThrow(/x workgroup count/);
+  expect(() => setGPUComputeDispatchWorkgroups({}, [1, 1.5, 1])).toThrow(/y workgroup count/);
+  expect(() => setGPUComputeDispatchWorkgroups({}, [1, 1, Number.NaN])).toThrow(
+    /z workgroup count/
+  );
+});
`````

`getGPUComputeDispatchWorkgroups` stays `@internal` and unexported.

## Test plan

- In the patch: `gpu-command-dispatch-metadata.node.spec.ts` imports the setter through the public subpath, checks it returns a copy with a frozen `dispatchWorkgroups`, leaves the input untouched, and rejects negative, fractional and NaN counts.
- Done here: that spec passes in node (`yarn vitest run --project node modules/gpgpu/test/gpu-core/gpu-command-dispatch-metadata.node.spec.ts`).

## Verification run for this packet

With all packets applied together on the base (plus `#3330` merged for c3/c4): `yarn vitest run --project node modules/core modules/webgpu modules/webgl modules/test-utils modules/gpgpu modules/engine` gave 158 files passed, 1 skipped; 1392 tests passed, 7 skipped; `biome check` on every touched `.ts` file: 0 errors, 29 warnings (the same 29 on the unpatched base). Browser-tier specs (`*.spec.ts` without `.node`) were not run, no browser here. Root `tsc --noEmit` prints about 3,650 errors on the unpatched base (the luma workspace is not built here); none of the patches adds an error outside the spec mocks that already fail the same way.

## PR description (luma template)

```markdown
For # (none; trivial export)

#### Background

The helper that records a compute node's direct dispatch geometry, which GPU-predicate lowering needs, is public API in effect (every gpgpu operation calls it) but is missing from the `gpu-core` index.

#### Rationale

Application nodes should be able to opt in to the same lowering as built-in operations without private imports or copies of its validation.

#### Change List

- Export `setGPUComputeDispatchWorkgroups` and the `GPUComputeDispatchWorkgroups` type from `gpu-core`
- Node spec through the public subpath
```

## Notes

- Vendored patch that disappears: none. App code that shrinks: the hand-written validation block in `ComputeGraph.addKernel` (`src/lib/gpu/core/graph.ts`); it also differs in one behaviour (it skips the annotation on invalid values instead of throwing), which the migration would have to decide.
- Risk: none beyond committing to the name and signature as public API.
