# Design da Trilha — base visual

Vocabulário visual da tela Trilha. Quem for construir a tela lê **só** este documento e consome as classes de `src/features/trilha/trilha.css`. Tudo aqui obedece a `docs/DESIGN-TOKENS.md`; onde este documento e o CSS discordarem, o CSS ganha.

## 1. O que a Trilha é, e a regra que manda no desenho

A Trilha é um caminho de estudo que se percorre seguindo setas, em faixas horizontais: "primeira flecha, aprender Databricks; próxima, Azure", com as etapas móveis; "uma flecha de estudos de T.I. e outra embaixo sendo um fluxo totalmente diferente".

**O eixo horizontal é dependência, não tempo.** A coluna de uma etapa é o nível dela no grafo: estar à direita quer dizer "depende do que está à esquerda", nunca "acontece depois no calendário". Toda decisão de forma abaixo serve a isso:

| Sinal | O que diz | Por que não parece linha do tempo |
|---|---|---|
| Flecha com ponta, saindo da direita de A e entrando na esquerda de B | "B depende de A" | linha do tempo não tem ponta nem nó de destino |
| Soquete oco à esquerda da etapa, pino cheio à direita | "encaixa em" | é a metáfora de plugue, não de sequência |
| Coluna de nível sem tique, sem linha de base, sem data, rótulo "raiz / nível 1 / nível 2" | "profundidade no grafo" | régua tem tique e número crescente; aqui só há faixa alternada e um rótulo |
| Etapa concluída pode estar à direita de uma disponível | a ordem de estudo é livre dentro do que as dependências permitem | numa linha do tempo, o concluído fica sempre à esquerda |

**Proibido** no rótulo de nível e no cabeçalho de raia: data, semana, mês, "dia 1". Se o componente precisar mostrar quando algo foi estudado, isso vai no `.trilha-etapa__meta` da etapa, nunca no eixo.

## 2. Como consumir

- Importe `@xyflow/react/dist/style.css` **antes** de `./trilha.css` (o CSS da trilha vence de qualquer forma, por estar fora de `@layer`; a ordem é só higiene).
- Envolva o `<ReactFlow>` num elemento `.trilha-canvas` (é ele que carrega as réguas e o escopo de todas as regras).
- **Quem dimensiona o quê:** a raia é um nó do @xyflow e recebe largura/altura por `style` inline do componente; `.trilha-raia` só veste esse retângulo (`inset: 0`). A coluna de nível recebe apenas `style={{ "--nivel": n }}`; o `left` (= n × `--trilha-coluna-passo`) é calculado pelo CSS, para o passo de coluna ter uma fonte só.
- **Cor por raia:** uma classe `.trilha-cor--<id>` (`azul`, `ciano`, `roxo`, `magenta`, `oliva`) em **três lugares**: na raia (`.trilha-raia`), em cada etapa dela (`.trilha-etapa`, porque no @xyflow o nó filho não é descendente DOM do nó pai) e no `className` de cada aresta (vira classe do `<g class="react-flow__edge">`). Tudo lê `--raia-cor`; sem a classe, cai em `--border`.
- **Estado da etapa:** uma das cinco classes `.trilha-etapa--bloqueada | --disponivel | --em-andamento | --concluida | --em-ciclo`. A marca (glifo no canto) é `::before` — o componente não renderiza nada para ela. **Acessibilidade é do componente:** ponha `data-estado="…"` e um `aria-label` que diga o estado ("Azure — bloqueada, falta concluir Databricks"), porque `::before` não é lido por leitor de tela.
- **Ponta da flecha:** o @xyflow pinta o marcador com `style` inline no `<polyline>`, então CSS **não alcança** a cor da ponta. O componente passa em `markerEnd` a **mesma** cor que a regra CSS dá ao traço (§4). Sem isso a ponta sai cinza `#b1b1b7` fixo da lib.
- **Handles:** `<Handle type="target" position={Position.Left} />` e `<Handle type="source" position={Position.Right} />` dentro de `.trilha-etapa`. Só esses dois lados; um handle em cima/embaixo quebraria a leitura "entra pela esquerda".
- **`<Controls />`, `<MiniMap />` e `<Background variant="dots" />`** já saem vestidos com os tokens do tema por estarem dentro de `.trilha-canvas` (o CSS redefine as variáveis `--xy-*` que a lib lê antes dos hex fixos dela). Nada a configurar; não passe `style` nem `color` a esses componentes.

## 3. Os cinco estados da etapa

Cada estado tem **forma** própria (borda, fundo, faixa, glifo), não só cor — baixa visão e daltonismo continuam lendo. **Nenhum estado usa `opacity`.**

