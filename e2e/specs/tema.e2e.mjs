// A escolha de tema, de ponta a ponta.
//
// Nenhuma spec tocava tema antes desta, e o caminho tem exatamente as partes
// que só um app de verdade exercita: o `data-theme` no documento, a
// persistência no `config.json` pelo comando `save_theme` do Rust, e o cache
// de primeiro paint no `localStorage` da WebView. Um teste de componente em
// jsdom mocka os três.
//
// O que ele NÃO tenta provar: que as cores estão bonitas. Isso é olho humano.
// O que dá para provar por máquina é que a escolha chega ao documento, que ela
// sobrevive, e que cada tema de fato pinta diferente do outro — que é a
// regressão silenciosa mais provável (um bloco de tema com erro de sintaxe
// simplesmente não casa, e o app fica no tema anterior sem erro nenhum).

import fs from "node:fs";
import path from "node:path";

import { query, waitFor } from "../lib/db.mjs";

/** Onde as capturas ficam, para inspeção humana depois da rodada. */
const PASTA_DE_CAPTURA = path.join(process.env.TEMP ?? ".", "learno-temas");

async function abrirConfiguracoes() {
  await $('[aria-label="Páginas"]').waitForDisplayed({ timeout: 30000 });
  await $('button[aria-label="Configurações"]').click();
  await $('[aria-label="Seções das configurações"]').waitForDisplayed({ timeout: 5000 });
}

/** O `data-theme` que está no `<html>` agora. */
function temaNoDocumento() {
  return browser.execute(() => document.documentElement.dataset.theme ?? null);
}

/** A cor de fundo que o navegador de fato calculou para o corpo da página. */
function fundoCalculado() {
  return browser.execute(() => getComputedStyle(document.body).backgroundColor);
}

describe("Aparência — escolha de tema", () => {
  before(async () => {
    fs.mkdirSync(PASTA_DE_CAPTURA, { recursive: true });
    await abrirConfiguracoes();
  });

  it("abre em Âmbar noturno numa instalação nova", async () => {
    // A decisão de produto: a primeira impressão é sempre a identidade
    // escolhida, e não o que o Windows estiver usando.
    await expect(await temaNoDocumento()).toBe("ambar-noturno");
  });

  it("mostra os cinco temas mais a opção de seguir o sistema", async () => {
    const grupo = await $('[role="radiogroup"][aria-label="Tema"]');
    await grupo.waitForDisplayed({ timeout: 5000 });

    const opcoes = await grupo.$$('input[type="radio"]');
    await expect(opcoes.length).toBe(6);
  });

  it("trocar de tema repinta o documento, e cada tema pinta diferente", async () => {
    const fundos = new Map();
    fundos.set("ambar-noturno", await fundoCalculado());

    // Volta ao padrao no fim: o teste seguinte comeca de um estado conhecido,
    // e a captura do tema padrao — o que o usuario ve ao abrir o app — fica
    // salva junto com as outras.
    for (const id of ["papel", "grafite", "meia-noite", "alto-contraste", "ambar-noturno"]) {
      // O input é `sr-only`, focável mas invisível — o clique vai no `<label>`
      // que o embrulha, que é como o usuário interage de verdade.
      await $(`input[value="${id}"]`).parentElement().click();

      await waitFor(
        async () => await temaNoDocumento(),
        (atual) => atual === id,
        { mensagem: `o documento passar para o tema ${id}` },
      );

      fundos.set(id, await fundoCalculado());
      await browser.saveScreenshot(path.join(PASTA_DE_CAPTURA, `${id}.png`));
    }

    // A regressão que isto pega: um bloco de tema com erro de sintaxe não
    // casa, o `data-theme` muda mas a cor não, e nada acusa. Fundos iguais
    // entre temas diferentes é exatamente esse sintoma.
    const distintos = new Set(fundos.values());
    await expect(distintos.size).toBe(fundos.size);
  });

  it("a escolha vai para o config.json, não só para a memória da sessão", async () => {
    await $('input[value="grafite"]').parentElement().click();
    await waitFor(
      async () => await temaNoDocumento(),
      (atual) => atual === "grafite",
      { mensagem: "o documento passar para grafite antes de conferir o disco" },
    );

    // O `config.json` é do `tauri-plugin-store` e fica na pasta de dados do
    // app, ao lado do banco — não dentro dele. Ler o arquivo é o jeito de
    // provar que o comando `save_theme` do Rust foi mesmo chamado.
    const configJson = path.join(process.env.APPDATA ?? "", "com.learno.app", "config.json");
    await waitFor(
      () => JSON.parse(fs.readFileSync(configJson, "utf-8")).theme ?? null,
      (gravado) => gravado === "grafite",
      { mensagem: `o tema gravado em ${configJson}` },
    );
  });

  it("o banco continua respondendo depois de trocar de tema", async () => {
    // Guarda contra a regressão boba: tema é só CSS, e nada do que ele faz
    // pode derrubar a conexão com o banco que a sessão já tinha aberto.
    const tabelas = query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pages'");
    await expect(tabelas.length).toBe(1);
  });
});
