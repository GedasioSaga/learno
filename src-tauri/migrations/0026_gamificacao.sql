-- Gamificação (Fase 1 de 2, só banco + Rust): XP, nível, sequências,
-- desafios diários e resumo de sessão — a versão local, sem servidor e sem
-- conta, do que o SynapsePro faz com um ranking de comunidade.
--
-- ===========================================================================
-- A REGRA MAIS FORTE DESTE PROJETO DECIDE O DESENHO DESTA TABELA:
-- "nada na tela pode afirmar mais do que o dado sustenta."
-- ===========================================================================
-- Duas consequências diretas:
--
-- 1. NÃO EXISTE RANKING CONTRA NINGUÉM. Este app é local, de um usuário só —
--    um ranking comparado a outra pessoa seria um número inventado. O que
--    existe em vez disso são RECORDES PESSOAIS (melhor dia, maior sequência,
--    melhor semana), derivados do histórico real (`review_log`,
--    `pomodoro_sessions`) — nunca guardados como contador à parte. Por isso
--    esta migração NÃO cria tabela nenhuma de "recorde": recorde é uma
--    LEITURA (`db::gamificacao::recordes_pessoais`), não um dado gravado.
--
-- 2. TODO XP TEM ORIGEM RASTREÁVEL NUMA LINHA DE BANCO. Esta migração cria
--    uma única tabela nova, `xp_events`: um evento por conquista de
--    motivação, nunca um contador que alguém incrementa. O total de XP em
--    qualquer tela é SEMPRE `SUM(amount)` sobre esta tabela — apagar um
--    evento tem que mudar o total sozinho, sem nenhum outro lugar para
--    corrigir. Nível, barra de progresso e resumo de sessão são todos
--    FUNÇÕES desse total, nunca uma segunda fonte de verdade.
--
-- Este projeto já teve uma tela afirmando "50% cumprido" comparando dado que
-- o timer não media contra um plano que incluía leitura e revisão — e um
-- teste que validava esse comportamento errado. `xp_events` existe
-- justamente para não repetir aquele padrão: XP só entra por uma linha
-- rastreável, nunca por estimativa.

-- Evento de XP: uma linha por conquista — revisar um cartão, concluir um
-- pomodoro de foco, cumprir um bloco do cronograma, ou vencer um desafio
-- diário. `amount` é sempre positivo: este projeto não modela "perder XP"
-- (não existe penalidade de gamificação aqui), então uma correção é apagar
-- a linha errada, não gravar um valor negativo.
--
-- IDEMPOTÊNCIA NO SCHEMA, NÃO SÓ NO CÓDIGO: `UNIQUE (origin, reference_id)`
-- é o que impede responder o MESMO cartão (mesma linha de `review_log`),
-- finalizar a MESMA sessão de pomodoro, cumprir o MESMO bloco do cronograma
-- ou creditar o MESMO desafio do MESMO dia duas vezes. Mesmo que o Rust
-- chame `INSERT` duas vezes (reconexão, duplo clique, replay de um comando
-- IPC), a segunda tentativa esbarra nesta constraint — o lado do Rust já
-- assume isso e usa `ON CONFLICT (origin, reference_id) DO NOTHING` (ver
-- `GamificacaoRepository::inserir_evento_xp`), então o chamador nunca vê um
-- erro só porque tentou creditar de novo algo já creditado.
--
-- `reference_id` é uma associação POLIMÓRFICA por convenção de aplicação,
-- não um FK de banco (SQLite não tem FK condicional por valor de coluna
-- irmã): o que ela referencia depende de `origin`.
--   - 'card_review'      -> `review_log.id` (uma resposta de cartão).
--   - 'pomodoro_focus'   -> `pomodoro_sessions.id` (uma sessão de foco
--                           concluída — nunca uma cancelada).
--   - 'cronograma_bloco' -> `study_plan_blocks.id` (um bloco planejado cujo
--                           tempo realizado já alcançou `planned_minutes`).
--   - 'desafio_diario'   -> a chave sintética `"<local_date>:<tipo>"`
--                           (ex.: `"2026-09-05:revisar_cartoes"`). Desafio
--                           diário não é linha de outra tabela — é derivado
--                           do dia local, ver o comentário de módulo de
--                           `db::gamificacao` para o catálogo e a seleção
--                           determinística.
-- A integridade das três primeiras origens (a referência de fato existe, e
-- de fato cumpre o critério da origem) é responsabilidade do Rust: todo
-- método de `GamificacaoRepository::registrar_xp_*` confere a linha de
-- origem ANTES de inserir, nunca cru a partir de um id vindo do IPC — a
-- mesma cautela de "entrada de comando é hostil" que o resto do projeto já
-- aplica a todo id recebido do frontend.
CREATE TABLE xp_events (
    id TEXT PRIMARY KEY NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    origin TEXT NOT NULL CHECK (origin IN ('card_review', 'pomodoro_focus', 'cronograma_bloco', 'desafio_diario')),
    reference_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (origin, reference_id)
) STRICT;

-- `resumo_de_sessao` soma `amount` por uma janela de `created_at`; este
-- índice cobre esse `BETWEEN` sem tocar a tabela inteira. `xp_total`/
-- `nivel_atual` somam a tabela toda e não usam índice nenhum — não há um
-- para acelerar (nem falta, no volume de um usuário só).
CREATE INDEX idx_xp_events_created_at ON xp_events (created_at);
-- `desafios_hoje` confere "este desafio já foi creditado?" por
-- `origin = 'desafio_diario' AND reference_id = ?`, que a UNIQUE acima já
-- serve como índice — este segundo índice é só para listar por origem
-- (ex.: "quanto XP veio de pomodoro?") sem varrer a tabela toda.
CREATE INDEX idx_xp_events_origin ON xp_events (origin);
