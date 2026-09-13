# Vitrine

Rota de desenvolvimento que renderiza telas do app com dados de fixture, sem
depender do backend Tauri — existe para um agente externo (ou qualquer
pessoa) tirar screenshot em viewport fixo e julgar o resultado por pixel, sem
precisar subir o app Tauri inteiro.

Só existe em `npm run dev` (`import.meta.env.DEV`): some do bundle de
produção, não muda nada do app real.

## Como abrir

```
npm run dev
```

Depois abra no navegador (a porta é a de `vite.config.ts`, hoje `1430`):

```
http://localhost:1430/?vitrine=cronograma-grade
http://localhost:1430/?vitrine=cronograma-colunas
http://localhost:1430/?vitrine=biblioteca-estante
```

Tema opcional via `?tema=<id>` (padrão `ambar-noturno`; ids válidos em
`src/styles/theme.css`):

```
http://localhost:1430/?vitrine=cronograma-grade&tema=papel
```

Sem `?vitrine=`, a URL abre o app normal — a vitrine nunca intercepta uma
navegação comum.

## Como adicionar um cenário

1. Leia o componente de feature que o cenário vai montar — a assinatura real
   de props, e se ele lê alguma store zustand.
2. Se ele ler uma store com busca automática no `useEffect` de montagem
   (`carregarX`/`load`), veja o campo de status dela (`xStatus`) e popule a
   store com esse campo já `"ready"` **antes** de devolver o JSX do
   `render` — nunca dentro de um `useEffect` do próprio cenário, porque o
   efeito do componente de feature roda primeiro (filho antes de pai) e
   ainda pegaria o status inicial, disparando a chamada de IPC real que a
   vitrine existe para evitar. Exemplo: `cronograma-grade` em
   `cenarios.tsx`.
3. Se o componente só lê de props, não precisa de nada além dos dados de
   fixture — exemplo: `cronograma-colunas` e `biblioteca-estante`.
4. Adicione a entrada em `CENARIOS` (`cenarios.tsx`) com um id em
   `kebab-case` e um `titulo` curto.
