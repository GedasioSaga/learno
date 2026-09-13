import { useEffect, useState, type FormEvent } from "react";
import {
  AppError,
  atualizarBloco as ipcAtualizarBloco,
  criarBloco as ipcCriarBloco,
  type AtividadeDoBloco,
} from "../../lib/ipc";
import { ROTULO_DA_ATIVIDADE } from "./format";
import { useCronogramaStore } from "./store";

const ATIVIDADES: readonly AtividadeDoBloco[] = ["pomodoro", "review", "mindmap", "reading", "other"];

/** `HH:MM`, 00-23:00-59 — mesmo formato de `startLocalTime` em `BlocoPlanejado` (lib/ipc.ts). */
const HORARIO_VALIDO = /^([01]\d|2[0-3]):[0-5]\d$/;

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

interface NovoBlocoFormProps {
  /** `YYYY-MM-DD` local do dia em que o bloco entra. */
  dia: string;
  onFechar: () => void;
}

/**
 * O formulário de "+ bloco": atividade, duração, título opcional, matéria
 * (opcional) e horário de início (opcional).
 *
 * MATÉRIA: vem de `useCronogramaStore().materias` (`carregarMaterias` é
 * disparada aqui mesmo — a store já se protege contra recarregar à toa,
 * mesma guarda que `ConteudoDeCronograma` usa para `load()`). Sem nenhuma
 * matéria cadastrada ainda, um `<select>` vazio não levaria a lugar nenhum;
 * em vez disso aparece um campo pra criar a primeira (`criarMateria`, que a
 * store já expõe) e ela nasce pré-selecionada para este bloco. Se
 * `carregarMaterias` falhar (`materiasStatus === "error"`), o `<select>`
 * vazio some do jeito errado — indistinguível de "sem matéria cadastrada" —
 * então esse estado ganha ramo próprio: mensagem de erro da store e um botão
 * pra tentar `carregarMaterias()` de novo.
 *
 * HORÁRIO: `criarBloco` (o contrato de IPC) não recebe horário — só depois
 * de o bloco existir dá pra marcar `startLocalTime` (ver o comentário desse
 * campo em `BlocoPlanejado`, `lib/ipc.ts`). A ação `criarBloco` da STORE
 * também não resolve isso: ela chama o IPC e só recarrega a semana no
 * final, descartando o `BlocoPlanejado` que voltou — sem o id, não dá pra
 * fazer o segundo passo. Por isso, só quando há horário para marcar, este
 * formulário fala com o IPC diretamente (`ipcCriarBloco` +
 * `ipcAtualizarBloco`) e chama `load()` da store à mão para refletir o
 * resultado, em vez de passar pela ação `criarBloco` da store.
 *
 * Se o SEGUNDO passo (`ipcAtualizarBloco`) falhar depois do primeiro ter
 * dado certo, o bloco já existe no backend — sumir com o erro deixaria o
 * usuário sem saber que algo foi criado. Em vez disso: a semana é
 * recarregada (o bloco aparece no balde "Sem horário definido" da grade), o
 * erro deixa explícito que o bloco foi criado e só o horário não foi salvo,
 * os outros campos travam (mudá-los agora não mudaria nada no bloco que já
 * existe) e um novo clique tenta salvar só o horário de novo — sem duplicar
 * o bloco (`blocoPendenteId` guarda o id já criado).
 *
 * Baralho e página continuam de fora (fora de escopo desta rodada, ver o
 * relatório de entrega do `ConteudoDeCronograma`) — só matéria e horário
 * entraram agora.
 */
