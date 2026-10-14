# Changelog

## 0.1.0 - Initial release

- Checks paths in package.json, tsconfig / jsconfig (including `compilerOptions.baseUrl`, `typeRoots` and `paths`, resolved against the own or inherited `baseUrl`), Dockerfile / Containerfile COPY and ADD, Compose build context and dockerfile, GitHub Actions workflows and composite actions, GitLab CI local includes, CODEOWNERS and `.vscode/launch.json`.
- Rules PM001 - PM011, on the exact range of the path string, with configurable severity.
- Globs are accepted when they match at least one file (PM009 otherwise).
- Dockerfile sources are resolved against the build context from Compose when available, and flagged when they leave it (PM011).
- Quick Fix "Did you mean ...?" using the same file name in another folder or a close spelling.
- Rename and move awareness: offers to update every config reference to the old path, with an optional refactor preview.
- Activity bar view: broken references grouped by config file, each row labelled with the rule and the exact path (for example `PM003  scripts/start.sh`), click to open at the path, inline "Apply suggested path" action, badge with the count, Scan and Show buttons, and welcome text when there is nothing to show or PathMend is turned off.
- Commands: Scan workspace, Show broken references. Status bar count.
- Files created, deleted or moved outside VS Code are picked up on window focus and once a minute, also when file watching is unavailable.
- Security: only config files found by the editor's file search are read; referenced paths are only checked for existence and only inside the workspace folders, with symlinks walked step by step. Paths outside the workspace are reported as not checked (PM010).
- No network, telemetry or child processes; works in untrusted workspaces.
