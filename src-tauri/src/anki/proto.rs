//! Leitor mínimo de protobuf: só o que o schema novo do Anki exige para
//! importar. Uma crate de protobuf traria geração de código inteira para ler
//! três campos.
//!
//! Números de campo conferidos nos bytes de uma coleção real (13/09/2026):
//! `notetypes.config` campo 1 = kind (1 = cloze, ausente = normal);
//! `templates.config` campo 1 = frente e campo 2 = verso; `decks.kind` campo 1
//! = baralho normal e campo 2 = filtrado.

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Valor<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

/// Os campos de primeiro nível de `bytes`, na ordem em que aparecem.
///
/// Campos de tamanho fixo são pulados porque nada aqui os lê. Grupo (tipo de
/// fio obsoleto) ou mensagem truncada é erro, nunca pânico: o arquivo vem de
/// fora.
pub fn campos(bytes: &[u8]) -> Result<Vec<(u64, Valor<'_>)>> {
    let mut achados = Vec::new();
    let mut pos = 0;
    while pos < bytes.len() {
        let chave = ler_varint(bytes, &mut pos)?;
        let numero = chave >> 3;
        match chave & 0x7 {
            0 => achados.push((numero, Valor::Varint(ler_varint(bytes, &mut pos)?))),
            1 => pular(bytes, &mut pos, 8)?,
            2 => {
                let tamanho = usize::try_from(ler_varint(bytes, &mut pos)?).map_err(|_| malformado())?;
                let fim = pos.checked_add(tamanho).filter(|fim| *fim <= bytes.len()).ok_or_else(malformado)?;
                achados.push((numero, Valor::Bytes(&bytes[pos..fim])));
                pos = fim;
            }
            5 => pular(bytes, &mut pos, 4)?,
            _ => return Err(malformado()),
        }
    }
    Ok(achados)
}

/// O varint do campo `numero`. Repetido, vale o último, como no protobuf.
pub fn varint(bytes: &[u8], numero: u64) -> Result<Option<u64>> {
    Ok(campos(bytes)?.into_iter().rev().find_map(|(n, valor)| match valor {
        Valor::Varint(v) if n == numero => Some(v),
        _ => None,
    }))
}

/// O texto UTF-8 do campo `numero`. Repetido, vale o último.
pub fn texto(bytes: &[u8], numero: u64) -> Result<Option<String>> {
    let achado = campos(bytes)?.into_iter().rev().find_map(|(n, valor)| match valor {
        Valor::Bytes(b) if n == numero => Some(b),
        _ => None,
    });
    achado.map(|b| String::from_utf8(b.to_vec()).map_err(|_| malformado())).transpose()
}

pub fn tem_campo(bytes: &[u8], numero: u64) -> Result<bool> {
    Ok(campos(bytes)?.iter().any(|(n, _)| *n == numero))
}

fn ler_varint(bytes: &[u8], pos: &mut usize) -> Result<u64> {
    let mut valor = 0u64;
    for deslocamento in (0..64).step_by(7) {
        let byte = *bytes.get(*pos).ok_or_else(malformado)?;
        *pos += 1;
        valor |= u64::from(byte & 0x7F) << deslocamento;
        if byte & 0x80 == 0 {
            return Ok(valor);
        }
    }
    Err(malformado())
}

fn pular(bytes: &[u8], pos: &mut usize, quantos: usize) -> Result<()> {
    *pos = pos.checked_add(quantos).filter(|fim| *fim <= bytes.len()).ok_or_else(malformado)?;
    Ok(())
}

fn malformado() -> Error {
    Error::Invalid("pacote do Anki com configuração corrompida (protobuf malformado)".into())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn le_varint_de_varios_bytes() {
        assert_eq!(campos(&[0x08, 0x96, 0x01]).unwrap(), vec![(1, Valor::Varint(150))]);
    }

    #[test]
    fn le_bytes_e_texto() {
        let bytes = [0x12, 0x03, b'a', b'b', b'c'];
        assert_eq!(campos(&bytes).unwrap(), vec![(2, Valor::Bytes(b"abc"))]);
        assert_eq!(texto(&bytes, 2).unwrap().as_deref(), Some("abc"));
        assert_eq!(texto(&bytes, 1).unwrap(), None);
    }

    #[test]
    fn pula_campos_de_tamanho_fixo() {
        let bytes = [0x0D, 1, 2, 3, 4, 0x11, 1, 2, 3, 4, 5, 6, 7, 8, 0x08, 0x01];
        assert_eq!(campos(&bytes).unwrap(), vec![(1, Valor::Varint(1))]);
    }

    #[test]
    fn mensagem_vazia_nao_tem_campo_nenhum() {
        assert_eq!(varint(&[], 1).unwrap(), None);
        assert!(!tem_campo(&[], 1).unwrap());
    }

    #[test]
    fn campo_repetido_vale_o_ultimo() {
        assert_eq!(varint(&[0x08, 0x01, 0x08, 0x02], 1).unwrap(), Some(2));
    }

    #[test]
    fn mensagem_truncada_ou_grupo_e_erro_e_nao_panico() {
        for bytes in [&[0x12, 0x05, b'a'][..], &[0x08, 0x80][..], &[0x0B][..], &[0x0D, 1][..]] {
            assert!(matches!(campos(bytes), Err(Error::Invalid(_))), "{bytes:?}");
        }
    }

    #[test]
    fn varint_com_mais_de_dez_bytes_e_erro() {
        let bytes = [0x08, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x01];
        assert!(matches!(campos(&bytes), Err(Error::Invalid(_))));
    }

    #[test]
    fn texto_que_nao_e_utf8_e_erro() {
        assert!(matches!(texto(&[0x0A, 0x01, 0xFF], 1), Err(Error::Invalid(_))));
    }
}
