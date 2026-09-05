/**
 * Ponto de entrada desta pasta para o resto de `pages/` (`PageWorkspace.tsx`
 * é o único consumidor hoje). Sem o problema de ciclo que o README do editor
 * documenta para `editor/index.ts` — esta pasta não é descoberta por
 * `import.meta.glob`, então nada aqui reimporta este barrel de volta.
 */
export { BacklinksSection } from "./BacklinksSection";
export { usePageTitle } from "./use-page-title";
