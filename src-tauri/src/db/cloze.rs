//! Parser puro e TOTAL de cloze deletion (`{{c1::texto}}` /
//! `{{c1::texto::dica}}`) — a sintaxe e a semântica de
//! `docs.ankiweb.net/editing.html` (seção "Cloze Deletion"), que a bar desta
//! peça cita como régua:
//!
//! - `{{c1::texto}}` esconde `texto` e pertence ao cartão de número 1;
//! - números diferentes geram cartões diferentes (`c1` e `c2` → dois
//!   cartões; o resto do texto aparece nos dois);
//! - o MESMO número usado duas vezes esconde as duas ocorrências no MESMO
//!   cartão;
//! - `{{c1::texto::dica}}` mostra `dica` no lugar da lacuna, em vez de um
//!   vazio anônimo;
//! - lacunas não precisam cair em fronteira de palavra;
//! - números não precisam ser contíguos (`c1` e `c5` sem os do meio é
//!   válido).
//!
//! TOTAL significa: nenhuma entrada, por mais hostil (`{{c1::` sem fechar,
//! aninhado, `{{c0::}}`, número que não cabe num inteiro, texto vazio dentro
//! da lacuna, `::` sobrando, chaves desbalanceadas), entra em pânico ou trava
//! num laço infinito — uma nota malformada não pode derrubar a sessão de
//! estudo. As duas funções públicas deste módulo não devolvem `Result`: para
//! TODA entrada, mesmo a mais corrompida, existe uma resposta — o pior caso é
//! "nenhuma lacuna encontrada" ou "texto de volta inalterado", nunca um erro.
//!
//! Este módulo não toca banco nem `db::notes` — quem decide o que fazer com
//! os números devolvidos (criar cartão, orfanizar, etc.) é
//! `db::notes::NoteRepository`.
//!
//! ## Uma gramática só: por que a tela recebe SEGMENTOS, e não a string
//!
//! A tela de estudo (`src/features/cartoes/EstudoSessao.tsx`) precisa
//! desenhar a lacuna como lacuna — destaque visível no meio do texto corrido,
//! com a dica dentro — e, ao revelar, pôr o texto escondido no MESMO lugar.
//! Duas saídas foram consideradas e uma foi rejeitada:
//!
//! - **Reimplementar o parser em TypeScript.** Rejeitada: seriam duas
//!   gramáticas da mesma sintaxe, uma em cada lado do fio, divergindo em
//!   silêncio na primeira borda que uma trata e a outra não (`c0`, `::`
//!   sobrando, aninhamento — cada caso hostil dos testes abaixo teria que
//!   ser copiado à mão e mantido em sincronia para sempre). É o mesmo motivo
//!   pelo qual a coloração de sintaxe das fórmulas ficou de fora
//!   (`HANDOFF.md`, seção de Fórmulas).
//! - **Entregar só a string de [`render_cloze`] (`"[...]"`).** Rejeitada
//!   também, por um motivo mais sutil: para destacar a lacuna, o TypeScript
//!   teria que PROCURAR `[...]`/`[dica]` no texto renderizado — uma segunda
//!   gramática disfarçada, e ambígua, porque colchetes são texto legítimo
//!   numa nota.
//!
//! A saída adotada é [`segment_cloze`]: o Rust devolve a lista de trechos
//! já classificados (`hidden: true` para a lacuna alvo, com o texto e a
//! dica separados; `hidden: false` para o resto), e o TypeScript só percorre
//! a lista e escolhe o `<span>`. Zero interpretação do lado da tela. O custo
//! aceito é um campo a mais no `CardToStudy` (`db::cards`), que a trava
//! `src/lib/contrato-ipc.test.ts` cobra em `ipc.ts` — e é exatamente o que
//! se quer: a costura conferida por teste, não por memória.

use serde::Serialize;

/// Um trecho do texto de uma nota cloze, já resolvido para UM cartão
/// (um número de lacuna). É a forma que atravessa o IPC dentro de
/// `CardToStudy.cloze` (ver `db::cards`) — espelhada por `ClozeSegment` em
/// `src/lib/ipc.ts`.
///
/// Invariantes que a tela pode assumir:
/// - concatenar `text` de todos os segmentos, na ordem, dá o "verso" completo
///   (todas as lacunas reveladas);
/// - `hidden == true` é a lacuna DESTE cartão: `text` é a resposta (só pode
///   entrar no DOM depois de revelar), `hint` é o que aparece no lugar dela
///   antes disso (`None` → a tela mostra reticências);
/// - `hidden == false` é texto visível desde a frente — literal ou lacuna de
///   OUTRO número, já com o conteúdo dela; `hint` é sempre `None` aqui;
/// - segmentos visíveis adjacentes já vêm fundidos (nunca dois `hidden ==
///   false` seguidos), então a lista é o menor conjunto de spans possível.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClozeSegment {
    pub text: String,
    pub hidden: bool,
    pub hint: Option<String>,
}

