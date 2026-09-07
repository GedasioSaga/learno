import { useEffect, useId, useState, type ReactNode } from "react";
import {
  AppError,
  getDeckSchedulingOptions,
  setDeckSchedulingOptions,
  type AgendadorDeBaralho,
} from "../../lib/ipc";
import {
  PESOS_PADRAO_FSRS6,
  RETENCAO_ALERTA_PCT,
  formatarPesos,
  opcoesDoRascunho,
  rascunhoDeOpcoes,
  type CampoDoRascunho,
  type ErrosDoRascunho,
  type RascunhoDeOpcoes,
} from "./opcoes-de-baralho";
import { useCartoesStore } from "./store";
import { displayDeckName } from "./tree-utils";

/**
 * Opções de UM baralho: qual agendador os cartões novos recebem (SM-2 ou
 * FSRS) e os números de estudo que o backend de fato lê (`OpcoesDeDeckJson`).
 *
 * Esta tela existe porque `decks.options` era configurável no backend e
 * nenhum pixel do app deixava o usuário mexer — a mesma família de defeito
 * de `saveDataDir` sem chamador (`DataFolderSection`). O que o backend NÃO
 * tem fica de fora de propósito: limite diário de cartões, otimizador de
 * parâmetros e simulador não existem, então não há controle prometendo-os.
 *
 * Duas verdades do backend que a tela conta antes do clique, não depois:
 *
 * 1. Trocar o agendador não migra cartão nenhum — cartão que já existe
 *    termina a vida no agendador em que nasceu (`db::cards::answer_card`).
 *    Sem o aviso, o usuário troca, não vê diferença e conclui que quebrou.
 * 2. Não há otimizador: os 21 pesos são os padrões do FSRS-6, e o único
 *    caminho para outros é colar os que o Anki otimizou.
 *
 * Salvar é explícito (não há autosave): a troca de agendador merece um
 * momento em que o usuário lê o aviso e decide.
 */
type Status =
  | { kind: "carregando" }
  | { kind: "pronto" }
  | { kind: "salvando" }
  | { kind: "salvo" }
  | { kind: "erro"; mensagem: string };

const NOME_DO_AGENDADOR: Record<AgendadorDeBaralho, string> = { sm2: "SM-2", fsrs: "FSRS" };

const AGENDADORES: readonly { id: AgendadorDeBaralho; descricao: string }[] = [
  {
    id: "sm2",
    descricao: "O algoritmo clássico do Anki. Cada cartão carrega um fator de facilidade que sobe ou desce conforme a resposta.",
  },
  {
    id: "fsrs",
    descricao:
      "Padrão do Anki desde a versão 23.10. Modela a memória com estabilidade, dificuldade e recuperabilidade, e chega à mesma retenção com 20 a 30 % menos revisões.",
  },
];

/** Anexado à ajuda dos campos que só o SM-2 lê, enquanto o FSRS está escolhido. */
const IGNORADO_PELO_FSRS = "O FSRS não usa este valor.";

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

