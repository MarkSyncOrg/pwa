import { isSafeBookmarkUrl, type SyncEngine, SyncConflictError } from '@marksyncorg/core';
import {
  buildBookmarkTree,
  type FlatBookmark,
  flattenBookmarks,
  type LocalBookmarksProvider,
  type TreeFolder,
  type TreeNode,
} from '../adapters/local-bookmarks';
import './styles.css';

const DEFAULT_SERVICE_URL = 'https://api.xbrowsersync.org';

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

// Brand mark for the app header. Served from public/, so it is precached with
// the shell and shows offline; the on-dark variant matches the dark UI.
function brandMark(): HTMLElement {
  return el('img', {
    class: 'mark',
    src: '/brand/marksync-mark.svg',
    alt: '',
    width: '20',
    height: '24',
  });
}

/**
 * Rejects a URL the core would refuse to sync. `isSafeBookmarkUrl` also rejects
 * anything that is not an absolute URL, which is the check the `type="url"` input
 * gives us for free but the share hooks do not get at all.
 */
function assertSafeUrl(url: string): void {
  if (!isSafeBookmarkUrl(url)) {
    throw new Error('Only absolute http, https, ftp and mailto links can be saved.');
  }
}

// Long URLs are truncated to one line by CSS; dropping the scheme and any
// trailing slash first spends that line on the part that identifies the page.
function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * One bookmark row. Search results also carry the folder path they came from.
 *
 * The core sanitises every tree crossing a trust boundary, but the list is read
 * straight from the local store, which is not one of those boundaries — so the
 * render-time guard core's SECURITY.md asks for lives here. A `javascript:` or
 * `data:` URL becomes inert text rather than an `<a href>` that would execute in
 * this origin.
 *
 * Since core 0.3.0 such an entry also survives a pull rather than being erased by
 * it, so it is a permanent resident of the list and the row has to say why it
 * looks different: excluded from the sync, not broken.
 */
function bookmarkItem(b: FlatBookmark, showPath: boolean): HTMLElement {
  const item = el('li', { class: 'bookmark', 'data-testid': 'bookmarkItem' });
  if (showPath && b.path.length) {
    item.append(el('div', { class: 'crumb' }, b.path.join(' / ')));
  }
  item.append(
    isSafeBookmarkUrl(b.url)
      ? el('a', { href: b.url, target: '_blank', rel: 'noopener noreferrer', title: b.url }, b.title)
      : el(
          'span',
          {
            class: 'blocked',
            'data-testid': 'blockedBookmark',
            title: `Kept on this device but never synced — ${b.url}`,
          },
          b.title,
        ),
    el('div', { class: 'url', title: b.url }, prettyUrl(b.url)),
  );
  if (b.tags?.length) item.append(el('div', { class: 'tags' }, b.tags.join(', ')));
  return item;
}

export class App {
  private root: HTMLElement;
  private bookmarks: FlatBookmark[] = [];
  private tree: TreeNode[] = [];
  // Expansion state, kept by folder id so it survives a re-render after an add
  // or a sync. Top-level folders (the containers) start open, everything below
  // starts closed, so only a deliberate toggle is remembered either way.
  private openFolders = new Set<string>();
  private closedFolders = new Set<string>();
  private query = '';
  private pendingShare: { url: string; title?: string } | undefined;
  // Live references to the results region, so adds/syncs can refresh just the
  // list without rebuilding (and wiping) the add form and its status message.
  private listEl: HTMLElement | undefined;
  private countEl: HTMLElement | undefined;
  private addMsgEl: HTMLElement | undefined;

  constructor(
    root: HTMLElement,
    private readonly engine: SyncEngine,
    private readonly provider: LocalBookmarksProvider,
  ) {
    this.root = root;
  }

  /** Boots: shows the bookmark list if a sync is already enabled, else the login. */
  async start(share?: { url: string; title?: string }): Promise<void> {
    this.pendingShare = share;
    const status = await this.engine.getStatus();
    this.root.removeAttribute('aria-busy');
    if (status.enabled) {
      await this.loadAndRenderList();
      await this.flushPendingShare();
    } else {
      this.renderLogin();
    }
  }

  /** Programmatic share hook (iOS Shortcut / Plan B native Share Extension). */
  async receiveSharedUrl(url: string, title?: string): Promise<void> {
    assertSafeUrl(url);
    const status = await this.engine.getStatus();
    if (!status.enabled) {
      this.pendingShare = { url, title };
      return;
    }
    await this.addBookmark(title ?? url, url);
  }

