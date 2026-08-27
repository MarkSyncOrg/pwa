import { SyncEngine, SyncStore } from '@marksyncorg/core';
import { IndexedDbStorageArea } from './adapters/indexeddb-storage';
import { LocalBookmarksProvider } from './adapters/local-bookmarks';
import { App, type SharedUrl } from './ui/app';

declare global {
  interface Window {
    // Share hook: invoked by an iOS Shortcut opening the PWA, or by the Plan B
    // native Share Extension. Adds a bookmark to the local store and pushes it.
    // `text` is optional and becomes the bookmark's description.
    marksyncReceiveSharedUrl: (url: string, title?: string, text?: string) => Promise<void>;
  }
}

// iOS cannot be a Web Share Target, so we also accept a shared URL via query
// params (?shareUrl=…&shareTitle=…&shareText=…). Android delivers the same via the
// manifest share_target. Read once at boot, then strip the params from the URL.
function readSharedFromUrl(): SharedUrl | undefined {
  const params = new URLSearchParams(location.search);
  const url = params.get('shareUrl') ?? params.get('url');
  if (!url) {
    return undefined;
  }
  const title = params.get('shareTitle') ?? params.get('title') ?? undefined;
  const text = params.get('shareText') ?? params.get('text') ?? undefined;
  history.replaceState(null, '', location.pathname);
  // The shared text is the page's excerpt, so it belongs in the description — but only
  // when the share also named the page. A share that carried no title has nothing else
  // to be called, so the text still names it rather than being dropped, which is what
  // this hook did with it before there was anywhere better to put it.
  return title ? { url, title, text } : { url, title: text ?? undefined, text: undefined };
}

const storage = new IndexedDbStorageArea();
const provider = new LocalBookmarksProvider(storage);
const engine = new SyncEngine({
  store: new SyncStore(storage),
  provider,
  appVersion: __APP_VERSION__,
});

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app root element');
}
const app = new App(root, engine, provider);

window.marksyncReceiveSharedUrl = (url, title, text) => app.receiveSharedUrl(url, title, text);

void app.start(readSharedFromUrl());
