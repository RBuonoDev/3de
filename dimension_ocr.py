"""OCR assistido para cotas; nunca associa números ao modelo sem confirmação."""

from __future__ import annotations

import gc
import os
import re
from functools import lru_cache

import cv2
import numpy as np


# Hospedagem gratuita (Render, 512 MB): LOW_MEMORY=1 lê imagens menores, com uma
# thread e sem a passada ampliada; a memória do OCR cresce com a área da imagem.
LOW_MEMORY = os.environ.get("LOW_MEMORY", "").strip() not in ("", "0")
MAX_SIDE = 1400 if LOW_MEMORY else 1800


@lru_cache(maxsize=1)
def _reader():
    from rapidocr import RapidOCR

    if LOW_MEMORY:
        return RapidOCR(params={"Global.max_side_len": MAX_SIDE, "Global.log_level": "warning",
                                "EngineConfig.onnxruntime.intra_op_num_threads": 1,
                                "EngineConfig.onnxruntime.inter_op_num_threads": 1})
    return RapidOCR()


def _number(text: str) -> float | None:
    cleaned = text.strip().replace(",", ".")
    cleaned = re.sub(r"^[Ø⌀φΦRr\s]+", "", cleaned)
    cleaned = re.sub(r"\s*mm$", "", cleaned, flags=re.IGNORECASE)   # "62mm", "100 mm"
    if re.fullmatch(r"0\d", cleaned):
        return None  # Dois caracteres podem ser Ø seguido de algarismo invertido.
    # Em cotas verticais, o símbolo Ø costuma ser lido como um zero inicial.
    if re.fullmatch(r"0\d{2,3}", cleaned):
        cleaned = cleaned[1:]
    if not re.fullmatch(r"\d{1,4}(?:\.\d{1,3})?", cleaned):
        return None
    value = float(cleaned)
    return value if 0 < value <= 500 else None


def inspect_dimensions(data: bytes, result: dict) -> dict:
    """Reporta o que o OCR viu e o que continua sem leitura confiável."""
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return result
    scale = min(1.0, MAX_SIDE / max(image.shape[:2]))
    if scale < 1:
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    try:
        reading = _reader()(image)
    except Exception:
        result["ocr_message"] = "A leitura automática das cotas não está disponível; confira todas as medidas."
        return result
    found = []

    def collect(output, image_height, image_width, min_score=.45):
        boxes = output.boxes if output.boxes is not None else []
        for text, score, box in zip(output.txts or [], output.scores or [], boxes):
            center_y = float(np.asarray(box)[:, 1].mean()) / image_height
            if center_y < .035 or center_y > .965:
                continue  # Índices da moldura não são cotas da peça.
            value = _number(text)
            if value is not None and score >= min_score:
                display = text
                if text.startswith(("Ø", "⌀", "φ", "Φ")):
                    display = f"Ø{value:g}"
                elif re.fullmatch(r"0\d{2,3}", text):
                    display = f"{value:g} (possível Ø)"
                coordinates = np.asarray(box)
                item = {"text": text, "display": display, "value": value,
                        "confidence": round(float(score), 2),
                        "orientation": "vertical" if np.ptp(coordinates[:, 1]) > np.ptp(coordinates[:, 0]) * 1.35 else "horizontal",
                        "x": round(float(coordinates[:, 0].mean()) / image_width, 3),
                        "y": round(center_y, 3)}
                if not any(old["value"] == value for old in found):
                    found.append(item)

    collect(reading, image.shape[0], image.shape[1])
    # A OCR horizontal frequentemente confunde Ø20/Ø60 escritos na vertical.
    # Tentar as duas rotações recupera o número sem inventar um diâmetro.
    vertical_text = any(
        np.ptp(np.asarray(box)[:, 1]) > np.ptp(np.asarray(box)[:, 0]) * 1.35
        for box in (reading.boxes if reading.boxes is not None else [])
    )
    if vertical_text and len(found) < 3:
        for rotation in (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE):
            try:
                turned = cv2.rotate(image, rotation)
                collect(_reader()(turned), turned.shape[0], turned.shape[1], .9)
            except Exception:
                pass
    expected = [float(value) for value in result.get("dimensions", {}).values()
                if isinstance(value, (int, float))]
    missing = [value for value in expected
               if not any(abs(item["value"] - value) < .051 for item in found)]
    if (missing or not result.get("recognized")) and max(image.shape[:2]) < 1600 and not LOW_MEMORY:
        factor = min(1.7, 2200 / max(image.shape[:2]))
        try:
            enlarged = cv2.resize(image, None, fx=factor, fy=factor,
                                  interpolation=cv2.INTER_CUBIC)
            collect(_reader()(enlarged), enlarged.shape[0], enlarged.shape[1])
        except Exception:
            pass
    gc.collect()   # devolve logo as matrizes grandes das imagens lidas
    result["ocr_readings"] = found[:80]
    result["ocr_message"] = (
        "Números detectados por OCR; a associação com cada dimensão ainda requer conferência."
        if found else "Nenhuma cota numérica foi lida com segurança. Envie uma imagem mais nítida."
    )
    statuses = {}
    provisional = {
        "exercise32": {"flange_height", "mount_hole_diameter", "mount_hole_x", "mount_hole_y"},
        "round": {"outer_diameter", "thickness"},
        "profile2d": {"profile_width", "profile_height", "profile_thickness"},
        "two_views": {"view_width", "view_height", "view_depth"},
    }.get(result.get("kind"), set())
    for key, raw_value in result.get("dimensions", {}).items():
        if not isinstance(raw_value, (int, float)):
            continue
        if key in provisional:
            statuses[key] = {"state": "unread", "message": "Sem cota vinculada com segurança; valor provisório."}
            continue
        matches = [item for item in found if abs(item["value"] - float(raw_value)) < .051]
        best = max(matches, key=lambda item: item["confidence"], default=None)
        if best is None:
            statuses[key] = {"state": "unread", "message": "Não localizada na imagem; valor provisório."}
        else:
            statuses[key] = {
                "state": "candidate",
                "message": f"Número {best['text']} detectado ({round(best['confidence'] * 100)}%); confirme a qual linha pertence.",
            }
    result["dimension_status"] = statuses
    return result
