/**
 * A única porta de saída para MathJax - EDT-083's decisão de segurança vive
 * inteira neste arquivo: a única forma de transformar LaTeX em algo visível
 * é chamar `renderLatexNode`, que carrega `mathjax` (o pacote client-side,
 * `tex-svg.js`) por `import()` dinâmico dentro da função, nunca no topo do
 * módulo - não pesa o bundle inicial enquanto nenhum bloco de equação existe
 * na página, e nenhum outro caminho deste builder toca processo externo.
 *
 * Isolada aqui, atrás de uma função pequena, exatamente para que
 * `math-node-view.ts` a receba como parâmetro (`RenderLatex`) em vez de
 * chamá-la direto - MathJax não termina de carregar a tempo de um teste
 * vitest sob jsdom, então o NodeView é testado com um stub no lugar deste
 * módulo, e só este arquivo (não testado por unidade) fala com a lib de
 * verdade.
 */
import { isReadyMathJax, type ReadyMathJax } from "./mathjax-types";

let mathJaxReady: Promise<ReadyMathJax> | null = null;

/** `window.MathJax` já existe (import repetido) ou é criado com a config que `tex-svg.js` lê ao carregar - ver `mathjax-types.ts` sobre por que este objeto ainda não tem `tex2svgPromise`. */
function ensureMathJaxConfig(): void {
  if (window.MathJax) return;
  window.MathJax = { svg: { fontCache: "global" } };
}

async function loadMathJax(): Promise<ReadyMathJax> {
  if (!mathJaxReady) {
    mathJaxReady = (async () => {
      ensureMathJaxConfig();
      // Efeito colateral: completa `window.MathJax`, no lugar, com a API real.
      await import("mathjax/tex-svg.js");
      const mathJax = window.MathJax;
      if (!mathJax || !isReadyMathJax(mathJax)) {
        throw new Error("mathjax/tex-svg.js carregou sem inicializar window.MathJax");
      }
      await mathJax.startup.promise;
      return mathJax;
    })();
  }
  return mathJaxReady;
}

/** LaTeX cru -> nó DOM já tipografado. `display` decide bloco (centralizado, EDT-022) vs inline (EDT-023). */
export async function renderLatexNode(expression: string, display: boolean): Promise<Node> {
  const mathJax = await loadMathJax();
  return mathJax.tex2svgPromise(expression, { display });
}
