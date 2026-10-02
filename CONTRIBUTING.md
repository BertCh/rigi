# Contributing to Rigi

**Thanks for taking the time to contribute!**

PRs and bug reports are welcome. Rigi is a small project; please keep contributions focused so they can be reviewed.

## AI-assisted contributions

We follow the spirit of the policy deck.gl and luma.gl use (the OpenJS Foundation's [policy on AI coding assistants](https://openjsf.cdn.prismic.io/openjsf/acqiJpGXnQHGZGtq_OpenJSAICodingAssistantsPolicy.pdf), and deck.gl's [CONTRIBUTING](https://github.com/visgl/deck.gl/blob/master/CONTRIBUTING.md#ai-assisted-contributions)). Parts of this repository are themselves written with AI assistance, so this is not a ban. It is a matter of *how* the tools are used.

There are still humans in the loop, so:

- **Think.** If a contribution takes more effort to review than it took you to create, something is wrong.
- Avoid **copy-pasting** responses from AI into conversations with humans.
- Avoid AI-generated **PR descriptions**; they will likely not be read. The best PR description is a short set of bullet points written by a human. The PR template says so in its first line.
- **Disclose AI use.** If AI wrote or substantially shaped the code, say so in the PR. If you must include AI-generated context, label it under a heading "Context for AI".
- You are responsible for every line you submit: you have read it, run it, and can explain it.
- Break larger contributions into **manageable chunks**.

## Setting up the dev environment

The **master** branch is the active development branch. You need Node 22.

```bash
npm install
npm run dev          # http://localhost:3100
```

luma.gl 10 and deck.gl are installed from tarballs in `vendor/` (see `vendor/luma/README.md`). Most demo photos and DEM tiles are fetched or local; several checks are skipped when the gitignored `data/` and `public/photos/` directories are absent. SKIP results from `node scripts/ci/run.mjs` are expected in a clone without that data.

## Running checks

```bash
node scripts/ci/run.mjs fast     # tsc, biome ratchet, node/tsx unit checks (about 30 s)
node scripts/ci/run.mjs full     # adds the browser checks
node scripts/ci/spdx.mjs         # SPDX headers
npx biome check --write <files>  # format and lint what you changed
```

Develop against `npm run dev` and the fast tier. Browser and GPU checks are not run per change: they run in batches over a chunk of work, and changes land marked browser-unverified until then (see "Testing policy" in `AGENTS.md`). In a batch, browser and GPU jobs share one machine-wide queue; run them as `node scripts/gpu/with-render-lock.mjs -- <command>`, one step at a time (the `full` tier does this for you).

## Pull requests

- For a feature or a bug fix, open an issue first.
- Follow `.github/pull_request_template.md`: Background, Rationale, Change List, Verification. In Verification, say which checks you ran and which you could not run.
- Run `npx biome check --write` on the files you changed, and `node scripts/ci/run.mjs fast` before you push.
- Every first-party source file carries `SPDX-License-Identifier` and `SPDX-FileCopyrightText` (see `AGENTS.md`). Do not add code or data copied from elsewhere without its licence, and record it in `NOTICE.md`.
- Do not change vendored packages (`vendor/`) by hand; follow the rebuild steps in their READMEs.

## Licence and data

Code is MIT (`LICENSE`). By contributing code you agree it is released under the MIT licence. Photographs, map data and models have their own terms; see `NOTICE.md`. Do not contribute photos you do not own.

## Code of conduct

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go through [.github/SECURITY.md](.github/SECURITY.md), not public issues.
