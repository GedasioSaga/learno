import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useThemeStore } from "./lib/theme-store";
import "./styles/theme.css";

// Aplica o tema salvo antes do primeiro paint, não dentro de um efeito do
// React — senão a tela pisca no tema errado por um quadro.
useThemeStore.getState().iniciar();

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
      <App />
    </React.StrictMode>,
  );
}
