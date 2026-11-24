"""Construção de recursos editáveis do desenho no projeto 3DE."""

from __future__ import annotations

import math
import re

from drawing_model import _centers, _dimensions
from exercise32 import dimensions as exercise_dimensions
from profile_reader import validate as validate_profile
from multiview_reader import validate_views
from shaft_reader import validate_shaft
from apostila_models import build as build_apostila


def _number(value, name, minimum=0.0, maximum=500.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"Cota inválida: {name}") from None
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise ValueError(f"Cota fora do intervalo: {name}")
    return number


def round_dimensions(values):
    diameter = _number(values.get("outer_diameter"), "diâmetro externo", 2)
    thickness = _number(values.get("thickness"), "espessura", .1)
    bore = _number(values.get("bore_diameter", 0), "diâmetro interno")
    if bore >= diameter - 1:
        raise ValueError("O furo central deve ser menor que o contorno externo.")
    holes = []
    indices = sorted({int(match.group(1)) for key in values if (match := re.fullmatch(r"hole_(\d+)_diameter", key))})
    for index in indices:
        x = _number(values.get(f"hole_{index}_x"), f"furo {index}: X", -250, 250)
        y = _number(values.get(f"hole_{index}_y"), f"furo {index}: Y", -250, 250)
        size = _number(values.get(f"hole_{index}_diameter"), f"furo {index}: diâmetro", .1)
        if math.hypot(x, y) + size / 2 >= diameter / 2 - .2:
            raise ValueError(f"O furo {index} ultrapassa o contorno da peça.")
        if bore and math.hypot(x, y) < (bore + size) / 2 + .2:
            raise ValueError(f"O furo {index} se sobrepõe ao furo central.")
        if any(math.hypot(x - hx, y - hy) < (size + hd) / 2 + .2 for hx, hy, hd in holes):
            raise ValueError(f"O furo {index} se sobrepõe a outro furo.")
        holes.append((x, y, size))
    return diameter, thickness, bore, holes


def _circle(commands, name, x, y, diameter, distance, operation, offset=0, body_name="Peça circular"):
    params = {"plane": "XY", "name": name}
    if offset:
        params["offset"] = offset
    commands.extend([
        {"command": "sketch.create", "params": params},
        {"command": "sketch.circle.center", "params": {"center": [round(x, 4), round(y, 4)], "diameter": round(diameter, 4)}},
        {"command": "sketch.finish", "params": {}},
        {"command": "solid.extrude", "params": {"distance": round(distance, 4), "operation": operation, "name": name, **({"body_name": body_name} if operation == "new" else {})}},
    ])


def _rectangle(commands, name, p0, p1, distance, operation, offset=0, body_name="Suporte"):
    params = {"plane": "XY", "name": name}
    if offset:
        params["offset"] = offset
    commands.extend([
        {"command": "sketch.create", "params": params},
        {"command": "sketch.rectangle.two_point", "params": {"p0": p0, "p1": p1}},
        {"command": "sketch.finish", "params": {}},
        {"command": "solid.extrude", "params": {"distance": round(distance, 4), "operation": operation, "name": name, **({"body_name": body_name} if operation == "new" else {})}},
    ])


def _points(coords, flip_y_offset=None):
    """Arredonda pontos de um contorno para enviar ao motor CAD."""
    if flip_y_offset is None:
        return [[round(x, 4), round(y, 4)] for x, y in coords]
    return [[round(x, 4), round(-y - flip_y_offset, 4)] for x, y in coords]


def _polyline(commands, plane, name, points, extrude):
    """Esboço com uma poligonal fechada seguido de uma extrusão."""
    commands.extend([
        {"command": "sketch.create", "params": {"plane": plane, "name": name}},
        {"command": "sketch.line", "params": {"points": points, "closed": True}},
        {"command": "sketch.finish", "params": {}},
        {"command": "solid.extrude", "params": extrude},
    ])


