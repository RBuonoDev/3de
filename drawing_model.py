"""Reconstrução paramétrica preliminar da ménsula enviada pelo usuário.

As três seções são perfis 2D com arcos e furos circulares reais, extrudidos
nas alturas do desenho. O leitor reconhece somente o exemplo cadastrado.
"""

from __future__ import annotations

import hashlib
import math
import struct

from shapely import constrained_delaunay_triangles
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import unary_union


EXAMPLE_SHA256 = "5c699981f3b4a9e5be852546e74792585d98bce6b96e58eac5bd33d38d416076"
DEFAULTS = {
    "hub_radius": 32.0,
    "arm_span": 75.0,
    "lower_spacing": 80.0,
    "hole_radius": 7.0,
    "base_height": 25.0,
    "arm_height": 36.0,
    "total_height": 60.0,
    "hub_bore_radius": 16.0,
}


def recognize(data: bytes) -> dict:
    from exercise32 import recognize as recognize_exercise32

    exercise = recognize_exercise32(data)
    if exercise is not None:
        return exercise
    if hashlib.sha256(data).hexdigest() != EXAMPLE_SHA256:
        return {
            "recognized": False,
            "message": "Não consegui identificar uma vista 2D isolada com segurança. Enquadre apenas a vista principal, de frente e com boa nitidez, e envie PNG, JPG ou WEBP. Várias vistas e cotas incompletas exigem conferência manual.",
        }
    return {
        "recognized": True,
        "name": "Ménsula de cinco apoios",
        "dimensions": DEFAULTS,
        "uncertain": ["Diâmetro exato dos furos", "Diâmetro interno do cubo", "Altura de cada ressalto"],
        "message": "Modelo preliminar gerado. Confira as cotas destacadas antes de fabricar.",
    }


def _dimensions(values: dict) -> dict[str, float]:
    dims = dict(DEFAULTS)
    for key, value in values.items():
        if key not in dims:
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"Cota inválida: {key}") from None
        if not math.isfinite(number) or not 1 <= number <= 200:
            raise ValueError(f"Cota fora do intervalo: {key}")
        dims[key] = number
    if not 0 < dims["base_height"] < dims["arm_height"] < dims["total_height"]:
        raise ValueError("As alturas devem crescer da base até o topo.")
    if dims["hub_bore_radius"] >= dims["hub_radius"] - 2:
        raise ValueError("O furo central deve ser menor que o cubo.")
    if dims["hole_radius"] >= 12:
        raise ValueError("Os furos de fixação devem caber nos apoios.")
    return dims


def _centers(d: dict[str, float]) -> list[tuple[float, float]]:
    r = d["arm_span"]
    return [
        (-d["lower_spacing"] / 2, -45),
        (d["lower_spacing"] / 2, -45),
        (0, -r),
        (-r * math.sqrt(3) / 2, r / 2),
        (r * math.sqrt(3) / 2, r / 2),
    ]


def _profile(d: dict[str, float], layer: str):
    # Patamares recuados evitam superfícies coplanares sobrepostas nas junções.
    hub_radius = d["hub_radius"] + {"base": 4, "arms": 2, "top": 0}[layer]
    hub = Point(0, 0).buffer(hub_radius, quad_segs=32)
    if layer == "top":
        outer = hub
    else:
        width, pad = (12, 16) if layer == "base" else (10, 14)
        parts = [hub]
        for center in _centers(d):
            parts.append(LineString([(0, 0), center]).buffer(width, quad_segs=32))
            parts.append(Point(center).buffer(pad, quad_segs=32))
        outer = unary_union(parts)
    holes = [Point(0, 0).buffer(d["hub_bore_radius"], quad_segs=32)]
    if layer != "top":
        holes.extend(Point(c).buffer(d["hole_radius"], quad_segs=32) for c in _centers(d))
    return outer.difference(unary_union(holes))


def _polygons(geometry):
    if geometry.is_empty:
        return
    if geometry.geom_type == "Polygon":
        yield geometry
    elif hasattr(geometry, "geoms"):
        for part in geometry.geoms:
            yield from _polygons(part)


def _normal(a, b, c):
    u = tuple(b[i] - a[i] for i in range(3))
    v = tuple(c[i] - a[i] for i in range(3))
    n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
    size = math.sqrt(sum(x * x for x in n))
    return tuple(x / size for x in n) if size else (0.0, 0.0, 0.0)


def _add(triangles, a, b, c):
    normal = _normal(a, b, c)
    if normal != (0.0, 0.0, 0.0):
        triangles.append((normal, a, b, c))


def _walls(triangles, geometry, low: float, high: float):
    for polygon in _polygons(geometry):
        polygon = orient(polygon, sign=1.0)
        for ring in [polygon.exterior, *polygon.interiors]:
            vertices = list(ring.coords)
            for (x0, y0), (x1, y1) in zip(vertices, vertices[1:]):
                a, b = (x0, y0, low), (x1, y1, low)
                c, e = (x1, y1, high), (x0, y0, high)
                _add(triangles, a, b, c)
                _add(triangles, a, c, e)


def _cap(triangles, geometry, z: float, up: bool):
    for polygon in _polygons(geometry):
        for piece in constrained_delaunay_triangles(polygon).geoms:
            if not polygon.covers(piece.representative_point()):
                continue
            a, b, c = [(x, y, z) for x, y in list(piece.exterior.coords)[:3]]
            cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if (cross > 0) != up:
                b, c = c, b
            _add(triangles, a, b, c)


