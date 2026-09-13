//! Onde os dados do usuário moram, e a validação dessa escolha.
//!
//! Antes da migração para SQLite (05/09/2026, ver `docs/MIGRACAO-SQLITE.md`)
//! este módulo descrevia uma conexão de rede: host, porta, usuário, senha,
//! nome do banco no servidor. Nada disso existe mais. O banco é um arquivo
//! dentro de uma pasta de trabalho, então a configuração inteira do app se
//! reduz a uma pergunta — em que pasta? — e ela tem uma resposta padrão boa
//! (`AppHandle::path().app_data_dir()`), que é justamente o que faz o app
//! abrir na primeira execução em qualquer máquina sem assistente nenhum.
//!
//! Este módulo não fala com o SQLite nem com o `tauri-plugin-store` — isso é
//! trabalho do `ipc`, que empresta os comandos de `#[tauri::command]`. Aqui
//! só fica a lógica pura, testável sem banco e sem app Tauri de pé.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Nome do arquivo do `tauri-plugin-store` onde a configuração fica salva.
pub const STORE_FILE: &str = "config.json";

/// Chave, dentro do store acima, onde a pasta de trabalho escolhida pelo
/// usuário (PLT-016) fica salva. A antiga `postgres_connection` deixou de
/// existir junto com o assistente de conexão.
pub const DATA_DIR_STORE_KEY: &str = "app_data_dir";

/// Chave, no mesmo store, onde o tema escolhido fica salvo.
///
/// O tema morava em `localStorage` da WebView, e era a única configuração do
/// app fora daqui: não migrava junto com a pasta de trabalho, não entrava em
/// backup e o Rust não a enxergava. Agora segue o mesmo caminho dos vizinhos.
/// O `localStorage` continua sendo escrito do lado do frontend, mas como
/// **cache de primeiro paint** — ler por IPC é assíncrono e chegaria tarde
/// demais para evitar a tela piscar no tema errado.
pub const THEME_STORE_KEY: &str = "theme";

/// Quantos caracteres um id de tema pode ter. Os ids reais são curtos
/// (`ambar-noturno`, `alto-contraste`); o teto existe só para um valor
/// absurdo não ir parar no `config.json`.
const MAX_THEME_ID_BYTES: usize = 40;

/// Confere que `theme` tem forma de id de tema antes de ir para o disco.
///
/// Valida FORMA, não pertencimento a uma lista. A lista de temas é do
/// frontend (`src/lib/themes.ts`), que é quem sabe pintar cada um; repeti-la
/// aqui criaria duas fontes da verdade em duas linguagens, e a segunda ficaria
/// para trás na primeira vez que alguém acrescentasse um tema. Um id
/// desconhecido não é perigoso — o seletor `:root[data-theme="..."]` não casa
/// e o app cai no tema padrão. O que seria ruim é gravar algo que nem parece
/// um id, e é isso que esta função barra.
///
/// `save_theme` é um comando de IPC, alcançável por qualquer script rodando
/// dentro da WebView, então a entrada é hostil por padrão (regra 11).
pub fn validate_theme_id(theme: &str) -> Result<()> {
    if theme.is_empty() {
        return Err(Error::Invalid("tema não pode ser vazio".into()));
    }
    if theme.len() > MAX_THEME_ID_BYTES {
        return Err(Error::Invalid(format!(
            "id de tema não pode passar de {MAX_THEME_ID_BYTES} bytes (recebido: {} bytes)",
            theme.len()
        )));
    }
    if !theme.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(Error::Invalid(
            "id de tema só pode ter letras minúsculas (a-z), dígitos e hífen".into(),
        ));
    }
    Ok(())
}

/// Nome do arquivo do banco dentro da pasta de trabalho. Fixo de propósito:
/// deixar o usuário nomear o arquivo só criaria um jeito de o app não achar
/// o próprio banco depois de um rename fora dele.
pub const DATABASE_FILE_NAME: &str = "learno.sqlite";

/// Onde o banco vive dentro de uma pasta de trabalho qualquer.
pub fn database_path_in(data_dir: &Path) -> PathBuf {
    data_dir.join(DATABASE_FILE_NAME)
}

/// A configuração inteira do app, do jeito que persiste em disco.
///
/// Um campo só, e nenhum segredo: com o banco em arquivo local não há
/// credencial a guardar nem a esquecer entre sessões. Continua sendo uma
/// struct (em vez de uma `String` solta) porque é o que o cache de
/// `ipc::state::AppState` guarda e o que o frontend recebe de
/// `get_app_config` — e porque os caminhos derivados (pasta, arquivo do
/// banco) têm um dono óbvio assim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppConfig {
    pub data_dir: String,
}

impl AppConfig {
    pub fn new(data_dir: impl Into<String>) -> Self {
        Self { data_dir: data_dir.into() }
    }

    /// Confere que a pasta faz sentido antes de gravar no store.
    pub fn validate(&self) -> Result<()> {
        validate_data_dir(&self.data_dir)
    }

    /// A pasta de trabalho como caminho.
    pub fn data_dir_path(&self) -> PathBuf {
        PathBuf::from(&self.data_dir)
    }

    /// O arquivo do banco dentro dela — o que `db::pool` abre.
    pub fn database_path(&self) -> PathBuf {
        database_path_in(&self.data_dir_path())
    }
}

