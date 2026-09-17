# Create command — `npm create @dsiddharth2/fleet-agent`

Status: agreed — design approved 2026-09-17, implementation pending.

## Problem

Getting started with the kit today means `git clone` followed by `rm -rf .git`.
That lands a user inside a copy of *this development repo*, not inside *their
project*:

| What they get | Size | Theirs? |
|---|---|---|
| `mcp/`, `pool/`, `host/`, `transport/`, `comm/` | ~3,200 lines, 41 files | No — framework they will rarely edit |
| `workflows/` — demo, inspect-members, city-briefing | 592 lines | Examples, to delete or adapt |
| `tools/` — 10 Python demo tools | 609 lines | Examples |
| `tests/` | 5,340 lines, 39 files | No — tests of the framework |
| `docs/specs/`, `docs/superpowers/` | ~16,000 lines | No — design history of this repo |
| `.github/workflows/` | — | No — CI for this repo |
| `package.json` (`"name": "workflow-kit"`), `README.md` | — | No |

Roughly 27,000 lines arrive, of which a couple of hundred are a useful starting
point. The user must work out by reading which files are framework (leave
alone), which are examples (delete), and where their own code goes. Nothing
carries their project's name. The README they inherit instructs them to clone
the repository they are already sitting inside.

A second problem sits underneath: nothing in the repo is arranged for this use.
`mcp/registry.mjs` imports the three demo workflows at module scope
(`registry.mjs:4-6`), so deleting the demos breaks the MCP server.
`ensure-apralabs.mjs` — framework code that both `mcp/main.mjs:4` and
`host/index.mjs:135` depend on — lives inside `workflows/demo/`, so deleting the
demo workflow breaks startup. The clone-and-delete flow is not merely
unpolished; it produces a project that does not run.

## Goal

One command produces a directory that is the user's project: named after them,
free of this repo's history and demo clutter, carrying one starter workflow to
copy, with local prerequisites either installed or precisely reported.

```
npm create @dsiddharth2/fleet-agent my-agent
```

## Non-goals

- **Publishing the framework as a library.** The generated project owns a copy
  of the framework (see Decision 1). Turning the kit into a dependency is a
  larger API redesign, deliberately out of scope.
- **An upgrade command.** Generated projects are forks from the moment they
  exist. `.kit-version` is written so a future upgrade path is possible, but
  none is designed here.
- **Module presets.** Every generated project receives the full framework.
  Trimming by deployment shape (tool server vs. full agent) is deferred.
- **Automating OAuth.** `claude setup-token` opens a browser. The command
  prints it; it cannot run it.

## User experience

```
$ npm create @dsiddharth2/fleet-agent my-agent

  Creating my-agent…
  ✓ copied kit (mcp, pool, host, transport, comm)
  ✓ starter workflow: workflows/hello
  ✓ npm install

  apra-fleet is not installed.
    Fleet is the runtime your workflows execute on. Without it,
    workflows cannot resolve @apralabs/apra-fleet-workflow and
    will fail on first run. It installs globally, outside this
    project, because Fleet is a machine install, not a dependency.
  Install now? (Y/n)

  ✓ npm i -g @apralabs/apra-fleet @anthropic-ai/claude-code
  ✓ apra-fleet install --skill none
  ✓ git init

  Two steps left — these need a browser and your shell:
    export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
    npm run hello

  Check anything at any time with: npm run doctor
```

### CLI surface

| Form | Behaviour |
|---|---|
| `npm create @dsiddharth2/fleet-agent my-agent` | Generate into `./my-agent` |
| no directory argument | Prompt for a project name |
| `--no-install` | Copy and substitute only; run no npm, no git, no prompts |
| `--yes` | Accept every prompt without asking |
| `--force` | Permit a non-empty target directory |

A non-empty target without `--force` is an error, not a prompt. Overwriting a
user's existing files on a typo'd path is not recoverable.

Prompts must explain before they ask. Every prompt states what the step is for,
what breaks without it, and whether it modifies anything outside the project
directory. A bare `Install apra-fleet? (Y/n)` is not acceptable output.

## Generated project

