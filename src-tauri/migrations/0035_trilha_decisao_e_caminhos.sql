-- Arquivo: src-tauri/migrations/0035_trilha_decisao_e_caminhos.sql
-- (0033 é o último em disco; 0034 está reservado para a peça de dono de
--  página desta mesma rodada, então 0035 é o próximo livre.)

-- Área TRL — a DECISÃO: a etapa que RAMIFICA, e os CAMINHOS que saem dela.
--
-- Leia o cabeçalho de `0023_trilha.sql` antes deste arquivo: ele é a
-- especificação da Trilha, e NADA aqui desfaz o que está travado lá.
--
--   O EIXO CONTINUA SENDO DEPENDÊNCIA, NUNCA TEMPO. Este arquivo não cria
--   coluna de coordenada nenhuma, e não precisa: um rótulo NÃO cria nem
--   remove aresta, então `calcular_niveis_topologicos` (db/trilha.rs:220)
--   recebe exatamente o mesmo grafo de antes e devolve exatamente as mesmas
--   colunas. Consequência deliberada: o caminho NÃO escolhido continua
--   ocupando a coluna dele no desenho. Sumir com o ramo descartado faria o
--   desenho mentir sobre o grafo — o oposto exato do que a posição derivada
--   existe para garantir.
--
--   UMA tabela de aresta, nunca duas (0023, linhas 8-12). Por isso o rótulo
--   é COLUNA da aresta que já existe, e não uma `trail_path_labels` ao lado:
--   uma tabela paralela com a mesma chave (blocked_id, blocking_id) exigiria
--   um JOIN na leitura mais quente da tela (`fetch_dependencies_into`,
--   db/trilha.rs:1109) e cascataria igual — pagaria uma tabela para comprar
--   nada. E continua valendo TRL-003: apagar a dependência pela view Tabela
--   apaga a flecha E o rótulo dela, numa linha só.
--
--   O CICLO continua tratado como está. O que existe hoje não é recusa: é
--   marcação — `criar_flecha` PERMITE a aresta que fecha o laço de propósito
--   (db/trilha.rs:773-783) e toda etapa presa nele volta com `in_cycle`
--   (teste `criar_flecha_permite_fechar_ciclo...`, tests/db_trilha.rs:603).
--   Como rótulo não é aresta, esse tratamento sai daqui intacto.
--
-- ---------------------------------------------------------------------------
-- POR QUE UMA TABELA, e não um valor de propriedade da database
-- ---------------------------------------------------------------------------
--
-- Uma etapa é uma página-registro (0023, linhas 5-7), então "tipo de etapa"
-- PODERIA ser mais um valor em `database_record_values`, como a raia é
-- (TRL-007/TRL-009). Recusado, por quatro razões, cada uma verificável:
--
--   1. Uma Trilha nasce e vive SEM propriedade nenhuma configurada, e isso é
--      estado válido (TRL-014; `criar_trilha_completa` passa `None`,
--      db/trilha.rs:870). Toda operação de raia recusa sem
--      `group_property_id` (db/trilha.rs:940-945). Se decisão fosse valor de
--      propriedade, ramificar exigiria configurar uma propriedade antes —
--      uma trava nova, do mesmo tipo que esta rodada acabou de abrir.
--   2. Valor de propriedade é editável na view Tabela e a propriedade pode
--      ser apagada. Para a raia, degradar é benigno: volta para a raia única
--      (0023, linhas 60-63). Para a decisão, degradar apagaria em silêncio a
--      REGRA DE DESBLOQUEIO de um ramo inteiro — é o mesmo argumento que
--      tirou `group_property_id` do blob de config (0023, linhas 46-51).
--   3. Escrever `database_record_values` obriga passar por
--      `RecordValueRepository` (I4, db/trilha.rs:14-17), que dispara cascata
--      de fórmula e automação. Desbloqueio não pode depender do motor de
--      fórmula.
--   4. A escolha do usuário precisa de casa com carimbo e com guarda ("o
--      rótulo escolhido existe?"). Valor de propriedade não referencia
--      rótulo de aresta nenhum.
--
-- Coluna em `pages` também foi recusada: `pages` é a tabela global de página,
-- e decisão é conceito de UMA seção. O precedente de `is_template` (0020,
-- linha 9) não vale — aquilo é conceito de database inteira, não de feature.
--
-- E derivar "é decisão" de "tem flecha rotulada saindo" foi recusado porque
-- tornaria impossível marcar a decisão ANTES de desenhar as flechas, que é a
-- ordem em que a tela funciona (não dá para arrastar de um nó que ainda não
-- pode existir) — e apagaria um estado legítimo de nascença, pelo mesmo
-- motivo que TRL-014 existe.

CREATE TABLE trail_decisions (
    -- Presença da linha = esta etapa é uma decisão. Ausência = etapa comum.
    -- Nunca uma coluna `kind` com dois valores: com ela, "comum" teria duas
    -- representações (linha ausente e linha dizendo 'comum') e alguma
    -- consulta esqueceria uma delas — a mesma invariante I1 que fez
    -- `trail_step_progress` não ter `not_started` (0023, linhas 165-170).
    --
    -- PK e FK na mesma coluna: uma decisão por etapa, e ela morre com a
    -- etapa. Que a página seja um REGISTRO (`database_id` setado) é exigido
    -- no Rust e não aqui — CHECK não consulta outra tabela, e a mensagem
    -- útil precisa nomear a página, exatamente como o cabeçalho de 0023
    -- argumenta para o ciclo (linhas 287-297).
    step_id TEXT PRIMARY KEY NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    -- O caminho escolhido pelo usuário. NULL = ainda não escolheu, e é o
    -- estado de nascença: a decisão existe, os caminhos existem, e nenhum
    -- deles está liberado ainda. Aqui NULL é a representação certa (e não a
    -- ausência de linha, como em `trail_step_progress`) porque a linha
    -- carrega OUTRA informação que precisa sobreviver a "desescolher": o
    -- fato de a etapa ser uma decisão.
    chosen_label TEXT,
    chosen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Escolha e carimbo não podem discordar nos dois sentidos — mesma forma
    -- do par state/completed_at de `trail_step_progress` (0023, linha 185).
    CHECK ((chosen_label IS NULL) = (chosen_at IS NULL)),
    -- Rótulo vazio seria uma SEGUNDA forma de dizer "sem escolha", e a
    -- primeira já é NULL.
    CHECK (chosen_label IS NULL OR trim(chosen_label) <> '')
) STRICT;

-- Nenhum índice além da PK, e isso é decisão: toda leitura é por `step_id`
-- (uma decisão) ou por um `IN` sobre as etapas da trilha (dezenas), fatiado
-- como `fetch_done_set` já faz. Mesmo raciocínio do comentário de 0023,
-- linhas 192-197, sobre índice que finge ajudar.

CREATE TRIGGER trail_decisions_set_updated_at
AFTER UPDATE ON trail_decisions
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE trail_decisions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE step_id = NEW.step_id;
END;

-- ---------------------------------------------------------------------------
-- O caminho: o rótulo da flecha que sai da decisão
-- ---------------------------------------------------------------------------

-- Um CAMINHO não é uma linha: é o CONJUNTO das flechas que saem da mesma
-- decisão com o mesmo rótulo. "Sim" levando a duas primeiras etapas em
-- paralelo é um caminho só, duas flechas — e é por isso que não existe
-- índice único sobre (blocking_id, path_label).
--
-- A PK (blocked_id, blocking_id) de 0020 já garante UMA flecha por par, logo
-- uma etapa está em no máximo um caminho de cada decisão. "Esta etapa vem
-- depois da decisão em QUALQUER caminho" se escreve com uma flecha SEM
-- rótulo: rótulo ausente = pré-requisito incondicional, como sempre foi.
ALTER TABLE database_record_dependencies ADD COLUMN path_label TEXT;

-- Nenhum índice novo: `idx_dependencies_blocking` (0020, linha 44) já
-- responde "quais flechas saem desta etapa?", que é a única pergunta que os
-- gatilhos abaixo e a leitura dos caminhos fazem.

-- O rótulo só pode existir em flecha que SAI de uma decisão, e nunca vazio.
--
-- Por que ESTA guarda mora no schema, se a do ciclo mora no Rust (0023,
-- linhas 287-297): a mensagem aqui não precisa interpolar título nenhum, a
-- checagem é uma busca pontual por chave (não uma varredura do grafo), e a
-- coluna vive numa tabela que a Trilha NÃO é dona — a view Tabela escreve
-- ali sem saber o que é um caminho. Sem esta guarda, um rótulo solto numa
-- flecha de etapa comum ficaria eternamente sem ninguém que pudesse
-- escolhê-lo, e a etapa de destino ficaria bloqueada para sempre, sem erro.
-- O Rust espelha esta regra para dar `Error::Invalid` legível antes de bater
-- na constraint — mesmo padrão de `validate_material_kind_and_target`
-- (db/trilha.rs:284-287), em que o schema é a verdade e o Rust é a mensagem.
CREATE TRIGGER database_record_dependencies_rotulo_valido_insert
BEFORE INSERT ON database_record_dependencies
FOR EACH ROW
WHEN NEW.path_label IS NOT NULL
 AND (trim(NEW.path_label) = ''
      OR NOT EXISTS (SELECT 1 FROM trail_decisions WHERE step_id = NEW.blocking_id))
BEGIN
    SELECT RAISE(ABORT, 'rotulo de caminho so existe em flecha que sai de uma decisao, e nunca vazio');
END;

CREATE TRIGGER database_record_dependencies_rotulo_valido_update
BEFORE UPDATE OF path_label ON database_record_dependencies
FOR EACH ROW
WHEN NEW.path_label IS NOT NULL
 AND (trim(NEW.path_label) = ''
      OR NOT EXISTS (SELECT 1 FROM trail_decisions WHERE step_id = NEW.blocking_id))
BEGIN
    SELECT RAISE(ABORT, 'rotulo de caminho so existe em flecha que sai de uma decisao, e nunca vazio');
END;

-- A escolha precisa nomear um caminho que EXISTE. Sem isto, um rótulo
-- digitado errado (ou um caminho apagado no meio do caminho) mataria TODOS
-- os ramos da decisão de uma vez: nenhuma flecha casaria com a escolha, e
-- todas virariam aresta morta em silêncio.
CREATE TRIGGER trail_decisions_escolha_precisa_existir_insert
BEFORE INSERT ON trail_decisions
FOR EACH ROW
WHEN NEW.chosen_label IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM database_record_dependencies
                  WHERE blocking_id = NEW.step_id AND path_label = NEW.chosen_label)