export function NovoBlocoForm({ dia, onFechar }: NovoBlocoFormProps) {
  const load = useCronogramaStore((state) => state.load);
  const materias = useCronogramaStore((state) => state.materias);
  const materiasStatus = useCronogramaStore((state) => state.materiasStatus);
  // `materiasErrorMessage`, e não o `errorMessage` compartilhado: os dois
  // foram separados justamente porque uma ação de matéria bem-sucedida
  // limpava, em silêncio, um erro de bloco que o usuário ainda não tinha
  // visto. Ler o campo antigo aqui deixava esta mensagem SEMPRE nula, e o
  // motivo real da falha (vindo do backend) era trocado pelo texto genérico
  // logo abaixo — o usuário via "não foi possível" sem nunca saber por quê.
  const mensagemErroMaterias = useCronogramaStore((state) => state.materiasErrorMessage);
  const carregarMaterias = useCronogramaStore((state) => state.carregarMaterias);
  const criarMateria = useCronogramaStore((state) => state.criarMateria);

  const [atividade, setAtividade] = useState<AtividadeDoBloco>("pomodoro");
  const [minutosTexto, setMinutosTexto] = useState("25");
  const [titulo, setTitulo] = useState("");
  const [horario, setHorario] = useState("");
  const [materiaId, setMateriaId] = useState("");
  const [novaMateriaNome, setNovaMateriaNome] = useState("");
  const [criandoMateria, setCriandoMateria] = useState(false);
  // Id do bloco já criado quando só o segundo passo (marcar o horário) falhou
  // — ver o comentário de topo. `null` é o caso comum: nada foi criado ainda.
  const [blocoPendenteId, setBlocoPendenteId] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    void carregarMaterias();
  }, [carregarMaterias]);

  async function handleCriarMateria() {
    const nome = novaMateriaNome.trim();
    if (nome === "") return;
    setCriandoMateria(true);
    try {
      const materia = await criarMateria(nome);
      setMateriaId(materia.id);
      setNovaMateriaNome("");
      setErro(null);
    } catch (error) {
      setErro(messageFor(error, "Não foi possível criar a matéria."));
    } finally {
      setCriandoMateria(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const minutosPlanejados = Number(minutosTexto);
    if (!Number.isFinite(minutosPlanejados) || minutosPlanejados <= 0) {
      setErro("Duração precisa ser maior que zero.");
      return;
    }
    const horarioAparado = horario.trim();
    if (horarioAparado !== "" && !HORARIO_VALIDO.test(horarioAparado)) {
      setErro("Horário inválido. Use o formato HH:MM (ex.: 14:30).");
      return;
    }

    setSalvando(true);
    setErro(null);
    const tituloOuNull = titulo.trim() === "" ? null : titulo.trim();
    const subjectId = materiaId === "" ? null : materiaId;

    let idDoBloco: string;
    try {
      if (blocoPendenteId !== null) {
        // Retentativa: o bloco já existe, só falta o horário — não criar outro.
        idDoBloco = blocoPendenteId;
      } else {
        const blocoCriado = await ipcCriarBloco(dia, atividade, minutosPlanejados, tituloOuNull, null, null, subjectId);
        idDoBloco = blocoCriado.id;
      }
    } catch (error) {
      setErro(messageFor(error, "Não foi possível criar o bloco."));
      setSalvando(false);
      return;
    }

    if (horarioAparado !== "") {
      try {
        await ipcAtualizarBloco(idDoBloco, { startLocalTime: horarioAparado });
      } catch (error) {
        setBlocoPendenteId(idDoBloco);
        await load();
        setErro(
          `O bloco foi criado, mas o horário não foi salvo: ${messageFor(error, "erro desconhecido")}. ` +
            "Clique em Criar de novo para tentar salvar o horário, ou feche e ajuste depois.",
        );
        setSalvando(false);
        return;
      }
    }

    await load();
    onFechar();
  }

  // Só falta o horário de um bloco que já existe: os demais campos não têm
  // mais efeito (o bloco já nasceu com eles), travar evita a falsa impressão
  // de que mudá-los agora ainda muda alguma coisa.
  const travadoPorPendencia = blocoPendenteId !== null;
  const semMateriaCadastrada = materiasStatus === "ready" && materias.length === 0;

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      aria-label="Novo bloco"
      className="flex flex-col gap-1.5 rounded-sm border border-border bg-paper p-2"
    >
      <label className="text-xs">
        <span className="mb-0.5 block text-ink-muted">Atividade</span>
        <select
          value={atividade}
          onChange={(event) =>
            // Seguro: o valor só pode ser um dos `value` das `<option>` abaixo,
            // que são exatamente os literais de `AtividadeDoBloco` em `ATIVIDADES`.
            setAtividade(event.currentTarget.value as AtividadeDoBloco)
          }
          disabled={travadoPorPendencia}
          className="w-full rounded-sm border border-border bg-paper px-2 py-1 text-xs text-ink disabled:opacity-50"
        >
          {ATIVIDADES.map((valor) => (
            <option key={valor} value={valor}>
              {ROTULO_DA_ATIVIDADE[valor]}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs">
        <span className="mb-0.5 block text-ink-muted">Duração (min)</span>
        <input
          type="number"
          min="1"
          value={minutosTexto}
          onChange={(event) => setMinutosTexto(event.currentTarget.value)}
          disabled={travadoPorPendencia}
          className="w-full rounded-sm border border-border bg-paper px-2 py-1 text-xs text-ink disabled:opacity-50"
        />
      </label>

      <label className="text-xs">
        <span className="mb-0.5 block text-ink-muted">Horário de início (opcional)</span>
        <input
          type="text"
          placeholder="HH:MM"
          value={horario}
          onChange={(event) => setHorario(event.currentTarget.value)}
          disabled={travadoPorPendencia}
          className="w-full rounded-sm border border-border bg-paper px-2 py-1 text-xs text-ink disabled:opacity-50"
        />
      </label>

      <label className="text-xs">
        <span className="mb-0.5 block text-ink-muted">Título (opcional)</span>
        <input
          value={titulo}
          onChange={(event) => setTitulo(event.currentTarget.value)}
          disabled={travadoPorPendencia}
          className="w-full rounded-sm border border-border bg-paper px-2 py-1 text-xs text-ink disabled:opacity-50"
        />
      </label>

      <div className="text-xs">
        <span className="mb-0.5 block text-ink-muted">Matéria (opcional)</span>
        {materiasStatus === "error" ? (
          <div className="flex flex-col items-start gap-1">
            <p role="alert" className="text-terracotta-ink">
              {mensagemErroMaterias ?? "Não foi possível carregar as matérias."}
            </p>
            <button
              type="button"
              onClick={() => void carregarMaterias()}
              className="rounded-sm border border-border px-2 py-1 text-xs text-ink-muted transition duration-150 ease-out hover:text-ink"
            >
              Tentar de novo
            </button>
          </div>
        ) : semMateriaCadastrada ? (
          <div className="flex flex-col gap-1">
            <p className="text-ink-muted">Nenhuma matéria ainda.</p>
            <div className="flex gap-1">
              <label className="flex-1">
                <span className="sr-only">Nome da nova matéria</span>
                <input
                  value={novaMateriaNome}
                  onChange={(event) => setNovaMateriaNome(event.currentTarget.value)}
                  placeholder="Nome da matéria"
                  disabled={travadoPorPendencia}
                  className="w-full rounded-sm border border-border bg-paper px-2 py-1 text-xs text-ink disabled:opacity-50"
                />
              </label>
              <button
                type="button"
                onClick={() => void handleCriarMateria()}
                disabled={criandoMateria || novaMateriaNome.trim() === "" || travadoPorPendencia}
                className="shrink-0 rounded-sm border border-border px-2 py-1 text-xs text-ink-muted transition duration-150 ease-out hover:text-ink disabled:opacity-50"
              >
                {criandoMateria ? "Criando…" : "Criar matéria"}
              </button>
            </div>
          </div>
        ) : (
          <select
            value={materiaId}
            onChange={(event) => setMateriaId(event.currentTarget.value)}
            disabled={materiasStatus === "loading" || travadoPorPendencia}
            aria-label="Matéria (opcional)"
            className="w-full rounded-sm border border-border bg-paper px-2 py-1 text-xs text-ink disabled:opacity-50"
          >
            <option value="">Nenhuma</option>
            {materias.map((materia) => (
              <option key={materia.id} value={materia.id}>
                {materia.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {erro ? (
        <p role="alert" className="text-xs text-terracotta-ink">
          {erro}
        </p>
      ) : null}

      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onFechar}
          className="rounded-sm px-2 py-1 text-xs text-ink-muted transition duration-150 ease-out hover:text-ink"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={salvando}
          className="rounded-sm bg-emerald px-2.5 py-1 text-xs font-medium text-on-emerald transition hover:brightness-110 active:scale-97 disabled:opacity-50"
        >
          {salvando ? "Salvando…" : travadoPorPendencia ? "Salvar horário" : "Criar"}
        </button>
      </div>
    </form>
  );
}
