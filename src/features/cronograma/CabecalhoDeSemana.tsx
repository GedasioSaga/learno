import { useRef, useState, type FormEvent } from "react";
import { AppError, semanaDeEstudo, type SemanaDeEstudo } from "../../lib/ipc";
import { inicioDaSemanaLocal, rotuloCurtoDoDia, somarDiasLocal } from "./date-utils";
import { minutosParaHorasTexto } from "./format";
import { useCronogramaStore } from "./store";

const ESTILO_BOTAO_NAV =
  "rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink transition duration-150 ease-out hover:bg-surface-raised active:scale-97";

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/** `YYYY-MM-DD` local -> `Date` à meia-noite local, mesma técnica não-exportada de `date-utils.ts` (nunca `new Date(iso)`, que lê como UTC). Reimplementada aqui porque é a única chamadora — a data que sai do `<input type="date">`. */
function paraDataLocal(dataIso: string): Date {
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  return new Date(ano, mes - 1, dia);
}

/** "1 de setembro de 2026" — mês por extenso, diferente de `rotuloCurtoDoDia` (abreviado): a confirmação de copiar semana precisa ser inequívoca, nunca "tem certeza?". */
function rotuloPorExtenso(dataIso: string): string {
  return new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: "numeric" }).format(paraDataLocal(dataIso));
}

function textoDeContagem(quantidade: number, singular: string, plural: string): string {
  return quantidade === 1 ? `1 ${singular}` : `${quantidade} ${plural}`;
}

function contarBlocos(semana: Pick<SemanaDeEstudo, "dias">): number {
  return semana.dias.reduce((soma, dia) => soma + dia.blocos.length, 0);
}

interface CabecalhoDeSemanaProps {
  semana: SemanaDeEstudo;
}

/**
 * Título da seção, navegação entre semanas e a meta semanal — "Horas na
 * semana 6,5 / 8" da maquete, editável clicando no número.
 */
export function CabecalhoDeSemana({ semana }: CabecalhoDeSemanaProps) {
  const semanaAnterior = useCronogramaStore((state) => state.semanaAnterior);
  const proximaSemana = useCronogramaStore((state) => state.proximaSemana);
  const irParaHoje = useCronogramaStore((state) => state.irParaHoje);

  const minutosRealizados = semana.dias.reduce((soma, dia) => soma + dia.minutosRealizados, 0);
  const fimDaSemana = somarDiasLocal(semana.inicio, 6);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl text-ink">Cronograma</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Semana de {rotuloCurtoDoDia(semana.inicio)} a {rotuloCurtoDoDia(fimDaSemana)}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void semanaAnterior()} className={ESTILO_BOTAO_NAV}>
            ‹ Semana anterior
          </button>
          <button type="button" onClick={() => void irParaHoje()} className={ESTILO_BOTAO_NAV}>
            Hoje
          </button>
          <button type="button" onClick={() => void proximaSemana()} className={ESTILO_BOTAO_NAV}>
            Próxima semana ›
          </button>
        </div>

        <MetaSemanal metaMinutos={semana.metaMinutos} minutosRealizados={minutosRealizados} />
      </div>

      <SemanaModelo semanaAtual={semana} />
    </div>
  );
}

/**
 * O caminho de "semana modelo": copiar os blocos de outra semana para a
 * semana aberta. `copiarSemana` (IPC, ver `lib/ipc.ts`) NÃO é idempotente —
 * chamar duas vezes duplica tudo, e não existe desfazer — por isso a
 * confirmação aqui é o portão de verdade, não cerimônia: mostra quantos
 * blocos vão ser copiados e as duas semanas por extenso, nunca "tem
 * certeza?", e só chama `copiarSemanaModelo` (a store, que já resolve a
 * semana de destino como a atualmente aberta) depois que o usuário confirma
 * esse texto. `window.confirm` está fora de cogitação por pedido explícito
 * da tarefa (o diálogo nativo trava a WebView do Tauri).
 */
