# Design tokens do Learno

Contrato do sistema visual. Quem for construir tela nova (a Fase 5 herda isto) usa **só** o que está aqui — nenhum hex fora de `src/styles/theme.css`, nenhuma sombra ou duração inventada no componente.

Fonte de verdade: `src/styles/theme.css`. Este documento descreve o que está lá e o porquê; se os dois discordarem, o CSS ganha e este arquivo está desatualizado.

## 1. Os cinco temas

| id (`data-theme`) | Nome | Aparência | Personalidade |
|---|---|---|---|
| `ambar-noturno` | Âmbar noturno | escura | **Padrão.** Quente, marrom-quase-preto, âmbar só como acento. Nasceu no escuro, não é o claro invertido. |
| `papel` | Papel | clara | Creme de papel, tinta marrom-escura, esmeralda como cor de ação. |
| `grafite` | Grafite | escura | Neutro, frio, cinza-azulado. Para quem acha o âmbar quente demais à noite. |
| `meia-noite` | Meia-noite | escura | Marinho profundo, texto e borda um degrau mais fortes que os outros escuros. |
| `alto-contraste` | Alto contraste | escura | Acessibilidade: ≥ 7:1 em todo texto, elevação só por borda, foco amarelo. |

Aliases legados: `light` → `papel`, `dark` → `ambar-noturno` (o `theme-store.ts` ainda escreve esses dois; saem quando ele migrar).

### Como o tema é aplicado

- Cada tema é um bloco `[data-theme="<id>"]` **sem** `:root` na frente. Assim um `<div data-theme="grafite">` no meio da página herda o bloco inteiro — é como a tela de Aparência pinta uma amostra real de cada tema sem repetir cor em TypeScript.
- O bloco padrão é `:root, [data-theme="ambar-noturno"], [data-theme="dark"]` e fica **no topo do arquivo**. `:root` e `[data-theme]` têm a mesma especificidade; é a ordem no arquivo que faz o tema escolhido vencer o padrão.
- Não existe `@media (prefers-color-scheme)` no CSS. "Seguir o sistema" é resolvido em JS, que escreve o id do tema claro ou escuro.
- `color-scheme` (barra de rolagem e controle nativo da WebView2) é **aplicado só em `html`**, a partir de `--color-scheme-do-tema`. Uma amostra escura dentro de uma página clara troca as cores, não os controles nativos.

## 2. Tabela de tokens por tema

Todos os valores em hex. Coluna "papel" = função do token (seção 3).

