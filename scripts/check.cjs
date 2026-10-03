'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let count = 0;
for (const folder of ['src', 'ui', 'scripts', 'test']) {
  for (const entry of fs.readdirSync(path.join(root, folder), { recursive: true })) {
    if (!/\.(cjs|js)$/.test(entry)) continue;
    execFileSync(process.execPath, ['--check', path.join(root, folder, entry)], { stdio: 'pipe' });
    count++;
  }
}
console.log(`Syntax verified: ${count} JavaScript files.`);