export function OpcoesDoBaralho() {
  const deckSelecionadoId = useCartoesStore((state) => state.deckSelecionadoId);
  const decksById = useCartoesStore((state) => state.decksById);
  const irPara = useCartoesStore((state) => state.irPara);

  const [status, setStatus] = useState<Status>({ kind: "carregando" });
  const [salvas, setSalvas] = useState<RascunhoDeOpcoes | null>(null);
  const [rascunho, setRascunho] = useState<RascunhoDeOpcoes | null>(null);
  const [erros, setErros] = useState<ErrosDoRascunho>({});
  const [pesosAbertos, setPesosAbertos] = useState(false);
  const grupoDoAgendador = useId();
  const prefixo = useId();

  useEffect(() => {
    if (deckSelecionadoId === null) return;
    let cancelado = false;
    setStatus({ kind: "carregando" });
    setRascunho(null);
    setSalvas(null);
    setErros({});

    getDeckSchedulingOptions(deckSelecionadoId)
      .then((opcoes) => {
        if (cancelado) return;
        const inicial = rascunhoDeOpcoes(opcoes);
        setSalvas(inicial);
        setRascunho(inicial);
        // Quem já colou parâmetros próprios quer vê-los; quem está no padrão
        // não precisa de 21 números na cara.
        setPesosAbertos(inicial.fsrsPesos !== formatarPesos(PESOS_PADRAO_FSRS6));
        setStatus({ kind: "pronto" });
      })
      .catch((erro: unknown) => {
        if (cancelado) return;
        setStatus({ kind: "erro", mensagem: messageFor(erro, "Não foi possível carregar as opções do baralho.") });
      });

    return () => {
      cancelado = true;
    };
  }, [deckSelecionadoId]);

  const deck = deckSelecionadoId === null ? undefined : decksById.get(deckSelecionadoId);

  const alterado = rascunho !== null && salvas !== null && JSON.stringify(rascunho) !== JSON.stringify(salvas);
  const agendadorMudou = rascunho !== null && salvas !== null && rascunho.agendador !== salvas.agendador;

  function voltar() {
    if (alterado && !window.confirm("Descartar as alterações que ainda não foram salvas?")) return;
    irPara("resumo");
  }

  function alterar(campo: CampoDoRascunho, valor: string) {
    setRascunho((atual) => (atual ? { ...atual, [campo]: valor } : atual));
    setErros((atuais) => {
      if (!(campo in atuais)) return atuais;
      const proximos = { ...atuais };
      delete proximos[campo];
      return proximos;
    });
    limparFeedback();
  }

  function escolherAgendador(agendador: AgendadorDeBaralho) {
    setRascunho((atual) => (atual ? { ...atual, agendador } : atual));
    limparFeedback();
  }

  function alternarFuzz(fuzz: boolean) {
    setRascunho((atual) => (atual ? { ...atual, fuzz } : atual));
    limparFeedback();
  }

  /** "Opções salvas." ou o erro da última tentativa somem na primeira edição seguinte. */
  function limparFeedback() {
    setStatus((atual) => (atual.kind === "salvo" || atual.kind === "erro" ? { kind: "pronto" } : atual));
  }

  async function salvar() {
    if (rascunho === null || deckSelecionadoId === null) return;
    const resultado = opcoesDoRascunho(rascunho);
    if (!resultado.ok) {
      setErros(resultado.erros);
      return;
    }
    setStatus({ kind: "salvando" });
    try {
      await setDeckSchedulingOptions(deckSelecionadoId, resultado.opcoes);
      // O que fica na tela é o que foi gravado, já normalizado ("1, 10" vira
      // "1 10"), para o rascunho e o salvo voltarem a ser iguais.
      const gravado = rascunhoDeOpcoes(resultado.opcoes);
      setSalvas(gravado);
      setRascunho(gravado);
      setStatus({ kind: "salvo" });
    } catch (erro: unknown) {
      setStatus({ kind: "erro", mensagem: messageFor(erro, "Não foi possível salvar as opções.") });
    }
  }

  if (deck === undefined) {
    return (
      <Moldura onVoltar={voltar} titulo="Opções do baralho">
        <p className="mt-2 max-w-[var(--measure)] text-sm text-ink-muted">
          Cada baralho tem a sua configuração. Escolha um na lista à esquerda para ver as opções dele —
          "Todos os baralhos" é a coleção inteira, não um baralho.
        </p>
      </Moldura>
    );
  }

  const nomeDoBaralho = displayDeckName(deck);

  if (rascunho === null) {
    return (
      <Moldura onVoltar={voltar} titulo={nomeDoBaralho}>
        {status.kind === "erro" ? (
          <p role="alert" className="mt-3 text-sm text-terracotta-ink">
            {status.mensagem}
          </p>
        ) : (
          <p className="mt-3 text-sm text-ink-muted">Carregando opções…</p>
        )}
      </Moldura>
    );
  }

  const fsrs = rascunho.agendador === "fsrs";
  const retencaoDigitada = Number(rascunho.fsrsRetencaoPct);
  const retencaoAlta = Number.isFinite(retencaoDigitada) && retencaoDigitada > RETENCAO_ALERTA_PCT;
  const pesosSaoOsPadroes = rascunho.fsrsPesos === formatarPesos(PESOS_PADRAO_FSRS6);
  const idPesos = `${prefixo}-pesos`;
  const idFuzz = `${prefixo}-fuzz`;

  /** Ajuda de um campo que só o SM-2 lê: ganha a nota quando o FSRS está escolhido. */
  function soSm2(texto: string): string {
    return fsrs ? `${texto} ${IGNORADO_PELO_FSRS}` : texto;
  }

  function campo(nome: CampoDoRascunho) {
    return {
      id: `${prefixo}-${nome}`,
      valor: rascunho === null ? "" : rascunho[nome],
      erro: erros[nome],
      onChange: (valor: string) => alterar(nome, valor),
    };
  }

  return (
    <Moldura onVoltar={voltar} titulo={nomeDoBaralho} subtitulo="Como este baralho agenda as revisões.">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void salvar();
        }}
        noValidate
      >
        <fieldset className="mt-8">
          <legend className="font-display text-lg text-ink">Agendador</legend>
          <p className="mt-1 max-w-[var(--measure)] text-sm text-ink-muted">Qual algoritmo decide quando cada cartão volta.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {AGENDADORES.map((opcao) => {
              const selecionada = rascunho.agendador === opcao.id;
              return (
                <label
                  key={opcao.id}
                  className={[
                    "cursor-pointer rounded-md border p-4 transition-[border-color,background-color] duration-150 ease-out motion-reduce:transition-none",
                    selecionada ? "border-emerald bg-surface-sunken" : "border-border bg-surface hover:border-ink-muted",
                  ].join(" ")}
                >
                  <input
                    type="radio"
                    name={grupoDoAgendador}
                    value={opcao.id}
                    checked={selecionada}
                    onChange={() => escolherAgendador(opcao.id)}
                    className="sr-only"
                  />
                  <span className="block text-sm font-medium text-ink">{NOME_DO_AGENDADOR[opcao.id]}</span>
                  <span className="mt-1 block text-sm text-ink-muted">{opcao.descricao}</span>
                </label>
              );
            })}
          </div>
          <p
            role={agendadorMudou ? "status" : undefined}
            className={["mt-3 max-w-[var(--measure)] text-sm", agendadorMudou ? "text-amber-ink" : "text-ink-muted"].join(" ")}
          >
            {agendadorMudou && salvas !== null
              ? `Ao salvar, só os cartões criados daqui em diante nascem no ${NOME_DO_AGENDADOR[rascunho.agendador]}. Os cartões que já existem continuam no ${NOME_DO_AGENDADOR[salvas.agendador]} até o fim — nada é migrado, e eles não vão parecer diferentes.`
              : "Trocar de agendador vale só para cartões criados depois da troca. Os cartões que já existem terminam a vida no agendador em que nasceram."}
          </p>
        </fieldset>

        {fsrs ? (
          <Secao titulo="FSRS">
            <Campo
              {...campo("fsrsRetencaoPct")}
              rotulo="Retenção desejada"
              unidade="%"
              ajuda="Proporção de cartões que você quer acertar quando vencem. Mais alto: intervalos mais curtos e mais revisões por dia."
              aviso={retencaoAlta ? `Acima de ${RETENCAO_ALERTA_PCT} % a carga diária de revisões cresce muito para um ganho pequeno.` : undefined}
            />
            <div className="py-3">
              <details open={pesosAbertos} onToggle={(event) => setPesosAbertos(event.currentTarget.open)}>
                <summary className="cursor-pointer text-sm text-ink-muted transition-colors duration-150 ease-out motion-reduce:transition-none hover:text-ink">
                  Parâmetros do modelo
                </summary>
                <p id={`${idPesos}-ajuda`} className="mt-2 max-w-[var(--measure)] text-xs text-ink-muted">
                  Os 21 pesos do FSRS-6. O Learno não tem otimizador: se você já otimizou parâmetros para este material
                  no Anki, cole-os aqui (separados por espaço ou vírgula, decimal com ponto). Senão, os padrões servem
                  bem.
                </p>
                <label htmlFor={idPesos} className="sr-only">
                  Parâmetros do FSRS
                </label>
                <textarea
                  id={idPesos}
                  rows={3}
                  value={rascunho.fsrsPesos}
                  onChange={(event) => alterar("fsrsPesos", event.currentTarget.value)}
                  aria-invalid={erros.fsrsPesos ? true : undefined}
                  aria-describedby={erros.fsrsPesos ? `${idPesos}-ajuda ${idPesos}-erro` : `${idPesos}-ajuda`}
                  className={[
                    "mt-2 w-full rounded-sm border bg-surface-sunken px-2 py-1.5 text-sm tabular-nums text-ink",
                    erros.fsrsPesos ? "border-terracotta" : "border-border",
                  ].join(" ")}
                />
                {erros.fsrsPesos ? (
                  <p id={`${idPesos}-erro`} className="mt-1 text-xs text-terracotta-ink">
                    {erros.fsrsPesos}
                  </p>
                ) : null}
                <button
                  type="button"
                  onClick={() => alterar("fsrsPesos", formatarPesos(PESOS_PADRAO_FSRS6))}
                  disabled={pesosSaoOsPadroes}
                  className="mt-2 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink transition hover:bg-surface-raised active:scale-97 disabled:opacity-50 disabled:pointer-events-none"
                >
                  Usar padrões do FSRS-6
                </button>
              </details>
            </div>
          </Secao>
        ) : null}

        <Secao titulo="Cartões novos">
          <Campo
            {...campo("learningSteps")}
            rotulo="Passos de aprendizagem"
            unidade="min"
            lista
            ajuda="Minutos entre cada passo antes de um cartão novo graduar. Vazio gradua na primeira resposta."
          />
          <Campo
            {...campo("graduatingInterval")}
            rotulo="Intervalo de graduação"
            unidade="dias"
            ajuda={soSm2("Dias até a próxima revisão ao responder Bom no último passo.")}
          />
          <Campo
            {...campo("easyInterval")}
            rotulo="Intervalo fácil"
            unidade="dias"
            ajuda={soSm2("Dias ao responder Fácil durante a aprendizagem; pula os passos que faltam.")}
          />
        </Secao>

        <Secao titulo="Lapsos">
          <Campo
            {...campo("relearningSteps")}
            rotulo="Passos de reaprendizagem"
            unidade="min"
            lista
            ajuda="Minutos de cada passo depois de errar um cartão já graduado."
          />
          <Campo
            {...campo("lapseNewIntervalPct")}
            rotulo="Novo intervalo"
            unidade="%"
            ajuda={soSm2("Quanto do intervalo anterior sobra depois de um erro. 0 recomeça do zero.")}
          />
          <Campo
            {...campo("minimumInterval")}
            rotulo="Intervalo mínimo"
            unidade="dias"
            ajuda={soSm2("Piso do intervalo depois de um erro.")}
          />
          <Campo
            {...campo("leechThreshold")}
            rotulo="Limiar de leech"
            unidade="erros"
            ajuda={soSm2("Erros até o cartão ser marcado como leech. 0 desliga a marcação.")}
          />
        </Secao>

        <Secao titulo="Avançado">
          <Campo
            {...campo("maximumInterval")}
            rotulo="Intervalo máximo"
            unidade="dias"
            ajuda="Teto de qualquer intervalo. 36500 é o padrão, cerca de 100 anos."
          />
          <Campo
            {...campo("easyBonusPct")}
            rotulo="Bônus fácil"
            unidade="%"
            ajuda={soSm2("Multiplicador extra ao responder Fácil numa revisão. 130 = intervalo × 1,3.")}
          />
          <Campo
            {...campo("hardIntervalPct")}
            rotulo="Multiplicador hard"
            unidade="%"
            ajuda={soSm2("Multiplicador ao responder Difícil numa revisão. 120 = intervalo × 1,2.")}
          />
          <div className="py-3">
            <label htmlFor={idFuzz} className="flex cursor-pointer items-center justify-between gap-6 py-1 text-sm text-ink">
              Variação aleatória do intervalo
              <input
                id={idFuzz}
                type="checkbox"
                checked={rascunho.fuzz}
                onChange={(event) => alternarFuzz(event.currentTarget.checked)}
                className="size-4 accent-emerald"
              />
            </label>
            <p className="mt-1 max-w-[var(--measure)] text-xs text-ink-muted">
              Espalha um pouco cada intervalo para cartões criados juntos não vencerem sempre no mesmo dia.
            </p>
          </div>
        </Secao>

        <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-hairline pt-6">
          <button
            type="submit"
            disabled={!alterado || status.kind === "salvando"}
            className="rounded-sm bg-emerald px-5 py-2.5 text-sm font-medium text-on-emerald transition hover:brightness-110 active:scale-97 disabled:opacity-50 disabled:pointer-events-none"
          >
            Salvar opções
          </button>
          {status.kind === "salvando" ? <span className="text-sm text-ink-muted">Salvando…</span> : null}
          {status.kind === "salvo" ? (
            <span role="status" className="text-sm text-mint-ink">
              Opções salvas.
            </span>
          ) : null}
          {status.kind === "erro" ? (
            <span role="alert" className="text-sm text-terracotta-ink">
              {status.mensagem}
            </span>
          ) : null}
        </div>
      </form>
    </Moldura>
  );
}