| Token | Papel | ambar-noturno | papel | grafite | meia-noite | alto-contraste |
|---|---|---|---|---|---|---|
| `--paper` | fundo da janela | `#12100E` | `#F3EBDB` | `#141516` | `#0B1120` | `#050505` |
| `--surface` | card, painel | `#1B1815` | `#FCF8EF` | `#1C1E21` | `#121A2B` | `#121212` |
| `--surface-sunken` | barra lateral, código, área rebaixada | `#0C0A09` | `#E7DCC3` | `#0E0F10` | `#060B15` | `#000000` |
| `--surface-raised` | linha em hover, chip, um degrau acima do card | `#24201B` | `#FFFFFF` | `#25282C` | `#1A2438` | `#1C1C1C` |
| `--hairline` | divisor decorativo (< 3:1, de propósito) | `#2E2823` | `#D9CBAE` | `#2B2F33` | `#223049` | `#707070` |
| `--border` | borda de controle (≥ 3:1) | `#736553` | `#8A7657` | `#676D74` | `#74869F` | `#C4C4C4` |
| `--ink` | texto principal | `#EFE7D8` | `#1E150C` | `#E9EBEE` | `#F2F5FA` | `#FFFFFF` |
| `--ink-muted` | texto secundário, rótulo, metadado | `#A99C86` | `#5C4A35` | `#A3A9B1` | `#B0BBCF` | `#D9D9D9` |
| `--amber` | acento de marca: ícone, borda, selo | `#E0A44E` | `#B5771C` | `#D3A052` | `#F0B457` | `#FFC65C` |
| `--amber-ink` | texto de aviso | `#E8B265` | `#7B5015` | `#DDB06A` | `#F5C470` | `#FFD27A` |
| `--mint` | ícone/selo de sucesso | `#6FCF97` | `#2A985D` | `#6CCB93` | `#7EE0A8` | `#7DF0AE` |
| `--mint-ink` | texto de sucesso | `#86DAA8` | `#1B6A43` | `#84D6A5` | `#90E8B5` | `#9CF5C0` |
| `--emerald` | fundo do botão primário, indicador de soltar | `#1D7864` | `#0F5B50` | `#1F7B6B` | `#1A7E6A` | `#2ED2AD` |
| `--on-emerald` | texto sobre `emerald` | `#FBF6EA` | `#FBF5E6` | `#F2F4F5` | `#F6F9FF` | `#000000` |
| `--terracotta` | ícone/borda de erro | `#E0705B` | `#B05A33` | `#E07460` | `#F07D66` | `#FF8A6E` |
| `--terracotta-ink` | texto de erro/alerta | `#EE8E7B` | `#8A3F1B` | `#EF9280` | `#F89D8A` | `#FFA592` |
| `--brown` | decorativo (ilustração, marca) | `#9A7A5C` | `#7D3912` | `#8E8074` | `#A48B70` | `#CFAE92` |
| `--focus` | anel de foco e seleção de texto | `#E0A44E` | `#0F5B50` | `#E9EBEE` | `#8AB4F8` | `#FFEB3B` |
| `--shadow-ink` | cor da sombra | `rgb(0 0 0 / 55%)` | `rgb(40 24 8 / 18%)` | `rgb(0 0 0 / 55%)` | `rgb(0 0 0 / 60%)` | `transparent` |
| `--shadow-glow` | fio de luz na aresta de cima | `rgb(255 255 255 / 5%)` | `rgb(255 255 255 / 60%)` | `rgb(255 255 255 / 6%)` | `rgb(255 255 255 / 6%)` | `transparent` |
| `--color-scheme-do-tema` | controles nativos | `dark` | `light` | `dark` | `dark` | `dark` |

Utilitários Tailwind gerados (via `@theme`): `bg-/text-/border-/outline-/ring-` + `paper`, `surface`, `surface-sunken`, `surface-raised`, `hairline`, `border`, `ink`, `ink-muted`, `amber`, `amber-ink`, `mint`, `mint-ink`, `emerald`, `terracotta`, `terracotta-ink`, `brown`, `on-emerald`, `focus`. Modificador de opacidade funciona (`bg-amber/10`, `bg-ink/40`).

### 2.1 Contraste medido

Razão WCAG 2.x, calculada (não estimada) sobre os hex acima. Barra: texto ≥ 4.5:1 (alto contraste ≥ 7:1); borda, ícone, botão e foco ≥ 3:1. **Nenhum par abaixo da barra em nenhum tema.**

**Âmbar noturno**

| Par | Razão | Barra |
|---|---|---|
| ink / paper | 15.45:1 | 4.5 |
| ink / surface | 14.39:1 | 4.5 |
| ink / surface-sunken | 16.08:1 | 4.5 |
| ink-muted / paper | 7.04:1 | 4.5 |
| ink-muted / surface | 6.55:1 | 4.5 |
| ink-muted / surface-sunken | 7.33:1 | 4.5 |
| amber-ink / paper · surface | 9.93:1 · 9.25:1 | 4.5 |
| mint-ink / paper · surface | 11.40:1 · 10.61:1 | 4.5 |
| terracotta-ink / paper · surface | 7.95:1 · 7.40:1 | 4.5 |
| on-emerald / emerald | 4.96:1 | 4.5 |
| border / surface · paper · sunken | 3.13:1 · 3.36:1 · 3.50:1 | 3 |
| amber / surface (ícone) | 8.07:1 | 3 |
| mint / surface (ícone) | 9.30:1 | 3 |
| terracotta / surface (ícone) | 5.59:1 | 3 |
| emerald / surface · paper (botão) | 3.30:1 · 3.55:1 | 3 |
| focus / paper · surface · sunken | 8.67:1 · 8.07:1 · 9.02:1 | 3 |
| hairline / surface (informativo) | 1.22:1 | — |

