import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { abrirPastaDeLogs } from "../lib/ipc";
import { descreverErro, registrarDescrito } from "../lib/registro-de-erros";

interface Props {
  children: ReactNode;
  /** `location.reload` não existe no jsdom; o teste passa o próprio. */
  recarregar?: () => void;
}

interface Estado {
  temErro: boolean;
  erro: unknown;
  pilhaDeComponentes: string | null;
}

function montarDetalhes(erro: unknown, pilhaDeComponentes: string | null): string {
  const { mensagem, pilha } = descreverErro(erro);
  const partes = [mensagem, pilha ?? "(sem pilha)"];
  if (pilhaDeComponentes) partes.push(`Componentes:${pilhaDeComponentes}`);
  return partes.join("\n\n");
}

/**
 * A última rede do app: um erro de renderização que ninguém tratou troca a
 * tela inteira por esta, em vez de deixar a janela em branco. O erro vai para
 * o arquivo de log com a pilha dos componentes, e a tela oferece o caminho
 * até ele.
 */
export class LimiteDeErroGlobal extends Component<Props, Estado> {
  state: Estado = { temErro: false, erro: null, pilhaDeComponentes: null };

  static getDerivedStateFromError(erro: unknown): Partial<Estado> {
    return { temErro: true, erro };
  }

  componentDidCatch(erro: unknown, info: ErrorInfo): void {
    const pilhaDeComponentes = info.componentStack ?? null;
    this.setState({ pilhaDeComponentes });
    registrarDescrito("tela", { mensagem: descreverErro(erro).mensagem, pilha: montarDetalhes(erro, pilhaDeComponentes) });
  }

  render() {
    if (!this.state.temErro) return this.props.children;
    return (
      <TelaDeErro
        detalhes={montarDetalhes(this.state.erro, this.state.pilhaDeComponentes)}
        recarregar={this.props.recarregar ?? (() => window.location.reload())}
      />
    );
  }
}

const BOTAO =
  "rounded-sm border border-border bg-surface px-4 py-2 text-sm font-medium text-ink transition hover:bg-surface-raised active:scale-97";

function TelaDeErro({ detalhes, recarregar }: { detalhes: string; recarregar: () => void }) {
  const [copiado, setCopiado] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(detalhes);
      setCopiado(true);
      setAviso(null);
    } catch {
      setAviso("Não foi possível copiar. Os mesmos detalhes estão no arquivo de log do dia.");
    }
  }

  async function abrirPasta() {
    try {
      await abrirPastaDeLogs();
      setAviso(null);
    } catch (erro) {
      setAviso(`Não foi possível abrir a pasta de logs: ${erro instanceof Error ? erro.message : String(erro)}`);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-paper px-6 text-center text-ink">
      <h1 className="font-display text-2xl">Algo deu errado</h1>
      <p className="max-w-md text-sm text-ink-muted">
        A tela parou por um erro inesperado. O que já estava salvo continua no banco. Recarregar costuma resolver; se o
        erro voltar, copie os detalhes ou anexe o arquivo de log do dia ao relatar o problema.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <button type="button" onClick={recarregar} className={BOTAO}>
          Recarregar
        </button>
        <button type="button" onClick={() => void copiar()} className={BOTAO}>
          {copiado ? "Copiado" : "Copiar detalhes"}
        </button>
        <button type="button" onClick={() => void abrirPasta()} className={BOTAO}>
          Abrir pasta de logs
        </button>
      </div>
      {aviso ? (
        <p role="alert" className="text-sm text-terracotta-ink">
          {aviso}
        </p>
      ) : null}
      <details className="w-full max-w-2xl text-left">
        <summary className="cursor-pointer text-xs text-ink-muted">Detalhes técnicos</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-ink-muted">{detalhes}</pre>
      </details>
    </main>
  );
}
