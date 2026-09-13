import { useState, type ReactNode } from "react";
import { BackupSettings } from "../backup";
import { ImportApkgSection } from "../import";
import { CheckDatabaseSection } from "../integrity";
import { AppearanceSection } from "./AppearanceSection";
import { DataFolderSection } from "./DataFolderSection";

/**
 * A tela de Configurações, com navegação própria.
 *
 * Antes disto as quatro seções ficavam empilhadas num diálogo estreito, com
 * rolagem: quem procurava "onde troco a pasta de trabalho" rolava por 400
 * linhas de backup até achar. Com seções nomeadas, cada assunto tem endereço,
 * e acrescentar o próximo (atalhos, editor, sincronização) não piora os que já
 * estavam lá.
 *
 * As seções em si não foram reescritas — são exatamente os componentes que já
 * existiam, remontados. O que mudou é onde eles moram.
 */
interface Secao {
  id: string;
  nome: string;
  /** Uma linha explicando o assunto, acima do conteúdo. */
  resumo: string;
  conteudo: ReactNode;
}

const SECOES: readonly Secao[] = [
  {
    id: "aparencia",
    nome: "Aparência",
    resumo: "Como o Learno se parece enquanto você estuda.",
    conteudo: <AppearanceSection />,
  },
  {
    id: "dados",
    nome: "Banco de dados",
    resumo: "Onde seus dados ficam, e como conferir se estão sãos.",
    conteudo: (
      <div className="space-y-8">
        <DataFolderSection />
        <div className="border-t border-border pt-8">
          <h3 className="font-display text-base text-ink">Verificar banco de dados</h3>
          <div className="mt-3">
            <CheckDatabaseSection />
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "backup",
    nome: "Backup",
    resumo: "Cópias do seu acervo, manuais e automáticas.",
    conteudo: <BackupSettings />,
  },
  {
    id: "importar",
    nome: "Importar",
    resumo: "Trazer material de outros programas.",
    conteudo: <ImportApkgSection />,
  },
] as const;

export function SettingsScreen() {
  const [ativa, setAtiva] = useState(SECOES[0].id);
  const secao = SECOES.find((item) => item.id === ativa) ?? SECOES[0];

  return (
    <div className="flex min-h-0 flex-1">
      {/* `aria-label` no `nav` e não no `ul`: é a navegação da tela, e é assim
          que um leitor de tela a anuncia como marco navegável. */}
      <nav aria-label="Seções das configurações" className="w-44 shrink-0 border-r border-border p-2">
        <ul className="space-y-0.5">
          {SECOES.map((item) => {
            const selecionada = item.id === secao.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setAtiva(item.id)}
                  aria-current={selecionada ? "page" : undefined}
                  className={[
                    "w-full rounded-md px-3 py-2 text-left text-sm transition-colors duration-150 ease-out",
                    selecionada ? "bg-surface-sunken font-medium text-ink" : "text-ink-muted hover:text-ink",
                  ].join(" ")}
                >
                  {item.nome}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        <h2 className="font-display text-xl text-ink">{secao.nome}</h2>
        <p className="mt-1 text-sm text-ink-muted">{secao.resumo}</p>
        <div className="mt-6">{secao.conteudo}</div>
      </div>
    </div>
  );
}