| Estado | Significado | Forma | Por quê |
|---|---|---|---|
| **disponível** | todas as bloqueadoras concluídas; pode começar | borda 1px sólida `--border`, fundo `surface`, faixa da raia sólida, marca **○** (`ink-muted` sobre `surface`) | é o estado neutro de "controle em repouso" do app (nível 1 de elevação); o círculo vazio é a caixa por marcar |
| **bloqueada** | falta concluir pelo menos uma bloqueadora à esquerda | borda 1px **tracejada** `--border`, fundo `surface-sunken` **sem sombra** (afundada), faixa da raia **hachurada** (raia ⟷ sunken em 3px/4px a 135°), texto `--ink-muted`, marca **⊘** | quatro sinais independentes de cor: tracejado, hachura, afundamento, glifo. Só opacidade apagaria a informação mais importante da tela para quem tem baixa visão |
| **em andamento** | começou e não terminou | borda **2px** sólida na cor da raia, fundo `surface` + 12% raia, marca **◐** (`ink`), barra de progresso de 3px no rodapé (`.trilha-etapa__progresso`, `--progresso` de 0 a 100) | é a única etapa que "acende" na cor da raia: o olho vai para onde o estudo está agora |
| **concluída** | terminada | borda 1px sólida `--mint`, fundo `surface` + 10% mint, marca **✓** (`mint-ink`) | verde de sucesso do app; as flechas que chegam nela também ficam mint (§4), então o caminho já percorrido é verde |
| **em ciclo** | está num ciclo de dependência (A → B → A): erro do grafo, precisa ser desfeito | borda **5px dupla** `--terracotta` (duas linhas: "volta para si"), fundo `surface` + 10% terracotta, marca **↻** (`terracotta-ink`) | é o único estado de erro, e o único com borda dupla: não se confunde com "bloqueada" (tracejada) nem com "em andamento" (2px sólida) |

Notas:

- A **faixa** de 6px à esquerda é sempre a cor da raia (identidade); o **estado** vive na borda, no fundo e na marca. Bloqueada é a exceção onde a faixa muda de padrão (hachura) sem mudar de cor.
- A largura da borda muda por estado (1, 2 ou 5px); o padding compensa (`0.75rem + 1px − borda`), então o texto não pula quando a etapa muda de estado.
- **Selecionada** (qualquer estado): anel `2px solid var(--amber)` com offset 2px — o mesmo amber da seleção do mapa mental; Delete apaga o que estiver com o anel. **Foco de teclado**: anel `--focus` global. **Arrastando**: sombra nível 2 (`--shadow-hard`). **Hover**: sobe 1px (`translateY(-1px)`), sem mudar o fundo — o fundo já carrega estado.
- Título `--ink` (ou `--ink-muted` na bloqueada), 2 linhas no máximo; meta `--ink-muted` em `text-xs`, uma linha com reticências.

## 4. A flecha

| Propriedade | Valor | Onde |
|---|---|---|
| Espessura | 2 (selecionada/hover: 3) | CSS `--trilha-aresta-espessura` |
| Ponta de linha | `round` | CSS |
| Curva | bezier com tangentes horizontais — `type: "default"`, `pathOptions: { curvature: 0.35 }` | prop da edge (curvatura não é CSS) |
| Ponta | `markerEnd: { type: MarkerType.ArrowClosed, width: 22, height: 22, markerUnits: "userSpaceOnUse", strokeWidth: 1.5, color: <mesma cor do traço> }` | prop da edge |

Por que `markerUnits: "userSpaceOnUse"`: o padrão da lib (`strokeWidth`) multiplica o tamanho do marcador pela espessura do traço — com traço 2 a ponta sairia com 25px de caixa. Em espaço de usuário, 22px dá uma ponta de ~7×10px que acompanha o zoom.

Cor do traço, e a `color` que o componente passa em `markerEnd` (obrigatoriamente a mesma):

| Classe na aresta | Chega em | Traço | `markerEnd.color` |
|---|---|---|---|
| `.trilha-aresta .trilha-cor--<id>` | disponível ou em andamento | cor da raia da etapa **alvo** (quem depende), sólido | `var(--raia-<id>)` |
| `+ .trilha-aresta--para-bloqueada` | bloqueada | cor da raia, **tracejado 7 5** — "o caminho ainda não se abriu" | `var(--raia-<id>)` |
| `+ .trilha-aresta--para-concluida` | concluída | `--mint`, sólido — "caminho já percorrido é verde" | `var(--mint)` |
| `+ .trilha-aresta--em-ciclo` | qualquer, mas a aresta fecha um ciclo | `--terracotta`, **pontilhado 2 6** — dois sinais (padrão + cor) porque é erro | `var(--terracotta)` |
| `.selected` (a lib põe) | — | `--amber`, espessura 3, contínuo — é o que Delete apaga | `var(--amber)` |

A regra "cor do alvo" é a mesma do mapa mental (aresta na cor do filho): numa dependência que cruza raias, a flecha entra na cor de quem depende. A linha de conexão enquanto se arrasta uma dependência nova é amber tracejada; vira sólida ao soltar num soquete.

