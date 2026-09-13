import { useState, type FormEvent } from "react";
import { AppError } from "../../lib/ipc";
import { deslocarMes, ehMesValido, lerReais, rotuloCurtoDoMes, rotuloDoMes } from "./dinheiro";
import { BOTAO_PRIMARIO, BOTAO_SECUNDARIO, BOTAO_TEXTO, CAMPO, CARTAO, ROTULO } from "./estilos";
import type { RecorrenteComVigencias } from "./ipc";
import { RecorrenteForm } from "./RecorrenteForm";
import { useFinancasStore } from "./store";
import { Valor } from "./Valor";
import { descreverVigencia, ultimaVigencia, vigenciaNoMes } from "./vigencias";

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/**
 * Renda e gastos fixos, com o valor de cada um no mês aberto e o histórico
 * de valores. Aumento, redução, item que entra e item que sai são todos
 * mudanças de VIGÊNCIA — nunca edição do valor antigo, que reescreveria o
 * passado.
 */
export function RendaEFixos() {
  const recorrentes = useFinancasStore((state) => state.recorrentes);
  const [criando, setCriando] = useState(false);

  const rendas = recorrentes.filter((recorrente) => recorrente.tipo === "entrada");
  const gastos = recorrentes.filter((recorrente) => recorrente.tipo === "saida");

  return (
    <div className="flex flex-col gap-6">
      {criando ? (
        <RecorrenteForm onFechar={() => setCriando(false)} />
      ) : (
        <button type="button" onClick={() => setCriando(true)} className={`${BOTAO_PRIMARIO} self-start`}>
          + Nova renda ou gasto fixo
        </button>
      )}

      <GrupoDeRecorrentes titulo="Renda" vazio="Nenhuma renda cadastrada." itens={rendas} />
      <GrupoDeRecorrentes titulo="Gastos fixos" vazio="Nenhum gasto fixo cadastrado." itens={gastos} />
    </div>
  );
}

interface GrupoProps {
  titulo: string;
  vazio: string;
  itens: RecorrenteComVigencias[];
}

