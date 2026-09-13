import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A trava contra o defeito que este projeto já cometeu SEIS vezes.
 *
 * O histórico, em `docs/ACHADOS-FASE-2.md` e `-FASE-3.md`: o autosave que
 * nunca gravou bloco, a @-menção que nunca gerou backlink, o registro de
 * extensões que ninguém chamava, o `saveDataDir` sem chamador, o motor de
 * fórmula inteiro fora do `lib.rs` — e, por último, a seção Cartões, com
 * árvore de baralhos, sessão de estudo e criação de nota prontas e testadas,
 * mostrando "Em construção" porque `montarSecoes` em `App.tsx` não a listava.
 *
 * Todas as seis passaram por revisão e por suíte verde. Nenhum teste as pegou
 * porque cada um testava a peça, e o que faltava era a LIGAÇÃO entre a peça e
 * o caminho que o usuário percorre.
 *
 * Este teste é o inverso: ele não olha nenhuma peça, olha só a costura. A
 * regra que ele impõe é uma frase — **uma tela de seção que existe no código
 * precisa estar montada no app** — e ela se mantém sozinha: uma seção nova
 * entra na conta no instante em que o arquivo aparece, sem ninguém lembrar de
 * atualizar uma lista aqui.
 *
 * Ele lê o texto de `App.tsx` de propósito, em vez de importar o módulo: o que
 * se quer provar é que a fiação está ESCRITA lá, e importar `App.tsx` num
 * teste de nó arrastaria a árvore inteira de componentes e o runtime do Tauri
 * junto.
 */
const RAIZ = path.resolve(__dirname, "../..");

/** Todo `ConteudoDeX` exportado por qualquer feature — cada um é uma tela de seção. */
function telasDeSecaoNoCodigo(): string[] {
  const encontradas = new Set<string>();

  function varrer(diretorio: string) {
    for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
      const caminho = path.join(diretorio, entrada.name);
      if (entrada.isDirectory()) {
        varrer(caminho);
        continue;
      }
      if (!/\.tsx?$/.test(entrada.name) || /\.test\.tsx?$/.test(entrada.name)) continue;

      const fonte = fs.readFileSync(caminho, "utf-8");
      for (const achado of fonte.matchAll(/export function (ConteudoDe[A-Za-z]+)/g)) {
        encontradas.add(achado[1]);
      }
    }
  }

  varrer(path.join(RAIZ, "features"));
  return [...encontradas].sort();
}

describe("toda tela de seção é alcançável", () => {
  it("cada ConteudoDe* que existe no código está montado em App.tsx", () => {
    const app = fs.readFileSync(path.join(RAIZ, "App.tsx"), "utf-8");
    const telas = telasDeSecaoNoCodigo();

    expect(telas.length).toBeGreaterThan(0);

    const orfas = telas.filter((tela) => !app.includes(tela));
    expect(orfas, [
      "Estas telas de seção existem no código e não estão montadas em src/App.tsx —",
      "ou seja: nenhum clique no app chega até elas, e o usuário vê 'Em construção'",
      "numa seção que na verdade está pronta. Acrescente-as ao `montarSecoes({ ... })`.",
    ].join(" ")).toEqual([]);
  });

  it("cada tela montada é de fato passada para montarSecoes, não só importada", () => {
    // Importar sem usar é o mesmo defeito com outra cara: o `tsc` não reclama
    // (o import é usado no arquivo, na lista de importação) mas a seção segue
    // com o placeholder.
    const app = fs.readFileSync(path.join(RAIZ, "App.tsx"), "utf-8");
    const blocoDeMontagem = app.slice(app.indexOf("montarSecoes("), app.indexOf("});", app.indexOf("montarSecoes(")));

    const importadas = [...app.matchAll(/\b(ConteudoDe[A-Za-z]+)\b/g)].map((achado) => achado[1]);
    const fora = [...new Set(importadas)].filter((nome) => !blocoDeMontagem.includes(nome));

    expect(fora, "importadas em App.tsx mas nunca passadas para montarSecoes").toEqual([]);
  });
});
