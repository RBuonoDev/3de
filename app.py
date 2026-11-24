"""Servidor Flask do 3DE.

Rotas principais
----------------
- ``/``: editor CAD do 3DE (static/editor).
- ``/ler-desenho``: página do leitor de desenhos técnicos.
- ``/api/ler-desenho``: reconhece a peça numa imagem e lê as cotas por OCR.
- ``/api/modelo-stl``: gera a prévia STL a partir das cotas revisadas.
- ``/api/modelo-projeto``: gera um projeto editável (.3de) para o editor.
- ``/api/transferir-modelo``: guarda um STL para o editor abrir.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import threading
import time
from collections import OrderedDict
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, Response, abort, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException

import cad_kernel
from apostila_reader import detect_exercise_image
from dimension_ocr import inspect_dimensions
from drawing_model import make_stl, recognize
from multiview_reader import apply_ocr_scale, detect_multiview
from sheet_cleanup import clean_sheet
from storage import open_storage, valid_owner
from parametric_model import make_script
from profile_reader import detect_profile
from round_reader import detect_round
from shaft_reader import detect_stepped_shaft


# ---------------------------------------------------------------------------
# Configuração
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
EDITOR_DIR = STATIC_DIR / "editor"
DRAWING_PAGE_PATH = BASE_DIR / "drawing_reader.html"
PROJECT_DIR = BASE_DIR / "generated_projects"

MB = 1_000_000
MAX_IMAGE_BYTES = 12 * MB           # Imagens de desenho técnico.
MAX_STL_BYTES = 80 * MB             # STL transferido ao editor.
MAX_STL_TRIANGLES = 1_599_998       # (80 MB - 84 bytes de cabeçalho) / 50 bytes.
TRANSFER_TTL_SECONDS = 30 * 60      # Tempo de vida das peças em memória.
PROJECT_FILE_TTL_SECONDS = 7 * 24 * 3600  # Cópias dos projetos em disco.

# Tipos de peça cuja prévia é gerada pelo núcleo paramétrico (roteiro de recursos).
# Os demais (ménsula, peça circular e perfil 2D) têm gerador STL próprio em drawing_model.
SCRIPT_PREVIEW_KINDS = {"exercise32", "two_views", "stepped_shaft", "apostila1"}

app = Flask(__name__, static_folder=None)
# Recusa corpos gigantes antes de lê-los (maior limite aceito + folga).
app.config["MAX_CONTENT_LENGTH"] = MAX_STL_BYTES + MB
log = logging.getLogger("3de")


# ---------------------------------------------------------------------------
# Banco de dados: PostgreSQL (Supabase) se DATABASE_URL estiver definida
# ---------------------------------------------------------------------------

db = open_storage(PROJECT_FILE_TTL_SECONDS, 200 * MB)
log.info("Armazenamento: %s", db.backend)


# ---------------------------------------------------------------------------
# Funções auxiliares
# ---------------------------------------------------------------------------

def _json_error(message: str, status: int, **extra) -> tuple[Response, int]:
    return jsonify({"error": message, **extra}), status


def _safe_name(raw: str | None, default: str) -> str:
    """Converte um nome livre em um nome de arquivo seguro (até 60 caracteres)."""
    name = re.sub(r"[^a-zA-Z0-9_-]", "-", raw or "")[:60].strip("-")
    return name or default


def _is_supported_image(data: bytes) -> bool:
    """Confere a assinatura binária (os primeiros bytes) de PNG, JPG ou WEBP."""
    is_png = data.startswith(b"\x89PNG")
    is_jpg = data.startswith(b"\xff\xd8")
    is_webp = data.startswith(b"RIFF") and data[8:12] == b"WEBP"
    return is_png or is_jpg or is_webp


def _binary_stl_triangles(data: bytes) -> int | None:
    """Retorna a quantidade de triângulos de um STL binário íntegro, ou None.

    Formato: 80 bytes de cabeçalho, 4 bytes com a contagem e 50 bytes por
    triângulo (normal + 3 vértices em float32 + 2 bytes de atributos).
    """
    if len(data) < 84:
        return None
    count = int.from_bytes(data[80:84], "little")
    if count == 0 or count > MAX_STL_TRIANGLES or 84 + count * 50 != len(data):
        return None
    return count


def _owner() -> str | None:
    """Chave do navegador (cabeçalho X-3DE-Dono): separa os projetos de cada pessoa."""
    owner = request.headers.get("X-3DE-Dono", "")
    return owner if valid_owner(owner) else None


# ---------------------------------------------------------------------------
# Páginas
# ---------------------------------------------------------------------------

@app.get("/")
def index() -> Response:
    return send_from_directory(EDITOR_DIR, "index.html")


@app.get("/editor")
def editor() -> Response:
    """Mantém compatíveis os links antigos para o editor."""
    return send_from_directory(EDITOR_DIR, "index.html")


@app.get("/health")
def health() -> dict[str, str]:
    if not (EDITOR_DIR / "index.html").is_file():
        abort(503, description="Arquivos do editor indisponíveis.")
    return {"status": "ok", "aplicacao": "3DE"}


@app.get("/ler-desenho")
def drawing_page() -> Response:
    return Response(DRAWING_PAGE_PATH.read_text(encoding="utf-8"), mimetype="text/html")


# ---------------------------------------------------------------------------
# Leitor de desenhos técnicos
# ---------------------------------------------------------------------------

def _flatten_transparency(data: bytes) -> bytes:
    """Coloca imagens com transparência (PNG exportado de SVG, por exemplo) sobre fundo branco.

    Lida em tons de cinza, a área transparente viraria preta e esconderia o desenho.
    """
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None or image.ndim != 3 or image.shape[2] != 4:
        return data
    alpha = image[:, :, 3:4].astype(np.float32) / 255
    flat = image[:, :, :3].astype(np.float32) * alpha + 255 * (1 - alpha)
    ok, encoded = cv2.imencode(".png", flat.astype(np.uint8))
    return encoded.tobytes() if ok else data


def _recognize_drawing(data: bytes) -> dict:
    """Tenta os reconhecedores do mais específico ao mais genérico.

    Ordem: exemplos cadastrados (ménsula e suporte) -> duas vistas -> peça
    circular -> perfil 2D -> exercícios da apostila. A apostila fica por último
    porque a comparação de pontos característicos (ORB) também acha semelhança
    em desenhos simples de flanges e perfis; os reconhecedores geométricos só
    aceitam uma vista única e limpa, então não confundem uma prancha da apostila.
    Depois o OCR lê as cotas e, se nada foi reconhecido, ainda tenta o eixo
    escalonado (que depende das cotas lidas pelo OCR).
    """
    data = _flatten_transparency(data)
    result = recognize(data)
    if result.get("recognized"):
        result.setdefault("kind", "bracket")
    else:
        # Prancha completa: sem moldura, legenda e perspectiva sombreada, sobram as vistas.
        clean, _ = clean_sheet(data)
        for detector in (detect_multiview, detect_round, detect_profile, detect_exercise_image):
            # A apostila compara a foto inteira com os exercícios; os outros usam a prancha limpa.
            detected = detector(data if detector is detect_exercise_image else clean)
            if detected:
                result = detected
                break
    result = inspect_dimensions(data, result)
    result = apply_ocr_scale(result)
    if not result.get("recognized"):
        shaft = detect_stepped_shaft(data, result.get("ocr_readings", []))
        if shaft:
            shaft["ocr_readings"] = result.get("ocr_readings", [])
            shaft["ocr_message"] = result.get("ocr_message", "")
            result = shaft
    return result


@app.post("/api/ler-desenho")
def read_drawing() -> Response:
    upload = request.files.get("drawing")
    if upload is None:
        return _json_error("Envie uma imagem do desenho.", 400)
    data = upload.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        return _json_error("A imagem deve ter até 12 MB.", 413)
    if not _is_supported_image(data):
        return _json_error("Envie PNG, JPG ou WEBP.", 400)
    try:
        result = _recognize_drawing(data)
    except Exception:  # noqa: BLE001 - uma imagem estranha não deve derrubar a página.
        log.exception("Falha ao analisar o desenho")
        return _json_error("Não foi possível analisar esta imagem. Tente outra foto ou recorte a vista principal.", 500)
    return jsonify(result)


@app.post("/api/modelo-stl")
def model_stl() -> Response:
    values = request.get_json(silent=True) or {}
    try:
        if values.get("kind") in SCRIPT_PREVIEW_KINDS:
            data = cad_kernel.to_stl(cad_kernel.run(make_script(values)["commands"]))
        else:
            data = make_stl(values)
    except ValueError as exc:
        return _json_error(str(exc), 400)
    return Response(data, mimetype="model/stl",
                    headers={"Content-Disposition": "attachment; filename=peca-3de.stl"})


@app.post("/api/modelo-projeto")
def model_project() -> Response:
    """Gera um projeto paramétrico (.3de) com esboços e recursos editáveis."""
    try:
        script = make_script(request.get_json(silent=True) or {})
        model = cad_kernel.run(script["commands"])   # confere se as cotas formam um sólido
    except ValueError as exc:
        return _json_error(str(exc), 400)
    name = _safe_name(request.args.get("name"), "peca-editavel")
    project = {"format": "3de-commands/1", "name": name, "units": "mm", "commands": script["commands"],
               "mass": cad_kernel.mass_properties(model)}
    design = json.dumps(project, ensure_ascii=False).encode("utf-8")
    token = db.put_file("projeto", name, design)
    return jsonify({"url": f"/api/projeto/{token}/{name}.3de", "features": model.features})


@app.get("/api/projeto/<token>/<filename>")
def transferred_project(token: str, filename: str) -> Response:
    if not filename.endswith(".3de"):
        abort(404)
    data = db.get_file("projeto", token, filename[:-4])
    if data is None:
        abort(404)
    response = Response(data, mimetype="application/json")
    response.headers["Cache-Control"] = "no-store"
    return response


# ---------------------------------------------------------------------------
# Transferência de STL ao editor
# ---------------------------------------------------------------------------

@app.post("/api/transferir-modelo")
def transfer_model() -> Response:
    """Guarda temporariamente a peça para o editor abri-la no mesmo navegador."""
    if request.content_length is not None and request.content_length > MAX_STL_BYTES:
        return _json_error("O STL deve ter até 80 MB.", 413)
    data = request.get_data(cache=False)
    if len(data) < 84 or len(data) > MAX_STL_BYTES:
        return _json_error("Envie uma peça STL binária de até 80 MB.", 400)
    if _binary_stl_triangles(data) is None:
        return _json_error("O arquivo STL está incompleto ou é inválido.", 400)
    name = _safe_name(request.args.get("name"), "peca-3de")
    token = db.put_file("stl", name, data)
    return jsonify({"url": f"/api/transferir-modelo/{token}/{name}.stl"})


@app.get("/api/transferir-modelo/<token>/<filename>")
def transferred_model(token: str, filename: str) -> Response:
    data = db.get_file("stl", token, filename[:-4]) if filename.endswith(".stl") else None
    if data is None:
        abort(404)
    response = Response(data, mimetype="model/stl")
    response.headers["Cache-Control"] = "no-store"
    return response


# ---------------------------------------------------------------------------
# Projetos salvos no editor (tabela "projetos")
# ---------------------------------------------------------------------------

MAX_PROJECT_BYTES = 8 * MB


@app.get("/api/projetos")
def list_saved_projects() -> Response:
    owner = _owner()
    if owner is None:
        return _json_error("Navegador sem identificação.", 400)
    return jsonify({"banco": db.backend, "projetos": db.list_projects(owner)})


@app.post("/api/projetos")
def save_project() -> Response:
    owner = _owner()
    if owner is None:
        return _json_error("Navegador sem identificação.", 400)
    raw = request.get_data(cache=False, as_text=True)
    if not raw or len(raw.encode("utf-8")) > MAX_PROJECT_BYTES:
        return _json_error("O projeto deve ter até 8 MB.", 413)
    try:
        project = json.loads(raw)
    except ValueError:
        return _json_error("O projeto enviado não é um JSON válido.", 400)
    if not isinstance(project, dict) or not str(project.get("format", "")).startswith("3de"):
        return _json_error("Isto não é um projeto do 3DE.", 400)
    name = str(project.get("name") or "Sem título").strip()[:80] or "Sem título"
    return jsonify({"banco": db.backend, "projeto": db.save_project(owner, name, raw)})


@app.get("/api/projetos/<pid>")
def open_saved_project(pid: str) -> Response:
    owner = _owner()
    data = db.get_project(owner, pid) if owner else None
    if data is None:
        abort(404)
    response = Response(data, mimetype="application/json")
    response.headers["Cache-Control"] = "no-store"
    return response


@app.delete("/api/projetos/<pid>")
def delete_saved_project(pid: str) -> Response:
    owner = _owner()
    if owner is None or not db.delete_project(owner, pid):
        abort(404)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Arquivos estáticos e erros
# ---------------------------------------------------------------------------

@app.get("/<path:filename>")
def assets(filename: str) -> Response:
    """Arquivos do editor (/editor/...) e o leitor de STL."""
    response = send_from_directory(STATIC_DIR, filename, conditional=True)
    response.headers["Cache-Control"] = "no-cache"
    # Compacta JS/CSS/SVG: pelo túnel público cada KB pesa no carregamento.
    if (response.status_code == 200 and filename.endswith((".js", ".css", ".svg", ".html"))
            and "gzip" in request.headers.get("Accept-Encoding", "")):
        import gzip
        response.direct_passthrough = False
        body = gzip.compress(response.get_data(), 6)
        response.set_data(body)
        response.headers["Content-Encoding"] = "gzip"
        response.headers["Content-Length"] = str(len(body))
        response.headers["Vary"] = "Accept-Encoding"
    return response


@app.errorhandler(HTTPException)
def http_error(error: HTTPException):
    """Nas rotas /api, responde erros em JSON para a página exibir a mensagem."""
    if not request.path.startswith("/api/"):
        return error
    messages = {
        404: "Arquivo não encontrado ou expirado. Gere a peça novamente.",
        413: "O arquivo enviado é grande demais.",
    }
    return _json_error(messages.get(error.code, error.description or "Erro na requisição."), error.code or 500)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
