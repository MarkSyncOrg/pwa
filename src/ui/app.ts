import {
  type BookmarkUrlPolicy,
  DESCRIPTION_MAX_LENGTH,
  formatTags,
  isSafeBookmarkUrl,
  isSyncableBookmarkUrl,
  normalizeDescription,
  parseTags,
  type SyncEngine,
  SyncConflictError,
  type SyncStore,
} from '@marksyncorg/core';
import {
  buildBookmarkTree,
  type FlatBookmark,
  flattenBookmarks,
  type LocalBookmarksProvider,
  type TreeFolder,
  type TreeNode,
} from '../adapters/local-bookmarks';
import { readPageMetadata } from '../adapters/page-metadata';
import { cycleTheme, getThemePreference, type ThemePreference } from './theme';
import './styles.css';

const DEFAULT_SERVICE_URL = 'https://api.xbrowsersync.org';

/**
 * How long to wait after the last keystroke in the URL field before asking the page
 * what it says about itself. Long enough that typing a URL out by hand is one request
 * rather than thirty, short enough that a paste feels immediate.
 */
const SUGGEST_DEBOUNCE_MS = 450;

/**
 * A URL arriving from outside the app: an Android share target, an iOS Shortcut, or the
 * native Share Extension.
 *
 * `text` is the share sheet's text alongside the link — typically the page's excerpt or
 * the user's selection, which is the one piece of bookmark metadata a share can actually
 * deliver, since no share sheet has a tags field.
 */
export interface SharedUrl {
  url: string;
  title?: string;
  text?: string;
}

/** The metadata suggestion offered for a URL, normalised and ready for the fields. */
interface Suggestion {
  description: string;
  tags: string[];
}

/** Live references to the add form's fields, so a suggestion or a share can reach them. */
interface AddFormFields {
  title: HTMLInputElement;
  url: HTMLInputElement;
  description: HTMLTextAreaElement;
  tags: HTMLInputElement;
  count: HTMLElement;
  hint: HTMLElement;
}

// Minimal DOM helper: tag with attributes/children, no framework.
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

// Brand mark for the app header. Both variants are served from public/, so both are
// precached and show offline; styles.css shows only one at a time, on the same
// selectors that drive the rest of the theme, so the mark always matches the
// current theme with no JS involved.
function brandMark(): HTMLElement {
  const img = (variant: 'on-dark' | 'on-light', src: string) =>
    el('img', { class: variant, src, alt: '', width: '20', height: '24' });
  return el(
    'span',
    { class: 'mark' },
    img('on-dark', '/brand/marksync-mark.svg'),
    img('on-light', '/brand/marksync-mark-onlight.svg'),
  );
}

// Build-time versions (see vite.config.ts), shown in the header on every screen so
// a bug report or a "which build is this" question always has an answer on-screen —
// the core version too, since a sync bug can as easily be @marksyncorg/core's as
// the PWA's own.
function versionTag(): HTMLElement {
  return el(
    'span',
    { class: 'version', 'data-testid': 'appVersion' },
    `v${__APP_VERSION__} · core ${__CORE_VERSION__}`,
  );
}

function themeLabel(pref: ThemePreference): string {
  switch (pref) {
    case 'system':
      return 'Auto';
    case 'light':
      return 'Light';
    case 'dark':
      return 'Dark';
  }
}

// Cycles system → light → dark → system. Labelled with the mode's name rather than
// an icon: the app draws nothing else as an icon (the folder twist is a mono '+'),
// and a word survives a screen reader and a glance both, which a sun/moon glyph
// pair does not always do at 11px.
function themeToggle(): HTMLElement {
  const btn = el(
    'button',
    {
      type: 'button',
      class: 'secondary theme-toggle',
      'data-testid': 'themeToggle',
      title: 'Switch color theme — cycles Auto, Light, Dark',
    },
    themeLabel(getThemePreference()),
  ) as HTMLButtonElement;
  btn.addEventListener('click', () => {
    btn.textContent = themeLabel(cycleTheme());
  });
  return btn;
}

