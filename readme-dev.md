# PathMend development guide

For features and settings, see [README.md](README.md).

## Setup

You need Node.js and npm.

```bash
npm install
npm test
```

## Test commands

| Command                                                     | Runs                                                                                                | Needs VS Code |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------- |
| `npm test`                                                  | Run all Vitest tests. To add a test, create a `*.test.js`, `*.test.mjs`, or `*.spec.*` file. | No            |
| `npm run test:watch`                                        | Vitest, re-running as files change                                                                  | No            |
| `npx vitest run test/package-json/package-scripts.test.mjs` | Package-script tests only                                                                           | No            |
| `node test/unit.js`                                         | Core diagnostics against the sample workspace                                                       | No            |
| `node test/run-vscode.js`                                   | Editor integration tests (trusted and untrusted workspaces)                                         | Yes           |

The trusted VS Code run also executes `test/vscode/usecases.js` and `test/vscode/monorepo.js` after the original functional suite. It checks `package.json` script operands (missing and existing scripts, chained commands, package binaries, variables and URLs), GitHub Actions shell-script references, and Docker/Compose/build-output false positives. Both suites use the tracked `test/fixtures/ws/packages/script-cases/` fixture, copied to an isolated workspace by `test/prepare.js`. Tests modify and restore only that copied fixture; they never execute script commands or modify tracked source files. The focused rename regression suite (`test/vscode/monorepo.js`) uses one `bin` reference and two `node` script references to the same file. It renames that file through VS Code, accepts PathMend’s **Update all** prompt, and checks the updated paths and cleared diagnostics. It deliberately avoids copying the entire MoyaForge manifest. Both suites run automatically with `node test/run-vscode.js` or `PM_SCREENSHOTS=0 node test/run-vscode.js`.

**Note:** `test/unit.js` and `test/run-vscode.js` are not Vitest tests, so `npm test` skips them. Run them when you change core diagnostics, rename handling, or editor behavior.

The VS Code runner launches an isolated editor and runs `test/vscode/index.js`. By default, `@vscode/test-electron` downloads a VS Code executable (cached across runs). Set `VSCODE_EXECUTABLE_PATH` to an existing **VS Code Electron executable** to avoid downloading it, or `VSCODE_TEST_VERSION` to select a specific download. The `code` command-line shell wrapper is not a substitute for the executable.

By default, the test runner enables Playwright screenshots and creates `screenshots/` at the repository root. Set `PM_SCREENSHOTS=0` to run only the trusted and untrusted Extension Host functional checks, without loading Playwright or enabling Chromium remote debugging. The editor and sidebar still navigate through the same meaningful test states for someone watching the run. If Playwright is missing, it is automatically skipped. This works with `VSCODE_EXECUTABLE_PATH` to use your installed VS Code. When enabled, captured images are preserved after successful tests. The folder is ignored by Git and excluded from extension packaging. Each screenshot has a descriptive name:

- `diagnostics-panel.png` — initial broken-path findings
- `after-inline-fix.png` — findings after applying a fix
- `after-folder-rename.png` — findings after updating references
- `ignored-rename.png` — unresolved references after ignoring an update
- `empty-state.png` — no findings displayed
- `disabled-state.png` — extension diagnostics disabled
- `untrusted-panel.png` — panel in an untrusted workspace

Each named visual checkpoint is declared in `test/vscode/index.js`, while its editor/layout instructions live in `test/vscode/utils/visual.js`. This keeps functional assertions separate from presentation. Each checkpoint prepares a relevant editor or shows an appropriate workbench panel. PathMend file groups are expanded by default through its TreeItem configuration. The initial diagnostics snapshot also shows Problems; fix and rename snapshots show the affected configuration lines, while empty and disabled snapshots close editors to expose welcome content. Screenshots are optional visual debugging artifacts captured at these specific UI states, not assertions. The functional checks in `test/vscode/index.js` determine pass/fail. Playwright initialization, capture and observer failures log warnings without failing the test suite or changing its functional check results.

Screenshots use Playwright's Chromium DevTools Protocol (CDP) connection to the **actual VS Code workbench**, not OS-level screen capture. This works on macOS, Windows, and Linux with the same code and does not require ImageMagick, `xdotool`, `screencapture`, or PowerShell. VS Code still needs a graphical desktop or virtual display on headless Linux to capture screenshots; failures to capture screenshots do not affect the functional test result.

For example:

```bash
npm install
node test/run-vscode.js
# Or use a previously installed VS Code executable:
VSCODE_EXECUTABLE_PATH=/path/to/vscode/electron node test/run-vscode.js
# Run functional checks without Playwright or screenshots:
PM_SCREENSHOTS=0 node test/run-vscode.js
# Use the installed VS Code and disable screenshots:
PM_SCREENSHOTS=0 VSCODE_EXECUTABLE_PATH=/path/to/vscode/electron node test/run-vscode.js
```

### Use the locally installed VS Code on macOS

In Bash or Zsh, locate the application executable automatically and run the integration tests without downloading another copy of VS Code:

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
PM_SCREENSHOTS=0 node test/run-vscode.js  # Functional checks only
# Or: node test/run-vscode.js     # Includes Playwright screenshots
```

If VS Code is installed elsewhere, replace the application path. Use the Electron executable (`Code` or `Electron`), not the `code` shell command.

## Test fixtures

Files in `test/fixtures/` are test inputs, not tests.

```text
test/
├── fixtures/
│   ├── ws/                       # Sample workspace
│   └── package-json/
│       └── package.json          # Manifest for script path tests
├── package-json/
│   └── package-scripts.test.mjs  # Vitest suite
├── prepare.js                    # Builds the temporary workspace
├── unit.js                       # Core diagnostics test
├── run-vscode.js                 # VS Code test launcher
└── vscode/
    ├── index.js                  # Functional tests inside the editor
    ├── usecases.js               # Additional article/script regression cases
    ├── monorepo.js               # VS Code file rename → package scripts/bin updates
    └── utils/
        └── visual.js             # Watchable editor states and optional screenshots
```

- **`unit.js` and `run-vscode.js`:** `prepare.js` copies `fixtures/ws/` to a temp folder, adds symlinks and other edge cases, and returns the workspace paths.
