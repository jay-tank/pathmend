"use strict";
// Runs inside a real VS Code extension host (--extensionTestsPath), started by
// test/run-vscode.js. Asserts exact diagnostics, the activity bar view (rows, badge, open and
// fix commands, empty states), the Quick Fix, the rename prompt driven by onDidRenameFiles,
// settings, the polling fallback, and that no fs call made by PathMend leaves the workspace.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const expected = require("../expected");

const EXT_DIR = path.resolve(__dirname, "..", "..");
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

function diagList(ws) {
  const out = [];
  for (const [uri, list] of vscode.languages.getDiagnostics()) {
    for (const d of list) {
      if (d.source !== "PathMend") continue;
      out.push({ key: path.relative(ws, uri.fsPath).split(path.sep).join("/") + ":" + (d.range.start.line + 1) + ":" + d.code, d, uri });
    }
  }
  return out;
}

function diff(got, exp) {
  const extra = got.slice();
  const missing = [];
  for (const e of exp) {
    const i = extra.indexOf(e);
    if (i >= 0) extra.splice(i, 1);
    else missing.push(e);
  }
  return { extra, missing };
}

const withTimeout = (p, ms) => Promise.race([Promise.resolve(p), sleep(ms).then(() => "timeout")]);
/** Code actions at a range; VS Code cancels the request when a rescan changes diagnostics meanwhile, so retry. */
async function codeActions(uri, range) {
  for (let i = 0; ; i++) {
    try {
      return (await vscode.commands.executeCommand("vscode.executeCodeActionProvider", uri, range)) || [];
    } catch (e) {
      if (i >= 5 || !/Canceled/.test(String(e))) throw e;
      await sleep(300);
    }
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function run() {
  const cfg = JSON.parse(fs.readFileSync(process.env.PM_TEST_CONFIG, "utf8"));
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: ok ? undefined : detail === undefined ? null : detail });
  try {
    if (cfg.mode === "untrusted") await untrusted(check, cfg);
    else await body(check, cfg);
  } catch (e) {
    check("no exception", false, String(e && e.stack));
  }
  const passed = results.filter((r) => r.ok).length;
  const out = { passed, failed: results.length - passed, total: results.length, results };
  fs.writeFileSync(cfg.resultFile, JSON.stringify(out, null, 2));
  if (out.failed) throw new Error(out.failed + " PathMend checks failed");
}

/** All rows of the view: [{ group, label, item, node }]. */
function rows(api) {
  const out = [];
  for (const g of api.getChildren()) {
    const gi = api.getTreeItem(g);
    for (const n of api.getChildren(g)) out.push({ group: gi.label, groupItem: gi, label: api.getTreeItem(n).label, item: api.getTreeItem(n), node: n });
  }
  return out;
}

async function activate() {
  const ext = vscode.extensions.getExtension("jaytankdev.pathmend");
  const api = await ext.activate();
  await api.ready;
  return { ext, api };
}

// ---------------------------------------------------------------------------------------------
// Untrusted workspace: PathMend declares full support, so everything read-only must still work.
// ---------------------------------------------------------------------------------------------
async function untrusted(check, cfg) {
  const ws = fs.realpathSync(cfg.ws);
  check("untrusted: workspace is not trusted", vscode.workspace.isTrusted === false);
  const { ext, api } = await activate();
  check("untrusted: extension active", ext.isActive);
  await api.rebuildIndex();
  const d = diff(diagList(ws).map((x) => x.key), expected);
  check("untrusted: exact diagnostics", !d.extra.length && !d.missing.length, d);
  await vscode.commands.executeCommand("workbench.view.extension.pathmend");
  const broken = api.getFindings().filter((f) => !f.info).length;
  check("untrusted: view has rows", rows(api).length === expected.length, rows(api).length);
  check("untrusted: badge = broken references", api.getBadge() === broken && broken > 0, [api.getBadge(), broken]);
  const row = rows(api).find((r) => r.group === "Dockerfile" && r.label === "PM003  scripts/start.sh");
  const opened = row && (await vscode.commands.executeCommand(row.item.command.command, ...row.item.command.arguments));
  const ed = vscode.window.activeTextEditor;
  check("untrusted: row opens Dockerfile at the line", opened === true && ed && ed.document.uri.fsPath === path.join(ws, "Dockerfile") && ed.selection.start.line === 5);
  const forged = await vscode.commands.executeCommand("pathmend.openReference", { file: path.join(cfg.outside, "secret.txt"), line: 0, col: 0, code: "PM003" });
  check("untrusted: forged open rejected", forged === false);
}