/** Cabeçalho comum aos três estados da tela (sem baralho, carregando, editando). */
function Moldura({
  titulo,
  subtitulo,
  onVoltar,
  children,
}: {
  titulo: string;
  subtitulo?: string;
  onVoltar: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <button
        type="button"
        onClick={onVoltar}
        className="-ml-2 rounded-sm px-2 py-2 text-sm text-ink-muted transition-colors duration-150 ease-out motion-reduce:transition-none hover:text-ink"
      >
        Voltar ao baralho
      </button>
      <h2 className="mt-3 font-display text-2xl text-ink">{titulo}</h2>
      {subtitulo ? <p className="mt-1 text-sm text-ink-muted">{subtitulo}</p> : null}
      {children}
    </div>
  );
}

function Secao({ titulo, children }: { titulo: string; children: ReactNode }) {
  const idTitulo = useId();
  return (
    <section aria-labelledby={idTitulo} className="mt-8 border-t border-hairline pt-6">
      <h3 id={idTitulo} className="font-display text-lg text-ink">
        {titulo}
      </h3>
      <div className="mt-2 divide-y divide-hairline">{children}</div>
    </section>
  );
}

interface CampoProps {
  id: string;
  rotulo: string;
  valor: string;
  onChange: (valor: string) => void;
  unidade: string;
  ajuda: string;
  erro?: string;
  /** Alerta não-bloqueante (valor válido, mas com consequência que vale avisar). */
  aviso?: string;
  /** Lista de números (passos): campo largo e alinhado à esquerda. */
  lista?: boolean;
}

