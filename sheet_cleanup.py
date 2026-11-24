"""Limpeza de pranchas de desenho técnico antes do reconhecimento das vistas.

Uma prancha completa traz, além das vistas ortográficas:
- a moldura e a régua de zonas (números e letras nas bordas);
- a legenda (tabela do título) e listas de peças, que são grades de linhas;
- uma perspectiva isométrica sombreada ou colorida, que não é uma vista projetada.

Aqui tudo isso é apagado (pintado de branco). As vistas, as cotas e as hachuras
dos cortes ficam como estão: os reconhecedores seguintes tratam delas.
"""

from __future__ import annotations

import cv2
import numpy as np


def _shaded_pictures(color: np.ndarray, gray: np.ndarray) -> np.ndarray:
    """Máscara das imagens sombreadas ou coloridas (perspectivas renderizadas)."""
    height, width = gray.shape
    hsv = cv2.cvtColor(color, cv2.COLOR_BGR2HSV)
    colored = (hsv[:, :, 1] > 60) & (hsv[:, :, 2] > 40)
    # Meios-tons em áreas grandes: um desenho a traço só tem meio-tom na borda das linhas.
    midtone = (gray > 45) & (gray < 228)
    paint = np.uint8(colored | midtone) * 255
    paint = cv2.morphologyEx(paint, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(paint)
    mask = np.zeros_like(gray)
    for i in range(1, count):
        x, y, w, h, area = stats[i]
        if area < width * height * .004:
            continue
        # Texto colorido (títulos) é comprido e baixo; uma imagem 3D é volumosa.
        if min(w, h) < min(width, height) * .06:
            continue
        mask[labels == i] = 255
    if not cv2.countNonZero(mask):
        return mask
    # Junta as partes de uma mesma imagem e pega também o contorno preto em volta.
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31)))
    filled = np.zeros_like(mask)
    for contour in cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        cv2.drawContours(filled, [cv2.convexHull(contour)], -1, 255, cv2.FILLED)
    return cv2.dilate(filled, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))


def _frame_and_tables(ink: np.ndarray) -> np.ndarray:
    """Máscara da moldura, da régua de zonas e das tabelas (legenda, lista de peças)."""
    height, width = ink.shape
    horizontal = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, width // 9), 1)))
    vertical = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, height // 14))))
    mask = np.zeros_like(ink)
    frame_rows, frame_cols = [], []
    # Moldura: linhas que atravessam quase a prancha inteira, perto das bordas.
    candidates = []
    for lines, along in ((horizontal, 0), (vertical, 1)):
        count, labels, stats, _ = cv2.connectedComponentsWithStats(lines)
        for i in range(1, count):
            span = stats[i, cv2.CC_STAT_WIDTH] if along == 0 else stats[i, cv2.CC_STAT_HEIGHT]
            size = width if along == 0 else height
            pos = stats[i, cv2.CC_STAT_TOP] if along == 0 else stats[i, cv2.CC_STAT_LEFT]
            if span > size * .6:
                candidates.append((along, pos, labels == i))
    # Só é moldura com os quatro lados: uma aresta comprida da peça ou uma linha de
    # cota atravessando o desenho não podem ser apagadas.
    def near(along, low):
        limit = (height if along == 0 else width)
        return any(a == along and (p < limit * .15 if low else p > limit * .85) for a, p, _ in candidates)
    if all(near(a, low) for a in (0, 1) for low in (True, False)):
        for along, pos, region in candidates:
            limit = height if along == 0 else width
            if pos < limit * .15 or pos > limit * .85:
                mask[region] = 255
                (frame_rows if along == 0 else frame_cols).append(pos)
    # Tabelas: grades com muitos cruzamentos de linhas longas (sem contar a moldura,
    # que encostaria tudo numa grade só).
    # Borda interna da moldura (ou da imagem, se não houver moldura).
    inner_bottom = min((r for r in frame_rows if r > height * .75), default=height)
    inner_right = min((c for c in frame_cols if c > width * .75), default=width)
    frame = cv2.dilate(mask, np.ones((7, 7), np.uint8))
    horizontal[frame > 0] = 0
    vertical[frame > 0] = 0
    grid = cv2.dilate(cv2.bitwise_or(horizontal, vertical), np.ones((3, 3), np.uint8))
    crossings = cv2.bitwise_and(cv2.dilate(horizontal, np.ones((5, 5), np.uint8)), cv2.dilate(vertical, np.ones((5, 5), np.uint8)))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(grid)
    for i in range(1, count):
        x, y, w, h, _ = stats[i]
        if w * h > width * height * .4:
            continue
        box = np.uint8((crossings[y:y + h, x:x + w] > 0) & (labels[y:y + h, x:x + w] == i))
        n = cv2.connectedComponentsWithStats(box)[0] - 1
        # Legenda e lista de peças ficam encostadas na moldura (embaixo ou à direita);
        # uma vista com muitas linhas retas fica solta no meio da prancha.
        anchored = y + h >= inner_bottom - height * .03 or x + w >= inner_right - width * .03
        if n >= 9 and anchored:
            mask[y:y + h, x:x + w] = 255
    return mask


def clean_sheet(data: bytes) -> tuple[bytes, dict]:
    """Devolve a imagem só com as vistas e um resumo do que foi apagado."""
    color = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if color is None:
        return data, {}
    scale = min(1.0, 1800 / max(color.shape[:2]))
    if scale < 1:
        color = cv2.resize(color, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(color, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    if np.mean(gray > 200) < .5:
        return data, {}          # foto escura ou papel não branco: deixa para os outros passos
    pictures = _shaded_pictures(color, gray)
    # Uma vista pintada de cinza chapado (exportada de SVG) também é meio-tom, mas uma
    # perspectiva renderizada tem degradê de luz e sombra. Cinza uniforme fica.
    if cv2.countNonZero(pictures):
        tones = gray[(pictures > 0) & (gray > 45) & (gray < 228)]
        if tones.size and np.std(tones) < 6:
            pictures[:] = 0
    out = gray.copy()
    out[pictures > 0] = 255
    _, ink = cv2.threshold(out, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    frame = _frame_and_tables(ink)
    out[cv2.dilate(frame, np.ones((5, 5), np.uint8)) > 0] = 255
    # Régua de zonas e textos soltos fora da moldura: a borda da prancha fica branca.
    margin = int(min(width, height) * .02)
    out[:margin, :] = 255; out[-margin:, :] = 255; out[:, :margin] = 255; out[:, -margin:] = 255
    # As cotas ficam: nos desenhos as linhas de chamada têm uma folga até a peça, e
    # apagar linhas perto dos números arriscava levar junto arestas da própria vista.
    summary = {"pictures": int(cv2.countNonZero(pictures) > 0), "frame": int(cv2.countNonZero(frame) > 0)}
    ok, encoded = cv2.imencode(".png", out)
    return (encoded.tobytes() if ok else data), summary
