//! O sistema de tipos e de valores da fórmula (arquitetura §4/§9).
//!
//! `Type` é o que o checador estático usa (DBS-085); `Value` é o que o
//! avaliador produz. Os dois são fechados de propósito — o mesmo raciocínio
//! do `ValueShape` de `src/features/databases/contract.ts` (arquitetura §6):
//! um `match` exaustivo aqui é o que garante que ninguém esqueça um tipo
//! numa regra de operador ou numa função nova.
//!
//! **`Value::Empty` não é um `Type`.** É um valor que habita TODO tipo — a
//! checagem estática nunca vê "tipo vazio": uma propriedade `Number` que
//! está vazia tem tipo estático `Number` e valor de runtime `Value::Empty`.
//! Ver `eval.rs` para a propagação (aritmética/texto/data) e a regra de
//! comparação (I4, arquitetura §4).

use std::fmt;

use serde_json::json;
use uuid::Uuid;

/// `database_properties.id`. Alias, não newtype: todo o resto do crate já
/// passa `Uuid` cru nessa posição (ver a assinatura congelada de
/// `ValueSource` em `eval.rs`), e um newtype aqui obrigaria conversão nos
/// dois lados sem nenhum ganho de tipo — o `Uuid` já não se confunde com
/// `RecordId` por engano num `match` porque os dois são o mesmo tipo de
/// propósito.
pub type PropertyId = Uuid;

/// O conjunto FECHADO de tipos que a linguagem conhece. Como
/// `ValueShape` (arquitetura §6), um tipo novo não se "estende" por fora —
/// alguém edita este `enum` e todo `match` não-exaustivo vira erro do
/// compilador, o que é o ponto.
///
/// **Divergência da arquitetura, nomeada:** a prosa da §4 lista "number,
/// string, boolean, date, list<T>, page" como o sistema de tipos. DBS-082/083
/// exigem `prop("Responsável").at(0).email()` — acesso a nome/e-mail de um
/// valor Pessoa (`PersonValue` em `contract.ts`, JÁ existente como forma de
/// valor de propriedade, distinta de `page`: um contato local não é uma
/// página). Sem um tipo próprio para isso, F6 (página/pessoa) não tem como
/// tipar estaticamente `.email()` — teria que fingir que Pessoa é `Page` ou
/// desistir de checagem estática ali, violando DBS-085 bem onde o checklist
/// mais pede (metadado de pessoa). Adicionei `Person` como sétimo tipo
/// primitivo para fechar essa lacuna; nenhuma outra peça desta fase depende
/// da lista de seis, então a extensão não colide com nada.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Type {
    Number,
    String,
    Boolean,
    Date,
    Page,
    Person,
    List(Box<Type>),
}

impl fmt::Display for Type {
    /// Em português, porque toda mensagem de diagnóstico (DBS-085) que cita
    /// um tipo passa por aqui e vai direto para a caixa de erro do editor.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Type::Number => write!(f, "número"),
            Type::String => write!(f, "texto"),
            Type::Boolean => write!(f, "booleano"),
            Type::Date => write!(f, "data"),
            Type::Page => write!(f, "página"),
            Type::Person => write!(f, "pessoa"),
            Type::List(item) => write!(f, "lista<{item}>"),
        }
    }
}

/// I5: `{start, end?}` de largura fixa, hora local, sem segundos. Espelha
/// `DateValue` de `contract.ts` campo a campo. A validação de formato mora
/// em [`DateValue::parse`] — nenhum outro caminho deste módulo constrói um
/// `DateValue` a partir de texto sem passar por ela, então um valor de data
/// que existe já está no formato que a ordenação lexicográfica exige.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateValue {
    pub start: String,
    pub end: Option<String>,
}

impl DateValue {
    /// `true` só para `YYYY-MM-DD` ou `YYYY-MM-DDTHH:MM` — a MESMA forma que
    /// `chk_drv_iso_date_shape` (`0017`) valida em SQL. Feito à mão (sem
    /// `regex`, que não está no `Cargo.toml` e a regra 2 proíbe adicionar por
    /// suposição) porque a forma é fixa o bastante para não precisar de uma
    /// gramática: dez dígitos com traços em posição fixa, e opcionalmente
    /// "T" + quatro dígitos com dois-pontos.
    ///
    /// Opera em BYTES, nunca em `&text[a..b]`: uma entrada adversária (texto
    /// digitado por um usuário, formatado por uma função de data que não
    /// gerou o que se esperava) pode ter comprimento de bytes 10 ou 16 sem
    /// que essas posições sejam fronteira de caractere UTF-8 válida — fatiar
    /// `&str` ali entraria em pânico (regra 3), e a linguagem é TOTAL. Um
    /// comparativo byte a byte nunca precisa de fronteira de char.
    fn is_valid_component(bytes: &[u8]) -> bool {
        let digits_at = |range: std::ops::Range<usize>| bytes.get(range).is_some_and(|s| s.iter().all(u8::is_ascii_digit));

        match bytes.len() {
            10 => digits_at(0..4) && bytes[4] == b'-' && digits_at(5..7) && bytes[7] == b'-' && digits_at(8..10),
            16 => {
                Self::is_valid_component(&bytes[0..10])
                    && bytes[10] == b'T'
                    && digits_at(11..13)
                    && bytes[13] == b':'
                    && digits_at(14..16)
            }
            _ => false,
        }
    }

