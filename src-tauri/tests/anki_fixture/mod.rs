//! Pacotes do Anki sintéticos para os testes do importador — nenhum dado real.
//!
//! Gera os dois formatos: o novo (`collection.anki21b` comprimido com zstd,
//! schema 18, configuração em protobuf) e o antigo (`collection.anki2` ou
//! `collection.anki21`, schema 11, tipos de nota e baralhos em JSON dentro de
//! `col`). As tabelas e colunas imitam as do Anki, inclusive a collation
//! `unicase` do schema novo.
#![allow(clippy::unwrap_used, clippy::expect_used, dead_code)]

use std::io::Write;
use std::path::{Path, PathBuf};

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use sqlx::{ConnectOptions, Connection, SqliteConnection};

pub const SEPARADOR: &str = "\u{1f}";
pub const CRIADA_EM: i64 = 1_698_562_800;

pub struct TipoFixture {
    pub id: i64,
    pub nome: &'static str,
    pub cloze: bool,
    pub campos: Vec<&'static str>,
    /// `(nome, frente, verso)`.
    pub templates: Vec<(&'static str, &'static str, &'static str)>,
}

pub struct NotaFixture {
    pub id: i64,
    pub guid: &'static str,
    pub tipo: i64,
    pub tags: &'static str,
    pub campos: Vec<&'static str>,
}

pub struct CartaoFixture {
    pub id: i64,
    pub nota: i64,
    pub baralho: i64,
    pub ordinal: i64,
    pub tipo: i64,
    pub fila: i64,
    pub due: i64,
    pub intervalo: i64,
    pub fator: i64,
    pub repeticoes: i64,
    pub lapsos: i64,
    pub baralho_original: i64,
    pub due_original: i64,
}

impl CartaoFixture {
    /// Cartão novo, sem histórico; os testes sobrescrevem o que precisam.
    pub fn novo(id: i64, nota: i64, baralho: i64, ordinal: i64) -> Self {
        Self {
            id,
            nota,
            baralho,
            ordinal,
            tipo: 0,
            fila: 0,
            due: 0,
            intervalo: 0,
            fator: 0,
            repeticoes: 0,
            lapsos: 0,
            baralho_original: 0,
            due_original: 0,
        }
    }
}

pub struct RevisaoFixture {
    pub id: i64,
    pub cartao: i64,
    pub resposta: i64,
    pub intervalo: i64,
    pub intervalo_anterior: i64,
    pub fator: i64,
    pub duracao_ms: i64,
    pub tipo: i64,
}

pub struct Fixture {
    pub criada_em: i64,
    pub tipos: Vec<TipoFixture>,
    /// `(id, "Pai::Filho", filtrado)`.
    pub baralhos: Vec<(i64, &'static str, bool)>,
    pub notas: Vec<NotaFixture>,
    pub cartoes: Vec<CartaoFixture>,
    pub revisoes: Vec<RevisaoFixture>,
    pub midias: usize,
}

impl Fixture {
    /// Um pouco de tudo que o importador precisa tratar: tipo básico, tipo
    /// com cartão invertido, cloze, hierarquia de baralho, baralho filtrado,
    /// cartão em cada estado e uma revisão manual (resposta 0).
    pub fn exemplo() -> Self {
        Self {
            criada_em: CRIADA_EM,
            tipos: vec![
                TipoFixture {
                    id: 1,
                    nome: "Basic",
                    cloze: false,
                    campos: vec!["Front", "Back"],
                    templates: vec![("Card 1", "{{Front}}", "{{FrontSide}}<hr id=answer>{{Back}}")],
                },
                TipoFixture {
                    id: 2,
                    nome: "Basic (and reversed card)",
                    cloze: false,
                    campos: vec!["Front", "Back"],
                    templates: vec![
                        ("Card 1", "{{Front}}", "{{FrontSide}}<hr id=answer>{{Back}}"),
                        ("Card 2", "{{Back}}", "{{FrontSide}}<hr id=answer>{{Front}}"),
                    ],
                },
                TipoFixture {
                    id: 3,
                    nome: "Cloze",
                    cloze: true,
                    campos: vec!["Text", "Back Extra"],
                    templates: vec![("Cloze", "{{cloze:Text}}", "{{cloze:Text}}<br>{{Back Extra}}")],
                },
            ],
            baralhos: vec![(1, "Default", false), (100, "Medicina::Rim", false), (200, "Filtrado", true)],
            notas: vec![
                NotaFixture {
                    id: 1,
                    guid: "g-basico",
                    tipo: 1,
                    tags: " rim fisiologia ",
                    campos: vec!["O que o <b>rim</b> filtra?", "Sangue&nbsp;e <i>plasma</i>"],
                },
                NotaFixture { id: 2, guid: "g-invertido", tipo: 2, tags: "", campos: vec!["Néfron", "Unidade funcional"] },
                NotaFixture {
                    id: 3,
                    guid: "g-cloze",
                    tipo: 3,
                    tags: "bioquimica",
                    campos: vec!["A {{c1::mitocôndria}} produz {{c2::ATP}}", r#"<img src="mito.png">"#],
                },
            ],
            cartoes: vec![
                CartaoFixture {
                    tipo: 2,
                    fila: 2,
                    due: 900,
                    intervalo: 10,
                    fator: 2500,
                    repeticoes: 5,
                    lapsos: 1,
                    ..CartaoFixture::novo(11, 1, 100, 0)
                },
                CartaoFixture { due: 3, ..CartaoFixture::novo(12, 2, 100, 0) },
                CartaoFixture {
                    tipo: 2,
                    fila: 2,
                    due: 5,
                    intervalo: 3,
                    fator: 2300,
                    repeticoes: 2,
                    baralho_original: 100,
                    due_original: 950,
                    ..CartaoFixture::novo(13, 2, 200, 1)
                },
                CartaoFixture {
                    tipo: 1,
                    fila: 1,
                    due: 1_776_643_820,
                    repeticoes: 1,
                    ..CartaoFixture::novo(14, 3, 100, 0)
                },
                CartaoFixture {
                    tipo: 2,
                    fila: -1,
                    due: 800,
                    intervalo: 20,
                    fator: 2600,
                    repeticoes: 8,
                    lapsos: 2,
                    ..CartaoFixture::novo(15, 3, 100, 1)
                },
            ],
            revisoes: vec![
                RevisaoFixture {
                    id: 1_700_000_000_000,
                    cartao: 11,
                    resposta: 3,
                    intervalo: 10,
                    intervalo_anterior: 4,
                    fator: 2500,
                    duracao_ms: 8000,
                    tipo: 1,
                },
                RevisaoFixture {
                    id: 1_700_000_100_000,
                    cartao: 11,
                    resposta: 0,
                    intervalo: 12,
                    intervalo_anterior: 10,
                    fator: 2500,
                    duracao_ms: 0,
                    tipo: 4,
                },
                RevisaoFixture {
                    id: 1_700_000_200_000,
                    cartao: 14,
                    resposta: 1,
                    intervalo: -600,
                    intervalo_anterior: 0,
                    fator: 0,
                    duracao_ms: 3000,
                    tipo: 0,
                },
            ],
            midias: 2,
        }
    }

    /// O `collection.anki2` que o Anki novo põe ao lado do `anki21b`: uma nota
    /// pedindo para atualizar. Criação em 1, para o teste distinguir.
    pub fn aviso_de_formato_novo() -> Self {
        Self {
            criada_em: 1,
            tipos: vec![TipoFixture {
                id: 1,
                nome: "Basic",
                cloze: false,
                campos: vec!["Front", "Back"],
                templates: vec![("Card 1", "{{Front}}", "{{Back}}")],
            }],
            baralhos: vec![(1, "Default", false)],
            notas: vec![NotaFixture {
                id: 1,
                guid: "aviso",
                tipo: 1,
                tags: "",
                campos: vec!["Please update to the latest Anki version, then import the .colpkg/.apkg file again.", ""],
            }],
            cartoes: vec![CartaoFixture::novo(1, 1, 1, 0)],
            revisoes: vec![],
            midias: 0,
        }
    }
}

const TABELAS_COMUNS: &str = "
CREATE TABLE notes (id INTEGER PRIMARY KEY, guid TEXT NOT NULL, mid INTEGER NOT NULL, mod INTEGER NOT NULL,
    usn INTEGER NOT NULL, tags TEXT NOT NULL, flds TEXT NOT NULL, sfld INTEGER NOT NULL, csum INTEGER NOT NULL,
    flags INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER NOT NULL, did INTEGER NOT NULL, ord INTEGER NOT NULL,
    mod INTEGER NOT NULL, usn INTEGER NOT NULL, type INTEGER NOT NULL, queue INTEGER NOT NULL, due INTEGER NOT NULL,
    ivl INTEGER NOT NULL, factor INTEGER NOT NULL, reps INTEGER NOT NULL, lapses INTEGER NOT NULL,
    left INTEGER NOT NULL, odue INTEGER NOT NULL, odid INTEGER NOT NULL, flags INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE revlog (id INTEGER PRIMARY KEY, cid INTEGER NOT NULL, usn INTEGER NOT NULL, ease INTEGER NOT NULL,
    ivl INTEGER NOT NULL, lastIvl INTEGER NOT NULL, factor INTEGER NOT NULL, time INTEGER NOT NULL,
    type INTEGER NOT NULL);
CREATE TABLE col (id INTEGER PRIMARY KEY, crt INTEGER NOT NULL, mod INTEGER NOT NULL DEFAULT 0,
    scm INTEGER NOT NULL DEFAULT 0, ver INTEGER NOT NULL, dty INTEGER NOT NULL DEFAULT 0,
    usn INTEGER NOT NULL DEFAULT 0, ls INTEGER NOT NULL DEFAULT 0, conf TEXT NOT NULL DEFAULT '{}',
    models TEXT NOT NULL DEFAULT '{}', decks TEXT NOT NULL DEFAULT '{}', dconf TEXT NOT NULL DEFAULT '{}',
    tags TEXT NOT NULL DEFAULT '{}');
";

const TABELAS_SCHEMA_NOVO: &str = "
CREATE TABLE notetypes (id INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL COLLATE unicase,
    mtime_secs INTEGER NOT NULL, usn INTEGER NOT NULL, config BLOB NOT NULL);
CREATE UNIQUE INDEX idx_notetypes_name ON notetypes (name);
CREATE TABLE fields (ntid INTEGER NOT NULL, ord INTEGER NOT NULL, name TEXT NOT NULL COLLATE unicase,
    config BLOB NOT NULL, PRIMARY KEY (ntid, ord)) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_fields_name_ntid ON fields (name, ntid);
CREATE TABLE templates (ntid INTEGER NOT NULL, ord INTEGER NOT NULL, name TEXT NOT NULL COLLATE unicase,
    mtime_secs INTEGER NOT NULL, usn INTEGER NOT NULL, config BLOB NOT NULL, PRIMARY KEY (ntid, ord)) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_templates_name_ntid ON templates (name, ntid);
CREATE TABLE decks (id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL COLLATE unicase,
    mtime_secs INTEGER NOT NULL, usn INTEGER NOT NULL, common BLOB NOT NULL, kind BLOB NOT NULL);
CREATE UNIQUE INDEX idx_decks_name ON decks (name);
";

pub async fn pacote_novo(pasta: &Path, fixture: &Fixture) -> PathBuf {
    let sqlite = pasta.join("colecao-nova.sqlite");
    let mut conexao = abrir(&sqlite).await;
    sqlx::raw_sql(TABELAS_COMUNS).execute(&mut conexao).await.unwrap();
    sqlx::raw_sql(TABELAS_SCHEMA_NOVO).execute(&mut conexao).await.unwrap();
    sqlx::query("INSERT INTO col (id, crt, ver) VALUES (1, ?, 18)")
        .bind(fixture.criada_em)
        .execute(&mut conexao)
        .await
        .unwrap();

    for tipo in &fixture.tipos {
        let config = if tipo.cloze { varint(1, 1) } else { Vec::new() };
        sqlx::query("INSERT INTO notetypes (id, name, mtime_secs, usn, config) VALUES (?, ?, 0, 0, ?)")
            .bind(tipo.id)
            .bind(tipo.nome)
            .bind(config)
            .execute(&mut conexao)
            .await
            .unwrap();
        for (ordem, campo) in tipo.campos.iter().enumerate() {
            sqlx::query("INSERT INTO fields (ntid, ord, name, config) VALUES (?, ?, ?, x'')")
                .bind(tipo.id)
                .bind(i64::try_from(ordem).unwrap())
                .bind(*campo)
                .execute(&mut conexao)
                .await
                .unwrap();
        }
        for (ordem, (nome, frente, verso)) in tipo.templates.iter().enumerate() {
            let config = [bytes(1, frente.as_bytes()), bytes(2, verso.as_bytes())].concat();
            sqlx::query("INSERT INTO templates (ntid, ord, name, mtime_secs, usn, config) VALUES (?, ?, ?, 0, 0, ?)")
                .bind(tipo.id)
                .bind(i64::try_from(ordem).unwrap())
                .bind(*nome)
                .bind(config)
                .execute(&mut conexao)
                .await
                .unwrap();
        }
    }

    for (id, nome, filtrado) in &fixture.baralhos {
        let kind = if *filtrado { bytes(2, &varint(1, 1)) } else { bytes(1, &varint(1, 1)) };
        sqlx::query("INSERT INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (?, ?, 0, 0, x'', ?)")
            .bind(id)
            .bind(nome.replace("::", SEPARADOR))
            .bind(kind)
            .execute(&mut conexao)
            .await
            .unwrap();
    }

    inserir_conteudo(&mut conexao, fixture).await;
    conexao.close().await.unwrap();

    let comprimido = zstd::encode_all(std::fs::File::open(&sqlite).unwrap(), 3).unwrap();
    std::fs::remove_file(&sqlite).unwrap();
    let aviso = colecao_antiga(pasta, &Fixture::aviso_de_formato_novo()).await;

    let pacote = pasta.join("formato-novo.apkg");
    escrever_zip(
        &pacote,
        &[("meta", vec![0x08, 0x03]), ("collection.anki21b", comprimido), ("collection.anki2", aviso)],
        fixture.midias,
        zip::CompressionMethod::Stored,
    );
    pacote
}

/// Pacote antigo com uma coleção por entrada, na ordem dada: `("collection.anki2", &fixture)`.
pub async fn pacote_antigo(pasta: &Path, colecoes: &[(&str, &Fixture)]) -> PathBuf {
    let mut entradas = Vec::new();
    for (nome, fixture) in colecoes {
        entradas.push((*nome, colecao_antiga(pasta, fixture).await));
    }
    let midias = colecoes.first().map_or(0, |(_, fixture)| fixture.midias);
    let pacote = pasta.join("formato-antigo.apkg");
    escrever_zip(&pacote, &entradas, midias, zip::CompressionMethod::Deflated);
    pacote
}

/// Os bytes de um SQLite no schema 11.
pub async fn colecao_antiga(pasta: &Path, fixture: &Fixture) -> Vec<u8> {
    let sqlite = pasta.join(format!("colecao-antiga-{}.sqlite", uuid::Uuid::new_v4()));
    let mut conexao = abrir(&sqlite).await;
    sqlx::raw_sql(TABELAS_COMUNS).execute(&mut conexao).await.unwrap();

    let modelos: serde_json::Map<String, serde_json::Value> = fixture
        .tipos
        .iter()
        .map(|tipo| {
            let modelo = serde_json::json!({
                "id": tipo.id,
                "name": tipo.nome,
                "type": i64::from(tipo.cloze),
                "flds": tipo.campos.iter().enumerate().map(|(ord, nome)| serde_json::json!({ "name": nome, "ord": ord })).collect::<Vec<_>>(),
                "tmpls": tipo.templates.iter().enumerate().map(|(ord, (nome, frente, verso))| {
                    serde_json::json!({ "name": nome, "ord": ord, "qfmt": frente, "afmt": verso })
                }).collect::<Vec<_>>(),
            });
            (tipo.id.to_string(), modelo)
        })
        .collect();
    let baralhos: serde_json::Map<String, serde_json::Value> = fixture
        .baralhos
        .iter()
        .map(|(id, nome, filtrado)| {
            (id.to_string(), serde_json::json!({ "id": id, "name": nome, "dyn": i64::from(*filtrado) }))
        })
        .collect();

    sqlx::query("INSERT INTO col (id, crt, ver, models, decks) VALUES (1, ?, 11, ?, ?)")
        .bind(fixture.criada_em)
        .bind(serde_json::Value::Object(modelos).to_string())
        .bind(serde_json::Value::Object(baralhos).to_string())
        .execute(&mut conexao)
        .await
        .unwrap();

    inserir_conteudo(&mut conexao, fixture).await;
    conexao.close().await.unwrap();

    let conteudo = std::fs::read(&sqlite).unwrap();
    std::fs::remove_file(&sqlite).unwrap();
    conteudo
}

async fn abrir(caminho: &Path) -> SqliteConnection {
    SqliteConnectOptions::new()
        .filename(caminho)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Delete)
        .collation("unicase", |a: &str, b: &str| a.to_lowercase().cmp(&b.to_lowercase()))
        .connect()
        .await
        .unwrap()
}

async fn inserir_conteudo(conexao: &mut SqliteConnection, fixture: &Fixture) {
    for nota in &fixture.notas {
        sqlx::query(
            "INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) \
             VALUES (?, ?, ?, 0, 0, ?, ?, 0, 0, 0, '')",
        )
        .bind(nota.id)
        .bind(nota.guid)
        .bind(nota.tipo)
        .bind(nota.tags)
        .bind(nota.campos.join(SEPARADOR))
        .execute(&mut *conexao)
        .await
        .unwrap();
    }
    for c in &fixture.cartoes {
        sqlx::query(
            "INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, \
             odue, odid, flags, data) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, '')",
        )
        .bind(c.id)
        .bind(c.nota)
        .bind(c.baralho)
        .bind(c.ordinal)
        .bind(c.tipo)
        .bind(c.fila)
        .bind(c.due)
        .bind(c.intervalo)
        .bind(c.fator)
        .bind(c.repeticoes)
        .bind(c.lapsos)
        .bind(c.due_original)
        .bind(c.baralho_original)
        .execute(&mut *conexao)
        .await
        .unwrap();
    }
    for r in &fixture.revisoes {
        sqlx::query(
            "INSERT INTO revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)",
        )
        .bind(r.id)
        .bind(r.cartao)
        .bind(r.resposta)
        .bind(r.intervalo)
        .bind(r.intervalo_anterior)
        .bind(r.fator)
        .bind(r.duracao_ms)
        .bind(r.tipo)
        .execute(&mut *conexao)
        .await
        .unwrap();
    }
}

pub fn escrever_zip(destino: &Path, entradas: &[(&str, Vec<u8>)], midias: usize, metodo: zip::CompressionMethod) {
    let mut zip = zip::ZipWriter::new(std::fs::File::create(destino).unwrap());
    let opcoes = zip::write::SimpleFileOptions::default().compression_method(metodo);
    for (nome, conteudo) in entradas {
        zip.start_file(*nome, opcoes).unwrap();
        zip.write_all(conteudo).unwrap();
    }
    for indice in 0..midias {
        zip.start_file(indice.to_string(), opcoes).unwrap();
        zip.write_all(b"midia").unwrap();
    }
    zip.start_file("media", opcoes).unwrap();
    zip.write_all(b"{}").unwrap();
    zip.finish().unwrap();
}

fn varint(numero: u64, valor: u64) -> Vec<u8> {
    let mut saida = codificar_varint(numero << 3);
    saida.extend(codificar_varint(valor));
    saida
}

fn bytes(numero: u64, conteudo: &[u8]) -> Vec<u8> {
    let mut saida = codificar_varint((numero << 3) | 2);
    saida.extend(codificar_varint(u64::try_from(conteudo.len()).unwrap()));
    saida.extend_from_slice(conteudo);
    saida
}

fn codificar_varint(mut valor: u64) -> Vec<u8> {
    let mut saida = Vec::new();
    loop {
        let byte = u8::try_from(valor & 0x7F).unwrap();
        valor >>= 7;
        if valor == 0 {
            saida.push(byte);
            return saida;
        }
        saida.push(byte | 0x80);
    }
}

/// Pasta temporária de um teste, apagada no fim.
pub struct Pasta(pub PathBuf);

impl Pasta {
    pub fn nova(rotulo: &str) -> Self {
        let caminho = std::env::temp_dir().join(format!("learno-teste-anki-{rotulo}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&caminho).unwrap();
        Self(caminho)
    }
}

impl Drop for Pasta {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
