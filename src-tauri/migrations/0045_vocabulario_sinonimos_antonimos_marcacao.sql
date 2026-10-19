-- Vocabulário do leitor: sinônimos, antônimos e marcação no livro.
--
-- `synonyms`/`antonyms` são listas de texto guardadas como array JSON, no
-- mesmo espírito de `notes.tags` (0011): a lista é sempre lida e gravada
-- inteira junto com a palavra, nunca consultada item a item, então uma
-- tabela filha só acrescentaria JOIN sem ganho. O `CHECK` garante que o que
-- está ali é um array, não um objeto ou um escalar solto. A normalização
-- (trim, sem vazio, sem duplicata ignorando caixa/acento, tetos) mora em
-- `db::vocabulario`, que é o único escritor.
--
-- `highlight_in_book` liga a marcação da palavra no texto do livro onde ela
-- foi colhida. DEFAULT 1 de propósito: palavra nova nasce marcada, e toda
-- linha que já existia antes desta migração também passa a ser marcada —
-- é o comportamento que o usuário pediu para palavra colhida.
ALTER TABLE library_vocabulary ADD COLUMN synonyms TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(synonyms) AND json_type(synonyms) = 'array');
ALTER TABLE library_vocabulary ADD COLUMN antonyms TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(antonyms) AND json_type(antonyms) = 'array');
ALTER TABLE library_vocabulary ADD COLUMN highlight_in_book INTEGER NOT NULL DEFAULT 1
  CHECK (highlight_in_book IN (0, 1));
