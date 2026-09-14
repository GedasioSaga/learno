import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LimiteDeErroGlobal } from "./components/LimiteDeErroGlobal";
import { instalarRegistroDeErros } from "./lib/registro-de-erros";
import { useThemeStore } from "./lib/theme-store";
import "./styles/theme.css";

// Aplica o tema salvo antes do primeiro paint, não dentro de um efeito do
// React — senão a tela pisca no tema errado por um quadro.
useThemeStore.getState().iniciar();

// Antes de montar: um erro solto já durante a primeira renderização vai para o log.
instalarRegistroDeErros();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("elemento #root não encontrado em index.html — o app não tem onde montar");
}

const root = ReactDOM.createRoot(rootElement);

// Vitrine (`src/vitrine/`): rota de dev que troca o app real por uma tela
// com dados de fixture, para tirar screenshot sem precisar do backend Tauri
// (ver `src/vitrine/README.md`). `import.meta.env.DEV` faz este branch E o
// `import()` dinâmico da pasta inteira sumirem do bundle de produção — o
// `tauri build` nunca carrega `src/vitrine`.
const emModoVitrine = import.meta.env.DEV && new URLSearchParams(location.search).has("vitrine");

if (emModoVitrine) {
  void import("./vitrine").then(({ Vitrine }) => {
    root.render(
      <React.StrictMode>
        <Vitrine />
      </React.StrictMode>,
    );
  });
} else {
  root.render(
    <React.StrictMode>
      <LimiteDeErroGlobal>
        <App />
      </LimiteDeErroGlobal>
    </React.StrictMode>,
  );
}
