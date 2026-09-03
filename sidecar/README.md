# Sidecar Python do Learno

Processo Python 3.12 empacotado com PyInstaller, iniciado pelo núcleo Rust via
`tauri-plugin-shell`. Fala com o Rust por stdio: uma linha JSON por mensagem,
em ambas as direções. Fase 1 (PLT-003) construiu o transporte e o
health-check; PLT-004 ligou a primeira ponte de verdade — `apkg.import` — ao
comando `ipc::commands::import_apkg`, subido e encerrado pelo `tauri::Builder`
de `lib.rs`. FSRS e leitura de PDF chegam do mesmo jeito: só um novo handler
em `learno_sidecar/handlers/` e uma nova chamada `SidecarProcess::call`, sem
tocar no transporte.

## Protocolo

Requisição (Rust → sidecar), uma linha:

```json
{"id": "a1b2c3", "method": "health.check", "params": {}}
```

Resposta de sucesso:

```json
{"id": "a1b2c3", "ok": true, "result": {"version": "0.1.0", "capabilities": ["health.check"]}}
```

Resposta de erro:

```json
{"id": "a1b2c3", "ok": false, "error": {"code": "method_not_found", "message": "unknown method: nope"}}
```

`id` é um identificador de correlação gerado pelo lado Rust (`uuid` v4) —
permite pipeline de várias chamadas concorrentes sem esperar uma responder
antes de mandar a próxima. `code` de erro é estável (`invalid_request`,
`method_not_found`, `internal_error`, mais os que cada handler futuro
definir, ex.: `apkg_invalido`); `message` é só para humano/log.

`capabilities` no `health.check` reflete os métodos que o dispatcher tem
registrados naquele momento — cresce sozinho conforme `handlers/__init__.py`
ganha novos módulos, sem precisar editar o handler de saúde.

### `apkg.import` (PLT-004)

```json
{"id": "a1b2c3", "method": "apkg.import", "params": {"path": "C:/baralhos/meu.apkg"}}
```

Fase 1 só prova a ponte: `handlers/apkg.py` confere que `path` existe e é um
zip de verdade (`zipfile.is_zipfile`) e sempre devolve
`{"notes_imported": 0}` — ou `apkg_invalido` se o arquivo não existe ou não é
um zip. Ler o `collection.anki2` de dentro e converter nota/cartão de verdade
é Fase 4; a forma da resposta já é a final (`ApkgImportResult` do lado Rust)
para o contrato de IPC não mudar quando isso chegar.

## Rodar localmente

```bash
cd sidecar
pip install -e ".[dev]"
python -m learno_sidecar          # espera linhas JSON no stdin
pytest                             # 33 testes, sem processo nenhum de fora
```

## Empacotar com PyInstaller

```bash
cd sidecar
pip install -e ".[dev]"           # já traz o pyinstaller
pyinstaller learno_sidecar.spec
```

Gera `sidecar/dist/learno-sidecar.exe` (onefile). Tauri exige o binário
renomeado com o *target triple* do host dentro de `src-tauri/binaries/`.
Nesta máquina (`rustc -vV` → `host: x86_64-pc-windows-msvc`):

```bash
mkdir -p ../src-tauri/binaries
cp dist/learno-sidecar.exe ../src-tauri/binaries/learno-sidecar-x86_64-pc-windows-msvc.exe
```

Outras plataformas repetem o `cp`/`pyinstaller` com o triple correspondente
(ex.: `learno-sidecar-x86_64-unknown-linux-gnu`, `learno-sidecar-aarch64-apple-darwin`)
quando o build multiplataforma entrar em pauta — não precisa disso agora.

`src-tauri/binaries/` não é versionado (artefato de build — ver `.gitignore`),
então esse `cp` precisa ser refeito a cada `pyinstaller learno_sidecar.spec`
novo, em qualquer máquina que for gerar um build ou rodar os testes
`#[ignore]`d de `sidecar::tests::real_process` abaixo.

## Fiação fora deste diretório (PLT-004, já feita)

