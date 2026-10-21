/**
 * E2E Test Utilities for with-browser-fs
 *
 * Note: Due to File System Access API limitations, many traditional
 * testing utilities cannot be used (e.g., we can't programmatically
 * select folders). These utilities focus on what can be tested.
 */

import { Page, expect } from '@playwright/test';

/**
 * Wait for the welcome screen to be fully loaded
 */
export async function waitForWelcomeScreen(page: Page): Promise<void> {
  await page.waitForSelector('.welcome-container', { timeout: 10000 });
  await page.waitForSelector('#select-folder-btn', { timeout: 10000 });
  await page.waitForLoadState('networkidle');
}

/**
 * Get the welcome card element
 */
export async function getWelcomeCard(page: Page) {
  return page.locator('.welcome-card');
}

/**
 * Click the select folder button
 * Note: This will trigger the native file picker which cannot be automated
 */
export async function clickSelectFolder(page: Page): Promise<void> {
  const button = page.locator('#select-folder-btn');
  await button.click();
}

/**
 * Check if an element is visible on the page
 */
export async function isElementVisible(
  page: Page,
  selector: string,
): Promise<boolean> {
  try {
    const element = page.locator(selector);
    return await element.isVisible();
  } catch {
    return false;
  }
}

/**
 * Get all console errors that occurred during page load
 */
export async function captureConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });

  page.on('pageerror', (error) => {
    errors.push(error.message);
  });

  return errors;
}

/**
 * Assert that no console errors occurred
 */
export async function assertNoConsoleErrors(page: Page): Promise<void> {
  const errors = await captureConsoleErrors(page);
  expect(errors).toHaveLength(0);
}

/**
 * Get computed styles for an element
 */
export async function getComputedStyles(
  page: Page,
  selector: string,
  properties: string[],
): Promise<Record<string, string>> {
  const element = page.locator(selector);
  const styles: Record<string, string> = {};

  for (const prop of properties) {
    const value = await element.evaluate((el, property) => {
      return window.getComputedStyle(el).getPropertyValue(property);
    }, prop);
    styles[prop] = value;
  }

  return styles;
}
