/**
 * How a `bookmark` block crosses `serialize.ts`'s round trip (README §2 /
 * `core/block-spec.ts`). An atom (`hasContent: false`), so there's no
 * `nodeContent`/inline text to reconstruct - every field the card shows
 * lives in `content`, one-to-one with the node's own attrs.
 *
 * `plainText` joins title and URL (mirrors `block-spec.test.ts`'s own
 * "spec_test_bookmark" example almost exactly) so a bookmark shows up in
 * global search by either.
 */
import type { BlockContent } from "../../contract";
import type { BlockSpec } from "../../core/block-spec";
import { BOOKMARK_BLOCK_TYPE, BOOKMARK_NODE_NAME } from "./constants";

function readString(content: BlockContent, key: string): string {
  const value = content[key];
  return typeof value === "string" ? value : "";
}

function readNullableString(content: BlockContent, key: string): string | null {
  const value = content[key];
  return typeof value === "string" ? value : null;
}

export const bookmarkBlockSpec: BlockSpec = {
  blockType: BOOKMARK_BLOCK_TYPE,
  nodeName: BOOKMARK_NODE_NAME,
  hasContent: false,
  serialization: {
    attrs: (_blockType, content) => ({
      url: readString(content, "url"),
      title: readString(content, "title"),
      description: readString(content, "description"),
      favicon: readNullableString(content, "favicon"),
    }),
    content: (attrs) => ({
      url: attrs.url,
      title: attrs.title,
      description: attrs.description,
      favicon: attrs.favicon,
    }),
    plainText: (content) => `${readString(content, "title")} ${readString(content, "url")}`.trim(),
  },
};
