/**
 * Fetching a page's real title/description/favicon for EDT-028 needs an
 * outbound HTTP request the WebView's own `fetch` can't make reliably for
 * most sites (CORS blocks the response body even when the request itself
 * succeeds). `@tauri-apps/plugin-http`'s `fetch` runs on the Rust side, not
 * subject to the page's CORS policy - the plugin is registered in
 * `src-tauri/src/lib.rs` and its URL scope lives in
 * `src-tauri/capabilities/default.json` (any http/https host, but never a
 * short list of loopback spellings). That capability scope is checked only
 * once, against the URL `fetch()` is called with - it does NOT re-check
 * `Location:` redirect hops or cover the rest of RFC1918/link-local space,
 * so `isPrivateOrLoopbackHost` (bookmark-card.ts) is the real gate here,
 * applied to the initial target and to every redirect hop *before* that hop
 * is dialed (see `fetchHtml` below) - a bookmark paste must not become a
 * scanner of the user's own machine or local network, and checking only
 * where the chain ended would already be too late.
 *
 * Outside the Tauri runtime (`vite dev` in a plain browser, every `vitest`
 * run) there is no such plugin and a direct `fetch` would just fail on CORS
 * anyway, so this always falls back there - the same `isTauri()` gate
 * `open-url.ts` uses in this same folder.
 *
 * The fallback never fabricates anything: it's the hostname `parseSafeUrl`
 * already validated, and nothing else. That's true whether the fetch never
 * ran (not in Tauri, not a safe URL), timed out, returned a non-2xx status,
 * returned something that isn't HTML, or threw for any other reason - a
 * broken card that guesses is worse than an honest one that just opens the
 * URL.
 */
import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { hostnameOf, isPrivateOrLoopbackHost, parseSafeUrl } from "./bookmark-card";

export interface BookmarkMetadata {
  title: string;
  description: string;
  favicon: string | null;
}

/** Remote pages can be slow or simply never answer - this keeps a paste from leaving the user staring at "Enviando…" indefinitely. */
const FETCH_TIMEOUT_MS = 4000;

/** Title/description/favicon all live in `<head>`, near the top of the document - capping how much of the body we ever decode means a multi-gigabyte response (malicious or just a very large page) costs a bounded amount of memory and time, never more. */
const MAX_HTML_BYTES = 200 * 1024;

function fallbackMetadata(url: string): BookmarkMetadata {
  return { title: hostnameOf(url), description: "", favicon: null };
}

/**
 * Reads at most `maxBytes` of `response`'s body as text. Prefers streaming
 * via `body.getReader()` so a huge response is never buffered whole before
 * being cut down; falls back to `response.text()` (then a string-length
 * cap) only if the platform's `Response` doesn't expose a body stream at
 * all - still bounded, just on decoded characters instead of raw bytes.
 */
async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }

  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";
  try {
    while (receivedBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

/**
 * How many `Location:` hops a bookmark will follow before giving up. Real
 * pages redirect once or twice (http->https, canonical host, trailing
 * slash); a chain longer than this is either a loop or someone playing
 * games, and either way the fallback card is the better answer.
 */
const MAX_REDIRECT_HOPS = 5;

/**
 * Fetches `url` and returns its HTML body (capped), or `null` when the
 * response isn't usable: non-2xx status, a redirect that points somewhere
 * other than http(s) or at a loopback/private host, a chain longer than
 * `MAX_REDIRECT_HOPS`, or a `Content-Type` that isn't HTML.
 *
 * **Redirects are followed here, one hop at a time, on purpose.**
 * `tauri-plugin-http`'s ACL (`http:default` in
 * `src-tauri/capabilities/default.json`) validates only the URL `fetch()`
 * was called with, once, before dialing. Handing `reqwest` a
 * follow-redirects policy would let it chase every `Location:` header on
 * the Rust side with no further check - so a public URL that 302s to
 * `http://169.254.169.254/` (cloud metadata) or `http://192.168.1.1/admin`
 * would be *requested*, and validating the final `response.url` afterwards
 * only stops the content from being displayed: the internal host has
 * already been hit, side effects included. That is a blind SSRF, and it is
 * the reason `maxRedirections: 0` is passed below (the plugin turns that
 * into `reqwest`'s `Policy::none()`, which returns the 3xx instead of
 * chasing it) and every hop's host is checked *before* it is dialed.
 */
async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      const response = await tauriFetch(target, {
        method: "GET",
        // See this function's doc comment: nothing is followed for us.
        maxRedirections: 0,
        signal: controller.signal,
      });

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        // `new URL(location, target)` resolves a relative `Location` (which
        // is legal and common) against the hop we just asked.
        let next: URL;
        try {
          next = new URL(location, target);
        } catch {
          return null;
        }
        const safeNext = parseSafeUrl(next.href);
        if (!safeNext || isPrivateOrLoopbackHost(safeNext.hostname)) return null;
        target = safeNext.href;
        continue;
      }

      if (!response.ok) return null;
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("text/html")) return null;
      return await readCappedText(response, MAX_HTML_BYTES);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readMetaContent(doc: Document, ...selectors: string[]): string {
  for (const selector of selectors) {
    const value = doc.querySelector(selector)?.getAttribute("content")?.trim();
    if (value) return value;
  }
  return "";
}

/**
 * `doc.querySelector`/`getAttribute`/`textContent` only ever read from a
 * document `DOMParser` built in `"text/html"` mode - per the DOM spec that
 * document has scripting disabled and never executes anything it parses,
 * and it's never attached to the live page - so nothing here can run
 * attacker HTML/JS, only read text and attribute strings out of it. Every
 * one of those strings is later set via `textContent` (`bookmark-card.ts`),
 * never `innerHTML`.
 */
export function parseBookmarkHtml(html: string, pageUrl: URL): BookmarkMetadata {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const rawTitle = doc.querySelector("title")?.textContent?.trim();
  const title = rawTitle || pageUrl.hostname;

  const description = readMetaContent(
    doc,
    'meta[name="description"]',
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
  );

  const faviconHref = doc.querySelector('link[rel~="icon"]')?.getAttribute("href")?.trim();
  let favicon: string | null = null;
  if (faviconHref) {
    try {
      const resolved = new URL(faviconHref, pageUrl);
      favicon = parseSafeUrl(resolved.toString()) ? resolved.toString() : null;
    } catch {
      favicon = null;
    }
  }

  return { title, description, favicon };
}

export async function fetchBookmarkMetadata(url: string): Promise<BookmarkMetadata> {
  if (!isTauri()) return fallbackMetadata(url);
  const target = parseSafeUrl(url);
  if (!target || isPrivateOrLoopbackHost(target.hostname)) return fallbackMetadata(url);

  try {
    const html = await fetchHtml(target.toString());
    if (html === null) return fallbackMetadata(url);
    return parseBookmarkHtml(html, target);
  } catch {
    return fallbackMetadata(url);
  }
}