BEGIN
    SELECT RAISE(ABORT, 'nenhuma flecha sai desta decisao com o rotulo escolhido');
END;

CREATE TRIGGER trail_decisions_escolha_precisa_existir_update
BEFORE UPDATE OF chosen_label ON trail_decisions
FOR EACH ROW
WHEN NEW.chosen_label IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM database_record_dependencies
                  WHERE blocking_id = NEW.step_id AND path_label = NEW.chosen_label)
BEGIN
    SELECT RAISE(ABORT, 'nenhuma flecha sai desta decisao com o rotulo escolhido');
END;

-- E o inverso: quando a ÚLTIMA flecha de um caminho some (ou é re-rotulada),
-- a escolha que apontava para ele fica pendurada. Aqui a escolha é ZERADA,
-- não é erro — a decisão degrada para "ainda não escolhido", que é um estado
-- desenhável, exatamente como `group_property_id ON DELETE SET NULL` degrada
-- a Trilha para raia única em vez de explodir (0023, linhas 60-63).
--
-- Estes dois gatilhos existem porque este caminho de escrita NÃO passa pelo
-- Rust da Trilha: apagar a dependência pela view Tabela é o cenário de
-- TRL-003, e ali ninguém sabe o que é uma escolha.
--
-- Apagar a PÁGINA da decisão não cai aqui em ordem perigosa: as duas linhas
-- (a aresta e a decisão) caem por CASCADE de `pages`, e se a decisão cair
-- primeiro este UPDATE simplesmente afeta zero linha.
CREATE TRIGGER database_record_dependencies_caminho_apagado_limpa_escolha
AFTER DELETE ON database_record_dependencies
FOR EACH ROW
WHEN OLD.path_label IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM database_record_dependencies
                  WHERE blocking_id = OLD.blocking_id AND path_label = OLD.path_label)