  /**
   * Adds a share that arrived before the list was ready. Guarded, because this
   * runs on the boot path: a rejected URL must surface as a message, not as an
   * exception that leaves the app half-rendered.
   */
  private async flushPendingShare(): Promise<void> {
    const share = this.pendingShare;
    if (!share) {
      return;
    }
    this.pendingShare = undefined;
    try {
      await this.addBookmark(share.title ?? share.url, share.url);
    } catch (err) {
      this.reportAddError(err);
    }
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
    // Dropped with the DOM it pointed at, so a message never goes to a detached
    // node after a logout; renderList sets it again on the way back in.
    this.addMsgEl = undefined;
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
      el('header', { class: 'bar' }, brandMark(), el('h1', {}, 'MarkSync')),
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
    this.clear();
    const status = el('span', { class: 'status', 'data-testid': 'syncStatus' }, `${this.bookmarks.length} bookmarks`);
    const syncBtn = el('button', { class: 'secondary', 'data-testid': 'syncButton' }, 'Sync');
    const logoutBtn = el('button', { class: 'secondary', 'data-testid': 'logoutButton' }, 'Log out');
    syncBtn.addEventListener('click', () => void this.doSync(syncBtn));
    logoutBtn.addEventListener('click', () => void this.logout());

    // Add form
    const addTitle = el('input', { type: 'text', 'data-testid': 'addTitle', placeholder: 'Title' }) as HTMLInputElement;
    const addUrl = el('input', { type: 'url', 'data-testid': 'addUrl', placeholder: 'https://…' }) as HTMLInputElement;
    const addBtn = el('button', { type: 'submit', 'data-testid': 'addSubmit' }, 'Add') as HTMLButtonElement;
    const addMsg = el('div', { 'data-testid': 'addMessage' });
    this.addMsgEl = addMsg;
    const addForm = el(
      'form',
      { class: 'card', 'data-testid': 'addForm' },
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Title'), addTitle),
        el('div', {}, el('label', {}, 'URL'), addUrl),
        addBtn,
      ),
      addMsg,
    );
    addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.onAdd(addTitle, addUrl, addBtn, addMsg);
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
      el('header', { class: 'bar' }, brandMark(), el('h1', {}, 'MarkSync'), status, syncBtn, logoutBtn),
      addForm,
      el('div', { class: 'card' }, el('label', {}, 'Search'), search, countEl, listEl),
    );
    this.renderResults(listEl, countEl);
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
      [b.title, b.url, ...(b.tags ?? [])].some((s) => s?.toLowerCase().includes(q)),
    );
    countEl.textContent = `${matches.length} of ${this.bookmarks.length} match "${this.query}"`;
    listEl.className = 'bookmarks';
    if (matches.length === 0) {
      listEl.append(el('li', { class: 'empty' }, 'No matches.'));
      return;
    }
    listEl.append(...matches.map((b) => bookmarkItem(b, true)));
  }

  private renderTreeNode(node: TreeNode, depth: number): HTMLElement {
    if (node.kind === 'bookmark') return bookmarkItem(node, false);
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
    const details = el('details', open ? { open: '' } : {}, summary);
    const children = folder.children.length
      ? folder.children.map((child) => this.renderTreeNode(child, depth + 1))
      : [el('li', { class: 'empty' }, 'Empty folder.')];
    details.append(el('ul', { class: 'tree' }, ...children));
    details.addEventListener('toggle', () => {
      if (details.open) {
        this.openFolders.add(folder.id);
        this.closedFolders.delete(folder.id);
      } else {
        this.closedFolders.add(folder.id);
        this.openFolders.delete(folder.id);
      }
    });
    return el('li', { class: 'folder', 'data-testid': 'folderItem' }, details);
  }

  private async onAdd(
    title: HTMLInputElement,
    url: HTMLInputElement,
    btn: HTMLButtonElement,
    msg: HTMLElement,
  ): Promise<void> {
    msg.className = '';
    msg.textContent = '';
    const urlValue = url.value.trim();
    if (!urlValue) {
      msg.className = 'msg error';
      msg.textContent = 'URL is required.';
      return;
    }
    btn.disabled = true;
    try {
      await this.addBookmark(title.value.trim() || urlValue, urlValue);
      title.value = '';
      url.value = '';
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
  private async addBookmark(title: string, url: string): Promise<void> {
    // Rejected here rather than left to the sync engine, which drops unsafe-scheme
    // nodes from the tree it uploads without telling anyone: the bookmark would sit
    // in the local list looking saved and never reach another device.
    assertSafeUrl(url);
    await this.provider.addBookmark(title, url);
    await this.pushWithLastWriteWins();
    await this.refreshResults();
  }

  private async doSync(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      await this.engine.sync();
      await this.loadAndRenderList();
    } catch (err) {
      if (err instanceof SyncConflictError) {
        await this.engine.forcePull();
        await this.loadAndRenderList();
      } else {
        console.error(err);
        this.renderList();
      }
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