def make_script(values):
    """Converte as cotas revisadas em uma lista de comandos do motor CAD.

    Cada peça vira uma sequência de esboços (``sketch.*``) e operações sólidas
    (``solid.extrude`` com ``new``, ``join`` ou ``cut``), que continuam
    editáveis na árvore de recursos do editor.
    """
    kind = values.get("kind", "bracket")
    commands = []
    if kind == "apostila1":
        return build_apostila(values, _rectangle, _circle)
    if kind == "stepped_shaft":
        d = validate_shaft(values)
        middle = d["shaft_length"] - 2 * (d["end_length"] + d["shoulder_length"])
        sections = [
            ("Ponta esquerda", d["end_diameter"], d["end_length"]),
            ("Ombro esquerdo", d["shoulder_diameter"], d["shoulder_length"]),
            ("Seção central", d["center_diameter"], middle),
            ("Ombro direito", d["shoulder_diameter"], d["shoulder_length"]),
            ("Ponta direita", d["end_diameter"], d["end_length"]),
        ]
        offset = 0.0
        for index, (name, diameter, length) in enumerate(sections):
            _circle(commands, name, 0, 0, diameter, length,
                    "new" if index == 0 else "join", offset,
                    body_name="Eixo escalonado")
            offset += length
        return {"commands": commands}
    if kind == "two_views":
        # Peça = interseção das extrusões das vistas (frontal, superior e lateral);
        # os furos de cada vista atravessam a peça na direção daquela vista.
        v = validate_views(values)
        width, height, depth, sign = v["width"], v["height"], v["depth"], v["side_sign"]
        ring = lambda shape: list(shape.exterior.coords)[:-1]
        # No plano XZ deste motor, o eixo vertical do esboço aponta para -Z.
        front_pts = lambda shape: _points(ring(shape), flip_y_offset=height / 2)
        # No plano YZ: u = Y (profundidade, sentido conforme o diedro), v = Z.
        side_pts = lambda shape: [[round(sign * x, 4), round(y + height / 2, 4)] for x, y in ring(shape)]
        _polyline(commands, "XZ", "Vista frontal", front_pts(v["front"]),
                  {"distance": depth, "direction": "symmetric", "operation": "new",
                   "name": "Volume da vista frontal", "body_name": "Frente"})
        if v["top"] is not None:
            _polyline(commands, "XY", "Vista superior", _points(ring(v["top"])),
                      {"distance": height, "operation": "new", "name": "Volume da vista superior", "body_name": "Topo"})
            commands.append({"command": "solid.combine", "params": {"target": "Frente", "tools": ["Topo"], "operation": "intersect"}})
        if v["side"] is not None:
            _polyline(commands, "YZ", "Vista lateral", side_pts(v["side"]),
                      {"distance": width, "direction": "symmetric", "operation": "new", "name": "Volume da vista lateral", "body_name": "Lado"})
            commands.append({"command": "solid.combine", "params": {"target": "Frente", "tools": ["Lado"], "operation": "intersect"}})
        through = 2 * max(width, height, depth) + 10
        for index, hole in enumerate(v["front_holes"], 1):
            _polyline(commands, "XZ", f"Furo frontal {index}", front_pts(hole),
                      {"distance": through, "direction": "symmetric", "operation": "cut", "name": f"Furo frontal {index}"})
        for index, hole in enumerate(v["top_holes"], 1):
            _polyline(commands, "XY", f"Furo superior {index}", _points(ring(hole)),
                      {"distance": through, "direction": "symmetric", "operation": "cut", "name": f"Furo superior {index}"})
        for index, hole in enumerate(v["side_holes"], 1):
            _polyline(commands, "YZ", f"Furo lateral {index}", side_pts(hole),
                      {"distance": through, "direction": "symmetric", "operation": "cut", "name": f"Furo lateral {index}"})
        return {"commands": commands}
    if kind == "profile2d":
        polygon, thickness = validate_profile(values)
        _polyline(commands, "XY", "Contorno principal", _points(list(polygon.exterior.coords)[:-1]),
                  {"distance": thickness, "operation": "new", "name": "Espessura", "body_name": "Perfil 2D"})
        for index, ring in enumerate(polygon.interiors, 1):
            _polyline(commands, "XY", f"Recorte {index}", _points(list(ring.coords)[:-1]),
                      {"distance": thickness, "operation": "cut", "name": f"Recorte {index}"})
        return {"commands": commands}
    if kind == "exercise32":
        d = exercise_dimensions(values)
        half_length, half_width = d["plate_length"] / 2, d["plate_width"] / 2
        top_bridge = d["plate_height"] + d["bridge_height"]
        _rectangle(commands, "Base 92 x 40", [-half_length, -half_width], [half_length, half_width], d["plate_height"], "new")
        _rectangle(commands, "Ponte central", [-d["bridge_width"] / 2, -half_width], [d["bridge_width"] / 2, half_width], d["bridge_height"], "join", d["plate_height"])
        for side, name in ((-1, "Nervura esquerda"), (1, "Nervura direita")):
            edge = side * d["bridge_width"] / 2
            tip = side * (half_length - d["mount_hole_diameter"] - 1)
            # No plano XZ deste motor, o eixo vertical do esboço aponta para -Z.
            # Valores negativos posicionam as nervuras acima da base.
            points = [[edge, -d["plate_height"]], [tip, -d["plate_height"]], [edge, -d["plate_height"] - d["rib_height"]]]
            _polyline(commands, "XZ", name, points,
                      {"distance": d["rib_width"], "operation": "join", "name": name})
        _circle(commands, "Flange Ø36", 0, 0, d["flange_diameter"], d["flange_height"], "join", top_bridge)
        _circle(commands, "Cubo Ø30", 0, 0, d["boss_diameter"], d["boss_height"] - d["flange_height"], "join", top_bridge + d["flange_height"])
        holes = [(x, y) for x in (-d["mount_hole_x"], d["mount_hole_x"]) for y in (-d["mount_hole_y"], d["mount_hole_y"])]
        for index, (x, y) in enumerate(holes, 1):
            _circle(commands, f"Furo de fixação {index}", x, y, d["mount_hole_diameter"], d["plate_height"], "cut")
        _circle(commands, "Furo central Ø14", 0, 0, d["bore_diameter"], d["plate_height"] + d["bridge_height"] + d["boss_height"], "cut")
        _rectangle(commands, "Abertura inferior", [-d["notch_width"] / 2, -half_width], [d["notch_width"] / 2, half_width], d["plate_height"], "cut")
        return {"commands": commands}
    if kind == "round":
        diameter, thickness, bore, holes = round_dimensions(values)
        _circle(commands, "Contorno circular", 0, 0, diameter, thickness, "new")
        if bore:
            _circle(commands, "Furo central", 0, 0, bore, thickness, "cut")
        for index, (x, y, size) in enumerate(holes, 1):
            _circle(commands, f"Furo {index}", x, y, size, thickness, "cut")
        return {"commands": commands}

    if kind != "bracket":
        raise ValueError("Tipo de peça não reconhecido.")
    d = _dimensions(values)
    centers = _centers(d)
    _circle(commands, "Base central", 0, 0, 2 * (d["hub_radius"] + 4), d["base_height"], "new", body_name="Ménsula")
    for index, (x, y) in enumerate(centers, 1):
        length = math.hypot(x, y)
        nx, ny = -y / length * 12, x / length * 12
        # Braço retangular de 24 mm de largura, do centro até o apoio.
        points = _points(((nx, ny), (x + nx, y + ny), (x - nx, y - ny), (-nx, -ny)))
        _polyline(commands, "XY", f"Braço {index}", points,
                  {"distance": d["base_height"], "operation": "join", "name": f"Braço {index}"})
        _circle(commands, f"Apoio {index}", x, y, 32, d["base_height"], "join")
    _circle(commands, "Cubo intermediário", 0, 0, 2 * (d["hub_radius"] + 2), d["arm_height"] - d["base_height"], "join", d["base_height"])
    for index, (x, y) in enumerate(centers, 1):
        _circle(commands, f"Ressalto {index}", x, y, 28, d["arm_height"] - d["base_height"], "join", d["base_height"])
    _circle(commands, "Cubo superior", 0, 0, 2 * d["hub_radius"], d["total_height"] - d["arm_height"], "join", d["arm_height"])
    _circle(commands, "Furo central", 0, 0, 2 * d["hub_bore_radius"], d["total_height"], "cut")
    for index, (x, y) in enumerate(centers, 1):
        _circle(commands, f"Furo de fixação {index}", x, y, 2 * d["hole_radius"], d["arm_height"], "cut")
    return {"commands": commands}