```
my-agent/
  mcp/            server.mjs, http.mjs, auth.mjs, fleet-text.mjs, main.mjs
                  registry.mjs        ← starter version, 3 tools
  pool/           all 11 files, unchanged
  host/           all 21 files, unchanged
  transport/      stdio-fleet.mjs, ensure-apralabs.mjs  ← relocated
  comm/           express.mjs, interface.mjs
  workflows/
    standalone.mjs
    hello/        main.mjs, hello.js
  tools/
    weather/weather.py
    textstats/textstats.py
  tests/hello.test.mjs
  scripts/doctor.mjs
  docs/           architecture.md, development.md
  Dockerfile
  docker-compose.yml
  .gitignore, .dockerignore
  package.json    "name": "my-agent"
  README.md       about my-agent
  .kit-version    version this project was generated from
```

`.kit-version` holds the `version` field of the package that generated the
project, written verbatim. `git init` runs with no initial commit, leaving the
user to make their own.

## Distribution and packaging

The package is `@dsiddharth2/create-fleet-agent`, published under the user's
personal npm scope with `npm publish --access public` (scoped packages default
to restricted). The name is what makes `npm create @dsiddharth2/fleet-agent`
resolve.

Packaging obeys two rules and requires no build step.

### Rule 1 — `files` decides what ships

```json
"files": [
  "mcp", "pool", "host", "transport", "comm",
  "workflows/standalone.mjs",
  "tools/weather", "tools/textstats",
  "docs/architecture.md", "docs/development.md",
  "template", "bin", "create",
  ".dockerignore"
]
```

`.gitignore` is absent by necessity: npm rewrites a packed `.gitignore` to
`.npmignore`, so the generated project's copy ships as `template/gitignore` and
the generator renames it on write. `.dockerignore` is unaffected and ships
as-is.

npm packs these paths from the repository as they are. `tests/`,
`docs/specs/`, `docs/superpowers/`, `.github/`, `workdir/`, the three demo
workflows and the remaining eight Python tools are absent from the tarball
because they are not listed. The `files` field is the manifest; no separate
manifest file and no prepublish assembly step exist.

### Rule 2 — `template/` overlays, and wins

At generate time the command copies the published framework folders into the
target, then copies `template/` over the result. On conflict, `template/` wins.

`template/` therefore holds exactly two kinds of file — those with no
counterpart in the repository, and the few that must *differ* from it:

| `template/` path | Kind | Why |
|---|---|---|
| `workflows/hello/main.mjs`, `hello.js` | New | `demo` smoke-tests the kit; it does not teach. A starter should be readable top to bottom |
| `mcp/registry.mjs` | Differs | Repo version imports the three demo workflows at module scope; starter imports `hello` |
| `package.json` | Differs | Project name, project scripts, no lockfile |
| `Dockerfile` | Differs | `npm install`, not `npm ci` — a generated project has no lockfile |
| `docker-compose.yml` | Differs | Trailing comments reference `workflows/hello`, not `workflows/demo` |
| `README.md` | New | Describes the user's agent |
| `tests/hello.test.mjs` | New | A green test on first run, modelling the mock-test convention |
| `gitignore` | Differs | Renamed to `.gitignore` on write — npm rewrites a packed `.gitignore` to `.npmignore`, so it cannot ship under its real name |

Nothing else is duplicated. `pool/`, `host/`, `transport/`, `comm/` and the
remainder of `mcp/` exist in exactly one place — this repository — and a fix
there reaches new projects on the next publish with nothing to remember.

## Module structure

```
bin/create.mjs          CLI entry: parse args, orchestrate, print
create/copy.mjs         recursive copy, then overlay
create/substitute.mjs   project name into package.json, README, compose
create/prompt.mjs       explain-then-ask prompt, honours --yes
create/doctor.mjs       the six environment checks
template/               everything above
```

`create/doctor.mjs` has one copy in this repository and two consumers: the
generator, which runs the checks to decide what to prompt for, and the
generated project, which receives it as `scripts/doctor.mjs`. It is the only
file the generator writes to a path other than its source. A second copy
authored in `template/` would drift from the checks the generator itself runs,
and the two disagreeing about whether an environment is valid is a worse
failure than the special case.

### Substitution

Substitution is confined to three files and is literal string replacement, not
a template engine:

| File | Replaced |
|---|---|
| `package.json` | `"name"` field |
| `README.md` | `{{PROJECT_NAME}}` occurrences |
| `docker-compose.yml` | nothing today; reserved for a container name |

Project names are validated against npm's package-name rules before anything is
written, so `package.json` cannot be generated invalid.

## Doctor checks

Six checks, each reporting what breaks and how to fix it. A bare ✗ is a bug.

