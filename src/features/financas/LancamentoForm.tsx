import { useState, type FormEvent } from "react";
import { AppError } from "../../lib/ipc";
import { formatarReais, lerReais, mesDe, primeiroDiaDoMes } from "./dinheiro";
import { BOTAO_PRIMARIO, BOTAO_TEXTO, CAMPO, ROTULO } from "./estilos";
import type { CategoriaRow, LancamentoRow, TipoFinanceiro } from "./ipc";
import { NovaCategoria } from "./NovaCategoria";
import { useFinancasStore } from "./store";

interface LancamentoFormProps {
  /** Presente = editando; ausente = criando. */
  lancamento?: LancamentoRow;
  onFechar: () => void;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/** Hoje, se hoje cai no mês aberto; senão o dia 1º dele — lançar em outubro olhando outubro. */
function dataPadrao(mes: string): string {
  const hoje = new Date();
  if (mesDe(hoje) !== mes) return primeiroDiaDoMes(mes);
  return `${mes}-${String(hoje.getDate()).padStart(2, "0")}`;
}

function categoriasDoTipo(categorias: CategoriaRow[], tipo: TipoFinanceiro): CategoriaRow[] {
  return categorias.filter((categoria) => categoria.tipo === tipo);
}

/**
 * Criar ou editar um lançamento. Valor é texto livre lido por `lerReais`
 * (aceita `1.234,56`), nunca `type="number"`: o campo numérico do navegador
 * não entende vírgula decimal no pt-BR.
 *
 * Categoria não pode voltar a "sem categoria" na edição — o patch do backend
 * usa `COALESCE`, mesma limitação documentada em `prazos/PrazoForm.tsx`.
 * Por isso, editando, a opção "Sem categoria" só aparece se o lançamento já
 * não tem categoria.
 */
export function LancamentoForm({ lancamento, onFechar }: LancamentoFormProps) {
  const mes = useFinancasStore((state) => state.mes);
  const categorias = useFinancasStore((state) => state.categorias);
  const criarLancamento = useFinancasStore((state) => state.criarLancamento);
  const atualizarLancamento = useFinancasStore((state) => state.atualizarLancamento);

  const [dataLocal, setDataLocal] = useState(lancamento?.dataLocal ?? dataPadrao(mes));
  const [descricao, setDescricao] = useState(lancamento?.descricao ?? "");
  const [tipo, setTipo] = useState<TipoFinanceiro>(lancamento?.tipo ?? "saida");
  const [categoriaId, setCategoriaId] = useState(lancamento?.categoriaId ?? "");
  const [valorTexto, setValorTexto] = useState(
    lancamento ? formatarReais(lancamento.valorCentavos).replace(/R\$\s?/, "") : "",
  );
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const opcoes = categoriasDoTipo(categorias, tipo);
  const podeFicarSemCategoria = !lancamento || lancamento.categoriaId === null;

  function trocarTipo(novoTipo: TipoFinanceiro) {
    setTipo(novoTipo);
    // Categoria de saída não serve para entrada: limpa em vez de gravar "Salário" como gasto.
    if (!categoriasDoTipo(categorias, novoTipo).some((categoria) => categoria.id === categoriaId)) {
      setCategoriaId("");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const descricaoAparada = descricao.trim();
    const valorCentavos = lerReais(valorTexto);
    if (descricaoAparada === "") return setErro("Descreva o lançamento.");
    if (dataLocal === "") return setErro("Escolha a data.");
    if (valorCentavos === null) return setErro("Valor inválido. Use, por exemplo, 1.234,56.");
    if (!podeFicarSemCategoria && categoriaId === "") return setErro("Escolha uma categoria.");

    setSalvando(true);
    setErro(null);
    try {
      if (lancamento) {
        await atualizarLancamento(lancamento.id, {
          dataLocal,
          descricao: descricaoAparada,
          tipo,
          valorCentavos,
          ...(categoriaId === "" ? {} : { categoriaId }),
        });
      } else {
        await criarLancamento({
          dataLocal,
          descricao: descricaoAparada,
          tipo,
          categoriaId: categoriaId === "" ? null : categoriaId,
          valorCentavos,
        });
      }
      onFechar();
    } catch (error) {
      setErro(messageFor(error, "Não foi possível salvar o lançamento."));
      setSalvando(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      aria-label={lancamento ? "Editar lançamento" : "Novo lançamento"}
      className="grid grid-cols-1 gap-3 rounded-md border border-border bg-paper p-4 sm:grid-cols-2 lg:grid-cols-5"
    >
      <label className="lg:col-span-2">
        <span className={ROTULO}>Descrição</span>
        <input value={descricao} onChange={(event) => setDescricao(event.currentTarget.value)} className={CAMPO} />
      </label>

      <label>
        <span className={ROTULO}>Data</span>
        <input
          type="date"
          value={dataLocal}
          onChange={(event) => setDataLocal(event.currentTarget.value)}
          className={CAMPO}
        />
      </label>

      <label>
        <span className={ROTULO}>Tipo</span>
        <select
          value={tipo}
          onChange={(event) => trocarTipo(event.currentTarget.value as TipoFinanceiro)}
          className={CAMPO}
        >
          <option value="saida">Saída</option>
          <option value="entrada">Entrada</option>
        </select>
      </label>

      <label>
        <span className={ROTULO}>Valor (R$)</span>
        <input
          inputMode="decimal"
          value={valorTexto}
          onChange={(event) => setValorTexto(event.currentTarget.value)}
          placeholder="0,00"
          className={`${CAMPO} tabular-nums`}
        />
      </label>

      <div className="sm:col-span-2 lg:col-span-2">
        <label className="block">
          <span className={ROTULO}>Categoria</span>
          <select value={categoriaId} onChange={(event) => setCategoriaId(event.currentTarget.value)} className={CAMPO}>
            {podeFicarSemCategoria ? <option value="">Sem categoria</option> : null}
            {!podeFicarSemCategoria && categoriaId === "" ? <option value="">Escolha…</option> : null}
            {opcoes.map((categoria) => (
              <option key={categoria.id} value={categoria.id}>
                {categoria.nome}
              </option>
            ))}
          </select>
        </label>
        <NovaCategoria tipo={tipo} onCriada={(categoria) => setCategoriaId(categoria.id)} />
      </div>

      <div className="flex items-end justify-end gap-1.5 sm:col-span-2 lg:col-span-3">
        {erro ? (
          <p role="alert" className="mr-auto self-center text-xs text-terracotta-ink">
            {erro}
          </p>
        ) : null}
        <button type="button" onClick={onFechar} className={BOTAO_TEXTO}>
          Cancelar
        </button>
        <button type="submit" disabled={salvando} className={BOTAO_PRIMARIO}>
          {salvando ? "Salvando…" : lancamento ? "Salvar" : "Lançar"}
        </button>
      </div>
    </form>
  );
}
