-- Backs FUN-037 (global search). Na versão Postgres isto era uma coluna
-- gerada `tsvector` + índice GIN, depois refeita em 0015 para ficar
-- insensível a acento via `unaccent`. Em SQLite as duas migrações colapsam
-- numa só: FTS5 com `tokenize = "unicode61 remove_diacritics 2"` já nasce
-- insensível a acento — não existe um passo de normalização separado para
-- refazer depois, então 0015 inteira deixa de existir (ver
-- `docs/MIGRACAO-SQLITE.md`).
--
-- Verificado (não assumido) contra este exato binário SQLite: FTS5 está
-- compilado (a feature `bundled` do `libsqlite3-sys` traz FTS5 sem flag
-- extra), e uma busca por "mitocondria" acha uma linha com "mitocôndria" e
-- vice-versa.
--
-- Tabela FTS5 separada (não "external content"): `pages.id` é TEXT/UUID, não
-- um inteiro de rowid estável entre reconstruções do arquivo, então usar
-- `content_rowid` arriscaria desalinhar o índice de um `VACUUM INTO`
-- (PLT-020) para o outro. Duplicar o título (pequeno, uma linha por página)
-- é mais barato que esse risco.
CREATE VIRTUAL TABLE pages_fts USING fts5(
    id UNINDEXED,
    title,
    tokenize = "unicode61 remove_diacritics 2"
);

-- Mantido em sincronia por gatilho — nunca por quem escreve `pages.title` se
-- lembrar de chamar algo. Um INSERT/DELETE explícito (não UPDATE OR REPLACE)
-- porque FTS5 não tem uma forma de "atualizar a linha com este id": o id
-- aqui é uma coluna UNINDEXED comum, sem chave única imposta pelo módulo.
CREATE TRIGGER pages_fts_after_insert
AFTER INSERT ON pages
BEGIN
    INSERT INTO pages_fts (id, title) VALUES (NEW.id, NEW.title);
END;

CREATE TRIGGER pages_fts_after_update
AFTER UPDATE OF title ON pages
BEGIN
    DELETE FROM pages_fts WHERE id = OLD.id;
    INSERT INTO pages_fts (id, title) VALUES (NEW.id, NEW.title);
END;

CREATE TRIGGER pages_fts_after_delete
AFTER DELETE ON pages
BEGIN
    DELETE FROM pages_fts WHERE id = OLD.id;
END;
