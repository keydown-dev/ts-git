import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for with-browser-fs E2E tests
 *
 * Note: The File System Access API requires user interaction (file picker dialog)
 * which cannot be fully automated in browser tests. These tests focus on:
 * - Welcome screen rendering
 * - App structure loading
 * - Console error detection
 * - UI component visibility
 */
export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.PREVIEW_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    contextOptions: {
      logger: {
        isEnabled: () => true,
        log: (name, severity, message) => {
          if (severity === 'error' || severity === 'warning') {
            console.log(`[${severity}] ${message}`);
          }
        },
      },
    },
    // Grant permission for File System Access API (Chrome only)
    permissions: ['clipboard-read', 'clipboard-write'],
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Launch options for File System Access API support
        launchOptions: {
          args: [
            '--allow-file-access-from-files',
            '--enable-features=FileSystemAccessAPI',
          ],
        },
      },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