function GrupoDeRecorrentes({ titulo, vazio, itens }: GrupoProps) {
  return (
    <section aria-label={titulo} className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-ink">{titulo}</h2>
      {itens.length === 0 ? (
        <p className={`${CARTAO} text-sm text-ink-muted`}>{vazio}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {itens.map((item) => (
            <CartaoDeRecorrente key={item.id} recorrente={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

type Painel = "valor" | "encerrar" | "historico" | null;

function CartaoDeRecorrente({ recorrente }: { recorrente: RecorrenteComVigencias }) {
  const mes = useFinancasStore((state) => state.mes);
  const categorias = useFinancasStore((state) => state.categorias);
  const removerRecorrente = useFinancasStore((state) => state.removerRecorrente);
  const [painel, setPainel] = useState<Painel>(null);
  const [apagando, setApagando] = useState(false);

  const noMes = vigenciaNoMes(recorrente.vigencias, mes);
  const ultima = ultimaVigencia(recorrente.vigencias);
  const categoria = categorias.find((item) => item.id === recorrente.categoriaId)?.nome ?? "Sem categoria";

  let situacao: string;
  if (noMes) situacao = noMes.fimMes ? `vale até ${rotuloCurtoDoMes(noMes.fimMes)}` : "ativo";
  else if (ultima && ultima.inicioMes > mes) situacao = `começa em ${rotuloCurtoDoMes(ultima.inicioMes)}`;
  else if (ultima?.fimMes) situacao = `encerrado em ${rotuloCurtoDoMes(ultima.fimMes)}`;
  else situacao = "sem valor neste mês";

  async function handleApagar() {
    const confirmado = window.confirm(
      `Apagar "${recorrente.descricao}" e todo o histórico de valores? Lançamentos já confirmados continuam, sem vínculo.`,
    );
    if (!confirmado) return;
    setApagando(true);
    try {
      await removerRecorrente(recorrente.id);
    } catch {
      setApagando(false);
    }
  }

  const alternar = (alvo: Painel) => setPainel((atual) => (atual === alvo ? null : alvo));

  return (
    <li className={`${CARTAO} flex flex-col gap-3`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{recorrente.descricao}</p>
          <p className="text-xs text-ink-muted">
            {categoria} · {situacao}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-ink-muted first-letter:uppercase">{rotuloDoMes(mes)}</p>
          {noMes ? (
            <Valor centavos={noMes.valorCentavos} className="text-sm font-semibold text-ink" />
          ) : (
            <p className="text-sm text-ink-muted">—</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-1.5">
        <button type="button" onClick={() => alternar("historico")} aria-expanded={painel === "historico"} className={BOTAO_SECUNDARIO}>
          Histórico ({recorrente.vigencias.length})
        </button>
        <button type="button" onClick={() => alternar("valor")} aria-expanded={painel === "valor"} className={BOTAO_SECUNDARIO}>
          Mudar valor
        </button>
        <button type="button" onClick={() => alternar("encerrar")} aria-expanded={painel === "encerrar"} className={BOTAO_SECUNDARIO}>
          Encerrar
        </button>
        <button
          type="button"
          onClick={() => void handleApagar()}
          disabled={apagando}
          aria-label={`Apagar ${recorrente.descricao}`}
          className={`${BOTAO_SECUNDARIO} hover:text-terracotta-ink`}
        >
          {apagando ? "Apagando…" : "Apagar"}
        </button>
      </div>

      {painel === "historico" ? (
        <ol className="flex flex-col gap-1 border-t border-border pt-2 text-xs text-ink-muted" aria-label="Histórico de valores">
          {recorrente.vigencias.map((vigencia) => (
            <li key={vigencia.id} className="tabular-nums">
              {descreverVigencia(vigencia)}
            </li>
          ))}
        </ol>
      ) : null}
      {painel === "valor" ? (
        <FormularioDeMes
          recorrenteId={recorrente.id}
          modo="valor"
          mesInicial={mes}
          onFechar={() => setPainel(null)}
        />
      ) : null}
      {painel === "encerrar" ? (
        <FormularioDeMes
          recorrenteId={recorrente.id}
          modo="encerrar"
          mesInicial={mes}
          onFechar={() => setPainel(null)}
        />
      ) : null}
    </li>
  );
}

interface FormularioDeMesProps {
  recorrenteId: string;
  modo: "valor" | "encerrar";
  mesInicial: string;
  onFechar: () => void;
}

/**
 * "Mudar valor a partir de [mês]" ou "Último mês: [mês]". Os dois só pedem
 * um mês (e o valor, no primeiro), por isso dividem o formulário.
 */
function FormularioDeMes({ recorrenteId, modo, mesInicial, onFechar }: FormularioDeMesProps) {
  const mudarValorRecorrente = useFinancasStore((state) => state.mudarValorRecorrente);
  const encerrarRecorrente = useFinancasStore((state) => state.encerrarRecorrente);
  const [mes, setMes] = useState(mesInicial);
  const [valorTexto, setValorTexto] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ehMesValido(mes)) return setErro("Escolha um mês.");
    const valorCentavos = modo === "valor" ? lerReais(valorTexto) : null;
    if (modo === "valor" && valorCentavos === null) return setErro("Valor inválido. Use, por exemplo, 4.387,00.");

    setSalvando(true);
    setErro(null);
    try {
      if (modo === "valor" && valorCentavos !== null) await mudarValorRecorrente(recorrenteId, valorCentavos, mes);
      else await encerrarRecorrente(recorrenteId, mes);
      onFechar();
    } catch (error) {
      setErro(messageFor(error, "Não foi possível salvar."));
      setSalvando(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      aria-label={modo === "valor" ? "Mudar valor" : "Encerrar item fixo"}
      className="flex flex-wrap items-end gap-3 border-t border-border pt-3"
    >
      {modo === "valor" ? (
        <label>
          <span className={ROTULO}>Novo valor (R$)</span>
          <input
            inputMode="decimal"
            value={valorTexto}
            onChange={(event) => setValorTexto(event.currentTarget.value)}
            placeholder="0,00"
            className={`${CAMPO} w-36 tabular-nums`}
          />
        </label>
      ) : null}
      <label>
        <span className={ROTULO}>{modo === "valor" ? "A partir de" : "Último mês que conta"}</span>
        <input type="month" value={mes} onChange={(event) => setMes(event.currentTarget.value)} className={`${CAMPO} w-44`} />
      </label>
      <p className="basis-full text-xs text-ink-muted sm:basis-auto">
        {modo === "valor"
          ? ehMesValido(mes)
            ? `Meses antes de ${rotuloCurtoDoMes(mes)} mantêm o valor antigo.`
            : null
          : ehMesValido(mes)
            ? `A partir de ${rotuloCurtoDoMes(deslocarMes(mes, 1))} não entra mais no previsto.`
            : null}
      </p>
      <div className="ml-auto flex items-center gap-1.5">
        {erro ? (
          <p role="alert" className="text-xs text-terracotta-ink">
            {erro}
          </p>
        ) : null}
        <button type="button" onClick={onFechar} className={BOTAO_TEXTO}>
          Cancelar
        </button>
        <button type="submit" disabled={salvando} className={BOTAO_PRIMARIO}>
          {salvando ? "Salvando…" : modo === "valor" ? "Mudar valor" : "Encerrar"}
        </button>
      </div>
    </form>
  );
}
