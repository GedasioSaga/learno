# Learno

App desktop de estudo: notas em blocos, repetição espaçada (FSRS), cloze, mapa mental, biblioteca, cronograma e finanças — tudo local, num banco SQLite na sua máquina.

Feito com [Tauri 2](https://tauri.app) (núcleo Rust + React/TypeScript) e um sidecar Python para importação de `.apkg`.

## Instalar

1. Abra a [página do último release](https://github.com/GedasioSaga/learno/releases/latest).
2. Baixe `learno_x.y.z_x64-setup.exe` e execute.

O Windows SmartScreen pode avisar que o instalador não é assinado com certificado de editor — clique em **Mais informações → Executar assim mesmo**.

## Atualizações

O Learno confere o GitHub a cada abertura. Quando existe versão nova aparece um aviso no canto inferior direito; **Atualizar agora** baixa o instalador, instala e reinicia o app. Os seus dados ficam onde estão.

A atualização é verificada por assinatura (minisign): o app só instala um pacote assinado pela chave deste projeto.

## Desenvolvimento

Pré-requisitos: Node LTS, Rust stable, Python 3.12.

```bash
npm install
# sidecar (uma vez, e sempre que mudar sidecar/)
cd sidecar && pip install -e ".[dev]" && pyinstaller learno_sidecar.spec && cd ..
mkdir -p src-tauri/binaries
cp sidecar/dist/learno-sidecar.exe src-tauri/binaries/learno-sidecar-x86_64-pc-windows-msvc.exe

npm run tauri dev      # app em modo desenvolvimento
npm test               # testes do frontend (vitest)
cd src-tauri && cargo test
```

Detalhes do sidecar em [`sidecar/README.md`](sidecar/README.md); testes e2e em [`docs/e2e.md`](docs/e2e.md).

## Publicar uma versão

```powershell
.\scripts\publicar.ps1 -Versao 0.2.0
```

O script roda os testes, sobe a versão em `tauri.conf.json` / `Cargo.toml` / `package.json`, commita, cria a tag `v0.2.0` e dá push. A tag dispara `.github/workflows/release.yml`, que empacota o sidecar, gera o instalador NSIS assinado e publica o release com o `latest.json` que os apps instalados consultam.
