-- Rotina diária do Cronograma (fase 1 do plano `rotina-diaria`): o usuário
-- desenha o formato de um dia UMA vez ("Dia de semana": 14 linhas, 04:40 às
-- 20:40) e aplica esse molde a um dia real, que vira linhas de verdade em
-- `study_plan_blocks` (0024). Duas tabelas novas; nenhuma tabela existente é
-- tocada.
--
-- ===========================================================================
-- MATERIALIZADO, NÃO VIRTUAL — a rotina em si (`study_routines` +
-- `study_routine_items`) NÃO é o plano do dia. Ela é só o MOLDE. Aplicar
-- (`CronogramaRepository::aplicar_rotina`, fora desta migração) lê o molde e
-- grava linhas reais em `study_plan_blocks`, que dali em diante vivem sua
-- própria vida — editar a rotina depois não reescreve dia nenhum já aplicado.
-- Isso é obrigatório, não estético: `pomodoro_sessions.plan_block_id` e
-- `study_time_entries.plan_block_id` são FK para `study_plan_blocks(id)`
-- (0024:180, ALTER de 0029:225-226) — um bloco de rotina "virtual" não tem
-- linha própria para essas FKs apontarem. E reescrever dias passados ao mudar
-- a rotina seria o mesmo erro que `weekly_study_goals` (0024:60-63) já
-- recusou: mudar a meta hoje não pode reescrever o veredito de uma semana já
-- vivida.
-- ===========================================================================

