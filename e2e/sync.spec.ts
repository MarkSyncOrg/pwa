import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import {
  BookmarkContainer,
  encryptData,
  getContainer,
  getPasswordHash,
  newBookmark,
  serializeBookmarks,
} from '@marksyncorg/core';

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

/** Encrypts an arbitrary container tree, for the folder-tree test below. */
async function encryptCustomTree(tree: ReturnType<typeof newBookmark>[]): Promise<string> {
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

// Long enough to overflow the row at any viewport this suite runs at.
const LONG_URL =
  'https://caniuse.com/?search=details%20element%20support&utm_source=marksync&utm_medium=e2e&utm_campaign=truncation-check&session=6f2a1c9d4b8e7f30a1c2d3e4f5061728';

test('folders render as an expandable tree; search flattens it with breadcrumbs', async ({
  browser,
}) => {
  // Toolbar
  //   Dev/            (nested, starts collapsed)
  //     MDN, Caniuse
  //   Hacker News     (loose bookmark at container level)
  const dev = newBookmark('Dev');
  dev.children = [
    newBookmark('MDN', 'https://developer.mozilla.org/'),
    newBookmark('Caniuse', LONG_URL),
  ];
  const toolbar = newBookmark(BookmarkContainer.Toolbar);
  toolbar.children = [dev, newBookmark('Hacker News', 'https://news.ycombinator.com/')];

  const state: ServerState = {
    blob: await encryptCustomTree([toolbar]),
    lastUpdated: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    version: '1.1.13',
  };
  const ctx = await browser.newContext();
  await installApiMock(ctx, state);
  const page = await ctx.newPage();
  await page.goto('/');
  await login(page);

  // The container is open by default and shows its own total; the nested
  // folder is closed, so its bookmarks are in the DOM but not visible.
  const toolbarFolder = page.getByTestId('folderItem').filter({ hasText: 'Toolbar' }).first();
  await expect(toolbarFolder.getByTestId('folderToggle').first()).toContainText('3');
  await expect(page.getByRole('link', { name: 'Hacker News' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'MDN' })).toBeHidden();

  // Expanding the nested folder reveals them.
  await page.getByTestId('folderToggle').filter({ hasText: 'Dev' }).click();
  await expect(page.getByRole('link', { name: 'MDN' })).toBeVisible();

  // Collapsing the container hides everything under it.
  await page.getByTestId('folderToggle').filter({ hasText: 'Toolbar' }).click();
  await expect(page.getByRole('link', { name: 'Hacker News' })).toBeHidden();
  await page.getByTestId('folderToggle').filter({ hasText: 'Toolbar' }).click();

  // Searching drops the hierarchy and labels each hit with its folder path.
  await page.getByTestId('search').fill('mdn');
  await expect(page.getByTestId('bookmarkItem')).toHaveCount(1);
  await expect(page.getByTestId('bookmarkItem')).toContainText('Toolbar / Dev');
  await expect(page.getByTestId('folderItem')).toHaveCount(0);

  // Clearing it restores the tree with the expansion state from before.
  await page.getByTestId('search').fill('');
  await expect(page.getByRole('link', { name: 'MDN' })).toBeVisible();

  // A long URL is truncated to its row rather than wrapping over three lines.
  const caniuse = page.getByTestId('bookmarkItem').filter({ hasText: 'Caniuse' });
  const url = caniuse.locator('.url');
  await expect(url).toHaveAttribute('title', LONG_URL);
  const { scrollWidth, clientWidth, lines } = await url.evaluate((n) => ({
    scrollWidth: n.scrollWidth,
    clientWidth: n.clientWidth,
    lines: n.getClientRects().length,
  }));
  expect(lines).toBe(1);
  expect(scrollWidth).toBeGreaterThan(clientWidth);

  await ctx.close();
});

// Security behaviour introduced by @marksyncorg/core 0.2.0: unsafe URL schemes are
// dropped from every tree crossing a trust boundary, and the app is responsible for
// the two ends the library cannot reach — the add form and the render.

const UNSAFE_URL = 'javascript:alert(document.domain)';

test('a javascript: bookmark in the sync payload never reaches the list', async ({ browser }) => {
  // Core sanitises the decrypted tree, so the entry is gone before the PWA's store
  // ever sees it; the two safe siblings still arrive.
  const toolbar = newBookmark(BookmarkContainer.Toolbar);
  toolbar.children = [
    newBookmark('xBrowserSync', 'https://www.xbrowsersync.org/'),
    newBookmark('Pwned', UNSAFE_URL),
    newBookmark('GitHub', 'https://github.com/'),
  ];
  const state: ServerState = {
    blob: await encryptCustomTree([toolbar]),
    lastUpdated: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    version: '1.1.13',
  };
  const ctx = await browser.newContext();
  await installApiMock(ctx, state);
  const page = await ctx.newPage();
  await page.goto('/');
  await login(page);

  await expect(page.getByTestId('bookmarkItem')).toHaveCount(2);
  await expect(page.getByText('Pwned')).toHaveCount(0);
  await ctx.close();
});

test('the add form rejects an unsafe URL instead of storing one that will not sync', async ({
  browser,
}) => {
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

  // type="url" would block this on submit, so set the value past the form and
  // submit programmatically — the same path the share hooks take.
  await page.getByTestId('addTitle').fill('Pwned');
  await page.getByTestId('addUrl').evaluate((input, value) => {
    (input as HTMLInputElement).type = 'text';
    (input as HTMLInputElement).value = value;
  }, UNSAFE_URL);
  await page.getByTestId('addSubmit').click();

  await expect(page.getByTestId('addMessage')).toHaveText(/http, https, ftp and mailto/i);
  await expect(page.getByTestId('bookmarkItem')).toHaveCount(2);

  // The share hook rejects it too, rather than queueing it for later.
  const rejected = await page.evaluate(
    (url) => window.marksyncReceiveSharedUrl(url).then(() => false, () => true),
    UNSAFE_URL,
  );
  expect(rejected).toBe(true);
  await expect(page.getByTestId('bookmarkItem')).toHaveCount(2);
  await ctx.close();
});

test('an unsafe URL already in the local store renders inert, not as a link', async ({
  browser,
}) => {
  // Defence in depth for a tree written by a pre-0.2.0 build: the store is not a
  // trust boundary the library sees, so the guard has to be at the render.
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

  // Write straight into the PWA's IndexedDB store, bypassing every core code path.
  await page.evaluate(async (url) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('marksync', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction('kv', 'readwrite');
    const store = tx.objectStore('kv');
    const tree = await new Promise<unknown>((resolve, reject) => {
      const get = store.get('localBookmarks');
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    const containers = tree as { children?: { title: string; url: string }[] }[];
    containers[0]!.children!.push({ title: 'Legacy Pwned', url });
    await new Promise<void>((resolve, reject) => {
      const put = store.put(containers, 'localBookmarks');
      put.onsuccess = () => resolve();
      put.onerror = () => reject(put.error);
    });
  }, UNSAFE_URL);

  await page.reload();
  await expect(page.getByTestId('bookmarkItem')).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'Legacy Pwned' })).toHaveCount(0);
  await expect(page.getByTestId('blockedBookmark')).toHaveText('Legacy Pwned');
  await ctx.close();
});

test('window.marksyncReceiveSharedUrl adds and syncs a bookmark', async ({ browser }) => {
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
    window.marksyncReceiveSharedUrl('https://example.com/shared', 'Shared Link'),
  );

  await expect(page.getByText('Shared Link')).toBeVisible();
  await expect(page.getByTestId('bookmarkItem')).toHaveCount(3);
  await ctx.close();
});
