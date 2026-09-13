import { useEffect, useRef, useState } from "react";
import {
  criarPaginaDeLivro,
  escreverConteudoDaPagina,
  listarPaginasDoLivro,
  moverPaginaDeLivro,
  removerPaginaDeLivro,
  renomearPaginaDeLivro,
  type PaginaDeLivro,
} from "../../../lib/ipc";

interface PainelDePaginasProps {
  livroId: string;
}

/**
 * Espera depois da última tecla antes de gravar o conteúdo (regra 4 do
 * pedido desta rodada: "salvar sem perder"). Curto o bastante para que
 * fechar o livro logo depois de digitar raramente perca alguma coisa; longo
 * o bastante para não disparar uma chamada de IPC a cada letra. `onBlur` e o
 * desmonte do item (ver `ItemDePagina`) gravam na hora, sem esperar isto —
 * este intervalo só cobre o caso de o usuário continuar digitando.
 */
const ESPERA_ENTRE_TECLAS_MS = 1000;

const CAMPO_INLINE = "min-w-0 flex-1 rounded-sm border border-border bg-paper px-2 py-1 text-sm text-ink";

/**
 * `AppError` (ver `lib/ipc.ts`) já carrega `.message` pronto pro usuário, mas
 * nem todo erro passa por `call()` — uma falha de rede antes do `invoke`
 * chegar, por exemplo, rejeita com um `Error` comum. Um fallback genérico
 * cobre os dois sem exigir checar `instanceof AppError` especificamente.
 */
function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  return "Algo deu errado. Tente de novo.";
}

/**
 * Campo de nome que mora NA linha — mesmo raciocínio de `CampoDeNomeInline`
 * em `PainelDeBiblioteca.tsx` (Enter confirma, Escape cancela, blur
 * confirma): esse componente não é exportado de lá (e aquele arquivo está
 * fora do escopo desta rodada), então o padrão é reproduzido aqui, usado
 * duas vezes neste arquivo (criar página, renomear página).
 */
interface CampoDeNomeInlineProps {
  rotulo: string;
  placeholder?: string;
  valorInicial: string;
  /** Nome vazio fecha o campo em silêncio (tratado como "desistiu"), nunca chega ao IPC. Erro do backend mantém o campo aberto — quem chama mostra a mensagem. */
  onConfirmar: (nome: string) => Promise<boolean>;
  onCancelar: () => void;
}

function CampoDeNomeInline({ rotulo, placeholder, valorInicial, onConfirmar, onCancelar }: CampoDeNomeInlineProps) {
  const [valor, setValor] = useState(valorInicial);
  const inputRef = useRef<HTMLInputElement>(null);
  // Depois que o campo fechou, um blur atrasado do desmonte não pode
  // confirmar de novo; e enquanto uma confirmação está em voo, Enter
  // repetido não dispara uma segunda.
  const fechadoRef = useRef(false);
  const emVooRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function confirmar() {
    if (fechadoRef.current || emVooRef.current) return;
    emVooRef.current = true;
    try {
      const fechou = await onConfirmar(valor.trim());
      if (fechou) fechadoRef.current = true;
    } finally {
      emVooRef.current = false;
    }
  }

  function cancelar() {
    if (fechadoRef.current) return;
    fechadoRef.current = true;
    onCancelar();
  }

  return (
    <input
      ref={inputRef}
      value={valor}
      onChange={(event) => setValor(event.currentTarget.value)}
      onBlur={() => void confirmar()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void confirmar();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelar();
        }
      }}
      aria-label={rotulo}
      placeholder={placeholder}
      className={CAMPO_INLINE}
    />
  );
}

/**
 * Painel de páginas do livro, irmão de `PainelDeAnotacoes` na mesma barra
 * lateral do leitor — mesmo tom visual, mesma forma de props "dirigido de
 * fora" (só `livroId`). Substitui a antiga lista automática de capítulos do
 * sumário: aqui é o usuário quem cria cada página, com o nome que quiser, e
 * escreve dentro — nada é extraído do livro.
 *
 * Autocontido de propósito: busca as páginas sozinho (`listarPaginasDoLivro`)
 * a partir de `livroId` — quem monta este painel no leitor não precisa saber
 * que página de livro existe no contrato de IPC.
 */
