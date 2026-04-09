/* eslint-env node */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyExportAssets, getDistAssetCopyJobs } from './export-dist-assets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function syncAssets() {
  try {
    copyExportAssets(root);
  } catch (err) {
    console.error('[@ts-git/ui] failed to copy export assets:', err);
  }
}

syncAssets();
const assetJobs = getDistAssetCopyJobs(root);
for (const { src } of assetJobs) {
  fs.watch(src, () => {
    syncAssets();
  });
}

const tscJs = path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');
const tsc = spawn(process.execPath, [tscJs, '--watch', '--preserveWatchOutput'], {
  cwd: root,
  stdio: 'inherit',
});

tsc.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