**Papel**

| Par | Razão | Barra |
|---|---|---|
| ink / paper | 15.17:1 | 4.5 |
| ink / surface | 16.97:1 | 4.5 |
| ink / surface-sunken | 13.21:1 | 4.5 |
| ink-muted / paper | 7.13:1 | 4.5 |
| ink-muted / surface | 7.97:1 | 4.5 |
| ink-muted / surface-sunken | 6.20:1 | 4.5 |
| amber-ink / paper · surface | 5.90:1 · 6.60:1 | 4.5 |
| mint-ink / paper · surface | 5.56:1 · 6.21:1 | 4.5 |
| terracotta-ink / paper · surface | 6.31:1 · 7.06:1 | 4.5 |
| on-emerald / emerald | 7.33:1 | 4.5 |
| border / surface · paper · sunken | 4.12:1 · 3.68:1 · 3.21:1 | 3 |
| amber / surface (ícone) | 3.53:1 | 3 |
| mint / surface (ícone) | 3.45:1 | 3 |
| terracotta / surface (ícone) | 4.55:1 | 3 |
| emerald / surface · paper (botão) | 7.53:1 · 6.73:1 | 3 |
| focus / paper · surface · sunken | 6.73:1 · 7.53:1 · 5.86:1 | 3 |
| hairline / surface (informativo) | 1.51:1 | — |

**Grafite**

| Par | Razão | Barra |
|---|---|---|
| ink / paper | 15.31:1 | 4.5 |
| ink / surface | 13.99:1 | 4.5 |
| ink / surface-sunken | 16.06:1 | 4.5 |
| ink-muted / paper | 7.72:1 | 4.5 |
| ink-muted / surface | 7.05:1 | 4.5 |
| ink-muted / surface-sunken | 8.10:1 | 4.5 |
| amber-ink / paper · surface | 9.14:1 · 8.35:1 | 4.5 |
| mint-ink / paper · surface | 10.57:1 · 9.66:1 | 4.5 |
| terracotta-ink / paper · surface | 7.92:1 · 7.23:1 | 4.5 |
| on-emerald / emerald | 4.64:1 | 4.5 |
| border / surface · paper · sunken | 3.20:1 · 3.50:1 · 3.67:1 | 3 |
| amber / surface (ícone) | 7.10:1 | 3 |
| mint / surface (ícone) | 8.43:1 | 3 |
| terracotta / surface (ícone) | 5.44:1 | 3 |
| emerald / surface · paper (botão) | 3.26:1 · 3.57:1 | 3 |
| focus / paper · surface · sunken | 15.31:1 · 13.99:1 · 16.06:1 | 3 |
| hairline / surface (informativo) | 1.24:1 | — |

**Meia-noite**

| Par | Razão | Barra |
|---|---|---|
| ink / paper | 17.23:1 | 4.5 |
| ink / surface | 15.90:1 | 4.5 |
| ink / surface-sunken | 18.02:1 | 4.5 |
| ink-muted / paper | 9.73:1 | 4.5 |
| ink-muted / surface | 8.98:1 | 4.5 |
| ink-muted / surface-sunken | 10.18:1 | 4.5 |
| amber-ink / paper · surface | 11.67:1 · 10.77:1 | 4.5 |
| mint-ink / paper · surface | 12.91:1 · 11.91:1 | 4.5 |
| terracotta-ink / paper · surface | 9.13:1 · 8.43:1 | 4.5 |
| on-emerald / emerald | 4.70:1 | 4.5 |
| border / surface · paper · sunken | 4.68:1 · 5.07:1 · 5.30:1 | 3 |
| amber / surface (ícone) | 9.41:1 | 3 |
| mint / surface (ícone) | 10.85:1 | 3 |
| terracotta / surface (ícone) | 6.48:1 | 3 |
| emerald / surface · paper (botão) | 3.51:1 · 3.80:1 | 3 |
| focus / paper · surface · sunken | 8.93:1 · 8.25:1 · 9.34:1 | 3 |
| hairline / surface (informativo) | 1.31:1 | — |

**Alto contraste** (barra de texto: 7:1)

