import { useEffect, useState, type FormEvent } from "react";
import { AppError, type CorDeMateria, type Materia, type PatchDeMateria } from "../../lib/ipc";
import { CORES_DA_GRADE } from "./cores";
import { useCronogramaStore } from "./store";
import "./materias-cores.css";

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/** Nome em português de cada cor da paleta fechada — o rótulo acessível de cada amostra, nunca a cor sozinha. */
const NOME_DA_COR: Record<CorDeMateria, string> = {
  amber: "Âmbar",
  mint: "Menta",
  azul: "Azul",
  terracotta: "Terracota",
  roxo: "Roxo",
  emerald: "Esmeralda",
  vermelho: "Vermelho",
  brown: "Marrom",
};

interface SeletorDeCorProps {
  corSelecionada: CorDeMateria;
  onSelecionar: (cor: CorDeMateria) => void;
  rotuloDoGrupo: string;
}

/**
 * As oito amostras da paleta fechada (`CORES_DA_GRADE`), pintadas com a cor
 * de verdade — ver `materias-cores.css` pro porquê de não dar pra fazer isso
 * só com classe Tailwind. A amostra escolhida ganha um CONTORNO (`ring`) e
 * `aria-pressed`, nunca só a mudança de cor: quem não distingue cor (visão
 * daltônica, tela em escala de cinza) ainda vê e ouve qual está ativa.
 */
function SeletorDeCor({ corSelecionada, onSelecionar, rotuloDoGrupo }: SeletorDeCorProps) {
  return (
    <div role="group" aria-label={rotuloDoGrupo} className="flex flex-wrap gap-1.5">
      {CORES_DA_GRADE.map((cor) => {
        const selecionada = cor === corSelecionada;
        return (
          <button
            key={cor}
            type="button"
            data-slot="amostra-de-cor"
            data-cor={cor}
            onClick={() => onSelecionar(cor)}
            aria-label={NOME_DA_COR[cor]}
            aria-pressed={selecionada}
            className={`size-7 shrink-0 rounded-full border border-border transition ${
              selecionada ? "ring-2 ring-ink ring-offset-2 ring-offset-surface" : ""
            }`}
          />
        );
      })}
    </div>
  );
}

interface LinhaDeMateriaProps {
  materia: Materia;
  onRenomear: (nome: string) => Promise<void>;
  onTrocarCor: (cor: CorDeMateria) => Promise<void>;
  onRemover: () => Promise<void>;
}

/**
 * Uma matéria na lista: nome (renomeável inline, lápis ou duplo clique),
 * amostras de cor (clicar em outra já É a troca — sem passo extra de
 * "salvar cor"), e remover — que exige confirmação NESTE painel, nunca
 * `window.confirm` (diálogo nativo trava a WebView do Tauri).
 */
