"""Reconstrução de peças desenhadas em duas ou três vistas ortográficas.

Cada vista (frontal, superior e lateral) vira uma extrusão do seu contorno na
direção em que foi vista; a peça é a interseção dessas extrusões. Furos circulares
desenhados numa vista viram furos passantes nessa direção.

Funciona com o 1º diedro (ABNT: superior abaixo da frontal, lateral esquerda à
direita) e com o 3º diedro (superior acima, lateral direita à direita). Cotas,
linhas de chamada e linhas de centro encostadas nas vistas são apagadas por uma
abertura morfológica da vista preenchida. Linhas ocultas e detalhes internos que
não aparecem no contorno continuam exigindo revisão.
"""

from __future__ import annotations

import math

import cv2
import numpy as np
from shapely.geometry import Polygon


def _flatten_paper(gray: np.ndarray) -> np.ndarray:
    """Rectify a bright photographed page against a darker tabletop."""
    height, width = gray.shape
    border = np.concatenate((gray[0], gray[-1], gray[:, 0], gray[:, -1]))
    if np.mean(border > 210) >= .85:
        return gray
    bright = np.uint8(gray > 165) * 255
    bright = cv2.morphologyEx(bright, cv2.MORPH_CLOSE, np.ones((13, 13), np.uint8))
    contours, _ = cv2.findContours(bright, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return gray
    page = max(contours, key=cv2.contourArea)
    if cv2.contourArea(page) < width * height * .4:
        return gray
    corners = cv2.approxPolyDP(page, .018 * cv2.arcLength(page, True), True).reshape(-1, 2)
    if len(corners) != 4:
        return gray
    corners = corners.astype(np.float32)
    sums, differences = corners.sum(axis=1), np.diff(corners, axis=1).reshape(-1)
    source = np.array([corners[np.argmin(sums)], corners[np.argmin(differences)],
                       corners[np.argmax(sums)], corners[np.argmax(differences)]], dtype=np.float32)
    page_width = int(max(np.linalg.norm(source[0] - source[1]), np.linalg.norm(source[2] - source[3])))
    page_height = int(max(np.linalg.norm(source[0] - source[3]), np.linalg.norm(source[1] - source[2])))
    if min(page_width, page_height) < 260:
        return gray
    page_width, page_height = min(page_width, 1600), min(page_height, 1600)
    target = np.array([[0, 0], [page_width - 1, 0], [page_width - 1, page_height - 1],
                       [0, page_height - 1]], dtype=np.float32)
    flattened = cv2.warpPerspective(gray, cv2.getPerspectiveTransform(source, target),
                                    (page_width, page_height), borderValue=255)
    inset = max(4, int(min(page_width, page_height) * .012))
    return flattened[inset:-inset, inset:-inset]


def _view_regions(ink: np.ndarray, open_size: int | None = None) -> list[dict]:
    """Regiões das vistas: contornos externos preenchidos, sem as linhas finas que saem deles.

    Uma moldura ou legenda grande não é vista: as vistas dentro dela são procuradas
    no nível de dentro (netos do contorno da moldura).
    """
    height, width = ink.shape
    contours, hierarchy = cv2.findContours(ink, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return []
    tree = hierarchy[0]
    frame_like = lambda i: (lambda r: r[2] * r[3] > width * height * .45)(cv2.boundingRect(contours[i]))
    shapes = []
    for i, node in enumerate(tree):
        if node[3] != -1:
            continue
        if frame_like(i):
            # Filhos do contorno interno da moldura (o lado de dentro da linha).
            for j, inner in enumerate(tree):
                if inner[3] == i:
                    shapes.extend(k for k, item in enumerate(tree) if item[3] == j)
        else:
            shapes.append(i)
    filled = np.zeros_like(ink)
    for i in shapes:
        cv2.drawContours(filled, contours, i, 255, cv2.FILLED)
    size = open_size or (max(5, int(min(width, height) * .011)) | 1)
    solid = cv2.morphologyEx(filled, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size)))
    regions = []
    for contour in cv2.findContours(solid, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        x, y, w, h = cv2.boundingRect(contour)
        area = cv2.contourArea(contour)
        if area < width * height * .006 or min(w, h) < min(width, height) * .05:
            continue
        if x <= width * .01 or y <= height * .01 or x + w >= width * .99 or y + h >= height * .99:
            continue
        points = cv2.approxPolyDP(contour, max(1.2, cv2.arcLength(contour, True) * .003), True).reshape(-1, 2)
        if not 4 <= len(points) <= 96:
            continue
        shape = Polygon(points)
        if not shape.is_valid or shape.area < area * .5:
            continue
        regions.append({"box": (x, y, w, h), "points": points, "area": area, "shape": shape})
    regions.sort(key=lambda item: item["area"], reverse=True)
    return regions


def _holes(gray: np.ndarray, ink: np.ndarray, view: dict) -> list[tuple[float, float, float]]:
    """Círculos desenhados dentro da vista (furos): (cx, cy, raio) em pixels.

    As retas horizontais e verticais (linhas de centro, arestas) são tiradas da tinta;
    o que sobra de curvo é fechado de leve e cada região branca fechada, redonda e sem
    nada dentro vira um furo. Arcos abertos (raios de concordância) não fecham região
    e letras são pequenas demais.
    """
    x, y, w, h = view["box"]
    pad = 4
    x0, y0 = max(0, x - pad), max(0, y - pad)
    # Limiar mais claro que o das vistas: em imagens pequenas os círculos finos e
    # serrilhados se quebram em pontinhos com o limiar automático.
    crop = np.uint8(gray[y0:y + h + pad, x0:x + w + pad] < 205) * 255
    small = min(w, h)
    # Duas passadas: retas "longas" curtas cortam linhas de centro em furos pequenos, mas
    # num círculo de traço grosso o alto e os lados também parecem retos e se abririam;
    # com retas mais longas o círculo grosso fica inteiro.
    found = []
    for share in (.16, .32):
        found += _holes_pass(crop, small, max(15, int(small * share)), view, x0, y0)
    # Círculos concêntricos (escareado, rebaixo): fica o menor, que é o furo passante.
    found.sort(key=lambda c: c[2])
    kept = []
    for c in found:
        if not any(math.hypot(c[0] - k[0], c[1] - k[1]) < max(3, k[2] * .5) for k in kept):
            kept.append(c)
    return kept[:16]


def _holes_pass(crop, small, long, view, x0, y0) -> list[tuple[float, float, float]]:
    straight = cv2.bitwise_or(cv2.morphologyEx(crop, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (long, 1))),
                              cv2.morphologyEx(crop, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, long))))
    # Retas longas inclinadas também (a linha de indicação de um Ø atravessa o furo).
    lines = cv2.HoughLinesP(crop, 1, np.pi / 180, threshold=int(long * .7), minLineLength=long, maxLineGap=2)
    for x1, y1, x2, y2 in ([] if lines is None else lines[:, 0]):
        cv2.line(straight, (int(x1), int(y1)), (int(x2), int(y2)), 255, 2)
    curvy = cv2.bitwise_and(crop, cv2.bitwise_not(cv2.dilate(straight, np.ones((3, 3), np.uint8))))
    # Fecha os cortes deixados pelas linhas de centro que cruzavam o círculo.
    curvy = cv2.morphologyEx(curvy, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    contours, hierarchy = cv2.findContours(curvy, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    found = []
    if hierarchy is None:
        return found
    tree = hierarchy[0]
    for i, contour in enumerate(contours):
        if tree[i][3] == -1:
            continue                      # contorno de fora de um traço: não é região branca
        area = cv2.contourArea(contour)
        (cx, cy), r = cv2.minEnclosingCircle(contour)
        if r < max(4, small * .02) or r > small * .42:
            continue
        # Pode ter sobras pequenas dentro (traço da linha de centro, marca de centro).
        inside, j = 0.0, tree[i][2]
        while j != -1:
            inside += cv2.contourArea(contours[j])
            j = tree[j][0]
        if inside > area * .18:
            continue
        perimeter = cv2.arcLength(contour, True)
        if area < .78 * math.pi * r * r or 4 * math.pi * area / max(1e-6, perimeter * perimeter) < .75:
            continue
        r += 1.5                          # meio traço: o furo vai até o meio da linha
        gx, gy = cx + x0, cy + y0
        if not view["shape"].buffer(-2).contains(Polygon([(gx + r * math.cos(a), gy + r * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 16, endpoint=False)])):
            continue
        found.append((float(gx), float(gy), float(r)))
    return found


def _layout(regions: list[dict]):
    """Escolhe frontal, superior e lateral pelo alinhamento das caixas das vistas."""
    views = [r for r in regions[:8] if r["area"] >= regions[0]["area"] * .08] if regions else []
    best = None
    for front in views:
        fx, fy, fw, fh = front["box"]
        top = side = None
        for other in views:
            if other is front:
                continue
            ox, oy, ow, oh = other["box"]
            same_w = abs(ow - fw) / max(ow, fw) < .14 and abs((ox + ow / 2) - (fx + fw / 2)) < max(ow, fw) * .12
            same_h = abs(oh - fh) / max(oh, fh) < .14 and abs((oy + oh / 2) - (fy + fh / 2)) < max(oh, fh) * .12
            apart_v = oy > fy + fh or oy + oh < fy
            apart_h = ox > fx + fw or ox + ow < fx
            if same_w and apart_v and top is None:
                top = other
            elif same_h and apart_h and side is None:
                side = other
        score = (top is not None) + (side is not None)
        if not score:
            continue
        # Erro de alinhamento: largura da frontal x superior, altura da frontal x lateral e
        # profundidade da superior x lateral (numa projeção ortográfica são iguais).
        pairs = []
        if top is not None:
            pairs.append((fw, top["box"][2]))
        if side is not None:
            pairs.append((fh, side["box"][3]))
        if top is not None and side is not None:
            pairs.append((top["box"][3], side["box"][2]))
        error = sum(abs(a - b) / max(a, b) for a, b in pairs) / len(pairs)
        # Com duas vistas empilhadas a frontal fica em cima (1º diedro, ABNT).
        upper = top is None or front["box"][1] < top["box"][1]
        key = (score, upper, -error)
        if best is None or key > best[4]:
            best = (score, front, top, side, key)
    # Devolve (vistas encontradas, frontal, superior, lateral, erro de alinhamento ≥ 0).
    return best and best[:4] + (-best[4][2],)


def detect_multiview(data: bytes) -> dict | None:
    gray = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if gray is None or min(gray.shape) < 260:
        return None
    gray = _flatten_paper(gray)
    # Pranchas da internet costumam ser pequenas: ampliar dá contornos e furos mais precisos.
    factor = min(2.5, 1400 / max(gray.shape))
    if abs(factor - 1) > .05:
        gray = cv2.resize(gray, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA if factor < 1 else cv2.INTER_CUBIC)
    height, width = gray.shape
    border = np.concatenate((gray[0], gray[-1], gray[:, 0], gray[:, -1]))
    if np.mean(gray > 200) < .6 or np.mean(border > 200) < .6:
        return None
    _, ink = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    # Várias leituras da tinta; fica a que dá o conjunto de vistas mais coerente.
    #  - linhas grossas (contorno) sem as finas (cotas, chamadas, centro), se houver diferença;
    #  - limiar fixo mais escuro: em JPEG, cotas claras ou serrilhadas não grudam na vista;
    #  - limiar automático (Otsu), com ou sem fechar falhas de 1 px.
    total = max(1, cv2.countNonZero(ink))
    small = max(3, int(min(width, height) * .004)) | 1
    attempts = []
    for k in (3, 2):
        thick = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
        if cv2.countNonZero(thick) >= total * .3:
            attempts.append((cv2.morphologyEx(thick, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)), 5))
    attempts.append((np.uint8(gray < 140) * 255, small))
    attempts.append((ink, small))
    attempts.append((cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)), None))
    regions, layout = [], None
    for mask, size in attempts:
        found = _view_regions(mask, size)
        candidate = _layout(found)
        # Mais vistas, menor erro de alinhamento e, no empate, vistas mais justas (uma
        # cota grudada só aumenta a área da vista).
        area = lambda lay: sum(v["area"] for v in lay[1:4] if v is not None)
        rank = lambda lay: (lay[0], -round(lay[4] / .02), -area(lay))
        if candidate and (layout is None or rank(candidate) > rank(layout)):
            regions, layout = found, candidate
    if not layout or layout[4] > .16:
        return None
    _, front, top, side, _ = layout
    used = [v for v in (front, top, side) if v is not None]
    # Sobrou outra forma do tamanho de uma vista (outra peça, uma lista)? É uma montagem
    # ou uma prancha com várias peças: melhor pedir o recorte de uma peça.
    if sum(1 for r in regions if r not in used and r["area"] > front["area"] * .45) >= 1:
        return None
    first_angle = top is None or top["box"][1] > front["box"][1]
    side_right = side is not None and side["box"][0] > front["box"][0]
    fx, fy, fw, fh = front["box"]

    def normalized(view, points):
        x, y, w, h = view["box"]
        # Os pontos extremos ficam em x e em x + w - 1: assim a vista vai de -0,5 a 0,5.
        return [[round(float((px - x) / max(1, w - 1) - .5), 5), round(float(.5 - (py - y) / max(1, h - 1)), 5)] for px, py in points]

    def circle(view, c):
        cx, cy, r = c
        return normalized(view, [(cx + r * math.cos(a), cy + r * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 32, endpoint=False)])

    geometry = {"front": normalized(front, front["points"]), "front_holes": [circle(front, c) for c in _holes(gray, ink, front)]}
    depths = []
    if top is not None:
        geometry["top"] = normalized(top, top["points"])
        geometry["top_holes"] = [circle(top, c) for c in _holes(gray, ink, top)]
        depths.append(top["box"][3])
    if side is not None:
        geometry["side"] = normalized(side, side["points"])
        geometry["side_holes"] = [circle(side, c) for c in _holes(gray, ink, side)]
        # Sentido da profundidade na lateral: 1º diedro com a vista à direita é a lateral esquerda.
        geometry["side_sign"] = -1 if side_right == first_angle else 1
        depths.append(side["box"][2])
    depth = sum(depths) / len(depths)
    holes = sum(len(geometry.get(k, [])) for k in ("front_holes", "top_holes", "side_holes"))
    names = [n for n, v in (("frontal", front), ("superior", top), ("lateral", side)) if v is not None]
    return {
        "recognized": True,
        "kind": "two_views",
        "name": "Peça de três vistas" if len(names) == 3 else "Peça de duas vistas",
        "dimensions": {"view_width": 100.0, "view_height": round(100 * fh / fw, 1), "view_depth": round(100 * depth / fw, 1)},
        "geometry": geometry,
        "layout": {"views": names, "first_angle": first_angle, "holes": holes,
                   "front_box": [round(fx / width, 4), round(fy / height, 4), round(fw / width, 4), round(fh / height, 4)],
                   **({"top_box": [round(top["box"][0] / width, 4), round(top["box"][1] / height, 4), round(top["box"][2] / width, 4), round(top["box"][3] / height, 4)]} if top else {}),
                   **({"side_box": [round(side["box"][0] / width, 4), round(side["box"][1] / height, 4), round(side["box"][2] / width, 4), round(side["box"][3] / height, 4)]} if side else {})},
        "uncertain": ["Escala real", "Linhas ocultas e detalhes internos", "Furos que não atravessam a peça inteira"],
        "message": (f"Reconheci as vistas {', '.join(names)} ({'1º' if first_angle else '3º'} diedro) e combinei os contornos num modelo"
                    + (f", com {holes} furo(s) passante(s)" if holes else "") + ". Confira largura, altura e profundidade pelas cotas."),
    }