| Par | Razão | Barra |
|---|---|---|
| ink / paper | 20.38:1 | 7 |
| ink / surface | 18.73:1 | 7 |
| ink / surface-sunken | 21.00:1 | 7 |
| ink-muted / paper | 14.44:1 | 7 |
| ink-muted / surface | 13.27:1 | 7 |
| ink-muted / surface-sunken | 14.88:1 | 7 |
| amber-ink / paper · surface | 14.32:1 · 13.16:1 | 7 |
| mint-ink / paper · surface | 15.76:1 · 14.48:1 | 7 |
| terracotta-ink / paper · surface | 10.72:1 · 9.86:1 | 7 |
| on-emerald / emerald | 10.94:1 | 7 |
| border / surface · paper · sunken | 10.74:1 · 11.69:1 · 12.04:1 | 3 |
| amber / surface (ícone) | 12.03:1 | 3 |
| mint / surface (ícone) | 13.33:1 | 3 |
| terracotta / surface (ícone) | 8.13:1 | 3 |
| emerald / surface · paper (botão) | 9.76:1 · 10.62:1 | 3 |
| focus / paper · surface · sunken | 16.69:1 · 15.34:1 · 17.20:1 | 3 |
| hairline / surface | 3.78:1 | — (aqui até o divisor passa de 3:1, de propósito) |

Os pares mais apertados do sistema — e os primeiros a quebrar se alguém "só clarear um pouco" um valor: `border / surface` no Âmbar noturno (3.13:1), `emerald / surface` no Grafite (3.26:1), `on-emerald / emerald` no Grafite (4.64:1) e `mint / surface` no Papel (3.45:1). **Ao mudar qualquer hex, recalcule.**

## 3. Quando usar cada token

| Preciso de… | Use | Não use |
|---|---|---|
| Fundo da janela, da área principal | `bg-paper` | `bg-surface` (é para o card em cima do papel) |
| Card, painel, diálogo, popover, menu | `bg-surface` + `border-border` | `bg-paper` dentro de card (perde o degrau) |
| Barra lateral, campo de código, campo de entrada, área "afundada" | `bg-surface-sunken` | `bg-ink/5` improvisado |
| Linha em hover, chip, opção selecionada em lista | `bg-surface-raised` | mudar `bg-surface` de opacidade |
| Borda de botão, campo, card | `border-border` | `border-hairline` (fica invisível como controle) |
| Divisor entre seções, linha de tabela, traço decorativo | `border-hairline` | `border-border` (vira grade pesada) |
| Texto principal | `text-ink` | preto/branco puro |
| Rótulo, metadado, placeholder, atalho de teclado | `text-ink-muted` | `text-ink/60` (opacidade não é medida; o token é) |
| Erro, alerta, ação destrutiva (texto) | `text-terracotta-ink` | `text-terracotta` como texto (é ícone, 3:1) |
| Erro (ícone, borda de campo inválido) | `text-terracotta`, `border-terracotta` | |
| Sucesso (texto) / (ícone, selo) | `text-mint-ink` / `text-mint`, `bg-mint` | |
| Aviso (texto) / (ícone, selo, fundo suave) | `text-amber-ink` / `text-amber`, `bg-amber/10` | `text-amber` como texto no tema Papel (3.5:1, abaixo de 4.5) |
| Botão primário | `bg-emerald text-on-emerald` | `bg-amber` (o acento não é a cor de ação) |
| Indicador de soltar no arrasto | `bg-emerald` | |
| Anel de foco | herdado de `:focus-visible` (não estilize); se precisar, `outline-focus` | `outline-emerald` |
| Sombra de botão/card | `shadow-hard-sm` | sombra inline |
| Sombra de coisa flutuando | `shadow-hard` | |
| Ícone decorativo de marca, ilustração | `text-brown`, `text-amber` | |

Regras que valem sempre:

