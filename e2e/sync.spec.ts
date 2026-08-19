import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import {
  BookmarkContainer,
  decryptData,
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

/** Decrypts a blob the app pushed, so a test can assert on what actually went up. */
async function decryptTree(blob: string): Promise<string> {
  const hash = await getPasswordHash(PASSWORD, SYNC_ID);
  return decryptData(blob, hash);
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

/**
 * Appends a node straight into the PWA's IndexedDB store, inside the first container,
 * bypassing every core code path. Simulates a bookmarklet the user already had — the
 * one thing the app itself will not create, since the add form rejects the scheme.
 */
async function seedLocalBookmark(page: Page, title: string, url: string): Promise<void> {
  await page.evaluate(
    async ([title, url]) => {
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
      containers[0]!.children!.push({ title: title!, url: url! });
      await new Promise<void>((resolve, reject) => {
        const put = store.put(containers, 'localBookmarks');
        put.onsuccess = () => resolve();
        put.onerror = () => reject(put.error);
      });
    },
    [title, url],
  );
}

test('an unsafe URL already in the local store renders inert, not as a link', async ({
  browser,
}) => {
  // The store is not a trust boundary the library sees, so the guard has to be at
  // the render — and since 0.3.0 these entries stay put instead of being erased by
  // the next pull, so this is the steady state, not a transient one.
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

  await seedLocalBookmark(page, 'Legacy Pwned', UNSAFE_URL);

  await page.reload();
  await expect(page.getByTestId('bookmarkItem')).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'Legacy Pwned' })).toHaveCount(0);
  await expect(page.getByTestId('blockedBookmark')).toHaveText('Legacy Pwned');
  await ctx.close();
});

test('a local bookmarklet survives a pull that rewrites the whole tree', async ({ browser }) => {
  // Regression test for MarkSyncOrg/core#3, from the consumer's side. `setBookmarks` is
  // a destructive full-tree write and the tree being written is sanitised, so on 0.2.0
  // the first pull deleted the bookmarklet from the device — the only copy, since the
  // upload filter had already excluded it. 0.3.0 reinstates it before the write.
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

  await seedLocalBookmark(page, 'My bookmarklet', UNSAFE_URL);
  await page.reload();
  await expect(page.getByTestId('bookmarkItem')).toHaveCount(3);

  // Another device pushes. Sanitising the local tree is symmetric, so the bookmarklet
  // does not make this device dirty — the sync is a straight pull, which is exactly
  // the path that used to destroy it.
  state.blob = await encryptTree([...SEEDED, { title: 'From Elsewhere', url: 'https://example.org/' }]);
  state.lastUpdated = new Date('2024-06-01T00:00:00.000Z').toISOString();
  await page.getByTestId('syncButton').click();

  await expect(page.getByRole('link', { name: 'From Elsewhere' })).toBeVisible();
  await expect(page.getByTestId('blockedBookmark')).toHaveText('My bookmarklet');
  await expect(page.getByTestId('bookmarkItem')).toHaveCount(4);

  // Kept is not the same as synced: the next push still uploads a tree without it.
  await page.getByTestId('addTitle').fill('Hacker News');
  await page.getByTestId('addUrl').fill('https://news.ycombinator.com/');
  await page.getByTestId('addSubmit').click();
  await expect(page.getByTestId('addMessage')).toHaveText(/synced/i);

  const uploaded = await decryptTree(state.blob);
  expect(uploaded).toContain('news.ycombinator.com');
  expect(uploaded).not.toContain('javascript:');

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

test('descriptions and tags survive a pull, are searchable, and are not stripped on push', async ({
  browser,
}) => {
  // Descriptions and tags are part of the xBrowserSync model but no browser stores
  // them, so they exist only in the synced payload. A client that drops them on the
  // way through erases them for every device sharing the sync — which is exactly what
  // this asserts does not happen here.
  const described = [newBookmark(BookmarkContainer.Toolbar)];
  const toolbar = getContainer(BookmarkContainer.Toolbar, described, true)!;
  toolbar.children = [
    newBookmark('Caniuse', 'https://caniuse.com/', 'Browser support tables', [
      'compat',
      'reference',
    ]),
    newBookmark('GitHub', 'https://github.com/'),
  ];

  const state: ServerState = {
    blob: await encryptCustomTree(described),
    lastUpdated: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    version: '1.1.13',
  };

  const ctx = await browser.newContext();
  await installApiMock(ctx, state);
  const page = await ctx.newPage();
  await page.goto('/');
  await login(page);

  // Both are rendered, so metadata written by another client is actually readable.
  const caniuse = page.getByTestId('bookmarkItem').filter({ hasText: 'Caniuse' });
  await expect(caniuse).toContainText('Browser support tables');
  await expect(caniuse).toContainText('compat, reference');

  // Searchable by description and by tag, not just by title and URL.
  await page.getByTestId('search').fill('support tables');
  await expect(page.getByTestId('bookmarkItem')).toHaveCount(1);
  await page.getByTestId('search').fill('compat');
  await expect(page.getByTestId('bookmarkItem')).toHaveCount(1);
  await page.getByTestId('search').fill('');

  // Adding a bookmark pushes the whole tree. The metadata on the entry we did not
  // touch has to still be in what goes up.
  await page.getByTestId('addTitle').fill('Hacker News');
  await page.getByTestId('addUrl').fill('https://news.ycombinator.com/');
  await page.getByTestId('addSubmit').click();
  await expect(page.getByTestId('addMessage')).toHaveText(/synced/i);

  const pushed = JSON.parse(await decryptTree(state.blob)) as {
    children?: { children?: { url?: string; description?: string; tags?: string[] }[] }[];
  }[];
  const uploaded = pushed[0]!.children!.find((node) => node.url === 'https://caniuse.com/')!;
  expect(uploaded.description).toBe('Browser support tables');
  expect(uploaded.tags).toEqual(['compat', 'reference']);

  await ctx.close();
});

/**
 * Serves a page whose `<meta>` tags are what the suggestion is supposed to find, with
 * the CORS header that makes it readable from the app's origin at all.
 *
 * That header is the whole reason this has to be mocked: a real site almost never sends
 * it, which is exactly the limitation `readPageMetadata` documents. Mocking it here
 * tests the path that runs when a site does allow the read — the parsing, the
 * precedence and the fill-only-what-is-empty rule — rather than pretending the common
 * case is a hit.
 */
async function serveMetaPage(context: BrowserContext, url: string): Promise<void> {
  await context.route(url, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: `<!doctype html><html><head>
        <title>Caniuse</title>
        <meta name="description" content="The plain description, which loses.">
        <meta property="og:description" content="Support tables for HTML5, CSS3 and more">
        <meta name="keywords" content="Compat, browser support ,, COMPAT, css">
      </head><body>ignored</body></html>`,
    }),
  );
}

