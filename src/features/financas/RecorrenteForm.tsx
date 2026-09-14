import { useState, type FormEvent } from "react";
import { AppError } from "../../lib/ipc";
import { ehMesValido, lerReais } from "./dinheiro";
import { BOTAO_PRIMARIO, BOTAO_TEXTO, CAMPO, ROTULO } from "./estilos";
import type { TipoFinanceiro } from "./ipc";
import { NovaCategoria } from "./NovaCategoria";
import { useFinancasStore } from "./store";

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/**
 * Cadastrar renda ou gasto fixo: descrição, tipo, categoria, valor e o mês em
 * que começa a valer. Mudar o valor depois NÃO é editar este formulário — é
 * "Mudar valor a partir de…" (`FormularioDeValor`), para o histórico de
 * valores continuar verdadeiro nos meses que já passaram.
 */
export function RecorrenteForm({ onFechar }: { onFechar: () => void }) {
  const mes = useFinancasStore((state) => state.mes);
  const categorias = useFinancasStore((state) => state.categorias);
  const criarRecorrente = useFinancasStore((state) => state.criarRecorrente);

  const [descricao, setDescricao] = useState("");
  const [tipo, setTipo] = useState<TipoFinanceiro>("saida");
  const [categoriaId, setCategoriaId] = useState("");
  const [valorTexto, setValorTexto] = useState("");
  const [inicioMes, setInicioMes] = useState(mes);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const opcoes = categorias.filter((categoria) => categoria.tipo === tipo);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const descricaoAparada = descricao.trim();
    const valorCentavos = lerReais(valorTexto);
    if (descricaoAparada === "") return setErro("Dê um nome, por exemplo Salário ou MEI.");
    if (valorCentavos === null) return setErro("Valor inválido. Use, por exemplo, 4.100,00.");
    if (!ehMesValido(inicioMes)) return setErro("Escolha o mês em que começa.");

    setSalvando(true);
    setErro(null);
    try {
      await criarRecorrente({
        descricao: descricaoAparada,
        tipo,
        categoriaId: categoriaId === "" ? null : categoriaId,
        valorCentavos,
        inicioMes,
      });
      onFechar();
    } catch (error) {
      setErro(messageFor(error, "Não foi possível salvar o item fixo."));
      setSalvando(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      aria-label="Novo item fixo"
      className="grid grid-cols-1 gap-3 rounded-md border border-border bg-paper p-4 sm:grid-cols-2 lg:grid-cols-5"
    >
      <label className="lg:col-span-2">
        <span className={ROTULO}>Descrição</span>
        <input value={descricao} onChange={(event) => setDescricao(event.currentTarget.value)} className={CAMPO} />
      </label>

      <label>
        <span className={ROTULO}>Tipo</span>
        <select
          value={tipo}
          onChange={(event) => {
            setTipo(event.currentTarget.value as TipoFinanceiro);
            setCategoriaId("");
          }}
          className={CAMPO}
        >
          <option value="saida">Gasto fixo</option>
          <option value="entrada">Renda</option>
        </select>
      </label>

      <label>
        <span className={ROTULO}>Valor por mês (R$)</span>
        <input
          inputMode="decimal"
          value={valorTexto}
          onChange={(event) => setValorTexto(event.currentTarget.value)}
          placeholder="0,00"
          className={`${CAMPO} tabular-nums`}
        />
      </label>

      <label>
        <span className={ROTULO}>Começa em</span>
        <input
          type="month"
          value={inicioMes}
          onChange={(event) => setInicioMes(event.currentTarget.value)}
          className={CAMPO}
        />
      </label>

      <div className="sm:col-span-2">
        <label className="block">
          <span className={ROTULO}>Categoria</span>
          <select value={categoriaId} onChange={(event) => setCategoriaId(event.currentTarget.value)} className={CAMPO}>
            <option value="">Sem categoria</option>
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
          {salvando ? "Salvando…" : "Cadastrar"}
        </button>
      </div>
    </form>
  );
}
