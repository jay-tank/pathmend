# PathMend development guide

For features and settings, see [README.md](README.md).

## Setup

You need Node.js and npm.

```bash
npm install
npm test
```

`npm test`

## Test commands

| Command                                                     | Runs                                                                                                | Needs VS Code |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------- |
| `npm test`                                                  | Vitest,run All Vitest tests. To add a test, create a `*.test.js`, `*.test.mjs`, or `*.spec.*` file. | No            |
| `npm run test:watch`                                        | Vitest, re-running as files change                                                                  | No            |
| `npx vitest run test/package-json/package-scripts.test.mjs` | Package-script tests only                                                                           | No            |
| `node test/unit.js`                                         | Core diagnostics against the sample workspace                                                       | No            |
| `node test/run-vscode.js`                                   | Editor integration tests (trusted and untrusted workspaces)                                         | Yes           |

**Note:** `test/unit.js` and `test/run-vscode.js` are not Vitest tests, so `npm test` skips them. Run them when you change core diagnostics, rename handling, or editor behavior.

The VS Code runner needs the `code` CLI on your `PATH`. It launches an isolated editor with PathMend loaded and runs `test/vscode/index.js`. Screenshot capture uses the built-in `screencapture` on macOS and Windows PowerShell (`System.Drawing`) on Windows. On Linux, the runner uses `xdotool` (for selecting the editor window when available) and ImageMagick's `import`. Capture requires an interactive graphical desktop or a configured display; a screenshot failure is reported explicitly rather than counted as a successful screenshot.

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
    └── index.js                  # Tests that run inside the editor
```

- **`unit.js` and `run-vscode.js`:** `prepare.js` copies `fixtures/ws/` to a temp folder, adds symlinks and other edge cases, and returns the workspace paths.
