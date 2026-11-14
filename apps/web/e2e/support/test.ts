// Playwright fixtures: each person is an isolated browser context. Any
// Content-Security-Policy violation or uncaught page error fails the test.

import { chromium, test as base, expect, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export { expect };

export interface User {
  readonly context: BrowserContext;
  readonly page: Page;
}

interface Fixtures {
  /** Creates a person (a fresh browser context with one page). */
  newUser: (options?: BrowserContextOptions & { init?: string }) => Promise<User>;
  /** Problems collected from every page of the test. */
  problems: string[];
}

const CSP_MARK = '[csp-violation]';

/** Reports CSP violations to the console, where the fixture picks them up. */
const CSP_LISTENER = `
  document.addEventListener('securitypolicyviolation', (e) => {
    console.error(${JSON.stringify(CSP_MARK)} + ' ' + e.violatedDirective + ' ' + e.blockedURI + ' ' + (e.sourceFile || '') + ':' + e.lineNumber);
  });
`;

export function watch(page: Page, problems: string[]): void {
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().startsWith(CSP_MARK)) problems.push(m.text());
  });
}

export async function makeUser(
  browser: Browser,
  problems: string[],
  options: BrowserContextOptions & { init?: string } = {},
): Promise<User> {
  const { init, ...contextOptions } = options;
  const context = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow', ...contextOptions });
  await context.addInitScript(CSP_LISTENER);
  if (init) await context.addInitScript(init);
  context.on('page', (p) => watch(p, problems));
  const page = await context.newPage();
  return { context, page };
}

/**
 * A person with an on-disk browser profile (its own browser). Ordinary test
 * contexts are incognito-like: Chromium keeps their IndexedDB and OPFS in
 * memory, which hides whether the app itself streams large files.
 */
export async function makePersistentUser(
  problems: string[],
  userDataDir: string,
  options: BrowserContextOptions & { init?: string; args?: string[] } = {},
): Promise<User> {
  const { init, args, ...contextOptions } = options;
  const context = await chromium.launchPersistentContext(userDataDir, {
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    ...(args ? { args } : {}),
    ...contextOptions,
  });
  await context.addInitScript(CSP_LISTENER);
  if (init) await context.addInitScript(init);
  context.on('page', (p) => watch(p, problems));
  const page = context.pages()[0] ?? (await context.newPage());
  watch(page, problems);
  return { context, page };
}

export const test = base.extend<Fixtures>({
  problems: async ({}, use) => {
    const problems: string[] = [];
    await use(problems);
    expect(problems, 'CSP violations and page errors').toEqual([]);
  },
  newUser: async ({ browser, problems }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (options) => {
      const user = await makeUser(browser, problems, options);
      contexts.push(user.context);
      return user;
    });
    for (const c of contexts) await c.close().catch(() => undefined);
  },
});

/** Runs axe and fails on serious or critical violations. */
export async function expectAccessible(page: Page, what: string): Promise<void> {
  // Contrast is measured on the final frame, not in the middle of the new-message animation.
  // Endless ones (the recording dot) never finish and are skipped.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const result = await new AxeBuilder({ page }).analyze();
  const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const summary = bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(summary, `axe on ${what}`).toEqual([]);
}
