"""Leitura inicial da peça de suporte enviada em 16/11/2026."""

from __future__ import annotations

import hashlib
import math

import cv2
import numpy as np


IMAGE_SHA256 = "080956b87b8665932070935042c3ce8b93e1cc7a08888fb086ea82d09e43331f"
IMAGE_DHASH = 0x3270978687371CB4
DEFAULTS = {
    "plate_length": 92.0,
    "plate_width": 40.0,
    "plate_height": 9.0,
    "bridge_width": 32.0,
    "bridge_height": 20.0,
    "flange_diameter": 36.0,
    "flange_height": 3.0,
    "boss_diameter": 30.0,
    "boss_height": 18.0,
    "bore_diameter": 14.0,
    "notch_width": 18.0,
    "rib_height": 14.0,
    "rib_width": 6.0,
    "mount_hole_diameter": 8.0,
    "mount_hole_x": 37.0,
    "mount_hole_y": 10.0,
}


def recognize(data: bytes) -> dict | None:
    if hashlib.sha256(data).hexdigest() != IMAGE_SHA256:
        image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
        if image is None or min(image.shape) < 600 or abs(image.shape[1] / image.shape[0] - 860 / 1318) > .025:
            return None
        small = cv2.resize(image, (9, 8), interpolation=cv2.INTER_AREA)
        fingerprint = sum(int(bit) << index for index, bit in enumerate((small[:, :-1] > small[:, 1:]).reshape(-1)))
        if (fingerprint ^ IMAGE_DHASH).bit_count() > 4:
            return None
    return {
        "recognized": True,
        "kind": "exercise32",
        "name": "Suporte com cubo cilíndrico",
        "dimensions": DEFAULTS,
        "uncertain": ["Diâmetro dos quatro furos de fixação", "Posição dos furos", "Espessura e posição das nervuras", "Altura do ressalto Ø36"],
        "message": "Desenho reconhecido. Comprimento 92 mm, largura 40 mm e base 9 mm foram lidos; confira as medidas sem cota explícita antes de usar o modelo.",
    }


def dimensions(values: dict) -> dict[str, float]:
    result = dict(DEFAULTS)
    for key, value in values.items():
        if key not in result:
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"Cota inválida: {key}") from None
        if not math.isfinite(number) or not .1 <= number <= 500:
            raise ValueError(f"Cota fora do intervalo: {key}")
        result[key] = number
    d = result
    if d["notch_width"] >= d["bridge_width"] - 2 or d["bridge_width"] >= d["plate_length"] - 10:
        raise ValueError("A abertura inferior deve ser menor que a ponte central, que deve caber na base.")
    if d["boss_diameter"] > d["flange_diameter"] or d["bore_diameter"] >= d["boss_diameter"] - 2:
        raise ValueError("Os diâmetros do cubo e do furo central não cabem um no outro.")
    if d["flange_height"] >= d["boss_height"] - .5:
        raise ValueError("O ressalto inferior deve ser mais baixo que o cubo cilíndrico.")
    if d["flange_diameter"] > d["plate_width"] + 4:
        raise ValueError("O flange central está grande demais para a largura da base.")
    if d["mount_hole_x"] + d["mount_hole_diameter"] / 2 >= d["plate_length"] / 2 - 1:
        raise ValueError("Os furos de fixação ultrapassam as extremidades da base.")
    if d["mount_hole_y"] + d["mount_hole_diameter"] / 2 >= d["plate_width"] / 2 - 1:
        raise ValueError("Os furos de fixação ultrapassam as laterais da base.")
    if d["mount_hole_x"] - d["mount_hole_diameter"] / 2 <= d["flange_diameter"] / 2 + 1:
        raise ValueError("Os furos de fixação estão próximos demais do cubo central.")
    if d["rib_height"] > d["bridge_height"] or d["rib_width"] >= d["plate_width"] / 2:
        raise ValueError("As nervuras não cabem no suporte.")
    return d
