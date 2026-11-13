import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import core from "../../core.js";

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
});