def _to_stl(header: bytes, triangles) -> bytes:
    """Serializa triângulos no formato STL binário.

    Cabeçalho de 80 bytes, contagem uint32 e, para cada triângulo, 12 floats
    (normal e três vértices) seguidos de 2 bytes de atributos.
    """
    result = bytearray(header.ljust(80, b"\0")[:80] + struct.pack("<I", len(triangles)))
    for normal, a, b, c in triangles:
        result.extend(struct.pack("<12fH", *normal, *a, *b, *c, 0))
    return bytes(result)


def _extrude(shape, thickness: float) -> list:
    """Extrusão simples de um perfil 2D: paredes laterais, fundo e topo."""
    triangles = []
    _walls(triangles, shape, 0, thickness)
    _cap(triangles, shape, 0, False)
    _cap(triangles, shape, thickness, True)
    return triangles


def _round_shape(dimensions: dict):
    from parametric_model import round_dimensions

    diameter, thickness, bore, holes = round_dimensions(dimensions)
    shape = Point(0, 0).buffer(diameter / 2, quad_segs=48)
    cuts = []
    if bore:
        cuts.append(Point(0, 0).buffer(bore / 2, quad_segs=48))
    cuts.extend(Point(x, y).buffer(size / 2, quad_segs=32) for x, y, size in holes)
    if cuts:
        shape = shape.difference(unary_union(cuts))
    if shape.is_empty or not shape.is_valid:
        raise ValueError("As cotas escolhidas não formam uma peça circular válida.")
    return shape, thickness


PILLOW_DEFAULTS = {
    # Valores lidos da prancha "mancal" (mm); conferir antes de fabricar.
    "base_length": 150.0,
    "base_width": 90.0,
    "base_thickness": 20.0,
    "body_length": 65.0,
    "body_height": 61.39,
    "bore_diameter": 65.0,
    "bore_center_height": 61.39,
}


def _pillow_dimensions(values: dict) -> dict[str, float]:
    dims = dict(PILLOW_DEFAULTS)
    for key, value in values.items():
        if key not in dims:
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"Cota inválida: {key}") from None
        if not math.isfinite(number) or not 1 <= number <= 300:
            raise ValueError(f"Cota fora do intervalo: {key}")
        dims[key] = number
    if dims["bore_diameter"] / 2 >= dims["bore_center_height"]:
        raise ValueError("O furo do mancal deve ficar acima da base.")
    if dims["body_length"] >= dims["base_length"]:
        raise ValueError("O corpo deve ser menor que a base.")
    return dims


def _pillow_stl(values: dict) -> bytes:
    """Mancal de eixo horizontal: base retangular e corpo com berço semicircular.

    O perfil frontal (X, Z) é extrudado ao longo da largura (Y), como na prancha:
    o furo do berço atravessa a peça pela largura.
    """
    d = _pillow_dimensions(values)
    width = d["base_width"]
    base = Polygon([(-d["base_length"] / 2, 0), (d["base_length"] / 2, 0),
                    (d["base_length"] / 2, d["base_thickness"]), (-d["base_length"] / 2, d["base_thickness"])])
    body = Polygon([(-d["body_length"] / 2, d["base_thickness"]), (d["body_length"] / 2, d["base_thickness"]),
                    (d["body_length"] / 2, d["body_height"]), (-d["body_length"] / 2, d["body_height"])])
    profile = unary_union([base, body]).difference(
        Point(0, d["bore_center_height"]).buffer(d["bore_diameter"] / 2, quad_segs=48))
    if profile.is_empty or not profile.is_valid:
        raise ValueError("As cotas escolhidas não formam um mancal válido.")
    raw = _extrude(profile, width)
    triangles = []
    for normal, a, b, c in raw:
        # Perfil (x, z) virou (x, largura, altura): troca Y e Z, refaz o sentido e a normal.
        m = [(p[0], p[2] - width / 2, p[1]) for p in (a, c, b)]
        triangles.append((_normal(*m), *m))
    return _to_stl(b"3DE pillow block - dimensions in mm", triangles)


def make_stl(dimensions: dict) -> bytes:
    """Gera a prévia STL das peças que não dependem do motor CAD."""
    if dimensions.get("kind") == "pillow_block":
        return _pillow_stl(dimensions)
    if dimensions.get("kind") == "profile2d":
        from profile_reader import validate

        shape, thickness = validate(dimensions)
        return _to_stl(b"3DE planar profile - dimensions in mm", _extrude(shape, thickness))
    if dimensions.get("kind") == "round":
        shape, thickness = _round_shape(dimensions)
        return _to_stl(b"3DE round part - dimensions in mm", _extrude(shape, thickness))
    return _bracket_stl(dimensions)


def _bracket_stl(dimensions: dict) -> bytes:
    """Ménsula em três patamares (base, braços e cubo superior)."""
    d = _dimensions(dimensions)
    base, arms, top = (_profile(d, layer) for layer in ("base", "arms", "top"))
    if any(shape.is_empty or not shape.is_valid for shape in (base, arms, top)):
        raise ValueError("As cotas escolhidas não formam uma peça válida.")
    triangles = []
    _walls(triangles, base, 0, d["base_height"])
    _walls(triangles, arms, d["base_height"], d["arm_height"])
    _walls(triangles, top, d["arm_height"], d["total_height"])
    _cap(triangles, base, 0, False)
    _cap(triangles, base.difference(arms), d["base_height"], True)
    _cap(triangles, arms.difference(base), d["base_height"], False)
    _cap(triangles, arms.difference(top), d["arm_height"], True)
    _cap(triangles, top.difference(arms), d["arm_height"], False)
    _cap(triangles, top, d["total_height"], True)
    return _to_stl(b"3DE bracket - smooth circular profiles - dimensions in mm", triangles)
