import {
  DESCRIPTION_MAX_LENGTH,
  formatTags,
  isSafeBookmarkUrl,
  normalizeDescription,
  parseTags,
  type SyncEngine,
  SyncConflictError,
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
  // starts closed, so only a deliberate toggle is remembered either way.
  private openFolders = new Set<string>();
  private closedFolders = new Set<string>();
  private query = '';
  private pendingShare: SharedUrl | undefined;
  // Live references to the results region, so adds/syncs can refresh just the
  // list without rebuilding (and wiping) the add form and its status message.
  private listEl: HTMLElement | undefined;
  private countEl: HTMLElement | undefined;
  private addMsgEl: HTMLElement | undefined;
  private addFields: AddFormFields | undefined;
  // The URL a suggestion has already been attempted for. Blurring the URL field
  // repeatedly, or editing the title and coming back, must not refetch the same page —
  // so a request is only made when this does not already name the URL in the field.
  // Cleared after an add, which is what lets the next bookmark be asked about even if
  // it happens to be the same URL.
  private suggestedFor: string | undefined;
  private suggestTimer: number | undefined;

  constructor(
    root: HTMLElement,
    private readonly engine: SyncEngine,
    private readonly provider: LocalBookmarksProvider,
  ) {
    this.root = root;
  }

  /** Boots: shows the bookmark list if a sync is already enabled, else the login. */
  async start(share?: SharedUrl): Promise<void> {
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
    assertSafeUrl(url);
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
  private async flushPendingShare(): Promise<void> {
    const share = this.pendingShare;
    if (!share) {
      return;
    }
    this.pendingShare = undefined;
    try {
      await this.addShare(share);
    } catch (err) {
      this.reportAddError(err);
    }
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
      [b.title, b.url, b.description, ...(b.tags ?? [])].some((s) => s?.toLowerCase().includes(q)),
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
    // Rejected here rather than left to the sync engine, which drops unsafe-scheme
    // nodes from the tree it uploads without telling anyone: the bookmark would sit
    // in the local list looking saved and never reach another device.
    assertSafeUrl(url);
    await this.provider.addBookmark(title, url, description, tags);
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
