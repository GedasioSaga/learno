import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getAppConfig, saveDataDir } from "../../lib/ipc";

/**
 * PLT-016: onde o usuário vê e troca a pasta de trabalho — a pasta onde o
 * arquivo do banco (`learno.sqlite`) e os backups vivem.
 *
 * Este componente existe porque a migração para SQLite apagou o assistente de
 * primeira execução, e o assistente era o ÚNICO lugar do app que chamava
 * `saveDataDir`. Sem esta seção, o comando continuaria correto e testado no
 * Rust e inalcançável por qualquer clique — o mesmo defeito que já apareceu
 * três vezes neste projeto (`docs/ACHADOS-FASE-2.md`,
 * `docs/ACHADOS-FASE-3.md`: autosave, @-menção e registro de extensões).
 *
 * Trocar a pasta não é uma operação inofensiva: o backend fecha o pool, leva o
 * banco junto quando a pasta escolhida está vazia, adota o banco que já
 * estiver lá quando não está, e reabre. Por isso a tela diz o que vai
 * acontecer ANTES, e pede confirmação — a diferença entre "mudei de lugar" e
 * "abri outro acervo" não deve ser descoberta depois do clique.
 */
type Status =
  | { kind: "carregando" }
  | { kind: "pronto" }
  | { kind: "confirmando"; escolhida: string }
  | { kind: "trocando" }
  | { kind: "erro"; mensagem: string };

export function DataFolderSection() {
  const [pastaAtual, setPastaAtual] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "carregando" });

  useEffect(() => {
    let cancelado = false;

    getAppConfig()
      .then((config) => {
        if (cancelado) return;
        // `null` significa "nunca escolheu" — o app está usando a pasta padrão
        // do sistema operacional, que é um estado normal, não um erro.
        setPastaAtual(config?.data_dir ?? null);
        setStatus({ kind: "pronto" });
      })
      .catch((erro: unknown) => {
        if (cancelado) return;
        setStatus({
          kind: "erro",
          mensagem: erro instanceof Error ? erro.message : "Não foi possível ler a pasta de trabalho.",
        });
      });

    return () => {
      cancelado = true;
    };
  }, []);

  async function escolher() {
    const escolhida = await open({ directory: true, multiple: false, title: "Escolher pasta de trabalho" });
    if (typeof escolhida !== "string") return;
    setStatus({ kind: "confirmando", escolhida });
  }

  async function confirmar(escolhida: string) {
    setStatus({ kind: "trocando" });
    try {
      const config = await saveDataDir(escolhida);
      setPastaAtual(config.data_dir);
      setStatus({ kind: "pronto" });
    } catch (erro: unknown) {
      setStatus({
        kind: "erro",
        mensagem: erro instanceof Error ? erro.message : "Não foi possível trocar a pasta de trabalho.",
      });
    }
  }

  return (
    <section>
      <p className="text-sm text-ink-muted">
        Seus dados ficam num arquivo dentro desta pasta. Guardá-la numa pasta sincronizada (OneDrive,
        Dropbox) faz o Learno acompanhar você entre computadores — desde que só um deles esteja aberto por
        vez.
      </p>

      <p className="mt-3 text-sm text-ink">
        <span className="font-medium">Pasta atual: </span>
        {status.kind === "carregando" ? "carregando…" : (pastaAtual ?? "pasta padrão do sistema")}
      </p>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void escolher()}
          disabled={status.kind === "trocando" || status.kind === "carregando"}
          className="rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink disabled:opacity-50"
        >
          Escolher outra pasta…
        </button>
      </div>

      {status.kind === "confirmando" ? (
        <div className="mt-3 rounded-sm border border-border bg-surface p-3">
          <p className="text-sm text-ink">
            Usar <span className="font-medium">{status.escolhida}</span> como pasta de trabalho?
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            Se a pasta estiver vazia, seus dados são copiados para lá. Se já houver um Learno nela, ele é
            aberto como está. Nada é apagado da pasta atual.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void confirmar(status.escolhida)}
              className="rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink"
            >
              Trocar
            </button>
            <button
              type="button"
              onClick={() => setStatus({ kind: "pronto" })}
              className="rounded-sm px-3 py-2 text-sm text-ink-muted"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : null}

      {status.kind === "trocando" ? <p className="mt-3 text-sm text-ink-muted">Trocando de pasta…</p> : null}

      {status.kind === "erro" ? (
        <p role="alert" className="mt-3 text-sm text-terracotta-ink">
          {status.mensagem}
        </p>
      ) : null}
    </section>
  );
}