## 5. A raia

- `.trilha-raia`: faixa horizontal, **sem preenchimento colorido**. Motivo medido: qualquer tinta de `paper` na direção da cor da raia derrubava a borda de etapa abaixo de 3:1 em algum tema (Papel: `--mint` de 3.08 para 2.70:1). A identidade fica no **filete de 3px** à esquerda (altura toda da raia), no **ponto** antes do título, na faixa de cada etapa e nas flechas.
- Raias vizinhas se separam por `hairline` em cima. Nada de sombra entre irmãs (DESIGN-TOKENS §7).
- `.trilha-raia__cabecalho` (altura `--trilha-raia-cabecalho-altura`, 37.5px): `.trilha-raia__alternar` (chevron desenhado com borda, área de clique 44px via `::after`), `.trilha-raia__titulo` (serifada `--font-display`, 15px, 600, `--ink`, com o ponto na cor da raia) e `.trilha-raia__resumo` (`text-xs`, `--ink-muted`; ex.: "12 etapas · 4 concluídas").
- **Recolhida** (`.trilha-raia--recolhida`): fica só o cabeçalho; `.trilha-raia__corpo` some; o chevron vira para a direita; o filete vira tracejado e a faixa ganha uma hachura leve na cor da raia ("tem coisa dobrada aqui dentro"). O componente esconde os nós da raia (`hidden: true`) e reduz a altura do nó da raia à do cabeçalho — CSS não altera altura de nó do @xyflow (é style inline).

## 6. A coluna de nível

- `.trilha-nivel`: uma faixa vertical por nível, largura = `--trilha-coluna-passo` (315px), posicionada por `--nivel` (o componente põe `style={{ "--nivel": n }}`; `left` sai do CSS). `.trilha-nivel--alternado` em níveis ímpares recebe `--trilha-nivel-fundo`; sem linha entre colunas (fora do Alto contraste), sem tique, sem eixo embaixo.
- A tinta anda **sempre para longe de `--ink`**: nos temas escuros é `surface-sunken` a 55% sobre `paper` (mais escuro), no Papel é `surface-raised` a 55% (mais claro). Assim o contraste de toda borda e flecha sobre a coluna **sobe** em vez de cair. No Alto contraste a coluna alternada é `surface` opaco com um traço `hairline` à esquerda (tinta não é sinal nesse tema; ver theme.css) — continua sem tique e sem número.
- `.trilha-nivel__rotulo`: dentro da coluna, canto de cima, caixa alta pequena, `--ink-muted`. Texto escrito pelo componente: **"raiz"** para o nível 0 (`.trilha-nivel--raiz` põe um ponto cheio antes), **"nível N"** para os demais. Nunca data.
- Reserve `--trilha-nivel-rotulo-altura` (26px) no topo do canvas para os rótulos não ficarem atrás da primeira raia.

## 7. Espaçamento mínimo

Réguas em `.trilha-canvas` (rem sobre a raiz de 15px; unidade do app = 3.75px). O layout em TypeScript espelha estes valores — leia com `getComputedStyle` ou copie com comentário apontando para o CSS.

| Régua | Valor | Por quê |
|---|---|---|
| `--trilha-etapa-largura` | 15rem = 225px | cabe um título de duas linhas em `text-sm` mais a marca |
| `--trilha-etapa-altura-min` | 4rem = 60px | título + meta + barra de progresso |
| `--trilha-gap-coluna` | **6rem = 90px** livres entre a borda direita de uma etapa e a esquerda da próxima coluna | mínimo para a curva bezier e a ponta de ~10px serem legíveis; abaixo disso a flecha vira um traço reto e a ponta cola na etapa |
| `--trilha-coluna-passo` | 21rem = 315px | largura + gap: a coluna n começa em `x = n · passo`; a etapa em `x = n · passo + gap/2` |
| `--trilha-gap-linha` | **1.5rem = 22.5px** entre etapas da mesma raia | menos que isso e as alças (10px, metade para fora) de etapas vizinhas quase se tocam |
| `--trilha-raia-cabecalho-altura` | 2.5rem = 37.5px | |
| `--trilha-alca-tamanho` | 10px | os 6px da lib somem no tema escuro |
| `--trilha-marca-tamanho` | 1.25rem = 18.75px | glifo de 11.25px dentro |

Gap entre raias: o `hairline` de 1px mais `--trilha-gap-linha` acima e abaixo da primeira/última etapa.

## 8. Cor por raia

Cinco tokens novos, declarados em `trilha.css` (um bloco por tema, mesma forma e mesma regra de ordem de `theme.css`): `--raia-azul`, `--raia-ciano`, `--raia-roxo`, `--raia-magenta`, `--raia-oliva`.

