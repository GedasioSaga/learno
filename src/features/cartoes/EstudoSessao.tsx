import { useCallback, useEffect, useRef, useState } from "react";
import { AppError, answerCard, nextCard, type CardRating, type CardToStudy } from "../../lib/ipc";
import { LeitorDeVoz } from "./LeitorDeVoz";
import { MultiplaEscolha } from "./MultiplaEscolha";
import { formatarIntervalo, preverIntervaloDias } from "./previsao";
import { ProcedenciaDoCartao } from "./ProcedenciaDoCartao";
import { RespostaDigitada } from "./RespostaDigitada";
import { useCartoesStore } from "./store";
import { TextoComLacuna, textoDaLacunaParaVoz } from "./TextoComLacuna";

/** Nomes exatos semeados em `src-tauri/src/db/notes.rs` — comparação por nome, nunca por posição. */
const NOME_TIPO_DIGITAR_RESPOSTA = "Digitar a resposta";
const NOME_TIPO_MULTIPLA_ESCOLHA = "Múltipla escolha";

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

type SessaoStatus = "carregando" | "cartao" | "vazio" | "erro";

/** Ordem dos botões de resposta = ordem do teclado (1–4), igual ao contrato de `CardRating`. */
const BOTOES: readonly { rating: CardRating; rotulo: string; tecla: string }[] = [
  { rating: "again", rotulo: "Errei", tecla: "1" },
  { rating: "hard", rotulo: "Difícil", tecla: "2" },
  { rating: "good", rotulo: "Bom", tecla: "3" },
  { rating: "easy", rotulo: "Fácil", tecla: "4" },
];

/**
 * A tela de estudo: frente, revelar, responder. Duas garantias que importam
 * mais que o resto desta tela:
 *
 * 1. O verso só entra no DOM depois que `revelado` vira `true` — é renderização
 *    condicional do React, não CSS escondendo algo que já existe. Não tem como
 *    "piscar" o que ainda não foi montado.
 * 2. `enviandoRef` (não só o estado `enviando`) é o que impede `answerCard` de
 *    disparar duas vezes num duplo clique: dois cliques que caem na mesma
 *    janela de render (antes de o React processar o primeiro `setState`)
 *    ainda chamariam o mesmo `responder` com `enviando` (estado) igual a
 *    `false` nos dois — é exatamente o buraco que uma ref, mutada na hora,
 *    fecha. O estado continua existindo, só para desenhar os botões
 *    desabilitados.
 */
