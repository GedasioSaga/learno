/**
 * O pacote "mathjax" não publica `.d.ts` nenhum - confirmado lendo
 * `node_modules/mathjax/package.json` (só declara `main`/`exports` para os
 * bundles `.js`/`.mjs`/`.cjs` crus) antes de escrever contra ele, como a
 * regra 3 pede. `tex-svg.js` é o "componente combinado": um IIFE que roda
 * por efeito colateral e popula `window.MathJax` no lugar, não um módulo ES
 * com exports - por isso a declaração abaixo é um módulo vazio, e o valor
 * real é lido via `window.MathJax` (tipado em `mathjax-types.ts`).
 *
 * Ambient e escopado a esta pasta de propósito: só `render-latex.ts` importa
 * a lib, então o tipo mora ao lado de quem o usa em vez de virar uma
 * declaração global do projeto que ninguém pediu.
 */
declare module "mathjax/tex-svg.js" {}
