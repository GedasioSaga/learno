//! Log em arquivo e registro de pânico.
//!
//! No app instalado não há terminal: sem arquivo, um erro relatado por quem
//! usa não deixa rastro. Um arquivo por dia na pasta de logs do app
//! (`%LOCALAPPDATA%\<identificador>\logs` no Windows), os últimos
//! [`DIAS_DE_LOG`] guardados. O terminal continua recebendo tudo, para quem
//! roda em desenvolvimento.

use std::path::Path;

use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter};

use crate::error::{Error, Result};

pub const DIAS_DE_LOG: usize = 7;

const PREFIXO: &str = "learno";
const SUFIXO: &str = "log";
const FILTRO_PADRAO: &str = "learno_lib=info,sqlx=warn";

/// O arquivo do dia em `pasta`, trocado à meia-noite, com os mais velhos
/// apagados.
///
/// Escrita síncrona, sem o `non_blocking` do tracing-appender: o volume é
/// baixo, e um escritor em outra thread perderia justamente a última linha
/// antes de um pânico que derruba o processo.
pub fn arquivo_do_dia(pasta: &Path) -> Result<RollingFileAppender> {
    RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(PREFIXO)
        .filename_suffix(SUFIXO)
        .max_log_files(DIAS_DE_LOG)
        .build(pasta)
        .map_err(|erro| Error::Config(format!("não foi possível abrir o log em {}: {erro}", pasta.display())))
}

/// Liga o log (terminal e, havendo pasta, arquivo) e o registro de pânico.
///
/// Pasta ausente ou que não abre não impede o app de abrir: o log segue só no
/// terminal, e o motivo vai para o próprio log. Só a primeira chamada vale.
pub fn iniciar(pasta_de_logs: Option<&Path>) {
    let filtro = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(FILTRO_PADRAO));
    let (camada_de_arquivo, falha) = match pasta_de_logs.map(arquivo_do_dia) {
        Some(Ok(arquivo)) => (Some(fmt::layer().with_ansi(false).with_writer(arquivo)), None),
        Some(Err(erro)) => (None, Some(erro)),
        None => (None, None),
    };

    let ligou = tracing_subscriber::registry()
        .with(filtro)
        .with(fmt::layer())
        .with(camada_de_arquivo)
        .try_init()
        .is_ok();
    if !ligou {
        return;
    }

    registrar_panicos();
    match (falha, pasta_de_logs) {
        (Some(erro), _) => tracing::error!(%erro, "log em arquivo indisponível; seguindo só com o terminal"),
        (None, None) => tracing::warn!("pasta de logs desconhecida; seguindo só com o terminal"),
        (None, Some(pasta)) => tracing::info!(pasta = %pasta.display(), "log em arquivo ligado"),
    }
}

/// Pânico vai para o log com a pilha, e depois segue para o tratamento que já
/// existia (a mensagem no terminal).
fn registrar_panicos() {
    let anterior = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let pilha = std::backtrace::Backtrace::force_capture();
        tracing::error!(panico = %info, pilha = %pilha, "pânico");
        anterior(info);
    }));
}

/// `texto` com no máximo `limite` bytes, cortado em fronteira de caractere.
pub fn cortar(texto: &str, limite: usize) -> &str {
    if texto.len() <= limite {
        return texto;
    }
    let mut fim = limite;
    while !texto.is_char_boundary(fim) {
        fim -= 1;
    }
    &texto[..fim]
}

#[cfg(test)]
pub(crate) mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::path::PathBuf;

    use super::*;

    pub(crate) struct Pasta(pub PathBuf);

    impl Pasta {
        pub(crate) fn nova(rotulo: &str) -> Self {
            let caminho = std::env::temp_dir().join(format!("learno-logs-{rotulo}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&caminho).unwrap();
            Self(caminho)
        }

        /// O único arquivo da pasta, e o conteúdo dele.
        pub(crate) fn unico_arquivo(&self) -> (String, String) {
            let arquivos: Vec<PathBuf> = std::fs::read_dir(&self.0).unwrap().map(|e| e.unwrap().path()).collect();
            assert_eq!(arquivos.len(), 1, "{arquivos:?}");
            let nome = arquivos[0].file_name().unwrap().to_string_lossy().into_owned();
            (nome, std::fs::read_to_string(&arquivos[0]).unwrap())
        }
    }

    impl Drop for Pasta {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_linha_logada_chega_ao_arquivo_do_dia_sem_cor_de_terminal() {
        let pasta = Pasta::nova("arquivo");
        let arquivo = arquivo_do_dia(&pasta.0).unwrap();
        let assinante = tracing_subscriber::registry().with(fmt::layer().with_ansi(false).with_writer(arquivo));

        tracing::subscriber::with_default(assinante, || tracing::error!(detalhe = "x", "marcador-de-teste"));

        let (nome, conteudo) = pasta.unico_arquivo();
        assert!(nome.starts_with("learno.") && nome.ends_with(".log"), "{nome}");
        assert!(conteudo.contains("ERROR") && conteudo.contains("marcador-de-teste"), "{conteudo}");
        assert!(!conteudo.contains('\u{1b}'), "o arquivo não pode ter código de cor: {conteudo:?}");
    }

    #[test]
    fn pasta_que_nao_pode_ser_criada_e_erro_e_nao_panico() {
        let pasta = Pasta::nova("invalida");
        let arquivo = pasta.0.join("sou-um-arquivo");
        std::fs::write(&arquivo, "x").unwrap();

        assert!(matches!(arquivo_do_dia(&arquivo.join("logs")), Err(Error::Config(_))));
    }

    #[test]
    fn cortar_para_em_fronteira_de_caractere() {
        assert_eq!(cortar("abc", 10), "abc");
        assert_eq!(cortar("ação", 2), "a");
        assert_eq!(cortar("ação", 3), "aç");
        assert_eq!(cortar("", 0), "");
    }
}
