-- Cronograma (Fase 5): a faixa semanal de estudo — sete dias, cada um com o
-- que fazer e por quanto tempo, e o total realizado da semana contra a meta
-- ("6,5 / 8"). Três peças: a meta da semana, o bloco planejado do dia, e o
-- tempo que de fato aconteceu.
--
-- ===========================================================================
-- A DECISÃO QUE MANDA NESTE ARQUIVO: "que dia da semana é hoje" é uma
-- pergunta LOCAL, e o banco guarda instante em UTC.
-- ===========================================================================
-- `pomodoro_sessions.started_at` (0014) é UTC, como todo timestamp do projeto.
-- Agrupar por `substr(started_at, 1, 10)` daria o dia UTC — e para quem estuda
-- de noite isso é o dia ERRADO, silenciosamente: um pomodoro iniciado às
-- 21:30 em Brasília (UTC-3) tem `started_at` = 00:30Z do dia SEGUINTE. A
-- faixa semanal mostraria a sessão de sexta à noite dentro do sábado, e a
-- soma "6,5 / 8" ficaria certa no total e errada em todos os sete dias.
--
-- Por que NÃO resolver na leitura, com `datetime(started_at, 'localtime')`:
--
--   a) `'localtime'` lê o fuso do SISTEMA OPERACIONAL no momento da consulta.
--      SQLite trata a função como não determinística e recusa a ESCRITA em
--      qualquer coluna gerada ou índice que dependa dela — e recusa TARDE,
--      não na criação (verificado no SQLite 3.45.3: o `CREATE TABLE` com
--      `GENERATED ALWAYS AS (date(a,'localtime'))` é aceito, e o primeiro
--      INSERT falha com "non-deterministic use of date() in a generated
--      column"; o índice em expressão é aceito e quebra igual, com
--      "... in an index"). Ou seja: a consulta que a faixa semanal faz o
--      tempo todo — somar por dia — não teria índice nenhum, e a tentativa
--      de dar um só apareceria na primeira gravação.
--   b) Ela reescreve o passado. Trocar o fuso da máquina (viagem, correção do
--      relógio) faria sessões antigas mudarem de dia, e o histórico da semana
--      passada deixaria de bater com o que o usuário viu na época.
--   c) Ela depende do banco de fusos do SO para o horário de verão de datas
--      passadas — dependência de ambiente para um dado que já foi vivido.
--
-- A saída é desnormalizar no momento da ESCRITA: o Rust, que está no relógio
-- do usuário, grava `local_date` (o dia que a pessoa viveu, congelado) e
-- `utc_offset_minutes` (o deslocamento em vigor naquele instante). O par é
-- redundante de propósito: `local_date` é o que se agrupa e se indexa, e o
-- offset é o que permite reconstruir a hora local (`started_at` + offset) e
-- distinguir depois uma sessão de viagem/horário de verão de um bug de
-- gravação. Sem o offset, `local_date` seria afirmação sem prova.
--
-- `local_date` é TEXT `YYYY-MM-DD`, largura fixa: ordenação lexicográfica é a
-- cronológica (invariante I5), e a janela da semana vira um `BETWEEN` de duas
-- strings, que usa índice.
--
-- Onde termina o dia é decisão de configuração, não de schema: quem estuda
-- 00:30 pode querer que aquilo conte como o dia anterior (a "hora de virada"
-- do Anki). O Rust aplica a regra e grava o resultado; o banco só guarda a
-- decisão tomada, e nunca a recalcula. É a mesma linha que 0014 traçou ao
-- deixar duração e auto-start do timer fora da tabela.
--
-- UNIDADE: tudo nesta migração é MINUTO INTEIRO. `pomodoro_sessions` (0014)
-- guarda SEGUNDOS. A conversão acontece num lugar só, na view
-- `study_day_totals` no fim deste arquivo — ninguém deve somar
-- `duration_seconds` com `planned_minutes` direto. Minuto inteiro (e não hora
-- fracionária) pela mesma razão de `cards.ease_factor`: soma repetida de
-- float acumula erro, e "6,5 h" é exatamente 390.

