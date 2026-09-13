-- Fase 5, área BIB: o acervo de livros (PDF e EPUB) com progresso de leitura.
--
-- ============================================================================
-- A DECISÃO DE ENTRADA: o livro é um REGISTRO de database, e estas tabelas são
-- satélites dele — não a identidade dele.
-- ============================================================================
--
-- A pergunta ("registro da Fase 3 ou tabela própria?") se decide pelas
-- consultas que as telas fazem, e elas puxam para os dois lados. As três que
-- exigem que o livro seja um registro (uma linha de `pages` com `database_id`
-- preenchido, como em 0007):
--
-- 1. BIB-012: a Biblioteca é uma VIEW da database — capa, título, status e
--    barra, com a ordenação, o filtro e o agrupamento da view. Toda essa
--    máquina (0008, 0009, 0017) só sabe ler `database_record_values`. Um
--    livro em tabela própria obrigaria a reimplementar filtro, ordenação,
--    agrupamento e rodapé para uma tabela que a view não conhece — a mesma
--    tela duas vezes, divergindo na segunda.
-- 2. BIB-003: abrir o livro mostra leitor + propriedades + CORPO DE BLOCOS na
--    mesma tela. Corpo de blocos é `blocks.page_id`: sem página não há onde as
--    anotações serem escritas, nem lixeira, nem histórico de versão, nem
--    busca global — tudo isso o registro herda de graça.
-- 3. BIB-011: uma etapa da Trilha aponta para um livro e mostra o progresso
--    dele. Apontar é `database_relation_edges` (0018), que referencia
--    `pages(id)`. Uma linha de tabela própria não é endereçável por lá.
--
-- E as três consultas que o registro NÃO responde bem, que são a razão destas
-- tabelas existirem:
--
-- 1. BIB-001: "já existe livro com este conteúdo?" a cada importação. Em EAV
--    isso é varrer `database_record_values` comparando JSON; aqui é um índice
--    UNIQUE sobre `content_hash`, e a duplicata é recusada pelo banco em vez
--    de por uma varredura que alguém pode esquecer de fazer.
-- 2. Abrir o leitor precisa de formato, caminho e contagem de páginas em uma
--    leitura de linha inteira. Em EAV são N linhas e um pivô, para dados que
--    são escritos UMA vez (na importação) e lidos em toda abertura.
-- 3. A posição de leitura é escrita a cada virada de página. Escrevê-la como
--    valor de propriedade dispararia o gatilho de `pages.updated_at` de 0017 a
--    cada rolagem, sujando "modificado em" e o histórico de versões da página
--    com um evento que não é edição de conteúdo.
--
-- COMO O DADO SE DIVIDE, então, entre os dois lados:
--
--   `pages.title`            -> o título mostrado (uma fonte só; a sidebar, a
--                              busca e a view já leem de lá)
--   `database_record_values` -> o que a VIEW filtra e ordena: Autor, Status,
--                              Progresso %, Categoria
--   estas tabelas            -> os fatos do ARQUIVO e da LEITURA
--
-- O espelho de progresso para a propriedade (BIB-011) é escrito pelo caminho
-- único de escrita de valores (invariante I4), NÃO por gatilho daqui: uma
-- migração não pode conhecer o id da propriedade "Progresso", que nasce em
-- tempo de execução quando a database Biblioteca é criada. Pelo mesmo motivo
-- esta migração não semeia a database nem suas propriedades — ids vêm do Rust
-- (ver `docs/MIGRACAO-SQLITE.md`, tabela de equivalências).

