/**
 * A forma de `window.MathJax` - só a fatia que `render-latex.ts` realmente
 * usa, não a API inteira do componente combinado. Ver `mathjax-module.d.ts`
 * para por que isso existe: o pacote não vem com tipos.
 *
 * `startup`/`tex2svgPromise` são opcionais porque a mesma variável serve
 * dois momentos diferentes (ver docs oficiais, "Configure MathJax Global
 * Object"): antes de `tex-svg.js` carregar, `window.MathJax` é só a config
 * que se está passando pra ele (`{ svg: {...} }`); só depois de carregar o
 * bundle é que a lib devolve a API de verdade no mesmo objeto. `ReadyMathJax`
 * é a forma pós-carregamento, e `isReady` é o jeito de provar isso ao
 * compilador sem `as`/`!`.
 */
export interface MathJaxObject {
  startup?: { promise: Promise<void> };
  /** Assíncrono de propósito (carrega fonte/extensão sob demanda) - ver docs oficiais, "Preferred over synchronous variants in v4". */
  tex2svgPromise?(tex: string, options?: { display?: boolean }): Promise<HTMLElement>;
  svg?: { fontCache?: string };
}

export type ReadyMathJax = MathJaxObject & Required<Pick<MathJaxObject, "startup" | "tex2svgPromise">>;

export function isReadyMathJax(mathJax: MathJaxObject): mathJax is ReadyMathJax {
  return mathJax.startup !== undefined && typeof mathJax.tex2svgPromise === "function";
}

declare global {
  interface Window {
    MathJax?: MathJaxObject;
  }
}
