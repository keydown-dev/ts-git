import { test, expect, type ConsoleMessage } from '@playwright/test';

test.describe('Application Smoke Tests', () => {
  test('app loads without console errors', async ({ page }) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Capture console errors and warnings
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        const errorText = msg.text();
        errors.push(errorText);
        console.log('Console error:', errorText);
      } else if (msg.type() === 'warning') {
        const warningText = msg.text();
        warnings.push(warningText);
        console.log('Console warning:', warningText);
      }
    });

    // Capture page errors
    page.on('pageerror', (error: Error) => {
      console.log('Page error:', error.message);
      errors.push(error.message);
    });

    // Navigate to app
    await page.goto('/');

    // Wait for app to load
    await page.waitForLoadState('networkidle');

    // Check that app container exists
    const app = page.locator('#root');
    await expect(app).toBeVisible({ timeout: 10000 });

    // Log test results
    console.log(`Found ${errors.length} console errors`);
    console.log(`Found ${warnings.length} console warnings`);

    // Verify no critical console errors (warnings are acceptable)
    expect(errors).toHaveLength(0);
  });

  test('sidebar, terminal, and git panes are present', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const fileTreePanel = page.locator('.file-tree');
    await expect(fileTreePanel).toBeVisible();

    const terminalPanel = page.locator('.terminal');
    await expect(terminalPanel).toBeVisible();

    await page.locator('#sidebar-tab-changes').click();
    const gitPanel = page.locator('#git-changes-panel');
    await expect(gitPanel).toBeVisible();

    const folderName = page.locator('.sidebar__folder-title');
    await expect(folderName).toContainText('No folder selected');
  });

  test('help command works without folder selected', async ({ page }) => {
    // Navigate to app
    await page.goto('/');

    // Wait for app to load
    await page.waitForLoadState('networkidle');

    // Wait for terminal to be ready
    const terminalInput = page.locator('.terminal__input');
    await expect(terminalInput).toBeVisible({ timeout: 10000 });

    // Type help command
    await terminalInput.fill('help');
    await terminalInput.press('Enter');

    // Wait a moment for output
    await page.waitForTimeout(500);

    // Get terminal output
    const terminalOutput = page.locator('.terminal__output');
    const output = await terminalOutput.textContent();
    console.log('Terminal output:', output);

    // Should show help message
    expect(output).toContain('Available commands');
    expect(output).toContain('Git Commands');
    expect(output).toContain('File Commands');

    // Should NOT contain error messages
    expect(output).not.toContain('Error:');
    expect(output).not.toContain('Module');
    expect(output).not.toContain('externalized');
  });

  test('file commands show "No folder selected" error', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Wait for terminal to be ready
    const terminalInput = page.locator('.terminal__input');
    await expect(terminalInput).toBeVisible({ timeout: 10000 });

    // Try a file command that requires a folder
    await terminalInput.fill('ls');
    await terminalInput.press('Enter');
    await page.waitForTimeout(500);

    const terminalOutput = page.locator('.terminal__output');
    const output = await terminalOutput.textContent();
    console.log('Terminal output after ls:', output);

    // Should show "No folder selected" error
    expect(output).toContain('No folder selected');
  });

  test('open folder button is visible', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Check that "Open Folder" button is visible
    const openFolderBtn = page.locator('#select-folder-btn');
    await expect(openFolderBtn).toBeVisible();
    await expect(openFolderBtn).toContainText('Open Folder');

    // Sidebar top header: folder icon + title act as open/change folder control
    const sidebarFolderOpenBtn = page.locator('#open-folder-btn');
    await expect(sidebarFolderOpenBtn).toBeVisible();
  });

  test('page has correct metadata and title', async ({ page }) => {
    await page.goto('/');

    // Check page title
    await expect(page).toHaveTitle(/TS-Git Browser/);

    // Check viewport meta tag exists
    const viewportMeta = page.locator('meta[name="viewport"]');
    await expect(viewportMeta).toHaveAttribute('content', /width=device-width/);

    // Check theme-color meta tag
    const themeColorMeta = page.locator('meta[name="theme-color"]');
    await expect(themeColorMeta).toHaveAttribute('content');
  });

  test('no JavaScript errors on page load', async ({ page }) => {
    const jsErrors: string[] = [];

    page.on('pageerror', (error: Error) => {
      jsErrors.push(error.message);
      console.log('JavaScript error:', error.message);
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Wait a bit for any async initialization
    await page.waitForTimeout(1000);

    // Verify no JS errors occurred
    expect(jsErrors).toHaveLength(0);
  });

  test('responsive layout works on mobile viewport', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Verify panels are still visible on mobile
    const fileTreePanel = page.locator('.file-tree');
    await expect(fileTreePanel).toBeVisible();

    const terminalPanel = page.locator('.terminal');
    await expect(terminalPanel).toBeVisible();

    await page.locator('#sidebar-tab-changes').click();
    const gitPanel = page.locator('#git-changes-panel');
    await expect(gitPanel).toBeVisible();
  });
});