BEGIN
    UPDATE trail_decisions SET chosen_label = NULL, chosen_at = NULL
     WHERE step_id = OLD.blocking_id AND chosen_label = OLD.path_label;
END;

CREATE TRIGGER database_record_dependencies_caminho_rerotulado_limpa_escolha
AFTER UPDATE OF path_label ON database_record_dependencies
FOR EACH ROW
WHEN OLD.path_label IS NOT NULL
 AND (NEW.path_label IS NULL OR NEW.path_label <> OLD.path_label)
 AND NOT EXISTS (SELECT 1 FROM database_record_dependencies
                  WHERE blocking_id = OLD.blocking_id AND path_label = OLD.path_label)
BEGIN
    UPDATE trail_decisions SET chosen_label = NULL, chosen_at = NULL
     WHERE step_id = OLD.blocking_id AND chosen_label = OLD.path_label;
END;

-- ---------------------------------------------------------------------------
-- A regra de desbloqueio que este schema pede, escrita por extenso
-- ---------------------------------------------------------------------------
--
-- Continua valendo o de sempre (0023, linhas 158-164): desbloqueio é
-- CALCULADO, nunca gravado. O que muda é a classificação de cada flecha que
-- ENTRA numa etapa, resolvida em ordem topológica (a mesma fila de Kahn que
-- já calcula o nível):
--
--   MORTA     — a flecha tem rótulo, sai de uma decisão JÁ ESCOLHIDA, e o
--               rótulo não é o escolhido; ou sai de uma etapa descartada.
--   PENDENTE  — a flecha tem rótulo e a decisão ainda não foi escolhida.
--   VIVA      — todo o resto (inclusive flecha sem rótulo, e flecha vinda de
--               fora desta database, que nunca tem rótulo porque
--               `criar_flecha` exige mesma database, db/trilha.rs:1197).
--
--   descartada(E) = E tem flecha entrando E TODAS são MORTAS.
--   desbloqueada(E) = NÃO descartada(E) E toda flecha não-morta que entra em
--                     E está satisfeita (bloqueadora `done`, e rótulo igual
--                     ao escolhido quando houver rótulo).
--
-- A parte que decide o desenho inteiro é "aresta MORTA é IGNORADA, não
-- bloqueia para sempre". É ela que faz os dois caminhos se REENCONTRAREM:
-- "Projeto final" bloqueado por "Curso avançado" (Sim) e por "Curso básico"
-- (Não) libera com o ramo escolhido concluído, em vez de ficar preso para
-- sempre esperando o ramo que o usuário abandonou. E não abre buraco: se
-- TODAS as flechas de entrada estiverem mortas, a etapa é descartada, não
-- desbloqueada.
--
-- Rótulo em flecha cuja origem deixou de ser decisão (só alcançável por
-- exclusão definitiva da página, já que o Rust recusa desmarcar uma decisão
-- com caminhos) é lido como flecha SEM rótulo: pré-requisito incondicional.
-- Degradar para a regra antiga é o pior caso aceitável; nunca sumir com a
-- etapa.
--
-- O caminho NÃO escolhido nunca é apagado e nunca é escondido: fica
-- descartado, na coluna topológica dele, com o progresso INTACTO. Trocar de
-- ideia é UPDATE de `chosen_label`, uma linha, uma coluna — nenhum DELETE em
-- `trail_step_progress`, jamais. Progresso é o que o usuário DECLAROU (0023,
-- linhas 158-159); apagá-lo como efeito colateral de navegar seria perda
-- silenciosa de dado do usuário, e voltar para a escolha anterior tem que
-- devolver a cena exatamente como estava.
