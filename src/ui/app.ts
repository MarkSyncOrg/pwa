import { type SyncEngine, SyncConflictError } from '@xbrowsersync/core';
import {
  type FlatBookmark,
  flattenBookmarks,
  type LocalBookmarksProvider,
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

export class App {
  private root: HTMLElement;
  private bookmarks: FlatBookmark[] = [];
  private query = '';
  private pendingShare: { url: string; title?: string } | undefined;
  // Live references to the results region, so adds/syncs can refresh just the
  // list without rebuilding (and wiping) the add form and its status message.
  private listEl: HTMLElement | undefined;
  private countEl: HTMLElement | undefined;

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
      if (this.pendingShare) {
        await this.addBookmark(this.pendingShare.title ?? this.pendingShare.url, this.pendingShare.url);
        this.pendingShare = undefined;
      }
    } else {
      this.renderLogin();
    }
  }

  /** Programmatic share hook (iOS Shortcut / Plan B native Share Extension). */
  async receiveSharedUrl(url: string, title?: string): Promise<void> {
    const status = await this.engine.getStatus();
    if (!status.enabled) {
      this.pendingShare = { url, title };
      return;
    }
    await this.addBookmark(title ?? url, url);
  }

  private clear(): void {
    this.root.replaceChildren();
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
      el('header', { class: 'bar' }, el('h1', {}, 'xBrowserSync')),
      el('div', { class: 'card' }, el('h2', { style: 'margin-top:0;font-size:16px' }, 'Log in to an existing sync'), form),
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
      if (this.pendingShare) {
        await this.addBookmark(this.pendingShare.title ?? this.pendingShare.url, this.pendingShare.url);
        this.pendingShare = undefined;
      }
    } catch (err) {
      submit.disabled = false;
      submit.textContent = 'Log in';
      message.className = 'msg error';
      message.textContent = err instanceof Error ? err.message : 'Login failed.';
    }
  }

  private async loadAndRenderList(): Promise<void> {
    this.bookmarks = flattenBookmarks(await this.provider.getBookmarks());
    this.renderList();
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
      el('header', { class: 'bar' }, el('h1', {}, 'xBrowserSync'), status, syncBtn, logoutBtn),
      addForm,
      el('div', { class: 'card' }, el('label', {}, 'Search'), search, countEl, listEl),
    );
    this.renderResults(listEl, countEl);
  }

  /** Reloads bookmarks from the store and refreshes only the results region. */
  private async refreshResults(): Promise<void> {
    this.bookmarks = flattenBookmarks(await this.provider.getBookmarks());
    if (this.listEl && this.countEl) {
      this.renderResults(this.listEl, this.countEl);
    } else {
      this.renderList();
    }
  }

  private renderResults(listEl: HTMLElement, countEl: HTMLElement): void {
    const q = this.query.trim().toLowerCase();
    const matches = q
      ? this.bookmarks.filter((b) =>
          [b.title, b.url, ...(b.tags ?? [])].some((s) => s?.toLowerCase().includes(q)),
        )
      : this.bookmarks;
    countEl.textContent = q ? `${matches.length} of ${this.bookmarks.length} match "${this.query}"` : '';
    listEl.replaceChildren();
    if (matches.length === 0) {
      listEl.append(el('li', { class: 'empty' }, q ? 'No matches.' : 'No bookmarks yet.'));
      return;
    }
    for (const b of matches) {
      const item = el('li', { 'data-testid': 'bookmarkItem' },
        el('a', { href: b.url, target: '_blank', rel: 'noopener noreferrer' }, b.title),
        el('div', { class: 'url' }, b.url),
      );
      if (b.tags?.length) item.append(el('div', { class: 'tags' }, b.tags.join(', ')));
      listEl.append(item);
    }
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