    /// Constrói um `DateValue` validando a forma dos dois campos e que
    /// `end` (quando presente) tem a MESMA largura de `start` — a regra que
    /// `chk_drv_iso_date_shape` já não cobre sozinha (o CHECK aceita `end`
    /// mais curto ou mais longo que `start`; aqui é onde isso vira erro, não
    /// um valor que quebraria I2 silenciosamente mais adiante). `None`
    /// quando a forma é inválida — o chamador (uma função de data de F3, ou
    /// `parsePlainText` de um import) decide se isso vira `Value::Empty`
    /// (a linguagem é TOTAL) ou um diagnóstico.
    pub fn parse(start: &str, end: Option<&str>) -> Option<Self> {
        if !Self::is_valid_component(start.as_bytes()) {
            return None;
        }
        match end {
            None => Some(Self { start: start.to_string(), end: None }),
            Some(end) if end.len() == start.len() && Self::is_valid_component(end.as_bytes()) => {
                Some(Self { start: start.to_string(), end: Some(end.to_string()) })
            }
            Some(_) => None,
        }
    }
}

/// Metadado de página que `ValueSource::page_meta` devolve — o que
/// `id()`/uma futura função de "título da página" (F6) precisam, sem dar a
/// elas acesso a `pages` inteira. Não é `PropertyValue`: nenhuma dessas
/// colunas tem linha em `database_record_values` (arquitetura §6, notas de
/// `created_time`/`last_edited_time`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageMeta {
    pub id: Uuid,
    pub title: String,
    /// I5: já no formato `YYYY-MM-DDTHH:MM` (hora local, sem segundos) —
    /// convertido pelo adaptador de `ValueSource`, não aqui, porque só quem
    /// lê `pages.created_at`/`updated_at` (um `TIMESTAMPTZ`) sabe em que
    /// fuso o "hora local" do usuário está.
    pub created_at: String,
    pub updated_at: String,
}

/// Um contato local (DBS-082/083). Espelha `PersonValue` de `contract.ts`
/// campo a campo — "não há conta, login nem perfil", só nome e e-mail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonValue {
    pub name: String,
    pub email: Option<String>,
}

/// O que o avaliador produz. Um `match` exaustivo sobre isto é o que
/// [`Type`] promete: todo `Value` tem exatamente um `Type` estático (via
/// [`Value::type_of`]), MENOS `Empty`, que é válido para qualquer um —
/// "vazio é um valor habitando todo tipo" (arquitetura §4). Nenhuma
/// variante carrega `NaN`/`Infinity`: a linguagem é TOTAL exatamente para
/// que isto nunca precise existir (jsonb não representa nenhum dos dois).
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Empty,
    Number(f64),
    String(String),
    Boolean(bool),
    Date(DateValue),
    Page(Uuid),
    Person(PersonValue),
    List(Vec<Value>),
}

impl Value {
    /// O tipo estático de um valor NÃO-vazio. `None` para `Empty`, de
    /// propósito: perguntar "qual o tipo de vazio" não faz sentido no
    /// vocabulário desta linguagem (arquitetura §4) — o chamador que
    /// precisa de um tipo estático (o checador) sempre já sabe o tipo
    /// esperado pelo contexto (o tipo da propriedade, o tipo do outro lado
    /// de um operador), nunca precisa perguntar a um `Value::Empty` runtime
    /// "que tipo você é".
    pub fn type_of(&self) -> Option<Type> {
        match self {
            Value::Empty => None,
            Value::Number(_) => Some(Type::Number),
            Value::String(_) => Some(Type::String),
            Value::Boolean(_) => Some(Type::Boolean),
            Value::Date(_) => Some(Type::Date),
            Value::Page(_) => Some(Type::Page),
            Value::Person(_) => Some(Type::Person),
            Value::List(items) => {
                // Lista vazia: sem elemento nenhum para inferir `T`, então
                // não há tipo estático a devolver — coerente com o mesmo
                // "não force um tipo que não dá para saber" de `Empty`
                // acima. Um `Value::List` sempre nasce de uma expressão já
                // tipada estaticamente (o checador conhece `T` pelo `prop()`
                // ou pela função que o produziu), então nenhum chamador
                // deste método precisa arrancar `T` de uma lista vazia em
                // runtime.
                let item_type = items.first().and_then(Value::type_of)?;
                Some(Type::List(Box::new(item_type)))
            }
        }
    }

    /// Serialização para o valor que atravessa a fronteira IPC
    /// (`preview_formula`) — pura, sem `serde` no tipo `Value` em si, porque
    /// o formato exato na borda é decisão de `ipc::formula_commands`
    /// (poderia mudar de forma sem mexer no núcleo). `Empty` vira `null`: é
    /// exatamente como uma célula vazia de `database_record_values` já se
    /// comporta (I1 — a linha simplesmente não existe, e o cliente já trata
    /// ausência como `null` no mapa `RecordRow.values`).
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Value::Empty => serde_json::Value::Null,
            Value::Number(n) => json!(n),
            Value::String(s) => json!(s),
            Value::Boolean(b) => json!(b),
            Value::Date(d) => json!({ "start": d.start, "end": d.end }),
            Value::Page(id) => json!(id),
            Value::Person(p) => json!({ "name": p.name, "email": p.email }),
            Value::List(items) => serde_json::Value::Array(items.iter().map(Value::to_json).collect()),
        }
    }
}
