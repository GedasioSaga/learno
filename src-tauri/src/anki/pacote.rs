//! Abrir um `.apkg`/`.colpkg`: achar a coleção dentro do zip e deixá-la num
//! arquivo SQLite temporário que o `sqlx` consegue abrir.

use std::fs::File;
use std::io::{self, Read, Seek};
use std::path::{Path, PathBuf};

use zip::result::ZipError;
use zip::ZipArchive;

use crate::error::{Error, Result};

/// A coleção no formato novo, comprimida com zstd. Um pacote nesse formato
/// TAMBÉM traz um `collection.anki2`, mas ele é só um aviso de "atualize o
/// Anki" com uma nota. Por isso a ordem de procura importa.
const COLECAO_ZSTD: &str = "collection.anki21b";

/// O formato antigo, SQLite puro: `anki21` é mais novo que `anki2` quando os
/// dois aparecem.
const COLECOES_SQLITE: [&str; 2] = ["collection.anki21", "collection.anki2"];

/// A coleção extraída para um arquivo temporário, apagado quando isto sai de
/// escopo.
pub struct PacoteAberto {
    arquivo: PathBuf,
    /// Arquivos de mídia no pacote. Não são importados; o número vai para o
    /// relatório.
    pub midias: usize,
}

impl PacoteAberto {
    pub fn caminho_da_colecao(&self) -> &Path {
        &self.arquivo
    }
}

impl Drop for PacoteAberto {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.arquivo);
        for sufixo in ["-wal", "-shm", "-journal"] {
            let mut acompanhante = self.arquivo.clone().into_os_string();
            acompanhante.push(sufixo);
            let _ = std::fs::remove_file(acompanhante);
        }
    }
}

pub fn abrir_pacote(caminho: &Path) -> Result<PacoteAberto> {
    let mut zip = ZipArchive::new(File::open(caminho)?).map_err(|erro| invalido(caminho, &erro))?;

    // Mídia mora em entradas de nome numérico ("0", "1", ...) nos dois formatos.
    let midias =
        zip.file_names().filter(|nome| !nome.is_empty() && nome.bytes().all(|b| b.is_ascii_digit())).count();

    // O guarda nasce antes de o arquivo existir: se a extração falhar no meio,
    // o `Drop` apaga o que ficou pela metade.
    let pacote = PacoteAberto {
        arquivo: std::env::temp_dir().join(format!("learno-anki-{}.sqlite", uuid::Uuid::new_v4())),
        midias,
    };

    if let Some(entrada) = entrada(&mut zip, COLECAO_ZSTD, caminho)? {
        zstd::stream::copy_decode(entrada, File::create(&pacote.arquivo)?)
            .map_err(|erro| Error::Invalid(format!("{}: coleção do Anki corrompida ({erro})", nome(caminho))))?;
        return Ok(pacote);
    }

    for nome_da_colecao in COLECOES_SQLITE {
        if let Some(mut entrada) = entrada(&mut zip, nome_da_colecao, caminho)? {
            io::copy(&mut entrada, &mut File::create(&pacote.arquivo)?)?;
            return Ok(pacote);
        }
    }

    Err(Error::Invalid(format!("{} não é um pacote do Anki: não há coleção dentro do arquivo", nome(caminho))))
}

/// `None` só quando a entrada não existe; qualquer outro defeito do zip é erro.
fn entrada<'a, R: Read + Seek>(
    zip: &'a mut ZipArchive<R>,
    nome_da_entrada: &str,
    caminho: &Path,
) -> Result<Option<zip::read::ZipFile<'a, R>>> {
    match zip.by_name(nome_da_entrada) {
        Ok(entrada) => Ok(Some(entrada)),
        Err(ZipError::FileNotFound) => Ok(None),
        Err(erro) => Err(invalido(caminho, &erro)),
    }
}

fn invalido(caminho: &Path, erro: &ZipError) -> Error {
    Error::Invalid(format!("{} não é um pacote do Anki válido: {erro}", nome(caminho)))
}

fn nome(caminho: &Path) -> String {
    caminho.file_name().map_or_else(|| caminho.display().to_string(), |nome| nome.to_string_lossy().into_owned())
}
