-- Fase 5, área BIB: três capacidades que a Biblioteca ainda não tinha —
-- categorias de livro, resumo por capítulo e vocabulário novo. A capa NÃO
-- entra aqui: `library_books.cover_file_name` já existe desde 0022 e só
-- nunca foi preenchida.
--
-- REGRA DE OURO desta migração: ela roda sobre banco de usuário que JÁ TEM
-- livros. Só `CREATE TABLE`/`CREATE INDEX`/`CREATE TRIGGER` — nada aqui
-- apaga nem reescreve `library_books`, `library_reading_progress` ou
-- `library_annotations`.

-- =============================================================================
-- A) CATEGORIAS — N:N entre livro e categoria
-- =============================================================================
--
-- Um livro pode estar em várias categorias e uma categoria agrupa vários
-- livros: relação N:N, por isso duas tabelas — uma coluna de texto com
-- separador não sustentaria filtro nem índice, e reimplementaria em SQL o
-- que uma tabela de junção resolve de graça.
CREATE TABLE library_categories (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    -- Índice fracionário entre categorias — mesma técnica de `pages.position`
    -- (0003) e `blocks.position` (0006): reordenar a lista de categorias
    -- escreve uma linha só, nunca renumera o resto.
    position TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TRIGGER library_categories_set_updated_at
AFTER UPDATE ON library_categories
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE library_categories SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- Nome único, ignorando caixa E acento ("Ficção" e "ficcao" são a MESMA
-- categoria). Um índice de expressão com `lower(name)` só dobraria caixa
-- ASCII — SQLite não tem `unaccent()` nativo, exatamente o que
-- `0015_global_search_accent_insensitive.sql` documenta ao explicar por que
-- aquela migração Postgres não tem equivalente aqui. O que já dobra os dois
-- ao mesmo tempo, no projeto inteiro, é o tokenizador
-- `unicode61 remove_diacritics 2` do FTS5 (0004/0006) — então a mesma
-- técnica é reaproveitada aqui, num índice FTS5 auxiliar dedicado só a esta
-- checagem de duplicata, mantido em sincronia por gatilho do mesmo jeito que
-- `pages_fts`/`blocks_fts`.
CREATE VIRTUAL TABLE library_categories_name_fts USING fts5(
    id UNINDEXED,
    name,
    tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER library_categories_fts_after_insert
AFTER INSERT ON library_categories
BEGIN
    INSERT INTO library_categories_name_fts (id, name) VALUES (NEW.id, NEW.name);
END;

CREATE TRIGGER library_categories_fts_after_update
AFTER UPDATE OF name ON library_categories
BEGIN
    DELETE FROM library_categories_name_fts WHERE id = OLD.id;
    INSERT INTO library_categories_name_fts (id, name) VALUES (NEW.id, NEW.name);
END;

CREATE TRIGGER library_categories_fts_after_delete
AFTER DELETE ON library_categories
BEGIN
    DELETE FROM library_categories_name_fts WHERE id = OLD.id;
END;

-- A checagem em si: BEFORE, para recusar a linha inteira antes dela existir
-- (e antes do gatilho AFTER INSERT acima indexar um nome duplicado).
--
-- `MATCH` com a frase inteira entre aspas (não uma busca livre de termos) é
-- o que faz a comparação ser "mesmo nome", e não "mesmas palavras em
-- qualquer ordem": busca livre casaria "Ciências Sociais" com "Sociais
-- Ciências" como se fossem a mesma categoria. As aspas internas do nome são
-- escapadas dobrando (convenção de frase do próprio FTS5), não removidas.
--
-- `id != NEW.id` exclui a própria linha do resultado — necessário em UPDATE
-- (renomear só a caixa, ex. "Ficção" -> "ficção", não pode colidir consigo
-- mesma, já que o id não muda) e inofensivo em INSERT (nenhuma linha com
-- `NEW.id` existe ainda, então a condição é sempre verdadeira ali).
--
-- A guarda `length(trim(NEW.name)) > 0` evita uma consulta MATCH de frase
-- vazia quando o nome é só espaço — o mesmo caso que o CHECK acima recusa,
-- só que o CHECK roda DEPOIS deste gatilho BEFORE, então sem a guarda a
-- consulta MATCH rodaria de qualquer jeito antes da rejeição.
--
-- EFEITO COLATERAL aceito, não pedido: como o tokenizador também descarta
-- pontuação, "Ficção: Nacional" e "Ficção Nacional" empatam pela mesma
-- regra — mesmo comportamento que a busca global já tem para título de
-- página (0004), então não é uma superfície nova de inconsistência.
CREATE TRIGGER library_categories_name_unico_insert
BEFORE INSERT ON library_categories
FOR EACH ROW
WHEN length(trim(NEW.name)) > 0
    AND EXISTS (
        SELECT 1 FROM library_categories_name_fts
        WHERE library_categories_name_fts MATCH '"' || replace(NEW.name, '"', '""') || '"'
            AND id != NEW.id
    )
BEGIN
    SELECT RAISE(ABORT, 'library_categories.name duplicado (ignorando caixa e acento)');
END;

CREATE TRIGGER library_categories_name_unico_update
BEFORE UPDATE OF name ON library_categories
FOR EACH ROW
WHEN length(trim(NEW.name)) > 0
    AND EXISTS (
        SELECT 1 FROM library_categories_name_fts
        WHERE library_categories_name_fts MATCH '"' || replace(NEW.name, '"', '""') || '"'
            AND id != NEW.id
    )
BEGIN
    SELECT RAISE(ABORT, 'library_categories.name duplicado (ignorando caixa e acento)');
END;

-- A junção. Sem `id` próprio: a chave natural já é o par, mesmo precedente
-- de `library_reading_progress` (0022) para "não duplicar chave onde a
-- natural já basta". `ON DELETE CASCADE` nos dois lados: apagar o livro (via
-- lixeira esvaziada) ou apagar a categoria remove só o VÍNCULO, nunca o
-- outro lado.
CREATE TABLE library_book_categories (
    book_id TEXT NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES library_categories(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, category_id)
) STRICT;

-- A direção inversa ("livros desta categoria") não é coberta pela chave
-- primária (que começa por `book_id`), e é exatamente a consulta que a tela
-- de categoria faz para listar seus livros.
CREATE INDEX idx_library_book_categories_category ON library_book_categories (category_id);

-- =============================================================================
-- B) RESUMO POR CAPÍTULO
-- =============================================================================
--
-- `chapter_locator` é TEXT, e não um número, pelo mesmo motivo de
-- `library_reading_progress.current_locator` (0022): a unidade de capítulo
-- não tem uma forma só. Num EPUB o índice (spine/TOC) referencia capítulo
-- por HREF do manifesto ("text/cap05.xhtml") — não um inteiro sequencial
-- confiável, já que a ordem de leitura e a ordem do manifesto podem
-- divergir. Num PDF não existe TOC estruturado igual: o que a tela tem para
-- identificar "capítulo" é o número da página onde ele começa. Os dois
-- formatos não cabem na mesma coluna numérica sem forçar um a fingir ser o
-- outro; quem interpreta o valor é o Rust, olhando `library_books.format` —
-- mesma decisão que 0022 já tomou para `current_locator`/`furthest_locator`.
CREATE TABLE library_chapter_notes (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
    chapter_locator TEXT NOT NULL,
    -- Título do capítulo, quando o formato o expõe (TOC do EPUB) ou o
    -- usuário o digita (PDF não tem TOC estruturado). NULL é "sem título
    -- conhecido", não "capítulo sem nome" — a tela cai no locator bruto.
    chapter_title TEXT,
    summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Um resumo por capítulo: reescrever o mesmo capítulo SUBSTITUI o resumo
    -- anterior, não acumula um segundo. O caminho de escrita faz
    -- `INSERT ... ON CONFLICT (book_id, chapter_locator) DO UPDATE`.
    UNIQUE (book_id, chapter_locator)
) STRICT;