/**
 * Rejects a URL this device would refuse to sync. `isSyncableBookmarkUrl` also rejects
 * anything that is not an absolute URL, which is the check the `type="url"` input
 * gives us for free but the share hooks do not get at all.
 *
 * Wider than what the list will render as a link: `chrome://` and `file://` bookmarks
 * are carried by the sync for the browsers that can open them, so saving one here is
 * saving a real bookmark, not a broken one.
 */
function assertSyncableUrl(url: string, policy: BookmarkUrlPolicy): void {
  if (!isSyncableBookmarkUrl(url, policy)) {
    throw new Error(
      policy.allowBookmarklets === true
        ? 'That is not an address this device can save.'
        : 'That is not an address this device can save. Bookmarklets (javascript: and data:) ' +
          'need "Sync bookmarklets" turned on.',
    );
  }
}

// Long URLs are truncated to one line by CSS; dropping the scheme and any
// trailing slash first spends that line on the part that identifies the page.
function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * The row's title element: a link, or inert text with the reason it is not one.
 *
 * Three states, because there are three different things to say:
 *
 *  - an ordinary web address becomes an `<a href>`;
 *  - `chrome://`, `file://` and the other local schemes are synced like anything else,
 *    but only a browser can open them, so this shows the entry without pretending a web
 *    app could follow it;
 *  - a bookmarklet is inert *and* excluded from the sync while the option is off, which
 *    is a different fact about the same row and has to read differently.
 *
 * The core sanitises every tree crossing a trust boundary, but the list is read straight
 * from the local store, which is not one of those boundaries, so the render-time guard
 * core's SECURITY.md asks for lives here. `isSafeBookmarkUrl` stays the gate on `href`
 * whatever the sync policy is: a `javascript:` URL would otherwise execute in this
 * origin.
 */
function bookmarkTitle(b: FlatBookmark, policy: BookmarkUrlPolicy): HTMLElement {
  if (isSafeBookmarkUrl(b.url)) {
    return el('a', { href: b.url, target: '_blank', rel: 'noopener noreferrer', title: b.url }, b.title);
  }
  if (isSyncableBookmarkUrl(b.url, policy)) {
    return el(
      'span',
      {
        class: 'unopenable',
        'data-testid': 'unopenableBookmark',
        title: `Synced, but only a browser can open this address: ${b.url}`,
      },
      b.title,
    );
  }
  return el(
    'span',
    {
      class: 'blocked',
      'data-testid': 'blockedBookmark',
      title: `Kept on this device but never synced: ${b.url}`,
    },
    b.title,
  );
}

/**
 * One bookmark row. Search results also carry the folder path they came from.
 *
 * An entry the sync refuses is a permanent resident of the list rather than a transient
 * one (since core 0.3.0 it survives the destructive write a pull performs), so the row
 * has to say why it looks different: excluded from the sync, not broken.
 */
function bookmarkItem(b: FlatBookmark, showPath: boolean, policy: BookmarkUrlPolicy): HTMLElement {
  const item = el('li', { class: 'bookmark', 'data-testid': 'bookmarkItem' });
  if (showPath && b.path.length) {
    item.append(el('div', { class: 'crumb' }, b.path.join(' / ')));
  }
  item.append(
    bookmarkTitle(b, policy),
    el('div', { class: 'url', title: b.url }, prettyUrl(b.url)),
  );
  // Description and tags come from the sync, not from any browser: no bookmarks API
  // has anywhere to keep them, so they exist only in the synced payload. The PWA is
  // where they are read — an extension can capture them while you are on the page,
  // but this is the view with room to show what they say.
  if (b.description) {
    item.append(el('div', { class: 'description', title: b.description }, b.description));
  }
  if (b.tags?.length) item.append(el('div', { class: 'tags' }, b.tags.join(', ')));
  return item;
}

