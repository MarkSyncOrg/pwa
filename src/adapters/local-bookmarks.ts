import {
  type Bookmark,
  BookmarkContainer,
  type BookmarkProvider,
  getContainer,
  newBookmark,
  SEPARATOR_URL,
  type StorageArea,
} from '@marksyncorg/core';

// The PWA's BookmarkProvider. On the extension this seam is `browser.bookmarks`;
// here there is no host bookmark API (and on iOS none exists at all), so the
// bookmarks live in the PWA's own IndexedDB store as an xBrowserSync container tree.

const KEY = 'localBookmarks';

export class LocalBookmarksProvider implements BookmarkProvider {
  constructor(private readonly area: StorageArea) {}

  async getBookmarks(): Promise<Bookmark[]> {
    return (await this.area.get<Bookmark[]>(KEY)) ?? [];
  }

  async setBookmarks(bookmarks: Bookmark[]): Promise<void> {
    await this.area.set(KEY, bookmarks);
  }

  /**
   * Adds a single bookmark into the "Other" container (created if missing) and
   * persists the tree. Returns the updated tree. The caller triggers a sync/push.
   */
  async addBookmark(title: string, url: string): Promise<Bookmark[]> {
    const tree = await this.getBookmarks();
    const container = getContainer(BookmarkContainer.Other, tree, true);
    container!.children ??= [];
    container!.children.push(newBookmark(title, url));
    await this.setBookmarks(tree);
    return tree;
  }
}

/** A flat leaf-bookmark view of a container tree, for search results and counting. */
export interface FlatBookmark {
  title: string;
  url: string;
  description?: string;
  tags?: string[];
  /** Titles of the folders holding it, outermost first — the breadcrumb. */
  path: string[];
}

/** A leaf bookmark in the folder tree. */
export interface TreeBookmark extends FlatBookmark {
  kind: 'bookmark';
}

/** A folder in the tree, with its own children and a total bookmark count. */
export interface TreeFolder {
  kind: 'folder';
  /** Path of titles, not of indices: an insert elsewhere in the tree must not
   *  shift it, or the UI's expansion state would jump to another folder. */
  id: string;
  title: string;
  children: TreeNode[];
  /** Leaf bookmarks in this folder and everything below it. */
  count: number;
}

export type TreeNode = TreeFolder | TreeBookmark;

// Containers are the browser's bookmark roots and carry an "[xbs] " prefix in
// the synced data; the UI shows them as ordinary top-level folders.
const CONTAINER_PREFIX = '[xbs] ';

function folderTitle(node: Bookmark): string {
  const title = node.title?.trim() || 'Untitled folder';
  return title.startsWith(CONTAINER_PREFIX) ? title.slice(CONTAINER_PREFIX.length) : title;
}

function toFlat(node: Bookmark, path: string[]): FlatBookmark {
  return {
    title: node.title ?? node.url!,
    url: node.url!,
    description: node.description,
    tags: node.tags,
    path,
  };
}

function isBookmark(node: Bookmark): boolean {
  return Boolean(node.url) && node.url !== SEPARATOR_URL;
}

/** Flattens a container tree to its leaf bookmarks (entries that have a URL). */
export function flattenBookmarks(bookmarks: Bookmark[]): FlatBookmark[] {
  const out: FlatBookmark[] = [];
  const walk = (nodes: Bookmark[], path: string[]): void => {
    for (const node of nodes) {
      if (isBookmark(node)) out.push(toFlat(node, path));
      if (node.children?.length) {
        walk(node.children, node.url ? path : [...path, folderTitle(node)]);
      }
    }
  };
  walk(bookmarks, []);
  return out;
}

/** Builds the folder tree the list view renders, preserving the stored order. */
export function buildBookmarkTree(bookmarks: Bookmark[]): TreeNode[] {
  const build = (nodes: Bookmark[], parentId: string, path: string[]): TreeNode[] => {
    const out: TreeNode[] = [];
    const takenIds = new Set<string>();
    for (const node of nodes) {
      if (isBookmark(node)) {
        out.push({ kind: 'bookmark', ...toFlat(node, path) });
        continue;
      }
      if (node.url) continue; // separator
      const title = folderTitle(node);
      // Siblings may share a title; suffixing keeps ids unique so two folders
      // never end up sharing one expansion state.
      let id = `${parentId}/${title}`;
      for (let n = 2; takenIds.has(id); n++) id = `${parentId}/${title}#${n}`;
      takenIds.add(id);
      const children = build(node.children ?? [], id, [...path, title]);
      out.push({ kind: 'folder', id, title, children, count: countBookmarks(children) });
    }
    return out;
  };
  return build(bookmarks, '', []);
}

function countBookmarks(nodes: TreeNode[]): number {
  let total = 0;
  for (const node of nodes) total += node.kind === 'folder' ? node.count : 1;
  return total;
}
