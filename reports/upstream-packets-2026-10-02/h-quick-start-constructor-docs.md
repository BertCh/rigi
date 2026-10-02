# (h) Quick-start docs: `new GPUCommandGraph({device, id})` vs the real constructor `(device, props)`

Status: **local packet, nothing posted** (owner decides). Rank 4 of 11 in [README.md](README.md). Base: luma master `00aab0f91` (2026-10-02, "fix(examples): refine architectural charcoal strokes (#3349)").

Kind: docs. Size: 3 files, 3 lines. Depends on nothing.

## Title

`docs(gpgpu): GPUCommandGraph constructor takes (device, props) in the quick starts`

## Problem

Three experimental API pages start with `const graph = new GPUCommandGraph({device, id: '...'});`. The constructor is `constructor(device: Device, props: {id?: string; autotuner?: ...} = {})` (`modules/gpgpu/src/gpu-core/gpu-command-graph.ts`), so the snippet passes an object where the device belongs and throws "GPUCommandGraph requires a WebGPU device". Found by Rigi while writing against the gpu-raster quick start.

The affected pages: `docs/api-reference/experimental/gpu-graph.md`, `gpu-dataframe.md`, `gpu-raster/README.md`.

## Minimal repro

Copy the quick start into a project: `new GPUCommandGraph({device, id: 'raster-analysis'})` throws on the first line (`device.type` of a plain object is not `'webgpu'`).

## Proposed patch

`patches/h-quick-start-ctor-docs.patch` (52 lines, `git am` format, authored as the owner).

`````diff
From 90ff6759d75d39ca75c8ac917eb690673e9e0317 Mon Sep 17 00:00:00 2001
From: Robert Christie <rgcgeog@gmail.com>
Date: Fri, 2 Oct 2026 14:45:59 -0400
Subject: [PATCH] docs(gpgpu): GPUCommandGraph constructor takes (device,
 props) in the quick starts

The gpu-graph, gpu-dataframe and gpu-raster quick starts called new GPUCommandGraph({device, id}); the constructor is (device, props).
---
 docs/api-reference/experimental/gpu-dataframe.md     | 2 +-
 docs/api-reference/experimental/gpu-graph.md         | 2 +-
 docs/api-reference/experimental/gpu-raster/README.md | 2 +-
 3 files changed, 3 insertions(+), 3 deletions(-)

diff --git a/docs/api-reference/experimental/gpu-dataframe.md b/docs/api-reference/experimental/gpu-dataframe.md
index 09c8c2f17..decb54bf4 100644
--- a/docs/api-reference/experimental/gpu-dataframe.md
+++ b/docs/api-reference/experimental/gpu-dataframe.md
@@ -24,7 +24,7 @@ implicit downloads.
 import {GPUCommandGraph} from '@luma.gl/gpgpu/gpu-core';
 import {GPUDataFrame} from '@luma.gl/experimental/gpu-dataframe';
 
-const graph = new GPUCommandGraph({device, id: 'dataframe-analysis'});
+const graph = new GPUCommandGraph(device, {id: 'dataframe-analysis'});
 const frame = new GPUDataFrame({device, graph, table});
 const filtered = frame.filter({column: 'duration', greaterThan: 10});
 
diff --git a/docs/api-reference/experimental/gpu-graph.md b/docs/api-reference/experimental/gpu-graph.md
index 88a8d8cbb..c88200ccd 100644
--- a/docs/api-reference/experimental/gpu-graph.md
+++ b/docs/api-reference/experimental/gpu-graph.md
@@ -26,7 +26,7 @@ algorithm whose result is immediately needed on the CPU, a CPU graph library may
 import {GPUCommandGraph} from '@luma.gl/gpgpu/gpu-core';
 import {GPUGraph, GPUGraphPageRank, GPUGraphTopology} from '@luma.gl/gpgpu/gpu-graph';
 
-const graph = new GPUCommandGraph({device, id: 'graph-analysis'});
+const graph = new GPUCommandGraph(device, {id: 'graph-analysis'});
 const topology = new GPUGraphTopology({device, graph, edges, vertexCount});
 const pageRank = new GPUGraphPageRank({device, graph, topology});
 
diff --git a/docs/api-reference/experimental/gpu-raster/README.md b/docs/api-reference/experimental/gpu-raster/README.md
index 679a49df0..14f507c15 100644
--- a/docs/api-reference/experimental/gpu-raster/README.md
+++ b/docs/api-reference/experimental/gpu-raster/README.md
@@ -24,7 +24,7 @@ analytical values usually belong in a renderer or shader module instead.
 import {GPUCommandGraph} from '@luma.gl/gpgpu/gpu-core';
 import {GPURasterBand, GPURasterStatistics} from '@luma.gl/experimental/gpu-raster';
 
-const graph = new GPUCommandGraph({device, id: 'raster-analysis'});
+const graph = new GPUCommandGraph(device, {id: 'raster-analysis'});
 const band = new GPURasterBand({device, graph, values, validity, width, height});
 const statistics = new GPURasterStatistics({device, graph, band});
`````

## Test plan

Docs only. Checked that the constructor signature is as stated and that no other `GPUCommandGraph({` call with an object first argument exists under `docs/`, `modules/`, `examples/`, `dev-docs/` or `website/src` at the base.

## Related doc problems found, NOT fixed in this patch

The same three quick starts are pseudo-code in other places too (checked against `modules/` at the base):

- `gpu-graph.md`: `new GPUGraphTopology({device, graph, edges, vertexCount})` does not match `GPUGraphTopologyProps` (`graph: GPUGraph`, `forward`, `reverse?`, `invalidEdgeCount`); `new GPUGraphPageRank({device, graph, topology})` does not match `GPUGraphPageRankProps` (`topology`, `output`, ...); `pageRank.addPasses()` does not exist (no `addPasses` anywhere under `modules/`; operations are added with `graph.add(op)`).
- `gpu-raster/README.md`: `GPURasterBand` is a type, not a class; `new GPURasterStatistics({device, graph, band})` does not match `GPURasterStatisticsProps` (`width`, `height`, `input`, `count`, `sum`, `mean`, `extent`).
- `gpu-dataframe.md`: `frame.filter(...)` / `groupBy(...).mean(...)`: no such methods found on `GPUDataFrame` at the base (not checked against every expression helper).

A follow-up could replace these snippets with code taken from the corresponding examples under `examples/`, which run.

## PR description (luma template)

```markdown
For # (none; docs fix)

#### Background

Three quick starts construct the command graph with an options object as first argument; the constructor is `(device, props)`.

#### Rationale

Copying the snippet fails on its first line, which is the worst place for a quick start to fail.

#### Change List

- Use `new GPUCommandGraph(device, {id: ...})` in the gpu-graph, gpu-dataframe and gpu-raster quick starts
```

## Notes

- Vendored patch that disappears: none. Risk: none.