/// Um trecho do texto original depois de tokenizado: ou um pedaço literal
/// (fora de qualquer `{{...}}` reconhecido), ou uma lacuna cloze válida.
/// Interno — as duas funções públicas do módulo são a API; nenhum chamador
/// externo precisa do token em si.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClozeToken<'a> {
    Literal(&'a str),
    Cloze { numero: u32, conteudo: &'a str, dica: Option<&'a str> },
}

/// Quebra `texto` numa sequência de tokens que, concatenados de volta (todo
/// `Literal` verbatim, todo `Cloze` como `{{cN::conteudo}}` ou
/// `{{cN::conteudo::dica}}`), reproduziriam o texto original — a prova de
/// que nenhum byte é perdido nem inventado, só reconhecido ou não.
///
/// Avança por busca literal de `"{{c"`/`"::"`/`"}}"` (nunca por regex — o
/// crate teria que entrar via `cargo add`, e uma gramática desta simplicidade
/// não precisa de uma dependência nova). Quando uma tentativa de
/// reconhecimento falha em qualquer ponto (dígito ausente, `"::"` ausente,
/// `"}}"` nunca encontrado), o laço NUNCA trava: ele recua um caractere (não
/// um byte cru — `is_char_boundary` garante que nunca corta um caractere
/// multi-byte ao meio), marca esse único caractere como literal, e tenta de
/// novo a partir dali. Cada iteração consome pelo menos um caractere do
/// texto (seja como parte de uma lacuna reconhecida, seja como um único
/// caractere literal), então o laço termina sempre, em no máximo
/// `texto.chars().count()` iterações de recuo.
fn tokenize(texto: &str) -> Vec<ClozeToken<'_>> {
    let mut tokens = Vec::new();
    let mut pos = 0usize;
    let total_bytes = texto.len();

    while pos < total_bytes {
        let restante = &texto[pos..];
        let Some(idx_relativo) = restante.find("{{c") else {
            tokens.push(ClozeToken::Literal(&texto[pos..]));
            break;
        };
        let start = pos + idx_relativo;
        if start > pos {
            tokens.push(ClozeToken::Literal(&texto[pos..start]));
        }

        match parse_one_cloze(texto, start) {
            Some((token, fim)) => {
                tokens.push(token);
                pos = fim;
            }
            None => {
                // Não é uma lacuna válida (dígito ausente, "::" ausente ou
                // "}}" nunca encontrado) — recua exatamente 1 caractere,
                // tratado como literal, e deixa a próxima volta do laço
                // procurar "{{c" de novo a partir dali. `"{{c"` é ASCII puro,
                // então `start + 1` já cai numa fronteira de char válida sem
                // precisar do laço de `is_char_boundary` — mas ele fica aqui
                // mesmo assim, porque nada nesta função depende de a busca
                // ter encontrado exatamente ASCII (defesa contra este código
                // mudar um dia sem que esta garantia mude junto).
                let mut proximo = start + 1;
                while !texto.is_char_boundary(proximo) {
                    proximo += 1;
                }
                tokens.push(ClozeToken::Literal(&texto[start..proximo]));
                pos = proximo;
            }
        }
    }

    tokens
}