/// PLT-016: confere que a pasta de trabalho informada é utilizável antes de
/// o app mover o banco para lá e persistir a escolha.
///
/// Exigir caminho **absoluto** é a parte que importa para segurança, e ela
/// espelha `ipc::backup_commands::validate_backup_output_dir`, que já fazia o
/// mesmo pelo mesmo motivo. `save_data_dir` é um `#[tauri::command]`, e todo
/// comando de IPC é alcançável por qualquer script rodando dentro da WebView
/// — não só pelo diálogo nativo que a tela de Configurações abre. Um caminho
/// relativo (`"x"`) seria resolvido contra o diretório de trabalho do
/// processo, que num app empacotado é imprevisível: o banco vivo seria
/// copiado para lá, o caminho relativo ficaria gravado no store, e toda
/// abertura seguinte reabriria um banco diferente conforme o cwd daquela
/// execução.
///
/// `..` é recusado pela mesma razão que em `validate_export_target`: o
/// diálogo nativo sempre devolve caminho já resolvido, então um componente
/// `..` só aparece quando alguém montou a string à mão.
///
/// O que esta função deliberadamente NÃO faz: conferir que o caminho existe
/// ou que é gravável. Isso é de quem de fato abre o banco lá
/// (`db::pool::connect_and_migrate`, que cria a pasta e propaga o erro de I/O
/// real), não de uma função pura.
pub fn validate_data_dir(data_dir: &str) -> Result<()> {
    let cortado = data_dir.trim();
    if cortado.is_empty() {
        return Err(Error::Invalid("pasta de dados não pode ser vazia".into()));
    }

    let caminho = Path::new(cortado);
    if !caminho.is_absolute() {
        return Err(Error::Invalid("pasta de dados precisa ser um caminho absoluto".into()));
    }
    if caminho.components().any(|componente| componente == std::path::Component::ParentDir) {
        return Err(Error::Invalid("pasta de dados não pode conter '..'".into()));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    // A regra 3 isenta `#[cfg(test)]` do banimento de unwrap/expect; o lint do
    // clippy não conhece essa exceção, então ela é escrita aqui.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    /// Um caminho absoluto do sistema onde o teste roda — `C:\...` no Windows
    /// não é absoluto no Linux e vice-versa, e a regra que se quer provar não
    /// é sobre a sintaxe de um sistema operacional específico.
    fn caminho_absoluto() -> String {
        std::env::temp_dir().join("learno-teste").to_string_lossy().into_owned()
    }

    #[test]
    fn validate_data_dir_rejects_blank_input() {
        assert!(validate_data_dir("   ").is_err());
        assert!(validate_data_dir("").is_err());
    }

    #[test]
    fn validate_data_dir_accepts_a_real_looking_path() {
        assert!(validate_data_dir(&caminho_absoluto()).is_ok());
    }

    /// A defesa que importa: `save_data_dir` é um comando de IPC, alcançável
    /// por qualquer script na WebView, não só pelo diálogo nativo. Um caminho
    /// relativo seria resolvido contra o diretório de trabalho do processo, e
    /// o banco inteiro iria parar num lugar imprevisível.
    #[test]
    fn validate_data_dir_rejects_a_relative_path() {
        assert!(validate_data_dir("x").is_err());
        assert!(validate_data_dir("dados/learno").is_err());
        assert!(validate_data_dir(r"dados\learno").is_err());
    }

    #[test]
    fn validate_data_dir_rejects_a_path_climbing_out_with_dotdot() {
        let subindo = std::env::temp_dir().join("..").join("outro-lugar");
        assert!(validate_data_dir(&subindo.to_string_lossy()).is_err());
    }

    #[test]
    fn validate_theme_id_accepts_the_real_ids() {
        for id in ["ambar-noturno", "papel", "grafite", "meia-noite", "alto-contraste", "sistema"] {
            assert!(validate_theme_id(id).is_ok(), "{id} deveria ser aceito");
        }
    }

    #[test]
    fn validate_theme_id_rejects_what_is_not_an_id() {
        assert!(validate_theme_id("").is_err());
        assert!(validate_theme_id("Ambar Noturno").is_err(), "maiúscula e espaço");
        assert!(validate_theme_id("../../etc/passwd").is_err(), "caminho");
        assert!(validate_theme_id("tema\"]{color:red}").is_err(), "fuga de seletor CSS");
        assert!(validate_theme_id(&"a".repeat(41)).is_err(), "longo demais");
    }

    #[test]
    fn config_validation_delegates_to_the_same_rule() {
        assert!(AppConfig::new("  ").validate().is_err());
        assert!(AppConfig::new("relativo").validate().is_err());
        assert!(AppConfig::new(caminho_absoluto()).validate().is_ok());
    }

    #[test]
    fn database_path_is_the_fixed_file_name_inside_the_chosen_folder() {
        let config = AppConfig::new(r"C:\Users\alguem\Learno");
        let path = config.database_path();

        assert_eq!(path.file_name().and_then(|name| name.to_str()), Some(DATABASE_FILE_NAME));
        assert_eq!(path.parent(), Some(Path::new(r"C:\Users\alguem\Learno")));
    }

    /// A configuração serializada não pode ganhar um campo de segredo por
    /// descuido: com o banco em arquivo não existe senha nenhuma a guardar, e
    /// este teste cai na primeira vez que alguém tentar acrescentar uma.
    #[test]
    fn serialized_config_carries_only_the_data_dir() {
        let json = serde_json::to_value(AppConfig::new("/tmp/learno")).unwrap();
        let object = json.as_object().unwrap();

        assert_eq!(object.len(), 1);
        assert_eq!(object.get("data_dir").and_then(|value| value.as_str()), Some("/tmp/learno"));
    }
}
