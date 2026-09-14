import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AppError, importApkg, type RelatorioDeImportacao } from "../../lib/ipc";
import { useCartoesStore } from "../cartoes/store";

type ImportStatus =
  | { kind: "idle" }
  | { kind: "importing"; fileName: string }
  | { kind: "done"; fileName: string; relatorio: RelatorioDeImportacao }
  | { kind: "error"; message: string };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof AppError || error instanceof Error ? error.message : fallback;
}

/**
 * O diálogo nativo devolve o caminho absoluto do arquivo escolhido — só o
 * nome do arquivo importa para o status na tela, não o caminho inteiro do
 * disco do usuário. `\\` e `/` cobrem separador do Windows e do resto.
 */
function fileNameFromPath(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/** O que o resumo diz além da linha principal: só o que de fato aconteceu. */
function detalhesDoRelatorio(relatorio: RelatorioDeImportacao): string[] {
  const linhas: string[] = [];
  if (relatorio.notasJaExistentes > 0) {
    linhas.push(`${relatorio.notasJaExistentes} nota(s) já importada(s) antes: pulada(s), sem mexer no progresso.`);
  }
  if (relatorio.revisoesImportadas > 0) {
    linhas.push(`${relatorio.revisoesImportadas} revisão(ões) do histórico.`);
  }
  if (relatorio.baralhosCriados > 0) {
    linhas.push(`${relatorio.baralhosCriados} baralho(s) novo(s).`);
  }
  if (relatorio.tiposDeNotaCriados > 0) {
    linhas.push(`${relatorio.tiposDeNotaCriados} tipo(s) de nota novo(s).`);
  }
  if (relatorio.notasSemCartao > 0) {
    linhas.push(`${relatorio.notasSemCartao} nota(s) sem cartão ficaram de fora.`);
  }
  if (relatorio.midiasIgnoradas > 0) {
    linhas.push(
      `${relatorio.midiasIgnoradas} arquivo(s) de mídia não importado(s): imagem e áudio ainda não aparecem nos cartões.`,
    );
  }
  return linhas;
}

/**
 * PLT-004: o único ponto de entrada da importação do Anki (`.apkg` e
 * `.colpkg`). O backend lê o pacote e grava notas, cartões com o agendamento
 * e o histórico numa transação só (`src-tauri/src/anki`).
 *
 * `handlePickFile` nunca bloqueia a thread de UI enquanto o backend importa —
 * é um `await` comum sobre uma Promise, então cliques e scroll em qualquer
 * outro lugar da tela continuam funcionando (uma coleção de 24 mil notas leva
 * alguns segundos), o que o teste deste componente confirma mantendo a
 * Promise pendente e interagindo com outro elemento antes de resolvê-la.
 *
 * O resumo mostra o que o backend contou, sem arredondar para "deu certo":
 * nota pulada por já ter sido importada e mídia deixada de fora aparecem por
 * escrito.
 *
 * PLT-013: o backend faz uma cópia de segurança do banco (`VACUUM INTO`)
 * antes de gravar qualquer coisa.
 */
export function ImportApkgSection() {
  const [status, setStatus] = useState<ImportStatus>({ kind: "idle" });

  async function handlePickFile() {
    const selected = await open({
      title: "Selecionar baralho ou coleção do Anki",
      filters: [{ name: "Anki", extensions: ["apkg", "colpkg"] }],
    });

    // Usuário fechou o diálogo sem escolher nada — não é erro, só nada a fazer.
    if (typeof selected !== "string") return;

    const fileName = fileNameFromPath(selected);
    setStatus({ kind: "importing", fileName });
    try {
      const relatorio = await importApkg(selected);
      // A importação pode criar tipos de nota, e a store de Cartões guarda os
      // tipos de uma carga só. Voltar para "idle" faz a próxima tela de
      // Cartões que montar buscar de novo, em vez de seguir sem os tipos novos
      // até o app reiniciar.
      useCartoesStore.setState({ noteTypesStatus: "idle" });
      setStatus({ kind: "done", fileName, relatorio });
    } catch (error) {
      // Arquivo que não é pacote do Anki, arquivo ilegível e falha do backup
      // pré-importação (PLT-013: disco cheio, permissão negada) chegam todos
      // como `AppError` com `message` pronta para o usuário.
      setStatus({ kind: "error", message: errorMessage(error, "Não foi possível importar o arquivo do Anki.") });
    }
  }

  const isImporting = status.kind === "importing";

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">
        Importa um baralho (<code>.apkg</code>) ou uma coleção inteira (<code>.colpkg</code>) exportados do Anki, com
        o progresso de estudo e o histórico de revisões. O texto dos cartões chega sem formatação, e importar o mesmo
        arquivo de novo não duplica nada. Antes de importar, o app faz uma cópia de segurança do banco atual.
      </p>

      <div>
        <button
          type="button"
          disabled={isImporting}
          onClick={() => void handlePickFile()}
          className="rounded-sm border border-border bg-surface px-4 py-2 text-sm font-medium text-ink disabled:opacity-60"
        >
          {isImporting ? `Importando "${status.fileName}"…` : "Importar do Anki (.apkg ou .colpkg)"}
        </button>
      </div>

      {status.kind === "done" ? (
        <div role="status" className="text-sm text-mint-ink">
          <p>
            {`"${status.fileName}": ${status.relatorio.notasImportadas} nota(s) e ${status.relatorio.cartoesImportados} cartão(ões) importados.`}
          </p>
          {detalhesDoRelatorio(status.relatorio).length > 0 ? (
            <ul className="mt-1 list-disc pl-5 text-ink-muted">
              {detalhesDoRelatorio(status.relatorio).map((linha) => (
                <li key={linha}>{linha}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {status.kind === "error" ? (
        <p role="alert" className="text-sm text-terracotta-ink">
          {status.message}
        </p>
      ) : null}
    </div>
  );
}
