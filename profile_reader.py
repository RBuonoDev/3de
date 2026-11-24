"""Extrusão editável de uma vista 2D isolada de desenho técnico.

Esta etapa é geométrica: não infere espessura, tolerâncias nem vistas ocultas.
Quando há várias vistas concorrentes, pede ao usuário uma imagem enquadrada.
"""

from __future__ import annotations

import math

import cv2
import numpy as np
from shapely.geometry import Polygon


def _outline(contour) -> list[list[float]] | None:
    perimeter = cv2.arcLength(contour, True)
    points = cv2.approxPolyDP(contour, max(1.1, perimeter * .002), True).reshape(-1, 2)
    if len(points) < 3 or len(points) > 128:
        return None
    return [[float(x), float(y)] for x, y in points]


def large_ink_outside(ink, left: int, top: int, right: int, bottom: int) -> int:
    """Pixels de tinta fora da caixa que pertencem a formas grandes nas duas direções.

    Cotas ficam fora da peça, mas são números (pequenos) e linhas finas; uma outra
    vista, um quadro ou um título em caixa são grandes na largura e na altura.
    """
    height, width = ink.shape
    outside = ink.copy()
    outside[max(0, top):min(height, bottom), max(0, left):min(width, right)] = 0
    count, _, stats, _ = cv2.connectedComponentsWithStats(outside)
    big = min(width, height) * .08
    return sum(int(stats[i, cv2.CC_STAT_AREA]) for i in range(1, count)
               if stats[i, cv2.CC_STAT_WIDTH] > big and stats[i, cv2.CC_STAT_HEIGHT] > big)