function LinhaDeMateria({ materia, onRenomear, onTrocarCor, onRemover }: LinhaDeMateriaProps) {
  const [renomeando, setRenomeando] = useState(false);
  const [rascunho, setRascunho] = useState(materia.name);
  const [confirmandoRemocao, setConfirmandoRemocao] = useState(false);

  function iniciarRenomeio() {
    setRascunho(materia.name);
    setRenomeando(true);
  }

  async function confirmarRenomeio(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRenomeando(false);
    const nome = rascunho.trim();
    // Mesma guarda de `DeckTreeRow.confirmarRenomeio`: nome vazio ou igual ao
    // atual não é uma mudança de verdade, não vale um round-trip de IPC.
    if (nome === "" || nome === materia.name) return;
    await onRenomear(nome);
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-3">
      <div className="flex items-center gap-2">
        {renomeando ? (
          <form onSubmit={(event) => void confirmarRenomeio(event)} className="flex flex-1 items-center gap-2">
            <input
              value={rascunho}
              onChange={(event) => setRascunho(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setRenomeando(false);
              }}
              aria-label={`Nome da matéria ${materia.name}`}
              autoFocus
              className="min-w-0 flex-1 rounded-sm border border-border bg-paper px-2 py-1 text-sm text-ink"
            />
            <button type="submit" className="text-xs font-medium text-ink-muted hover:text-ink">
              Salvar
            </button>
            <button type="button" onClick={() => setRenomeando(false)} className="text-xs text-ink-muted hover:text-ink">
              Cancelar
            </button>
          </form>
        ) : (
          <>
            <span className="flex-1 truncate text-sm text-ink">{materia.name}</span>
            <button
              type="button"
              onClick={iniciarRenomeio}
              aria-label={`Renomear ${materia.name}`}
              className="grid size-6 shrink-0 place-items-center rounded-sm text-ink-muted hover:bg-surface hover:text-ink"
            >
              ✎
            </button>
            <button
              type="button"
              onClick={() => setConfirmandoRemocao(true)}
              aria-label={`Remover ${materia.name}`}
              className="grid size-6 shrink-0 place-items-center rounded-sm text-ink-muted hover:bg-surface hover:text-terracotta-ink"
            >
              🗑
            </button>
          </>
        )}
      </div>

      <SeletorDeCor corSelecionada={materia.color} onSelecionar={(cor) => void onTrocarCor(cor)} rotuloDoGrupo={`Cor de ${materia.name}`} />

      {confirmandoRemocao ? (
        <div
          role="alertdialog"
          aria-label={`Remover ${materia.name}?`}
          className="flex flex-col gap-2 rounded-sm border border-hairline bg-surface p-2"
        >
          {/* A store descobriu isso (ver relatório de `store.ts`): a coluna
              é `ON DELETE SET NULL`, então remover a matéria NÃO apaga bloco
              nenhum — só solta o vínculo. Quem vai remover precisa saber
              disso antes de confirmar, não descobrir depois.

              Decisão deliberada (achado do revisor): a mensagem fica
              qualitativa, sem "N blocos afetados". `Materia` (tipo em
              `lib/ipc.ts`) não carrega essa contagem, e hoje não existe
              nenhum comando IPC que a devolva sem uma consulta nova — fora
              de escopo desta correção, e um número inventado aqui seria
              pior que nenhum número. Se a contagem virar importante,
              o pedido é: expor `blocosVinculados: number` em `Materia`
              (contrato em `src-tauri/`, fora do que este painel pode tocar). */}
          <p className="text-xs text-ink-muted">
            Remover "{materia.name}"? Os blocos que já usam essa matéria não são apagados — só perdem o vínculo com ela.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmandoRemocao(false)} className="text-xs text-ink-muted hover:text-ink">
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmandoRemocao(false);
                void onRemover();
              }}
              className="rounded-sm border border-terracotta-ink px-2 py-1 text-xs font-medium text-terracotta-ink hover:bg-surface-raised"
            >
              Remover mesmo assim
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * A tela de matérias: hoje o backend tem `criar_materia`/`listar_materias`/
 * `atualizar_materia`/`remover_materia` e nenhuma tela os chama — este
 * painel é essa tela. Lista, cria (nome + cor), renomeia, troca cor e
 * remove; cada amostra de cor é a cor de verdade (`SeletorDeCor`), nunca um
 * menu suspenso de nomes.
 *
 * O erro de qualquer ação (criar/renomear/trocar cor/remover) cai no mesmo
 * `erro` local, substituindo o anterior — o painel é pequeno o bastante pra
 * uma mensagem de cada vez bastar, e local (não o `errorMessage` da store)
 * porque este painel precisa funcionar sozinho, sem depender de estar
 * montado dentro de `ConteudoDeCronograma` pra ter onde mostrar erro.
 */
export function PainelDeMaterias() {
  const materias = useCronogramaStore((state) => state.materias);
  const materiasStatus = useCronogramaStore((state) => state.materiasStatus);
  const materiasErrorMessage = useCronogramaStore((state) => state.materiasErrorMessage);
  const carregarMaterias = useCronogramaStore((state) => state.carregarMaterias);
  const criarMateria = useCronogramaStore((state) => state.criarMateria);
  const atualizarMateria = useCronogramaStore((state) => state.atualizarMateria);
  const removerMateria = useCronogramaStore((state) => state.removerMateria);

  useEffect(() => {
    void carregarMaterias();
  }, [carregarMaterias]);

  const [nomeNovo, setNomeNovo] = useState("");
  const [corNova, setCorNova] = useState<CorDeMateria>(CORES_DA_GRADE[0]);
  const [criando, setCriando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function criar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nome = nomeNovo.trim();
    if (nome === "") {
      setErro("Dê um nome à matéria antes de criar.");
      return;
    }
    setCriando(true);
    setErro(null);
    try {
      await criarMateria(nome, corNova);
      setNomeNovo("");
      setCorNova(CORES_DA_GRADE[0]);
    } catch (error) {
      setErro(messageFor(error, "Não foi possível criar a matéria."));
    } finally {
      setCriando(false);
    }
  }

  // As três ações por matéria abaixo nunca relançam: a store já garante que
  // a lista não fica corrompida numa falha (ver `store.test.ts`), então o
  // painel só precisa capturar o erro pra mostrar — não há estado de
  // "reverter" a fazer aqui.
  async function renomear(materiaId: string, nome: string) {
    try {
      await atualizarMateria(materiaId, { name: nome });
      setErro(null);
    } catch (error) {
      setErro(messageFor(error, "Não foi possível renomear a matéria."));
    }
  }

  async function trocarCor(materiaId: string, cor: CorDeMateria) {
    const patch: PatchDeMateria = { color: cor };
    try {
      await atualizarMateria(materiaId, patch);
      setErro(null);
    } catch (error) {
      setErro(messageFor(error, "Não foi possível trocar a cor da matéria."));
    }
  }

  async function remover(materiaId: string) {
    try {
      await removerMateria(materiaId);
      setErro(null);
    } catch (error) {
      setErro(messageFor(error, "Não foi possível remover a matéria."));
    }
  }

  return (
    <section aria-labelledby="painel-de-materias-titulo" className="flex flex-col gap-4">
      <h2 id="painel-de-materias-titulo" className="font-display text-lg text-ink">
        Matérias
      </h2>

      <form onSubmit={(event) => void criar(event)} className="flex flex-col gap-3 rounded-md border border-hairline bg-surface p-3">
        <label className="text-sm">
          <span className="mb-1 block text-ink-muted">Nova matéria</span>
          <input
            value={nomeNovo}
            onChange={(event) => setNomeNovo(event.currentTarget.value)}
            placeholder="Nome da matéria"
            className="w-full rounded-sm border border-border bg-paper px-3 py-2 text-sm text-ink"
          />
        </label>

        <SeletorDeCor corSelecionada={corNova} onSelecionar={setCorNova} rotuloDoGrupo="Cor da nova matéria" />

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={criando}
            className="rounded-sm bg-emerald px-3 py-1.5 text-sm font-medium text-on-emerald transition hover:brightness-110 active:scale-97 disabled:opacity-50 disabled:pointer-events-none"
          >
            {criando ? "Criando…" : "Criar matéria"}
          </button>
        </div>
      </form>

      {erro ? (
        <p role="alert" className="text-sm text-terracotta-ink">
          {erro}
        </p>
      ) : null}

      {materiasStatus === "loading" ? (
        <p className="text-sm text-ink-muted">Carregando matérias…</p>
      ) : materiasStatus === "error" ? (
        // Ramo que faltava: sem isto, `carregarMaterias()` falhando e a lista
        // continuando vazia caía no MESMO texto do sucesso vazio abaixo — um
        // convite pra criar matéria quando na verdade a busca falhou.
        <p role="alert" className="text-sm text-terracotta-ink">
          {materiasErrorMessage ?? "Não foi possível carregar as matérias."}
        </p>
      ) : materias.length === 0 ? (
        <p className="text-sm text-ink-muted">Nenhuma matéria ainda. Crie a primeira acima.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {materias.map((materia) => (
            <LinhaDeMateria
              key={materia.id}
              materia={materia}
              onRenomear={(nome) => renomear(materia.id, nome)}
              onTrocarCor={(cor) => trocarCor(materia.id, cor)}
              onRemover={() => remover(materia.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
