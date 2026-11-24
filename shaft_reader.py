"""Reconhece o caso limitado de eixo escalonado simétrico em uma vista lateral."""

from __future__ import annotations

import cv2
import numpy as np


def validate_shaft(values: dict) -> dict[str, float]:
    keys = ("shaft_length", "end_length", "shoulder_length", "end_diameter",
            "shoulder_diameter", "center_diameter")
    try:
        d = {key: float(values[key]) for key in keys}
    except (KeyError, TypeError, ValueError):
        raise ValueError("Confira as seis cotas do eixo.") from None
    if any(not np.isfinite(value) or not 1 <= value <= 500 for value in d.values()):
        raise ValueError("As cotas do eixo devem estar entre 1 e 500 mm.")
    if d["shaft_length"] <= 2 * (d["end_length"] + d["shoulder_length"]):
        raise ValueError("As seções laterais não cabem no comprimento total.")
    if not d["end_diameter"] < d["shoulder_diameter"] < d["center_diameter"]:
        raise ValueError("Os diâmetros devem crescer da ponta até o centro.")
    return d


def detect_stepped_shaft(data: bytes, readings: list[dict]) -> dict | None:
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None:
        return None
    height, width = image.shape
    if width / height < 1.8 or min(width, height) < 170:
        return None
    horizontal = {item["value"] for item in readings if item.get("orientation") == "horizontal"
                  and item["confidence"] >= .8}
    vertical = {item["value"] for item in readings if item.get("orientation") == "vertical"
                and item["confidence"] >= .8}
    # Uma vista lateral com três diâmetros e três comprimentos explícitos.
    if len(vertical) != 3 or len(horizontal) < 3:
        return None
    end_diameter, shoulder_diameter, center_diameter = sorted(vertical)
    shaft_length = max(horizontal)
    section_lengths = sorted(value for value in horizontal if value < shaft_length)
    if len(section_lengths) != 2:
        return None
    shoulder_length, end_length = section_lengths
    dims = {"shaft_length": shaft_length, "end_length": end_length,
            "shoulder_length": shoulder_length, "end_diameter": end_diameter,
            "shoulder_diameter": shoulder_diameter, "center_diameter": center_diameter}
    try:
        validate_shaft(dims)
    except ValueError:
        return None
    edges = cv2.Canny(image, 80, 180)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=35,
                            minLineLength=max(20, width // 30), maxLineGap=5)
    if lines is None:
        return None
    horizontal_lines = sum(abs(int(y1) - int(y2)) < 3 and abs(int(x1) - int(x2)) > width * .07
                           for x1, y1, x2, y2 in lines[:, 0])
    vertical_lines = sum(abs(int(x1) - int(x2)) < 3 and abs(int(y1) - int(y2)) > height * .07
                         for x1, y1, x2, y2 in lines[:, 0])
    if horizontal_lines < 5 or vertical_lines < 4:
        return None
    statuses = {}
    for key, value in dims.items():
        match = max((item for item in readings if item["value"] == value),
                    key=lambda item: item["confidence"])
        statuses[key] = {"state": "candidate",
                         "message": f"Cota {match['display']} detectada ({round(match['confidence'] * 100)}%); confira a linha de chamada."}
    return {
        "recognized": True,
        "kind": "stepped_shaft",
        "name": "Eixo escalonado simétrico",
        "dimensions": dims,
        "dimension_status": statuses,
        "uncertain": ["Simetria das seções", "Comprimento central calculado pelas demais cotas",
                      "Extensão da ponta esquerda fora da linha de cota total"],
        "message": "Eixo escalonado preliminar criado a partir de uma vista e seis cotas. Confira o comprimento total, a ponta esquerda e a simetria antes de usar.",
    }