/// Tenta reconhecer uma lacuna cloze começando exatamente em `start` (onde
/// `texto[start..]` começa com `"{{c"` — garantido por quem chama, via
/// `str::find`). Devolve o token e o byte logo após o `"}}"` de fechamento
/// quando a gramática inteira bate; `None` para qualquer desvio — dígito
/// ausente ou fora do alcance de `u32`, `"::"` ausente depois do número,
/// número zero (Anki numera lacunas a partir de 1), ou `"}}"` nunca
/// encontrado dali em diante.
///
/// Toda indexação usa offsets devolvidos por `str::find`/contagem de bytes
/// ASCII (dígitos, `"::"`, `"}}"`), nunca um valor inventado — todos caem em
/// fronteira de char válida por construção, então nenhuma fatia aqui pode
/// entrar em pânico por cortar um caractere multi-byte ao meio (o conteúdo
/// entre os marcadores pode ser qualquer UTF-8, acentuação inclusive).
fn parse_one_cloze(texto: &str, start: usize) -> Option<(ClozeToken<'_>, usize)> {
    let bytes = texto.as_bytes();
    let mut idx = start + 3; // pula "{{c"

    let digits_start = idx;
    while idx < bytes.len() && bytes[idx].is_ascii_digit() {
        idx += 1;
    }
    if idx == digits_start {
        return None; // "{{c" sem nenhum dígito depois não é uma lacuna.
    }

    // Número que não cabe num `u32` (nota corrompida ou hostil): `parse`
    // devolve `Err`, nunca entra em pânico — `.ok()?` trata isso como "não é
    // uma lacuna válida", igual a qualquer outro desvio de gramática aqui.
    let numero: u32 = texto[digits_start..idx].parse().ok()?;
    if numero == 0 {
        return None; // Anki numera lacunas a partir de 1; c0 não é válido.
    }

    if !texto[idx..].starts_with("::") {
        return None;
    }
    idx += 2;

    let resto = &texto[idx..];
    let fechamento_relativo = resto.find("}}")?;
    let conteudo_bruto = &resto[..fechamento_relativo];
    let fim = idx + fechamento_relativo + 2;

    // Separador dentro do conteúdo, se houver, é a PRIMEIRA ocorrência de
    // "::" (não a última): `{{c1::texto::dica}}` tem exatamente uma, mas uma
    // entrada hostil com "::" sobrando (`{{c1::a::b::c}}`) precisa de uma
    // regra determinística mesmo assim — texto é tudo antes da primeira
    // "::", dica é tudo depois, "::" extra incluído verbatim dentro da dica.
    let (conteudo, dica) = match conteudo_bruto.find("::") {
        Some(separador) => (&conteudo_bruto[..separador], Some(&conteudo_bruto[separador + 2..])),
        None => (conteudo_bruto, None),
    };

    Some((ClozeToken::Cloze { numero, conteudo, dica }, fim))
}

/// Todo número de lacuna presente em `texto`, ordenado e sem repetição — na
/// geração de cartão (`db::notes`), cada um vira exatamente um cartão. Números
/// não precisam ser contíguos: `"{{c1::a}} {{c5::b}}"` devolve `[1, 5]`, nunca
/// `[1, 2, 3, 4, 5]`. Texto sem nenhuma lacuna reconhecível (vazio, hostil, ou
/// simplesmente sem `{{...}}`) devolve `vec![]` — nunca um erro.
pub fn parse_cloze_numbers(texto: &str) -> Vec<u32> {
    let mut numeros: Vec<u32> = tokenize(texto)
        .into_iter()
        .filter_map(|token| match token {
            ClozeToken::Cloze { numero, .. } => Some(numero),
            ClozeToken::Literal(_) => None,
        })
        .collect();
    numeros.sort_unstable();
    numeros.dedup();
    numeros
}

/// O texto renderizado para o cartão da lacuna `alvo`: toda ocorrência de
/// `alvo` fica escondida — a dica entre colchetes quando houver
/// (`{{c1::texto::dica}}` → `"[dica]"`), senão `"[...]"` (mesma convenção do
/// próprio Anki para uma lacuna sem dica); toda ocorrência de QUALQUER outro
/// número fica visível, com o texto que ela esconderia; todo trecho fora de
/// lacuna nenhuma passa inalterado.
///
/// Duas ocorrências do MESMO `alvo` ficam escondidas as duas, no mesmo
/// cartão — não por um caso especial aqui, mas porque cada token é resolvido
/// independente dos outros: se dois tokens carregam `numero == alvo`, os dois
/// batem na mesma condição.
///
/// `alvo` que não existe em `texto` (nenhum token bate) devolve o texto com
/// TODAS as lacunas visíveis — o mesmo resultado de pedir o "verso" completo
/// de uma nota; nunca um erro, mesmo para um número que
/// [`parse_cloze_numbers`] jamais devolveria para este `texto`.
pub fn render_cloze(texto: &str, alvo: u32) -> String {
    // Escrita por cima de `segment_cloze` de propósito: as duas funções
    // precisam concordar sempre, e a maneira de garantir isso não é testar
    // as duas contra os mesmos casos, é fazer uma ser derivada da outra.
    let mut saida = String::with_capacity(texto.len());
    for segmento in segment_cloze(texto, alvo) {
        if segmento.hidden {
            saida.push('[');
            saida.push_str(segmento.hint.as_deref().unwrap_or("..."));
            saida.push(']');
        } else {
            saida.push_str(&segmento.text);
        }
    }
    saida
}

