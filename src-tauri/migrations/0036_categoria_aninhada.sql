-- Fase 5, Biblioteca: categoria dentro de categoria. Mesmo precedente de
-- árvore que `pages.parent_id` já estabeleceu (0003) — profundidade livre
-- (D2) é só a ausência de um CHECK que a limitasse, não algo que o schema
-- precisa resolver.
--
-- `ADD COLUMN` simples, como em 0032/0034: coluna nasce opcional (sem
-- `NOT NULL`), então não exige o procedimento de 12 passos que uma tabela
-- STRICT pediria para uma coluna obrigatória. `NULL` = categoria de raiz —
-- exatamente o que TODA categoria já existente é hoje, então nenhuma delas
-- muda de nome nem some: elas só ganham um `parent_id` vazio, que é o
-- default de uma coluna nova sem valor informado.
--
-- D4 (apagar um pai que tem filho) — decisão: RECUSAR, não promover.
-- `CategoriaRepository::remover` conta as subcategorias e devolve
-- `Error::Invalid` ANTES de qualquer `DELETE` chegar aqui — essa é a
-- mensagem que a tela mostra, e o motivo de escolher recusar em vez de
-- promover os filhos ao avô (a outra opção oferecida pelo pedido) está lá:
-- promover colide direto com D3 (nome único por PAI), porque o avô pode já
-- ter uma categoria com o mesmo nome de uma sendo promovida, e decidir o que
-- fazer com esse choque não é uma escolha que o usuário pediu nem teria como
-- prever antes de apagar. `ON DELETE RESTRICT` aqui é só o SEGUNDO cinto:
-- se um caminho de escrita futuro pular o repositório (migração, script,
-- edição direta em `sqlite3`), o próprio banco recusa a linha em vez de
-- apagar o pai e deixar o filho com um `parent_id` órfão silencioso.
ALTER TABLE library_categories ADD COLUMN parent_id TEXT
    REFERENCES library_categories(id) ON DELETE RESTRICT;

-- Toda consulta de árvore (filho direto, descendente, ancestral para checar
-- ciclo) começa por um lookup de `parent_id` — mesmo precedente de
-- `idx_pages_parent_id` (0003).
CREATE INDEX idx_library_categories_parent_id ON library_categories (parent_id);

-- =============================================================================
-- D3: nome único entre IRMÃOS, não mais no banco inteiro.
-- =============================================================================
--
-- A checagem de duplicata (seção A de 0033) continua sendo o MESMO índice
-- FTS5 auxiliar (`library_categories_name_fts`) e a MESMA sintaxe de MATCH
-- de frase entre aspas — só o ESCOPO da comparação muda. Duas técnicas
-- possíveis para restringir por pai:
--
--   (a) acrescentar `parent_id` como coluna UNINDEXED na própria tabela
--       virtual FTS5 — a técnica que `library_vocabulary_term_fts` já usa
--       para `book_id` — só que isso exige DROP + CREATE da tabela virtual
--       e reindexar toda categoria já existente dentro desta migração; ou
--   (b) manter a tabela virtual como está e voltar à tabela base
--       (`library_categories`) com um JOIN em `id`, filtrando por
--       `c.parent_id IS NEW.parent_id` — o `IS`, não `=`, porque
--       `parent_id` pode ser NULL dos dois lados (duas categorias de raiz) e
--       SQLite só compara NULL corretamente com `IS`/`IS NOT`.
--
-- Esta migração escolhe (b): zero risco em cima do índice que já existe (a
-- tabela virtual não é tocada, nenhuma reindexação roda), e o JOIN só lê de
-- outro lugar o mesmo dado que o índice já guardava (`id`). Os gatilhos
-- antigos são SUBSTITUÍDOS pelos de baixo, não remendados — SQLite não tem
-- `CREATE OR REPLACE TRIGGER`.
--
-- O gatilho de UPDATE passa a disparar também quando `parent_id` muda (além
-- de `name`, como antes): mover uma categoria para um novo pai que já tem um
-- filho com o mesmo nome é exatamente a mesma colisão que renomear dentro do
-- mesmo pai — `CategoriaRepository::mover` faz a mesma pré-checagem em Rust
-- para nomear a categoria conflitante na mensagem, e este gatilho continua
-- sendo a garantia de verdade por baixo (pega qualquer escrita que não passe
-- pelo repositório).
DROP TRIGGER library_categories_name_unico_insert;
DROP TRIGGER library_categories_name_unico_update;

CREATE TRIGGER library_categories_name_unico_insert
BEFORE INSERT ON library_categories
FOR EACH ROW
WHEN length(trim(NEW.name)) > 0
    AND EXISTS (
        SELECT 1 FROM library_categories_name_fts
        JOIN library_categories c ON c.id = library_categories_name_fts.id
        WHERE library_categories_name_fts MATCH '"' || replace(NEW.name, '"', '""') || '"'
            AND library_categories_name_fts.id != NEW.id
            AND c.parent_id IS NEW.parent_id
    )
BEGIN
    SELECT RAISE(ABORT, 'library_categories.name duplicado entre irmãos (ignorando caixa e acento)');
END;

CREATE TRIGGER library_categories_name_unico_update
BEFORE UPDATE OF name, parent_id ON library_categories
FOR EACH ROW
WHEN length(trim(NEW.name)) > 0
    AND EXISTS (
        SELECT 1 FROM library_categories_name_fts
        JOIN library_categories c ON c.id = library_categories_name_fts.id
        WHERE library_categories_name_fts MATCH '"' || replace(NEW.name, '"', '""') || '"'
            AND library_categories_name_fts.id != NEW.id
            AND c.parent_id IS NEW.parent_id
    )
BEGIN
    SELECT RAISE(ABORT, 'library_categories.name duplicado entre irmãos (ignorando caixa e acento)');
END;