- **Texto usa `-ink`; ícone e borda usam a cor pura.** A cor pura de marca mira 3:1; a variante `-ink` mira 4.5:1 (7:1 no alto contraste). Trocar uma pela outra é o jeito mais fácil de ferir a barra sem o compilador avisar.
- **Fundo suave de selo é a cor pura com opacidade** (`bg-amber/10`, `bg-terracotta/10`) e o texto por cima é a `-ink` da mesma família. Não medimos o par "texto sobre fundo/10" porque ele muda com o fundo de trás; por isso a opacidade máxima de fundo suave é 15%.
- **`--focus` é o único token que pode mudar de família entre temas.** Âmbar no padrão, esmeralda no Papel, quase-branco no Grafite, azul no Meia-noite, amarelo no Alto contraste. Não use `focus` para nada além de foco e seleção de texto.

## 4. Escala tipográfica

Fonte de interface: `--font-sans` (nativa do SO: Segoe UI no Windows). Títulos: `--font-display` (serifada nativa). Não baixamos fonte: app offline-first.

Raiz em **15px** (`html { font-size: 15px }`). A escala é a padrão do Tailwind, que é em `rem`, então os valores reais são:

| Utilitário | rem | px reais | Uso |
|---|---|---|---|
| `text-xs` | 0.75 | 11.25 | atalho de teclado, contador, carimbo de data |
| `text-sm` | 0.875 | 13.125 | UI densa: barra lateral, menu, botão, rótulo |
| `text-base` | 1 | 15 | corpo do editor, diálogo, texto corrido |
| `text-lg` | 1.125 | 16.875 | título de card, nome de página na barra |
| `text-xl` | 1.25 | 18.75 | H3 do editor |
| `text-2xl` | 1.5 | 22.5 | H2 do editor, título de diálogo |
| `text-3xl` | 1.875 | 28.125 | H1 do editor, título de página |

- Entrelinha do corpo: `1.55` (definido em `body`). Título usa `leading-tight`.
- **Largura máxima de leitura: `max-width: var(--measure)` = 65ch.** Prosa (editor, texto explicativo de diálogo) não passa disso; tabela, barra lateral e toolbar ignoram a régua.
- Não crie tamanho fora da escala. Se `text-sm` está grande e `text-xs` pequeno, o problema é outro (peso, cor, espaço), não o tamanho.

## 5. Régua de espaçamento

Escala padrão do Tailwind (`--spacing: 0.25rem`), que na raiz de 15px dá **3.75px por unidade**:

| Unidade | px reais | Uso típico |
|---|---|---|
| `1` | 3.75 | gap entre ícone e texto num chip; padding de item de menu na vertical |
| `2` | 7.5 | padding de botão pequeno; gap entre controles numa toolbar |
| `3` | 11.25 | padding interno de popover, de item de lista |
| `4` | 15 | padding de card, de diálogo pequeno; margem entre blocos |
| `6` | 22.5 | padding de diálogo grande; separação entre seções |
| `8` | 30 | respiro em cima/embaixo de uma tela |

- Alvo mínimo de clique/toque: **`--hit-min` = 44px**. Um botão de ícone pode desenhar `size-6`; a área que reage (padding, pseudo-elemento) não pode ficar abaixo de 44px onde houver uso com mouse impreciso ou tela sensível ao toque.
- Alinhe em múltiplos da unidade; `px` solto (`mt-[7px]`) só com comentário do porquê.

## 6. Raios

Padrão do Tailwind v4, sem sobrescrita:

| Utilitário | Valor | Uso |
|---|---|---|
| `rounded-sm` | 0.25rem (3.75px) | botão, chip, item de menu, campo — o raio "de trabalho" do app |
| `rounded-md` | 0.375rem (5.6px) | diálogo, popover, card grande |
| `rounded-full` | — | botão flutuante circular, avatar, indicador |

O app é "cozy, mas ferramenta": raio pequeno. `rounded-lg`/`rounded-xl` não entram em controle; no máximo em ilustração ou card de boas-vindas.

## 7. Níveis de elevação

Os nomes `shadow-hard` e `shadow-hard-sm` ficaram por compatibilidade (16 usos em JSX). **A sombra dura de 2px/4px sem blur saiu**; o que os nomes significam hoje:

