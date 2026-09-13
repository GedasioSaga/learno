import { create } from "zustand";
import { getTheme, saveTheme } from "./ipc";
import {
  alternarClaroEscuro,
  ehPreferenciaValida,
  resolverTema,
  SEGUIR_O_SISTEMA,
  TEMA_PADRAO,
  acharTema,
  type PreferenciaDeTema,
} from "./themes";

/**
 * O estado do tema: qual o usuário escolheu, e qual está pintado agora.
 *
 * ## Por que a preferência é gravada em dois lugares
 *
 * A fonte da verdade é o `config.json` do `tauri-plugin-store`, o mesmo
 * arquivo das outras configurações do app — o tema era a única que ficava de
 * fora, presa ao `localStorage` da WebView, sem migrar junto com a pasta de
 * trabalho e sem entrar em backup.
 *
 * Mas ler o `config.json` é uma chamada de IPC, e portanto assíncrona: a
 * resposta chega DEPOIS do primeiro quadro pintado, e o usuário veria a tela
 * piscar no tema errado toda vez que abrisse o app. Então o `localStorage`
 * continua sendo escrito, agora no papel de **cache de primeiro paint**:
 * síncrono, disponível antes do render, e reconciliado com o disco logo em
 * seguida. Se os dois discordarem, o disco ganha.
 */
const CHAVE_DE_CACHE = "learno:theme-preference";

/**
 * Lê o cache local. Nunca lança: sem `localStorage` (ou com acesso bloqueado)
 * só cai no padrão.
 *
 * Um valor de uma versão antiga do app (`"light"`, `"dark"`, `"system"`) não é
 * mais uma preferência válida e é descartado aqui — quem tinha um deles passa
 * a abrir no tema padrão, que é o comportamento certo para quem nunca escolheu
 * nada nesta versão.
 */
export function lerCache(): PreferenciaDeTema {
  try {
    const bruto = window.localStorage.getItem(CHAVE_DE_CACHE);
    if (ehPreferenciaValida(bruto)) return bruto;
  } catch {
    // Storage indisponível — segue com o padrão abaixo.
  }
  return TEMA_PADRAO;
}

function gravarCache(preferencia: PreferenciaDeTema) {
  try {
    window.localStorage.setItem(CHAVE_DE_CACHE, preferencia);
  } catch {
    // A escolha não sobrevive à próxima abertura pelo cache, mas o
    // `config.json` (a fonte da verdade) guardou.
  }
}

function aplicarNoDocumento(tema: string) {
  document.documentElement.dataset.theme = tema;
}

interface EstadoDoTema {
  /** O que o usuário escolheu: um id do catálogo, ou `"sistema"`. */
  preferencia: PreferenciaDeTema;
  /** O id que está de fato pintado no documento — nunca `"sistema"`. */
  temaEfetivo: string;
  /**
   * O último tema ESCURO que esteve ativo. Só serve ao atalho de alternar
   * claro/escuro: voltar do claro tem que devolver o escuro que a pessoa
   * estava usando, não o padrão de fábrica.
   */
  ultimoEscuro: string;
  /**
   * Aplica o cache local e dispara a reconciliação com o disco.
   *
   * Chamado uma vez, em `main.tsx`, FORA do React — não num efeito. É o que
   * garante que o `data-theme` já está no documento antes do primeiro paint.
   */
  iniciar: () => void;
  escolher: (preferencia: PreferenciaDeTema) => void;
  /** Alterna claro/escuro. É o que o item "Alternar tema" do menu nativo faz. */
  alternar: () => void;
}

export const useThemeStore = create<EstadoDoTema>((set, get) => ({
  preferencia: TEMA_PADRAO,
  temaEfetivo: TEMA_PADRAO,
  ultimoEscuro: TEMA_PADRAO,

  iniciar: () => {
    const doCache = lerCache();
    aplicarPreferencia(set, get, doCache, { persistir: false });

    // Reconcilia com a fonte da verdade. Assíncrono de propósito: o cache já
    // pintou a tela, então uma diferença aqui é uma correção invisível (a
    // troca de tema é instantânea e sem layout shift), não um flash.
    void getTheme()
      .then((doDisco) => {
        if (!ehPreferenciaValida(doDisco)) return;
        if (doDisco === get().preferencia) return;
        aplicarPreferencia(set, get, doDisco, { persistir: false });
        gravarCache(doDisco);
      })
      .catch(() => {
        // Sem runtime Tauri (testes em jsdom) ou store indisponível: o cache
        // continua valendo, e a próxima escolha do usuário grava de novo.
      });

    ouvirOSistema(set, get);
  },

  escolher: (preferencia) => {
    if (!ehPreferenciaValida(preferencia)) return;
    aplicarPreferencia(set, get, preferencia, { persistir: true });
  },

  alternar: () => {
    const { temaEfetivo, ultimoEscuro } = get();
    aplicarPreferencia(set, get, alternarClaroEscuro(temaEfetivo, ultimoEscuro), { persistir: true });
  },
}));

type Definir = (parcial: Partial<EstadoDoTema>) => void;
type Ler = () => EstadoDoTema;

/**
 * O caminho único por onde uma preferência vira pixel: resolve, aplica no
 * documento, atualiza o estado e (quando é escolha do usuário) persiste.
 *
 * Existe como função separada porque três entradas diferentes precisam fazer
 * exatamente a mesma coisa — o cache no boot, a resposta do disco, e a escolha
 * do usuário — e a única diferença entre elas é se grava de volta.
 */
function aplicarPreferencia(
  definir: Definir,
  ler: Ler,
  preferencia: PreferenciaDeTema,
  { persistir }: { persistir: boolean },
) {
  const temaEfetivo = resolverTema(preferencia);
  aplicarNoDocumento(temaEfetivo);

  const ehEscuro = acharTema(temaEfetivo)?.aparencia === "escura";
  definir({
    preferencia,
    temaEfetivo,
    ultimoEscuro: ehEscuro ? temaEfetivo : ler().ultimoEscuro,
  });

  if (!persistir) return;
  gravarCache(preferencia);
  void saveTheme(preferencia).catch(() => {
    // Sem runtime Tauri, ou disco indisponível: a escolha vale nesta sessão e
    // no cache local. Falhar em silêncio aqui é melhor que um alerta por uma
    // troca de cor que o usuário já está vendo funcionar.
  });
}

/**
 * Segue o sistema operacional enquanto a preferência for "seguir o sistema".
 *
 * Sem isto, quem escolhe "seguir o sistema" e depois muda o Windows do claro
 * para o escuro continuaria no tema antigo até reabrir o app. O ouvinte é
 * registrado uma vez e vive o processo inteiro — não há caminho no app que o
 * remova, e nem deveria haver.
 */
function ouvirOSistema(definir: Definir, ler: Ler) {
  const consulta = window.matchMedia?.("(prefers-color-scheme: dark)");
  consulta?.addEventListener?.("change", () => {
    if (ler().preferencia !== SEGUIR_O_SISTEMA) return;
    aplicarPreferencia(definir, ler, SEGUIR_O_SISTEMA, { persistir: false });
  });
}
