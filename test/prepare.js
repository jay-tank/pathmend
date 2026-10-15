"use strict";
// Copies the fixture workspace to a scratch folder and adds the parts that cannot live in the
// source tree: symlinks that leave the workspace, an outside "secret" folder and a huge file.
const fs = require("fs");
const path = require("path");

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function prepare(target) {
  fs.rmSync(target, { recursive: true, force: true });
  const ws = path.join(target, "ws");
  const outside = path.join(target, "outside");
  copyDir(path.join(__dirname, "fixtures", "ws"), ws);
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "top secret\n");
  fs.writeFileSync(path.join(outside, "package.json"), '{ "main": "leak-from-outside.js" }\n');
  fs.writeFileSync(path.join(outside, "tsconfig.json"), '{ "extends": "./leak-from-outside.json" }\n');
  fs.symlinkSync(outside, path.join(ws, "hostile", "linkout"), "dir");
  fs.symlinkSync(path.join(outside, "tsconfig.json"), path.join(ws, "hostile", "tsconfig.json"));
  fs.mkdirSync(path.join(ws, "hostile", "huge"), { recursive: true });
  const filler = '"x": "' + "a".repeat(1024 * 1024) + '",';
  fs.writeFileSync(path.join(ws, "hostile", "huge", "package.json"), "{" + filler.repeat(3) + '"main": "nope-huge.js"}\n');
  return { ws: fs.realpathSync(ws), outside: fs.realpathSync(outside) };
}

module.exports = { prepare };
if (require.main === module) console.log(JSON.stringify(prepare(path.resolve(process.argv[2]))));
