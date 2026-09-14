//! Campo do Anki é HTML; a tela de estudo do Learno mostra texto. A conversão
//! acontece uma vez, na importação.

/// Converte o HTML de um campo do Anki em texto legível.
///
/// - `<br>` e o início ou fim de bloco (`div`, `p`, `li`...) viram quebra de
///   linha;
/// - `<img src="x">` vira `[imagem: x]` e `[sound:x]` vira `[áudio: x]`: a
///   mídia não é importada, então o marcador diz o que havia ali;
/// - conteúdo de `<style>`, `<script>` e comentário some inteiro;
/// - entidades são decodificadas DEPOIS de tirar as tags, para `&lt;b&gt;`
///   virar o texto `<b>` e não uma tag;
/// - espaço no fim da linha some, e linhas em branco seguidas viram uma.
///
/// `<` que não abre tag ("a < b") é texto. Marcação de cloze (`{{c1::...}}`)
/// não é tag e atravessa intacta.
pub fn html_para_texto(html: &str) -> String {
    let sem_tags = tirar_tags(html);
    let com_marcadores = sem_tags.replace("[sound:", "[áudio: ");
    normalizar_linhas(&decodificar_entidades(&com_marcadores))
}

const BLOCOS: [&str; 13] =
    ["div", "p", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table"];

fn tirar_tags(html: &str) -> String {
    let mut saida = String::with_capacity(html.len());
    let mut resto = html;

    while let Some(inicio) = resto.find('<') {
        saida.push_str(&resto[..inicio]);
        let depois = &resto[inicio..];

        if let Some(comentario) = depois.strip_prefix("<!--") {
            resto = comentario.find("-->").map_or("", |fim| &comentario[fim + 3..]);
            continue;
        }

        let abre_tag = depois[1..].chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '/' || c == '!');
        let Some(fim) = depois.find('>').filter(|_| abre_tag) else {
            saida.push('<');
            resto = &depois[1..];
            continue;
        };

        let tag = &depois[1..fim];
        resto = &depois[fim + 1..];
        let (fechamento, nome) = nome_da_tag(tag);

        if nome == "br" {
            saida.push('\n');
        } else if BLOCOS.contains(&nome.as_str()) {
            if !saida.is_empty() && !saida.ends_with('\n') {
                saida.push('\n');
            }
        } else if nome == "img" && !fechamento {
            if let Some(src) = atributo(tag, "src") {
                saida.push_str(&format!("[imagem: {src}]"));
            }
        } else if (nome == "style" || nome == "script") && !fechamento {
            resto = pular_bloco(resto, &format!("</{nome}"));
        }
    }

    saida.push_str(resto);
    saida
}

/// `("/div")` -> `(true, "div")`; `("br/")` -> `(false, "br")`.
fn nome_da_tag(tag: &str) -> (bool, String) {
    let (fechamento, corpo) = match tag.strip_prefix('/') {
        Some(corpo) => (true, corpo),
        None => (false, tag),
    };
    let nome: String = corpo.chars().take_while(char::is_ascii_alphanumeric).collect();
    (fechamento, nome.to_ascii_lowercase())
}

/// Valor de um atributo, com aspas duplas, simples ou nenhuma.
fn atributo(tag: &str, nome: &str) -> Option<String> {
    // `to_ascii_lowercase` preserva o tamanho em bytes, então as posições
    // achadas na cópia minúscula valem no original.
    let minusculo = tag.to_ascii_lowercase();
    let mut busca = 0;
    while let Some(achado) = minusculo[busca..].find(nome) {
        let inicio = busca + achado;
        busca = inicio + nome.len();
        let comeca_palavra = inicio == 0 || minusculo.as_bytes()[inicio - 1].is_ascii_whitespace();
        let depois_do_nome = minusculo[busca..].trim_start();
        if !comeca_palavra || !depois_do_nome.starts_with('=') {
            continue;
        }

        let posicao_do_igual = minusculo.len() - depois_do_nome.len();
        let valor_bruto = tag[posicao_do_igual + 1..].trim_start();
        let valor = match valor_bruto.chars().next() {
            Some(aspas @ ('"' | '\'')) => valor_bruto[1..].split(aspas).next().unwrap_or_default(),
            _ => valor_bruto.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or_default(),
        };
        return (!valor.is_empty()).then(|| decodificar_entidades(valor));
    }
    None
}

/// Tudo depois do `>` que fecha `fechamento` (`"</style"`), sem diferenciar caixa.
fn pular_bloco<'a>(resto: &'a str, fechamento: &str) -> &'a str {
    match resto.to_ascii_lowercase().find(fechamento) {
        Some(inicio) => resto[inicio..].find('>').map_or("", |fim| &resto[inicio + fim + 1..]),
        None => "",
    }
}

