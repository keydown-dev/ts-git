/**
 * Fixture helpers for extracting and managing the golden repository test fixture.
 *
 * The golden repository is a comprehensive git repository with various test scenarios
 * packaged as a tar.gz file in tests/fixtures/golden-repo.tar.gz
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const execFileAsync = promisify(execFile);

// Handle both source (src/) and compiled (dist/) paths
async function getFixturePath(): Promise<string> {
  // First, try the source path (if running from src/)
  const srcPath = path.join(
    __dirname,
    '..',
    '..',
    'fixtures',
    'golden-repo.tar.gz',
  );

  // Check if it exists in src
  try {
    await fs.access(srcPath);
    return srcPath;
  } catch {
    // Not in src, try from dist (go up to package root, then to src)
    const fromDistPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'src',
      'tests',
      'fixtures',
      'golden-repo.tar.gz',
    );
    return fromDistPath;
  }
}

/**
 * Extracts the golden repository fixture to a temporary directory.
 * Returns the path to the extracted repository.
 */
export async function extractGoldenRepo(): Promise<string> {
  const fixturePath = await getFixturePath();

  // Create temporary directory
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ts-git-golden-repo-'),
  );

  // Extract the fixture
  await execFileAsync('tar', [
    '--no-same-owner',
    '-xzf',
    fixturePath,
    '-C',
    tempDir,
  ]);

  // Return path to the extracted repo
  return path.join(tempDir, 'golden-repo');
}

/**
 * Cleans up the extracted golden repository.
 */
export async function cleanupGoldenRepo(dir: string): Promise<void> {
  // Get parent directory (temp dir created in extractGoldenRepo)
  const tempDir = path.dirname(dir);
  await fs.rm(tempDir, { recursive: true, force: true });
}

/**
 * Verifies the fixture file exists.
 */
export async function fixtureExists(): Promise<boolean> {
  try {
    const fixturePath = await getFixturePath();
    await fs.access(fixturePath);
    return true;
  } catch {
    return false;
  }
}
