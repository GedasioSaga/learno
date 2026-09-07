"""Gera vetores diferenciais do py-fsrs para confrontar com o port em Rust.

Cada caso e uma sequencia de revisoes com avaliacoes e atrasos sorteados,
incluindo revisoes no mesmo dia (que exercitam o ramo short-term) e o ramo
Hard em aprendizagem, que nenhum vetor dourado da referencia cobre.
"""

import json
import random
from datetime import datetime, timedelta, timezone

from fsrs.card import Card, State
from fsrs.review_log import Rating
from fsrs.scheduler import Scheduler

RATINGS = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]

ESTADO = {State.Learning: "learning", State.Review: "review", State.Relearning: "relearning"}

# Atrasos em segundos, misturando mesmo-dia (< 86400, ramo short-term) com
# varios dias e um atraso longo, que empurra a retrievability para baixo.
ATRASOS = [0, 30, 600, 3600, 43200, 86400, 86400 * 2, 86400 * 7, 86400 * 30, 86400 * 400]

INICIO = datetime(2023, 1, 1, 9, 0, 0, tzinfo=timezone.utc)


def gerar(n_casos: int, passos_por_caso: int, semente: int) -> list:
    rng = random.Random(semente)
    scheduler = Scheduler(enable_fuzzing=False)
    casos = []

    for _ in range(n_casos):
        card = Card()
        agora = INICIO
        passos = []

        for _ in range(passos_por_caso):
            rating = rng.choice(RATINGS)
            revisado_em = agora
            card, _ = scheduler.review_card(card=card, rating=rating, review_datetime=agora)

            passos.append(
                {
                    "rating": int(rating),
                    "revisado_em_iso": revisado_em.isoformat(),
                    "estado": ESTADO[card.state],
                    "step": card.step,
                    "estabilidade": card.stability,
                    "dificuldade": card.difficulty,
                    "intervalo_seg": int((card.due - card.last_review).total_seconds()),
                }
            )

            atraso = rng.choice(ATRASOS)
            agora = card.due + timedelta(seconds=atraso)

        casos.append({"inicio_iso": INICIO.isoformat(), "passos": passos})

    return casos


if __name__ == "__main__":
    casos = gerar(n_casos=400, passos_por_caso=12, semente=20260906)
    saida = {
        "fonte": "open-spaced-repetition/py-fsrs, Scheduler(enable_fuzzing=False), padroes",
        "casos": casos,
    }
    print(json.dumps(saida))