- **Por que não reaproveitar as cores de marca:** `mint` é "concluída", `terracotta` é "em ciclo", `amber` é "selecionado" (e o foco no tema padrão), `emerald` é o botão primário. Uma raia verde faria toda etapa disponível dela parecer concluída. As cinco famílias novas ficam fora dessas.
- **Ordem de ciclo recomendada** para raias novas: `azul, magenta, oliva, ciano, roxo` — vizinhas mais distantes em matiz (azul/roxo e roxo/magenta são os pares mais parecidos; a ordem os separa).
- **A cor da raia nunca é texto.** Nenhuma delas tem variante `-ink`; título e meta ficam em `--ink`/`--ink-muted` (≥ 4.5:1 por definição de theme.css). A cor da raia vai em borda, faixa, filete, ponto, alça e flecha — regra de 3:1, medida abaixo.
- Uma raia sem cor atribuída cai em `--border` (neutro, ≥ 3:1 em todo tema).

## 9. Contraste medido por tema

Método (reproduzível com qualquer calculadora WCAG a partir dos hex das tabelas): luminância relativa `L = 0.2126·R + 0.7152·G + 0.0722·B`, cada canal linearizado (`c ≤ 0.04045 → c/12.92`, senão `((c+0.055)/1.055)^2.4`); razão `(L_claro + 0.05) / (L_escuro + 0.05)`. `color-mix(in srgb, A p%, B)` replicado como `p·A + (1−p)·B` por canal em sRGB (é o que o espaço `srgb` faz — interpola as coordenadas gamma, não as lineares); mistura com `transparent` composta sobre `--paper`, que é o que está atrás do canvas. Os hex compostos aparecem nas tabelas para a conferência não depender de refazer a mistura. Calculado em 05/09/2026 e conferido com uma segunda implementação independente da fórmula: **300 pares, 0 abaixo da barra**. Mínimos: **3:1** para borda, aresta, alça e régua (**4.5:1** no Alto contraste); **4.5:1** para texto e glifo (**7:1** no Alto contraste).

Fundos por tema: `paper` (canvas), `surface` (etapa disponível), coluna de nível (composta), `sunken` (etapa bloqueada) e o fundo interno da etapa em cada estado.

### Borda, aresta e alça

#### ambar-noturno — mínimo 3:1 (borda, aresta, alça, régua)

Fundos: paper `#12100e` · surface `#1b1815` · coluna de nível `#0f0d0b` (sunken 55% sobre paper) · sunken `#0c0a09`

| Cor | hex | vs paper | vs surface | vs coluna de nível | vs sunken | dentro da etapa |
|---|---|---|---|---|---|---|
| `--raia-azul` | `#7fb2ff` | 8.78:1 | 8.18:1 | 8.97:1 | 9.14:1 | 6.65:1 (em andamento `#272a31`) |
| `--raia-ciano` | `#5cc8d8` | 9.68:1 | 9.01:1 | 9.89:1 | 10.07:1 | 7.22:1 (em andamento `#232d2c`) |
| `--raia-roxo` | `#b89cff` | 8.35:1 | 7.78:1 | 8.53:1 | 8.69:1 | 6.31:1 (em andamento `#2e2831`) |
| `--raia-magenta` | `#f090c8` | 8.61:1 | 8.02:1 | 8.80:1 | 8.96:1 | 6.52:1 (em andamento `#35262a`) |
| `--raia-oliva` | `#b9c26a` | 9.93:1 | 9.25:1 | 10.15:1 | 10.34:1 | 7.34:1 (em andamento `#2e2c1f`) |
| `--border` (disponível, bloqueada) | `#736553` | 3.36:1 | 3.13:1 | 3.43:1 | 3.50:1 | — |
| `--mint` (concluída) | `#6fcf97` | 9.99:1 | 9.30:1 | 10.20:1 | — | 7.75:1 (`#232a22`) |
| `--terracotta` (em ciclo) | `#e0705b` | 6.00:1 | 5.59:1 | 6.13:1 | — | 4.90:1 (`#2f211c`) |
| `--amber` (seleção) | `#e0a44e` | 8.67:1 | 8.07:1 | 8.86:1 | — | — |
| `--focus` (anel de foco) | `#e0a44e` | 8.67:1 | 8.07:1 | 8.86:1 | — | — |

#### papel — mínimo 3:1 (borda, aresta, alça, régua)

Fundos: paper `#f3ebdb` · surface `#fcf8ef` · coluna de nível `#faf6ef` (raised 55% sobre paper) · sunken `#e7dcc3`

