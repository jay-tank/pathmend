"use strict";

// Launches a real, isolated VS Code window with PathMend loaded from this folder and runs
// test/vscode/index.js inside it: once trusted (full suite), once in an untrusted workspace
// (PathMend supports untrusted workspaces, so it must still work there). In the trusted run the
// test asks for a screenshot of the (hidden) display with the PathMend view open; it is saved
// as <tmpBaseDir>/pathmend-panel.png.
// Usage: node test/run-vscode.js [tmpBaseDir]

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { prepare } = require("./prepare");

const extDir = path.resolve(__dirname, "..");
const base = fs.realpathSync(fs.mkdtempSync(path.join(process.argv[2] || os.tmpdir(), "pm-vscode-")));
const userDir = path.join(base, "user");
const extsDir = path.join(base, "exts");
fs.mkdirSync(path.join(userDir, "User"), { recursive: true });
fs.mkdirSync(extsDir, { recursive: true });
const settingsPath = path.join(userDir, "User", "settings.json");
const resultFile = path.join(base, "results.json");
const cfgFile = path.join(base, "config.json");
const shotDir = path.join(base, "shots");
fs.mkdirSync(shotDir);
const shot = path.join(process.argv[2] ? path.resolve(process.argv[2]) : base, "pathmend-panel.png");

function writeSettings(trustEnabled) {
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      "security.workspace.trust.enabled": trustEnabled,
      "security.workspace.trust.startupPrompt": "never",
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "workbench.startupEditor": "none",
      "git.enabled": false,
      "window.restoreWindows": "none",
      // Unique title so the screenshot finds this window even when other windows share the display.
      "window.title": "pathmend-shot ${rootName}",
      "chat.commandCenter.enabled": false,
      "workbench.secondarySideBar.defaultVisibility": "hidden",
    }, null, 2)
  );
}

async function launch(mode, extraArgs) {
  const fx = prepare(path.join(base, mode, "fx"));
  fs.writeFileSync(cfgFile, JSON.stringify({ mode, resultFile, shotDir, ws: fx.ws, outside: fx.outside }));
  const args = [
    "--wait", "--new-window",
    "--user-data-dir", userDir,
    "--extensions-dir", extsDir,
    "--disable-extensions",
    ...extraArgs,
    "--skip-welcome", "--skip-release-notes",
    "--extensionDevelopmentPath=" + extDir,
    "--extensionTestsPath=" + path.join(__dirname, "vscode", "index.js"),
    fx.ws,
  ];
  console.log("code " + args.join(" "));
  const child = spawn("code", args, { stdio: "inherit", env: Object.assign({}, process.env, { PM_TEST_CONFIG: cfgFile }) });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const killer = setTimeout(() => child.kill("SIGKILL"), 300000);
  const poll = setInterval(() => {
    const want = path.join(shotDir, "shot-" + mode);
    if (!fs.existsSync(want)) return;
    fs.unlinkSync(want);
    try {
      const display = process.env.DISPLAY || ":99";
      let win = "root";
      try {
        const ids = execFileSync("xdotool", ["search", "--name", "pathmend-shot"], { env: Object.assign({}, process.env, { DISPLAY: display }) }).toString().trim().split(/\s+/).filter(Boolean);
        if (ids.length) {
          win = ids[ids.length - 1];
          execFileSync("xdotool", ["windowraise", win], { env: Object.assign({}, process.env, { DISPLAY: display }) });
          execFileSync("sleep", ["1"]);
        }
      } catch (_) {
        win = "root";
      }
      execFileSync("import", ["-window", win, "-display", display, shot]);
      console.log("screenshot: " + shot);
    } catch (e) {
      console.log("screenshot failed: " + e.message);
    }
    fs.writeFileSync(path.join(shotDir, "shot-done-" + mode), "1");
  }, 300);
  const status = await exited;
  clearTimeout(killer);
  clearInterval(poll);
  console.log("code exit status:", status);
  if (!fs.existsSync(resultFile)) {
    console.log("FAIL: no results written");
    return { passed: 0, failed: 1, results: [] };
  }
  const res = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  fs.unlinkSync(resultFile);
  for (const t of res.results) console.log((t.ok ? "PASS " : "FAIL ") + t.name + (t.detail !== undefined ? " :: " + JSON.stringify(t.detail) : ""));
  return res;
}

(async () => {
  writeSettings(false);
  const r1 = await launch("trusted", ["--disable-workspace-trust"]);
  writeSettings(true);
  const r2 = await launch("untrusted", []);
  const passed = r1.passed + r2.passed;
  const failed = r1.failed + r2.failed;
  console.log(`\nin-editor tests: ${passed} passed, ${failed} failed (trusted run ${r1.passed}/${r1.passed + r1.failed}, untrusted run ${r2.passed}/${r2.passed + r2.failed})`);
  if (!failed) fs.rmSync(base, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