-- Um molde de dia: "Dia de semana", "Fim de semana", "Dia de prova".
-- Sem `position` — a lista de rotinas na tela é pequena e de referência, a
-- mesma categoria de `study_subjects` (0029:35-42): a ordem que ajuda é
-- `ORDER BY name`, não uma ordem manual que precisaria de índice fracionário
-- para uma meia dúzia de linhas.
CREATE TABLE study_routines (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL
    -- Sem UNIQUE, mesmo precedente de `study_subjects.name` (0029:38-42) e de
    -- `decks.name` (0010): duas rotinas homônimas em contextos diferentes
    -- ("Dia de semana" antes e depois de mudar de emprego) é caso legítimo, e
    -- travar aqui não ganha nada que a tela não resolva sozinha.
    CHECK (trim(name) <> ''),
    -- Máscara de 7 posições, posição 1 = SEGUNDA — a MESMA convenção que
    -- `db::cronograma::parse_week_start` já usa para "início de semana é
    -- segunda" (cronograma.rs:682-691), para não inventar uma segunda
    -- contagem de dia da semana no mesmo módulo. É só o PRÉ-PREENCHIMENTO dos
    -- chips de dia no diálogo "Aplicar" (fase 2) — a leitura da semana em
    -- `semana()` NUNCA consulta esta coluna; aplicar sempre grava dia por dia
    -- de verdade, e `default_weekdays` só existe para poupar clique.
    default_weekdays TEXT NOT NULL DEFAULT '1111100'
    -- GLOB de largura fixa, mesmo padrão de `0024:81`/`local_date`: garante
    -- exatamente 7 caracteres, cada um '0' ou '1', sem precisar de uma
    -- segunda checagem de comprimento (o GLOB já falha se faltar ou sobrar
    -- posição).
    CHECK (default_weekdays GLOB '[01][01][01][01][01][01][01]'),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TRIGGER study_routines_set_updated_at
AFTER UPDATE ON study_routines
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE study_routines SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- Uma linha do molde: "05:00, 2h, Estudo profundo". Note a diferença
-- deliberada para `study_plan_blocks` (0024): aqui `start_local_time` é
-- OBRIGATÓRIO, nunca NULL — uma rotina é uma sequência fechada de horários
-- (04:40 → 20:40, sem buraco), não uma lista de "fazer em algum momento do
-- dia" como o cronograma real permite.
--
-- TRÊS ECONOMIAS DELIBERADAS em relação a `study_plan_blocks`:
--
--   1. SEM coluna `position`. Em `study_plan_blocks` ela existe porque
--      `start_local_time` é OPCIONAL (0024:104-106) — sem hora, alguma outra
--      coisa precisa dizer a ordem. Aqui a hora é obrigatória, então A HORA É
--      A ORDEM: `ORDER BY start_local_time` já dá a sequência do dia, sem
--      índice fracionário, sem `mover_item`, sem `next_position_in_*` e sem
--      teste de vizinhança — nenhuma dessas peças tem o que fazer numa lista
--      que já se ordena sozinha.
--   2. SEM `deck_id`/`page_id`. A rotina descreve o FORMATO do dia ("2h de
--      estudo às 5h"), não QUAL baralho ou QUAL página — isso é decisão de
--      cada dia aplicado, feita depois em `study_plan_blocks`. Adicionar as
--      duas colunas aqui seria YAGNI: nenhuma tela desta fase precisa fixar
--      baralho no molde.
--   3. SEM coluna de proveniência em `study_plan_blocks` (nenhuma ALTER
--      TABLE nesta migração). A aplicação é idempotente por CONSTRUÇÃO — o
--      "preencher vazios" olha se o dia já tem algum bloco antes de gravar
--      qualquer coisa, então nunca existem duas fontes disputando a mesma
--      linha. Uma coluna dizendo "este bloco veio da rotina X" só vira
--      necessária na fase 2 (recorrência por bloco individual), quando DUAS
--      fontes podem gerar linha no mesmo dia e alguém precisa desempatar —
--      pagar esse custo agora, sem essa disputa existir, seria schema
--      especulativo.
CREATE TABLE study_routine_items (
    id TEXT PRIMARY KEY NOT NULL,
    -- CASCADE, ao contrário de quase toda FK deste projeto: a regra de
    -- cascata da casa (0024:177-179) reserva CASCADE para "o filho que não
    -- existe sem o pai", e uma linha de rotina sem rotina é exatamente isso —
    -- diferente de `study_plan_blocks.deck_id`/`subject_id`, que sobrevivem
    -- ao pai sumir porque representam um FATO já vivido.
    routine_id TEXT NOT NULL REFERENCES study_routines(id) ON DELETE CASCADE,
    -- Mesmo par de CHECK de `study_plan_blocks.start_local_time` (0024:140):
    -- GLOB fecha o formato `HH:MM`, e a comparação de string fecha o teto que
    -- o GLOB sozinho deixaria passar (`29:59` bate o GLOB, mas não é hora
    -- válida).
    start_local_time TEXT NOT NULL
    CHECK (start_local_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_local_time <= '23:59'),
    planned_minutes INTEGER NOT NULL CHECK (planned_minutes > 0 AND planned_minutes <= 1440),
    -- Mesmas cinco chaves de `study_plan_blocks.activity` (0024:141) — ver a
    -- decisão travada do plano: o CHECK NÃO é alargado. "Trabalho",
    -- "Deslocamento" e "Sono" (borda, nem vira item) são honestamente
    -- 'other' aqui: `activity` significa qual subsistema do app EXECUTA o
    -- item, e nenhum desses tem execução própria. A categoria visível ao
    -- usuário vem de `title` + `subject_id`, nunca deste campo.
    activity TEXT NOT NULL DEFAULT 'other'
    CHECK (activity IN ('pomodoro', 'review', 'mindmap', 'reading', 'other')),
    -- Mesmo CHECK pareado de `study_plan_blocks.pomodoro_cycles` (0024:142):
    -- só faz sentido com `activity = 'pomodoro'`, e só se os minutos
    -- planejados dividirem exato pelos ciclos (o "2x25" da tela nunca pode
    -- desenhar um número que não bate com os minutos guardados).
    pomodoro_cycles INTEGER
    CHECK (pomodoro_cycles IS NULL OR (activity = 'pomodoro' AND pomodoro_cycles > 0 AND planned_minutes % pomodoro_cycles = 0)),
    title TEXT NOT NULL DEFAULT '',
    -- Vínculo opcional com `study_subjects` (0029) — mesmo ON DELETE SET
    -- NULL de `study_plan_blocks.subject_id` (0029:71) e pelo mesmo motivo:
    -- apagar a matéria não pode apagar a linha da rotina, só soltar o
    -- vínculo. `title`, se preenchido, é o que sobra.
    subject_id TEXT REFERENCES study_subjects(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- A leitura de uma rotina é sempre "os itens de UMA rotina, na ordem do
-- dia" — a hora sendo a própria ordem (ver a economia 1 acima), este índice
-- atende `WHERE routine_id = ? ORDER BY start_local_time` inteiro, sem
-- ordenação separada.
CREATE INDEX idx_study_routine_items_routine ON study_routine_items (routine_id, start_local_time);

CREATE TRIGGER study_routine_items_set_updated_at
AFTER UPDATE ON study_routine_items
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE study_routine_items SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