test('the add form suggests the page description and tags, and only fills empty fields', async ({
  browser,
}) => {
  const state: ServerState = {
    blob: await encryptTree(SEEDED),
    lastUpdated: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    version: '1.1.13',
  };
  const ctx = await browser.newContext();
  await installApiMock(ctx, state);
  const SUGGESTED = 'https://caniuse.com/suggested';
  await serveMetaPage(ctx, SUGGESTED);
  const page = await ctx.newPage();
  await page.goto('/');
  await login(page);

  // Entering the URL is what triggers the read: the fields fill themselves, and the
  // hint says the values are a suggestion rather than something already recorded.
  await page.getByTestId('addUrl').fill(SUGGESTED);
  await page.getByTestId('addUrl').blur();

  // og:description wins over the plain `description` meta, matching the extension.
  await expect(page.getByTestId('addDescription')).toHaveValue(
    'Support tables for HTML5, CSS3 and more',
  );
  // Keywords are normalised by core: trimmed, de-duplicated case-insensitively (the
  // second "COMPAT" is dropped), empties removed and sorted into canonical order.
  await expect(page.getByTestId('addTags')).toHaveValue('browser support, compat, css');
  await expect(page.getByTestId('addHint')).toContainText(/suggested/i);
  await expect(page.getByTestId('addDescriptionCount')).toContainText('39 / 300');

  // What the user typed is never overwritten by the page's own claims. A second URL
  // with the same metadata leaves both fields exactly as they are now.
  await page.getByTestId('addDescription').fill('Mine, not the page’s');
  await page.getByTestId('addTags').fill('keep');
  const SECOND = 'https://caniuse.com/second';
  await serveMetaPage(ctx, SECOND);
  await page.getByTestId('addUrl').fill(SECOND);
  await page.getByTestId('addUrl').blur();
  await expect(page.getByTestId('addTags')).toHaveValue('keep');
  await expect(page.getByTestId('addDescription')).toHaveValue('Mine, not the page’s');

  // Saving puts both into the tree that goes up, so the suggestion the user accepted
  // reaches every other device rather than living in this browser.
  await page.getByTestId('addTitle').fill('Caniuse');
  await page.getByTestId('addSubmit').click();
  await expect(page.getByTestId('addMessage')).toHaveText(/synced/i);

  const item = page.getByTestId('bookmarkItem').filter({ hasText: 'Caniuse' });
  await expect(item).toContainText('Mine, not the page’s');
  await expect(item).toContainText('keep');

  const pushed = JSON.parse(await decryptTree(state.blob)) as {
    children?: { url?: string; description?: string; tags?: string[] }[];
  }[];
  const uploaded = pushed
    .flatMap((container) => container.children ?? [])
    .find((node) => node.url === SECOND)!;
  expect(uploaded.description).toBe('Mine, not the page’s');
  expect(uploaded.tags).toEqual(['keep']);

  // The form is emptied for the next bookmark, suggestion and hint included.
  await expect(page.getByTestId('addDescription')).toHaveValue('');
  await expect(page.getByTestId('addTags')).toHaveValue('');
  await expect(page.getByTestId('addHint')).toHaveText('');

  await ctx.close();
});