fn decodificar_entidades(texto: &str) -> String {
    // Nenhuma entidade que interessa tem mais de 10 caracteres entre `&` e `;`;
    // o limite evita tratar "& ... ;" de uma frase inteira como entidade.
    const MAIOR_ENTIDADE: usize = 10;

    let mut saida = String::with_capacity(texto.len());
    let mut resto = texto;
    while let Some(inicio) = resto.find('&') {
        saida.push_str(&resto[..inicio]);
        let depois = &resto[inicio..];
        let decodificada = depois
            .find(';')
            .filter(|fim| *fim <= MAIOR_ENTIDADE)
            .and_then(|fim| entidade(&depois[1..fim]).map(|caractere| (caractere, fim)));
        match decodificada {
            Some((caractere, fim)) => {
                saida.push(caractere);
                resto = &depois[fim + 1..];
            }
            None => {
                saida.push('&');
                resto = &depois[1..];
            }
        }
    }
    saida.push_str(resto);
    saida
}

fn entidade(nome: &str) -> Option<char> {
    match nome {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        // Espaço comum, não U+00A0: o texto vai para uma tela e para busca,
        // onde o espaço inseparável só atrapalha.
        "nbsp" => Some(' '),
        _ => {
            let numero = if let Some(hex) = nome.strip_prefix("#x").or_else(|| nome.strip_prefix("#X")) {
                u32::from_str_radix(hex, 16).ok()?
            } else {
                nome.strip_prefix('#')?.parse::<u32>().ok()?
            };
            char::from_u32(numero)
        }
    }
}

fn normalizar_linhas(texto: &str) -> String {
    let mut linhas: Vec<&str> = Vec::new();
    for linha in texto.lines().map(str::trim_end) {
        if linha.is_empty() && linhas.last().is_some_and(|anterior| anterior.is_empty()) {
            continue;
        }
        linhas.push(linha);
    }
    linhas.join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quebra_de_linha_e_blocos() {
        assert_eq!(html_para_texto("Olá<br>mundo"), "Olá\nmundo");
        assert_eq!(html_para_texto("<div>linha 1</div><div>linha 2</div>"), "linha 1\nlinha 2");
        assert_eq!(html_para_texto("texto<div>segunda</div>"), "texto\nsegunda");
        assert_eq!(html_para_texto("<ul><li>um</li><li>dois</li></ul>"), "um\ndois");
    }

    #[test]
    fn formatacao_some_e_o_texto_fica() {
        assert_eq!(html_para_texto("<b>negrito</b> e <i>itálico</i>"), "negrito e itálico");
        assert_eq!(html_para_texto(r#"<span style="color: red">vermelho</span>"#), "vermelho");
    }

    #[test]
    fn imagem_e_audio_viram_marcador() {
        assert_eq!(html_para_texto(r#"<img src="rim.png">"#), "[imagem: rim.png]");
        assert_eq!(html_para_texto("<IMG class=x SRC='a b.jpg' />"), "[imagem: a b.jpg]");
        assert_eq!(html_para_texto("<img data-src=\"x\" src=y.gif>"), "[imagem: y.gif]");
        assert_eq!(html_para_texto("[sound:pronuncia.mp3]"), "[áudio: pronuncia.mp3]");
    }

    #[test]
    fn entidades_sao_decodificadas_depois_das_tags() {
        assert_eq!(html_para_texto("&lt;b&gt; &amp; &nbsp;x &#233; &#xE9;"), "<b> &  x é é");
        assert_eq!(html_para_texto("&naoexiste; & sozinho"), "&naoexiste; & sozinho");
    }

    #[test]
    fn cloze_atravessa_intacto() {
        assert_eq!(
            html_para_texto("A {{c1::mitocôndria}} produz <b>{{c2::ATP::energia}}</b>"),
            "A {{c1::mitocôndria}} produz {{c2::ATP::energia}}"
        );
    }

    #[test]
    fn style_script_e_comentario_somem_inteiros() {
        assert_eq!(html_para_texto("<style>.card{color:red}</style>texto"), "texto");
        assert_eq!(html_para_texto("<SCRIPT>alert(1)</script>ok"), "ok");
        assert_eq!(html_para_texto("<!-- oculto -->visível"), "visível");
        assert_eq!(html_para_texto("<style>sem fim"), "");
    }

    #[test]
    fn menor_que_solto_e_texto() {
        assert_eq!(html_para_texto("a < b e c > d"), "a < b e c > d");
        assert_eq!(html_para_texto("1<2"), "1<2");
        assert_eq!(html_para_texto("termina com <"), "termina com <");
    }

    #[test]
    fn linhas_em_branco_seguidas_viram_uma() {
        assert_eq!(html_para_texto("a<br><br><br><br>b"), "a\n\nb");
        assert_eq!(html_para_texto("  <br>a   <br>  "), "a");
        assert_eq!(html_para_texto(""), "");
    }
}
