# Rodando a suíte Rust do zero

```powershell
cd src-tauri
cargo test
```

Após a migração para SQLite (ver `docs/MIGRACAO-SQLITE.md`), não existe mais cluster
PostgreSQL nem variáveis de ambiente especiais. Cada teste cria e derruba seu **próprio**
arquivo SQLite em pasta temporária (`tests/support::IsolatedDatabase`) — nada fica para
trás. Todo teste de banco roda por padrão: não há `#[ignore]` de preparação.

Resultado atual: 203 testes de unidade (na lib `learno-lib`) + 67 testes de
integração (11 binários em `tests/*.rs`). Ainda há 4 testes `#[ignore]`d
(`sidecar::tests::real_process`), mas esses não dependem do banco — precisam do
sidecar Python empacotado e não afetam a suíte normal.

## O portão, que não é só o teste

```powershell
cargo clippy --all-targets --all-features -- -D warnings -W clippy::unwrap_used -W clippy::expect_used
```

Um comando só, e ele precisa sair limpo. Pré-requisito conhecido: a primeira linha de
**cada** arquivo em `tests/` tem que ser
`#![allow(clippy::unwrap_used, clippy::expect_used)]` — um `cfg_attr` no `lib.rs` não
alcança teste de integração, que é um crate separado.