| Nível | Utilitário | Receita | Quando |
|---|---|---|---|
| 0 — no papel | (nada) | fundo `paper`, sem borda | área principal, conteúdo do editor |
| 0.5 — rebaixado | `bg-surface-sunken` | fundo mais escuro (ou mais claro, no Papel), sem sombra | barra lateral, código, campo |
| 1 — controle | `bg-surface border-border shadow-hard-sm` | `0 1px 2px var(--shadow-ink)` | botão, card, chip, linha arrastável |
| 1.5 — erguido | `bg-surface-raised` | um degrau mais claro, sem sombra nova | hover em linha, opção ativa em lista |
| 2 — flutuando | `bg-surface border-border shadow-hard` | `inset 0 1px 0 var(--shadow-glow)` + `0 4px 12px -2px` + `0 16px 40px -12px` de `--shadow-ink` | diálogo, popover, menu de contexto, paleta de busca |

Por que assim:

- **No escuro, sombra preta some contra fundo preto.** Por isso a sombra escura é mais opaca (55–60%) e mais difusa, e o nível 2 ganha um fio de luz na aresta de cima (`--shadow-glow`). É esse fio, mais a borda 3:1, que diz "isto está acima" quando a sombra em si mal aparece.
- **No Papel a sombra é marrom translúcida (18%)**, não preta: sombra preta sobre creme fica suja. O fio de luz é quase branco, dá o "verniz" na borda de cima sem parecer plástico.
- **No Alto contraste não existe sombra** (`--shadow-ink: transparent`). Elevação é só borda, e a borda tem 10:1.
- **Nunca use sombra para separar irmãos** (card do card, linha da linha). Sombra é para o eixo Z; para o eixo X/Y existem `hairline` e `gap`.

## 8. Os seis estados de um controle

Todo controle (botão, item de menu, linha de lista, chip, campo) tem os seis estados abaixo. Cada estado se expressa **só** com token; nada de cor nova por componente.

| Estado | Como se expressa | Token/utilitário |
|---|---|---|
| **Repouso** | superfície, borda de controle, texto principal, sombra nível 1 | `bg-surface border-border text-ink shadow-hard-sm` |
| **Hover** | sobe um degrau: fundo `raised` **ou** `-translate-y-px` (não os dois); texto de `muted` para `ink` se era secundário | `hover:bg-surface-raised` · `hover:-translate-y-px` · `hover:text-ink` |
| **Foco (teclado)** | anel de 2px, offset 2px, cor `--focus`. **Herdado do `:focus-visible` global — não sobrescreva.** Nada mais muda, para o anel ser a única diferença | (automático) · `outline-focus` só se precisar de raio/offset diferente |
| **Pressionado** | encolhe para `scale(0.97)` e perde a sombra: o botão "afunda" sob o dedo | `active:scale-97 active:shadow-none` (`active:translate-y-0` se usou o lift no hover) |
| **Desabilitado** | opacidade 50%, cursor padrão, sem hover/press | `disabled:opacity-50 disabled:pointer-events-none` — nunca só `text-ink-muted` (parece secundário, não desligado) |
| **Selecionado / ativo** | fundo `raised` fixo + texto `ink`; se há um item ativo entre vários, o acento entra como **borda ou indicador**, não como fundo | `bg-surface-raised text-ink` (+ `border-l-2 border-amber` ou similar) |

Combinações: hover + selecionado não empilham — selecionado vence. Foco + qualquer outro: o anel se soma. Desabilitado cancela hover, foco visível de mouse e pressionado.

Botão **primário** (`bg-emerald text-on-emerald`) segue a mesma tabela, exceto que hover é `brightness-110` (não existe "emerald-raised") e o anel de foco precisa de `outline-offset: 2px` para não colar no verde — já é o padrão global.

Erro em campo: `border-terracotta` + mensagem em `text-terracotta-ink` **abaixo** do campo, com `aria-describedby`. Não mude o fundo do campo.

## 9. Movimento

Regras adotadas da skill `emil-kowalski-ui-craft`, como restrição, não preferência. Os tokens vivem em `:root` (para CSS puro) e as curvas em `@theme` (para os utilitários `ease-out`/`ease-in-out`).

