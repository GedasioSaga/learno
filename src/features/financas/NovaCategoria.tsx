import { useState, type KeyboardEvent } from "react";
import { AppError } from "../../lib/ipc";
import { BOTAO_PRIMARIO, BOTAO_TEXTO, CAMPO } from "./estilos";
import type { CategoriaRow, TipoFinanceiro } from "./ipc";
import { useFinancasStore } from "./store";

interface NovaCategoriaProps {
  /** A categoria nasce do tipo que o formulário está usando agora. */
  tipo: TipoFinanceiro;
  onCriada: (categoria: CategoriaRow) => void;
}

/**
 * Criar categoria sem sair do formulário de lançamento ou de item fixo.
 *
 * Mora DENTRO de um `<form>` e HTML não aninha formulários, então isto não é
 * um `<form>`: o Enter é interceptado aqui, senão ele enviaria o lançamento
 * pela metade.
 */
export function NovaCategoria({ tipo, onCriada }: NovaCategoriaProps) {
  const criarCategoria = useFinancasStore((state) => state.criarCategoria);
  const [aberto, setAberto] = useState(false);
  const [nome, setNome] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  function fechar() {
    setAberto(false);
    setNome("");
    setErro(null);
  }

  async function criar() {
    const nomeAparado = nome.trim();
    if (nomeAparado === "") return setErro("Dê um nome à categoria.");

    setSalvando(true);
    setErro(null);
    try {
      const categoria = await criarCategoria(nomeAparado, tipo);
      fechar();
      onCriada(categoria);
    } catch (error) {
      setErro(error instanceof AppError ? error.message : "Não foi possível criar a categoria.");
    } finally {
      setSalvando(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void criar();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      fechar();
    }
  }

  if (!aberto) {
    return (
      <button type="button" onClick={() => setAberto(true)} className={`${BOTAO_TEXTO} mt-1 -ml-2`}>
        + Nova categoria
      </button>
    );
  }

  return (
    <div className="mt-1">
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          aria-label="Nome da nova categoria"
          value={nome}
          onChange={(event) => setNome(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder={tipo === "entrada" ? "Ex.: Freelance" : "Ex.: Pets"}
          className={`${CAMPO} min-w-0`}
        />
        <button type="button" onClick={() => void criar()} disabled={salvando} className={BOTAO_PRIMARIO}>
          {salvando ? "Criando…" : "Criar"}
        </button>
        <button type="button" onClick={fechar} aria-label="Cancelar nova categoria" className={BOTAO_TEXTO}>
          Cancelar
        </button>
      </div>
      {erro ? (
        <p role="alert" className="mt-0.5 text-xs text-terracotta-ink">
          {erro}
        </p>
      ) : null}
    </div>
  );
}