/**
 * Uma linha rótulo + campo + unidade, com ajuda embaixo e o erro logo abaixo
 * do campo (`aria-describedby`, `border-terracotta`), como o contrato manda.
 * `type="text"` com `inputMode="numeric"` em vez de `type="number"`: o campo
 * numérico nativo muda de valor com a roda do mouse e não sabe ficar vazio
 * enquanto o usuário redigita.
 */
function Campo({ id, rotulo, valor, onChange, unidade, ajuda, erro, aviso, lista = false }: CampoProps) {
  const idAjuda = `${id}-ajuda`;
  const idErro = `${id}-erro`;
  const idAviso = `${id}-aviso`;
  const descritoPor = [idAjuda, erro ? idErro : null, aviso ? idAviso : null].filter(Boolean).join(" ");

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
        <label htmlFor={id} className="text-sm text-ink">
          {rotulo}
        </label>
        <span className="flex items-center gap-2">
          <input
            id={id}
            type="text"
            inputMode={lista ? "text" : "numeric"}
            value={valor}
            onChange={(event) => onChange(event.currentTarget.value)}
            aria-invalid={erro ? true : undefined}
            aria-describedby={descritoPor}
            className={[
              "rounded-sm border bg-surface-sunken px-2 py-1.5 text-sm tabular-nums text-ink",
              lista ? "w-44" : "w-24 text-right",
              erro ? "border-terracotta" : "border-border",
            ].join(" ")}
          />
          <span className="w-12 text-sm text-ink-muted">{unidade}</span>
        </span>
      </div>
      <p id={idAjuda} className="mt-1 max-w-[var(--measure)] text-xs text-ink-muted">
        {ajuda}
      </p>
      {aviso ? (
        <p id={idAviso} className="mt-1 max-w-[var(--measure)] text-xs text-amber-ink">
          {aviso}
        </p>
      ) : null}
      {erro ? (
        <p id={idErro} className="mt-1 text-xs text-terracotta-ink">
          {erro}
        </p>
      ) : null}
    </div>
  );
}
