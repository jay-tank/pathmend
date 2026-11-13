import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import core from "../../core.js";
import scriptPaths from "../../package-scripts.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixtureManifest = path.resolve(testDirectory, "../fixtures/package-json/package.json");
let scratch;
let manifest;

function analyze() {
  const guard = core.createGuard(fs, [scratch]);
  const result = core.analyze({
    configs: [{ file: manifest, text: fs.readFileSync(manifest, "utf8") }],
    roots: [{ path: scratch, name: "scratch" }],
    guard,
    index: new core.FileIndex(),
    settings: {},
  });
  return { ...result, guard };
}

function applyPlan(plan) {
  // Update only the copied manifest, applying ranges in reverse offset order.
  const lines = fs.readFileSync(manifest, "utf8").split("\n");
  for (const entry of [...plan].sort((a, b) =>
    b.ref.line - a.ref.line || b.ref.col - a.ref.col)) {
    const { ref, newText } = entry;
    expect(lines[ref.line].slice(ref.col, ref.endCol)).toBe(ref.raw);
    const encoded = core.encodeFor(ref, newText);
    expect(encoded).not.toBeNull();
    lines[ref.line] = lines[ref.line].slice(0, ref.col)
      + encoded + lines[ref.line].slice(ref.endCol);
  }
  fs.writeFileSync(manifest, lines.join("\n"));
}

describe("isolated script path extraction", () => {
  it("extracts direct scripts and generic option operands with precise offsets", () => {
    const command = "node scripts/setup.js && tool --arbitrary-flag=./configs/build.js";
    const paths = scriptPaths.extractScriptPaths(command, "/workspace");
    expect(paths.map(({ value, offset, base }) => [value, command.slice(offset, offset + value.length), base]))
      .toEqual([
        ["scripts/setup.js", "scripts/setup.js", "/workspace"],
        ["./configs/build.js", "./configs/build.js", "/workspace"],
      ]);
  });

  it("resolves workspace option paths and skips unknown workspaces", () => {
    const dirs = new Map([["@scope/playground", "/workspace/packages/playground"]]);
    const command = "npm exec --workspace @scope/playground -- vite build --anything ../../tests/vite.config.js";
    expect(scriptPaths.extractScriptPaths(command, "/workspace", dirs))
      .toEqual([{
        value: "../../tests/vite.config.js",
        offset: command.indexOf("../../tests/vite.config.js"),
        base: "/workspace/packages/playground",
      }]);
    expect(scriptPaths.extractScriptPaths(command, "/workspace", new Map())).toEqual([]);
  });

  it("does not classify JavaScript expressions as file paths", () => {
    const script = "node --eval console.log(1) && node --eval console.error(2)";
    expect(scriptPaths.extractScriptPaths(script, "/workspace")).toEqual([]);
  });

  it("ignores URL, variable, package name, and scalar option arguments", () => {
    const command = "tool --url https://example.test/file.js --input $ENTRY --plugin @scope/pkg --mode production";
    expect(scriptPaths.extractScriptPaths(command, "/workspace")).toEqual([]);
  });
});