| Token | Valor | Uso |
|---|---|---|
| `--motion-fast` | 120ms | ação de alta frequência: hover, press, tooltip depois do primeiro |
| `--motion-base` | 180ms | entrada/saída de popover, menu, toast |
| `--motion-slow` | 240ms | diálogo grande, painel lateral abrindo |
| `--motion-scale-in` | 0.95 | escala inicial de entrada |
| `--motion-scale-press` | 0.97 | escala de pressionado |
| `ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | **entrada e saída** da tela |
| `ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | **movimento na tela** (reordenar, deslizar) |

As regras, com o porquê:

1. **Primeiro pergunte se deve animar.** Animação serve para dar feedback (press), explicar (de onde veio), manter continuidade espacial (drawer entra do lado em que vive) ou um raro deleite. Se não é nenhum dos quatro, **não anima**. "Nenhuma animação é melhor que uma animação ruim."
2. **Ação de alta frequência não anima** (ou anima em `--motion-fast`, no máximo). O menu que abre trinta vezes por hora vira atraso percebido na décima. Por isso o `PageContextMenu` e o `EmojiIconPicker` entram em 150ms e **fecham sem transição** — sumir é instantâneo.
3. **Ação iniciada por teclado não anima.** Parece desconectada e lenta. Atalho que abre a paleta: aparece; não escala.
4. **Tudo abaixo de 300ms.** 180ms costuma parecer melhor que 400ms; a percepção de "lento" começa bem antes de o olho conseguir apreciar a curva.
5. **Entrada/saída é sempre `ease-out`; `ease-in` nunca, em UI.** Ease-in atrasa o início e o usuário lê como travamento. Movimento na tela (um bloco que troca de lugar) é `ease-in-out`.
6. **Entrada nasce em `scale(0.95)`, nunca em `0`.** Pular do nada é o que faz a animação parecer barata. Popover: `opacity 0 → 1` e `scale 0.95 → 1`, com `transform-origin` no ponto de onde ele abriu.
7. **Pressionado é `scale(0.97)`.** O suficiente para responder, pouco o bastante para o texto não pular.
8. **Anime só `transform`, `opacity` e `clip-path`.** Os três não causam reflow. `height`, `width`, `top`, `margin` — nunca; para revelar sem mexer no layout, use `clip-path: inset()`.
9. **Segundo tooltip não re-anima.** Se um tooltip acabou de fechar e outro abre, o segundo entra instantâneo (`transition-duration: 0ms`). Delay e animação são para o primeiro.
10. **`prefers-reduced-motion: reduce` zera tudo**, globalmente, em `@layer base`. Duração vai a `0.01ms` (não `0`) para `transitionend`/`animationend` ainda dispararem — código que espera o fim de uma transição para desmontar um elemento não pode ficar pendurado. Componentes podem reforçar com `motion-reduce:transition-none`, mas não precisam.
11. **Interrupção precisa se recuperar.** Se o usuário fecha no meio da entrada, o estado final é "fechado", sem completar a animação de abrir. O `useOpenTransition` faz isso: `open=false` derruba `entered` no mesmo quadro.

## 10. Como validar uma tela nova contra este contrato

1. Nenhum hex, `rgb()` ou `oklch()` no componente: `rg -n "#[0-9a-fA-F]{3,8}\b|rgb\(|oklch\(" src/features/<tela>`. Exceção: `option-colors.css` (cores de etiqueta de banco de dados, sistema próprio).
2. Nenhuma sombra fora de `shadow-hard`/`shadow-hard-sm`: `rg -n "shadow-\[|box-shadow" src/features/<tela>`.
3. Nenhuma duração acima de 300ms: `rg -n "duration-[3-9][0-9]{2}|[3-9][0-9]{2}ms" src/features/<tela>`.
4. Nenhum `ease-in\b` (sem `-out`): `rg -n "ease-in[^-]" src/features/<tela>`.
5. Troque `data-theme` na raiz pelos cinco ids e olhe a tela em cada um. O que ficou invisível num tema era cor fora do contrato.
6. Tab pela tela inteira: todo controle mostra o anel de `--focus`; nenhum some.
7. Ative "reduzir movimento" no Windows (Acessibilidade → Efeitos visuais → Efeitos de animação) e abra menus e diálogos: nada anima.
