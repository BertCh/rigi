# (f) Growable `GPUReadbackRing` slots and partial-range ticket reads

Status: **local packet, nothing posted** (owner decides). Rank 10 of 11 in [README.md](README.md). Base: luma master `00aab0f91` (2026-10-02, "fix(examples): refine architectural charcoal strokes (#3349)").

Kind: feature. Size: 4 files, +about 300. Depends on nothing (it deliberately uses plain `readAsync`, so it does not need c3).

## Title

`feat(gpgpu): growable GPUReadbackRing slots and partial-range ticket reads`

## Problem

`GPUReadbackRing` slots all have one fixed capacity, so a ring has to be sized for the largest result it will ever carry, and a result whose useful length is written by the GPU (a counter followed by that many records, as in the index-picking region readback) still maps and copies the whole capacity on the CPU.

Rigi's `src/lib/gpu/core/readback.ts` implements the same ticket pattern with slots that grow on demand and a two-step "map the header, then only the used prefix" read. This packet proposes those two ideas on top of the existing ring, not Rigi's whole module.

## Minimal repro

```ts
const ring = new GPUReadbackRing(device, {byteLength: 16, slotCount: 2});
ring.tryAcquire({byteLength: 100}); // option ignored: the slot is still 16 bytes, copyFrom throws on a 100 byte copy
```

## Proposed patch

`patches/f-readback-ring-growable-partial.patch` (444 lines, `git am` format, authored as the owner). Too long to inline; the diffstat is:

```
 .../gpu-core/gpu-readback-ring.md             |  26 +++
 .../gpgpu/src/gpu-core/gpu-readback-ring.ts   | 179 ++++++++++++++++--
 modules/gpgpu/src/gpu-core/index.ts           |   6 +-
 .../gpu-core/gpu-readback-ring.node.spec.ts   | 118 ++++++++++++
 4 files changed, 311 insertions(+), 18 deletions(-)
```

API added:

- `GPUReadbackRingProps.growable?: boolean` (default `false`; `byteLength` is then the initial capacity);
- `tryAcquire(options?)` / `acquire(options?)` with `GPUReadbackAcquireOptions = {byteLength?}`: the smallest idle slot that fits is reused, otherwise an idle slot is replaced by one rounded up to a power of two; waiters are served with a slot that fits; a fixed ring throws a clear error for a request above its capacity;
- `GPUReadbackTicket.readPartial({headerByteLength, getByteLength})`: maps the header, asks `getByteLength(header)`, maps only that prefix; validates the length; releases the slot on error like `read()`.

Existing callers are unaffected (no option, no behaviour change). `read()` is untouched.

## Test plan

- In the patch: `gpu-readback-ring.node.spec.ts` (node, `NullDevice`): fixed ring rejects oversized requests; growable ring replaces a too-small idle slot (16 to 128 for a 100 byte request), then reuses it; a waiter gets a big enough slot; `readPartial` returns header and exactly the used words and releases the slot; a length outside the encoded range rejects and still releases; requires an encoded ticket.
- Done here: that spec and `yarn vitest run --project node modules/core modules/webgpu modules/webgl modules/test-utils modules/gpgpu modules/engine`.
- Not run: a real-GPU `readPartial` (browser). Not measured: whether the second, smaller map is faster than one full map (Rigi's own code comment says the same: correctness contract only).
- Follow-up option: once c3 is in, `read()` / `readPartial()` could use `mapAndReadAsync(..., {waitForSubmittedWork: false})` for their `MAP_READ` slots.

## Verification run for this packet

With all packets applied together on the base (plus `#3330` merged for c3/c4): `yarn vitest run --project node modules/core modules/webgpu modules/webgl modules/test-utils modules/gpgpu modules/engine` gave 158 files passed, 1 skipped; 1392 tests passed, 7 skipped; `biome check` on every touched `.ts` file: 0 errors, 29 warnings (the same 29 on the unpatched base). Browser-tier specs (`*.spec.ts` without `.node`) were not run, no browser here. Root `tsc --noEmit` prints about 3,650 errors on the unpatched base (the luma workspace is not built here); none of the patches adds an error outside the spec mocks that already fail the same way.

## PR description (luma template)

```markdown
For # (open an issue first per the template; none filed)

#### Background

A `GPUReadbackRing` has one fixed slot capacity, so readbacks of varying size need a ring sized for the worst case, and a result with a GPU-written length is always mapped in full.

#### Rationale

Growth is opt-in and replaces only idle slots, so slot reservation stays explicit and no in-flight buffer is touched. A header-first partial read is the smallest API that lets the CPU skip the unused tail.

#### Change List

- `growable` ring option and `acquire` / `tryAcquire` `{byteLength}` option
- `GPUReadbackTicket.readPartial()`
- Docs for both, node spec on the null device
```

## Notes

- Vendored patch that disappears: none. App code that shrinks: slot growth in `core/readback.ts`; the rest of that module (several ranges packed into one slot, device-loss and failed-submit propagation through `lifecycle.ts` / `queue.ts`) has no upstream counterpart and stays.
- Review items: the replaced slot's id counter changes buffer ids (`...-slot-N` keeps counting up); sizes round up to a power of two, so a growable ring can hold up to 2x the largest request per slot.
