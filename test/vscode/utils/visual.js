"use strict";

// VS Code editor presentation and optional screenshot synchronization.
// These helpers must never determine functional test pass/fail.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch (_) {
      v = undefined;
    }
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(100);
  }
}

async function screenshot(cfg, name) {
  if (!cfg.screenshotsEnabled) return;
  // Screenshots are diagnostic artifacts, not test assertions. Wait for the
  // runner's acknowledgment so each image corresponds to the requested state.
  const done = path.join(cfg.shotDir, "shot-done-" + cfg.mode + "-" + name);
  const request = path.join(cfg.shotDir, "shot-" + cfg.mode + "-" + name);
  try {
    fs.writeFileSync(request, "1");
    const completed = await waitFor(() => fs.existsSync(done), 20000);
    if (!completed) {
      console.warn("Screenshot timed out: " + name);
      return;
    }
    if (fs.readFileSync(done, "utf8") !== "ok") {
      console.warn("Screenshot unavailable: " + name);
    }
    fs.unlinkSync(done);
  } catch (error) {
    console.warn("Screenshot skipped (" + name + "): " + error.message);
  }
}

// Prepare only the *presentation* for a screenshot. Functional checks above
// verify the actual state; these commands must never determine test pass/fail.
async function screenshotEditor(ws, file, line) {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ws, file)));
  const position = new vscode.Position(Math.min(line, document.lineCount - 1), 0);
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false,
    selection: new vscode.Range(position, position),
  });
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

async function screenshotView() {
  // Opening PathMend is sufficient: its file-group TreeItems already default
  // to CollapsibleState.Expanded. There is no public list.expandAll command.
  await vscode.commands.executeCommand("workbench.view.extension.pathmend");
}

// These are presentation checkpoints, not tests. Keep their layout details
// here so index.js remains focused on PathMend behavior.
async function showState(name, ws) {
  switch (name) {
    case "diagnostics-panel":
      await screenshotEditor(ws, "Dockerfile", 5);
      await screenshotView();
      await vscode.commands.executeCommand("workbench.actions.view.problems");
      break;
    case "after-inline-fix":
      await screenshotEditor(ws, "Dockerfile", 5);
      await screenshotView();
      break;
    case "after-folder-rename":
      await screenshotEditor(ws, "packages/app/tsconfig.json", 6);
      await screenshotView();
      break;
    case "ignored-rename":
      await screenshotEditor(ws, "package.json", 8);
      await screenshotView();
      break;
    case "untrusted-panel":
      await screenshotEditor(ws, "Dockerfile", 5);
      await screenshotView();
      break;
    case "empty-state":
    case "disabled-state":
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await screenshotView();
      break;
    default:
      throw new Error("Unknown visual checkpoint: " + name);
  }
}

async function captureState(cfg, name, ws) {
  // Editor transitions remain watchable when Playwright is disabled or missing.
  try {
    await showState(name, ws);
  } catch (error) {
    console.warn("Could not show test state (" + name + "):", error.message);
  }
  if (cfg.screenshotsEnabled) {
    await sleep(500);
    await screenshot(cfg, name);
  }
  if (name === "diagnostics-panel") {
    // The Problems panel should not obscure subsequent editor interactions.
    try {
      await vscode.commands.executeCommand("workbench.action.closePanel");
    } catch (error) {
      console.warn("Could not close Problems panel after checkpoint:", error.message);
    }
  }
}

module.exports = { sleep, waitFor, captureState };
