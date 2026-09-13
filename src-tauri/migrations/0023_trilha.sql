-- Área TRL — a Trilha: as etapas que o usuário segue pelas flechas.
--
-- O que a Trilha É neste schema, para ninguém modelar de novo o que já existe:
--
--   etapa   = uma página-registro (`pages` com `database_id` setado). Por isso
--             abrir uma etapa mostra a página inteira com o corpo de blocos
--             (TRL-012) sem nada novo aqui: registro já é página desde 0007.
--   flecha  = `database_record_dependencies` (0020). É a MESMA aresta de
--             DBS-119 "B bloqueada por A" — TRL-003 exige que remover a
--             dependência pela view Tabela faça a flecha sumir, e duas tabelas
--             de aresta tornariam isso impossível. Este arquivo NÃO cria
--             aresta nenhuma, de propósito.
--   raia    = um valor da propriedade de agrupamento (TRL-007). "Uma flecha de
--             estudos de T.I. e outra embaixo sendo um fluxo totalmente
--             diferente" são duas raias empilhadas na mesma tela, não duas
--             telas; mover a etapa entre raias é gravar outro valor de
--             propriedade (TRL-009), o que já é `database_record_values`.
--
-- Sobram quatro coisas que nada existente guarda, e são as quatro tabelas
-- abaixo: a configuração da view Trilha, a raia (ordem e recolhimento), o
-- progresso da etapa, e o que a etapa manda estudar.
--
-- Não há tabela de usuário: o app é local, de um usuário só. "Várias trilhas
-- por usuário" acontece em dois eixos, ambos já cobertos — várias views do
-- tipo `trail` (uma por database, ou várias sobre a mesma) e várias raias
-- dentro de cada uma.
--
-- O EIXO É DEPENDÊNCIA, NUNCA TEMPO (decisão travada em 05/09/2026). A
-- consequência mais visível está no que este arquivo não tem: nenhuma coluna
-- de coordenada. `mindmap_nodes` (0013) guarda `position_x`/`position_y`
-- porque um mapa mental É um layout espacial; a Trilha é o oposto — a coluna
-- de cada etapa é derivada do nível topológico a cada abertura (TRL-002), e
-- guardar (x, y) permitiria o desenho contradizer a regra de desbloqueio.
-- Data de início/término (TRL-010) também não entra: é valor de propriedade,
-- e mudá-la não pode mover nada no desenho.

-- ---------------------------------------------------------------------------
-- A view Trilha
-- ---------------------------------------------------------------------------

