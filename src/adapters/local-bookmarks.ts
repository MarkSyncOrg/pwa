import {
  type Bookmark,
  BookmarkContainer,
  type BookmarkProvider,
  getContainer,
  newBookmark,
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

/** A flat leaf-bookmark view of a container tree, for list rendering and search. */
export interface FlatBookmark {
  title: string;
  url: string;
  description?: string;
  tags?: string[];
}

/** Flattens a container tree to its leaf bookmarks (entries that have a URL). */
export function flattenBookmarks(bookmarks: Bookmark[]): FlatBookmark[] {
  const out: FlatBookmark[] = [];
  const walk = (nodes: Bookmark[]): void => {
    for (const node of nodes) {
      if (node.url && node.url !== 'xbs:separator') {
        out.push({
          title: node.title ?? node.url,
          url: node.url,
          description: node.description,
          tags: node.tags,
        });
      }
      if (node.children?.length) {
        walk(node.children);
      }
    }
  };
  walk(bookmarks);
  return out;
}
