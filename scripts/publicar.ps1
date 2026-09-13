# Publica uma versao nova do Learno: sobe a versao nos 3 manifestos, roda os
# testes, commita, taggeia e da push - o GitHub Actions faz o resto (sidecar +
# instalador NSIS assinado + release com latest.json; os apps instalados
# mostram o aviso de atualizacao no proximo boot).
#
# Uso (na raiz do projeto):
#   .\scripts\publicar.ps1 -Versao 0.2.0
#
# Pre-requisitos: branch master, gh autenticado, secrets TAURI_SIGNING_PRIVATE_KEY
# e TAURI_SIGNING_PRIVATE_KEY_PASSWORD configurados no repo.
#
# OBS: arquivo sem acentos de proposito - PowerShell 5.1 le .ps1 sem BOM como
# ANSI e caracteres fora do ASCII quebram o parse.

param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Versao,
    # Pula vitest + cargo test (so para republicar algo ja testado).
    [switch]$SemTestes
)

# "Continue" de proposito: cargo e git escrevem coisa normal no stderr e com
# "Stop" o PS 5.1 mata o script nisso. Controle de erro real e por
# $LASTEXITCODE apos cada comando nativo.
$ErrorActionPreference = "Continue"
$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz

function Checar($etapa) {
    if ($LASTEXITCODE -ne 0) { throw "$etapa falhou (exit $LASTEXITCODE)" }
}

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne "master") { throw "Publicacao so sai da master (branch atual: $branch)." }
if (git status --porcelain) { throw "Arvore com mudancas nao commitadas. Commite ou descarte antes de publicar." }
git fetch origin master --quiet
Checar "git fetch"
if ((git rev-list --count HEAD..origin/master) -ne "0") { throw "master local atras de origin/master. De pull antes de publicar." }

$atual = (Get-Content "$raiz\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
if ([version]$Versao -le [version]$atual) {
    throw "Versao $Versao nao e maior que a atual ($atual). O updater ignoraria o release."
}

# 1. Testes antes de mexer em qualquer coisa.
if (-not $SemTestes) {
    Write-Host "== Testes..." -ForegroundColor Cyan
    npx vitest run 2>&1 | Select-Object -Last 6 | ForEach-Object { "$_" }
    Checar "vitest"
    Push-Location "$raiz\src-tauri"
    cargo test --quiet 2>&1 | Select-String "test result|error" | ForEach-Object { "$_" }
    $exit = $LASTEXITCODE
    Pop-Location
    if ($exit -ne 0) { throw "cargo test falhou (exit $exit)" }
}

# 2. Bump de versao nos 3 manifestos. SEM Set-Content -Encoding utf8: no PS 5.1
# ele grava BOM, e o CI nao parseia JSON/TOML com BOM.
Write-Host "== Versao $atual -> $Versao" -ForegroundColor Cyan
$utf8SemBom = New-Object System.Text.UTF8Encoding $false
function BumpVersao($caminho, $padrao, $novo) {
    $texto = [System.IO.File]::ReadAllText($caminho)
    [System.IO.File]::WriteAllText($caminho, ([regex]::new($padrao)).Replace($texto, $novo, 1), $utf8SemBom)
}
BumpVersao "$raiz\src-tauri\tauri.conf.json" '"version": "\d+\.\d+\.\d+"' "`"version`": `"$Versao`""
BumpVersao "$raiz\src-tauri\Cargo.toml" '(?m)^version = "\d+\.\d+\.\d+"' "version = `"$Versao`""
BumpVersao "$raiz\package.json" '"version": "\d+\.\d+\.\d+"' "`"version`": `"$Versao`""

# Cargo.lock e package-lock.json acompanham o bump sem compilar nada.
Push-Location "$raiz\src-tauri"
cargo metadata --format-version 1 | Out-Null
$exit = $LASTEXITCODE
Pop-Location
if ($exit -ne 0) { throw "cargo metadata falhou (exit $exit)" }
npm install --package-lock-only --ignore-scripts 2>&1 | Out-Null
Checar "npm install --package-lock-only"

# 3. Gate anti-segredo: nada de token/chave em claro no que vai subir.
Write-Host "== Gate anti-segredo..." -ForegroundColor Cyan
git add -A
$suspeitos = git grep --cached -I -n -E "ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWdu"
if ($suspeitos) {
    Write-Host $suspeitos -ForegroundColor Red
    throw "Possivel segredo detectado - publicacao ABORTADA. Confira antes de tentar de novo."
}

# 4. Commit + tag ANOTADA + push (`--follow-tags` ignora tag leve).
git commit -m "release: v$Versao" 2>&1 | ForEach-Object { "$_" }
Checar "git commit"
git tag -a "v$Versao" -m "release v$Versao" 2>&1 | ForEach-Object { "$_" }
Checar "git tag"
git push --follow-tags origin master 2>&1 | ForEach-Object { "$_" }
Checar "git push"

Write-Host ""
Write-Host "v$Versao publicada. Acompanhe o build:" -ForegroundColor Green
Write-Host "  gh run watch" -ForegroundColor Green
Write-Host "Release sai em ~15-20 min; os apps instalados mostram o aviso no proximo boot." -ForegroundColor Green
