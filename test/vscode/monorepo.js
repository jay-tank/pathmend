"use strict";

// Check actual PathMend behavior: a VS Code file rename updates references
// inside package.json scripts and bin. No commands/scripts are executed.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { waitFor } = require("./utils/visual");

async function runMonorepoCases(check, cfg) {
  const ws = fs.realpathSync(cfg.ws);
  const dir = path.join(ws, "packages", "script-cases");
  const manifest = path.join(dir, "package.json");
  const oldFile = path.join(dir, "scripts", "build-registry.ts");
  const newFile = path.join(dir, "scripts", "registry-cli.ts");
  const api = await vscode.extensions.getExtension("jaytankdev.pathmend").activate();
  const originalInfo = vscode.window.showInformationMessage;
  const original = fs.readFileSync(manifest, "utf8");
  let intercepted = false;
  const read = () => JSON.parse(fs.readFileSync(manifest, "utf8"));

  try {
    await api.rebuildIndex();
    const manifestDiagnostics = () => vscode.languages.getDiagnostics(vscode.Uri.file(manifest))
      .filter((d) => d.source === "PathMend");
    check("rename: initial script and bin references resolve", manifestDiagnostics().length === 0,
      manifestDiagnostics().map((d) => d.message));

    // The same real VS Code rename API used by the main integration suite.
    try {
      vscode.window.showInformationMessage = (message, ...items) => {
        if (typeof message === "string" && /config reference/.test(message)) {
          return Promise.resolve("Update all");
        }
        return originalInfo.call(vscode.window, message, ...items);
      };
      intercepted = vscode.window.showInformationMessage !== originalInfo;
    } catch (_) {
      intercepted = false;
    }
    check("rename: update confirmation can be automated", intercepted);
    if (!intercepted) return;

    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(oldFile), vscode.Uri.file(newFile));
    const renamed = await vscode.workspace.applyEdit(edit);
    check("rename: VS Code renames referenced script file", renamed);
    if (!renamed) return;

    const prompt = await waitFor(() => {
      const plan = api.getLastRenamePlan() || [];
      return plan.some((item) => item.ref.file === manifest) && api.getLastPrompt();
    }, 10000);
    check("rename: PathMend offers to update references", !!prompt, prompt);
    const plan = (api.getLastRenamePlan() || [])
      .filter((item) => item.ref.file === manifest)
      .map((item) => item.newText);
    check("rename: bin and both script entries are included",
      plan.length === 3 && plan.includes("./scripts/registry-cli.ts") &&
      plan.filter((value) => value === "scripts/registry-cli.ts").length === 2, plan);

    const applied = prompt && await Promise.race([
      prompt.done,
      new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
    ]);
    check("rename: Update all applies changes", applied === true, applied);
    const updated = read();
    check("rename: bin path rewritten", updated.bin["build-registry"] === "./scripts/registry-cli.ts",
      updated.bin);
    check("rename: script operands rewritten without changing commands",
      updated.scripts["registry:build"] === "node scripts/registry-cli.ts --check" &&
      updated.scripts["registry:check"] === "node scripts/registry-cli.ts" &&
      updated.scripts.other === "npm run registry:build", updated.scripts);
    await api.scan();
    check("rename: no broken references after update", manifestDiagnostics().length === 0,
      manifestDiagnostics().map((d) => d.message));

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(manifest));
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand("workbench.view.extension.pathmend");
    } catch (error) {
      console.warn("Could not display rename test:", error.message);
    }
  } finally {
    if (intercepted) vscode.window.showInformationMessage = originalInfo;
    // Restore the isolated copy so other tests see the original tracked fixture.
    fs.writeFileSync(manifest, original);
    if (fs.existsSync(newFile) && !fs.existsSync(oldFile)) fs.renameSync(newFile, oldFile);
    await api.rebuildIndex();
  }
}

module.exports = { runMonorepoCases };