export class App {
  private root: HTMLElement;
  private bookmarks: FlatBookmark[] = [];
  private tree: TreeNode[] = [];
  // Expansion state, kept by folder id so it survives a re-render after an add
  // or a sync. Top-level folders (the containers) start open, everything below
  // starts closed, so only a deliberate toggle is remembered either way. Both
  // sets are refreshed from the live `<details>` elements immediately before
  // every re-render — see `captureExpansion`.
  private openFolders = new Set<string>();
  private closedFolders = new Set<string>();
  private query = '';
  private pendingShare: SharedUrl | undefined;
  // Live references to the results region, so adds/syncs can refresh just the
  // list without rebuilding (and wiping) the add form and its status message.
  private listEl: HTMLElement | undefined;
  private countEl: HTMLElement | undefined;
  private syncBtn: HTMLButtonElement | undefined;
  private addMsgEl: HTMLElement | undefined;
  private addFields: AddFormFields | undefined;
  // The URL a suggestion has already been attempted for. Blurring the URL field
  // repeatedly, or editing the title and coming back, must not refetch the same page —
  // so a request is only made when this does not already name the URL in the field.
  // Cleared after an add, which is what lets the next bookmark be asked about even if
  // it happens to be the same URL.
  private suggestedFor: string | undefined;
  private suggestTimer: number | undefined;

  /**
   * What this device is willing to sync beyond the default set, read from the same
   * settings the engine reads. Held here because it decides three things the UI owns:
   * how a row renders, what the add form accepts, and what the toggle shows.
   */
  private urlPolicy: BookmarkUrlPolicy = {};

  constructor(
    root: HTMLElement,
    private readonly engine: SyncEngine,
    private readonly provider: LocalBookmarksProvider,
    private readonly store: SyncStore,
  ) {
    this.root = root;
  }

  /** Boots: shows the bookmark list if a sync is already enabled, else the login. */
  async start(share?: SharedUrl): Promise<void> {
    this.pendingShare = share;
    await this.loadUrlPolicy();
    const status = await this.engine.getStatus();
    this.root.removeAttribute('aria-busy');
    if (status.enabled) {
      await this.loadAndRenderList();
      const shared = await this.flushPendingShare();
      if (!shared) {
        await this.syncOnOpen();
      }
    } else {
      this.renderLogin();
    }
  }

  /**
   * Syncs once, on the way in.
   *
   * Deliberately after the first render rather than before it: the store is the source
   * the list draws from, and it is already on disk, so the bookmarks are on screen
   * before the network is touched. A device that opens the app offline, or against a
   * service that is down, still sees its bookmarks and simply does not get an update,
   * which is why the failure is silent here and noisy nowhere.
   *
   * The caller skips it when a share arrived with the launch: that path pushes the new
   * bookmark and reconciles as part of saving it, so this would be the same round trip
   * a second time.
   */
  private async syncOnOpen(): Promise<void> {
    await this.doSync({ silent: true });
  }

  /** Refreshes {@link urlPolicy} from the stored settings. */
  private async loadUrlPolicy(): Promise<void> {
    const { syncBookmarklets } = await this.store.getSettings();
    this.urlPolicy = { allowBookmarklets: syncBookmarklets };
  }

  /**
   * Programmatic share hook (iOS Shortcut / Plan B native Share Extension).
   *
   * `text` is what the share sheet carried alongside the link — on both Android's
   * share target and an iOS Shortcut that is the page's own excerpt or selection, so
   * it becomes the bookmark's description. This path stores it without a review step
   * because it has none to offer: the share *is* the confirmation, and the alternative
   * is a bookmark with no description at all. The add form, which does have a review
   * step, only ever suggests (see {@link suggestFromPage}).
   */
  async receiveSharedUrl(url: string, title?: string, text?: string): Promise<void> {
    await this.loadUrlPolicy();
    assertSyncableUrl(url, this.urlPolicy);
    const share: SharedUrl = { url, title, text };
    const status = await this.engine.getStatus();
    if (!status.enabled) {
      this.pendingShare = share;
      return;
    }
    await this.addShare(share);
  }

  /**
   * Adds a share that arrived before the list was ready. Guarded, because this
   * runs on the boot path: a rejected URL must surface as a message, not as an
   * exception that leaves the app half-rendered.
   */
  private async flushPendingShare(): Promise<boolean> {
    const share = this.pendingShare;
    if (!share) {
      return false;
    }
    this.pendingShare = undefined;
    try {
      await this.addShare(share);
    } catch (err) {
      this.reportAddError(err);
    }
    // Attempted either way: a share that failed to save has already reported why, and
    // syncing on top of it would only replace that message with a fresh render.
    return true;
  }

