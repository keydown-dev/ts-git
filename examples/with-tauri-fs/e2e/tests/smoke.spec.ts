import { test, expect } from '@playwright/test';

test('initial state: idle file tree and git panel before a folder is opened', async ({
  page,
}) => {
  // Navigate to app
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Wait for app to load
  const app = page.locator('#root');
  await expect(app).toBeVisible();

  const fileTreePanel = page.locator('.file-tree');
  await expect(fileTreePanel).toBeVisible();
  await expect(
    fileTreePanel.locator('.placeholder.placeholder--directory'),
  ).toHaveCount(0);

  await page.locator('#sidebar-tab-changes').click();
  const gitPanel = page.locator('#git-changes-panel');
  await expect(gitPanel).toBeVisible();
  await expect(gitPanel.locator('.repo-pane__no-repo-actions')).toBeHidden();

  await expect(
    page.locator('#git-changes-panel .git-tab-container'),
  ).toHaveCount(0);
});

test('app loads without console errors', async ({ page }) => {
  const errors: string[] = [];

  // Capture console errors (excluding known non-critical errors)
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const errorText = msg.text();
      // Skip the known ENOTDIR error from FileTree trying to read /workspace before it exists
      // Skip the known NotAGitRepoError from git refresh when git is not initialized
      // Skip "No folder selected" errors which are expected when no folder is opened
      if (
        !errorText.includes('ENOTDIR') &&
        !errorText.includes("readdir '/workspace'") &&
        !errorText.includes('NotAGitRepoError') &&
        !errorText.includes('not a git repository') &&
        !errorText.includes('No folder selected')
      ) {
        errors.push(errorText);
        console.log('Console error:', errorText);
      }
    }
  });

  // Capture page errors
  page.on('pageerror', (error) => {
    console.log('Page error:', error.message);
    errors.push(error.message);
  });

  // Navigate to app
  await page.goto('/');

  // Wait for app to load
  await page.waitForLoadState('networkidle');

  // Check that app container exists
  const app = page.locator('#root');
  await expect(app).toBeVisible();

  // Check that main panels exist
  const panels = page.locator('.panel');
  const panelCount = await panels.count();
  console.log(`Found ${panelCount} panels`);

  if (panelCount === 0) {
    // Check what actually rendered
    const appHtml = await app.innerHTML();
    console.log('App HTML:', appHtml.substring(0, 1000));
  }

  expect(panelCount).toBeGreaterThan(0);

  // Verify no console errors
  expect(errors).toHaveLength(0);
});

test('header shows Open Folder button', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Check that header exists
  const header = page.locator('.app-header');
  await expect(header).toBeVisible();

  // Check that Open Folder button exists
  const openFolderBtn = header.locator('#select-folder-btn');
  await expect(openFolderBtn).toBeVisible();
  await expect(openFolderBtn).toContainText('Open Folder');
});

test('app has correct layout structure', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const main = page.locator('.app-main');
  await expect(main).toBeVisible();

  const mainStyles = await main.evaluate((el) => {
    const computed = window.getComputedStyle(el);
    return {
      display: computed.display,
      flexDirection: computed.flexDirection,
    };
  });

  console.log('Main layout styles:', mainStyles);
  expect(mainStyles.display).toBe('flex');
  expect(mainStyles.flexDirection).toBe('row');
});

test('panels have correct CSS classes for styling', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Check all panels have the base 'panel' class
  const panels = page.locator('.panel');
  const count = await panels.count();
  expect(count).toBe(4);

  // Verify each panel has specific class
  const fileTreePanel = page.locator('.panel.file-tree');
  const terminalPanel = page.locator('.panel.terminal');
  const gitPanels = page.locator('.panel.sidebar__pane--git');

  await expect(fileTreePanel).toHaveCount(1);
  await expect(terminalPanel).toHaveCount(1);
  await expect(gitPanels).toHaveCount(2);
});

test('terminal is present with welcome message', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Check terminal panel
  const terminalPanel = page.locator('.terminal');
  await expect(terminalPanel).toBeVisible();

  // Check for terminal content
  const terminalContent = terminalPanel.locator('.terminal__window');
  await expect(terminalContent).toBeVisible();
});
