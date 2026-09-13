-- Prazos: a contagem regressiva que o SynapsePro tem e o Learno não tinha —
-- uma data-limite ("prova dia 20") que o app lembra e conta os dias até ela.
-- Fase 1 de 2: só o dado e o Rust. A tela que lê isto é a peça seguinte.
--
-- ===========================================================================
-- A DECISÃO QUE MANDA NESTE ARQUIVO: "faltam quantos dias" é uma pergunta
-- sobre DOIS DIAS DE CALENDÁRIO LOCAL, nunca sobre dois instantes divididos
-- por 86400 segundos.
-- ===========================================================================
-- "Prova dia 20" é um dia do calendário da pessoa, não um instante UTC — a
-- mesma razão que fez `0024_cronograma.sql` desnormalizar `local_date` em vez
-- de derivar dia a partir de timestamp. Aqui o cuidado é mais simples: não há
-- INSTANTE nenhum a congelar (o usuário escolhe o dia-limite na tela, e o
-- valor já nasce como dia de calendário — igual a `study_plan_blocks.local_date`,
-- e diferente de `pomodoro_sessions.started_at`, que É um instante). Por isso
-- `due_local_date` não vem acompanhado de nenhum `utc_offset_minutes`: não há
-- fuso a reconstruir para um dado que nunca foi um instante.
--
-- A conta em si — quantos dias entre hoje e o prazo — mora inteira no Rust,
-- como função pura sobre dois `NaiveDate` (ver `db::prazos::dias_ate_o_prazo`).
-- Este schema não tenta replicar a subtração em SQL: SQLite faria a mesma
-- conta bem (`julianday(due) - julianday(hoje)`), mas a validação de virada de
-- mês, ano bissexto e a garantia de que a diferença nunca soma HORA (só dia)
-- ficam mais fáceis de provar isoladas num teste unitário Rust do que dentro
-- de uma expressão de view.
--
-- UNIDADE: dia inteiro. Não existe hora-limite aqui — "prova dia 20" vale o
-- dia 20 inteiro, e o prazo não vence às 00h00. Quem decide o que fazer com
-- as últimas horas do dia-limite é a UI (mostrar "faltam 0 dias" o dia
-- inteiro), não o banco.
--
-- `due_local_date` é TEXT `YYYY-MM-DD`, largura fixa, mesmo motivo de
-- `local_date` em 0024: ordenação lexicográfica é cronológica, e vira índice.

-- Um prazo: título, data-limite, vínculo opcional com baralho/página, e um
-- estado de fluxo (`status`) que é ORTOGONAL à contagem de dias. "Vencido"
-- NÃO é um valor de `status` — é derivado, no Rust, comparando `due_local_date`
-- com o dia de hoje toda vez que a lista é montada (nunca armazenado). Um
-- `status = 'vencido'` gravado ficaria desatualizado sozinho: o prazo criado
-- ontem para "daqui a 5 dias" vira vencido só de o calendário virar, sem
-- ninguém tocar a linha — exatamente o tipo de afirmação que a tela não pode
-- fazer sem o dado sustentar (ver o cabeçalho do pedido: nada na tela pode
-- afirmar mais do que o dado prova). Guardar só a data e recalcular na leitura
-- é o que garante que "vencido" seja sempre verdade no momento em que aparece.
--
-- `status` cobre o que É decisão do usuário, e nada disso o calendário decide
-- sozinho:
--   'ativo'      — o padrão; entra na contagem regressiva.
--   'concluido'  — o usuário marcou como feito (a prova passou, o prazo foi
--                  cumprido); some da contagem regressiva mesmo que a data já
--                  tenha passado — não é "vencido", é resolvido.
--   'arquivado'  — o usuário não quer mais ver este prazo (prova cancelada,
--                  criado por engano); some da contagem sem apagar a linha.
-- Os dois últimos não reaparecem em `listar_prazos` (ver `db::prazos`) — quem
-- precisa vê-los de novo edita o status de volta para 'ativo'.
CREATE TABLE prazos (
    id TEXT PRIMARY KEY NOT NULL,
    -- Vazio não é um título válido: uma contagem regressiva sem nome não diz
    -- para o que faltam os dias. Reforçado aqui (não só no Rust) para que uma
    -- gravação direta por SQL não consiga criar a linha muda.
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    due_local_date TEXT NOT NULL
        CHECK (due_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    -- Vínculo opcional — mesma decisão de `study_plan_blocks.deck_id`/`page_id`
    -- em 0024, e pelo mesmo motivo: apagar o baralho ou a página ligada não
    -- pode arrastar o prazo junto. O prazo ("prova de Biologia dia 20") é um
    -- compromisso do calendário da pessoa; ele continua existindo — só perde
    -- o atalho para onde estudar — mesmo que o baralho ou a página apontada
    -- desapareça. `ON DELETE SET NULL`, nunca CASCADE nem RESTRICT: RESTRICT
    -- tornaria impossível apagar um baralho só porque um prazo antigo aponta
    -- para ele, e CASCADE apagaria um compromisso de data por causa de uma
    -- decisão sobre material de estudo — duas categorias diferentes de dado.
    deck_id TEXT REFERENCES decks(id) ON DELETE SET NULL,
    page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'concluido', 'arquivado')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- A consulta de `listar_prazos` é sempre "os prazos ATIVOS, na ordem da
-- data-limite" — este índice atende o filtro e a ordenação juntos, sem
-- ordenação separada em memória para o caso comum (poucas dezenas de linhas,
-- mas o índice custa nada e evita reavaliar isso se a base crescer).
CREATE INDEX idx_prazos_status_due ON prazos (status, due_local_date);
CREATE INDEX idx_prazos_deck_id ON prazos (deck_id) WHERE deck_id IS NOT NULL;
CREATE INDEX idx_prazos_page_id ON prazos (page_id) WHERE page_id IS NOT NULL;

CREATE TRIGGER prazos_set_updated_at
AFTER UPDATE ON prazos
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE prazos SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