| Cor | hex | vs paper | vs surface | vs coluna de nível | vs sunken | dentro da etapa |
|---|---|---|---|---|---|---|
| `--raia-azul` | `#2456c4` | 5.53:1 | 6.19:1 | 6.09:1 | 4.81:1 | 5.19:1 (em andamento `#e2e5ea`) |
| `--raia-ciano` | `#0d7186` | 4.76:1 | 5.32:1 | 5.24:1 | 4.14:1 | 4.51:1 (em andamento `#dfe8e2`) |
| `--raia-roxo` | `#6b3fc0` | 5.72:1 | 6.40:1 | 6.29:1 | 4.98:1 | 5.36:1 (em andamento `#ebe2e9`) |
| `--raia-magenta` | `#b0246e` | 5.33:1 | 5.96:1 | 5.87:1 | 4.64:1 | 4.95:1 (em andamento `#f3dfe0`) |
| `--raia-oliva` | `#5d7a15` | 4.16:1 | 4.65:1 | 4.58:1 | 3.62:1 | 4.01:1 (em andamento `#e9e9d5`) |
| `--border` (disponível, bloqueada) | `#8a7657` | 3.68:1 | 4.12:1 | 4.05:1 | 3.21:1 | — |
| `--mint` (concluída) | `#2a985d` | 3.08:1 | 3.45:1 | 3.39:1 | — | 3.08:1 (`#e7eee0`) |
| `--terracotta` (em ciclo) | `#b05a33` | 4.07:1 | 4.55:1 | 4.47:1 | — | 4.00:1 (`#f4e8dc`) |
| `--amber` (seleção) | `#b5771c` | 3.15:1 | 3.53:1 | 3.47:1 | — | — |
| `--focus` (anel de foco) | `#0f5b50` | 6.73:1 | 7.53:1 | 7.40:1 | — | — |

#### grafite — mínimo 3:1 (borda, aresta, alça, régua)

Fundos: paper `#141516` · surface `#1c1e21` · coluna de nível `#111213` (sunken 55% sobre paper) · sunken `#0e0f10`

| Cor | hex | vs paper | vs surface | vs coluna de nível | vs sunken | dentro da etapa |
|---|---|---|---|---|---|---|
| `--raia-azul` | `#7fb0f5` | 8.21:1 | 7.50:1 | 8.42:1 | 8.62:1 | 5.99:1 (em andamento `#28303a`) |
| `--raia-ciano` | `#5bc4d6` | 8.98:1 | 8.20:1 | 9.21:1 | 9.42:1 | 6.50:1 (em andamento `#243237`) |
| `--raia-roxo` | `#b49bf7` | 7.81:1 | 7.14:1 | 8.01:1 | 8.20:1 | 5.77:1 (em andamento `#2e2d3b`) |
| `--raia-magenta` | `#ee90c6` | 8.22:1 | 7.51:1 | 8.43:1 | 8.63:1 | 6.04:1 (em andamento `#352c35`) |
| `--raia-oliva` | `#b7c06c` | 9.38:1 | 8.57:1 | 9.62:1 | 9.84:1 | 6.76:1 (em andamento `#2f312a`) |
| `--border` (disponível, bloqueada) | `#676d74` | 3.50:1 | 3.20:1 | 3.59:1 | 3.67:1 | — |
| `--mint` (concluída) | `#6ccb93` | 9.23:1 | 8.43:1 | 9.47:1 | — | 6.98:1 (`#242f2c`) |
| `--terracotta` (em ciclo) | `#e07460` | 5.95:1 | 5.44:1 | 6.11:1 | — | 4.73:1 (`#302727`) |
| `--amber` (seleção) | `#d3a052` | 7.77:1 | 7.10:1 | 7.97:1 | — | — |
| `--focus` (anel de foco) | `#e9ebee` | 15.31:1 | 13.99:1 | 15.70:1 | — | — |

#### meia-noite — mínimo 3:1 (borda, aresta, alça, régua)

Fundos: paper `#0b1120` · surface `#121a2b` · coluna de nível `#080e1a` (sunken 55% sobre paper) · sunken `#060b15`

| Cor | hex | vs paper | vs surface | vs coluna de nível | vs sunken | dentro da etapa |
|---|---|---|---|---|---|---|
| `--raia-azul` | `#8dbcff` | 9.66:1 | 8.91:1 | 9.90:1 | 10.10:1 | 7.07:1 (em andamento `#212d44`) |
| `--raia-ciano` | `#6ad3e3` | 10.80:1 | 9.96:1 | 11.07:1 | 11.29:1 | 7.76:1 (em andamento `#1d3041`) |
| `--raia-roxo` | `#c2a9ff` | 9.34:1 | 8.62:1 | 9.57:1 | 9.76:1 | 6.87:1 (em andamento `#272b44`) |
| `--raia-magenta` | `#f59dd0` | 9.52:1 | 8.79:1 | 9.76:1 | 9.95:1 | 7.01:1 (em andamento `#2d2a3f`) |
| `--raia-oliva` | `#c4cc74` | 10.97:1 | 10.13:1 | 11.25:1 | 11.47:1 | 7.93:1 (em andamento `#272f34`) |
| `--border` (disponível, bloqueada) | `#74869f` | 5.07:1 | 4.68:1 | 5.20:1 | 5.30:1 | — |
| `--mint` (concluída) | `#7ee0a8` | 11.76:1 | 10.85:1 | 12.05:1 | — | 8.74:1 (`#1d2e38`) |
| `--terracotta` (em ciclo) | `#f07d66` | 7.02:1 | 6.48:1 | 7.20:1 | — | 5.65:1 (`#282431`) |
| `--amber` (seleção) | `#f0b457` | 10.20:1 | 9.41:1 | 10.45:1 | — | — |
| `--focus` (anel de foco) | `#8ab4f8` | 8.93:1 | 8.25:1 | 9.16:1 | — | — |

