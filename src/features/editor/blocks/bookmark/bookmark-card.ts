/**
 * The bookmark card's DOM, as a pure function from data to nodes - no
 * ProseMirror, no React. `bookmark-node-view.ts` is the only caller in the
 * running app; tests call it directly, without needing a live `EditorView`.
 *
 * Every piece of remote/user text (title, description, hostname) is set via
 * `textContent`, never `innerHTML` - a title like `<img onerror=...>` ends
 * up as literal displayed characters, not markup (EDT-028's "clicável" card
 * is otherwise the one part of this block trusted with arbitrary text from
 * whatever page the URL points at).
 */

export interface BookmarkCardContent {
  url: string;
  title: string;
  description: string;
  favicon: string | null;
}

/**
 * `javascript:`/`data:` (and anything else) are rejected on purpose - a
 * bookmark's whole point is "click to open", so an unsafe scheme here would
 * be script execution one click away, not a bookmark.
 */
const SAFE_URL_PROTOCOLS = new Set(["http:", "https:"]);

export function parseSafeUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return SAFE_URL_PROTOCOLS.has(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

/** Falls back to the raw string when it isn't even a well-formed URL, so the card still shows *something* instead of an empty label. */
export function hostnameOf(raw: string): string {
  return parseSafeUrl(raw)?.hostname ?? raw;
}

/**
 * `metadata.ts` is the only caller: it must reject a target/redirect host
 * that reaches the user's own machine or their local network before
 * fetching it, because `tauri-plugin-http`'s capability scope
 * (`src-tauri/capabilities/default.json`, `http:default`) is checked once
 * against the URL the fetch was *called with* and never re-checked against
 * a `Location:` header the server sends back - a public URL that 302s to
 * `http://192.168.1.1/` or the cloud metadata endpoint
 * `http://169.254.169.254/` sails through the ACL untouched, because as far
 * as the ACL is concerned the only URL that was ever dialed is the public
 * one. This function is that missing re-check, run in app code against
 * every hop: the original target *and* `response.url` after redirects.
 *
 * `new URL(...)` already canonicalizes alternate IPv4 spellings (octal,
 * hex, bare-integer) into plain dotted-quad per the WHATWG URL spec before
 * `.hostname` is ever read here, so only the dotted-quad/bracketed-IPv6
 * forms need parsing below - not every alternate spelling by hand.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "") return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return (
      a === 127 || // loopback, 127.0.0.0/8
      a === 10 || // RFC1918
      (a === 172 && b >= 16 && b <= 31) || // RFC1918
      (a === 192 && b === 168) || // RFC1918
      (a === 169 && b === 254) || // link-local, incl. cloud metadata 169.254.169.254
      a === 0 || // "this network" / unspecified
      (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT, RFC6598
    );
  }

  // IPv6 host from a URL always arrives bracketed, e.g. "[::1]".
  const ipv6 = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : null;
  if (ipv6 !== null) {
    if (ipv6 === "::1" || ipv6 === "::") return true;
    if (ipv6.startsWith("fe80:") || ipv6.startsWith("fe80::")) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(ipv6)) return true; // unique local, fc00::/7
    const mappedV4 = ipv6.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (mappedV4) return isPrivateOrLoopbackHost(mappedV4[1]);
  }

  return false;
}

/**
 * Renders into `container` in place (`replaceChildren` first, so calling
 * this again on an attrs update - `BookmarkNodeView.update` - doesn't grow a
 * duplicate card). `onOpen` fires only for a genuinely safe URL; a card
 * whose `url` attr was tampered with into `javascript:...` is inert instead
 * of silently refusing to render at all.
 */
export function renderBookmarkCard(container: HTMLElement, content: BookmarkCardContent, onOpen: () => void): void {
  container.replaceChildren();
  const safeUrl = parseSafeUrl(content.url);
  const hostname = hostnameOf(content.url);

  const link = document.createElement("div");
  link.className = "ed-bookmark__link";
  link.setAttribute("role", "button");
  link.tabIndex = 0;
  link.setAttribute("aria-label", `Abrir ${hostname} em uma nova janela`);

  const text = document.createElement("div");
  text.className = "ed-bookmark__text";

  const title = document.createElement("div");
  title.className = "ed-bookmark__title";
  title.textContent = content.title || hostname;
  text.append(title);

  if (content.description) {
    const description = document.createElement("div");
    description.className = "ed-bookmark__description";
    description.textContent = content.description;
    text.append(description);
  }

  const meta = document.createElement("div");
  meta.className = "ed-bookmark__meta";
  const faviconUrl = content.favicon ? parseSafeUrl(content.favicon) : null;
  if (faviconUrl) {
    const favicon = document.createElement("img");
    favicon.className = "ed-bookmark__favicon";
    favicon.src = faviconUrl.toString();
    favicon.alt = "";
    meta.append(favicon);
  }
  const urlLabel = document.createElement("span");
  urlLabel.className = "ed-bookmark__url";
  urlLabel.textContent = hostname;
  meta.append(urlLabel);
  text.append(meta);

  link.append(text);

  const activate = (event: Event) => {
    event.preventDefault();
    if (safeUrl) onOpen();
  };
  link.addEventListener("click", activate);
  link.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") activate(event);
  });

  container.append(link);
}