/// O texto de uma nota cloze quebrado em [`ClozeSegment`]s para o cartão da
/// lacuna `alvo` — a forma estruturada de [`render_cloze`], para a tela poder
/// destacar a lacuna sem interpretar nada (ver o comentário de módulo, "Uma
/// gramática só").
///
/// As mesmas regras de [`render_cloze`], só que preservando a estrutura:
/// toda ocorrência de `alvo` vira um segmento `hidden: true` com o conteúdo
/// em `text` e a dica em `hint`; toda outra lacuna vira texto visível com o
/// conteúdo dela; todo literal passa inalterado. Trechos visíveis adjacentes
/// são fundidos num segmento só.
///
/// TOTAL como o resto do módulo: qualquer entrada devolve uma lista (vazia
/// para `""`), nunca um erro. `alvo` ausente no texto (nota editada depois
/// de o cartão nascer, número corrompido, `0`) devolve tudo visível, sem
/// nenhum `hidden` — a tela trata "nenhuma lacuna" como estado próprio.
pub fn segment_cloze(texto: &str, alvo: u32) -> Vec<ClozeSegment> {
    /// Anexa texto visível, fundindo com o segmento visível anterior se
    /// houver — é o que garante "nunca dois `hidden == false` seguidos".
    fn empurrar_visivel(segmentos: &mut Vec<ClozeSegment>, pedaco: &str) {
        if pedaco.is_empty() {
            return;
        }
        match segmentos.last_mut() {
            Some(ultimo) if !ultimo.hidden => ultimo.text.push_str(pedaco),
            _ => segmentos.push(ClozeSegment { text: pedaco.to_string(), hidden: false, hint: None }),
        }
    }

    let mut segmentos: Vec<ClozeSegment> = Vec::new();

    for token in tokenize(texto) {
        match token {
            ClozeToken::Literal(pedaco) => empurrar_visivel(&mut segmentos, pedaco),
            ClozeToken::Cloze { numero, conteudo, dica } if numero == alvo => segmentos.push(ClozeSegment {
                text: conteudo.to_string(),
                hidden: true,
                hint: dica.map(str::to_string),
            }),
            ClozeToken::Cloze { conteudo, .. } => empurrar_visivel(&mut segmentos, conteudo),
        }
    }

    segmentos
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn uma_lacuna_simples() {
        assert_eq!(parse_cloze_numbers("A capital da França é {{c1::Paris}}."), vec![1]);
    }

    #[test]
    fn numeros_diferentes_geram_dois_cartoes() {
        assert_eq!(parse_cloze_numbers("{{c1::A}} e {{c2::B}}"), vec![1, 2]);
    }

    #[test]
    fn numeros_nao_precisam_ser_contiguos() {
        assert_eq!(parse_cloze_numbers("{{c1::A}} ... {{c5::B}}"), vec![1, 5], "c1 e c5 sem os do meio é válido");
    }

    #[test]
    fn mesmo_numero_duas_vezes_esconde_as_duas_ocorrencias_no_mesmo_cartao() {
        let texto = "{{c1::A}} e {{c1::B}}";
        assert_eq!(parse_cloze_numbers(texto), vec![1], "um número usado duas vezes é UM cartão, não dois");
        assert_eq!(render_cloze(texto, 1), "[...] e [...]", "as duas ocorrências escondem juntas");
    }

    #[test]
    fn dica_aparece_no_lugar_da_lacuna_escondida() {
        let texto = "{{c1::mitocôndria::organela}}";
        assert_eq!(render_cloze(texto, 1), "[organela]");
    }

    #[test]
    fn sem_dica_mostra_reticencias() {
        let texto = "{{c1::mitocôndria}}";
        assert_eq!(render_cloze(texto, 1), "[...]");
    }

    #[test]
    fn outras_lacunas_ficam_visiveis_com_o_texto_delas() {
        let texto = "{{c1::A}} e {{c2::B}}";
        assert_eq!(render_cloze(texto, 1), "[...] e B");
        assert_eq!(render_cloze(texto, 2), "A e [...]");
    }

    #[test]
    fn lacuna_nao_precisa_cair_em_fronteira_de_palavra() {
        let texto = "cardio{{c1::vascular}} é o sistema";
        assert_eq!(render_cloze(texto, 1), "cardio[...] é o sistema");
        assert_eq!(parse_cloze_numbers(texto), vec![1]);
    }

    #[test]
    fn texto_sem_nenhuma_lacuna_passa_inalterado() {
        let texto = "Nada de especial aqui.";
        assert_eq!(render_cloze(texto, 1), texto);
        assert!(parse_cloze_numbers(texto).is_empty());
    }

    #[test]
    fn alvo_que_nao_existe_devolve_tudo_visivel() {
        let texto = "{{c1::A}} e {{c2::B}}";
        assert_eq!(render_cloze(texto, 99), "A e B");
    }

    // --- Entradas hostis: nada abaixo pode entrar em pânico. ---

    #[test]
    fn lacuna_sem_fechar_nao_trava_nem_gera_cartao() {
        let texto = "{{c1::isto nunca fecha";
        assert!(parse_cloze_numbers(texto).is_empty());
        assert_eq!(render_cloze(texto, 1), texto, "sem fechamento, o texto volta inalterado");
    }

    #[test]
    fn numero_zero_nao_e_lacuna_valida() {
        let texto = "{{c0::x}}";
        assert!(parse_cloze_numbers(texto).is_empty(), "Anki numera lacunas a partir de 1");
    }

    #[test]
    fn numero_gigante_que_nao_cabe_num_u32_nao_derruba_o_parser() {
        let texto = "{{c99999999999999999999::x}}";
        assert!(parse_cloze_numbers(texto).is_empty());
        assert_eq!(render_cloze(texto, 1), texto);
    }

    #[test]
    fn texto_vazio_dentro_da_lacuna_e_uma_lacuna_valida() {
        let texto = "{{c1::}}";
        assert_eq!(parse_cloze_numbers(texto), vec![1]);
        assert_eq!(render_cloze(texto, 1), "[...]");
    }

    #[test]
    fn dois_pontos_sobrando_viram_parte_da_dica() {
        let texto = "{{c1::a::b::c}}";
        assert_eq!(parse_cloze_numbers(texto), vec![1]);
        assert_eq!(render_cloze(texto, 1), "[b::c]");
        assert_eq!(render_cloze(texto, 2), "a", "sem ser o alvo, mostra só o texto (antes do primeiro '::')");
    }

    #[test]
    fn chaves_desbalanceadas_um_fechamento_a_menos_nao_derruba_o_parser() {
        let texto = "{{c1::a}";
        assert!(parse_cloze_numbers(texto).is_empty());
        assert_eq!(render_cloze(texto, 1), texto);
    }

    #[test]
    fn chaves_desbalanceadas_uma_abertura_a_menos_nao_derruba_o_parser() {
        let texto = "{c1::a}}";
        assert!(parse_cloze_numbers(texto).is_empty());
        assert_eq!(render_cloze(texto, 1), texto);
    }

    #[test]
    fn lacuna_aninhada_nao_derruba_o_parser() {
        // Aninhamento não é sintaxe suportada pelo Anki nem por este parser —
        // a única garantia aqui é NUNCA entrar em pânico. O resultado exato
        // (a lacuna interna vira parte do conteúdo/dica da externa, porque o
        // parser para no PRIMEIRO "}}" que encontra) é documentado por este
        // teste para que uma mudança futura no comportamento seja deliberada,
        // não um acidente silencioso.
        let texto = "{{c1::a {{c2::b}} c}}";
        assert_eq!(parse_cloze_numbers(texto), vec![1]);
        assert_eq!(render_cloze(texto, 1), "[b] c}}");
    }

    #[test]
    fn entrada_vazia_nao_derruba_o_parser() {
        assert!(parse_cloze_numbers("").is_empty());
        assert_eq!(render_cloze("", 1), "");
    }

    #[test]
    fn string_so_de_chaves_nao_derruba_o_parser() {
        let texto = "{{{{{{}}}}}}";
        assert!(parse_cloze_numbers(texto).is_empty());
        assert_eq!(render_cloze(texto, 1), texto);
    }

    // --- segment_cloze: a forma estruturada que atravessa o IPC. ---

    fn visivel(texto: &str) -> ClozeSegment {
        ClozeSegment { text: texto.to_string(), hidden: false, hint: None }
    }

    fn escondido(texto: &str, dica: Option<&str>) -> ClozeSegment {
        ClozeSegment { text: texto.to_string(), hidden: true, hint: dica.map(str::to_string) }
    }

    #[test]
    fn segmentos_separam_lacuna_alvo_do_resto() {
        let texto = "A capital da França é {{c1::Paris}}.";
        assert_eq!(
            segment_cloze(texto, 1),
            vec![visivel("A capital da França é "), escondido("Paris", None), visivel(".")]
        );
    }

    #[test]
    fn segmentos_carregam_a_dica_separada_do_texto() {
        assert_eq!(segment_cloze("{{c1::mitocôndria::organela}}", 1), vec![escondido("mitocôndria", Some("organela"))]);
    }

    #[test]
    fn segmentos_de_outro_numero_viram_texto_visivel_fundido_com_os_vizinhos() {
        // "{{c2::B}}" no cartão 1 não é lacuna — é texto, e funde com o
        // literal ao redor num segmento só (a tela não precisa de um span
        // por token, só por MUDANÇA de estado).
        let texto = "{{c1::A}} e {{c2::B}} fim";
        assert_eq!(segment_cloze(texto, 1), vec![escondido("A", None), visivel(" e B fim")]);
        assert_eq!(segment_cloze(texto, 2), vec![visivel("A e "), escondido("B", None), visivel(" fim")]);
    }

    #[test]
    fn segmentos_escondem_as_duas_ocorrencias_do_mesmo_numero() {
        assert_eq!(
            segment_cloze("{{c1::A}} e {{c1::B}}", 1),
            vec![escondido("A", None), visivel(" e "), escondido("B", None)]
        );
    }

    #[test]
    fn concatenar_os_segmentos_reproduz_o_verso_completo() {
        // A invariante que a tela usa para o "verso": todo `text`, na ordem.
        let texto = "cardio{{c1::vascular}} é {{c2::um::artigo}} sistema";
        let verso: String = segment_cloze(texto, 1).into_iter().map(|s| s.text).collect();
        assert_eq!(verso, "cardiovascular é um sistema");
    }

    #[test]
    fn alvo_ausente_devolve_tudo_visivel_sem_nenhum_escondido() {
        let segmentos = segment_cloze("{{c1::A}} e {{c2::B}}", 99);
        assert_eq!(segmentos, vec![visivel("A e B")]);
        assert!(segmentos.iter().all(|s| !s.hidden));
    }

    #[test]
    fn alvo_zero_nunca_esconde_nada() {
        // `template_ordinal` corrompido/negativo vira 0 em `db::cards`; 0
        // nunca é lacuna válida, então o pior caso é "tudo visível".
        assert_eq!(segment_cloze("{{c1::A}}", 0), vec![visivel("A")]);
    }

    #[test]
    fn segmentos_de_entrada_vazia_e_hostil_nao_derrubam() {
        assert!(segment_cloze("", 1).is_empty());
        assert_eq!(segment_cloze("{{c1::sem fechar", 1), vec![visivel("{{c1::sem fechar")]);
        assert_eq!(segment_cloze("{{{{{{}}}}}}", 1), vec![visivel("{{{{{{}}}}}}")]);
        assert_eq!(segment_cloze("{{c1::}}", 1), vec![escondido("", None)], "lacuna vazia é lacuna, com texto vazio");
    }

    #[test]
    fn render_cloze_e_segment_cloze_concordam_em_todo_caso_dos_testes_acima() {
        for texto in [
            "A capital da França é {{c1::Paris}}.",
            "{{c1::mitocôndria::organela}}",
            "{{c1::A}} e {{c2::B}} fim",
            "{{c1::A}} e {{c1::B}}",
            "{{c1::a::b::c}}",
            "{{c1::a {{c2::b}} c}}",
            "{{c1::sem fechar",
            "",
        ] {
            for alvo in [0, 1, 2, 99] {
                let via_segmentos: String = segment_cloze(texto, alvo)
                    .into_iter()
                    .map(|s| if s.hidden { format!("[{}]", s.hint.as_deref().unwrap_or("...")) } else { s.text })
                    .collect();
                assert_eq!(render_cloze(texto, alvo), via_segmentos, "texto={texto:?} alvo={alvo}");
            }
        }
    }

    #[test]
    fn muitas_lacunas_desbalanceadas_seguidas_terminam_sem_travar() {
        // Regressão de laço infinito: uma sequência longa de aberturas sem
        // fechamento nenhum precisa terminar (não travar) e não pode gerar
        // lacuna nenhuma.
        let texto = "{{c1::".repeat(200);
        assert!(parse_cloze_numbers(&texto).is_empty());
    }
}
