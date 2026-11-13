"use strict";

/**
 * Extract local file references from package.json scripts.
 *
 * This module only identifies path-like arguments and their source offsets.
 * core.js owns diagnostics, workspace guards, and rename planning.
 *
 * A path argument to `npm exec --workspace NAME -- ...` resolves from the
 * named workspace's package directory. A workspace that cannot be resolved
 * is deliberately skipped rather than checked from the wrong directory.
 */

const SCRIPT_COMMAND =
  /(?:^|&&|\|\||[;|])\s*(?:(?:env|cross-env)\s+(?:[A-Za-z_]\w*=[^\s;&|]+\s+)*)?(?:(?:node|tsx|ts-node|ts-node-esm|bun|deno|python3?|bash|sh|zsh|dash|ksh|ruby|perl|pwsh)\s+(?:--?[\w-]+(?:=[^\s;&|]+)?\s+)*([^\s;&|"'\x60$()<>]+)|(\.\.?\/[^\s;&|"'\x60$()<>]+))/g;
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|rb|pl|ps1)$/i;
const OPTION_ARGUMENT = /(?:^|\s)--[a-z][\w-]*(?:\s+|=)([^\s;&|"'\x60$()<>]+)/gi;
const COMMAND_SEGMENT = /(?:^|&&|\|\||[;|])([^;&|]*)/g;

function localPath(value, allowAnyExtension) {
  if (!value || value.includes("\\") || /[*?[\]{}]/.test(value) ||
      /^[a-z][a-z\d+.-]*:\/\//i.test(value) ||
      /^(?:git@|docker:|data:|npm:|workspace:|link:|file:)/i.test(value) ||
      /[\x00-\x1f\x7f]/.test(value)) return false;
  if (value.startsWith("-")) return false;
  if (value.startsWith("./") || value.startsWith("../") || value.startsWith("/")) return true;
  return allowAnyExtension ? /\.[a-z\d]{1,8}$/i.test(value) : SCRIPT_EXTENSION.test(value);
}

/** Return { value, offset, base } for each local file operand. */
function extractScriptPaths(script, base, packageDirs = new Map()) {
  const refs = [];
  const seen = new Set();

  function add(value, offset, resolvedBase) {
    const key = offset + ":" + value.length;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ value, offset, base: resolvedBase });
  }

  SCRIPT_COMMAND.lastIndex = 0;
  let match;
  while ((match = SCRIPT_COMMAND.exec(script))) {
    const token = match[1] || match[2];
    if (!localPath(token, false)) continue;
    add(token, match.index + match[0].lastIndexOf(token), base);
  }

  COMMAND_SEGMENT.lastIndex = 0;
  let segment;
  while ((segment = COMMAND_SEGMENT.exec(script))) {
    const command = segment[1];
    const segmentStart = segment.index + segment[0].lastIndexOf(command);
    let resolvedBase = base;

    if (/(?:^|\s)npm\s+(?:exec|x)\b/.test(command)) {
      const workspace = /(?:^|\s)(?:--workspace(?:=|\s+)|-w\s+)([^\s;&|]+)/.exec(command);
      if (workspace) {
        resolvedBase = packageDirs.get(workspace[1]);
        if (!resolvedBase) continue;
      }
    }

    OPTION_ARGUMENT.lastIndex = 0;
    let option;
    while ((option = OPTION_ARGUMENT.exec(command))) {
      const token = option[1];
      if (!localPath(token, true)) continue;
      add(token, segmentStart + option.index + option[0].lastIndexOf(token), resolvedBase);
    }
  }
  return refs;
}

module.exports = { extractScriptPaths };