```
  node        ✓ 22.18.0
  python3     ✓ 3.11.2
  apra-fleet  ✗ not found
              → workflows can't run. npm i -g @apralabs/apra-fleet
  claude      ✓ 2.0.1
  @apralabs   ✓ linked → ~/.apra-fleet/node_modules/@apralabs
  token       ✗ CLAUDE_CODE_OAUTH_TOKEN unset
              → agent() calls fail. export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
```

| Check | Passes when | Consequence of failure |
|---|---|---|
| `node` | `>=22.16`, per `engines` | Kit does not run |
| `python3` | on PATH | Python tool scripts fail |
| `apra-fleet` | binary on PATH or `APRA_FLEET_BIN` set | Workflows cannot spawn Fleet |
| `claude` | binary on PATH | Live `agent()` calls fail; mock tests still pass |
| `@apralabs` | `node_modules/@apralabs/apra-fleet-workflow` resolves | Workflows fail at import |
| token | `CLAUDE_CODE_OAUTH_TOKEN` set and non-empty | `agent()` calls fail |

Only `apra-fleet` and `claude` are offered as installs. The `@apralabs` symlink
needs no prompt — `ensureApralabs()` creates it lazily on first run once Fleet
exists. The token cannot be automated.

`npm run doctor` exits non-zero if any check fails, so it is usable in CI.

## Prerequisite refactors in `main`

Two changes land before the generator. Neither is optional; the generator
cannot ship a working project without them.

### Relocate `ensure-apralabs.mjs`

Move `workflows/demo/ensure-apralabs.mjs` to `transport/ensure-apralabs.mjs`.
It is framework code — `mcp/main.mjs:4` and `host/index.mjs:135` both import it
— that happens to live inside an example directory. A generated project without
`workflows/demo/` has a broken MCP server.

Five importers update:

| File | Current |
|---|---|
| `mcp/main.mjs:4` | `../workflows/demo/ensure-apralabs.mjs` |
| `host/index.mjs:135` | `../workflows/demo/ensure-apralabs.mjs` |
| `tests/setup-fleet-modules.mjs:1` | `../workflows/demo/ensure-apralabs.mjs` |
| `workflows/inspect-members/main.mjs:6` | `../demo/ensure-apralabs.mjs` |
| `workflows/city-briefing/main.mjs:4` | `../demo/ensure-apralabs.mjs` |

`workflows/demo/main.mjs:4` becomes a `../../transport/` import.
`scripts/docker-entrypoint.sh` references the old path inline and updates too.

The module's own `repoRoot` constant changes from `'../..'` to `'..'`, since it
moves up one directory level. Missing this silently resolves `node_modules` to
the parent of the project.

Documentation references in `README.md:93,318` and `docs/development.md:180`
update. References inside `docs/superpowers/plans/` are historical records of
completed work and are left alone.

### Decouple `mcp/registry.mjs` from specific workflows

The registry imports `runDemo`, `runInspectMembers` and `runCityBriefing` at
module scope. The starter registry should be a drop-in replacement of the same
shape, differing only in which workflows it imports and registers — so that
`template/mcp/registry.mjs` is a small, obviously-correct file rather than a
reimplementation. The shared helpers it uses (`toolsDir`, `shellEscape`,
`parseToolOutput`) move to a sibling module both versions import.

## Decisions

1. **The generated project owns a copy of the framework.** Considered making
   the kit an npm dependency so fixes ship by version bump. Rejected for now:
   the current contract tells users to append their tool to `mcp/registry.mjs`,
   a framework file, so the dependency model is an API redesign rather than a
   packaging change. Copying also suits a kit meant to be read and modified.
   The accepted cost is that generated projects are forks and receive no fixes.
   `.kit-version` records the origin so a future upgrade tool has a baseline.

2. **Published to npm rather than run from GitHub.** `npx github:…` was viable
   and needs no publish, but a published scoped package gives one documented
   path and a version users deliberately received. `npm create` resolves
   `@dsiddharth2/fleet-agent` to `@dsiddharth2/create-fleet-agent`.

3. **No build step; `files` is the manifest.** An earlier design proposed a
   prepublish assembly stage driven by a custom manifest module. npm's `files`
   field already does exactly this, from a file already maintained. The custom
   stage was removed.

4. **`template/` overlays rather than replaces.** Makes the duplication set
   explicit and minimal: a file appears in `template/` only when it has no
   counterpart in the repo, or must differ from it. Eight files qualify.

