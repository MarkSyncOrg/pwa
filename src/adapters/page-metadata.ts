// Reads the description and keywords a page publishes about itself, so adding a
// bookmark does not start with two empty fields.
//
// This is where xBrowserSync's descriptions and tags come from: they are not browser
// bookmark data — no bookmarks API has anywhere to keep them — but `<meta>` tags
// scraped from the page. The extension (app-next) scrapes them by injecting a
// collector into the active tab under `activeTab`; it is sitting on the page, so it
// always has the markup. A PWA never is, so the only way to see a page's `<meta>` is
// to fetch it, which means this module is a best-effort analogue rather than an equal
// one:
//
//   - Same precedence (Open Graph, then Twitter, then the plain meta name), so both
//     clients suggest the same thing for the same page when both can see it.
//   - Subject to CORS. A cross-origin document is only readable when the site sends
//     `Access-Control-Allow-Origin`, which most sites do not. `no-cors` would not
//     help: the response would be opaque and its body unreadable. So a miss is the
//     common case, not the exception, and is treated as an ordinary outcome — the
//     fields simply stay empty, exactly as they do in the extension when a page
//     refuses injection.
//
// Nothing here is a trust boundary crossing for the bookmark tree: what comes back is
// a suggestion in a form, normalised by core before it can reach the store.

import { isSafeBookmarkUrl } from '@marksyncorg/core';

/** What a page says about itself, as far as a bookmark is concerned. */
export interface PageMetadata {
  description?: string;
  /** Raw keyword text (comma-separated); the caller normalises it into tags. */
  tags?: string;
}

/**
 * How long to wait for the page. Short on purpose: this runs while the user is looking
 * at the add form with a URL already typed, so a slow site must not hold up a bookmark
 * they could have saved immediately.
 */
const TIMEOUT_MS = 4_000;

/**
 * How much of the document to read. `<meta>` lives in `<head>`, and the read also stops
 * as soon as `</head>` appears, so this is only the ceiling for a page that never closes
 * its head — a stream that would otherwise be followed to the end of a video manifest.
 */
const MAX_BYTES = 512 * 1024;

/** Only these can be fetched for markup; `isSafeBookmarkUrl` also admits ftp and mailto. */
function isFetchable(url: string): boolean {
  if (!isSafeBookmarkUrl(url)) {
    return false;
  }
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** The charset the response declares, or utf-8 when it declares nothing usable. */
function decoderFor(contentType: string): TextDecoder {
  const charset = /charset=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8', { fatal: false });
  } catch {
    // An unknown label (TextDecoder throws on those) is not worth failing over.
    return new TextDecoder('utf-8', { fatal: false });
  }
}

/**
 * Reads the response body up to the end of `<head>`, or to {@link MAX_BYTES}.
 *
 * Streamed rather than `response.text()` so a huge page costs a few kilobytes instead of
 * being buffered whole to find two `<meta>` tags near the top of it.
 */
async function readHead(response: Response, contentType: string): Promise<string> {
  const body = response.body;
  const decoder = decoderFor(contentType);
  if (!body) {
    return decoder.decode(new Uint8Array(await response.arrayBuffer()).slice(0, MAX_BYTES));
  }
  const reader = body.getReader();
  let html = '';
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      read += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (read >= MAX_BYTES || /<\/head\s*>/i.test(html)) {
        break;
      }
    }
  } finally {
    // Releases the connection: without this the rest of the page keeps downloading.
    await reader.cancel().catch(() => {});
  }
  return html;
}

/**
 * Pulls the metadata out of markup.
 *
 * Parsed with `DOMParser` into an inert document: nothing in it runs, no subresource is
 * requested, and no node is ever adopted into this one. That is what makes reading a
 * third party's HTML in the app's own origin safe — the markup is data here, never
 * something the page gets to execute.
 */
function parseMetadata(html: string): PageMetadata {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const contentOf = (...names: string[]): string | undefined => {
    for (const name of names) {
      const selector = `meta[name="${name}" i], meta[property="${name}" i]`;
      const content = doc.querySelector<HTMLMetaElement>(selector)?.content?.trim();
      if (content) {
        return content;
      }
    }
    return undefined;
  };

  // Same two keyword sources, in the same order, as the extension's collector.
  const keywords = new Set<string>();
  doc.querySelectorAll<HTMLMetaElement>('meta[property="og:video:tag" i]').forEach((tag) => {
    const value = tag.content?.trim().toLowerCase();
    if (value) {
      keywords.add(value);
    }
  });
  for (const keyword of contentOf('keywords')?.split(',') ?? []) {
    const value = keyword.trim().toLowerCase();
    if (value) {
      keywords.add(value);
    }
  }

  return {
    description: contentOf('og:description', 'twitter:description', 'description'),
    tags: keywords.size > 0 ? [...keywords].join(', ') : undefined,
  };
}

/**
 * Reads what the page at `url` says about itself, or an empty result when it cannot be
 * read.
 *
 * Never throws and never rejects. A blocked cross-origin read, an offline device, a
 * timeout, a 404, a PDF — every one of those is an ordinary outcome for a suggestion,
 * not an error worth failing the add form over.
 *
 * `credentials: 'omit'` matters: this fetches a URL the user typed, so any cookie the
 * browser holds for that site must stay out of a request the app makes on its own
 * initiative.
 */
export async function readPageMetadata(url: string): Promise<PageMetadata> {
  if (!isFetchable(url)) {
    return {};
  }
  try {
    const response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return {};
    }
    const contentType = response.headers.get('content-type') ?? '';
    // Only markup carries `<meta>`. Anything else (a PDF, an image, a download) would
    // be megabytes of body that cannot contain an answer.
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return {};
    }
    return parseMetadata(await readHead(response, contentType));
  } catch {
    return {};
  }
}