export function PainelDePaginas({ livroId }: PainelDePaginasProps) {
  const [paginas, setPaginas] = useState<PaginaDeLivro[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erroDeCarga, setErroDeCarga] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);
  const [erroDeCriacao, setErroDeCriacao] = useState<string | null>(null);
  const [erroDeOrdem, setErroDeOrdem] = useState<string | null>(null);
  // Só uma página escrevível por vez — o painel é estreito demais para várias
  // caixas de texto abertas ao mesmo tempo (mesmo raciocínio de "capítulo
  // atual" da versão anterior, agora dirigido pelo clique do usuário em vez
  // da posição de leitura).
  const [paginaAbertaId, setPaginaAbertaId] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    setCarregando(true);
    setErroDeCarga(null);

    listarPaginasDoLivro(livroId)
      .then((lista) => {
        if (!cancelado) setPaginas(lista);
      })
      .catch((erro: unknown) => {
        if (!cancelado) setErroDeCarga(mensagemDeErro(erro));
      })
      .finally(() => {
        if (!cancelado) setCarregando(false);
      });

    return () => {
      cancelado = true;
    };
  }, [livroId]);

  function aoAtualizarPagina(pagina: PaginaDeLivro) {
    setPaginas((atual) => atual.map((p) => (p.id === pagina.id ? pagina : p)));
  }

  function aoRemoverPagina(id: string) {
    setPaginas((atual) => atual.filter((p) => p.id !== id));
    setPaginaAbertaId((atual) => (atual === id ? null : atual));
  }

  async function confirmarCriacao(titulo: string): Promise<boolean> {
    if (titulo === "") {
      setCriando(false);
      return true;
    }
    try {
      const nova = await criarPaginaDeLivro(livroId, titulo);
      setPaginas((atual) => [...atual, nova]);
      setCriando(false);
      setErroDeCriacao(null);
      // Abre a página recém-criada direto para escrita — o pedido do usuário
      // é "criar e escrever dentro", não criar e caçar o botão de abrir de novo.
      setPaginaAbertaId(nova.id);
      return true;
    } catch (erro) {
      setErroDeCriacao(mensagemDeErro(erro));
      return false;
    }
  }

  /**
   * Troca a página do `indice` de lugar com a vizinha (cima ou baixo) — não
   * existe "mover N posições", só o vizinho adjacente, e é o suficiente para
   * reordenar por teclado sem depender de arrastar. Otimista: a lista muda
   * na hora, e desfaz sozinha se o IPC falhar — sem isso, cada tecla teria
   * que esperar a viagem de rede antes de mostrar qualquer coisa.
   */
  async function mover(indice: number, direcao: "cima" | "baixo") {
    const alvo = direcao === "cima" ? indice - 1 : indice + 1;
    if (alvo < 0 || alvo >= paginas.length) return;

    const anterior = paginas;
    const reordenado = [...paginas];
    const tmp = reordenado[indice];
    reordenado[indice] = reordenado[alvo];
    reordenado[alvo] = tmp;
    setPaginas(reordenado);
    setErroDeOrdem(null);

    const paginaMovida = anterior[indice];
    const novoIndice = reordenado.findIndex((p) => p.id === paginaMovida.id);
    const aposId = novoIndice > 0 ? reordenado[novoIndice - 1].id : null;

    try {
      const atualizado = await moverPaginaDeLivro(paginaMovida.id, aposId);
      setPaginas((atual) => atual.map((p) => (p.id === atualizado.id ? atualizado : p)));
    } catch (erro) {
      setPaginas(anterior);
      setErroDeOrdem(mensagemDeErro(erro));
    }
  }

  if (carregando) {
    return <p className="px-3 py-3 text-xs text-ink-muted">Carregando páginas…</p>;
  }

  if (erroDeCarga) {
    return (
      <p role="alert" className="px-3 py-3 text-xs text-terracotta-ink">
        {erroDeCarga}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 px-2 py-2">
      {paginas.length === 0 && !criando ? (
        <p className="px-1 text-xs text-ink-muted">
          Nenhuma página ainda. Crie uma para escrever o que quiser sobre este livro.
        </p>
      ) : null}

      {paginas.length > 0 ? (
        <ul aria-label="Páginas do livro" className="flex flex-col gap-1 overflow-y-auto">
          {paginas.map((pagina, indice) => (
            <li key={pagina.id}>
              <ItemDePagina
                pagina={pagina}
                aberta={pagina.id === paginaAbertaId}
                podeMoverParaCima={indice > 0}
                podeMoverParaBaixo={indice < paginas.length - 1}
                onAlternarAbertura={() => setPaginaAbertaId((atual) => (atual === pagina.id ? null : pagina.id))}
                onAtualizar={aoAtualizarPagina}
                onRemover={aoRemoverPagina}
                onMoverParaCima={() => void mover(indice, "cima")}
                onMoverParaBaixo={() => void mover(indice, "baixo")}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {erroDeOrdem ? (
        <p role="alert" className="px-1 text-xs text-terracotta-ink">
          {erroDeOrdem}
        </p>
      ) : null}

      {criando ? (
        <div className="flex flex-col gap-1 px-1">
          <CampoDeNomeInline
            rotulo="Nome da nova página"
            placeholder="Nome da página"
            valorInicial=""
            onConfirmar={confirmarCriacao}
            onCancelar={() => setCriando(false)}
          />
          {erroDeCriacao ? (
            <p role="alert" className="text-xs text-terracotta-ink">
              {erroDeCriacao}
            </p>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setErroDeCriacao(null);
            setCriando(true);
          }}
          className="self-start rounded-sm px-1 py-1 text-xs text-ink-muted hover:text-ink"
        >
          + Nova página
        </button>
      )}
    </div>
  );
}

interface ItemDePaginaProps {
  pagina: PaginaDeLivro;
  aberta: boolean;
  podeMoverParaCima: boolean;
  podeMoverParaBaixo: boolean;
  onAlternarAbertura: () => void;
  onAtualizar: (pagina: PaginaDeLivro) => void;
  onRemover: (id: string) => void;
  onMoverParaCima: () => void;
  onMoverParaBaixo: () => void;
}

type StatusDeSalvamento = "ocioso" | "salvando" | "salvo" | "erro";

/**
 * Uma linha da lista: título (com renomear inline) + botões de mover +
 * remover, e — quando aberta — a caixa de texto livre onde o usuário
 * escreve. `ItemDeCapitulo` (a versão anterior) inspirou a forma geral, mas
 * aqui não existe "capítulo atual" nem formulário de edição único: é sempre
 * a mesma caixa, salvando sozinha enquanto o usuário digita.
 */
function ItemDePagina({
  pagina,
  aberta,
  podeMoverParaCima,
  podeMoverParaBaixo,
  onAlternarAbertura,
  onAtualizar,
  onRemover,
  onMoverParaCima,
  onMoverParaBaixo,
}: ItemDePaginaProps) {
  const [renomeando, setRenomeando] = useState(false);
  const [erroDeRenomeio, setErroDeRenomeio] = useState<string | null>(null);
  const [confirmandoRemocao, setConfirmandoRemocao] = useState(false);
  const [erroDeRemocao, setErroDeRemocao] = useState<string | null>(null);

  const [rascunho, setRascunho] = useState(pagina.content);
  const [status, setStatus] = useState<StatusDeSalvamento>("ocioso");
  const [erroDeSalvamento, setErroDeSalvamento] = useState<string | null>(null);

  // Duas cópias do mesmo texto: `rascunho` (estado, redesenha a tela) e este
  // ref (lido no `useEffect` de desmonte, que não pode enxergar um estado
  // capturado na hora em que o efeito foi criado — closure obsoleta).
  const rascunhoRef = useRef(rascunho);
  rascunhoRef.current = rascunho;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Trocar de página (id diferente) resincroniza o rascunho com o que veio
  // do servidor; uma atualização de CONTEÚDO da mesma página (a resposta do
  // próprio `salvar` abaixo) não deve — sobrescreveria o que o usuário já
  // digitou por cima enquanto a chamada anterior ainda estava em voo.
  useEffect(() => {
    setRascunho(pagina.content);
    setStatus("ocioso");
  }, [pagina.id]);

  // Salva o que houver de pendente ao desmontar (livro fechado, painel
  // trocado) — sem isto, fechar o livro logo depois de digitar, antes do
  // debounce disparar, perderia exatamente o texto que a regra 4 do pedido
  // proíbe perder. Sem `await` possível num cleanup: dispara e deixa correr;
  // não há mais UI para mostrar um erro depois que o item já sumiu da tela.
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        void escreverConteudoDaPagina(pagina.id, rascunhoRef.current).catch(() => undefined);
      }
    };
    // Deps vazias de propósito: isto roda só na montagem/desmonte real do
    // item, nunca de novo a cada tecla — os valores atuais de `pagina.id` e
    // `rascunho` chegam pelas refs acima, não por dependência do efeito.
  }, []);

  async function salvar(texto: string) {
    setStatus("salvando");
    try {
      const atualizado = await escreverConteudoDaPagina(pagina.id, texto);
      onAtualizar(atualizado);
      setStatus("salvo");
      setErroDeSalvamento(null);
    } catch (erro) {
      // `rascunho` não é tocado aqui: o texto que o usuário digitou continua
      // na tela mesmo que o IPC falhe — é exatamente o que a regra 4 pede.
      setStatus("erro");
      setErroDeSalvamento(mensagemDeErro(erro));
    }
  }

  function aoEditar(texto: string) {
    setRascunho(texto);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      void salvar(texto);
    }, ESPERA_ENTRE_TECLAS_MS);
  }

  function aoSairDoCampo() {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      void salvar(rascunho);
    }
  }

  function iniciarRenomeio() {
    setErroDeRenomeio(null);
    setRenomeando(true);
  }

  async function confirmarRenomeio(nome: string): Promise<boolean> {
    if (nome === "" || nome === pagina.title) {
      setRenomeando(false);
      return true;
    }
    try {
      const atualizada = await renomearPaginaDeLivro(pagina.id, nome);
      onAtualizar(atualizada);
      setRenomeando(false);
      setErroDeRenomeio(null);
      return true;
    } catch (erro) {
      setErroDeRenomeio(mensagemDeErro(erro));
      return false;
    }
  }

  async function remover() {
    setConfirmandoRemocao(false);
    setErroDeRemocao(null);
    try {
      await removerPaginaDeLivro(pagina.id);
      onRemover(pagina.id);
    } catch (erro) {
      setErroDeRemocao(mensagemDeErro(erro));
    }
  }

  return (
    <div className="flex flex-col gap-1 rounded-sm border border-transparent px-1 py-1 has-[[aria-expanded=true]]:border-hairline has-[[aria-expanded=true]]:bg-surface-sunken">
      <div className="flex items-center gap-1">
        {renomeando ? (
          <CampoDeNomeInline
            rotulo={`Nome da página ${pagina.title}`}
            valorInicial={pagina.title}
            onConfirmar={confirmarRenomeio}
            onCancelar={() => setRenomeando(false)}
          />
        ) : (
          <button
            type="button"
            onClick={onAlternarAbertura}
            onDoubleClick={iniciarRenomeio}
            aria-expanded={aberta}
            className="min-w-0 flex-1 truncate rounded-sm px-1 py-0.5 text-left text-sm text-ink hover:bg-surface-raised"
          >
            {pagina.title}
          </button>
        )}

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onMoverParaCima}
            disabled={!podeMoverParaCima}
            aria-label={`Mover ${pagina.title} para cima`}
            className="grid size-6 place-items-center rounded-sm text-ink-muted hover:bg-surface-raised hover:text-ink disabled:pointer-events-none disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={onMoverParaBaixo}
            disabled={!podeMoverParaBaixo}
            aria-label={`Mover ${pagina.title} para baixo`}
            className="grid size-6 place-items-center rounded-sm text-ink-muted hover:bg-surface-raised hover:text-ink disabled:pointer-events-none disabled:opacity-30"
          >
            ↓
          </button>
          {!renomeando ? (
            <button
              type="button"
              onClick={iniciarRenomeio}
              aria-label={`Renomear ${pagina.title}`}
              className="grid size-6 place-items-center rounded-sm text-ink-muted hover:bg-surface-raised hover:text-ink"
            >
              ✎
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setConfirmandoRemocao(true)}
            aria-label={`Apagar ${pagina.title}`}
            className="grid size-6 place-items-center rounded-sm text-ink-muted hover:bg-surface-raised hover:text-terracotta-ink"
          >
            ✕
          </button>
        </div>
      </div>

      {erroDeRenomeio ? (
        <p role="alert" className="text-xs text-terracotta-ink">
          {erroDeRenomeio}
        </p>
      ) : null}

      {aberta ? (
        <div className="flex flex-col gap-1">
          <textarea
            aria-label={`Conteúdo de ${pagina.title}`}
            value={rascunho}
            onChange={(event) => aoEditar(event.target.value)}
            onBlur={aoSairDoCampo}
            rows={8}
            className="w-full resize-none rounded-sm border border-hairline bg-surface px-2 py-1.5 text-sm text-ink"
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-ink-muted">
              {status === "salvando" ? "Salvando…" : status === "salvo" ? "Salvo." : ""}
            </span>
            {status === "erro" ? (
              <button
                type="button"
                onClick={() => void salvar(rascunho)}
                className="text-[11px] text-terracotta-ink hover:underline"
              >
                Tentar salvar de novo
              </button>
            ) : null}
          </div>
          {erroDeSalvamento ? (
            <p role="alert" className="text-xs text-terracotta-ink">
              {erroDeSalvamento}
            </p>
          ) : null}
        </div>
      ) : null}

      {erroDeRemocao ? (
        <p role="alert" className="text-xs text-terracotta-ink">
          {erroDeRemocao}
        </p>
      ) : null}

      {confirmandoRemocao ? (
        <div
          role="alertdialog"
          aria-label={`Apagar ${pagina.title}?`}
          className="flex flex-col gap-2 rounded-sm border border-hairline bg-surface p-2"
        >
          <p className="text-xs text-ink-muted">Apagar "{pagina.title}"? O texto desta página será perdido — não é possível desfazer.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmandoRemocao(false)} className="text-xs text-ink-muted hover:text-ink">
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void remover()}
              className="rounded-sm border border-terracotta-ink px-2 py-1 text-xs font-medium text-terracotta-ink hover:bg-surface-raised"
            >
              Apagar mesmo assim
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