5. **`docs/architecture.md` and `docs/development.md` ship as-is.** Rewriting
   them per project was considered and rejected — it recreates the duplication
   that Decision 4 exists to prevent, and prose drifts faster than code. They
   describe the same framework the project contains, so they stay accurate
   without maintenance. `README.md` carries everything project-specific.

6. **Prompts explain before they ask.** The global installs modify the machine
   outside the project directory, may require `sudo`, and may upgrade a Fleet
   version another project depends on. A user cannot consent to that from
   `(Y/n)` alone.

7. **Local `npm install` runs unprompted; global installs do not.** `npm
   install` writes only inside the new directory and is uncontroversial.
   `npm i -g` is not, and neither is `apra-fleet install`.

8. **Skipping setup is a supported outcome.** Declining every prompt yields a
   project that fails on first run with `ensureApralabs()`'s existing, clear
   message, and `npm run doctor` explains the rest. Declining is not a broken
   state.

9. **The doctor is copied out, not imported.** A generated project declares no
   dependency on `@dsiddharth2/create-fleet-agent`, so `scripts/doctor.mjs`
   cannot import from it — it is copied at generate time from
   `create/doctor.mjs` to `scripts/doctor.mjs`, the one file written to a path
   other than its source. This keeps a single copy in the repository, driving
   both the install prompts and the generated project's `npm run doctor`.

10. **Two demo tools survive, chosen for having no dependencies.** `weather`
    and `textstats` are stdlib-only and need no API key, so a generated project
    has working examples on first run. `geocode`, `forecast`,
    `travel-advisory` and the rest are dropped.

11. **A non-empty target is an error, not a prompt.** Overwriting files on a
    typo'd path is unrecoverable; `--force` exists for the deliberate case.

12. **No GitHub Actions workflow is generated.** Offered and declined — CI
    shape is the user's decision and guessing at it adds a file most would
    delete.

## Failure modes

| Situation | Behaviour |
|---|---|
| Target directory exists and is non-empty | Error before any write; suggest `--force` |
| Invalid project name | Error before any write, with npm's naming rule |
| `npm install` fails (offline, proxy) | Warn, continue; files are already correct. Doctor reports it |
| Global install fails (no sudo, proxy) | Warn, continue; print the manual command |
| `apra-fleet install` fails | Warn, continue; doctor reports `apra-fleet` present but unusable |
| User declines every prompt | Complete project, doctor lists what is missing |
| `git init` fails (git absent) | Warn, continue; the project does not require git |
| Copy fails midway (disk, permissions) | Remove the partially-created directory, then error |

Nothing except a bad target or a bad name aborts generation. Once files are
written they are correct; every later step is an optimisation the doctor can
re-report.

## Testing

| Area | Test | Asserts |
|---|---|---|
| Copy | `tests/create-copy.test.mjs` | Framework dirs land; excluded paths absent |
| Overlay | `tests/create-copy.test.mjs` | `template/` wins on conflict — `mcp/registry.mjs` is the starter |
| Substitution | `tests/create-substitute.test.mjs` | Name reaches `package.json` and `README.md`; invalid names rejected |
| Prompts | `tests/create-prompt.test.mjs` | `--yes` skips; declining leaves files intact; text names the consequence |
| Doctor | `tests/create-doctor.test.mjs` | Each check passes and fails correctly against a stubbed environment; exit code follows |
| Failure modes | `tests/create-failures.test.mjs` | Non-empty target aborts before writing; partial copy is cleaned up |
| End to end | `tests/create-e2e.test.mjs` | Generate into a temp dir with `--no-install`; assert the tree; run the generated `npm test` and require it green |

The end-to-end test is the one that matters. It makes a framework change that
breaks generated projects fail CI before publish — the guarantee that the
single-copy packaging is meant to deliver.

Generator tests need no Fleet binary, no members and no token, consistent with
the existing suite. The doctor's environment probes are injected so tests never
depend on what is installed on the machine running them.

## Open questions

1. **Does `npm create` pass flags through cleanly?** `npm create x a --no-install`
   should forward `--no-install` to the bin, but npm has historically eaten some
   flags. Verify before relying on `--no-install` in CI; `--` separator may be
   required and, if so, must be documented.

2. **Does the generated `Dockerfile` build without a lockfile?** Switching
   `npm ci` to `npm install` is the stated fix, but the generated image has not
   been built. Verify before publishing.
