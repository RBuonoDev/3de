"""Reconhecimento conservador de vistas frontais circulares em desenhos limpos."""

from __future__ import annotations

import cv2
import numpy as np

from profile_reader import large_ink_outside


def _coverage(edges, x: float, y: float, radius: float) -> float:
    height, width = edges.shape
    hits = 0
    for angle in np.linspace(0, 2 * np.pi, 96, endpoint=False):
        px = int(round(x + radius * np.cos(angle)))
        py = int(round(y + radius * np.sin(angle)))
        if 3 <= px < width - 3 and 3 <= py < height - 3 and np.any(edges[py - 3:py + 4, px - 3:px + 4]):
            hits += 1
    return hits / 96


def detect_round(data: bytes) -> dict | None:
    raw = np.frombuffer(data, dtype=np.uint8)
    picture = cv2.imdecode(raw, cv2.IMREAD_GRAYSCALE)
    if picture is None or min(picture.shape) < 200:
        return None
    height, width = picture.shape
    factor = min(1.0, 1200 / max(height, width))
    if factor < 1:
        picture = cv2.resize(picture, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
    height, width = picture.shape
    blurred = cv2.GaussianBlur(picture, (5, 5), 1.2)
    edges = cv2.Canny(blurred, 70, 150)
    found = cv2.HoughCircles(
        blurred, cv2.HOUGH_GRADIENT, dp=1.2,
        minDist=max(14, min(height, width) // 45),
        param1=130, param2=29,
        minRadius=max(12, min(height, width) // 50),
        maxRadius=int(min(height, width) * .46),
    )
    if found is None:
        return None
    circles = []
    for x, y, radius in found[0]:
        if not (.12 * width < x < .88 * width and .12 * height < y < .88 * height):
            continue
        coverage = _coverage(edges, x, y, radius)
        if coverage >= .55:
            circles.append((float(x), float(y), float(radius), coverage))
    circles.sort(key=lambda item: item[2], reverse=True)
    if not circles:
        return None
    outer = circles[0]
    ox, oy, radius, _ = outer
    # A single circular view should dominate the drawing. Ignore a circle
    # found inside a sheet with several views, titles or separate parts.
    # As cotas (números e linhas finas) fora do círculo não contam.
    _, ink = cv2.threshold(picture, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    margin = max(8, int(radius * .12))
    box = (int(ox - radius - margin), int(oy - radius - margin), int(ox + radius + margin), int(oy + radius + margin))
    if large_ink_outside(ink, *box) > cv2.countNonZero(ink) * .24:
        return None
    # A primeira passagem do Hough suprime círculos concêntricos por minDist.
    # Uma segunda busca limitada ao centro preserva o furo interno.
    inner = cv2.HoughCircles(
        blurred, cv2.HOUGH_GRADIENT, dp=1.0,
        minDist=max(10, int(radius * .08)), param1=130, param2=25,
        minRadius=max(8, int(radius * .1)), maxRadius=max(9, int(radius * .84)),
    )
    concentric = [c for c in circles[1:] if np.hypot(c[0] - ox, c[1] - oy) < radius * .07 and .12 * radius < c[2] < .86 * radius]
    if inner is not None:
        concentric.extend((float(x), float(y), float(r), _coverage(edges, x, y, r)) for x, y, r in inner[0] if np.hypot(x - ox, y - oy) < radius * .07 and .12 * radius < r < .86 * radius and _coverage(edges, x, y, r) >= .55)
    bore = min(concentric, key=lambda item: item[2], default=None)
    holes = []
    for x, y, r, _ in circles[1:]:
        distance = np.hypot(x - ox, y - oy)
        if distance < radius * .25 or distance + r > radius * .96 or r > radius * .28:
            continue
        if any(np.hypot(x - hx, y - hy) < max(r, hr) * .55 for hx, hy, hr in holes):
            continue
        holes.append((x, y, r))
        if len(holes) == 12:
            break
    if bore is None and not holes:
        return None
    scale = 50 / radius  # Diâmetro externo inicial: 100 mm; o usuário deve corrigir a cota.
    dims = {"outer_diameter": 100.0, "thickness": 10.0, "bore_diameter": round(2 * bore[2] * scale, 1) if bore else 0.0}
    for index, (x, y, r) in enumerate(holes, 1):
        dims[f"hole_{index}_x"] = round((x - ox) * scale, 1)
        dims[f"hole_{index}_y"] = round((oy - y) * scale, 1)
        dims[f"hole_{index}_diameter"] = round(2 * r * scale, 1)
    # Em pranchas com várias vistas, círculos de outras vistas podem cair na
    # projeção do contorno. Não trate essas sobreposições como uma peça circular.
    try:
        from parametric_model import round_dimensions

        round_dimensions(dims)
    except ValueError:
        return None
    return {
        "recognized": True,
        "kind": "round",
        "name": "Peça circular",
        "dimensions": dims,
        "message": f"Detectei um contorno circular, {'um furo central' if bore else 'sem furo central'} e {len(holes)} furos menores. O diâmetro externo foi definido provisoriamente como 100 mm: corrija essa cota e a espessura antes de enviar ao projeto.",
    }