  /**
   * Adds a shared URL with whatever metadata the share itself carried.
   *
   * Only the shared text is used, never a fetch of the page: this runs on the boot
   * path, where a slow or unreachable site would delay the one thing the user asked
   * for. The description is bounded here rather than left to `newBookmark` so the
   * value handed to the store is already the final one, as it is for the add form.
   */
  private async addShare(share: SharedUrl): Promise<void> {
    // A share sheet that has no separate description field often repeats the link in
    // its text; as a description that is noise, so it is dropped.
    const text = share.text?.trim();
    const description = text && text !== share.url ? normalizeDescription(text) : undefined;
    await this.addBookmark(share.title ?? share.url, share.url, description);
  }

  private reportAddError(err: unknown): void {
    const text = err instanceof Error ? err.message : 'Could not add the shared URL.';
    if (this.addMsgEl) {
      this.addMsgEl.className = 'msg error';
      this.addMsgEl.textContent = text;
    } else {
      console.error(err);
    }
  }

  private clear(): void {
    this.root.replaceChildren();
    // Dropped with the DOM they pointed at, so a message or a suggestion never goes
    // to a detached node after a logout; renderList sets them again on the way back
    // in. The pending debounce is cancelled for the same reason.
    this.addMsgEl = undefined;
    this.addFields = undefined;
    this.syncBtn = undefined;
    if (this.suggestTimer !== undefined) {
      clearTimeout(this.suggestTimer);
      this.suggestTimer = undefined;
    }
  }

