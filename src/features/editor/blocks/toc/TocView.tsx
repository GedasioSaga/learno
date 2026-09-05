/**
 * `TocPanel` renders the block's list from the *live* editor doc, never a
 * snapshot taken when the block was inserted - EDT-031's "se atualiza"
 * requirement. Subscribing to the editor's own `update` event (fired after
 * every transaction that changes the doc, anywhere on the page - not just
 * inside this node) is what makes a heading added or removed elsewhere show
 * up here without the page reloading.
 *
 * Split from `TocNodeView` (the `addNodeView` adapter) so the panel itself
 * takes a plain `editor` prop and can be exercised with
 * `@testing-library/react` directly, the way `marks/script/register.test.tsx`
 * tests its formatting buttons - no ProseMirror NodeView plumbing needed to
 * cover the reactive-update and click-to-navigate behavior.
 */
import type { Editor, NodeViewProps } from "@tiptap/core";
import { NodeViewWrapper } from "@tiptap/react";
import { useEffect, useState } from "react";
import { navigateToHeading } from "./toc-navigation";
import { buildTocTree, collectHeadings, type TocTreeNode } from "./toc-tree";
import "./toc.css";

interface TocPanelProps {
  editor: Editor;
}

export function TocPanel({ editor }: TocPanelProps) {
  const [tree, setTree] = useState<TocTreeNode[]>(() => buildTocTree(collectHeadings(editor.state.doc)));

  useEffect(() => {
    const recompute = () => setTree(buildTocTree(collectHeadings(editor.state.doc)));
    recompute(); // o doc pode ter mudado entre o render inicial e este efeito
    editor.on("update", recompute);
    return () => {
      editor.off("update", recompute);
    };
  }, [editor]);

  if (tree.length === 0) {
    return (
      <nav className="ed-toc ed-toc--empty" aria-label="Sumário da página">
        Esta página ainda não tem títulos. Use “#”, “##” ou “###” para criar um.
      </nav>
    );
  }

  return (
    <nav className="ed-toc" aria-label="Sumário da página">
      <TocList nodes={tree} onNavigate={(headingId) => navigateToHeading(editor, headingId)} />
    </nav>
  );
}

function TocList({ nodes, onNavigate }: { nodes: TocTreeNode[]; onNavigate: (headingId: string) => void }) {
  return (
    <ul className="ed-toc__list">
      {nodes.map((node) => (
        <li key={node.id} className="ed-toc__item">
          <button type="button" className="ed-toc__link" onClick={() => onNavigate(node.id)}>
            {node.text || "Sem título"}
          </button>
          {node.children.length > 0 && <TocList nodes={node.children} onNavigate={onNavigate} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * `addNodeView` adapter. The node itself carries nothing but its `id` (see
 * `table-of-contents-node.ts`), so only `editor` and `node` from
 * `NodeViewProps` are used - `id` re-applied here because a custom NodeView
 * bypasses the node type's own `renderHTML`/attr reflection entirely.
 */
export function TocNodeView({ editor, node }: NodeViewProps) {
  const blockId = typeof node.attrs.id === "string" ? node.attrs.id : undefined;
  return (
    <NodeViewWrapper
      data-block-type="tableOfContents"
      data-block-id={blockId}
      className="ed-block ed-toc-block"
      contentEditable={false}
    >
      <TocPanel editor={editor} />
    </NodeViewWrapper>
  );
}
