import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useThemeStore } from "./lib/theme-store";
import "./styles/theme.css";

// Aplica o tema salvo antes do primeiro paint, não dentro de um efeito do
// React — senão a tela pisca no tema errado por um quadro.
useThemeStore.getState().init();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("elemento #root não encontrado em index.html — o app não tem onde montar");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