// ---------------------------------------------------------------------------------------------
// Trusted run: everything.
// ---------------------------------------------------------------------------------------------
async function body(check, cfg) {
  const ws = fs.realpathSync(cfg.ws);
  const outside = cfg.outside;
  check("workspace trust disabled (trusted)", vscode.workspace.isTrusted === true);
  const { ext, api } = await activate();
  check("extension found", !!ext);

  // ---- fs spy ---------------------------------------------------------------
  const calls = [];
  const names = ["statSync", "lstatSync", "readlinkSync", "realpathSync", "readFileSync", "existsSync", "accessSync", "openSync", "readdirSync", "stat", "lstat", "readFile", "readdir", "open", "access", "createReadStream"];
  const orig = {};
  const mine = /[\\/]pathmend[\\/](core|extension)\.js/;
  for (const n of names) {
    if (typeof fs[n] !== "function") continue;
    orig[n] = fs[n];
    fs[n] = function (p, ...rest) {
      const st = new Error().stack || "";
      if (st.split("\n").some((l) => mine.test(l) && l.includes(EXT_DIR))) calls.push({ fn: n, p: String(p) });
      return orig[n].call(this, p, ...rest);
    };
  }
  const pnames = ["stat", "lstat", "readFile", "readdir", "open", "access", "realpath", "readlink"];
  const porig = {};
  for (const n of pnames) {
    porig[n] = fs.promises[n];
    fs.promises[n] = function (p, ...rest) {
      const st = new Error().stack || "";
      if (st.includes(path.join(EXT_DIR, "core.js")) || st.includes(path.join(EXT_DIR, "extension.js"))) calls.push({ fn: "promises." + n, p: String(p) });
      return porig[n].call(this, p, ...rest);
    };
  }

  await api.rebuildIndex();

  // ---- exact diagnostics -----------------------------------------------------
  let list = diagList(ws);
  let d = diff(list.map((x) => x.key), expected);
  check("exact diagnostics (" + expected.length + " expected)", !d.extra.length && !d.missing.length, d);

  const byKey = (k) => list.find((x) => x.key === k);
  const h = byKey("hostile/package.json:3:PM010");
  check("PM010 is Information and says not checked", h && h.d.severity === vscode.DiagnosticSeverity.Information && /outside the workspace - not checked/.test(h.d.message), h && h.d.message);
  const b = byKey("package.json:9:PM001");
  check("broken ref severity is Warning by default", b && b.d.severity === vscode.DiagnosticSeverity.Warning);
  check("diagnostic range covers the exact path string", b && b.d.range.start.character === 13 && b.d.range.end.character === 24, b && b.d.range);
  const cont = byKey("Dockerfile:16:PM003");
  check("continuation-line COPY source range", cont && cont.d.range.start.character === 5 && cont.d.range.end.character === 16, cont && cont.d.range);
  const tr = byKey("packages/app/tsconfig.json:13:PM002");
  check("tsconfig typeRoots checked relative to the tsconfig", tr && /"\.\/types"/.test(tr.d.message) && /typeRoots/.test(tr.d.message), tr && tr.d.message);
  const tp = byKey("packages/app/tsconfig.json:9:PM002");
  check("tsconfig paths checked against the inherited baseUrl", tp && /paths\["@typo"\]/.test(tp.d.message), tp && tp.d.message);
  check("tsconfig paths: package extends is not guessed", !list.some((x) => x.key.startsWith("packages/pkgext/")));

  // ---- fs confinement --------------------------------------------------------
  const inside = (p) => {
    const r = path.relative(ws, path.resolve(p));
    return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
  };
  const bad = calls.filter((c) => !inside(c.p));
  check("fs spy saw PathMend calls", calls.length > 50, calls.length);
  check("zero fs calls outside the workspace", bad.length === 0, bad.slice(0, 20));
  check("outside secret folder never touched", outside && !calls.some((c) => c.p.startsWith(outside)), outside);
  check("no call on /etc", !calls.some((c) => c.p.startsWith("/etc")));
  check("only config files are read", calls.filter((c) => /readFile/.test(c.fn)).every((c) => /(package\.json|tsconfig[^/]*\.json|Dockerfile|\.ya?ml|CODEOWNERS|launch\.json)$/.test(c.p)), calls.filter((c) => /readFile/.test(c.fn)).map((c) => c.p));
  check("symlinked tsconfig (to outside) not read", !calls.some((c) => /readFile/.test(c.fn) && c.p.endsWith(path.join("hostile", "tsconfig.json"))));
  check("huge package.json not read", !calls.some((c) => /readFile/.test(c.fn) && c.p.includes(path.join("hostile", "huge"))));
  check("config found through symlinked folder not reported", !list.some((x) => x.key.startsWith("hostile/linkout/")));
  for (const n of Object.keys(orig)) fs[n] = orig[n];
  for (const n of Object.keys(porig)) fs.promises[n] = porig[n];

  // ---- activity bar view -------------------------------------------------------
  const pkg = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "package.json"), "utf8"));
  const cont0 = (pkg.contributes.viewsContainers.activitybar || []).find((c) => c.id === "pathmend");
  check("activity bar container contributed with icon", cont0 && cont0.title === "PathMend" && fs.existsSync(path.join(EXT_DIR, cont0.icon)) && /<svg/.test(fs.readFileSync(path.join(EXT_DIR, cont0.icon), "utf8")), cont0);
  check("view lives in the container", (pkg.contributes.views.pathmend || []).some((v) => v.id === "pathmend.references"));
  check("onView activation", pkg.activationEvents.includes("onView:pathmend.references"));
  await vscode.commands.executeCommand("workbench.view.extension.pathmend");
  const visible = await waitFor(() => api.isViewVisible(), 5000);
  check("view opens", visible);

  let all = rows(api);
  const broken = () => api.getFindings().filter((f) => !f.info).length;
  check("one row per finding", all.length === expected.length, all.length);
  const groups = api.getChildren().map((g) => api.getTreeItem(g).label);
  check("rows grouped by config file, sorted", same(groups, groups.slice().sort((a, b) => a.localeCompare(b))) && groups.includes("Dockerfile") && groups.includes(".github/workflows/ci.yml"), groups);
  const start = all.find((r) => r.group === "Dockerfile" && r.label === "PM003  scripts/start.sh");
  check("row label names the exact broken path (PM003  scripts/start.sh)", !!start, all.filter((r) => r.group === "Dockerfile").map((r) => r.label));
  check("every row label is CODE + two spaces + path", all.every((r) => /^PM0\d\d {2}\S/.test(r.label)), all.map((r) => r.label).filter((l) => !/^PM0\d\d {2}\S/.test(l)));
  const dupes = all.filter((r, i) => all.findIndex((x) => x.group === r.group && x.label === r.label && x.item.description === r.item.description) !== i);
  check("rows in a group are distinguishable without hovering", dupes.length === 0, dupes.map((r) => r.group + " " + r.label));
  check("row description = rule title + line", start && start.item.description === "Dockerfile COPY / ADD source not found (line 6)", start && start.item.description);
  check("row tooltip = message + file:line + fix", start && /Dockerfile:6/.test(start.item.tooltip) && /Path not found: "scripts\/start\.sh"/.test(start.item.tooltip) && /did you mean "tools\/start\.sh"/.test(start.item.tooltip), start && start.item.tooltip);
  check("severity codicons (warning for broken, info for PM010)", start && start.item.iconPath.id === "warning" && all.filter((r) => /^PM010/.test(r.label)).every((r) => r.item.iconPath.id === "info"));
  check("fixable rows get the inline fix action", start && start.item.contextValue === "finding.fixable" && all.some((r) => r.item.contextValue === "finding"));
  check("file group shows a count and the file icon", start && /\d+ broken/.test(start.groupItem.description) && start.groupItem.resourceUri && start.groupItem.resourceUri.fsPath === path.join(ws, "Dockerfile"), start && start.groupItem.description);
  check("badge = broken references", api.getBadge() === broken() && broken() > 0, [api.getBadge(), broken()]);
  const tsRow = all.find((r) => r.group === "packages/app/tsconfig.json" && r.label === "PM002  ./types");
  check("tsconfig typeRoots row labelled with the path", !!tsRow, all.filter((r) => r.group === "packages/app/tsconfig.json").map((r) => r.label));

  // ---- screenshot of the panel ----------------------------------------------------
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await vscode.commands.executeCommand("workbench.view.extension.pathmend");
  await sleep(6000);
  fs.writeFileSync(path.join(cfg.shotDir, "shot-trusted"), "1");
  const shotDone = await waitFor(() => fs.existsSync(path.join(cfg.shotDir, "shot-done-trusted")), 20000);
  check("screenshot taken", shotDone);

  // ---- open command ------------------------------------------------------------------
  const openRes = await vscode.commands.executeCommand(start.item.command.command, ...start.item.command.arguments);
  let ed = vscode.window.activeTextEditor;
  check("row click opens the config file at the exact path", openRes === true && ed && ed.document.uri.fsPath === path.join(ws, "Dockerfile") && ed.selection.start.line === 5 && ed.selection.start.character === 5 && ed.selection.end.character === 21, ed && [ed.document.uri.fsPath, ed.selection.start, ed.selection.end]);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const forged = [
    { file: path.join(outside, "secret.txt"), line: 0, col: 0, code: "PM003" },
    { file: path.join(ws, "Dockerfile"), line: 5, col: 5, code: "PM999" },
    { file: path.join(ws, "Dockerfile"), line: "5", col: 5, code: "PM003" },
    { file: path.join(ws, "hostile", "linkout", "secret.txt"), line: 0, col: 0, code: "PM010" },
    "/etc/passwd",
    undefined,
  ];
  const forgedRes = [];
  for (const a of forged) forgedRes.push(await vscode.commands.executeCommand("pathmend.openReference", a));
  check("open command rejects forged and outside arguments", forgedRes.every((r) => r === false), forgedRes);
  check("nothing outside the workspace was opened", !vscode.workspace.textDocuments.some((dd) => dd.uri.scheme === "file" && !inside(dd.uri.fsPath)), vscode.workspace.textDocuments.map((dd) => dd.uri.fsPath));

  // ---- inline fix action -------------------------------------------------------------
  const before = api.getBadge();
  const fixRes = await vscode.commands.executeCommand("pathmend.applyFix", start.node);
  const dockerText = fs.readFileSync(path.join(ws, "Dockerfile"), "utf8");
  check("inline fix rewrote only that path and saved", fixRes === true && /^COPY tools\/start\.sh \/usr\/local\/bin\/start\.sh$/m.test(dockerText) && !/scripts\/start\.sh/.test(dockerText), dockerText.split("\n")[5]);
  check("badge drops by one after the fix", api.getBadge() === before - 1, [before, api.getBadge()]);
  check("row gone after the fix", !rows(api).some((r) => r.group === "Dockerfile" && r.label === "PM003  scripts/start.sh"));
  const forgedFix = await vscode.commands.executeCommand("pathmend.applyFix", { file: path.join(ws, "Dockerfile"), line: 5, col: 5, code: "PM003" });
  const noFix = await vscode.commands.executeCommand("pathmend.applyFix", rows(api).find((r) => r.item.contextValue === "finding").node);
  check("fix command rejects stale and unfixable rows", forgedFix === false && noFix === false, [forgedFix, noFix]);
  let afterFix = expected.filter((k) => k !== "Dockerfile:6:PM003");

  // ---- Quick Fix ---------------------------------------------------------------------
  await api.scan();
  await sleep(500);
  const pkgUri = vscode.Uri.file(path.join(ws, "package.json"));
  const pkgDoc = await vscode.workspace.openTextDocument(pkgUri);
  const actions = await codeActions(pkgUri, b.d.range);
  const actionsAt = async (rel, key) => {
    const uri = vscode.Uri.file(path.join(ws, rel));
    await vscode.workspace.openTextDocument(uri);
    const x = byKey(key);
    if (!x) return [];
    return codeActions(uri, x.d.range);
  };
  const fix = (actions || []).find((a) => a.title === 'Did you mean "lib/tool.js"?');
  check('Quick Fix offered: Did you mean "lib/tool.js"?', !!fix, (actions || []).map((a) => a.title));
  const ts = await actionsAt("tsconfig.build.json", "tsconfig.build.json:2:PM002");
  check("Quick Fix for typo extends", (ts || []).some((a) => a.title === 'Did you mean "./tsconfig.base.json"?'), (ts || []).map((a) => a.title));
  const lj = await actionsAt(".vscode/launch.json", ".vscode/launch.json:6:PM007");
  check("Quick Fix keeps ${workspaceFolder}", (lj || []).some((a) => a.title === 'Did you mean "${workspaceFolder}/src/app/server.js"?'), (lj || []).map((a) => a.title));
  const ad = await actionsAt("docker/app.Dockerfile", "docker/app.Dockerfile:3:PM003");
  check("Quick Fix relative to compose build context", (ad || []).some((a) => a.title === 'Did you mean "docker/app-only.txt"?'), (ad || []).map((a) => a.title));
  const tsq = await actionsAt("packages/app/tsconfig.json", "packages/app/tsconfig.json:13:PM002");
  check("Quick Fix for typeRoots", (tsq || []).some((a) => a.title === 'Did you mean "../../types"?'), (tsq || []).map((a) => a.title));
  if (fix) {
    await vscode.workspace.applyEdit(fix.edit);
    await pkgDoc.save();
    check("Quick Fix edited only the path", pkgDoc.lineAt(8).text === '    "tool": "lib/tool.js"', pkgDoc.lineAt(8).text);
  }
  await api.scan();
  list = diagList(ws);
  afterFix = afterFix.filter((k) => k !== "package.json:9:PM001");
  d = diff(list.map((x) => x.key), afterFix);
  check("diagnostic gone after Quick Fix", !d.extra.length && !d.missing.length, d);

  // ---- rename: the real onDidRenameFiles -> prompt -> "Update all" path ---------------------
  const prompts = [];
  let answer = "Update all";
  const origInfo = vscode.window.showInformationMessage;
  let stubbed = false;
  try {
    vscode.window.showInformationMessage = (msg, ...items) => {
      if (typeof msg === "string" && /config reference/.test(msg)) {
        prompts.push({ msg, items });
        return Promise.resolve(answer);
      }
      return origInfo.call(vscode.window, msg, ...items);
    };
    stubbed = vscode.window.showInformationMessage !== origInfo;
  } catch (_) {
    stubbed = false;
  }
  check("prompt can be answered by the test", stubbed);
  const read = (f) => fs.readFileSync(path.join(ws, f), "utf8");

  let re = new vscode.WorkspaceEdit();
  re.renameFile(vscode.Uri.file(path.join(ws, "src", "utils")), vscode.Uri.file(path.join(ws, "src", "common")));
  check("folder rename applied", await vscode.workspace.applyEdit(re));
  const p1 = await waitFor(() => prompts[0], 10000);
  check(
    "onDidRenameFiles prompts: 4 config references still point to src/utils - update all?",
    p1 && p1.msg === "4 config references still point to src/utils - update all?" && same(p1.items, ["Update all", "Preview", "Ignore"]),
    p1
  );
  const planFiles = (api.getLastRenamePlan() || []).map((p) => path.relative(ws, p.ref.file) + " -> " + p.newText).sort();
  check(
    "rename plan: 4 references in 4 config files",
    same(planFiles, ["Dockerfile -> src/common", "package.json -> ./src/common/helpers.js", "packages/app/tsconfig.json -> src/common/*", "tsconfig.json -> src/common/helpers.js"]),
    planFiles
  );
  const done1 = api.getLastPrompt() && (await withTimeout(api.getLastPrompt().done, 15000));
  check('"Update all" applied the edits', done1 === true, done1);
  check("package.json updated", /"\.\/helpers": "\.\/src\/common\/helpers\.js"/.test(read("package.json")));
  check("tsconfig.json updated", /"src\/common\/helpers\.js"/.test(read("tsconfig.json")) && !/src\/utils/.test(read("tsconfig.json")));
  check("tsconfig paths updated", /"@utils\/\*": \["src\/common\/\*"\]/.test(read("packages/app/tsconfig.json")));
  check("Dockerfile continuation line updated", /^COPY src\/common \\$/m.test(read("Dockerfile")));
  check("updated files saved (no dirty editors)", !vscode.workspace.textDocuments.some((dd) => dd.isDirty), vscode.workspace.textDocuments.filter((dd) => dd.isDirty).map((dd) => dd.uri.fsPath));
  await api.scan();
  list = diagList(ws);
  d = diff(list.map((x) => x.key), afterFix);
  check("no diagnostics left from the folder rename", !d.extra.length && !d.missing.length, d);

  // File rename, answered "Ignore": nothing edited, the references show up as broken.
  answer = "Ignore";
  re = new vscode.WorkspaceEdit();
  re.renameFile(vscode.Uri.file(path.join(ws, "lib", "tool.js")), vscode.Uri.file(path.join(ws, "lib", "cli.js")));
  check("file rename applied", await vscode.workspace.applyEdit(re));
  const p2 = await waitFor(() => prompts[1], 10000);
  check("file rename prompts for 3 references (bin, COPY, tsconfig paths via .js)", p2 && p2.msg === "3 config references still point to lib/tool.js - update all?", p2);
  const done2 = api.getLastPrompt() && (await withTimeout(api.getLastPrompt().done, 15000));
  check('"Ignore" edits nothing', done2 === false && /"tool": "lib\/tool\.js"/.test(read("package.json")) && /"@tool": \["lib\/tool"\]/.test(read("packages/app/tsconfig.json")));
  await api.scan();
  d = diff(diagList(ws).map((x) => x.key), afterFix);
  check("ignored rename leaves exactly those references broken", same(d.extra.sort(), ["Dockerfile:20:PM003", "package.json:9:PM001", "packages/app/tsconfig.json:7:PM002"]) && !d.missing.length, d);
  const cliRow = rows(api).find((r) => r.group === "package.json" && r.label === "PM001  lib/tool.js");
  check("panel shows the stale reference by its path", cliRow && /package\.json:9/.test(cliRow.item.tooltip), cliRow && cliRow.item.tooltip);

  // renameUpdates = off: plan computed, no prompt. Renaming back clears the diagnostics.
  await vscode.workspace.getConfiguration("pathmend").update("renameUpdates", "off", vscode.ConfigurationTarget.Workspace);
  await sleep(200);
  const nPrompts = prompts.length;
  re = new vscode.WorkspaceEdit();
  re.renameFile(vscode.Uri.file(path.join(ws, "lib", "cli.js")), vscode.Uri.file(path.join(ws, "lib", "tool.js")));
  check("rename back applied", await vscode.workspace.applyEdit(re));
  await waitFor(() => !diagList(ws).some((x) => x.key === "package.json:9:PM001"), 10000);
  await sleep(500);
  check("renameUpdates=off: no prompt", prompts.length === nPrompts, prompts.slice(nPrompts));
  await api.scan();
  d = diff(diagList(ws).map((x) => x.key), afterFix);
  check("renaming back clears the broken references", !d.extra.length && !d.missing.length, d);
  await vscode.workspace.getConfiguration("pathmend").update("renameUpdates", undefined, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage = origInfo;

  // ---- save path and polling fallback (file watchers may not fire on this machine) ----------
  const coUri = vscode.Uri.file(path.join(ws, ".github", "CODEOWNERS"));
  const coDoc = await vscode.workspace.openTextDocument(coUri);
  const we = new vscode.WorkspaceEdit();
  we.replace(coUri, new vscode.Range(3, 0, 3, "/docs/guid.md".length), "/docs/guide.md");
  await vscode.workspace.applyEdit(we);
  await coDoc.save();
  const savedOk = await waitFor(() => !diagList(ws).some((x) => x.key === ".github/CODEOWNERS:4:PM006"), 5000);
  check("saving a config file rescans by itself", savedOk);
  afterFix = afterFix.filter((k) => k !== ".github/CODEOWNERS:4:PM006");
  fs.writeFileSync(path.join(ws, "src", "missing.ts"), "export {};\n"); // created outside VS Code
  await api.poll();
  check("poll picks up a file created outside VS Code", !diagList(ws).some((x) => x.key === "tsconfig.json:7:PM002"));
  fs.unlinkSync(path.join(ws, "src", "missing.ts"));
  await api.poll();
  check("poll picks up a file deleted outside VS Code", diagList(ws).some((x) => x.key === "tsconfig.json:7:PM002"));

  // ---- settings ------------------------------------------------------------------
  const conf = vscode.workspace.getConfiguration("pathmend");
  await conf.update("disabledRules", ["PM006", "PM010"], vscode.ConfigurationTarget.Workspace);
  await sleep(200);
  await api.scan();
  list = diagList(ws);
  check("disabledRules hides PM006 and PM010", !list.some((x) => x.d.code === "PM006" || x.d.code === "PM010") && list.length > 0);
  check("view follows disabledRules", !rows(api).some((r) => /^PM00[6]|^PM010/.test(r.label)) && rows(api).length === list.length);
  await conf.update("disabledRules", ["PM001", "PM002", "PM003", "PM004", "PM005", "PM006", "PM007", "PM008", "PM009", "PM010", "PM011"], vscode.ConfigurationTarget.Workspace);
  await sleep(200);
  await api.scan();
  check("empty state: nothing to show -> no rows, no badge (welcome text shows)", api.getChildren().length === 0 && api.getBadge() === 0);
  await conf.update("disabledRules", undefined, vscode.ConfigurationTarget.Workspace);
  await conf.update("severity", "error", vscode.ConfigurationTarget.Workspace);
  await sleep(200);
  await api.scan();
  list = diagList(ws);
  check(
    "severity=error applies to broken refs, PM010 stays Information",
    list.filter((x) => x.d.code !== "PM010").every((x) => x.d.severity === vscode.DiagnosticSeverity.Error) &&
      list.filter((x) => x.d.code === "PM010").every((x) => x.d.severity === vscode.DiagnosticSeverity.Information)
  );
  check("view icons follow severity=error", rows(api).filter((r) => !/^PM010/.test(r.label)).every((r) => r.item.iconPath.id === "error"));
  await conf.update("severity", undefined, vscode.ConfigurationTarget.Workspace);
  await conf.update("enabled", false, vscode.ConfigurationTarget.Workspace);
  await sleep(200);
  await api.scan();
  check("enabled=false clears diagnostics", diagList(ws).length === 0);
  check("enabled=false: view empty, badge cleared", api.getChildren().length === 0 && api.getBadge() === 0);
  const welcome = pkg.contributes.viewsWelcome;
  check(
    "welcome states: turned off, no folder, nothing found (with what it checks + Scan button)",
    welcome.some((w) => w.when === "!config.pathmend.enabled" && /turned off/.test(w.contents)) &&
      welcome.some((w) => /workbenchState == empty/.test(w.when) && /Open Folder/.test(w.contents)) &&
      welcome.some((w) => /workbenchState != empty/.test(w.when) && /CODEOWNERS/.test(w.contents) && /command:pathmend\.scan/.test(w.contents))
  );
  await conf.update("enabled", undefined, vscode.ConfigurationTarget.Workspace);
  await sleep(200);
  await api.scan();
  check("re-enabled: rows and badge come back", api.getChildren().length > 0 && api.getBadge() === broken());

  // ---- commands ------------------------------------------------------------------
  const cmds = await vscode.commands.getCommands(true);
  check("commands registered", ["pathmend.scan", "pathmend.showBroken", "pathmend.openReference", "pathmend.applyFix"].every((c) => cmds.includes(c)));
  const f = await vscode.commands.executeCommand("pathmend.scan");
  d = diff(diagList(ws).map((x) => x.key), afterFix);
  check("PathMend: Scan workspace returns findings", Array.isArray(f) && f.length === afterFix.length && !d.extra.length && !d.missing.length, [f && f.length, d]);
}

module.exports = { run };