-- O lado ARQUIVO do livro: escrito uma vez na importação, reescrito só numa
-- reimportação (BIB-015). Sem `deleted_at` — a lixeira é a da página; apagar
-- de verdade só acontece ao esvaziar a lixeira, e aí a cascata leva livro,
-- progresso e anotações junto.
CREATE TABLE library_books (
    id TEXT PRIMARY KEY NOT NULL,
    -- 1:1 com o registro. UNIQUE e não só REFERENCES: duas linhas de livro
    -- para a mesma página seriam duas leituras concorrentes do mesmo registro,
    -- e o erro apareceria longe (a barra oscilando entre dois valores).
    page_id TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
    -- BIB-002: só estes dois. MOBI/AZW normalmente têm DRM e estão fora de
    -- questão; o CHECK existe para que um formato novo entre por migração
    -- (decisão revisada), nunca por um INSERT distraído.
    format TEXT NOT NULL CHECK (format IN ('pdf', 'epub')),
    -- SHA-256 em hex minúsculo do conteúdo do arquivo — a MESMA função que
    -- `storeMediaFile` já usa para mídia de bloco (`media-storage.ts`), para o
    -- livro reusar o armazenamento da Fase 2 em vez de inventar um segundo.
    -- UNIQUE é o que faz BIB-001 ("jogar o mesmo arquivo de novo reconhece a
    -- duplicata") ser garantia do banco, e não boa vontade do chamador.
    -- O CHECK fixa a forma canônica: comprimento 64 e nenhum caractere fora de
    -- [0-9a-f]. Sem ele, o mesmo arquivo com o hash em maiúsculas viraria uma
    -- segunda linha e a deduplicação falharia em silêncio.
    content_hash TEXT NOT NULL UNIQUE
        CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
    -- Só o NOME do arquivo dentro de `<pasta de dados>/media`, no formato
    -- "<hash><extensão>" — exatamente o que `content.src` de um bloco de mídia
    -- guarda. Caminho absoluto está proibido de propósito: quebraria o backup
    -- restaurado em outra máquina e o "alterar a pasta de dados".
    file_name TEXT NOT NULL,
    -- O nome que o arquivo tinha quando o usuário o arrastou. Não serve para
    -- abrir nada (o arquivo foi copiado); serve para o diálogo de BIB-015
    -- dizer QUAL arquivo reimportar, e para explicar de onde o título veio.
    original_file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL CHECK (file_size > 0),
    -- Capa extraída do arquivo, mesma convenção de `file_name`. NULL = o
    -- arquivo não tinha capa, ou ela ainda não foi extraída; a galeria de
    -- BIB-012 cai no substituto visual.
    cover_file_name TEXT,
    -- O que o ARQUIVO declarou (o /Author do PDF, o dc:creator do OPF do
    -- EPUB), e não o que o usuário vê. O autor exibido e filtrável é
    -- propriedade do registro; separar os dois é o que permite a reimportação
    -- reescrever a proveniência sem apagar a correção feita à mão.
    metadata_title TEXT,
    metadata_author TEXT,
    -- PDF: número de páginas, o "M" do "página N de M" de BIB-004.
    -- EPUB: número de itens do spine (capítulos), que serve para "capítulo N
    -- de M" e NUNCA para a barra — capítulo não tem tamanho fixo, então a
    -- barra de um EPUB vem da fração em `library_reading_progress`.
    -- NULL enquanto o arquivo não foi aberto e contado.
    total_units INTEGER CHECK (total_units IS NULL OR total_units > 0),
    -- BIB-006/007: 1 = há camada de texto (o modo leitura é oferecido), 0 =
    -- é digitalizado (o modo leitura NÃO é oferecido, e a tela explica por
    -- quê), NULL = ainda não foi analisado. O terceiro estado é significativo:
    -- sem ele, "não sei" e "não tem" se confundem, e um livro recém-importado
    -- apareceria como digitalizado antes de qualquer análise.
    has_text_layer INTEGER CHECK (has_text_layer IN (0, 1)),
    -- A data de adição ao acervo. É o `created_at` mesmo, e não uma coluna
    -- `added_at` à parte, porque a linha nasce na importação e a reimportação
    -- de BIB-015 atualiza a linha existente em vez de criar outra — o livro
    -- entrou no acervo uma vez só.
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Da página para o livro: a tela de BIB-003 abre por `page_id`, que é o que a
-- rota e a view conhecem. O UNIQUE acima já cria o índice dessa direção, então
-- nenhum índice adicional é declarado aqui.

-- Ver 0002_updated_at_trigger.sql: SQLite não tem função de gatilho
-- compartilhada, então cada tabela declara a sua; o `WHEN` evita rodar quando
-- quem escreveu já setou `updated_at`, e impede a recursão.
CREATE TRIGGER library_books_set_updated_at
AFTER UPDATE ON library_books
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE library_books SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- O lado LEITURA. Tabela separada de `library_books` porque as duas têm ritmos
-- de escrita opostos: os fatos do arquivo são escritos uma vez, a posição é
-- escrita a cada virada de página. Separadas, rolar o livro não toca a linha
-- do arquivo nem dispara o gatilho de `updated_at` dela.
--
-- DUAS COISAS DIFERENTES, e é aqui que mora a feature (BIB-009):
--
--   `current_*`  onde o usuário parou   -> "continuar de onde parou" (BIB-008)
--   `furthest_*` o ponto mais distante  -> a BARRA (BIB-009)
--
-- Voltar ao capítulo 1 para revisar move `current_*` para trás e deixa
-- `furthest_*` onde estava, porque reler não desfaz leitura.
--
-- POSIÇÃO É UM PAR (locator, fraction), e os dois são necessários:
--
--   locator  a unidade ESTÁVEL do documento, para restaurar a posição:
--            PDF  -> o número da página em decimal ("124")
--            EPUB -> um EPUB CFI ("epubcfi(/6/14[cap05]!/4/2/2:0)"), que é
--                    estável a mudança de fonte — exatamente o que BIB-008
--                    cobra ("mesmo se o tamanho da fonte tiver mudado")
--   fraction 0..1, para a BARRA e para ordenar em ordem de leitura
--
-- Uma coluna TEXT só, servindo aos dois formatos, e não duas colunas (uma
-- `pdf_page INTEGER`, outra `epub_cfi TEXT`) das quais uma está sempre nula:
-- toda consulta teria que escrever um CASE, e nada impediria as duas
-- preenchidas ao mesmo tempo. Quem interpreta é o Rust, olhando
-- `library_books.format`; não existe coluna de "tipo de locator" aqui pelo
-- mesmo motivo — duas fontes para o mesmo fato podem discordar.
--
-- E NUNCA restaure a posição pela fração: num EPUB ela é derivada do layout
-- do momento, então voltar por fração aterrissa a alguns parágrafos do lugar.
-- A fração é para desenhar a barra; o locator é para voltar.
CREATE TABLE library_reading_progress (
    -- Sem `id` próprio: é uma linha por livro, e a chave natural já é o livro.
    -- Um id à parte seria uma segunda chave para a mesma coisa — a mesma
    -- escolha de `database_record_values` (0009).
    book_id TEXT PRIMARY KEY NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
    current_locator TEXT,
    current_fraction REAL NOT NULL DEFAULT 0.0
        CHECK (current_fraction >= 0.0 AND current_fraction <= 1.0),
    furthest_locator TEXT,
    furthest_fraction REAL NOT NULL DEFAULT 0.0
        CHECK (furthest_fraction >= 0.0 AND furthest_fraction <= 1.0),
    -- NÃO existe `CHECK (furthest_fraction >= current_fraction)`, e a ausência
    -- é deliberada: BIB-010 é justamente uma DIMINUIÇÃO legítima do ponto mais
    -- distante ("pulei para a última página só para consultar; corrija para
    -- 62%"), com a posição atual ainda lá na frente. Um CHECK assim faria a
    -- correção manual falhar, ou obrigaria a correção a arrastar a posição
    -- atual junto — quebraria a feature para proteger uma invariante que a
    -- feature não tem. A monotonia do avanço normal é do caminho de escrita
    -- (`max(furthest, atual)` ao salvar), o único lugar que sabe distinguir
    -- "li mais" de "corrigi à mão".
    -- BIB-012: o status que a galeria mostra, derivado em vez de guardado —
    -- guardado, ele poderia discordar da barra logo ao lado. VIRTUAL (e não
    -- STORED) pela mesma regra do contrato de migração: é o que o SQLite
    -- aceita, é indexável e não ocupa disco. `finished_at` entra na conta para
    -- o usuário poder marcar como lido um livro cujo fim é um índice
    -- remissivo que ele não vai ler.
    status TEXT GENERATED ALWAYS AS (
        CASE
            WHEN finished_at IS NOT NULL OR furthest_fraction >= 1.0 THEN 'finished'
            WHEN furthest_fraction > 0.0 THEN 'reading'
            ELSE 'unread'
        END
    ) VIRTUAL,
    -- A última vez que este livro foi lido de fato (não "a linha mudou"): é
    -- por ele que a faixa "continuar lendo" do painel Hoje ordena.
    last_read_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- "Livros em leitura, do mais recente para o mais antigo" — a consulta do
-- painel Hoje, que roda sem a Biblioteca estar aberta e por isso não pode
-- depender da view.
CREATE INDEX idx_library_progress_continue ON library_reading_progress (status, last_read_at);

CREATE TRIGGER library_reading_progress_set_updated_at
AFTER UPDATE ON library_reading_progress
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE library_reading_progress SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE book_id = NEW.book_id;
END;

-- Marcador, destaque e anotação: um ponto (ou trecho) do livro que o usuário
-- quis guardar, no MESMO par (locator, fraction) do progresso acima.
--
-- Por que tabela própria e não só o bloco de citação que BIB-014 escreve no
-- corpo do registro: o bloco é o texto DENTRO da página, e o leitor precisa da
-- lista "o que está marcado neste livro, em ordem de leitura" para desenhar as
-- marcas na margem — em bloco, isso seria varrer o corpo inteiro procurando
-- JSON a cada abertura. Além disso um marcador simples ("voltar aqui") não
-- produz bloco nenhum, e mesmo assim precisa existir.
CREATE TABLE library_annotations (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
    -- 'bookmark' = só uma posição; 'highlight' = um trecho; 'note' = um
    -- trecho com comentário do usuário.
    kind TEXT NOT NULL CHECK (kind IN ('bookmark', 'highlight', 'note')),
    locator_start TEXT NOT NULL,
    -- NULL para um marcador pontual; preenchido quando a anotação cobre um
    -- intervalo (o trecho selecionado de BIB-014).
    locator_end TEXT,
    -- A mesma fração 0..1 do progresso, aqui pela ORDEM: ordenar por locator
    -- não funciona nos dois formatos ("10" < "9" em texto, e CFI não é
    -- ordenável lexicograficamente de forma confiável), e a lista de anotações
    -- precisa sair em ordem de leitura em PDF e em EPUB pela mesma consulta.
    fraction REAL NOT NULL DEFAULT 0.0 CHECK (fraction >= 0.0 AND fraction <= 1.0),
    -- O texto selecionado, CONGELADO no momento da anotação. Mesmo raciocínio
    -- de `notes.source_text_frozen` (0011) e requisito direto de BIB-015: o
    -- arquivo pode sumir da pasta de dados, e a anotação continua legível
    -- porque vive no banco, não no arquivo.
    excerpt TEXT NOT NULL DEFAULT '',
    -- O comentário que o usuário escreveu sobre o trecho (o que faz um
    -- 'highlight' virar 'note').
    note TEXT,
    color TEXT,
    -- BIB-014: o bloco de citação criado no corpo do registro. ON DELETE SET
    -- NULL, e não CASCADE: apagar a citação da página é apagar uma anotação
    -- escrita, não desmarcar o trecho no leitor — o destaque continua lá,
    -- apenas sem bloco correspondente.
    block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL,
    -- "Este trecho já virou cartão?" A ligação existe aqui, e não só por
    -- `notes.source_block_id` (0011), porque a pergunta que a tela faz é
    -- "quais destaques DESTE LIVRO ainda não viraram cartão" — pelo caminho do
    -- bloco ela exigiria que toda anotação tivesse produzido um bloco, o que
    -- um 'bookmark' nunca faz. SET NULL: apagar o cartão devolve o trecho à
    -- fila de candidatos em vez de apagar o destaque.
    note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- NÃO há coluna `position` (índice fracionário) aqui, e a ausência é decisão,
-- não esquecimento: a regra do projeto vale para ordem entre irmãos definida
-- pelo USUÁRIO (arrastar página, arrastar bloco). A ordem das anotações é a
-- ordem do livro, derivada de `fraction`; um índice fracionário criaria uma
-- segunda ordem, arrastável, que poderia discordar da posição real no texto.
-- Mesmo precedente de `mindmap_nodes` (0013), que usa (x, y) e documenta por
-- que não usa `position`.
CREATE INDEX idx_library_annotations_book_order ON library_annotations (book_id, fraction);
-- Do cartão e da citação de volta para o trecho (navegação reversa de
-- BIB-014). Parciais porque a maioria das anotações não tem nem um nem outro.
CREATE INDEX idx_library_annotations_block ON library_annotations (block_id) WHERE block_id IS NOT NULL;
CREATE INDEX idx_library_annotations_note ON library_annotations (note_id) WHERE note_id IS NOT NULL;

CREATE TRIGGER library_annotations_set_updated_at
AFTER UPDATE ON library_annotations
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE library_annotations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
