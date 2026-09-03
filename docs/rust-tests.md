# Rodando a suíte Rust do zero

```powershell
./scripts/dev-db.ps1 reset
$env:LEARNO_TEST_DATABASE_URL = "postgres://learno@127.0.0.1:5433/learno_test"
cd src-tauri; cargo test -- --include-ignored
```

`reset` recria o cluster descartável e as bases `learno_dev`/`learno_test`
vazias. Cada teste `#[ignore]`d cria e derruba seu **próprio** banco nesse
cluster (`tests/support::IsolatedDatabase`/`EmptyDatabase`) — nada fica para
trás, e nenhum banco precisa existir de antemão além do que `reset` já cria.
