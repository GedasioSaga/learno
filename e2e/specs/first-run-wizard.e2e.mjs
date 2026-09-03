// PLT-016 — "Assistente de primeira execução para conectar ao Postgres
// local" (docs/CHECKLIST.md). O critério de aceite descrito lá só se prova
// de ponta a ponta: precisa do processo Tauri de verdade, do IPC real e de
// um Postgres de verdade respondendo — nenhum desses três existe num teste
// de componente em Vitest, que troca `invoke()` por um mock.
//
// `wdio.conf.mjs` garante que cada sessão nasce sem `config.json`, então o
// primeiro estado visível tem que ser sempre este assistente.

import { DEV_DB } from "../lib/env.mjs";

/** Input pareado com `label`/`htmlFor` — não há `name`/`data-testid` no componente, então o par label+input é o seletor estável disponível. */
function fieldFor(label) {
  return $(`//label[normalize-space(text())="${label}"]/following-sibling::input`);
}

describe("PLT-016 — assistente de primeira execução", () => {
  it("aparece com o formulário de conexão quando não há configuração salva", async () => {
    const heading = await $("h1=Conectar ao Postgres");
    await heading.waitForDisplayed({ timeout: 20000 });

    await expect(fieldFor("Host")).toHaveValue("localhost");
    await expect($("button=Testar conexão")).toBeDisplayed();
  });

  it("testa a conexão real com o Postgres de desenvolvimento e reporta sucesso", async () => {
    await fieldFor("Host").setValue(DEV_DB.host);
    await fieldFor("Porta").setValue(String(DEV_DB.port));
    await fieldFor("Banco de dados").setValue(DEV_DB.database);
    await fieldFor("Usuário").setValue(DEV_DB.user);
    // Senha fica em branco de propósito: o cluster de dev roda com
    // autenticação trust (`DEV_DB.password` é `""`), e um Postgres local
    // trust não tem senha nenhuma para digitar. Este é o caso real que
    // FirstRunWizard.tsx precisa aceitar sem travar o submit em silêncio.
    await expect(fieldFor("Senha")).toHaveValue("");

    await $("button=Testar conexão").click();

    const status = await $('[role="status"]');
    await status.waitForDisplayed({ timeout: 15000 });
    await expect(status).toHaveText("Conexão bem-sucedida.");
  });

  it("ao clicar Continuar, libera a árvore de páginas — critério de aceite completo do PLT-016", async () => {
    await $("button=Continuar").click();

    // Isto é o próprio critério de aceite do PLT-016 (Dado testado com
    // sucesso, Quando "Continuar", Então o app segue para uso — nunca uma
    // tela em branco). `handleContinue` chama `connectDatabase()`
    // (src/lib/ipc.ts → comando Rust `connect_database`), que abre a
    // conexão de verdade, roda as migrações pendentes e só então persiste a
    // configuração — confirmado independentemente do DOM logo abaixo, com
    // `psql` direto no `learno_dev` (ver docs/e2e.md): a base que entrou
    // vazia nesta mesma rodada saiu com as 17 tabelas do schema.
    const tree = await $('[aria-label="Árvore de páginas"]');
    await tree.waitForDisplayed({ timeout: 15000 });
  });
});
