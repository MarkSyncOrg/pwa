import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import {
  BookmarkContainer,
  encryptData,
  getContainer,
  getPasswordHash,
  newBookmark,
  serializeBookmarks,
} from '@xbrowsersync/core';

// Fixed test credentials. The sync ID doubles as the PBKDF2 salt, so the seed
// ciphertext below must be derived with exactly this pair.
const SERVICE_URL = 'https://api.xbrowsersync.org';
const SYNC_ID = 'abc123def4567890abc123def4567890';
const PASSWORD = 'correct horse battery staple';

const SEEDED = [
  { title: 'xBrowserSync', url: 'https://www.xbrowsersync.org/' },
  { title: 'GitHub', url: 'https://github.com/' },
];

// Mutable server state, shared across browser contexts within this file so that a
// push from one "device" is observable by a second login.
interface ServerState {
  blob: string;
  lastUpdated: string;
  version: string;
}

async function encryptTree(
  entries: { title: string; url: string }[],
): Promise<string> {
  const tree = [newBookmark(BookmarkContainer.Toolbar)];
  const toolbar = getContainer(BookmarkContainer.Toolbar, tree, true)!;
  toolbar.children = entries.map((e) => newBookmark(e.title, e.url));
  const hash = await getPasswordHash(PASSWORD, SYNC_ID);
  return encryptData(serializeBookmarks(tree), hash);
}

/** Installs a stateful mock of the xBrowserSync API on a browser context. */
async function installApiMock(context: BrowserContext, state: ServerState): Promise<void> {
  await context.route(`${SERVICE_URL}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/info') {
      return json({ status: 1, version: '1.1.13', message: '', maxSyncSize: 2_000_000 });
    }
    if (path.endsWith('/lastUpdated')) {
      return json({ lastUpdated: state.lastUpdated });
    }
    if (req.method() === 'PUT' && /\/bookmarks\/[^/]+$/.test(path)) {
      const body = req.postDataJSON() as { bookmarks: string };
      state.blob = body.bookmarks;
      state.lastUpdated = new Date().toISOString();
      return json({ lastUpdated: state.lastUpdated });
    }
    if (req.method() === 'GET' && /\/bookmarks\/[^/]+$/.test(path)) {
      return json({ bookmarks: state.blob, lastUpdated: state.lastUpdated, version: state.version });
    }
    return route.fulfill({ status: 404, body: '{"code":"NotFound","message":"x"}' });
  });
}

async function login(page: Page): Promise<void> {
  await page.getByTestId('serviceUrl').fill(SERVICE_URL);
  await page.getByTestId('syncId').fill(SYNC_ID);
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('loginSubmit').click();
  await expect(page.getByTestId('bookmarkList')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('login decrypts and renders, search, add+push, second-session pull, offline reload', async ({
  browser,
}) => {
  const state: ServerState = {
    blob: await encryptTree(SEEDED),
    lastUpdated: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    version: '1.1.13',
  };

  // --- Device 1: login -> list -> search -> add (push) ---
  const ctx1 = await browser.newContext();
  await installApiMock(ctx1, state);
  const page1 = await ctx1.newPage();
  await page1.goto('/');

  await login(page1);
  await expect(page1.getByTestId('bookmarkItem')).toHaveCount(2);
  await expect(page1.getByRole('link', { name: 'xBrowserSync' })).toBeVisible();

  // Search filters the list.
  await page1.getByTestId('search').fill('github');
  await expect(page1.getByTestId('bookmarkItem')).toHaveCount(1);
  await page1.getByTestId('search').fill('');
  await expect(page1.getByTestId('bookmarkItem')).toHaveCount(2);

  // Add a bookmark -> local store + push to (mocked) backend.
  await page1.getByTestId('addTitle').fill('Hacker News');
  await page1.getByTestId('addUrl').fill('https://news.ycombinator.com/');
  await page1.getByTestId('addSubmit').click();
  await expect(page1.getByTestId('addMessage')).toHaveText(/synced/i);
  await expect(page1.getByTestId('bookmarkItem')).toHaveCount(3);

  // The push reached the server mock.
  expect(state.blob).not.toBe('');

  // --- Device 2: fresh context (empty IndexedDB) pulls the pushed state ---
  const ctx2 = await browser.newContext();
  await installApiMock(ctx2, state);
  const page2 = await ctx2.newPage();
  await page2.goto('/');
  await login(page2);
  await expect(page2.getByTestId('bookmarkItem')).toHaveCount(3);
  await expect(page2.getByText('Hacker News')).toBeVisible();
  await ctx2.close();

  // --- Offline reload on device 1: list still renders from local cache ---
  // Ensure the service worker has activated and precached the shell first.
  await page1.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await ctx1.setOffline(true);
  await page1.reload();
  await expect(page1.getByTestId('bookmarkList')).toBeVisible();
  await expect(page1.getByTestId('bookmarkItem')).toHaveCount(3);
  await expect(page1.getByText('Hacker News')).toBeVisible();

  await ctx1.close();
});

test('window.xbsReceiveSharedUrl adds and syncs a bookmark', async ({ browser }) => {
  const state: ServerState = {
    blob: await encryptTree(SEEDED),
    lastUpdated: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    version: '1.1.13',
  };
  const ctx = await browser.newContext();
  await installApiMock(ctx, state);
  const page = await ctx.newPage();
  await page.goto('/');
  await login(page);
  await expect(page.getByTestId('bookmarkItem')).toHaveCount(2);

  await page.evaluate(() =>
    window.xbsReceiveSharedUrl('https://example.com/shared', 'Shared Link'),
  );

  await expect(page.getByText('Shared Link')).toBeVisible();
  await expect(page.getByTestId('bookmarkItem')).toHaveCount(3);
  await ctx.close();
});