function SemanaModelo({ semanaAtual }: { semanaAtual: SemanaDeEstudo }) {
  const copiarSemanaModelo = useCronogramaStore((state) => state.copiarSemanaModelo);
  const [escolhendoOutra, setEscolhendoOutra] = useState(false);
  const [dataEscolhida, setDataEscolhida] = useState("");
  const [carregandoPreview, setCarregandoPreview] = useState(false);
  const [erroPreview, setErroPreview] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState<{ origem: string; blocosNaOrigem: number } | null>(null);
  const [copiando, setCopiando] = useState(false);
  const [erroCopia, setErroCopia] = useState<string | null>(null);

  const blocosNoDestino = contarBlocos(semanaAtual);

  /**
   * Contador de requisição em voo — incrementado a cada chamada de
   * `prepararConfirmacao` e também ao cancelar o formulário de "outra
   * semana". Sem isto, uma resposta tardia de `semanaDeEstudo` (usuário
   * escolheu uma data, clicou "Usar esta semana", mudou de ideia e clicou
   * "Cancelar" antes do fetch voltar) abriria o `alertdialog` de confirmação
   * sozinho, pedindo para copiar uma semana que o usuário já descartou.
   */
  const idDaRequisicaoRef = useRef(0);

  /**
   * Busca quantos blocos `origem` tem ANTES de abrir a confirmação — sem essa
   * contagem o texto de confirmação seria "tem certeza?" com outras
   * palavras. Chama `semanaDeEstudo` direto (não a store: a store só guarda
   * a semana ATUALMENTE aberta, nunca uma arbitrária que o usuário está só
   * cogitando copiar).
   */
  async function prepararConfirmacao(origem: string) {
    const idDaRequisicao = ++idDaRequisicaoRef.current;
    setErroPreview(null);
    setErroCopia(null);
    setCarregandoPreview(true);
    try {
      const semanaOrigem = await semanaDeEstudo(origem);
      // Requisição cancelada (usuário desistiu) enquanto o fetch estava em
      // voo — descarta a resposta em vez de abrir a confirmação.
      if (idDaRequisicaoRef.current !== idDaRequisicao) return;
      setConfirmando({ origem, blocosNaOrigem: contarBlocos(semanaOrigem) });
      setEscolhendoOutra(false);
      setDataEscolhida("");
    } catch (error) {
      if (idDaRequisicaoRef.current !== idDaRequisicao) return;
      setErroPreview(messageFor(error, "Não foi possível verificar a semana escolhida."));
    } finally {
      if (idDaRequisicaoRef.current === idDaRequisicao) setCarregandoPreview(false);
    }
  }

  /**
   * Cancelar o formulário de "outra semana" precisa invalidar o fetch que
   * `handleUsarDataEscolhida` já disparou — ver o comentário de
   * `idDaRequisicaoRef` acima. `setCarregandoPreview(false)` é explícito
   * aqui (não só via `finally` de `prepararConfirmacao`) porque o `finally`
   * vai ver o id já invalidado e pular o próprio `setCarregandoPreview`.
   */
  function cancelarEscolhaDeData() {
    idDaRequisicaoRef.current += 1;
    setEscolhendoOutra(false);
    setCarregandoPreview(false);
    setErroPreview(null);
  }

  function handleCopiarSemanaPassada() {
    void prepararConfirmacao(somarDiasLocal(semanaAtual.inicio, -7));
  }

  function handleUsarDataEscolhida(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (dataEscolhida === "") return;
    void prepararConfirmacao(inicioDaSemanaLocal(paraDataLocal(dataEscolhida)));
  }

  async function handleConfirmar() {
    if (!confirmando) return;
    setCopiando(true);
    setErroCopia(null);
    try {
      await copiarSemanaModelo(confirmando.origem);
      setConfirmando(null);
    } catch (error) {
      setErroCopia(messageFor(error, "Não foi possível copiar a semana modelo."));
    } finally {
      setCopiando(false);
    }
  }

  function handleCancelar() {
    setConfirmando(null);
    setErroCopia(null);
    // `copiarSemanaModelo` (store.ts) também grava o erro em `errorMessage`
    // global, para o banner de `ConteudoDeCronograma.tsx`. O diálogo já
    // mostrava esse texto localmente (`erroCopia` acima); fechar o diálogo
    // sem limpar o global deixava o banner preso na tela até a próxima ação
    // que recarregasse a semana. `setState` é a API pública do zustand — não
    // exige tocar em `store.ts`, que está fora do escopo desta tarefa.
    useCronogramaStore.setState({ errorMessage: null });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={handleCopiarSemanaPassada} disabled={carregandoPreview} className={ESTILO_BOTAO_NAV}>
          Copiar semana passada
        </button>

        {escolhendoOutra ? (
          <form onSubmit={handleUsarDataEscolhida} className="flex items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5 text-ink-muted">
              Copiar a semana que contém
              <input
                type="date"
                value={dataEscolhida}
                onChange={(event) => setDataEscolhida(event.currentTarget.value)}
                required
                className="rounded-sm border border-border bg-paper px-2 py-1 text-ink"
              />
            </label>
            <button
              type="submit"
              disabled={carregandoPreview}
              className="rounded-sm border border-border bg-surface px-2 py-1 text-ink transition duration-150 ease-out hover:bg-surface-raised"
            >
              Usar esta semana
            </button>
            <button
              type="button"
              onClick={cancelarEscolhaDeData}
              className="text-ink-muted transition duration-150 ease-out hover:text-ink"
            >
              Cancelar
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setEscolhendoOutra(true)}
            className="text-sm text-ink-muted underline decoration-dotted underline-offset-2 transition duration-150 ease-out hover:text-ink"
          >
            Copiar de outra semana…
          </button>
        )}

        {carregandoPreview ? <p className="text-xs text-ink-muted">Verificando blocos da semana escolhida…</p> : null}
      </div>

      {erroPreview ? (
        <p role="alert" className="text-xs text-terracotta-ink">
          {erroPreview}
        </p>
      ) : null}

      {confirmando ? (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="titulo-confirmar-semana-modelo"
          className="flex flex-col gap-2 rounded-sm border border-border bg-surface-raised p-3"
        >
          <p id="titulo-confirmar-semana-modelo" className="text-sm text-ink">
            Copiar {textoDeContagem(confirmando.blocosNaOrigem, "bloco", "blocos")} da semana de{" "}
            {rotuloPorExtenso(confirmando.origem)} a {rotuloPorExtenso(somarDiasLocal(confirmando.origem, 6))} para a
            semana de {rotuloPorExtenso(semanaAtual.inicio)} a {rotuloPorExtenso(somarDiasLocal(semanaAtual.inicio, 6))}?
          </p>

          {blocosNoDestino > 0 ? (
            <p className="text-xs text-terracotta-ink">
              A semana de destino já tem {textoDeContagem(blocosNoDestino, "bloco", "blocos")} — o resultado será a
              soma dos dois, não uma substituição.
            </p>
          ) : null}

          {erroCopia ? (
            <p role="alert" className="text-xs text-terracotta-ink">
              {erroCopia}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleCancelar}
              disabled={copiando}
              className="rounded-sm px-2 py-1 text-xs text-ink-muted transition duration-150 ease-out hover:text-ink"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmar()}
              disabled={copiando}
              className="rounded-sm bg-emerald px-2.5 py-1 text-xs font-medium text-on-emerald transition hover:brightness-110 active:scale-97 disabled:opacity-50"
            >
              {copiando ? "Copiando…" : "Copiar"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MetaSemanal({ metaMinutos, minutosRealizados }: { metaMinutos: number; minutosRealizados: number }) {
  const definirMeta = useCronogramaStore((state) => state.definirMeta);
  const [editando, setEditando] = useState(false);
  const [rascunhoEmHoras, setRascunhoEmHoras] = useState(() => minutosParaHorasTexto(metaMinutos));
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  function abrirEdicao() {
    setRascunhoEmHoras(minutosParaHorasTexto(metaMinutos));
    setErro(null);
    setEditando(true);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const horas = Number(rascunhoEmHoras.replace(",", "."));
    if (!Number.isFinite(horas) || horas < 0) {
      setErro("Informe um número de horas válido.");
      return;
    }
    setSalvando(true);
    setErro(null);
    try {
      await definirMeta(Math.round(horas * 60));
      setEditando(false);
    } catch {
      setErro("Não foi possível salvar a meta.");
    } finally {
      setSalvando(false);
    }
  }

  if (editando) {
    return (
      <form onSubmit={(event) => void handleSubmit(event)} className="flex items-center gap-2 text-sm">
        <label className="flex items-center gap-1.5 text-ink-muted">
          Meta da semana (h)
          <input
            type="number"
            min="0"
            step="0.5"
            value={rascunhoEmHoras}
            onChange={(event) => setRascunhoEmHoras(event.currentTarget.value)}
            className="w-16 rounded-sm border border-border bg-paper px-2 py-1 text-ink"
            autoFocus
          />
        </label>
        <button
          type="submit"
          disabled={salvando}
          className="rounded-sm bg-emerald px-2.5 py-1 text-xs font-medium text-on-emerald transition hover:brightness-110 active:scale-97 disabled:opacity-50"
        >
          {salvando ? "Salvando…" : "Salvar"}
        </button>
        <button
          type="button"
          onClick={() => setEditando(false)}
          className="rounded-sm px-2 py-1 text-xs text-ink-muted transition duration-150 ease-out hover:text-ink"
        >
          Cancelar
        </button>
        {erro ? (
          <p role="alert" className="text-xs text-terracotta-ink">
            {erro}
          </p>
        ) : null}
      </form>
    );
  }

  return (
    <button
      type="button"
      onClick={abrirEdicao}
      className="flex items-center gap-2 rounded-sm px-1 py-1 text-sm transition duration-150 ease-out hover:bg-surface-raised"
    >
      <span className="text-ink-muted">Horas na semana</span>
      <span className="font-display text-lg text-ink">
        {minutosParaHorasTexto(minutosRealizados)} / {minutosParaHorasTexto(metaMinutos)}
      </span>
    </button>
  );
}
