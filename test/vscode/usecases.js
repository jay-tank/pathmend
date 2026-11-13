"use strict";

// Additional article use cases, kept separate from the original integration checks.
// Uses only a temporary subfolder in the already-isolated VS Code test workspace.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

async function runScriptCases(check, cfg) {
  const ws = fs.realpathSync(cfg.ws);
  const pkgPath = path.join(ws, "packages", "script-cases", "package.json");
  const ext = vscode.extensions.getExtension("jaytankdev.pathmend");
  const api = await ext.activate();
  const original = fs.readFileSync(pkgPath, "utf8");
  try {
    const fixture = JSON.parse(original);
    Object.assign(fixture.scripts, {
      missingNode: "node tools/missing.js",
      missingBash: "bash tools/missing.sh",
      missingRelative: "./tools/missing-cli.sh",
      chained: "echo ready && node tools/missing-second.js",
    });
    fs.writeFileSync(pkgPath, JSON.stringify(fixture, null, 2) + "\n");
    await api.rebuildIndex();
    const findings = vscode.languages.getDiagnostics(vscode.Uri.file(pkgPath))
      .filter((d) => d.source === "PathMend");
    const valueFor = (d) => {
      const line = fs.readFileSync(pkgPath, "utf8").split("\n")[d.range.start.line];
      return line.slice(d.range.start.character, d.range.end.character);
    };
    const actual = findings.map((d) => ({ code: d.code, value: valueFor(d), range: d.range }));
    const expected = ["tools/missing.js", "tools/missing.sh", "./tools/missing-cli.sh", "tools/missing-second.js"];
    check("scripts: missing local executable paths reported as PM001", expected.every((v) =>
      actual.some((d) => d.code === "PM001" && d.value === v)), actual);
    check("scripts: valid commands, environment variables and URLs ignored", actual.length === expected.length, actual);
    check("scripts: exact token ranges", actual.every((d) => expected.includes(d.value)), actual);

    // Cover the article examples that must not be flagged as broken.
    const keys = new Set();
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      for (const d of diagnostics) {
        if (d.source === "PathMend") {
          const relative = path.relative(ws, uri.fsPath).split(path.sep).join("/");
          keys.add(relative + ":" + (d.range.start.line + 1) + ":" + d.code);
        }
      }
    }
    check("workflows: missing bash script diagnosed", keys.has(".github/workflows/ci.yml:28:PM005"));
    check("workflows: existing script and package commands not flagged",
      ![25, 27, 29, 30, 31, 32, 33, 34].some((line) => keys.has(".github/workflows/ci.yml:" + line + ":PM005")));
    check("Docker: stage, variable and URL sources ignored",
      ![7, 8, 9].some((line) => keys.has("Dockerfile:" + line + ":PM003")));
    check("Compose: remote context and variable ignored",
      ![14, 17].some((line) => keys.has("docker-compose.yml:" + line + ":PM004")));
    check("package: build output reference not diagnosed", !keys.has("package.json:7:PM001"));

    // Let someone watching the editor inspect the script examples as well.
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(pkgPath));
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand("workbench.view.extension.pathmend");
    } catch (error) {
      console.warn("Could not show script use cases:", error.message);
    }
  } finally {
    // Restore the copied tracked fixture; never modify the repository fixture.
    fs.writeFileSync(pkgPath, original);
    await api.rebuildIndex();
  }
}

module.exports = { runScriptCases };
