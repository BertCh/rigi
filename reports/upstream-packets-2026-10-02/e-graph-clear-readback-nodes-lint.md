# (e) Clear and readback copy-node factories, and a preflight report of uninitialized transient reads

Status: **local packet, nothing posted** (owner decides). Rank 11 of 11 in [README.md](README.md). Base: luma master `00aab0f91` (2026-10-02, "fix(examples): refine architectural charcoal strokes (#3349)").

Kind: feature. Size: 7 files, +about 350. Depends on c1 (`CommandEncoder.clearBuffer`). Not a copy of Rigi's code, see the differences below.

## Title

`feat(gpgpu): clear and readback copy-node factories; preflight reports uninitialized transient reads`

## Problem

Graph transients are not zero-initialized, and compatible transients with disjoint lifetimes share physical bytes. An operation that accumulates into a transient (atomics, partial writes) therefore reads whatever an earlier node left there, and nothing in luma helps: there is no clear node, and nothing reports a transient read before any write. Likewise a transient result can only be read back by promoting it to an import or writing a custom copy node.

Rigi's `ComputeGraph` (`src/lib/gpu/core/graph.ts`) has a `clearNode`, a `readNode` and a lint over the scheduled order (`clear-lint.ts`) for exactly this, and it has caught real bugs. This packet proposes the part that fits luma's model.

## What is proposed, and what is deliberately not

| Rigi | This packet |
|---|---|
| `clearNode(id, range)` over a handle, view or parameter-sized range | `createGPUClearBufferCommandNode({id, target, byteOffset?, byteLength?})`: a copy-pass node using `clearBuffer` (static range; a handle or a data view's contiguous span) |
| `readNode(id, ranges[])`: copies several ranges into one staging slot owned by Rigi's readback pool | `createGPUReadbackCommandNode({id, source, byteOffset?, byteLength?, getTicket})`: copies one range into a `GPUReadbackTicket` chosen per encoding, so it composes with the existing `GPUReadbackRing` |
| Lint: partial / atomic writes need a clear; GPU-conditioned (indirect gate) writers need a whole clear; unaudited nodes refused | `compiled.preflight.uninitializedTransientReads`: transient buffers whose first scheduled access is a read, as a report (a soft check, like the rest of `preflight`), not an error |

Not proposed: the partial / atomic and GPU-gate rules. They depend on write-mode metadata (`writes: {acc: "atomic"}`, `cleared: [...]`) that luma's `GraphBufferUsage` does not carry (`storage-write` cannot say "partial"). The report treats any write as initializing the whole buffer, so a partially written transient is only flagged when nothing wrote it at all. If upstream wants the stronger lint it needs a usage variant first.

## Minimal repro

```ts
const accumulator = graph.createTransientBuffer({id: 'accumulator', byteLength: 16, usage: Buffer.STORAGE | Buffer.COPY_SRC});
// ... a node that declares {buffer: accumulator, usage: 'storage-read'} before anything wrote it ...
graph.compile().preflight.uninitializedTransientReads; // undefined on master: no such report
```

## Proposed patch

`patches/e-graph-clear-readback-nodes-lint.patch` (458 lines, `git am` format, authored as the owner). Too long to inline; the diffstat is:

```
 .../gpu-core/gpu-command-graph.md             |  25 ++++
 .../src/gpu-core/gpu-buffer-command-nodes.ts  | 122 ++++++++++++++++
 .../gpu-core/gpu-command-graph-compiler.ts    |  37 +++++
 .../src/gpu-core/gpu-command-graph-types.ts   |  17 +++
 .../gpgpu/src/gpu-core/gpu-command-graph.ts   |   1 +
 modules/gpgpu/src/gpu-core/index.ts           |   9 ++
 .../gpu-buffer-command-nodes.node.spec.ts     | 137 ++++++++++++++++++
 7 files changed, 348 insertions(+)
```

## Test plan

- In the patch: `gpu-buffer-command-nodes.node.spec.ts` (node, no GPU: a `NullDevice` that reports type `webgpu`, the same fixture `gpu-command-graph-passes.node.spec.ts` uses) covers the clear node zeroing a byte range of an imported buffer, the readback node reading a transient through a `GPUReadbackRing` ticket at its place in the schedule, byte-range validation, and the preflight report (read-before-write flagged; a clear first, or a write first, not flagged).
- Done here: that spec, plus `yarn vitest run --project node modules/core modules/webgpu modules/webgl modules/test-utils modules/gpgpu modules/engine` with the new `preflight` field present (the existing specs pass unchanged).
- Not run: a real-GPU spec (browser). The clear node's GPU behaviour is c1's `clearBuffer`, tested there.

## Verification run for this packet

With all packets applied together on the base (plus `#3330` merged for c3/c4): `yarn vitest run --project node modules/core modules/webgpu modules/webgl modules/test-utils modules/gpgpu modules/engine` gave 158 files passed, 1 skipped; 1392 tests passed, 7 skipped; `biome check` on every touched `.ts` file: 0 errors, 29 warnings (the same 29 on the unpatched base). Browser-tier specs (`*.spec.ts` without `.node`) were not run, no browser here. Root `tsc --noEmit` prints about 3,650 errors on the unpatched base (the luma workspace is not built here); none of the patches adds an error outside the spec mocks that already fail the same way.

## PR description (luma template)

```markdown
For # (open an issue first per the template; none filed)

#### Background

Transient buffers are uninitialized and may alias, but a graph has no first-class way to clear one, to read one back at the point where it holds its result, or to notice a read before any write. Applications that accumulate into transients write the same copy nodes by hand.

#### Rationale

Both nodes are plain copy-pass nodes built with `createGPUCopyCommandNode`, so they take part in hazard inference like any copy. The report is a pure function over the scheduled order added to the existing preflight, so it costs nothing at encode time and changes no behaviour. Per-range and atomic-write tracking would need new usage modes and is left out on purpose.

#### Change List

- `createGPUClearBufferCommandNode()` (depends on `CommandEncoder.clearBuffer`)
- `createGPUReadbackCommandNode()` over `GPUReadbackTicket`
- `GPUCommandGraphPreflightReport.uninitializedTransientReads` and its type
- Docs section in the `GPUCommandGraph` reference, and a node spec
```

## Notes

- Vendored patch that disappears: none. App code that shrinks: `ComputeGraph.clearNode`'s node body (not its audit bookkeeping or lint, which stay), nothing in `readNode` (it packs several ranges into one pooled slot with loss and failure propagation).
- Review items: the report is a new required field on `GPUCommandGraphPreflightReport` (code that constructs one by hand needs it); `createGPUReadbackCommandNode` takes the ticket from `parameters` so one compiled graph can be encoded repeatedly with different tickets.
