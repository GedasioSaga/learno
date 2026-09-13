-- Cronograma, parte 2: o que faltava em `0024_cronograma.sql` para
-- `study_plan_blocks` sustentar uma GRADE — linha de faixa horária, coluna de
-- dia da semana, célula colorida por matéria — em vez de só a lista por dia
-- que a Fase 5 original desenhava. Pedido do usuário: quatro capturas de
-- cronogramas de estudo reais, todas na mesma forma de tabela.
--
-- Três peças, na ordem em que o comentário de módulo de `db::cronograma` as
-- numera (ver lá o "porquê" completo — aqui só o "o quê" do schema):
--
-- 1. FIM DO BLOCO: NÃO é coluna nova. `start_local_time` + `planned_minutes`
--    já bastam para derivar onde o bloco termina (`db::cronograma::fim_local`,
--    puro e testado, inclusive o caso que atravessa a meia-noite) — uma
--    coluna própria seria uma segunda verdade que nenhum `CHECK` desta
--    migração seria capaz de manter sincronizada com as outras duas.
--
-- 2. MATÉRIA: `study_subjects`, entidade própria e reusável — não um
--    segundo campo de texto livre em `study_plan_blocks`. É o que permite
--    renomear ou recolorir "Química" uma vez só e ver o efeito em toda
--    célula da semana que a usa, em vez de editar bloco por bloco.
--
-- 3. COR: fechada em oito chaves, as MESMAS de `PALETA_DE_RAMOS`
--    (`src/features/mapa-mental/cores-de-ramo.ts`) — chaves para os tokens
--    de `src/styles/theme.css` (cinco temas), nunca hex solto. Reusar a
--    paleta que o mapa mental já mediu (contraste ≥ 3:1 nos cinco temas)
--    evita medir tudo de novo para um segundo consumidor.
--
-- (A quarta peça do pedido — "semana modelo" — não precisa de schema: é
-- `db::cronograma::copiar_semana`, que só lê e reinsere linhas já existentes
-- de `study_plan_blocks`.)

-- Uma matéria: "Química", cor "terracotta". Pequena, de referência, sem
-- `position` própria (a ordem que importa é a da lista de escolha da tela —
-- `ORDER BY name`, ver `listar_materias` — não uma ordem manual como a de
-- `study_plan_blocks`).
CREATE TABLE study_subjects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    -- Sem UNIQUE de propósito: `decks.name` (0010) também não é único, e
    -- forçar aqui impediria o caso legítimo de duas matérias homônimas em
    -- contextos diferentes (ex.: "Redação" do pré-vestibular e "Redação" de
    -- um curso à parte) sem ganhar nada que a tela não resolva sozinha
    -- oferecendo "reusar existente" como primeira opção.
    color TEXT NOT NULL DEFAULT 'amber',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- As oito chaves de `PALETA_DE_RAMOS` — ver o item 3 acima. Fechado em
    -- CHECK pelo mesmo motivo de `study_plan_blocks.activity`: uma matéria
    -- com cor fora da paleta quebraria em silêncio em quatro dos cinco temas
    -- sem nenhum erro aparecer, e é exatamente esse risco que a paleta
    -- nomeada existe para eliminar.
    CHECK (color IN ('amber', 'mint', 'azul', 'terracotta', 'roxo', 'emerald', 'vermelho', 'brown'))
) STRICT;

CREATE TRIGGER study_subjects_set_updated_at
AFTER UPDATE ON study_subjects
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE study_subjects SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- O vínculo do bloco com a matéria. Mesmo padrão de `deck_id`/`page_id` em
-- 0024: opcional (um bloco pode não ter matéria — "Intervalo", "Revisão
-- geral"), e ON DELETE SET NULL pelo mesmo motivo dos dois: apagar a matéria
-- não pode apagar o histórico de blocos que a usaram, só soltar o vínculo —
-- o `title` congelado de cada bloco é o que sobra.
--
-- `NULL` por imposição do SQLite nesta ALTER TABLE, como as três colunas que
-- 0024 já tinha acrescentado em `pomodoro_sessions`: uma coluna com
-- `REFERENCES` só entra via `ADD COLUMN` se o default for NULL.
ALTER TABLE study_plan_blocks ADD COLUMN subject_id TEXT REFERENCES study_subjects(id) ON DELETE SET NULL;

CREATE INDEX idx_study_plan_blocks_subject_id ON study_plan_blocks (subject_id) WHERE subject_id IS NOT NULL;
