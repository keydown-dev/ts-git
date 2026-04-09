/* eslint-env node */

import fs from 'node:fs';
import path from 'node:path';

/** Every string path nested under package.json "exports". */
function collectExportPathStrings(exportsField) {
  const out = [];
  function walk(node) {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const v of Object.values(node)) {
        walk(v);
      }
    }
  }
  walk(exportsField);
  return out;
}

/** Filenames TypeScript emits into dist/ — copy from src/ is not used for these. */
const TSC_EMITTED_NAME =
  /\.(js|mjs|cjs|d\.ts|d\.ts\.map|js\.map|mjs\.map|cjs\.map)$/;

/**
 * For each non-TS-emitted file listed under ./dist/ in exports, map
 * src/<same-relative-path> -> dist/<same-relative-path>.
 */
export function getDistAssetCopyJobs(packageRoot) {
  const pkgPath = path.join(packageRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const { exports: exportsField } = pkg;
  if (!exportsField) {
    return [];
  }

  const strings = collectExportPathStrings(exportsField);
  const distRelSet = new Set();

  for (const s of strings) {
    if (typeof s !== 'string' || !s.startsWith('./')) {
      continue;
    }
    const rel = s.slice(2);
    if (!rel.startsWith('dist/')) {
      continue;
    }
    const underDist = rel.slice('dist/'.length);
    if (!underDist || underDist.endsWith('/')) {
      continue;
    }
    const base = path.basename(underDist);
    if (TSC_EMITTED_NAME.test(base)) {
      continue;
    }
    distRelSet.add(underDist);
  }

  const jobs = [];
  for (const distRel of distRelSet) {
    jobs.push({
      src: path.join(packageRoot, 'src', distRel),
      dest: path.join(packageRoot, 'dist', distRel),
    });
  }
  return jobs;
}

export function copyExportAssets(packageRoot) {
  const jobs = getDistAssetCopyJobs(packageRoot);
  for (const { src, dest } of jobs) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  return jobs;
}