  private renderLogin(): void {
    this.clear();
    const serviceUrl = el('input', {
      type: 'url',
      id: 'serviceUrl',
      'data-testid': 'serviceUrl',
      value: DEFAULT_SERVICE_URL,
    }) as HTMLInputElement;
    const syncId = el('input', { type: 'text', id: 'syncId', 'data-testid': 'syncId', autocomplete: 'off' }) as HTMLInputElement;
    const password = el('input', { type: 'password', id: 'password', 'data-testid': 'password' }) as HTMLInputElement;
    const submit = el('button', { type: 'submit', 'data-testid': 'loginSubmit' }, 'Log in') as HTMLButtonElement;
    const message = el('div', { 'data-testid': 'loginMessage' });

    const form = el(
      'form',
      { 'data-testid': 'loginForm' },
      el('label', { for: 'serviceUrl' }, 'Service URL'),
      serviceUrl,
      el('label', { for: 'syncId' }, 'Sync ID'),
      syncId,
      el('label', { for: 'password' }, 'Password'),
      password,
      el('div', { style: 'margin-top:14px' }, submit),
      message,
    );

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.login(serviceUrl.value.trim(), syncId.value.trim(), password.value, submit, message);
    });

    this.root.append(
      el('header', { class: 'bar' }, brandMark(), el('h1', {}, 'MarkSync'), versionTag(), themeToggle()),
      el('div', { class: 'card' }, el('h2', {}, 'Log in to an existing sync'), form),
    );
  }

  private async login(
    serviceUrl: string,
    syncId: string,
    password: string,
    submit: HTMLButtonElement,
    message: HTMLElement,
  ): Promise<void> {
    message.className = '';
    message.textContent = '';
    if (!serviceUrl || !syncId || !password) {
      message.className = 'msg error';
      message.textContent = 'Service URL, Sync ID and password are all required.';
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Logging in…';
    try {
      await this.engine.enableExistingSync(serviceUrl, syncId, password);
      await this.loadAndRenderList();
      await this.flushPendingShare();
    } catch (err) {
      submit.disabled = false;
      submit.textContent = 'Log in';
      message.className = 'msg error';
      message.textContent = err instanceof Error ? err.message : 'Login failed.';
    }
  }

  private async loadAndRenderList(): Promise<void> {
    await this.loadBookmarks();
    this.renderList();
  }

  private async loadBookmarks(): Promise<void> {
    const stored = await this.provider.getBookmarks();
    this.bookmarks = flattenBookmarks(stored);
    this.tree = buildBookmarkTree(stored);
  }

  private renderList(): void {
    if (this.listEl) this.captureExpansion(this.listEl);
    this.clear();
    const status = el('span', { class: 'status', 'data-testid': 'syncStatus' }, `${this.bookmarks.length} bookmarks`);
    const syncBtn = el('button', { class: 'secondary', 'data-testid': 'syncButton' }, 'Sync');
    const logoutBtn = el('button', { class: 'secondary', 'data-testid': 'logoutButton' }, 'Log out');
    this.syncBtn = syncBtn;
    syncBtn.addEventListener('click', () => void this.doSync());
    logoutBtn.addEventListener('click', () => void this.logout());

    // Add form. Description and tags are here for the same reason they are in the
    // extension's popup: they are part of the bookmark, so the moment it is created is
    // the moment to fill them in — and the only moment at which the page can still be
    // asked what it would suggest.
    const addTitle = el('input', { type: 'text', id: 'addTitle', 'data-testid': 'addTitle', placeholder: 'Title' }) as HTMLInputElement;
    const addUrl = el('input', { type: 'url', id: 'addUrl', 'data-testid': 'addUrl', placeholder: 'https://…' }) as HTMLInputElement;
    const addDescription = el('textarea', {
      id: 'addDescription',
      rows: '2',
      // The counter and the suggestion note are read out with the field rather than
      // being two orphaned lines of text a screen reader meets on its own.
      'aria-describedby': 'addDescriptionCount addHint',
      'data-testid': 'addDescription',
      placeholder: 'What is this page?',
    }) as HTMLTextAreaElement;
    // The browser enforces the model's own limit, so the field cannot hold more than
    // the sync will carry: what the user types is what gets stored, with no silent
    // truncation on save.
    addDescription.maxLength = DESCRIPTION_MAX_LENGTH;
    const addTags = el('input', {
      type: 'text',
      id: 'addTags',
      'aria-describedby': 'addHint',
      'data-testid': 'addTags',
      placeholder: 'comma, separated, tags',
    }) as HTMLInputElement;
    const addCount = el('div', { class: 'hint', id: 'addDescriptionCount', 'data-testid': 'addDescriptionCount' });
    // A suggestion arriving is announced, since it changes fields the user is not
    // looking at; `polite` waits for a pause rather than interrupting their typing.
    const addHint = el('div', {
      class: 'hint',
      id: 'addHint',
      role: 'status',
      'aria-live': 'polite',
      'data-testid': 'addHint',
    });
    const addBtn = el('button', { type: 'submit', 'data-testid': 'addSubmit' }, 'Add') as HTMLButtonElement;
    const addMsg = el('div', { 'data-testid': 'addMessage' });
    this.addMsgEl = addMsg;
    this.addFields = {
      title: addTitle,
      url: addUrl,
      description: addDescription,
      tags: addTags,
      count: addCount,
      hint: addHint,
    };
    this.renderDescriptionCount();

    const addForm = el(
      'form',
      { class: 'card', 'data-testid': 'addForm' },
      el('div', { class: 'row' },
        el('div', {}, el('label', { for: 'addTitle' }, 'Title'), addTitle),
        el('div', {}, el('label', { for: 'addUrl' }, 'URL'), addUrl),
      ),
      el('div', { class: 'row' },
        el('div', {}, el('label', { for: 'addDescription' }, 'Description'), addDescription, addCount),
      ),
      el('div', { class: 'row' },
        el('div', {}, el('label', { for: 'addTags' }, 'Tags'), addTags),
        addBtn,
      ),
      addHint,
      addMsg,
    );
    addDescription.addEventListener('input', () => this.renderDescriptionCount());
    // Two triggers for one suggestion: the debounced one catches a paste or a URL typed
    // out in full without ever leaving the field, and `change` (blur or Enter) asks
    // immediately rather than making the user wait out the debounce.
    addUrl.addEventListener('input', () => this.scheduleSuggest());
    addUrl.addEventListener('change', () => this.suggestNow());
    addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.onAdd(addBtn, addMsg);
    });

    // Search
    const search = el('input', { type: 'search', 'data-testid': 'search', placeholder: 'Search bookmarks…', value: this.query }) as HTMLInputElement;
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderResults(listEl, countEl);
    });

    const countEl = el('div', { class: 'count', 'data-testid': 'resultCount' });
    const listEl = el('ul', { class: 'bookmarks', 'data-testid': 'bookmarkList' });
    this.countEl = countEl;
    this.listEl = listEl;

    this.root.append(
      el('header', { class: 'bar' }, brandMark(), el('h1', {}, 'MarkSync'), versionTag(), themeToggle(), status, syncBtn, logoutBtn),
      addForm,
      this.bookmarkletSetting(),
      el('div', { class: 'card' }, el('label', {}, 'Search'), search, countEl, listEl),
    );
    this.renderResults(listEl, countEl);
  }

  /**
   * The one thing this device deliberately keeps out of the sync, and the switch for it.
   *
   * Everything else the browsers carry is synced, `chrome://` and `file://` included.
   * Bookmarklets are not, unless this is on: they run whatever they contain in whichever
   * context opens them, so a sync anyone else can write would otherwise be a way into
   * every device's bookmark bar. Off by default, and it says what turning it on costs
   * instead of hiding the trade in a tooltip.
   */
  private bookmarkletSetting(): HTMLElement {
    const checkbox = el('input', {
      type: 'checkbox',
      id: 'syncBookmarklets',
      'data-testid': 'syncBookmarklets',
    }) as HTMLInputElement;
    checkbox.checked = this.urlPolicy.allowBookmarklets === true;
    const hint = el('div', { class: 'hint', 'data-testid': 'bookmarkletHint' });
    const renderHint = (): void => {
      hint.textContent = checkbox.checked
        ? 'Bookmarklets (javascript: and data: addresses) are uploaded with everything else, ' +
          'and this app still refuses to open them. Turn it on everywhere: a device that ' +
          'has it off removes them from the sync the next time it uploads.'
        : 'Bookmarklets (javascript: and data: addresses) stay on this device and are never ' +
          'uploaded. Everything else, including chrome:// and file:// bookmarks, is synced.';
    };
    renderHint();
    checkbox.addEventListener('change', () => {
      void (async () => {
        await this.store.setSettings({ syncBookmarklets: checkbox.checked });
        await this.loadUrlPolicy();
        renderHint();
        // The rows say whether an entry is synced, so they are now out of date. The
        // upload is not forced: the next sync sees the tree this device is willing to
        // carry has changed and pushes it.
        await this.refreshResults();
      })();
    });
    return el(
      'div',
      { class: 'card setting', 'data-testid': 'bookmarkletSetting' },
      el('label', { class: 'checkbox', for: 'syncBookmarklets' }, checkbox, 'Sync bookmarklets'),
      hint,
    );
  }

  /** Reloads bookmarks from the store and refreshes only the results region. */
  private async refreshResults(): Promise<void> {
    await this.loadBookmarks();
    if (this.listEl && this.countEl) {
      this.renderResults(this.listEl, this.countEl);
    } else {
      this.renderList();
    }
  }

  /**
   * Two modes in one list element: the folder tree when browsing, a flat list
   * of matches when searching. A tree filtered down to a handful of hits hides
   * more than it explains, so search drops the hierarchy and shows the path of
   * each hit as a breadcrumb instead.
   */
  private renderResults(listEl: HTMLElement, countEl: HTMLElement): void {
    const q = this.query.trim().toLowerCase();
    this.captureExpansion(listEl);
    listEl.replaceChildren();

    if (!q) {
      countEl.textContent = '';
      listEl.className = 'tree';
      if (this.bookmarks.length === 0) {
        listEl.append(el('li', { class: 'empty' }, 'No bookmarks yet.'));
        return;
      }
      listEl.append(...this.tree.map((node) => this.renderTreeNode(node, 0)));
      return;
    }

    const matches = this.bookmarks.filter((b) =>
      [b.title, b.url, b.description, ...(b.tags ?? [])].some((s) => s?.toLowerCase().includes(q)),
    );
    countEl.textContent = `${matches.length} of ${this.bookmarks.length} match "${this.query}"`;
    listEl.className = 'bookmarks';
    if (matches.length === 0) {
      listEl.append(el('li', { class: 'empty' }, 'No matches.'));
      return;
    }
    listEl.append(...matches.map((b) => bookmarkItem(b, true, this.urlPolicy)));
  }

  private renderTreeNode(node: TreeNode, depth: number): HTMLElement {
    if (node.kind === 'bookmark') return bookmarkItem(node, false, this.urlPolicy);
    return this.renderFolder(node, depth);
  }

  private renderFolder(folder: TreeFolder, depth: number): HTMLElement {
    const open = depth === 0 ? !this.closedFolders.has(folder.id) : this.openFolders.has(folder.id);
    const summary = el(
      'summary',
      { 'data-testid': 'folderToggle' },
      el('span', { class: 'twist', 'aria-hidden': 'true' }, '+'),
      el('span', { class: 'name' }, folder.title),
      el('span', { class: 'n' }, String(folder.count)),
    );
    // The id travels on the element so `captureExpansion` can read the open
    // state back off the DOM without a second lookup structure.
    const details = el('details', { 'data-folder-id': folder.id, ...(open ? { open: '' } : {}) }, summary);
    const children = folder.children.length
      ? folder.children.map((child) => this.renderTreeNode(child, depth + 1))
      : [el('li', { class: 'empty' }, 'Empty folder.')];
    details.append(el('ul', { class: 'tree' }, ...children));
    return el('li', { class: 'folder', 'data-testid': 'folderItem' }, details);
  }

  /**
   * Reads the open/closed state of the rendered folders back into the two sets.
   *
   * Deliberately not driven by the `toggle` event: that event is queued as a task
   * rather than dispatched synchronously, so a re-render triggered in the same turn
   * as the click that opened a folder (typing in the search box right after) would
   * rebuild the tree from state the pending event had not written yet — and the
   * event would then land on a detached element, leaving the folder wrongly
   * collapsed with nothing left to re-render it. Reading the DOM at render time is
   * exact whatever the task queue is doing, and covers opens the app never saw a
   * click for (keyboard, find-in-page, `open` set by the UA).
   */
  private captureExpansion(listEl: HTMLElement): void {
    for (const details of listEl.querySelectorAll<HTMLDetailsElement>('details[data-folder-id]')) {
      const id = details.dataset.folderId;
      if (id === undefined) continue;
      if (details.open) {
        this.openFolders.add(id);
        this.closedFolders.delete(id);
      } else {
        this.closedFolders.add(id);
        this.openFolders.delete(id);
      }
    }
  }

  /** Updates the character counter under the description field. */
  private renderDescriptionCount(): void {
    const fields = this.addFields;
    if (!fields) {
      return;
    }
    fields.count.textContent = `${fields.description.value.length} / ${DESCRIPTION_MAX_LENGTH} characters`;
  }

  /** Debounced suggestion, for a URL still being typed or just pasted. */
  private scheduleSuggest(): void {
    if (this.suggestTimer !== undefined) {
      clearTimeout(this.suggestTimer);
    }
    this.suggestTimer = window.setTimeout(() => {
      this.suggestTimer = undefined;
      void this.suggestFromPage();
    }, SUGGEST_DEBOUNCE_MS);
  }

  /** Immediate suggestion, for a URL the user has finished with (blur or Enter). */
  private suggestNow(): void {
    if (this.suggestTimer !== undefined) {
      clearTimeout(this.suggestTimer);
      this.suggestTimer = undefined;
    }
    void this.suggestFromPage();
  }

  /**
   * Fills the empty description and tag fields with what the page says about itself.
   *
   * Only ever fills a field that is empty, so nothing the user typed is overwritten by
   * a page's own claims about itself. Nothing is stored either: this is a suggestion
   * sitting in the form until the user presses Add, which is why the hint says so
   * rather than letting them think it is already recorded. Both rules are the
   * extension's, so the two clients behave the same way at the same moment.
   *
   * A PWA cannot read a page it is not on, so unlike the extension this usually comes
   * back empty — see `../adapters/page-metadata`. Silence is the designed outcome: the
   * fields stay as they were and no message claims anything was tried.
   */
  private async suggestFromPage(): Promise<void> {
    const fields = this.addFields;
    if (!fields) {
      return;
    }
    const url = fields.url.value.trim();
    if (!url || !isSafeBookmarkUrl(url) || url === this.suggestedFor) {
      return;
    }
    if (fields.description.value !== '' && fields.tags.value !== '') {
      return;
    }
    this.suggestedFor = url;

    const metadata = await readPageMetadata(url);
    const suggestion: Suggestion = {
      description: normalizeDescription(metadata.description),
      tags: parseTags(metadata.tags ?? ''),
    };

    // The fetch took time, and the form may have moved on while it was in flight: a
    // re-render replaced the fields, the user retyped the URL, or they filled in a
    // description themselves. Any of those makes this answer stale, and laying it down
    // anyway would overwrite what the user did.
    if (this.addFields !== fields || fields.url.value.trim() !== url) {
      return;
    }
    const filled: string[] = [];
    if (suggestion.description !== '' && fields.description.value === '') {
      fields.description.value = suggestion.description;
      this.renderDescriptionCount();
      filled.push('description');
    }
    if (suggestion.tags.length > 0 && fields.tags.value === '') {
      fields.tags.value = formatTags(suggestion.tags);
      filled.push('tags');
    }
    if (filled.length === 0) {
      return;
    }
    fields.hint.textContent = `Suggested ${filled.join(' and ')} from the page — press Add to keep.`;
  }

  private async onAdd(btn: HTMLButtonElement, msg: HTMLElement): Promise<void> {
    const fields = this.addFields;
    msg.className = '';
    msg.textContent = '';
    if (!fields) {
      return;
    }
    const urlValue = fields.url.value.trim();
    if (!urlValue) {
      msg.className = 'msg error';
      msg.textContent = 'URL is required.';
      return;
    }
    btn.disabled = true;
    try {
      // Normalised before it reaches the store, so what the list shows after the add is
      // what actually went into the tree: tags de-duplicated, sorted and bounded by
      // core, which is the canonical order both dirty detection and the merge compare.
      await this.addBookmark(
        fields.title.value.trim() || urlValue,
        urlValue,
        fields.description.value.trim(),
        parseTags(fields.tags.value),
      );
      fields.title.value = '';
      fields.url.value = '';
      fields.description.value = '';
      fields.tags.value = '';
      fields.hint.textContent = '';
      this.renderDescriptionCount();
      // The next bookmark is a different page, so it gets its own suggestion.
      this.suggestedFor = undefined;
      msg.className = 'msg ok';
      msg.textContent = 'Added and synced.';
    } catch (err) {
      msg.className = 'msg error';
      msg.textContent = err instanceof Error ? err.message : 'Failed to add.';
    } finally {
      btn.disabled = false;
    }
  }

  /** Adds locally, pushes to the service, then re-renders the list. */
  private async addBookmark(
    title: string,
    url: string,
    description?: string,
    tags?: string[],
  ): Promise<void> {
    // Rejected here rather than left to the sync engine, which drops what this device
    // will not carry from the tree it uploads without telling anyone: the bookmark would
    // sit in the local list looking saved and never reach another device.
    assertSyncableUrl(url, this.urlPolicy);
    await this.provider.addBookmark(title, url, description, tags);
    await this.pushWithLastWriteWins();
    await this.refreshResults();
  }

  /**
   * Reconciles with the service and redraws the list.
   *
   * `silent` is for the sync the app runs on open, where a failure is an ordinary
   * outcome (offline, service down) and there is nothing for the user to do about it.
   * A failure never discards what is on screen either way: the list is already showing
   * the local store, so only the button goes back to how it was.
   */
  private async doSync({ silent = false }: { silent?: boolean } = {}): Promise<void> {
    const btn = this.syncBtn;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Syncing…';
    }
    try {
      await this.engine.sync();
      // Rebuilds the header, so the button comes back with it.
      await this.loadAndRenderList();
      return;
    } catch (err) {
      if (err instanceof SyncConflictError) {
        await this.engine.forcePull();
        await this.loadAndRenderList();
        return;
      }
      if (!silent) {
        console.error(err);
      }
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Sync';
    }
  }

  // Prototype conflict policy (non-goal: sophisticated merge): last-write-wins.
  private async pushWithLastWriteWins(): Promise<void> {
    try {
      await this.engine.sync();
    } catch (err) {
      if (err instanceof SyncConflictError) {
        await this.engine.forcePush();
      } else {
        throw err;
      }
    }
  }

  private async logout(): Promise<void> {
    await this.engine.disable();
    await this.provider.setBookmarks([]);
    this.bookmarks = [];
    this.query = '';
    this.renderLogin();
  }
}
