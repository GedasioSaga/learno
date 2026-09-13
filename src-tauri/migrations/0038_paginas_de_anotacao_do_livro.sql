-- Páginas de anotação que o USUÁRIO cria dentro de um livro — substituem, na
-- tela lateral do leitor, a lista automática de capítulos do sumário do EPUB
-- ("1 I ACCIDENTALLY VAPORIZE MY PRE-ALGEBRA TEACHER", "2 ..."), que o usuário
-- não pediu e não ia preencher. O painel de ANOTAÇÕES (grifos de trecho
-- durante a leitura, `library_annotations`, 0022) não é tocado por esta
-- migração — continua existindo, como pedido explicitamente.
--
-- DECISÃO: tabela NOVA (`library_book_pages`), ao lado de `library_chapter_notes`
-- (0033, seção B) — não uma migração no lugar dela. Três motivos, na ordem em
-- que eliminam a alternativa:
--
-- 1. FORMA INCOMPATÍVEL, não só nome errado. `library_chapter_notes` tem
--    `chapter_locator TEXT NOT NULL` dentro de uma `UNIQUE (book_id, chapter_locator)`
--    — a chave natural da tabela é justamente o locator do capítulo do livro.
--    Uma página criada pelo usuário não referencia capítulo nenhum: não tem
--    locator. Para reaproveitar a tabela seria preciso (a) tornar
--    `chapter_locator` opcional e tirar a `UNIQUE` que depende dele — SQLite
--    não faz `ALTER TABLE ... DROP CONSTRAINT`, exigiria reconstruir a tabela
--    inteira — e (b) tirar `CHECK (length(trim(summary)) > 0)`, porque a
--    página nova nasce com conteúdo vazio de propósito (o usuário cria e
--    escreve depois). Depois das duas mudanças, a tabela reconstruída não é
--    mais "resumo por capítulo" nem por forma nem por invariante — é esta
--    tabela nova, só usando o nome e o arquivo de migração errados.
-- 2. DUAS COISAS DIFERENTES, não uma só evoluindo. `chapter_locator` orienta
--    pelo ÍNDICE DO LIVRO (a ordem vem do EPUB/PDF); a página nova é ordenada
--    pela ESCOLHA DO USUÁRIO (por isso o índice fracionário abaixo, não um
--    locator). Guardar as duas na mesma tabela obrigaria toda leitura futura a
--    ramificar em "locator é NULL? então é o modo novo" — um discriminante
--    implícito por ausência de coluna, em vez de duas tabelas com forma
--    própria. `library_categories` vs. `library_vocabulary` (0033) já é
--    precedente de duas capacidades vizinhas em tabelas separadas quando a
--    chave natural diverge.
-- 3. ZERO RISCO DE PERDA, e não por sorte de banco vazio. Não tocar em
--    `library_chapter_notes` preserva qualquer resumo já escrito em QUALQUER
--    banco (o dev não tem nenhum hoje — a tela mostra "Nenhum resumo ainda"
--    em todos os capítulos —, mas o código não pode assumir isso para banco de
--    outro usuário). `db::resumo_capitulo` e seus comandos de IPC continuam
--    registrados em `lib.rs` exatamente como estão; esta migração não mexe
--    neles.
--
-- FORMA da tabela nova, seguindo 0033 como molde:
CREATE TABLE library_book_pages (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
    -- Título dado pelo usuário — sem ele a página não tem como aparecer numa
    -- lista para o usuário escolher; vazio é tratado como ausente (CHECK)
    -- pelo mesmo motivo de `library_categories.name`/`library_vocabulary.term`.
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    -- Texto livre. Sem CHECK de não-vazio — DIFERENTE de `library_chapter_notes.summary`
    -- de propósito: o usuário cria a página pelo título e escreve o conteúdo
    -- depois, então "vazia" é o estado inicial válido, não um erro.
    content TEXT NOT NULL DEFAULT '',
    -- Índice fracionário — mesma técnica de `library_categories.position`
    -- (0033) e `pages.position`/`blocks.position` (0003/0006): a ORDEM AQUI É
    -- DO USUÁRIO, não do livro, exatamente o caso que 0022 (~linha 271)
    -- registra como legítimo para `position` em vez de derivar de outra
    -- coluna. Reordenar escreve uma linha só, nunca renumera as vizinhas.
    position TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- "Páginas deste livro, na ordem do usuário" — a única consulta que a tela
-- faz. Uma coluna só (não `(book_id, position)` composto): o volume por livro
-- é baixo (páginas que uma pessoa escreve à mão, não uma tabela de fatos), o
-- mesmo raciocínio que já vale para `idx_library_chapter_notes_book` e
-- `idx_library_vocabulary_book` ao lado.
CREATE INDEX idx_library_book_pages_book ON library_book_pages (book_id);

CREATE TRIGGER library_book_pages_set_updated_at
AFTER UPDATE ON library_book_pages
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE library_book_pages SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