def detect_profile(data: bytes) -> dict | None:
    picture = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if picture is None or min(picture.shape) < 180:
        return None
    scale = min(1.0, 1200 / max(picture.shape))
    if scale < 1:
        picture = cv2.resize(picture, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    height, width = picture.shape
    border = np.concatenate((picture[0], picture[-1], picture[:, 0], picture[:, -1]))
    if np.mean(picture > 210) < .55 or np.mean(border > 210) < .7:
        return None
    _, ink = cv2.threshold(picture, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    result = _profile_from_mask(ink, ink)
    if result is None:
        # Vista hachurada ou sombreada (muito comum em pranchas): a peça é uma região
        # cheia. Uma abertura morfológica apaga linhas finas e textos (cotas, linhas
        # de chamada, eixos, linhas de centro) e deixa só a região com os furos.
        filled = np.where(picture < 235, 255, 0).astype(np.uint8)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
        solid = cv2.morphologyEx(filled, cv2.MORPH_OPEN, kernel)
        if cv2.countNonZero(solid) > width * height * .03:
            result = _profile_from_mask(solid, ink)
            if result:
                result["message"] = ("Detectei um perfil 2D preenchido (hachurado ou sombreado). A escala e a espessura são "
                                     "provisórias; revise as cotas e a prévia antes de enviar ao projeto.")
    return result


def _profile_from_mask(ink, line_ink) -> dict | None:
    """Procura um contorno principal em `ink`; `line_ink` é a tinta original (para o teste das outras vistas)."""
    height, width = ink.shape
    contours, hierarchy = cv2.findContours(ink, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return None
    candidates = []
    for index, contour in enumerate(contours):
        if hierarchy[0][index][3] != -1:
            continue
        x, y, w, h = cv2.boundingRect(contour)
        area = cv2.contourArea(contour)
        if area < width * height * .012 or w < 65 or h < 65:
            continue
        if x <= width * .025 or y <= height * .025 or x + w >= width * .975 or y + h >= height * .975:
            continue
        if w * h > width * height * .7:
            continue
        outline = _outline(contour)
        if outline is None:
            continue
        polygon = Polygon(outline)
        if not polygon.is_valid or polygon.area < width * height * .01:
            continue
        candidates.append((area, (x, y, w, h), outline, polygon))
    candidates.sort(key=lambda item: item[0], reverse=True)
    if not candidates:
        return None
    # Uma prancha com várias vistas não oferece uma profundidade única confiável.
    if len(candidates) > 1 and candidates[1][0] > candidates[0][0] * .42:
        return None
    _, (x, y, w, h), outline, polygon = candidates[0]
    # A clean single-view drawing keeps almost all ink near its main outline.
    # Exercise sheets contain titles, other views and separate components;
    # extruding one of those components would falsely imply a complete part.
    # Cotas ficam fora do contorno, mas são números (pequenos) e linhas finas:
    # só contam as formas grandes nas duas direções, como outra vista ou um quadro.
    margin = max(8, int(min(width, height) * .025))
    if large_ink_outside(line_ink, x - margin, y - margin, x + w + margin, y + h + margin) > cv2.countNonZero(line_ink) * .24:
        return None
    # A table or exploded diagram can form one big enclosing rectangle, but
    # it has many separate nested cells rather than a simple cutout pattern.
    main_index = next((index for index, contour in enumerate(contours)
                       if cv2.boundingRect(contour) == (x, y, w, h)
                       and hierarchy[0][index][3] == -1), None)
    if main_index is not None and sum(1 for item in hierarchy[0] if item[3] == main_index) > 5:
        return None
    # Regiões fechadas internas pequenas viram cortes; texto e linhas de cota são ignorados.
    holes = []
    for index, contour in enumerate(contours):
        if cv2.contourArea(contour) < polygon.area * .004:
            continue
        inner = _outline(contour)
        if inner is None or inner == outline:
            continue
        shape = Polygon(inner)
        if not shape.is_valid or shape.area > polygon.area * .25 or not polygon.buffer(-3).contains(shape):
            continue
        if any(other.intersects(shape) for other in holes):
            continue
        holes.append(shape)
        if len(holes) == 12:
            break
    center_x, center_y = x + w / 2, y + h / 2
    max_span = max(w, h)

    def normalized(points):
        return [[round((px - center_x) / max_span, 5), round((center_y - py) / max_span, 5)] for px, py in points]

    return {
        "recognized": True,
        "kind": "profile2d",
        "name": "Perfil 2D extrudido",
        "dimensions": {"profile_width": round(100 * w / max_span, 1), "profile_height": round(100 * h / max_span, 1), "profile_thickness": 10.0},
        "geometry": {"outer": normalized(outline), "holes": [normalized(list(hole.exterior.coords)[:-1]) for hole in holes]},
        "uncertain": ["Escala real", "Espessura", "Forma das faces não mostradas na vista 2D"],
        "message": "Detectei um perfil 2D isolado. A escala e a espessura são provisórias; revise as cotas e a prévia antes de enviar ao projeto.",
    }


def validate(values: dict) -> tuple[Polygon, float]:
    geometry = values.get("geometry")
    if not isinstance(geometry, dict):
        raise ValueError("O contorno do desenho não foi enviado.")
    try:
        width = float(values["profile_width"])
        height = float(values["profile_height"])
        thickness = float(values["profile_thickness"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("Confira largura, altura e espessura do perfil.") from None
    if any(not math.isfinite(value) or not .1 <= value <= 500 for value in (width, height, thickness)):
        raise ValueError("As cotas do perfil devem estar entre 0,1 e 500 mm.")

    def scaled(points):
        if not isinstance(points, list) or not 3 <= len(points) <= 128:
            raise ValueError("O contorno do desenho é inválido.")
        result = []
        for point in points:
            if not isinstance(point, list) or len(point) != 2:
                raise ValueError("Um ponto do contorno é inválido.")
            x, y = float(point[0]), float(point[1])
            if not math.isfinite(x) or not math.isfinite(y) or max(abs(x), abs(y)) > 1:
                raise ValueError("Um ponto do contorno está fora da área permitida.")
            result.append((x * width, y * height))
        return result

    outer = scaled(geometry.get("outer"))
    raw_holes = geometry.get("holes", [])
    if not isinstance(raw_holes, list) or len(raw_holes) > 12:
        raise ValueError("Há cortes demais no perfil.")
    holes = [scaled(points) for points in raw_holes]
    polygon = Polygon(outer, holes)
    if not polygon.is_valid or polygon.is_empty or polygon.area < 1:
        raise ValueError("O contorno ou os cortes se sobrepõem. Envie uma vista 2D mais limpa.")
    return polygon, thickness
