# PathMend development guide

This guide covers local development, testing, test fixtures, and optional VS Code screenshots.

For extension features and configuration, see [README.md](README.md).

## Getting started

**Requirements:** Node.js and npm.

Install dependencies and run the default tests:

```bash
npm install
npm test
```

## Running tests

PathMend uses Vitest for automated tests and separate scripts for core diagnostics and VS Code integration testing.

| Command                                                     | Description                                    |
| ----------------------------------------------------------- | ---------------------------------------------- |
| `npm test`                                                  | Run all Vitest tests                           |
| `npm run test:watch`                                        | Re-run Vitest tests when files change          |
| `npx vitest run test/package-json/package-scripts.test.mjs` | Run package-script tests only                  |
| `node test/unit.js`                                         | Test core diagnostics using a sample workspace |
| `node test/run-vscode.js`                                   | Run VS Code integration tests                  |

**Note:** `npm test` does not include `test/unit.js` or `test/run-vscode.js`. Run these separately when changing core diagnostics, file renaming, or editor behavior.

To add a Vitest test, create a `*.test.js`, `*.test.mjs`, or `*.spec.*` file.

### VS Code integration tests

Run the integration tests with:

```bash
node test/run-vscode.js
```

The runner launches an isolated VS Code instance and executes `test/vscode/index.js`.

Tests cover both **trusted and untrusted workspaces**. The trusted workspace also runs these additional suites:

| Test file                 | Coverage                                                           |
| ------------------------- | ------------------------------------------------------------------ |
| `test/vscode/usecases.js` | Package scripts, GitHub Actions references, and false positives    |
| `test/vscode/monorepo.js` | File renaming and updates to package scripts and binary references |

These tests verify:

- **Package scripts:** Missing and existing files, chained commands, package binaries, variables, and URLs.
- **GitHub Actions:** References to shell scripts.
- **False positives:** Docker, Compose, and build-output paths.
- **File renaming:** Updates to references and removal of resolved diagnostics.

#### File rename regression test

`test/vscode/monorepo.js` checks that PathMend updates multiple references to a renamed file.

The test:

1. Creates one `bin` reference and two `node` script references to the same file.
2. Renames the file through VS Code.
3. Accepts PathMend's **Update all** prompt.
4. Verifies that all three paths are updated and their diagnostics are cleared.

The test uses a small, dedicated fixture rather than copying the entire MoyaForge manifest.

#### Isolated test workspaces

Both suites use:

```text
test/fixtures/ws/packages/script-cases/
```

`test/prepare.js` copies the fixtures into a temporary workspace before testing.

Tests only modify the temporary copy. They do not execute package script commands or modify tracked source files.

## Using a local VS Code installation

By default, `@vscode/test-electron` downloads a VS Code executable and caches it for future runs.

You can instead use an existing installation:

```bash
VSCODE_EXECUTABLE_PATH=/path/to/vscode/electron node test/run-vscode.js
```

To test a specific VS Code version, set `VSCODE_TEST_VERSION`.

**Important:** `VSCODE_EXECUTABLE_PATH` must point to the actual VS Code Electron executable, not the `code` command-line wrapper.

### macOS

To automatically find VS Code in `/Applications` and run the integration tests:

```bash
VSCODE_EXECUTABLE_PATH="$(
  find "/Applications/Visual Studio Code.app/Contents/MacOS" \
    -maxdepth 1 -type f \( -name "Code" -o -name "Electron" \) \
    -print -quit
)"

if [ -z "$VSCODE_EXECUTABLE_PATH" ]; then
  echo "VS Code executable not found in /Applications" >&2
  exit 1
fi

export VSCODE_EXECUTABLE_PATH
echo "Using VS Code: $VSCODE_EXECUTABLE_PATH"

PM_SCREENSHOTS=0 node test/run-vscode.js
```

Remove `PM_SCREENSHOTS=0` to enable screenshots.

If VS Code is installed elsewhere, update the application path.

## Screenshots (optional)

The VS Code integration runner can capture screenshots of important editor states for visual debugging.

Screenshots are **enabled by default**.

```bash
# Integration tests with screenshots
node test/run-vscode.js

# Functional tests only (no Playwright)
PM_SCREENSHOTS=0 node test/run-vscode.js
```

Disabling screenshots does not disable functional testing. The editor and sidebar still navigate through the same test states.

### Captured screenshots

Screenshots are saved to `screenshots/` at the repository root.

| File                      | Captured state                                       |
| ------------------------- | ---------------------------------------------------- |
| `diagnostics-panel.png`   | Initial broken-path diagnostics and Problems panel   |
| `after-inline-fix.png`    | Diagnostics after applying an inline fix             |
| `after-folder-rename.png` | Updated references after renaming a folder           |
| `ignored-rename.png`      | Unresolved references after ignoring a rename update |
| `empty-state.png`         | No diagnostics to display                            |
| `disabled-state.png`      | PathMend diagnostics disabled                        |
| `untrusted-panel.png`     | Extension panel in an untrusted workspace            |

The `screenshots/` directory is ignored by Git and excluded from extension packaging. Captured images are preserved after successful tests.

### How screenshots work

PathMend uses Playwright's Chrome DevTools Protocol (CDP) connection to capture the **actual VS Code workbench**.

This approach:

- Works on macOS, Windows, and Linux.
- Does not require ImageMagick, `xdotool`, `screencapture`, or PowerShell.
- Requires a graphical desktop or virtual display on headless Linux.
- Automatically skips screenshots if Playwright is unavailable.

Screenshot-related failures produce warnings but **do not fail functional tests**.

### Visual checkpoints

Visual checkpoints are organized separately from functional assertions:

| File                          | Responsibility                                   |
| ----------------------------- | ------------------------------------------------ |
| `test/vscode/index.js`        | Defines checkpoints and functional assertions    |
| `test/vscode/utils/visual.js` | Prepares editor layouts and captures screenshots |

Each checkpoint displays the relevant editor, configuration lines, or workbench panel.

For example:

- Initial diagnostics show the Problems panel.
- Fix and rename checkpoints display the affected configuration lines.
- Empty and disabled states close editors to reveal welcome content.

PathMend file groups expand by default through their TreeItem configuration.

Screenshots are debugging artifacts, **not test assertions**. Functional checks determine whether the integration suite passes.

## Test fixtures and structure

Files in `test/fixtures/` are test inputs, not executable tests.

```text
test/
├── fixtures/
│   ├── ws/                       # Sample workspace
│   └── package-json/
│       └── package.json          # Package-script test manifest
├── package-json/
│   └── package-scripts.test.mjs  # Vitest package-script tests
├── prepare.js                    # Creates isolated test workspaces
├── unit.js                       # Core diagnostics tests
├── run-vscode.js                 # VS Code integration test launcher
└── vscode/
    ├── index.js                  # Editor integration tests
    ├── usecases.js               # Script and reference regression tests
    ├── monorepo.js               # File rename and reference updates
    └── utils/
        └── visual.js             # Editor layouts and screenshots
```

### Fixture preparation

For `test/unit.js` and `test/run-vscode.js`, `test/prepare.js`:

1. Copies `test/fixtures/ws/` into a temporary workspace.
2. Adds symlinks and other edge cases needed by the tests.
3. Returns the prepared workspace paths.

The Vitest package-script suite uses its dedicated manifest:

```text
test/fixtures/package-json/package.json
```

This keeps tests reproducible and prevents changes to tracked fixtures.
