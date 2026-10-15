# PathMend: Find Broken Paths in Config Files

**Find broken paths in your config files after a move or rename** - before CI, `docker build` or `npm publish` does.

You move `scripts/start.sh` to `tools/start.sh`. The editor updates the imports in your code,
the tests pass, and you push. Then CI fails, because a string in a config file still says
`scripts/start.sh`:

- the Dockerfile has `COPY scripts/start.sh /usr/local/bin/`, so the image build fails with
  `COPY failed: file not found in build context`
- `package.json` has `"bin": "scripts/start.sh"`, so the published package is broken
- a workflow has `run: bash scripts/start.sh`, or `working-directory: services/old-name`
- `CODEOWNERS` still lists `/scripts/`, so reviews stop being requested

Tools that check import paths only look at code. PathMend looks at the **config files**, where
these paths are plain strings that nothing else checks.

Real examples:

- [software-mansion/react-native-reanimated#3026](https://github.com/software-mansion/react-native-reanimated/issues/3026) - "Package json main points to non existing file", shipped in a release.
- [docker/build-push-action#97](https://github.com/docker/build-push-action/issues/97) - "What's the Context for COPY?" - a Dockerfile COPY path that does not match the build context.

## What it checks

| File | Paths checked | Relative to |
| --- | --- | --- |
| `package.json` | `main` (with Node's `.js` / `index.js` fallbacks), `module`, `types`, `typings`, `browser`, `bin`, `exports` (including `*` patterns), `files`, `workspaces` | the package folder |
| `tsconfig*.json`, `jsconfig*.json` | `extends` (relative paths only), `files`, `include`, `references` (folder must contain `tsconfig.json`), `compilerOptions.baseUrl` and `compilerOptions.typeRoots` | the tsconfig folder |
| | `compilerOptions.paths` targets: a `*` target must match at least one file, any other target must resolve like a module (`.ts`, `.tsx`, `.d.ts`, `.js`, `.json`, ... or an `index` file) | the `baseUrl` of that tsconfig, or the one it inherits through relative `extends`, otherwise the tsconfig folder |
| `Dockerfile`, `Dockerfile.*`, `*.Dockerfile`, `Containerfile` | `COPY` / `ADD` sources, shell and JSON form, line continuations, heredocs skipped | the build context from a Compose file that uses this Dockerfile, otherwise the Dockerfile folder (or a parent folder up to the workspace root) |
| `docker-compose*.yml`, `compose*.yaml` | `build:` / `build.context`, `build.dockerfile` | the compose file folder / the context |
| `.github/workflows/*.yml`, `.github/**/action.yml` | `working-directory` (workflow, job and step), local `uses: ./...` (must contain `action.yml`, `action.yaml` or `Dockerfile`), reusable `uses: ./.github/workflows/x.yml`, scripts started from `run:` (`./x.sh`, `bash scripts/x.sh`, `python tools/x.py`, `node x.js`, `source ./env.sh`) | the repository root, or the effective `working-directory` |
| `.gitlab-ci.yml` | `include:` local files (string or `local:`), including `*` / `**` globs | the repository root |
| `CODEOWNERS` (root, `.github/`, `docs/`, `.gitlab/`) | patterns without wildcards; `/path` and `dir/file` are anchored, a bare name matches anywhere | the repository root |
| `.vscode/launch.json` | `program`, `cwd` that start with `${workspaceFolder}` or `${workspaceFolder:Name}` | that workspace folder |

A glob is fine when it matches at least one file. Skipped on purpose: `COPY --from=<stage>`,
URLs and git contexts, anything with `$VAR`, `${VAR}` or `${{ }}`, bare package specifiers
in `extends`, `paths` in a tsconfig that may inherit its `baseUrl` from a package in
`extends` (or whose `baseUrl` is itself missing), jobs whose `actions/checkout` uses a custom
`path:`, and references into build
output folders (see `pathmend.ignoreReferences`; the `outDir` of your tsconfigs is added
automatically, so `"main": "build/index.js"` is not reported before a build).

## Rules

| Code | Meaning | Example |
| --- | --- | --- |
| **PM001** | package.json path not found | `"bin": { "tool": "bin/tool.js" }` after moving it to `lib/` |
| **PM002** | tsconfig / jsconfig path not found | `"extends": "./tsconfig.bse.json"` |
| **PM003** | Dockerfile COPY / ADD source not found | `COPY scripts/start.sh /usr/local/bin/` |
| **PM004** | Compose build context / dockerfile not found | `context: ./services/wrker` |
| **PM005** | GitHub Actions path not found | `uses: ./.github/actions/setpu`, `run: bash scripts/build.sh` |
| **PM006** | CODEOWNERS path not found | `/docs/guid.md @docs-team` |
| **PM007** | launch.json path not found | `"program": "${workspaceFolder}/src/server.js"` |
| **PM008** | GitLab CI local include not found | `- local: ci/templates/tset.yml` |
| **PM009** | Glob matches no files | `"files": ["docs/*.pdf"]`, `COPY config/*.yaml /app/` |
| **PM010** | Resolves outside the workspace - not checked (Information) | `"main": "/etc/passwd"`, `../../elsewhere` |
| **PM011** | COPY / ADD source outside the Docker build context | `COPY ../../src /src` with context `services/api` |

Each diagnostic sits on the exact path string, with source `PathMend`.

## Quick Fix: "Did you mean ...?"

For a missing path, PathMend looks for the closest existing file or folder in the workspace:
the same file name in another folder first (the usual "moved it" case), otherwise a close
spelling of the name. The fix keeps your style - a leading `./`, a leading `/` in CODEOWNERS
and GitLab includes, `${workspaceFolder}` in launch.json, a trailing `/` - and for Dockerfiles
only suggests files inside the build context.

## Rename and move: update all references

When you rename or move a file or folder in VS Code (Explorer, drag and drop, or a refactoring),
PathMend compares with the references it saw before the move and shows:

> 3 config references still point to src/utils - update all?

- **Update all** rewrites those strings in the config files and saves them.
- **Preview** opens the standard refactor preview, so you can review and untick edits.
- **Ignore** leaves them - they then show up as normal diagnostics.

Only config files inside the workspace are edited. Renames done outside VS Code (for example
`git mv` in a terminal) are not seen as renames; the references simply show up as broken.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `pathmend.enabled` | `true` | Turn diagnostics on or off. |
| `pathmend.exclude` | `**/node_modules/**`, `**/.git/**`, `**/dist/**` | Globs that are not scanned. Config files here are not read; references into them are not checked. |
| `pathmend.ignoreReferences` | `**/build/**`, `**/out/**`, `**/coverage/**`, `**/target/**`, `**/.next/**` | Build output folders; references into them are not checked. |
| `pathmend.disabledRules` | `[]` | Rule codes to turn off, e.g. `["PM006", "PM010"]`. |
| `pathmend.severity` | `warning` | `error`, `warning`, `information` or `hint` for broken references. PM010 is always Information. |
| `pathmend.reportOutsideWorkspace` | `true` | Show PM010 for paths outside the workspace. |
| `pathmend.renameUpdates` | `prompt` | `off` to never offer rename updates. |
| `pathmend.maxIndexedFiles` | `20000` | Files indexed for glob matching and suggestions. |
| `pathmend.maxConfigFileSizeKB` | `512` | Larger config files are skipped. |

## Activity bar and commands

- **Activity bar** - the PathMend view lists every broken reference, grouped by config file.
  Each row is labelled with the rule and the exact path string (for example
  `PM003  scripts/start.sh`), shows the rule and line next to it, and opens the file on that
  path when clicked. Rows with a suggestion have an inline **Apply suggested path** action (the
  same edit as the "Did you mean ...?" Quick Fix). The badge shows the number of broken
  references; the title bar has **Show broken references** and **Scan workspace**.
- **PathMend: Scan workspace** - rebuild the file index and check every config file.
- **PathMend: Show broken references** - pick a broken reference and jump to it.

The status bar shows the number of broken references; click it for the same list. Files
created, deleted or moved outside VS Code (for example by `git checkout`) are picked up when
the window regains focus and once a minute, even where the editor's file watcher misses them.

## Privacy and safety

- **No network, no telemetry, no child processes.** PathMend never runs git, docker, node or
  any other program.
- **Only config files are read.** They are found with the editor's own file search inside your
  workspace folders. Referenced files are only checked for **existence** - their contents are
  never opened.
- **Nothing outside the workspace is touched.** A path from a config file is resolved first,
  and is only checked when it lies inside a workspace folder. Symlinks are followed one step at
  a time; a link that leads outside the workspace stops the check before anything behind it is
  touched. Absolute paths, `../` escapes and escaping symlinks are reported as PM010
  ("outside the workspace - not checked"). A config file that is itself a symlink to outside
  the workspace is not read.
- **Works in untrusted workspaces**, because it only reads config files and checks whether
  paths exist.
- Edits happen only when you choose a Quick Fix or a rename update, and only in config files
  inside the workspace.

## Limitations

- The YAML reader is line-oriented: block maps and sequences, block scalars, one-line flow
  lists, quotes, comments. Multi-line flow collections and anchors merged with `<<:` are not
  followed.
- The Docker build context is only known when a Compose file points at the Dockerfile.
  Contexts passed on the command line (`docker build -f docker/Dockerfile .`) or in
  `docker/build-push-action` are not read, so a source is accepted if it exists relative to the
  Dockerfile folder or any parent folder up to the workspace root. `.dockerignore` is not
  applied.
- `run:` scripts are only recognised in command position (`./x.sh`, or after `bash`, `sh`,
  `python`, `node` and similar). Files created earlier in the same step are reported as missing.
- Glob matching and "did you mean" use an index of up to `pathmend.maxIndexedFiles` files;
  in a larger workspace unmatched globs are not reported.
- A rename update is skipped for references inside a config file that was itself moved.
- Out of scope by design: `env_file` and `${VAR}` in Compose files, and script line endings,
  shebangs and executable bits.

## License

MIT - included with the extension.
