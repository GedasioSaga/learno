// PLT-016 — "primeira execução do app numa máquina limpa" (docs/CHECKLIST.md).
//
// Este arquivo substitui `first-run-wizard.e2e.mjs`, e a substituição é o
// critério de aceite mudando de forma junto com o produto. Enquanto o banco
// era um PostgreSQL, a primeira execução tinha que mostrar um assistente que
// coletava host, porta, banco, usuário e senha, testava a conexão e só então
// liberava o app; o teste antigo dirigia exatamente esses campos. Depois da
// migração para SQLite (docs/MIGRACAO-SQLITE.md) não há o que coletar: o
// banco é um arquivo dentro da pasta de dados do app, criado na hora. O
// critério passou a ser o oposto do anterior — a primeira execução NÃO pode
// pedir nada.
//
// `wdio.conf.mjs` apaga a pasta de dados do app antes da sessão, então
// quando este arquivo roda a máquina está, para todos os efeitos, limpa: sem
// configuração e sem banco.

import fs from "node:fs";

import { DATABASE_FILE, query, waitFor } from "../lib/db.mjs";

describe("PLT-016 — primeira execução numa máquina limpa", () => {
  it("abre direto no app, sem assistente e sem pedir credencial nenhuma", async () => {
    // A barra lateral da árvore de páginas é a primeira coisa do app de
    // verdade: se ela aparece, o banco abriu e o IPC responde.
    const sidebar = await $('[aria-label="Páginas"]');
    await sidebar.waitForDisplayed({ timeout: 30000 });

    // E nada do assistente sobrou pelo caminho. Procurar por texto que não
    // existe mais é justamente o ponto: se alguém reintroduzir um passo de
    // conexão, este teste cai.
    await expect($("h1=Conectar ao Postgres")).not.toBeDisplayed();
    await expect($('input[type="password"]')).not.toBeDisplayed();
  });

  it("cria o arquivo do banco na pasta de dados do app", async () => {
    await waitFor(
      () => fs.existsSync(DATABASE_FILE),
      (existe) => existe === true,
      { mensagem: `o arquivo do banco em ${DATABASE_FILE}` },
    );
  });

  it("aplica as migrações antes de liberar o app", async () => {
    // Não basta o arquivo existir: um arquivo vazio também existiria. O que
    // prova que PLT-002 rodou é o schema estar lá — e é o mesmo histórico
    // que `db::pool` consulta para decidir se precisa migrar.
    const tabelas = query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('pages', 'blocks', '_sqlx_migrations') ORDER BY name",
    ).map((linha) => linha.name);

    expect(tabelas).toEqual(["_sqlx_migrations", "blocks", "pages"]);
  });
});
