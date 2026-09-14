//! Diagnóstico: o erro da interface vai para o mesmo arquivo de log do Rust
//! (`crate::logs`), e a pasta de logs abre no explorador de arquivos.

use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::error::{Error, Result};
use crate::logs::cortar;

// Um erro da interface pode carregar texto arbitrário; o log não pode crescer
// sem limite por causa de uma mensagem gigante repetida.
const LIMITE_DA_ORIGEM: usize = 40;
const LIMITE_DA_MENSAGEM: usize = 4_000;
const LIMITE_DA_PILHA: usize = 16_000;

/// Grava um erro que nasceu na interface. Não devolve erro: registrar falhando
/// não pode virar um segundo erro na tela.
#[tauri::command]
pub async fn registrar_erro_da_interface(origem: String, mensagem: String, pilha: Option<String>) {
    registrar_erro_da_interface_inner(&origem, &mensagem, pilha.as_deref());
}

fn registrar_erro_da_interface_inner(origem: &str, mensagem: &str, pilha: Option<&str>) {
    tracing::error!(
        origem = cortar(origem, LIMITE_DA_ORIGEM),
        pilha = cortar(pilha.unwrap_or_default(), LIMITE_DA_PILHA),
        "erro na interface: {}",
        cortar(mensagem, LIMITE_DA_MENSAGEM)
    );
}

/// Abre a pasta de logs, criando-a se o app ainda não escreveu nada nela.
#[tauri::command]
pub async fn abrir_pasta_de_logs(app: AppHandle) -> Result<()> {
    let pasta =
        app.path().app_log_dir().map_err(|erro| Error::Config(format!("pasta de logs desconhecida: {erro}")))?;
    std::fs::create_dir_all(&pasta)?;
    app.opener()
        .open_path(pasta.to_string_lossy(), None::<&str>)
        .map_err(|erro| Error::Config(format!("não foi possível abrir a pasta de logs: {erro}")))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use tracing_subscriber::fmt;
    use tracing_subscriber::layer::SubscriberExt;

    use super::*;
    use crate::logs::arquivo_do_dia;
    use crate::logs::tests::Pasta;

    fn registrar_num_arquivo(origem: &str, mensagem: &str, pilha: Option<&str>) -> String {
        let pasta = Pasta::nova("interface");
        let arquivo = arquivo_do_dia(&pasta.0).unwrap();
        let assinante = tracing_subscriber::registry().with(fmt::layer().with_ansi(false).with_writer(arquivo));
        tracing::subscriber::with_default(assinante, || registrar_erro_da_interface_inner(origem, mensagem, pilha));
        pasta.unico_arquivo().1
    }

    #[test]
    fn erro_da_interface_chega_ao_arquivo_com_origem_e_pilha() {
        let conteudo = registrar_num_arquivo("tela", "TypeError: x is undefined", Some("at Componente (App.tsx:10)"));

        assert!(conteudo.contains("ERROR"), "{conteudo}");
        assert!(conteudo.contains("erro na interface: TypeError: x is undefined"), "{conteudo}");
        assert!(conteudo.contains("origem=\"tela\""), "{conteudo}");
        assert!(conteudo.contains("at Componente (App.tsx:10)"), "{conteudo}");
    }

    #[test]
    fn mensagem_gigante_e_cortada() {
        let gigante = "a".repeat(LIMITE_DA_MENSAGEM * 3);

        let conteudo = registrar_num_arquivo("janela", &gigante, None);

        assert!(conteudo.contains(&"a".repeat(LIMITE_DA_MENSAGEM)));
        assert!(!conteudo.contains(&"a".repeat(LIMITE_DA_MENSAGEM + 1)));
    }
}
