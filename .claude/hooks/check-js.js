#!/usr/bin/env node
// PostToolUse(Write|Edit) hook: syntax-check edited .js files with `node --check`.
// There's no bundler/linter/CI in this repo, so this is the only automatic
// guard against shipping a JS syntax error. Exit 2 surfaces the error to Claude.
'use strict';

const { spawnSync } = require('child_process');

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', () => {
  let file;
  try {
    file = JSON.parse(data).tool_input.file_path;
  } catch {
    process.exit(0); // no/!malformed payload — nothing to check
  }
  if (!file || !file.endsWith('.js')) process.exit(0);

  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || `node --check failed for ${file}\n`);
    process.exit(2); // feeds stderr back to Claude
  }
  process.exit(0);
});