#### alto-contraste — mínimo 4.5:1 (borda, aresta, alça, régua)

Fundos: paper `#050505` · surface `#121212` · coluna de nível `#121212` (surface 100% sobre paper) · sunken `#000000`

| Cor | hex | vs paper | vs surface | vs coluna de nível | vs sunken | dentro da etapa |
|---|---|---|---|---|---|---|
| `--raia-azul` | `#9cc8ff` | 11.76:1 | 10.81:1 | 10.81:1 | 12.12:1 | 8.57:1 (em andamento `#23282e`) |
| `--raia-ciano` | `#7fe3f2` | 13.75:1 | 12.64:1 | 12.64:1 | 14.17:1 | 9.83:1 (em andamento `#1f2b2d`) |
| `--raia-roxo` | `#cdb6ff` | 11.39:1 | 10.46:1 | 10.46:1 | 11.73:1 | 8.34:1 (em andamento `#28262e`) |
| `--raia-magenta` | `#ffa8d9` | 11.51:1 | 10.58:1 | 10.58:1 | 11.86:1 | 8.46:1 (em andamento `#2e242a`) |
| `--raia-oliva` | `#d7e07f` | 14.42:1 | 13.25:1 | 13.25:1 | 14.86:1 | 10.15:1 (em andamento `#2a2b1f`) |
| `--border` (disponível, bloqueada) | `#c4c4c4` | 11.69:1 | 10.74:1 | 10.74:1 | 12.04:1 | — |
| `--mint` (concluída) | `#7df0ae` | 14.51:1 | 13.33:1 | 13.33:1 | — | 10.84:1 (`#1d2822`) |
| `--terracotta` (em ciclo) | `#ff8a6e` | 8.84:1 | 8.13:1 | 8.13:1 | — | 7.01:1 (`#2a1e1b`) |
| `--amber` (seleção) | `#ffc65c` | 13.09:1 | 12.03:1 | 12.03:1 | — | — |
| `--focus` (anel de foco) | `#ffeb3b` | 16.69:1 | 15.34:1 | 15.34:1 | — | — |

### Texto e glifo

#### ambar-noturno — mínimo 4.5:1 (texto e glifo de marca)

| Texto | Fundo | Razão |
|---|---|---|
| `--ink` (título) | surface (disponível) `#1b1815` | 14.39:1 |
| `--ink` (título) | em andamento, raia azul `#272a31` | 11.69:1 |
| `--ink` (título) | em andamento, raia ciano `#232d2c` | 11.52:1 |
| `--ink` (título) | em andamento, raia roxo `#2e2831` | 11.67:1 |
| `--ink` (título) | em andamento, raia magenta `#35262a` | 11.69:1 |
| `--ink` (título) | em andamento, raia oliva `#2e2c1f` | 11.42:1 |
| `--ink` (título) | concluída `#232a22` | 11.99:1 |
| `--ink` (título) | em ciclo `#2f211c` | 12.61:1 |
| `--ink-muted` (título bloqueada, meta) | sunken (bloqueada) `#0c0a09` | 7.33:1 |
| `--ink-muted` (meta, rótulo de nível) | surface `#1b1815` | 6.55:1 |
| `--ink-muted` (rótulo de nível) | coluna de nível `#0f0d0b` | 7.19:1 |
| `--ink` (título da raia) | paper `#12100e` | 15.45:1 |
| glifo ✓ `--mint-ink` | marca concluída `#283329` | 7.90:1 |
| glifo ↻ `--terracotta-ink` | marca em ciclo `#392520` | 6.02:1 |
| glifo ⊘ `--ink-muted` | marca bloqueada (sunken) `#0c0a09` | 7.33:1 |
| glifo ○ `--ink-muted` | marca disponível (surface) `#1b1815` | 6.55:1 |
| glifo ◐ `--ink` | marca em andamento, pior raia (oliva `#333222`) | 10.55:1 |

#### papel — mínimo 4.5:1 (texto e glifo de marca)