def apply_ocr_scale(result: dict) -> dict:
    """Usa as cotas lidas pelo OCR para dar a escala real às vistas.

    A cota horizontal logo acima ou abaixo da vista frontal, dentro da largura dela,
    costuma ser a largura total: a maior delas define a escala. A altura e a
    profundidade são conferidas com cotas próximas da vista frontal e da superior.
    """
    if result.get("kind") != "two_views" or "layout" not in result:
        return result
    readings = []
    for r in result.get("ocr_readings") or []:
        text = str(r.get("text", "")).strip()
        if text.endswith(("°", "º")) or text.upper().startswith("R"):
            continue                       # ângulos e raios não são largura, altura nem profundidade
        readings.append(r)
        # O OCR costuma ler "Ø70" como "270": guarda também a outra leitura.
        if len(text) >= 3 and text[0] == "2" and text[1:].isdigit():
            readings.append({**r, "value": float(text[1:]), "text": f"Ø{text[1:]}", "alternative": True})
    dims = result["dimensions"]
    keys = [k for k in ("view_width", "view_height", "view_depth") if dims.get(k)]
    # Cada número lido pode ser a largura, a altura ou a profundidade. Para cada hipótese
    # há uma escala (mm por unidade da vista); fica a escala que faz mais cotas lidas
    # baterem ao mesmo tempo com as três medidas. Um número solto (um ângulo lido como
    # 150, um índice da prancha) não encontra apoio nas outras medidas.
    best = None
    for r in readings:
        for key in keys:
            k = r["value"] / dims[key]
            matched = {}
            for other in keys:
                expected = dims[other] * k
                hit = min((x for x in readings if abs(x["value"] - expected) <= expected * .045), key=lambda x: abs(x["value"] - expected), default=None)
                if hit:
                    matched[other] = hit["value"]
            # Mais cotas que batem e cotas maiores (as medidas gerais costumam ser os
            # maiores números; números pequenos combinam entre si por acaso).
            score = (min(len(matched), 2) + sum(math.log1p(v) for v in matched.values()) / 4, r["value"])
            if matched and (best is None or score > best[0]):
                best = (score, k, matched)
    # As medidas gerais são dos maiores números da prancha. Se as cotas que combinam são
    # todas pequenas, foi coincidência: vale a maior cota horizontal junto da frontal.
    largest = max((r["value"] for r in readings if not r.get("alternative")), default=0)
    if best is None or len(best[2]) < 2 or (len(best[2]) < 3 and max(best[2].values()) < largest * .5):
        lay = result["layout"]
        fx, fy, fw, fh = lay["front_box"]
        widths = [r for r in readings if r["orientation"] == "horizontal" and fx - fw * .1 <= r["x"] <= fx + fw * 1.1
                  and (fy - .15 <= r["y"] < fy or fy + fh < r["y"] <= fy + fh + .15)]
        if not widths:
            return result
        width = max(widths, key=lambda r: r["value"])["value"]
        best = (None, width / dims["view_width"], {"view_width": width})
    _, k, matched = best
    scaled = {key: round(value * k, 1) for key, value in dims.items()}
    statuses = result.setdefault("dimension_status", {})
    for key in keys:
        if key in matched:
            scaled[key] = matched[key]
            statuses[key] = {"state": "candidate", "message": f"Cota {matched[key]:g} lida no desenho, coerente com as outras vistas; confirme."}
        else:
            statuses[key] = {"state": "unread", "message": "Calculada pela proporção das vistas, na escala das cotas lidas."}
    result["dimensions"] = scaled
    names = {"view_width": "largura", "view_height": "altura", "view_depth": "profundidade"}
    result["message"] = result.get("message", "") + " Escala pelas cotas lidas: " + ", ".join(f"{names[k]} {v:g} mm" for k, v in matched.items()) + "."
    return result