-- A meta é POR SEMANA, e não uma configuração única, porque a tela compara
-- realizado contra planejado de uma semana específica: se a meta fosse um
-- valor global, mudá-la hoje reescreveria o veredito de toda semana passada
-- ("cumpri a meta") sem tocar em nenhum dado histórico.
CREATE TABLE weekly_study_goals (
    id TEXT PRIMARY KEY NOT NULL,
    -- Data LOCAL do primeiro dia da semana (ver o bloco de fuso acima).
    -- QUAL dia começa a semana (domingo no calendário brasileiro, segunda no
    -- ISO 8601) é configuração da aplicação: o Rust calcula e grava a data; o
    -- banco não deriva semana de data nenhuma.
    week_start_date TEXT NOT NULL,
    target_minutes INTEGER NOT NULL CHECK (target_minutes > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Uma meta por semana: definir a meta de novo é UPDATE (ou ON CONFLICT),
    -- nunca uma segunda linha que o leitor teria que desempatar. Semana sem
    -- linha herda a meta da última semana anterior que tenha uma — assim
    -- definir a meta uma vez vale para o futuro sem reescrever o passado.
    UNIQUE (week_start_date),
    -- Largura fixa é o que faz `BETWEEN` e ordenação funcionarem; GLOB é
    -- determinístico e pode viver num CHECK.
    CHECK (week_start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
) STRICT;

CREATE TRIGGER weekly_study_goals_set_updated_at
AFTER UPDATE ON weekly_study_goals
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE weekly_study_goals SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- Um bloco planejado: "terça, 19:00, 2x25 de pomodoro em Biologia".
-- Não há linha para dia vazio — dia sem plano é a AUSÊNCIA de bloco, e a
-- faixa da semana monta os sete dias no cliente a partir da janela de datas.
CREATE TABLE study_plan_blocks (
    id TEXT PRIMARY KEY NOT NULL,
    -- O dia que a pessoa vive, não o dia UTC. Ver o bloco de fuso acima.
    -- Aqui não há instante a congelar: o usuário escolhe o dia na tela e o
    -- valor já nasce local. É data de calendário, não ponto no tempo — por
    -- isso esta tabela não guarda offset.
    local_date TEXT NOT NULL,
    -- Ordem entre os blocos do MESMO dia: índice fracionário (string hex, o
    -- mesmo esquema de `pages.position`/`blocks.position`), e não inteiro
    -- sequencial — arrastar um bloco reescreve uma linha, não a lista. Não dá
    -- para ordenar por `start_local_time` porque ele é opcional: "revisão" e
    -- "mapa" costumam ser "em algum momento do dia", sem hora marcada.
    position TEXT NOT NULL,
    -- Hora LOCAL planejada, `HH:MM` de largura fixa. NULL = sem hora marcada.
    -- É hora de parede, não instante: "19:00 de terça" continua sendo 19:00
    -- se o horário de verão entrar no meio da semana, e por isso NÃO é
    -- derivável de um timestamp UTC.
    start_local_time TEXT,
    planned_minutes INTEGER NOT NULL CHECK (planned_minutes > 0),
    -- Qual subsistema do app executa o bloco: 'pomodoro' cai no timer (0014),
    -- 'review' na fila de cards (0011/0012), 'mindmap' no mapa (0013).
    -- 'reading'/'other' não têm execução própria e só rendem tempo manual.
    activity TEXT NOT NULL DEFAULT 'other',
    -- O "2x25" da tela: 2 ciclos dentro dos 50 minutos planejados. Guardar o
    -- número de ciclos em vez do texto "2x25" mantém `planned_minutes` como
    -- fonte única do total (a soma do dia não precisa interpretar rótulo), e
    -- o CHECK garante que o rótulo renderizado seja exato — 50/2 = 25, e não
    -- "2x25" escrito ao lado de 45 minutos.
    pomodoro_cycles INTEGER,
    -- Rótulo do que estudar, congelado. Existe mesmo quando há `deck_id` ou
    -- `page_id`: os dois viram NULL se o alvo for apagado (abaixo), e sem o
    -- texto o bloco do cronograma passado viraria uma linha muda. Mesmo
    -- motivo de `notes.source_text_frozen` em 0011.
    title TEXT NOT NULL DEFAULT '',
    -- Alvos opcionais. ON DELETE SET NULL, e não RESTRICT: apagar um baralho
    -- não pode ficar impossível porque existe um plano de terça passada, e
    -- não pode apagar o plano junto — o que foi planejado naquela terça
    -- continua sendo verdade sobre a semana. O `title` acima é o que sobra.
    deck_id TEXT REFERENCES decks(id) ON DELETE SET NULL,
    page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    -- O GLOB sozinho aceitaria '29:59'; a comparação de string fecha o teto,
    -- e ela é válida justamente porque a largura é fixa.
    CHECK (start_local_time IS NULL OR (start_local_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_local_time <= '23:59')),
    CHECK (activity IN ('pomodoro', 'review', 'mindmap', 'reading', 'other')),
    CHECK (pomodoro_cycles IS NULL OR (activity = 'pomodoro' AND pomodoro_cycles > 0 AND planned_minutes % pomodoro_cycles = 0))
) STRICT;

-- A faixa semanal é sempre "os blocos das datas X a Y, na ordem do dia":
-- uma janela sobre `local_date` seguida da ordenação por `position`, que este
-- índice atende inteira.
CREATE INDEX idx_study_plan_blocks_day ON study_plan_blocks (local_date, position);
CREATE INDEX idx_study_plan_blocks_deck_id ON study_plan_blocks (deck_id) WHERE deck_id IS NOT NULL;
CREATE INDEX idx_study_plan_blocks_page_id ON study_plan_blocks (page_id) WHERE page_id IS NOT NULL;

CREATE TRIGGER study_plan_blocks_set_updated_at
AFTER UPDATE ON study_plan_blocks
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE study_plan_blocks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- O tempo realizado que NÃO passou pelo timer. `pomodoro_sessions` já é o
-- registro do que o timer rodou e continua sendo — esta tabela não a duplica,
-- ela cobre o resto: a revisão de cards de 20 minutos e a hora no mapa mental
-- não disparam pomodoro nenhum, e sem isto o "realizado" da semana só contaria
-- quem usou o cronômetro.
--
-- O preço, declarado: o total do dia soma DUAS fontes, e nada no schema impede
-- lançar à mão um tempo que o timer já contou. Não há restrição capaz de pegar
-- isso (seria preciso comparar intervalos entre tabelas); quem evita a
-- contagem dupla é a UI, que só oferece lançamento manual para atividade sem
-- execução própria.
CREATE TABLE study_time_entries (
    id TEXT PRIMARY KEY NOT NULL,
    local_date TEXT NOT NULL,
    minutes INTEGER NOT NULL CHECK (minutes > 0),
    -- A qual bloco planejado este tempo responde. NULL é caso legítimo e
    -- comum: estudo não planejado conta para o total da semana do mesmo jeito.
    -- SET NULL, e não CASCADE: apagar o PLANO não pode apagar o FATO — a
    -- regra de cascata deste projeto reserva CASCADE para o filho que não
    -- existe sem o pai, e este existe.
    plan_block_id TEXT REFERENCES study_plan_blocks(id) ON DELETE SET NULL,
    activity TEXT NOT NULL DEFAULT 'other',
    note TEXT NOT NULL DEFAULT '',
    -- Instante UTC de início, quando se sabe. NULL para o lançamento
    -- retroativo ("ontem estudei 40 min"), em que só o dia é conhecido.
    started_at TEXT,
    -- Offset em vigor no instante acima, em minutos (UTC-12 a UTC+14).
    -- Só faz sentido acompanhado de um instante — daí o CHECK de par.
    utc_offset_minutes INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    CHECK (activity IN ('pomodoro', 'review', 'mindmap', 'reading', 'other')),
    CHECK (utc_offset_minutes IS NULL OR (utc_offset_minutes BETWEEN -720 AND 840)),
    -- Offset sem instante é ruído, e instante sem offset é a armadilha que
    -- esta migração inteira existe para evitar. Ou os dois, ou nenhum.
    CHECK ((started_at IS NULL) = (utc_offset_minutes IS NULL))
) STRICT;

CREATE INDEX idx_study_time_entries_day ON study_time_entries (local_date);
CREATE INDEX idx_study_time_entries_plan_block_id ON study_time_entries (plan_block_id) WHERE plan_block_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- `pomodoro_sessions` (0014) ganha o dia local, o offset e o vínculo com o
-- plano. É ALTER e não tabela nova de propósito: a sessão de foco JÁ é o
-- registro do tempo realizado no timer, e uma segunda tabela espelhando-a
-- criaria duas respostas para "quanto estudei hoje".
--
-- As três colunas são nulas e sem default por imposição do SQLite: `ALTER
-- TABLE ADD COLUMN` não aceita default não constante (`strftime(...)`) nem
-- NOT NULL sem default, e uma coluna com `REFERENCES` só entra se o default
-- for NULL.
-- ---------------------------------------------------------------------------

-- Dia local congelado na escrita. NULL = linha gravada antes desta migração,
-- de quando o dia local não era registrado. O rollup abaixo cai para o dia
-- UTC nesse caso — aproximação assumida e visível, e não um backfill que
-- inventaria dia local a partir de UTC e depois pareceria dado real.
ALTER TABLE pomodoro_sessions ADD COLUMN local_date TEXT
    CHECK (local_date IS NULL OR local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');

ALTER TABLE pomodoro_sessions ADD COLUMN utc_offset_minutes INTEGER
    CHECK (utc_offset_minutes IS NULL OR (utc_offset_minutes BETWEEN -720 AND 840));

-- Qual bloco do cronograma esta sessão executou. SET NULL pelo mesmo motivo
-- de `study_time_entries.plan_block_id`: o plano some, o fato fica.
ALTER TABLE pomodoro_sessions ADD COLUMN plan_block_id TEXT
    REFERENCES study_plan_blocks(id) ON DELETE SET NULL;

-- A consulta do rollup é sempre "somar a duração das sessões de FOCO
-- concluídas, por dia local". `duration_seconds` entra no índice para a soma
-- sair só do índice, sem tocar na tabela. O índice de 0014
-- (`started_at WHERE completed = 1`) continua servindo ao contador de POM-010
-- e não é substituído por este.
CREATE INDEX idx_pomodoro_sessions_local_date
    ON pomodoro_sessions (local_date, duration_seconds)
    WHERE kind = 'focus' AND completed = 1;

CREATE INDEX idx_pomodoro_sessions_plan_block_id
    ON pomodoro_sessions (plan_block_id) WHERE plan_block_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- O "6,5 / 8" da tela, com UMA definição de "realizado".
--
-- A view existe para a conversão segundo->minuto e a soma das duas fontes
-- (timer + lançamento manual) morarem num lugar só; se cada consulta somasse
-- por conta própria, o total da faixa e o total do dia divergiriam em algum
-- canto da UI e ninguém saberia qual está certo.
--
-- A soma acontece em SEGUNDOS e só o TOTAL do dia vira minuto: converter cada
-- sessão antes de somar perderia até 59 s por sessão (medido: 12 pomodoros de
-- 24m59s dão 288 min convertidos um a um, contra os 300 corretos). O `+ 30`
-- arredonda o único resto que sobra ao minuto mais próximo, em vez de truncar
-- para baixo o dia inteiro.
--
-- Não existe view de SEMANA: agrupar dias em semanas exige saber qual dia
-- começa a semana, que é configuração da aplicação (ver `week_start_date`).
-- Quem monta a semana é o Rust, somando esta view num `BETWEEN` de sete dias.
-- ---------------------------------------------------------------------------
CREATE VIEW study_day_totals AS
SELECT
    local_date,
    planned_minutes,
    pomodoro_minutes,
    manual_minutes,
    pomodoro_minutes + manual_minutes AS done_minutes
FROM (
    WITH dias(local_date) AS (
        SELECT local_date FROM study_plan_blocks
        UNION
        SELECT local_date FROM study_time_entries
        UNION
        -- O coalesce cobre a linha pré-0024 descrita acima.
        SELECT coalesce(local_date, substr(started_at, 1, 10))
          FROM pomodoro_sessions
         WHERE kind = 'focus' AND completed = 1
    )
    SELECT
        dias.local_date AS local_date,
        (SELECT coalesce(sum(b.planned_minutes), 0)
           FROM study_plan_blocks b
          WHERE b.local_date = dias.local_date) AS planned_minutes,
        (SELECT coalesce(sum(s.duration_seconds), 0) + 30
           FROM pomodoro_sessions s
          WHERE coalesce(s.local_date, substr(s.started_at, 1, 10)) = dias.local_date
            AND s.kind = 'focus' AND s.completed = 1) / 60 AS pomodoro_minutes,
        (SELECT coalesce(sum(e.minutes), 0)
           FROM study_time_entries e
          WHERE e.local_date = dias.local_date) AS manual_minutes
    FROM dias
);
