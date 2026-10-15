"use strict";
// Exact diagnostics expected for the fixture workspace: "file:line(1-based):code".
module.exports = [
  // package.json
  "package.json:5:PM001", // module src/esm/index.mjs
  "package.json:9:PM001", // bin.tool bin/tool.js -> lib/tool.js
  "package.json:15:PM001", // exports ./legacy require ./src/legacy.cjs
  "package.json:17:PM009", // files docs/*.pdf
  // tsconfig.json
  "tsconfig.json:7:PM002", // files src/missing.ts
  "tsconfig.json:8:PM009", // include tests/**/*.ts
  "tsconfig.json:9:PM002", // references ./packages/core
  "tsconfig.json:9:PM002", // references ./src (no tsconfig.json)
  // tsconfig.build.json
  "tsconfig.build.json:2:PM002", // extends ./tsconfig.bse.json -> ./tsconfig.base.json
  // tsconfig compilerOptions: baseUrl, typeRoots, paths (inherited baseUrl, own folder, package extends skipped)
  "packages/app/tsconfig.json:8:PM009", // paths @gone/* -> src/gone/* matches nothing
  "packages/app/tsconfig.json:9:PM002", // paths @typo -> src/indx (no module file)
  "packages/app/tsconfig.json:13:PM002", // typeRoots ./types (relative to the tsconfig, not baseUrl) -> ../../types
  "packages/nobase/tsconfig.json:3:PM002", // paths @miss -> ./lib/missing (no baseUrl: relative to the tsconfig folder)
  "packages/badbase/tsconfig.json:1:PM002", // baseUrl ./srcx missing; its paths are not checked against it
  // Dockerfile
  "Dockerfile:6:PM003", // scripts/start.sh -> tools/start.sh
  "Dockerfile:11:PM009", // config/*.yaml
  "Dockerfile:12:PM003", // missing.json
  "Dockerfile:16:PM003", // src/nothere (continuation line)
  // docker/app.Dockerfile, linked from compose with context "."
  "docker/app.Dockerfile:3:PM003", // app-only.txt -> docker/app-only.txt
  // services/api/Dockerfile, linked from compose (api2) with context services/api
  "services/api/Dockerfile:3:PM011", // ../../src escapes the build context
  // docker-compose.yml
  "docker-compose.yml:7:PM004", // dockerfile Dockerfile.prod
  "docker-compose.yml:12:PM004", // context ./services/wrker -> ./services/worker
  // GitHub Actions
  ".github/workflows/ci.yml:15:PM005", // uses ./.github/actions/setpu -> setup
  ".github/workflows/ci.yml:16:PM005", // uses ./.github/actions/empty (no action.yml)
  ".github/workflows/ci.yml:22:PM005", // working-directory packages/web
  ".github/workflows/ci.yml:28:PM005", // bash scripts/build.sh -> tools/build.sh
  ".github/actions/setup/action.yml:7:PM005", // bash tools/setup-missing.sh
  // CODEOWNERS
  ".github/CODEOWNERS:4:PM006", // /docs/guid.md -> /docs/guide.md
  ".github/CODEOWNERS:5:PM006", // scripts/deploy.sh -> tools/deploy.sh
  ".github/CODEOWNERS:7:PM006", // nonexistent-dir/
  // launch.json
  ".vscode/launch.json:6:PM007", // ${workspaceFolder}/src/server.js -> src/app/server.js
  ".vscode/launch.json:8:PM007", // ${workspaceFolder}/services/nope
  // GitLab CI
  ".gitlab-ci.yml:3:PM008", // ci/templates/tset.yml -> ci/templates/test.yml
  ".gitlab-ci.yml:4:PM008", // /ci/missing.yml
  ".gitlab-ci.yml:10:PM009", // ci/none/*.yml
  // Hostile fixture: nothing outside the workspace is checked
  "hostile/package.json:3:PM010", // /etc/passwd
  "hostile/package.json:4:PM010", // ../../../etc/passwd
  "hostile/package.json:5:PM010", // linkout/secret.txt (symlink escapes)
  "hostile/package.json:6:PM010", // linkout/../linkout/secret.txt
  "hostile/package.json:7:PM010", // /etc/*
  "hostile/package.json:7:PM010", // linkout/*
  "hostile/package.json:7:PM010", // ../../*
  "hostile/Dockerfile:2:PM003", // /etc/passwd means <context>/etc/passwd - checked inside the workspace
  "hostile/Dockerfile:3:PM010", // ../ escape
  "hostile/Dockerfile:4:PM010", // linkout/secret.txt
  "hostile/.vscode/launch.json:1:PM010", // program escapes
  "hostile/.vscode/launch.json:1:PM010", // cwd -> linkout
  "hostile/.gitlab-ci.yml:2:PM010", // /../../etc/passwd
  "hostile/.gitlab-ci.yml:3:PM010", // /linkout/secret.txt
  "hostile/docker-compose.yml:4:PM010", // context ../../etc
  "hostile/docker-compose.yml:8:PM010", // context linkout
  "hostile/weird2/package.json:1:PM001", // exports a[2].b ./nope.js
  "hostile/weird2/package.json:1:PM010", // types with . escapes -> ../../etc/passwd
];