| Texto | Fundo | Razão |
|---|---|---|
| `--ink` (título) | surface (disponível) `#fcf8ef` | 16.97:1 |
| `--ink` (título) | em andamento, raia azul `#e2e5ea` | 14.24:1 |
| `--ink` (título) | em andamento, raia ciano `#dfe8e2` | 14.37:1 |
| `--ink` (título) | em andamento, raia roxo `#ebe2e9` | 14.20:1 |
| `--ink` (título) | em andamento, raia magenta `#f3dfe0` | 14.08:1 |
| `--ink` (título) | em andamento, raia oliva `#e9e9d5` | 14.63:1 |
| `--ink` (título) | concluída `#e7eee0` | 15.16:1 |
| `--ink` (título) | em ciclo `#f4e8dc` | 14.92:1 |
| `--ink-muted` (título bloqueada, meta) | sunken (bloqueada) `#e7dcc3` | 6.20:1 |
| `--ink-muted` (meta, rótulo de nível) | surface `#fcf8ef` | 7.97:1 |
| `--ink-muted` (rótulo de nível) | coluna de nível `#faf6ef` | 7.84:1 |
| `--ink` (título da raia) | paper `#f3ebdb` | 15.17:1 |
| glifo ✓ `--mint-ink` | marca concluída `#ddead9` | 5.28:1 |
| glifo ↻ `--terracotta-ink` | marca em ciclo `#f1e0d3` | 5.82:1 |
| glifo ⊘ `--ink-muted` | marca bloqueada (sunken) `#e7dcc3` | 6.20:1 |
| glifo ○ `--ink-muted` | marca disponível (surface) `#fcf8ef` | 7.97:1 |
| glifo ◐ `--ink` | marca em andamento, pior raia (magenta `#f1d8dc`) | 13.36:1 |

#### grafite — mínimo 4.5:1 (texto e glifo de marca)

| Texto | Fundo | Razão |
|---|---|---|
| `--ink` (título) | surface (disponível) `#1c1e21` | 13.99:1 |
| `--ink` (título) | em andamento, raia azul `#28303a` | 11.17:1 |
| `--ink` (título) | em andamento, raia ciano `#243237` | 11.08:1 |
| `--ink` (título) | em andamento, raia roxo `#2e2d3b` | 11.31:1 |
| `--ink` (título) | em andamento, raia magenta `#352c35` | 11.25:1 |
| `--ink` (título) | em andamento, raia oliva `#2f312a` | 11.03:1 |
| `--ink` (título) | concluída `#242f2c` | 11.58:1 |
| `--ink` (título) | em ciclo `#302727` | 12.17:1 |
| `--ink-muted` (título bloqueada, meta) | sunken (bloqueada) `#0e0f10` | 8.10:1 |
| `--ink-muted` (meta, rótulo de nível) | surface `#1c1e21` | 7.05:1 |
| `--ink-muted` (rótulo de nível) | coluna de nível `#111213` | 7.92:1 |
| `--ink` (título da raia) | paper `#141516` | 15.31:1 |
| glifo ✓ `--mint-ink` | marca concluída `#283832` | 7.13:1 |
| glifo ↻ `--terracotta-ink` | marca em ciclo `#392b2a` | 5.86:1 |
| glifo ⊘ `--ink-muted` | marca bloqueada (sunken) `#0e0f10` | 8.10:1 |
| glifo ○ `--ink-muted` | marca disponível (surface) `#1c1e21` | 7.05:1 |
| glifo ◐ `--ink` | marca em andamento, pior raia (oliva `#33362c`) | 10.31:1 |

#### meia-noite — mínimo 4.5:1 (texto e glifo de marca)

| Texto | Fundo | Razão |
|---|---|---|
| `--ink` (título) | surface (disponível) `#121a2b` | 15.90:1 |
| `--ink` (título) | em andamento, raia azul `#212d44` | 12.61:1 |
| `--ink` (título) | em andamento, raia ciano `#1d3041` | 12.39:1 |
| `--ink` (título) | em andamento, raia roxo `#272b44` | 12.68:1 |
| `--ink` (título) | em andamento, raia magenta `#2d2a3f` | 12.69:1 |
| `--ink` (título) | em andamento, raia oliva `#272f34` | 12.46:1 |
| `--ink` (título) | concluída `#1d2e38` | 12.81:1 |
| `--ink` (título) | em ciclo `#282431` | 13.86:1 |
| `--ink-muted` (título bloqueada, meta) | sunken (bloqueada) `#060b15` | 10.18:1 |
| `--ink-muted` (meta, rótulo de nível) | surface `#121a2b` | 8.98:1 |
| `--ink-muted` (rótulo de nível) | coluna de nível `#080e1a` | 9.98:1 |
| `--ink` (título da raia) | paper `#0b1120` | 17.23:1 |
| glifo ✓ `--mint-ink` | marca concluída `#22383e` | 8.45:1 |
| glifo ↻ `--terracotta-ink` | marca em ciclo `#332934` | 6.75:1 |
| glifo ⊘ `--ink-muted` | marca bloqueada (sunken) `#060b15` | 10.18:1 |
| glifo ○ `--ink-muted` | marca disponível (surface) `#121a2b` | 8.98:1 |
| glifo ◐ `--ink` | marca em andamento, pior raia (ciano `#1f3647`) | 11.46:1 |

