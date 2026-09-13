-- Finanças, entrega 1: categorias, gastos fixos (recorrentes) com histórico de
-- valor, e lançamentos do dia a dia. Só o dado e o Rust (`db::financas`).
--
-- ===========================================================================
-- DINHEIRO É SEMPRE CENTAVOS INTEIROS (`*_centavos INTEGER`), nunca REAL.
-- ===========================================================================
-- REAL é ponto flutuante binário: 0.1 + 0.2 não fecha em 0.3, e uma soma de
-- mês inteiro acumula o erro. Inteiro em centavos soma exato.
--
-- MÊS (`YYYY-MM`) E DIA (`YYYY-MM-DD`) SÃO CALENDÁRIO, NÃO INSTANTE — mesma
-- decisão de `0027_prazos.sql`: "conta de luz de setembro" é um mês do
-- calendário da pessoa, sem fuso a reconstruir. Texto de largura fixa, então a
-- ordem lexicográfica é a cronológica e comparação por texto é segura.

-- Categoria de lançamento. `tipo` separa as de entrada das de saída para a tela
-- oferecer só as que fazem sentido. `arquivada` esconde sem apagar: lançamento
-- antigo continua apontando para ela.
CREATE TABLE financas_categorias (
    id TEXT PRIMARY KEY NOT NULL,
    nome TEXT NOT NULL UNIQUE CHECK (length(trim(nome)) > 0),
    tipo TEXT NOT NULL CHECK (tipo IN ('entrada', 'saida')),
    ordem INTEGER NOT NULL DEFAULT 0,
    arquivada INTEGER NOT NULL DEFAULT 0 CHECK (arquivada IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TRIGGER financas_categorias_set_updated_at
AFTER UPDATE ON financas_categorias
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE financas_categorias SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- Seed: ids literais (TEXT canônico com hífens, o que `db::ids::DbId` lê) para
-- que toda instalação tenha os mesmos ids e um teste possa contar com eles.
INSERT INTO financas_categorias (id, nome, tipo, ordem) VALUES
    ('0f1a0000-0000-4000-8000-000000000001', 'Salário', 'entrada', 1),
    ('0f1a0000-0000-4000-8000-000000000002', 'Renda extra', 'entrada', 2),
    ('0f1a0000-0000-4000-8000-000000000003', 'MEI', 'saida', 1),
    ('0f1a0000-0000-4000-8000-000000000004', 'Telefone', 'saida', 2),
    ('0f1a0000-0000-4000-8000-000000000005', 'Gasolina', 'saida', 3),
    ('0f1a0000-0000-4000-8000-000000000006', 'Pessoal e imprevistos', 'saida', 4),
    ('0f1a0000-0000-4000-8000-000000000007', 'Cursos', 'saida', 5),
    ('0f1a0000-0000-4000-8000-000000000008', 'Carro', 'saida', 6),
    ('0f1a0000-0000-4000-8000-000000000009', 'Alimentação', 'saida', 7),
    ('0f1a0000-0000-4000-8000-00000000000a', 'Lazer', 'saida', 8),
    ('0f1a0000-0000-4000-8000-00000000000b', 'Saúde', 'saida', 9),
    ('0f1a0000-0000-4000-8000-00000000000c', 'Compras', 'saida', 10),
    ('0f1a0000-0000-4000-8000-00000000000d', 'Outros', 'saida', 11);

-- Gasto/receita fixa ("aluguel", "salário"). O VALOR não mora aqui: ele muda
-- com o tempo, e mudar não pode reescrever o passado — mora em
-- `financas_vigencias`. Apagar a categoria só solta o vínculo (SET NULL): o
-- compromisso mensal continua existindo.
CREATE TABLE financas_recorrentes (
    id TEXT PRIMARY KEY NOT NULL,
    descricao TEXT NOT NULL CHECK (length(trim(descricao)) > 0),
    tipo TEXT NOT NULL CHECK (tipo IN ('entrada', 'saida')),
    categoria_id TEXT REFERENCES financas_categorias(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TRIGGER financas_recorrentes_set_updated_at
AFTER UPDATE ON financas_recorrentes
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE financas_recorrentes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- Um valor de um recorrente num intervalo de meses, com fim INCLUSIVO
-- (`fim_mes` é o último mês que ainda vale; NULL = sem fim). Sem sobreposição
-- entre vigências do mesmo recorrente: garantido pelo Rust
-- (`mudar_valor_a_partir_de`/`encerrar_recorrente`), não por CHECK — SQLite não
-- tem constraint de exclusão de intervalo. Sem `updated_at`: vigência é
-- histórico, muda só pelo fechamento do intervalo.
CREATE TABLE financas_vigencias (
    id TEXT PRIMARY KEY NOT NULL,
    recorrente_id TEXT NOT NULL REFERENCES financas_recorrentes(id) ON DELETE CASCADE,
    valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
    inicio_mes TEXT NOT NULL CHECK (inicio_mes GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    fim_mes TEXT CHECK (fim_mes IS NULL OR fim_mes GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (fim_mes IS NULL OR fim_mes >= inicio_mes)
) STRICT;

CREATE INDEX idx_financas_vigencias_recorrente_id ON financas_vigencias (recorrente_id);

-- Um movimento real de dinheiro num dia. Avulso (`recorrente_id` NULL) ou a
-- confirmação de um fixo num mês (`recorrente_id` + `mes_referencia`).
--
-- Não há CHECK amarrando `recorrente_id` a `mes_referencia`: o `ON DELETE SET
-- NULL` do recorrente zera só `recorrente_id`, e um CHECK de "os dois nulos ou
-- os dois preenchidos" faria o DELETE do recorrente falhar. Apagar o fixo não
-- apaga o dinheiro que já saiu da conta — o lançamento fica, como avulso.
CREATE TABLE financas_lancamentos (
    id TEXT PRIMARY KEY NOT NULL,
    data_local TEXT NOT NULL CHECK (data_local GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    descricao TEXT NOT NULL CHECK (length(trim(descricao)) > 0),
    tipo TEXT NOT NULL CHECK (tipo IN ('entrada', 'saida')),
    categoria_id TEXT REFERENCES financas_categorias(id) ON DELETE SET NULL,
    valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
    recorrente_id TEXT REFERENCES financas_recorrentes(id) ON DELETE SET NULL,
    mes_referencia TEXT CHECK (mes_referencia IS NULL OR mes_referencia GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Um fixo se confirma no máximo uma vez por mês: é isto que impede o mesmo
-- aluguel de contar duas vezes no realizado. Parcial porque avulso não tem mês
-- de referência a disputar.
CREATE UNIQUE INDEX idx_financas_lancamentos_recorrente_mes
    ON financas_lancamentos (recorrente_id, mes_referencia) WHERE recorrente_id IS NOT NULL;
CREATE INDEX idx_financas_lancamentos_data_local ON financas_lancamentos (data_local);
CREATE INDEX idx_financas_lancamentos_categoria_id ON financas_lancamentos (categoria_id);

CREATE TRIGGER financas_lancamentos_set_updated_at
AFTER UPDATE ON financas_lancamentos
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE financas_lancamentos SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
