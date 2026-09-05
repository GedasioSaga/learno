/**
 * Pure heading-extraction and tree-building logic for the table-of-contents
 * block (EDT-031), kept apart from the NodeView so "reads the live doc and
 * nests by level" is exercised without mounting React or a ProseMirror view.
 *
 * `collectHeadings` never trusts a snapshot taken at insertion time - the
 * caller (`TocView.tsx`) re-runs it on every editor `update`, which is what
 * makes the list track headings added or removed anywhere on the page.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import { NODE_NAMES } from "../../core/node-names";

export interface HeadingEntry {
  id: string;
  level: number;
  text: string;
}

export interface TocTreeNode extends HeadingEntry {
  children: TocTreeNode[];
}

/** Every heading in the doc, in document order - the TOC follows page order, never a re-sort by level. */
export function collectHeadings(doc: PMNode): HeadingEntry[] {
  const headings: HeadingEntry[] = [];
  doc.descendants((node) => {
    if (node.type.name !== NODE_NAMES.heading) return true;
    const id = node.attrs.id;
    // Sem id estável não há como o clique navegar até este título depois -
    // mesma guarda que `docToFlatBlocks` usa para o mesmo motivo.
    if (typeof id !== "string") return true;
    const level = Number(node.attrs.level) || 1;
    headings.push({ id, level, text: node.textContent });
    return true;
  });
  return headings;
}

/**
 * Nests a flat, document-order heading list by level: an H2 becomes a child
 * of the H1 before it, an H3 a child of that H2, and so on. A level jump
 * (H1 straight to H3) still nests correctly - the loop pops every open
 * ancestor whose level is not strictly smaller than the new heading's, so
 * the new entry always lands under the nearest still-open ancestor, or at
 * the root when there is none.
 */
export function buildTocTree(headings: HeadingEntry[]): TocTreeNode[] {
  const roots: TocTreeNode[] = [];
  const openAncestors: TocTreeNode[] = [];

  for (const heading of headings) {
    const node: TocTreeNode = { ...heading, children: [] };
    while (openAncestors.length > 0 && openAncestors[openAncestors.length - 1].level >= heading.level) {
      openAncestors.pop();
    }
    const parent = openAncestors[openAncestors.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    openAncestors.push(node);
  }

  return roots;
}
