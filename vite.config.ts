import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  //
  // 1430, não a 1420 que é o padrão do Tauri: outro projeto desta máquina
  // (`C:\dev\Projeto Genesis\ui`) também é Tauri e já ocupa a 1420 com
  // `strictPort`. Com os dois no padrão, subir um derrubava o `npm run dev`
  // do outro — e, pior, o `learno.exe` de desenvolvimento chegava a abrir
  // renderizando o WebView2 do OUTRO app, porque ele só pede a URL e não
  // tem como saber quem respondeu. Foi assim que a suíte e2e falhou uma vez,
  // com um diagnóstico que não parecia ter nada a ver com o Learno.
  //
  // Este número aparece em TRÊS lugares que precisam concordar:
  // aqui, em `src-tauri/tauri.conf.json` (`devUrl`, que o Tauri assa no
  // binário de dev) e em `e2e/wdio.conf.mjs` (`DEV_SERVER_URL`). Mudar um
  // sem os outros faz o app abrir numa tela em branco.
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Acima do `asyncUtilTimeout` de `src/test/setup.ts` (5 s), para que um
    // `findBy` que não acha nada falhe com a mensagem dele, e não com um
    // "Test timed out" genérico. O teste mais lento mede ~2 s com duas
    // suítes inteiras rodando ao mesmo tempo; o padrão de 5 s ficava apertado
    // quando o `cargo build` disputava a CPU.
    testTimeout: 15000,
    // Só `formatting-buttons.test.tsx` lê CSS de arquivo (a fonte e o fundo
    // de `<code>` em `basic-marks.css`). Processar os outros ~40 `.css` com o
    // Tailwind custava CPU em todo worker sem provar nada: medido em
    // 13/09/2026, transform somado 30 s -> 24 s e import 97 s -> 66 s. Um
    // teste novo que dependa de outro `.css` precisa entrar nesta lista.
    //
    // Sem `maxWorkers` de propósito: duas suítes inteiras simultâneas (40
    // workers em 20 CPUs) passaram 2226/2226, e limitar os workers deixaria
    // mais lenta a rodada de todo dia.
    css: { include: [/basic-marks\.css$/] },
  },
});