test('a share with text records it as the description; a share without a title still names the bookmark', async ({
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
  await expect(page.getByTestId('bookmarkItem')).toHaveCount(2);

  // A share sheet carries the page's excerpt as its text. It is the only bookmark
  // metadata a share can deliver, and the share itself is the confirmation, so it is
  // stored rather than offered.
  await page.evaluate(() =>
    window.marksyncReceiveSharedUrl(
      'https://example.com/shared',
      'Shared Link',
      'What the share sheet said about the page',
    ),
  );
  const shared = page.getByTestId('bookmarkItem').filter({ hasText: 'Shared Link' });
  await expect(shared).toContainText('What the share sheet said about the page');

  // A share whose text is just the link again would make a description of the URL, so
  // it is dropped instead.
  await page.evaluate(() =>
    window.marksyncReceiveSharedUrl(
      'https://example.com/echoed',
      'Echoed',
      'https://example.com/echoed',
    ),
  );
  const echoed = page.getByTestId('bookmarkItem').filter({ hasText: 'Echoed' });
  await expect(echoed).toHaveCount(1);
  await expect(echoed.locator('.description')).toHaveCount(0);

  // The ?share… query params take the same path. With no title the text names the
  // bookmark, as it did before there was a description to put it in.
  await page.goto(
    '/?shareUrl=https%3A%2F%2Fexample.com%2Fvia-params&shareText=Only%20text%20was%20shared',
  );
  await expect(page.getByTestId('bookmarkList')).toBeVisible();
  const viaParams = page.getByTestId('bookmarkItem').filter({ hasText: 'Only text was shared' });
  await expect(viaParams).toHaveCount(1);
  await expect(viaParams.locator('.description')).toHaveCount(0);

  const pushed = JSON.parse(await decryptTree(state.blob)) as {
    children?: { url?: string; description?: string }[];
  }[];
  const nodes = pushed.flatMap((container) => container.children ?? []);
  expect(nodes.find((n) => n.url === 'https://example.com/shared')?.description).toBe(
    'What the share sheet said about the page',
  );
  expect(nodes.find((n) => n.url === 'https://example.com/echoed')?.description).toBeUndefined();

  await ctx.close();
});

// Injection payloads, one per field that a bookmark can carry. Titles, descriptions and
// tags are free text: core bounds and normalises them but never strips markup from them
// (nor should it — a bookmark whose title really is `<b>x</b>` must keep it), so the
// guarantee has to hold at the point they are rendered.
const XSS_TITLE = '<img src=x onerror="window.__pwned=1">TitlePayload';
const XSS_DESCRIPTION = '</div><script>window.__pwned=1</script>DescPayload';
const XSS_TAG = '<svg onload="window.__pwned=1">TagPayload';

test('markup in a title, description or tag is rendered as text, never as HTML', async ({
  browser,
}) => {
  // Arrives the way a hostile value realistically would: written by another client and
  // pulled out of the sync, so it has crossed core and reaches the renderer intact.
  const hostile = [newBookmark(BookmarkContainer.Toolbar)];
  const toolbar = getContainer(BookmarkContainer.Toolbar, hostile, true)!;
  toolbar.children = [
    newBookmark(XSS_TITLE, 'https://example.com/hostile', XSS_DESCRIPTION, [XSS_TAG]),
  ];

  const state: ServerState = {
    blob: await encryptCustomTree(hostile),
    lastUpdated: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    version: '1.1.13',
  };
  const ctx = await browser.newContext();
  await installApiMock(ctx, state);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await login(page);

  // Each payload is present as literal text, which is only possible if it went through a
  // text node rather than being parsed as markup.
  const item = page.getByTestId('bookmarkItem').filter({ hasText: 'TitlePayload' });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(XSS_TITLE);
  await expect(item).toContainText(XSS_DESCRIPTION);
  await expect(item).toContainText(XSS_TAG);

  // Nothing was injected: no element the payloads would have created exists, and no
  // handler on any of them ran.
  expect(await page.locator('#app img[src="x"], #app svg, #app script').count()).toBe(0);
  expect(await page.evaluate(() => '__pwned' in window)).toBe(false);
  expect(errors).toEqual([]);

  // The same values survive a round trip through the add form, which is the other way in.
  await page.getByTestId('addTitle').fill(XSS_TITLE);
  await page.getByTestId('addUrl').fill('https://example.com/typed');
  await page.getByTestId('addDescription').fill(XSS_DESCRIPTION);
  await page.getByTestId('addTags').fill(XSS_TAG);
  await page.getByTestId('addSubmit').click();
  await expect(page.getByTestId('addMessage')).toHaveText(/synced/i);
  expect(await page.evaluate(() => '__pwned' in window)).toBe(false);
  expect(await page.locator('#app img[src="x"], #app svg, #app script').count()).toBe(0);

  // Searching renders the same values down a second code path (flat list + breadcrumb).
  await page.getByTestId('search').fill('TagPayload');
  await expect(page.getByTestId('bookmarkItem')).toHaveCount(2);
  expect(await page.evaluate(() => '__pwned' in window)).toBe(false);
  expect(errors).toEqual([]);

  await ctx.close();
});

test('a hostile page cannot inject through the metadata it suggests', async ({ browser }) => {
  const state: ServerState = {
    blob: await encryptTree(SEEDED),
    lastUpdated: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    version: '1.1.13',
  };
  const ctx = await browser.newContext();
  await installApiMock(ctx, state);

  // The suggestion reads a document the app does not control, so the page gets to choose
  // the bytes: a script that would run if the markup were ever live, markup inside the
  // meta content itself, and a redirect that must not be followed.
  const HOSTILE = 'https://hostile.example/page';
  await ctx.route(HOSTILE, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: `<!doctype html><html><head>
        <script>window.__pwned = 1;</script>
        <meta http-equiv="refresh" content="0;url=https://elsewhere.example/">
        <meta property="og:description" content='</textarea><img src=x onerror="window.__pwned=1">Suggested'>
        <meta name="keywords" content='<svg onload="window.__pwned=1">, ok'>
        <img src="https://tracker.example/pixel.gif">
      </head><body></body></html>`,
    }),
  );
  // Nothing in the fetched document may cause a request of its own. Any hit here means
  // the markup was made live rather than parsed inert.
  let subresources = 0;
  await ctx.route('https://tracker.example/**', (route) => {
    subresources += 1;
    return route.abort();
  });
  await ctx.route('https://elsewhere.example/**', (route) => {
    subresources += 1;
    return route.abort();
  });

  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  await login(page);

  await page.getByTestId('addUrl').fill(HOSTILE);
  await page.getByTestId('addUrl').blur();

  // The suggestion still arrives — it is just inert text in a form field.
  await expect(page.getByTestId('addDescription')).toHaveValue(/Suggested$/);
  await expect(page.getByTestId('addTags')).toHaveValue(/ok/);

  expect(await page.evaluate(() => '__pwned' in window)).toBe(false);
  expect(await page.locator('#app img[src="x"], #app svg, #app script').count()).toBe(0);
  expect(subresources).toBe(0);
  // The app is still on its own origin: no meta refresh was honoured.
  expect(new URL(page.url()).origin).toBe(origin);
  await expect(page.getByTestId('addForm')).toBeVisible();
  expect(errors).toEqual([]);

  await ctx.close();
});