export function EstudoSessao() {
  const deckSelecionadoId = useCartoesStore((state) => state.deckSelecionadoId);
  const noteTypes = useCartoesStore((state) => state.noteTypes);
  const noteTypesStatus = useCartoesStore((state) => state.noteTypesStatus);
  const loadNoteTypes = useCartoesStore((state) => state.loadNoteTypes);
  const refreshAllCounts = useCartoesStore((state) => state.refreshAllCounts);
  const irPara = useCartoesStore((state) => state.irPara);

  const [status, setStatus] = useState<SessaoStatus>("carregando");
  const [atual, setAtual] = useState<CardToStudy | null>(null);
  const [revelado, setRevelado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Só usado por "Múltipla escolha" — qual alternativa o usuário escolheu,
  // controlado aqui (não dentro de `MultiplaEscolha`) porque é o mesmo dado
  // que decide `revelado`.
  const [escolhida, setEscolhida] = useState<string | null>(null);
  const enviandoRef = useRef(false);

  // Nome do tipo, não posição: um `.apkg` importado pode trazer qualquer tipo
  // de nota, e só o nome exato bate com o que `notes.rs` semeia. Tipo
  // desconhecido cai no `else` implícito de `ehDigitarResposta`/
  // `ehMultiplaEscolha` — os dois `false` — e o resto da tela trata isso como
  // o comportamento antigo (frente/verso por posição), que é seguro para um
  // tipo que ninguém aqui conhece.
  //
  // "Ainda carregando" NÃO é a mesma coisa que "desconhecido", e tratá-los
  // igual foi um vazamento de verdade: `loadNoteTypes` e `nextCard` disparam
  // em efeitos independentes, sem ordem garantida, então existe uma janela em
  // que a lista está vazia e um cartão de "Múltipla escolha" já chegou. Nela,
  // `ehMultiplaEscolha` era `false`, o verso genérico entrava no DOM — com a
  // Correta E as três Erradas listadas como se fossem a resposta — e o espaço
  // revelava sem exigir escolha nenhuma. Por isso a tela agora ESPERA os tipos
  // antes de desenhar qualquer coisa do cartão (ver o portão de renderização
  // e a guarda do teclado abaixo): sem saber o tipo, não há resposta certa
  // sobre o que pode aparecer.
  const tiposResolvidos = noteTypesStatus === "ready";
  const tipoDoCartao = atual ? noteTypes.find((noteType) => noteType.id === atual.note.noteTypeId) : undefined;
  const ehDigitarResposta = tipoDoCartao?.name === NOME_TIPO_DIGITAR_RESPOSTA;
  const ehMultiplaEscolha = tipoDoCartao?.name === NOME_TIPO_MULTIPLA_ESCOLHA;

  useEffect(() => {
    void loadNoteTypes();
  }, [loadNoteTypes]);

  const carregarProximo = useCallback(async () => {
    setStatus("carregando");
    setRevelado(false);
    setEscolhida(null);
    setErrorMessage(null);
    try {
      const card = await nextCard(deckSelecionadoId);
      setAtual(card);
      setStatus(card ? "cartao" : "vazio");
    } catch (error) {
      setErrorMessage(messageFor(error, "Não foi possível carregar o próximo cartão."));
      setStatus("erro");
    }
  }, [deckSelecionadoId]);

  useEffect(() => {
    void carregarProximo();
  }, [carregarProximo]);

  const responder = useCallback(
    async (rating: CardRating) => {
      if (!atual || enviandoRef.current) return;
      enviandoRef.current = true;
      setEnviando(true);
      setErrorMessage(null);
      try {
        await answerCard(atual.card.id, rating);
        await refreshAllCounts();
        await carregarProximo();
      } catch (error) {
        setErrorMessage(messageFor(error, "Não foi possível registrar a resposta."));
      } finally {
        enviandoRef.current = false;
        setEnviando(false);
      }
    },
    [atual, refreshAllCounts, carregarProximo],
  );

  useEffect(() => {
    function aoTeclar(event: KeyboardEvent) {
      // `!tiposResolvidos` aqui e não só no portão de renderização: o efeito
      // roda mesmo quando o componente devolve o "Carregando…", então sem
      // esta guarda o espaço marcaria `revelado` durante a janela de corrida
      // e a resposta apareceria já revelada assim que os tipos chegassem.
      if (status !== "cartao" || !tiposResolvidos) return;
      const alvo = event.target;
      // `isContentEditable` junto com as duas tags: a área de edição do editor
      // de blocos é uma `div[contenteditable]` do ProseMirror, não um `input`,
      // e sem isso digitar "1" dentro dela responderia o cartão.
      if (alvo instanceof HTMLElement && (alvo.tagName === "INPUT" || alvo.tagName === "TEXTAREA" || alvo.isContentEditable))
        return;

      // Espaço só revela quando existe o botão "Mostrar resposta" — nos dois
      // tipos novos, revelar sem digitar ou sem escolher furaria o próprio
      // exercício (é exatamente a parte que o tipo existe para forçar).
      if (event.key === " " && !revelado && !ehDigitarResposta && !ehMultiplaEscolha) {
        event.preventDefault();
        setRevelado(true);
        return;
      }

      const botao = BOTOES.find((item) => item.tecla === event.key);
      if (botao && revelado) {
        event.preventDefault();
        void responder(botao.rating);
      }
    }
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [status, revelado, responder, ehDigitarResposta, ehMultiplaEscolha, tiposResolvidos]);

  if (status === "carregando" || noteTypesStatus === "idle" || noteTypesStatus === "loading") {
    return <p className="p-6 text-sm text-ink-muted">Carregando…</p>;
  }

  if (status === "erro" || noteTypesStatus === "error") {
    // Falhar em carregar os tipos não pode virar "estuda como Básico": um
    // cartão de múltipla escolha desenhado como Básico entrega as alternativas
    // erradas junto com a certa. Sem os tipos, a tela para e diz por quê.
    return (
      <div className="p-6">
        <p role="alert" className="text-sm text-terracotta-ink">
          {errorMessage ?? "Não foi possível carregar os tipos de nota, então esta sessão não pode começar."}
        </p>
      </div>
    );
  }

  if (status === "vazio" || !atual) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <h2 className="font-display text-xl text-ink">Nada para estudar agora</h2>
        <p className="max-w-sm text-sm text-ink-muted">Você concluiu a fila de hoje. Volte mais tarde ou crie novos cartões.</p>
        <button
          type="button"
          onClick={() => irPara("resumo")}
          className="mt-2 rounded-sm border border-border bg-surface px-4 py-2 text-sm text-ink transition hover:bg-surface-raised active:scale-97"
        >
          Voltar
        </button>
      </div>
    );
  }

  // A ordem vem com o cartão (`fieldNames`), calculada no backend a partir do
  // tipo de nota — é a fonte certa, e chega sempre. O tipo carregado na store
  // fica como primeira opção só porque é o mesmo dado e evita divergir se o
  // usuário renomear campos com uma sessão aberta; `Object.keys` é o último
  // recurso, e a ordem dele é a de inserção do JSON, não a de exibição.
  //
  // Antes daqui só existir `Object.keys(atual.fields)`: o backend mandava
  // `fields` como LISTA e o TypeScript declarava mapa, então indexar por nome
  // devolvia `undefined` e a tela mostrava "(sem conteúdo)" com o cartão
  // íntegro no banco.
  //
  // A frente continua genérica (primeiro campo da ordem) para os três tipos —
  // "Frente" e "Pergunta" são, cada um, o primeiro campo do próprio tipo em
  // `notes.rs`. O verso é que muda: "Múltipla escolha" não pode herdar o
  // genérico (listaria as erradas como se fossem resposta), então é
  // recalculado abaixo por nome de campo, não por posição.
  const ordemDosCampos = tipoDoCartao?.fields ?? atual.fieldNames ?? Object.keys(atual.fields);
  const [primeiroCampo, ...camposRestantes] = ordemDosCampos;
  const frente = primeiroCampo ? (atual.fields[primeiroCampo] ?? "") : "";
  const versoEsperado = atual.fields["Verso"] ?? "";
  const correta = atual.fields["Correta"] ?? "";
  const erradas = ["Errada 1", "Errada 2", "Errada 3"].map((nome) => atual.fields[nome] ?? "");
  const verso = ehMultiplaEscolha
    ? [{ nome: "Correta", valor: correta }]
    : camposRestantes.map((nome) => ({ nome, valor: atual.fields[nome] ?? "" }));

  // Cloze é o primeiro tipo em que o CONTEÚDO do campo decide o que aparece,
  // e o discriminador é `atual.cloze`, não o nome nem o `kind` da store: o
  // backend só preenche esse campo quando `note_types.kind = 'cloze'` — a
  // mesma coluna que `NoteTypeRow.kind` espelha — e ele chega JUNTO com o
  // cartão, então não existe a janela de corrida que os dois tipos acima
  // tiveram. O parser de `{{cN::...}}` mora só no Rust (`db::cloze`); aqui
  // ninguém interpreta marcação, só percorre a lista pronta.
  //
  // O "Extra" é o resto da ordem (tudo depois do primeiro campo), por posição,
  // como `notes.rs` documenta — o nome pode mudar, a posição não.
  const segmentosCloze = atual.cloze;
  const extraCloze = camposRestantes
    .map((nome) => atual.fields[nome] ?? "")
    .filter((valor) => valor.trim() !== "")
    .join("\n");
  const frenteFalada = segmentosCloze ? textoDaLacunaParaVoz(segmentosCloze, false) : frente;
  const versoTexto = segmentosCloze
    ? [textoDaLacunaParaVoz(segmentosCloze, true), extraCloze].filter((texto) => texto !== "").join(". ")
    : verso.map(({ valor }) => valor).join(". ");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-hairline px-6 py-3 text-xs text-ink-muted">
        <span>{atual.deckName}</span>
        {errorMessage ? (
          <span role="alert" className="text-terracotta-ink">
            {errorMessage}
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-8">
        <div className="w-full max-w-2xl rounded-md border border-border bg-surface p-8 text-center shadow-hard-sm">
          {segmentosCloze ? (
            <TextoComLacuna
              segmentos={segmentosCloze}
              numeroDaLacuna={atual.card.templateOrdinal}
              revelado={revelado}
              extra={extraCloze}
            />
          ) : (
            <p className="whitespace-pre-wrap text-lg text-ink">{frente || "(sem conteúdo)"}</p>
          )}

          <div className="mt-3">
            <ProcedenciaDoCartao note={atual.note} />
          </div>

          {revelado && !segmentosCloze ? (
            <div className="mt-6 border-t border-hairline pt-6 text-left">
              {verso.map(({ nome, valor }) => (
                <div key={nome} className="mb-3 last:mb-0">
                  {verso.length > 1 ? <p className="text-xs uppercase tracking-wide text-ink-muted">{nome}</p> : null}
                  <p className="whitespace-pre-wrap text-base text-ink">{valor || "(sem conteúdo)"}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <LeitorDeVoz deckId={atual.note.deckId} cartaoId={atual.card.id} frente={frenteFalada} verso={versoTexto} revelado={revelado} />

        {ehDigitarResposta ? (
          <div className="w-full max-w-2xl">
            <RespostaDigitada esperado={versoEsperado} revelado={revelado} onEnviar={() => setRevelado(true)} />
          </div>
        ) : ehMultiplaEscolha ? (
          <div className="w-full max-w-2xl">
            <MultiplaEscolha
              correta={correta}
              erradas={erradas}
              cartaoId={atual.card.id}
              escolhida={escolhida}
              onEscolher={(alternativa) => {
                // Quem dá a nota continua sendo o usuário: escolher só revela
                // o verso, não chama `responder` sozinho.
                setEscolhida(alternativa);
                setRevelado(true);
              }}
            />
          </div>
        ) : !revelado ? (
          <button
            type="button"
            onClick={() => setRevelado(true)}
            className="rounded-sm bg-emerald px-6 py-3 text-sm font-medium text-on-emerald transition hover:brightness-110 active:scale-97"
          >
            Mostrar resposta <span className="ml-1 text-xs opacity-75">(espaço)</span>
          </button>
        ) : null}

        {revelado ? (
          <div className="flex w-full max-w-2xl gap-2">
            {BOTOES.map((botao) => (
              <button
                key={botao.rating}
                type="button"
                disabled={enviando}
                onClick={() => void responder(botao.rating)}
                className="flex flex-1 flex-col items-center gap-1 rounded-sm border border-border bg-surface px-2 py-2.5 text-sm text-ink
                  transition hover:bg-surface-raised active:scale-97 disabled:opacity-50 disabled:pointer-events-none"
              >
                <span>
                  {botao.rotulo} <span className="text-xs text-ink-muted">({botao.tecla})</span>
                </span>
                <span className="text-xs text-ink-muted">{formatarIntervalo(preverIntervaloDias(atual.card, botao.rating))}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
