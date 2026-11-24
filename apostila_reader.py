"""Exercícios identificados na apostila 1 enviada pelo usuário.

As dimensões ausentes são aproximações explícitas, editáveis no leitor.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np


# Página, região em coordenadas PDF, dimensões iniciais e lacunas a confirmar.
EXERCISES = {
    "1a": (4, (0, 160, 595, 465), "1A · Placa com ressalto e furo",
           {"plate_length": 200, "plate_width": 100, "plate_height": 10,
            "boss_length": 40, "boss_width": 50, "boss_height": 15,
            "bore_diameter": 30, "bore_x": 165, "bore_y": 70},
           ["Posição transversal do ressalto e do furo"]),
    "1b": (4, (0, 465, 595, 842), "1B · Suporte com cubo",
           {"base_length": 105, "base_width": 80, "base_height": 15,
            "arm_height": 25,
            "boss_diameter": 40, "bore_diameter": 20, "boss_height": 25,
            "notch_width": 15, "notch_height": 15},
           ["Comprimento total e largura da base", "Posição exata do recorte"]),
    "1c": (5, (0, 0, 595, 420), "1C · Suporte inclinado",
           {"base_length": 8, "base_width": 6, "base_height": 3,
            "top_height": 1, "left_boss_length": 4, "right_boss_length": 2,
            "slot_width": 2},
           ["Unidade original não indicada; valores tratados provisoriamente como milímetros",
            "Forma exata da abertura central", "Inclinação das faces"]),
    "1d": (5, (0, 420, 595, 842), "1D · Suporte inclinado com recorte",
           {"base_length": 8, "base_width": 6, "base_height": 3,
            "top_height": 1, "left_boss_length": 2, "right_boss_length": 3,
            "slot_width": 2},
           ["Unidade original não indicada; valores tratados provisoriamente como milímetros",
            "Forma exata do recorte frontal", "Inclinação das faces"]),
    "1e": (6, (0, 0, 595, 490), "1E · Placa com arcos",
           {"plate_width": 40, "total_height": 75, "thickness": 25,
            "body_diameter": 48, "upper_hole_diameter": 12,
            "lower_hole_diameter": 14, "foot_notch_radius": 8},
           ["Curvatura do pescoço", "Posição e largura da ranhura curva"]),
    "1f": (6, (0, 490, 595, 842), "1F · Perfil em C com furo",
           {"width": 50, "depth": 46, "height": 67,
            "wall_thickness": 7, "bottom_thickness": 6,
            "top_depth": 17, "top_thickness": 7, "hole_diameter": 20},
           ["Posição longitudinal do furo"]),
    "2a": (7, (0, 80, 595, 425), "2A · Pino de revolução",
           {"height": 45, "stem_diameter": 25, "bulge_diameter": 33,
            "bulge_height": 16, "top_length": 10},
           ["Perfil exato do arco R5", "Altura da base inferior"]),
    "2b": (7, (0, 425, 595, 842), "2B · Peça de revolução alta",
           {"height": 220, "base_diameter": 180, "stem_diameter": 40,
            "upper_ring_diameter": 60, "middle_ring_diameter": 80},
           ["Perfil curvo R60", "Posição axial dos anéis", "Raios de concordância"]),
    "2c": (8, (0, 0, 595, 305), "2C · Peça de revolução ilustrada",
           {"base_diameter": 100, "base_height": 12, "middle_diameter": 70,
            "middle_height": 20, "top_diameter": 35, "top_height": 8},
           ["A figura não contém cotas; todas as dimensões são estimadas"]),
    "2d": (8, (0, 305, 595, 650), "2D · Bloco com cavidade escalonada",
           {"block_length": 160, "block_height": 110, "block_depth": 50,
            "outer_diameter": 80, "middle_diameter": 46, "inner_diameter": 40,
            "cavity_depth": 35},
           ["Geometria exata da seção interna", "Raios R8 e chanfros"]),
    "2e": (8, (0, 625, 595, 842), "2E · Vista ilustrativa do bloco 2D",
           {"block_length": 160, "block_height": 110, "block_depth": 50,
            "outer_diameter": 80, "middle_diameter": 46, "inner_diameter": 40,
            "cavity_depth": 35},
           ["A ilustração usa as cotas do exercício 2D"]),
}


def preset(key: str) -> dict:
    _, _, name, dimensions, uncertain = EXERCISES[key]
    return {"recognized": True, "kind": "apostila1", "name": name,
            "geometry": {"template_id": key}, "dimensions": dimensions,
            "uncertain": uncertain,
            "message": f"{name}: modelo aproximado. Confira as cotas e as partes estimadas antes de usar."}


@lru_cache(maxsize=1)
def _features() -> dict[str, np.ndarray]:
    path = Path(__file__).parent / "assets" / "apostila1-orb.npz"
    with np.load(path) as archive:
        return {key: archive[key].copy() for key in archive.files}


def detect_exercise_image(data: bytes) -> dict | None:
    """Identifica fotografias ou recortes dos exercícios sem exigir o PDF inteiro.

    Desenhos simples (linhas, círculos e números) também têm pontos parecidos com
    os da apostila; por isso o servidor só chama esta função depois que os
    reconhecedores geométricos não encontraram nada.
    """
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None or min(image.shape) < 170:
        return None
    factor = min(1.0, 1600 / max(image.shape))
    if factor < 1:
        image = cv2.resize(image, None, fx=factor, fy=factor,
                           interpolation=cv2.INTER_AREA)
    _, descriptors = cv2.ORB_create(nfeatures=1500).detectAndCompute(image, None)
    if descriptors is None or len(descriptors) < 40:
        return None
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    scores = []
    for key, reference in _features().items():
        pairs = matcher.knnMatch(descriptors, reference, k=2)
        matches = sum(pair[0].distance < .72 * pair[1].distance
                      for pair in pairs if len(pair) == 2)
        scores.append((matches, key))
    scores.sort(reverse=True)
    if scores[0][0] < 40 or scores[0][0] < 1.5 * scores[1][0]:
        return None
    return preset(scores[0][1])