-- O quinto tipo de view, ao lado de table/board/list/calendar (TRL-001).
-- `database_views.view_type` é TEXT e NÃO tem CHECK (verificado em 0008: só um
-- comentário lista os tipos), então acrescentar 'trail' não exige alterar
-- tabela nenhuma — este arquivo é o registro de que o valor passou a existir.
--
-- Por que uma tabela e não mais um campo dentro do blob `database_views.config`
-- (que é onde filtro, ordenação e colunas visíveis moram, por decisão (d) da
-- fundação): `group_property_id` aponta para uma linha de outra tabela, e blob
-- não tem chave estrangeira. Apagar a propriedade "Trilha" deixaria a view
-- agrupando por um id inexistente e a tela abriria vazia sem erro nenhum. É o
-- mesmo argumento que deu tabela própria à aresta de relação em 0018.
CREATE TABLE trail_views (
    -- 1:1 com a view. A PK é o próprio id da view: não existe configuração de
    -- Trilha sem Trilha, e uma segunda linha para a mesma view seria uma
    -- segunda verdade sobre o agrupamento.
    view_id TEXT PRIMARY KEY NOT NULL REFERENCES database_views(id) ON DELETE CASCADE,
    -- A propriedade que nomeia as raias (TRL-007). NULL = uma raia só, sem
    -- título, com todas as etapas — que é como a Trilha nasce e é estado
    -- válido, não erro (TRL-014).
    --
    -- SET NULL e não CASCADE: apagar a propriedade de agrupamento não pode
    -- apagar a view inteira do usuário. Ela degrada para a raia única, que já
    -- é um estado desenhável.
    group_property_id TEXT REFERENCES database_properties(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- "Quais Trilhas usam esta propriedade para agrupar?" — a pergunta que a UI faz
-- antes de avisar que apagar a propriedade vai desmontar as raias. Parcial
-- porque a raia única (NULL) é o caso comum e não interessa a essa varredura.
CREATE INDEX idx_trail_views_group_property
    ON trail_views (group_property_id) WHERE group_property_id IS NOT NULL;

CREATE TRIGGER trail_views_set_updated_at
AFTER UPDATE ON trail_views
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE trail_views SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE view_id = NEW.view_id;
END;

-- A FK garante que a view existe, mas não que ela é uma Trilha — CHECK não
-- pode consultar outra tabela. Sem esta guarda, configurar por engano uma view
-- Tabela com raias é aceito em silêncio e some da tela: ninguém lê
-- `trail_views` para desenhar uma Tabela.
--
-- Só BEFORE INSERT: mudar o tipo de uma view existente não é operação do app
-- (o usuário cria outra view), então um gatilho em UPDATE de `database_views`
-- seria peso morto — se isso mudar, ele nasce aqui.
CREATE TRIGGER trail_views_require_trail_view_type
BEFORE INSERT ON trail_views
FOR EACH ROW
WHEN (SELECT view_type FROM database_views WHERE id = NEW.view_id) <> 'trail'
BEGIN
    SELECT RAISE(ABORT, 'trail_views so descreve uma view com view_type = trail');
END;

-- ---------------------------------------------------------------------------
-- A raia: um fluxo independente dentro da mesma tela
-- ---------------------------------------------------------------------------

-- A raia NÃO tem a lista das suas etapas: quem está em qual raia é o valor da
-- propriedade de agrupamento no registro, e duplicar isso aqui criaria duas
-- verdades que divergem no primeiro arrasto (TRL-009). Esta tabela guarda só o
-- que o valor da propriedade não sabe: a ordem vertical entre as raias e se a
-- raia está recolhida.
CREATE TABLE trail_lanes (
    -- Aponta para `trail_views`, não para `database_views`, para que uma raia
    -- não possa existir numa view que não é Trilha. Custo: criar uma Trilha é
    -- inserir em `trail_views` antes de inserir raia — na mesma transação.
    view_id TEXT NOT NULL REFERENCES trail_views(view_id) ON DELETE CASCADE,
    -- O valor da propriedade que nomeia a raia ("T.I.", "Inglês"), em texto
    -- puro — o mesmo que `json_extract(database_record_values.value, '$')`
    -- devolve, e NÃO o JSON com aspas. A comparação entre os dois lados tem
    -- que ser feita nessa forma; guardar `"T.I."` aqui e comparar com `T.I.`
    -- lá casaria zero linhas em silêncio.
    --
    -- String vazia é a raia legítima das etapas sem valor ("sem trilha"), e é
    -- por isso que ela não é NULL: NULL numa PK composta é aceito pelo SQLite
    -- e permitiria duas raias "sem valor" indistinguíveis.
    lane_value TEXT NOT NULL,
    -- Índice fracionário, como em pages/blocks: arrastar uma raia para cima ou
    -- para baixo grava UMA linha entre as duas vizinhas, nunca renumera as
    -- outras. Sequencial inteiro obrigaria reescrever a lista toda.
    position TEXT NOT NULL,
    -- TRL-008: recolhida some do canvas mas continua na tela com o contador —
    -- que é contado na hora, não guardado aqui, senão ele mente assim que uma
    -- etapa muda de raia.
    is_collapsed INTEGER NOT NULL DEFAULT 0 CHECK (is_collapsed IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Uma raia por valor, por view. É a PK e a regra de unicidade ao mesmo
    -- tempo: duas linhas para "T.I." dariam dois estados de recolhimento para
    -- a mesma raia. Por view, e não por database, porque TRL-015 exige que
    -- recolher numa Trilha não mexa na outra.
    PRIMARY KEY (view_id, lane_value)
) STRICT;

-- Desenhar a Trilha lê as raias de uma view na ordem vertical; a PK começa por
-- `view_id` mas ordena por `lane_value`, que é ordem alfabética, não a do
-- usuário.
CREATE INDEX idx_trail_lanes_order ON trail_lanes (view_id, position);

CREATE TRIGGER trail_lanes_set_updated_at
AFTER UPDATE ON trail_lanes
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE trail_lanes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE view_id = NEW.view_id AND lane_value = NEW.lane_value;
END;

-- ---------------------------------------------------------------------------
-- O progresso da etapa
-- ---------------------------------------------------------------------------

-- TRL-006 separa duas coisas que parecem uma só: o que o usuário DECLARA (não
-- comecei / estou fazendo / terminei) e o que o app CALCULA (disponível ou
-- bloqueada). Só a primeira é dado; a segunda é uma leitura do grafo — uma
-- etapa está disponível quando toda etapa que a bloqueia tem `state = 'done'`,
-- e sem pré-requisito ela nasce disponível. Guardar "bloqueada" numa coluna
-- seria um cache que desatualiza no instante em que um pré-requisito é
-- concluído, exatamente o que TRL-006 proíbe ("calculado, não marcado à mão").
--
-- Não iniciada é a AUSÊNCIA da linha, nunca um valor — a mesma invariante I1
-- de `database_record_values` (0009). Com um `state = 'not_started'` possível,
-- "não comecei" teria duas representações (linha ausente e linha com esse
-- valor) e toda consulta precisaria tratar as duas; uma delas seria esquecida.
-- Reabrir uma etapa concluída é UPDATE; zerá-la é DELETE.
CREATE TABLE trail_step_progress (
    -- A etapa é a página-registro. PK e FK na mesma coluna: um progresso por
    -- etapa, e ele morre com ela.
    step_id TEXT PRIMARY KEY NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('in_progress', 'done')),
    -- NOT NULL porque a linha só nasce quando a etapa começa.
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Estado e carimbo não podem discordar, nos DOIS sentidos: concluída sem
    -- data de conclusão, ou data de conclusão numa etapa reaberta que voltou a
    -- 'in_progress'. A segunda é a que quebra sozinha — reabrir sem limpar
    -- `completed_at` deixaria a etapa desbloqueando as seguintes por um lado e
    -- se dizendo em andamento pelo outro.
    CHECK ((state = 'done') = (completed_at IS NOT NULL)),
    -- Comparação de texto porque o timestamp é ISO de largura fixa em UTC:
    -- ordenação lexicográfica é a cronológica (I5). Só vale enquanto ninguém
    -- gravar aqui um formato de outra largura.
    CHECK (completed_at IS NULL OR completed_at >= started_at)
) STRICT;

-- Nenhum índice além da PK, e isso é decisão, não esquecimento: toda leitura é
-- por `step_id` (desenhar a etapa; e o desbloqueio, que resolve
-- `database_record_dependencies.blocking_id` para este `step_id`). Um índice
-- sobre `state` num app de um usuário, com dezenas de etapas por trilha, seria
-- peso morto — mesma lógica do comentário de 0009 sobre índice que finge
-- ajudar.

CREATE TRIGGER trail_step_progress_set_updated_at
AFTER UPDATE ON trail_step_progress
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE trail_step_progress SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE step_id = NEW.step_id;
END;

-- ---------------------------------------------------------------------------
-- O que a etapa manda estudar
-- ---------------------------------------------------------------------------

-- "Aprender Databricks" aponta para o material: uma página, um baralho de
-- cartões, um livro. Tabela própria com FK de verdade, e não uma lista de ids
-- dentro de um JSON, pelo mesmo motivo de 0018: um id solto em JSON não some
-- quando o alvo é apagado, e a etapa fica oferecendo um baralho inexistente —
-- erro que só aparece no clique.
CREATE TABLE trail_step_materials (
    id TEXT PRIMARY KEY NOT NULL,
    step_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    -- 'page' | 'deck' | 'book'. 'page' e 'book' guardam os dois em `page_id`
    -- porque um livro É um registro (decisão da Biblioteca, 05/09/2026), logo
    -- uma página — não vira FK nova quando a Biblioteca nascer. O tipo continua
    -- existindo porque a diferença é de destino: 'book' abre no leitor, 'page'
    -- abre no editor, e isso nenhuma chave estrangeira consegue dizer.
    kind TEXT NOT NULL CHECK (kind IN ('page', 'deck', 'book')),
    page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
    -- CASCADE aqui, RESTRICT em `notes.deck_id` (0011), e a diferença é
    -- proposital: uma nota é conteúdo do usuário e apagar o baralho por baixo
    -- dela seria perda silenciosa; um vínculo é só um ponteiro, e ponteiro
    -- para baralho que não existe mais é lixo, não perda.
    deck_id TEXT REFERENCES decks(id) ON DELETE CASCADE,
    -- Ordem entre os materiais da MESMA etapa (índice fracionário, como em
    -- pages/blocks) — a etapa "Azure" pode mandar ler a página antes de
    -- revisar o baralho.
    position TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Exatamente um alvo preenchido. Sem isto, uma linha com os dois nulos é
    -- um vínculo que aponta para lugar nenhum, e com os dois preenchidos é um
    -- vínculo ambíguo — os dois passam por qualquer NOT NULL isolado.
    CHECK ((page_id IS NOT NULL) + (deck_id IS NOT NULL) = 1),
    -- E o alvo preenchido é o que `kind` promete.
    CHECK ((kind = 'deck') = (deck_id IS NOT NULL)),
    -- Uma etapa mandando estudar a si mesma é a versão material do ciclo: o
    -- painel da etapa listaria a própria etapa como leitura.
    CHECK (page_id IS NULL OR page_id <> step_id)
) STRICT;

-- O painel da etapa: os materiais dela, na ordem.
CREATE INDEX idx_trail_step_materials_step ON trail_step_materials (step_id, position);
-- A direção inversa, "que etapas mandam estudar este baralho?" — é ela que
-- alimenta o progresso de TRL-011 e a pergunta antes de apagar um baralho.
-- Parciais porque só uma das duas colunas está preenchida em cada linha, e um
-- índice cheio de NULL é metade de disco desperdiçado.
CREATE INDEX idx_trail_step_materials_deck ON trail_step_materials (deck_id) WHERE deck_id IS NOT NULL;
CREATE INDEX idx_trail_step_materials_page ON trail_step_materials (page_id) WHERE page_id IS NOT NULL;

-- O mesmo material duas vezes na mesma etapa é sempre engano (duplo clique,
-- reimportação). `UNIQUE (step_id, page_id, deck_id)` NÃO serviria: o SQLite
-- trata NULLs como distintos, então toda linha com um dos alvos nulo — isto é,
-- todas — escaparia. Índice único parcial por alvo resolve.
CREATE UNIQUE INDEX idx_trail_step_materials_unico_page
    ON trail_step_materials (step_id, page_id) WHERE page_id IS NOT NULL;
CREATE UNIQUE INDEX idx_trail_step_materials_unico_deck
    ON trail_step_materials (step_id, deck_id) WHERE deck_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- O ciclo: onde ele é barrado, e por que não aqui
-- ---------------------------------------------------------------------------
--
-- Uma dependência que fecha ciclo (A bloqueia B, B bloqueia C, C bloqueia A)
-- torna a trilha impossível de percorrer: nenhuma das três etapas fica
-- disponível, para sempre, e o layout topológico de TRL-002 não tem solução —
-- não existe ordem de colunas em que todo pré-requisito esteja à esquerda.
-- Como o arrasto de TRL-004 cria dependência a cada solta, o ciclo é fácil de
-- produzir sem querer.
--
-- ONDE É BARRADO:
--
--   ciclo de tamanho 1 (A bloqueia A) -> NO SCHEMA, e já está: o
--   `CHECK (blocked_id <> blocking_id)` de `database_record_dependencies`
--   (0020). Não é reescrito aqui — duplicar a regra exigiria uma segunda
--   tabela de aresta, que é justamente o que o topo deste arquivo recusa.
--
--   ciclo de tamanho >= 2 -> NO RUST, antes do INSERT da aresta, na mesma
--   transação: "existe caminho de `blocked_id` até `blocking_id` seguindo as
--   arestas?" — se existe, a nova aresta fecharia o laço e é recusada.
--
-- POR QUE NÃO NO SCHEMA, já que um gatilho com `WITH RECURSIVE` conseguiria:
--
--   1. TRL-005 exige recusar "com uma explicação nomeando as duas etapas". O
--      `RAISE(ABORT, ...)` do SQLite só aceita string LITERAL — não dá para
--      interpolar os títulos. A mensagem útil só pode nascer no Rust, e então
--      a checagem já está lá.
--   2. Um gatilho recursivo rodaria a varredura do grafo em TODA inserção de
--      aresta, inclusive nas importações em lote, para pegar um caso raro.
--   3. Duas guardas para a mesma regra, com mensagens diferentes, é pior que
--      uma: a que dispara primeiro é a que o usuário vê, e ninguém sabe qual é
--      sem ler as duas.
--
-- A corrida "duas arestas concorrentes, cada uma sozinha sem ciclo, juntas com
-- ciclo" não existe aqui: o SQLite tem UM escritor por vez, então verificar e
-- inserir dentro da mesma transação de escrita é atômico. Esta é a única razão
-- pela qual a checagem no Rust é suficiente — num banco com escritores
-- concorrentes ela não seria, e isso muda se o banco mudar.