def validate_views(values: dict) -> dict:
    """Confere as cotas e os contornos das vistas e devolve tudo em milímetros.

    Coordenadas de cada vista: x para a direita e y para cima, normalizadas pela caixa
    da vista (de -0,5 a 0,5). Devolve {width, height, depth, front, top, side,
    front_holes, top_holes, side_holes, side_sign} com polígonos do shapely.
    """
    geometry = values.get("geometry")
    if not isinstance(geometry, dict):
        raise ValueError("As vistas não foram enviadas.")
    try:
        width, height, depth = (float(values[key]) for key in ("view_width", "view_height", "view_depth"))
    except (KeyError, TypeError, ValueError):
        raise ValueError("Confira largura, altura e profundidade da peça.") from None
    if any(not math.isfinite(value) or not .1 <= value <= 500 for value in (width, height, depth)):
        raise ValueError("As cotas devem estar entre 0,1 e 500 mm.")

    def polygon(points, sx: float, sy: float, minimum: int = 4) -> Polygon:
        if not isinstance(points, list) or not minimum <= len(points) <= 96:
            raise ValueError("O contorno de uma vista é inválido.")
        result = []
        for point in points:
            if not isinstance(point, list) or len(point) != 2:
                raise ValueError("Um ponto de vista é inválido.")
            x, y = float(point[0]), float(point[1])
            if not math.isfinite(x) or not math.isfinite(y) or max(abs(x), abs(y)) > .6:
                raise ValueError("Um ponto está fora da vista.")
            result.append((x * sx, y * sy))
        shape = Polygon(result)
        if not shape.is_valid or shape.area < 1e-3:
            raise ValueError("Uma das vistas não forma um perfil fechado válido.")
        return shape

    sizes = {"front": (width, height), "top": (width, depth), "side": (depth, height)}
    out = {"width": width, "height": height, "depth": depth, "side_sign": -1 if geometry.get("side_sign", -1) < 0 else 1}
    for key, (sx, sy) in sizes.items():
        points = geometry.get(key)
        out[key] = polygon(points, sx, sy) if points is not None else None
        holes = geometry.get(f"{key}_holes") or []
        if not isinstance(holes, list) or len(holes) > 16:
            raise ValueError("Há furos demais numa vista.")
        out[f"{key}_holes"] = [polygon(h, sx, sy, 3) for h in holes] if out[key] is not None else []
    if out["front"] is None or (out["top"] is None and out["side"] is None):
        raise ValueError("São necessárias a vista frontal e mais uma vista (superior ou lateral).")
    return out


def validate_two_views(values: dict) -> tuple[Polygon, Polygon, float, float, float]:
    """Compatibilidade: frontal e superior como no leitor de duas vistas."""
    v = validate_views(values)
    if v["top"] is None:
        raise ValueError("Falta a vista superior.")
    return v["front"], v["top"], v["width"], v["height"], v["depth"]