describe("package.json script paths", () => {
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pathmend-vitest-"));
    manifest = path.join(scratch, "package.json");
    // Only edit a temporary copy of the dedicated tracked fixture.
    fs.copyFileSync(fixtureManifest, manifest);
    fs.mkdirSync(path.join(scratch, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(scratch, "tools"), { recursive: true });
    for (const file of ["build.ts", "run.js", "setup.sh", "other.ts"]) {
      fs.writeFileSync(path.join(scratch, "scripts", file), "");
    }
  });

  afterEach(() => {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it("detects only executable local script operands with exact ranges", () => {
    const result = analyze();
    const refs = result.refs.filter((r) => r.label.startsWith("package.json scripts."));
    expect(refs.map((r) => [r.label.split("scripts.")[1], r.value])).toEqual([
      ["build", "scripts/build.ts"],
      ["node", "./scripts/run.js"],
      ["shell", "scripts/setup.sh"],
      ["direct", "./scripts/setup.sh"],
      ["chained", "scripts/other.ts"],
    ]);
    expect(result.findings).toEqual([]);
    const lines = fs.readFileSync(manifest, "utf8").split("\n");
    for (const ref of refs) {
      expect(lines[ref.line].slice(ref.col, ref.endCol)).toBe(ref.value);
    }
  });

  it("moves a file and edits only the copied package.json", () => {
    const { refs, guard } = analyze();
    const from = path.join(scratch, "scripts", "build.ts");
    const to = path.join(scratch, "tools", "build.ts");
    const plan = core.planRenames(refs, [{ from, to }], guard.inside);
    expect(plan).toHaveLength(1);
    expect(plan[0].newText).toBe("tools/build.ts");

    fs.renameSync(from, to);
    expect(analyze().findings.map((f) => f.ref.label)).toContain("package.json scripts.build");
    applyPlan(plan);
    expect(JSON.parse(fs.readFileSync(manifest, "utf8")).scripts.build)
      .toBe("tsx tools/build.ts --watch");
    expect(analyze().findings).toEqual([]);
  });

  it("moves a directory and updates all matching script references", () => {
    const { refs, guard } = analyze();
    const from = path.join(scratch, "scripts");
    const to = path.join(scratch, "tools", "scripts");
    const plan = core.planRenames(refs, [{ from, to }], guard.inside);
    expect(plan.map((p) => p.newText)).toEqual([
      "tools/scripts/build.ts",
      "./tools/scripts/run.js",
      "tools/scripts/setup.sh",
      "./tools/scripts/setup.sh",
      "tools/scripts/other.ts",
    ]);

    fs.renameSync(from, to);
    applyPlan(plan);
    const copy = JSON.parse(fs.readFileSync(manifest, "utf8"));
    expect(copy.scripts.node).toBe("node ./tools/scripts/run.js");
    expect(copy.scripts.package).toBe("vite build");
    expect(copy.scripts.npm).toBe("npm run build");
    expect(analyze().findings).toEqual([]);
  });
  it("suggests an indexed workspace file for an outside absolute path", () => {
    const script = path.join(scratch, "scripts", "prepare-github-cli.ts");
    fs.writeFileSync(script, "");
    const original = JSON.parse(fs.readFileSync(manifest, "utf8"));
    original.scripts.prepare =
      "npm run build --workspace @moyarich/moyaforge-cli && node /prepare-github-cli.ts";
    original.main = "/prepare-github-cli.ts";
    fs.writeFileSync(manifest, JSON.stringify(original, null, 2) + "\n");

    const guard = core.createGuard(fs, [scratch]);
    const index = new core.FileIndex();
    index.add(scratch, "scripts/prepare-github-cli.ts");
    const result = core.analyze({
      configs: [{ file: manifest, text: fs.readFileSync(manifest, "utf8") }],
      roots: [{ path: scratch, name: "scratch" }],
      guard,
      index,
      settings: {},
    });
    const findings = result.findings.filter(f => f.ref.value === "/prepare-github-cli.ts");
    expect(findings).toHaveLength(2);
    expect(findings.map(f => f.code)).toEqual(["PM010", "PM010"]);
    expect(findings.map(f => f.fix)).toEqual([
      "scripts/prepare-github-cli.ts",
      "scripts/prepare-github-cli.ts",
    ]);
    expect(findings.every(f => f.info)).toBe(true);

    const lines = fs.readFileSync(manifest, "utf8").split("\n");
    for (const finding of findings) {
      const { ref, fix } = finding;
      expect(lines[ref.line].slice(ref.col, ref.endCol)).toBe(ref.raw);
      lines[ref.line] = lines[ref.line].slice(0, ref.col)
        + core.encodeFor(ref, fix) + lines[ref.line].slice(ref.endCol);
    }
    fs.writeFileSync(manifest, lines.join("\n"));
    const updated = JSON.parse(fs.readFileSync(manifest, "utf8"));
    expect(updated.scripts.prepare).toBe(
      "npm run build --workspace @moyarich/moyaforge-cli && node scripts/prepare-github-cli.ts"
    );
    expect(updated.main).toBe("scripts/prepare-github-cli.ts");
  });

  it("checks config-file options relative to npm exec workspace and updates renamed files", () => {
    const workspaceDir = path.join(scratch, "packages", "moyaforge-playground");
    const workspaceManifest = path.join(workspaceDir, "package.json");
    const configDir = path.join(scratch, "tests", "vite-consumer-build");
    const correctConfig = path.join(configDir, "vite.config.js");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(workspaceManifest, JSON.stringify({
      name: "@moyarich/moyaforge-playground",
      version: "1.0.0",
    }));
    fs.writeFileSync(correctConfig, "export default {};\n");

    const packageData = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const prefix = "npm exec --workspace @moyarich/moyaforge-playground -- vite build --config ";
    packageData.scripts["test:consumer:browser"] =
      prefix + "../../vite-consumer-build/vite.config.js";
    fs.writeFileSync(manifest, JSON.stringify(packageData, null, 2) + "\n");

    const inspect = () => {
      const guard = core.createGuard(fs, [scratch]);
      const configs = [manifest, workspaceManifest].map(file => ({
        file, text: fs.readFileSync(file, "utf8"),
      }));
      const result = core.analyze({
        configs,
        roots: [{ path: scratch, name: "scratch" }],
        guard,
        index: new core.FileIndex(),
        settings: {},
      });
      return { ...result, guard };
    };

    const invalid = inspect();
    const finding = invalid.findings.find(f =>
      f.ref.label === "package.json scripts.test:consumer:browser");
    expect(finding).toBeDefined();
    expect(finding.code).toBe("PM001");
    expect(finding.ref.value).toBe("../../vite-consumer-build/vite.config.js");
    expect(finding.ref.base).toBe(workspaceDir);
    const line = fs.readFileSync(manifest, "utf8").split("\n")[finding.ref.line];
    expect(line.slice(finding.ref.col, finding.ref.endCol)).toBe(finding.ref.value);

    packageData.scripts["test:consumer:browser"] =
      prefix + "../../tests/vite-consumer-build/vite.config.js";
    fs.writeFileSync(manifest, JSON.stringify(packageData, null, 2) + "\n");
    const valid = inspect();
    expect(valid.findings.filter(f =>
      f.ref.label === "package.json scripts.test:consumer:browser")).toEqual([]);

    const renamedConfig = path.join(configDir, "renamed.config.js");
    const plan = core.planRenames(valid.refs, [
      { from: correctConfig, to: renamedConfig },
    ], valid.guard.inside);
    expect(plan).toHaveLength(1);
    expect(plan[0].newText).toBe("../../tests/vite-consumer-build/renamed.config.js");
    fs.renameSync(correctConfig, renamedConfig);
    applyPlan(plan);
    expect(inspect().findings.filter(f =>
      f.ref.label === "package.json scripts.test:consumer:browser")).toEqual([]);
  });

  it("ignores non-file values and variables passed to config options", () => {
    const packageData = JSON.parse(fs.readFileSync(manifest, "utf8"));
    Object.assign(packageData.scripts, {
      configVariable: "vite --config $CONFIG",
      configUrl: "vite --config https://example.test/vite.config.js",
      configValue: "vite --config production",
      configUnrelated: "vite --mode production",
      scalarOption: "tool --quality high",
      evalExpression: "node --eval console.log(1)",
      dottedExpression: "node --eval console.error(2)",
      packageOption: "tool --plugin @scope/example",
      remoteOption: "tool --asset https://example.test/preset.js",
    });
    fs.writeFileSync(manifest, JSON.stringify(packageData, null, 2) + "\n");
    const refs = analyze().refs.filter(r =>
      /scripts.(?:config(?:Variable|Url|Value|Unrelated)|scalarOption|evalExpression|dottedExpression|packageOption|remoteOption)/.test(r.label));
    expect(refs).toEqual([]);
  });

  it.each([
    ["--config", "vite build --config ./configs/missing.js"],
    ["--config=", "vite build --config=./configs/missing.js"],
    ["--config-file", "tool --config-file ./configs/missing.js"],
    ["--config-path", "tool --config-path=./configs/missing.js"],
    ["--input", "tool --input ./configs/missing.js"],
    ["--arbitrary-file-option", "tool --arbitrary-file-option=./configs/missing.js"],
    ["chained", "echo ready && vite build --config ./configs/missing.js"],
  ])("reports missing file arguments for %s", (_name, command) => {
    const data = JSON.parse(fs.readFileSync(manifest, "utf8"));
    data.scripts.checkConfig = command;
    fs.writeFileSync(manifest, JSON.stringify(data, null, 2) + "\n");
    const { findings } = analyze();
    const matches = findings.filter(f => f.ref.label === "package.json scripts.checkConfig");
    expect(matches).toHaveLength(1);
    expect(matches[0].code).toBe("PM001");
    expect(matches[0].ref.value).toBe("./configs/missing.js");
    const sourceLine = fs.readFileSync(manifest, "utf8").split("\n")[matches[0].ref.line];
    expect(sourceLine.slice(matches[0].ref.col, matches[0].ref.endCol))
      .toBe("./configs/missing.js");

    fs.mkdirSync(path.join(scratch, "configs"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "configs", "missing.js"), "");
    expect(analyze().findings.filter(f =>
      f.ref.label === "package.json scripts.checkConfig")).toEqual([]);
  });

  it("does not mistake workspace names or unrelated npm arguments for paths", () => {
    const data = JSON.parse(fs.readFileSync(manifest, "utf8"));
    Object.assign(data.scripts, {
      workspaceName: "npm exec --workspace @moyarich/moyaforge-playground -- vite build",
      npmPackage: "npm exec -- vite build --mode production",
      unknownWorkspace: "npm exec --workspace @missing/pkg -- vite build --config ./missing.js",
      configUrl: "vite build --config https://example.test/config.js",
      configVariable: "vite build --config $CONFIG",
      configUnrelated: "vite build --mode development",
    });
    fs.writeFileSync(manifest, JSON.stringify(data, null, 2) + "\n");
    const refs = analyze().refs.filter(r =>
      /scripts.(?:workspaceName|npmPackage|unknownWorkspace|configUrl|configVariable|configUnrelated)$/.test(r.label));
    expect(refs).toEqual([]);
  });

  it("does not suggest missing or ignored candidates for outside paths", () => {
    const source = JSON.parse(fs.readFileSync(manifest, "utf8"));
    source.scripts.prepare = "node /prepare-github-cli.ts";
    fs.writeFileSync(manifest, JSON.stringify(source, null, 2) + "\n");
    const guard = core.createGuard(fs, [scratch]);
    const index = new core.FileIndex();
    index.add(scratch, "scripts/prepare-github-cli.ts");
    const run = (settings) => core.analyze({
      configs: [{ file: manifest, text: fs.readFileSync(manifest, "utf8") }],
      roots: [{ path: scratch, name: "scratch" }],
      guard,
      index,
      settings,
    }).findings.find(f => f.ref.label === "package.json scripts.prepare");
    expect(run({}).fix).toBeNull();
    fs.writeFileSync(path.join(scratch, "scripts", "prepare-github-cli.ts"), "");
    expect(run({ ignoreReferences: ["**/prepare-github-cli.ts"] }).fix).toBeNull();
  });

});