-- "Resumos deste livro, na ordem em que os capítulos foram anotados" — a
-- tela de resumo por capítulo lista por livro; a UNIQUE acima já cobre
-- `(book_id, chapter_locator)`, então este índice é só `book_id` para a
-- consulta que não filtra por locator específico.
CREATE INDEX idx_library_chapter_notes_book ON library_chapter_notes (book_id);

CREATE TRIGGER library_chapter_notes_set_updated_at
AFTER UPDATE ON library_chapter_notes
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE library_chapter_notes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- =============================================================================
-- C) VOCABULÁRIO — palavras novas colhidas durante a leitura
-- =============================================================================
--
-- `UNIQUE (book_id, term)` sem diferenciar caixa nem acento, pela MESMA
-- técnica do item A (índice FTS5 auxiliar + gatilho BEFORE com MATCH de
-- frase, não uma `UNIQUE` de SQL literal — o motor não tem como dobrar
-- acento numa constraint declarativa, é o motivo de A existir): a mesma
-- palavra colhida duas vezes no mesmo livro é uma palavra só, e
-- "mitocôndria" colhida de novo como "Mitocôndria" precisa achar a linha
-- existente em vez de duplicá-la.
--
-- Diferente da categoria, aqui a checagem é POR LIVRO: duas linhas com o
-- mesmo termo em livros diferentes não são duplicata (a MESMA palavra pode
-- ser vocabulário novo em dois livros distintos, com contexto e nota
-- próprios em cada um) — por isso o índice FTS5 guarda `book_id` como coluna
-- UNINDEXED extra e o MATCH some com um filtro adicional
-- `AND book_id = NEW.book_id` para restringir a comparação ao mesmo livro.
CREATE TABLE library_vocabulary (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
    term TEXT NOT NULL CHECK (length(trim(term)) > 0),
    -- O trecho onde a palavra apareceu, CONGELADO no momento da coleta —
    -- mesmo raciocínio de `library_annotations.excerpt` (0022): o arquivo
    -- pode sumir da pasta de dados, e a entrada de vocabulário continua
    -- legível porque vive no banco.
    context_snippet TEXT,
    note TEXT,
    -- Onde a palavra foi colhida, no MESMO formato de locator do item B —
    -- NULL quando a palavra foi digitada à mão sem vir de uma seleção no
    -- texto (o usuário lembrou da palavra depois e a adicionou de memória).
    locator TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- "Vocabulário deste livro" — a tela de revisão de palavras abre por
-- `book_id`. Sem uma `UNIQUE (book_id, term)` de SQL literal (ver acima),
-- este índice não nasce de graça e precisa ser declarado à parte.
CREATE INDEX idx_library_vocabulary_book ON library_vocabulary (book_id);

CREATE TRIGGER library_vocabulary_set_updated_at
AFTER UPDATE ON library_vocabulary
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE library_vocabulary SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE VIRTUAL TABLE library_vocabulary_term_fts USING fts5(
    id UNINDEXED,
    book_id UNINDEXED,
    term,
    tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER library_vocabulary_fts_after_insert
AFTER INSERT ON library_vocabulary
BEGIN
    INSERT INTO library_vocabulary_term_fts (id, book_id, term) VALUES (NEW.id, NEW.book_id, NEW.term);
END;

CREATE TRIGGER library_vocabulary_fts_after_update
AFTER UPDATE OF term ON library_vocabulary
BEGIN
    DELETE FROM library_vocabulary_term_fts WHERE id = OLD.id;
    INSERT INTO library_vocabulary_term_fts (id, book_id, term) VALUES (NEW.id, NEW.book_id, NEW.term);
END;

CREATE TRIGGER library_vocabulary_fts_after_delete
AFTER DELETE ON library_vocabulary
BEGIN
    DELETE FROM library_vocabulary_term_fts WHERE id = OLD.id;
END;

CREATE TRIGGER library_vocabulary_term_unico_insert
BEFORE INSERT ON library_vocabulary
FOR EACH ROW
WHEN length(trim(NEW.term)) > 0
    AND EXISTS (
        SELECT 1 FROM library_vocabulary_term_fts
        WHERE library_vocabulary_term_fts MATCH '"' || replace(NEW.term, '"', '""') || '"'
            AND book_id = NEW.book_id
            AND id != NEW.id
    )
BEGIN
    SELECT RAISE(ABORT, 'library_vocabulary.term duplicado neste livro (ignorando caixa e acento)');
END;

CREATE TRIGGER library_vocabulary_term_unico_update
BEFORE UPDATE OF term ON library_vocabulary
FOR EACH ROW
WHEN length(trim(NEW.term)) > 0
    AND EXISTS (
        SELECT 1 FROM library_vocabulary_term_fts
        WHERE library_vocabulary_term_fts MATCH '"' || replace(NEW.term, '"', '""') || '"'
            AND book_id = NEW.book_id
            AND id != NEW.id
    )
BEGIN
    SELECT RAISE(ABORT, 'library_vocabulary.term duplicado neste livro (ignorando caixa e acento)');
END;