#### alto-contraste — mínimo 7:1 (texto e glifo de marca)

| Texto | Fundo | Razão |
|---|---|---|
| `--ink` (título) | surface (disponível) `#121212` | 18.73:1 |
| `--ink` (título) | em andamento, raia azul `#23282e` | 14.85:1 |
| `--ink` (título) | em andamento, raia ciano `#1f2b2d` | 14.57:1 |
| `--ink` (título) | em andamento, raia roxo `#28262e` | 14.93:1 |
| `--ink` (título) | em andamento, raia magenta `#2e242a` | 14.98:1 |
| `--ink` (título) | em andamento, raia oliva `#2a2b1f` | 14.35:1 |
| `--ink` (título) | concluída `#1d2822` | 15.23:1 |
| `--ink` (título) | em ciclo `#2a1e1b` | 16.15:1 |
| `--ink-muted` (título bloqueada, meta) | sunken (bloqueada) `#000000` | 14.88:1 |
| `--ink-muted` (meta, rótulo de nível) | surface `#121212` | 13.27:1 |
| `--ink-muted` (rótulo de nível) | coluna de nível `#121212` | 13.27:1 |
| `--ink` (título da raia) | paper `#050505` | 20.38:1 |
| glifo ✓ `--mint-ink` | marca concluída `#223329` | 10.32:1 |
| glifo ↻ `--terracotta-ink` | marca em ciclo `#362420` | 7.73:1 |
| glifo ⊘ `--ink-muted` | marca bloqueada (sunken) `#000000` | 14.88:1 |
| glifo ○ `--ink-muted` | marca disponível (surface) `#121212` | 13.27:1 |
| glifo ◐ `--ink` | marca em andamento, pior raia (oliva `#303122`) | 13.22:1 |

Resultado: 300 pares medidos (60 por tema), 0 abaixo da barra. Os mais apertados — e os primeiros a quebrar se alguém "só clarear um pouco" um valor — são `--mint` sobre `paper` no Papel (3.08:1), `--border` sobre `surface` no Âmbar noturno (3.13:1), `--amber` sobre `paper` no Papel (3.15:1) e `--border` sobre `surface` no Grafite (3.20:1); das cores novas, a mais apertada é `--raia-oliva` sobre `sunken` no Papel (3.62:1).

## 10. Como validar a tela construída

1. `rg -n "#[0-9a-fA-F]{3,8}\b" src/features/trilha` — só os 25 hex dos blocos `--raia-*` em `trilha.css` (5 cores × 5 temas) e um `#999` citado em comentário. Nenhum em `.tsx`.
2. `rg -n "shadow-\[|box-shadow" src/features/trilha` — só `var(--shadow-hard-sm)`, `var(--shadow-hard)` ou `none`.
3. `rg -n "opacity" src/features/trilha` — nenhum uso para estado de etapa.
4. Troque `data-theme` na raiz pelos cinco ids. Em cada um: as cinco etapas se distinguem com o monitor em escala de cinza (Windows: filtro de cor → escala de cinza); a bloqueada continua óbvia.
5. Ponta de toda flecha tem a mesma cor do traço (se sair cinza, faltou `markerEnd.color`).
6. Tab pelo canvas: etapa e aresta focadas mostram anel `--focus`; Delete apaga só o que está em amber.
7. Nenhuma data, semana ou mês em rótulo de nível ou cabeçalho de raia.

## 11. Classes (contrato para o componente)

```
.trilha-canvas
.trilha-cor--azul
.trilha-cor--ciano
.trilha-cor--roxo
.trilha-cor--magenta
.trilha-cor--oliva
.trilha-nivel
.trilha-nivel--alternado
.trilha-nivel--raiz
.trilha-nivel__rotulo
.trilha-raia
.trilha-raia--recolhida
.trilha-raia__cabecalho
.trilha-raia__alternar
.trilha-raia__titulo
.trilha-raia__resumo
.trilha-raia__corpo
.trilha-etapa
.trilha-etapa--bloqueada
.trilha-etapa--disponivel
.trilha-etapa--em-andamento
.trilha-etapa--concluida
.trilha-etapa--em-ciclo
.trilha-etapa__titulo
.trilha-etapa__meta
.trilha-etapa__progresso
.trilha-aresta
.trilha-aresta--para-bloqueada
.trilha-aresta--para-concluida
.trilha-aresta--em-ciclo
```

Tokens novos (por tema): `--raia-azul`, `--raia-ciano`, `--raia-roxo`, `--raia-magenta`, `--raia-oliva`, `--trilha-nivel-fundo`, `--trilha-nivel-separador`. Variável lida por tudo: `--raia-cor`. Variáveis que o componente escreve em `style`: `--nivel` (em `.trilha-nivel`, inteiro ≥ 0) e `--progresso` (em `.trilha-etapa__progresso`, 0 a 100). Réguas: §7.
