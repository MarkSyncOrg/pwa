import { SyncEngine, SyncStore } from '@marksyncorg/core';
import { IndexedDbStorageArea } from './adapters/indexeddb-storage';
import { LocalBookmarksProvider } from './adapters/local-bookmarks';
import { App } from './ui/app';

declare global {
  interface Window {
    // Share hook: invoked by an iOS Shortcut opening the PWA, or by the Plan B
    // native Share Extension. Adds a bookmark to the local store and pushes it.
    marksyncReceiveSharedUrl: (url: string, title?: string) => Promise<void>;
  }
}

// iOS cannot be a Web Share Target, so we also accept a shared URL via query
// params (?shareUrl=…&shareTitle=…). Android delivers the same via the manifest
// share_target. Read once at boot, then strip the params from the URL.
function readSharedFromUrl(): { url: string; title?: string } | undefined {
  const params = new URLSearchParams(location.search);
  const url = params.get('shareUrl') ?? params.get('url');
  if (!url) {
    return undefined;
  }
  const title = params.get('shareTitle') ?? params.get('title') ?? params.get('shareText') ?? undefined;
  history.replaceState(null, '', location.pathname);
  return { url, title: title ?? undefined };
}

const storage = new IndexedDbStorageArea();
const provider = new LocalBookmarksProvider(storage);
const engine = new SyncEngine({
  store: new SyncStore(storage),
  provider,
  appVersion: '0.1.0',
});

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app root element');
}
const app = new App(root, engine, provider);

window.marksyncReceiveSharedUrl = (url, title) => app.receiveSharedUrl(url, title);

void app.start(readSharedFromUrl());