`tauri.conf.json` tem `"externalBin": ["binaries/learno-sidecar"]` dentro de
`"bundle"`; `capabilities/default.json` tem a permissão `shell:allow-execute`
para `binaries/learno-sidecar` (ver a nota sobre ela mais abaixo — não é o
que faz o `spawn` funcionar, mas documenta a intenção); `lib.rs` sobe um
`SidecarProcess` em `.setup()`, guarda o handle em `ipc::AppState` via
`set_sidecar`, e desliga o processo em `ExitRequested` via
`AppState::sidecar()` + `SidecarProcess::shutdown()`. `ipc::commands::
import_apkg` lê o handle do mesmo jeito que os comandos de página leem
`state.pool()`.

## Por que `SidecarProcess::spawn` em si não tem teste automático — mas o resto do cruzamento com o processo real tem

`SidecarProcess::spawn` chama `app.shell().sidecar(...)`, que precisa de um
`AppHandle` real com o plugin `tauri_plugin_shell` registrado. Este crate já
descobriu (ver o doc comment de `ipc::commands::page_repository`) que
`tauri::test::mock_builder` — o único jeito de conseguir esse `AppHandle` em
teste — derruba o binário inteiro do `cargo test` nesta toolchain
(`STATUS_ENTRYPOINT_NOT_FOUND`, confirmado por bisecção). Então `spawn` em
si, e `write_request` (que escreve no stdin de um `CommandChild` de
verdade), continuam sem teste automatizado — cobri-los exigiria a mesma
`mock_builder` que quebra tudo mais.

O resto do cruzamento com o processo real — o motivo de existir esta
fronteira — tem teste, e roda contra o binário empacotado de verdade:
`sidecar::tests::real_process` em `src-tauri/src/sidecar/mod.rs` spawna
`sidecar/dist/learno-sidecar.exe` direto com `tokio::process::Command`
(sem passar pelo `tauri_plugin_shell`, que exigiria o `AppHandle` acima),
traduz o stdout real do processo real para os mesmos `CommandEvent` que o
plugin entregaria, e roda esse stream pelo `reader::run`/`PendingRequests`
de produção — não um canal `oneshot` fabricado à mão. Prova de ponta a
ponta, hoje com quatro testes: um `health.check` de sucesso, um método
desconhecido cujo `method_not_found` chega inteiro do processo real até
`Error::Sidecar`, e (PLT-004) um `apkg.import` real — com um `.apkg`
mínimo de verdade escrito em disco pelo próprio teste — que confere tanto o
caminho de sucesso (`notes_imported: 0`) quanto o `apkg_invalido` para um
arquivo que não é um zip.

Como `sidecar/dist/` é artefato de build (não versionado — ver a seção
".gitignore" acima), os quatro testes nascem `#[ignore]`, mesmo padrão dos
testes que exigem Postgres vivo: `cargo test -- --ignored` depois de rodar
`pyinstaller learno_sidecar.spec` (comando desta seção) os executa de
verdade. Tudo que roda antes e depois da fronteira de I/O — montar/parsear a
linha JSON, gerar e casar o id de correlação, esperar com timeout,
decodificar o resultado, tratar processo morto ou travado — continua
coberto por `#[cfg(test)]` comum em `protocol.rs`, `pending.rs`, `reader.rs`
e `mod.rs`, sem precisar do binário.

Nota para quem for ligar o `shell:allow-execute` do bloco 2 acima: lendo o
código-fonte de `tauri-plugin-shell` 2.3.6 (`src/lib.rs`), `Shell::sidecar`/
`Shell::command` não consultam nenhuma capability — o ACL só é verificado na
camada de comando invocada via IPC do frontend (`src/commands.rs` do
plugin). Como `SidecarProcess::spawn` chama `app.shell().sidecar(...)`
direto do lado Rust, sem passar pelo `invoke` do frontend, a permissão não é
necessária para o `spawn` funcionar — só o `externalBin` em
`tauri.conf.json` (que o `tauri-build` usa em tempo de build para copiar o
binário certo para perto do executável) e a chamada em `lib.rs` são
load-bearing. Adicionar a permissão mesmo assim não quebra nada e documenta
a intenção, mas não é o que faz o `spawn` falhar hoje.
