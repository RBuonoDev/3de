"""Modelos paramétricos aproximados dos exercícios da apostila 1."""

from __future__ import annotations

import math

from apostila_reader import EXERCISES


def _dimensions(values: dict) -> tuple[str, dict[str, float]]:
    key = (values.get("geometry") or {}).get("template_id")
    if key not in EXERCISES:
        raise ValueError("Escolha um exercício válido da apostila.")
    defaults = EXERCISES[key][3]
    result = {}
    for name, default in defaults.items():
        try:
            value = float(values.get(name, default))
        except (TypeError, ValueError):
            raise ValueError(f"Confira a cota {name}.") from None
        if not math.isfinite(value) or not .1 <= value <= 500:
            raise ValueError(f"A cota {name} deve estar entre 0,1 e 500 mm.")
        result[name] = value
    return key, result


def build(values: dict, rectangle, circle) -> dict:
    key, d = _dimensions(values)
    commands = []

    def rect(name, p0, p1, height, operation="join", offset=0):
        rectangle(commands, name, [round(v, 3) for v in p0],
                  [round(v, 3) for v in p1], height, operation, offset,
                  body_name=EXERCISES[key][2])

    def disc(name, x, y, diameter, height, operation="join", offset=0):
        circle(commands, name, x, y, diameter, height, operation, offset,
               body_name=EXERCISES[key][2])

    if key == "1a":
        l, w, base = d["plate_length"], d["plate_width"], d["plate_height"]
        rect("Placa", [0, 0], [l, w], base, "new")
        rect("Ressalto", [0, 0], [d["boss_length"], d["boss_width"]],
             d["boss_height"], offset=base)
        disc("Furo passante", d["bore_x"], d["bore_y"],
             d["bore_diameter"], base + 2, "cut")
    elif key == "1b":
        l, w, base = d["base_length"], d["base_width"], d["base_height"]
        disc("Extremidade arredondada", 0, 0, w, base, "new")
        rect("Braço", [0, -w / 2], [l, w / 2], d["arm_height"])
        disc("Cubo", 0, 0, d["boss_diameter"], d["boss_height"], offset=base)
        disc("Furo central", 0, 0, d["bore_diameter"], base + d["boss_height"] + 1, "cut")
        rect("Recorte inferior", [l / 2, -w / 2 - 1],
             [l / 2 + d["notch_width"], w / 2 + 1], d["notch_height"], "cut")
    elif key in ("1c", "1d"):
        w, depth, h = d["base_length"], d["base_width"], d["base_height"]
        # Perfil triangular extrudido: aproxima as duas faces inclinadas.
        commands.extend([
            {"command": "sketch.create", "params": {"plane": "XZ", "name": "Perfil inclinado"}},
            {"command": "sketch.line", "params": {"points": [[0, 0], [depth, 0], [depth, -h]], "closed": True}},
            {"command": "sketch.finish", "params": {}},
            {"command": "solid.extrude", "params": {"distance": w, "direction": "symmetric", "operation": "new",
                                               "name": "Corpo inclinado", "body_name": EXERCISES[key][2]}},
        ])
        rect("Bloco superior esquerdo", [depth * .72, -w / 2],
             [depth, -w / 2 + d["left_boss_length"]], d["top_height"], offset=h - d["top_height"])
        rect("Bloco superior direito", [depth * .72, w / 2 - d["right_boss_length"]],
             [depth, w / 2], d["top_height"], offset=h - d["top_height"])
        rect("Abertura frontal", [depth * .18, -d["slot_width"] / 2],
             [depth * .58, d["slot_width"] / 2], h + 1, "cut")
    elif key == "1e":
        t = d["thickness"]
        rect("Base", [-d["plate_width"] / 2, 0], [d["plate_width"] / 2, 9], t, "new")
        disc("Corpo circular", 0, 34, d["body_diameter"], t)
        rect("Pescoço", [-9, 34], [9, d["total_height"] - 10.5], t)
        disc("Cabeça", 0, d["total_height"] - 10.5, 21, t)
        disc("Furo superior", 0, d["total_height"] - 10.5,
             d["upper_hole_diameter"], t + 1, "cut")
        disc("Furo inferior", 0, 24, d["lower_hole_diameter"], t + 1, "cut")
        disc("Entalhe da base", 0, 0, d["foot_notch_radius"] * 2, t + 1, "cut")
        outer = [(21.5 * math.cos(a), 34 + 21.5 * math.sin(a))
                 for a in [math.radians(v) for v in range(10, 171, 5)]]
        inner = [(14.5 * math.cos(a), 34 + 14.5 * math.sin(a))
                 for a in [math.radians(v) for v in range(170, 9, -5)]]
        commands.extend([
            {"command": "sketch.create", "params": {"plane": "XY", "name": "Ranhura curva"}},
            {"command": "sketch.line", "params": {"points": [[round(x, 3), round(y, 3)] for x, y in outer + inner], "closed": True}},
            {"command": "sketch.finish", "params": {}},
            {"command": "solid.extrude", "params": {"distance": t + 1, "operation": "cut", "name": "Ranhura curva"}},
        ])
    elif key == "1f":
        w, depth, h = d["width"], d["depth"], d["height"]
        rect("Base horizontal", [-w / 2, 0], [w / 2, depth], d["bottom_thickness"], "new")
        rect("Parede vertical", [-w / 2, depth - d["wall_thickness"]],
             [w / 2, depth], h - d["bottom_thickness"], offset=d["bottom_thickness"])
        rect("Aba superior", [-w / 2, depth - d["top_depth"]], [w / 2, depth],
             d["top_thickness"], offset=h - d["top_thickness"])
        disc("Furo da base", 0, depth / 2, d["hole_diameter"],
             d["bottom_thickness"] + 1, "cut")
    elif key in ("2a", "2b", "2c"):
        if key == "2a":
            height = d["height"]
            sections = [(d["stem_diameter"], height - d["bulge_height"] - d["top_length"])]
            sections += [(d["stem_diameter"] + (d["bulge_diameter"] - d["stem_diameter"])
                          * math.sin(math.pi * (i + .5) / 8), d["bulge_height"] / 8)
                         for i in range(8)]
            sections.append((d["stem_diameter"], d["top_length"]))
        elif key == "2b":
            height = d["height"]
            sections = [(d["base_diameter"], 12), (d["base_diameter"] * .82, 12),
                        (d["base_diameter"] * .62, 14), (d["base_diameter"] * .45, 18),
                        (d["stem_diameter"], 54), (d["middle_ring_diameter"], 28),
                        (d["stem_diameter"], 52), (d["upper_ring_diameter"], 16),
                        (d["stem_diameter"], max(1, height - 206))]
        else:
            sections = [(d["base_diameter"], d["base_height"]),
                        (d["middle_diameter"], d["middle_height"]),
                        (d["top_diameter"], d["top_height"])]
        offset = 0
        for index, (diameter, length) in enumerate(sections):
            disc(f"Seção de revolução {index + 1}", 0, 0, diameter, length,
                 "new" if index == 0 else "join", offset)
            offset += length
    elif key in ("2d", "2e"):
        l, depth, h = d["block_length"], d["block_depth"], d["block_height"]
        rect("Bloco", [-l / 2, -depth / 2], [l / 2, depth / 2], h, "new")
        # O plano XZ tem coordenada vertical invertida; as aberturas ficam na face frontal.
        def front_cut(name, diameter, distance, offset=0, symmetric=False):
            params = {"plane": "XZ", "name": name}
            if offset:
                params["offset"] = offset
            extrude = {"distance": distance, "operation": "cut", "name": name}
            if symmetric:
                extrude["direction"] = "symmetric"
            commands.extend([
                {"command": "sketch.create", "params": params},
                {"command": "sketch.circle.center", "params": {"center": [0, -h / 2], "diameter": diameter}},
                {"command": "sketch.finish", "params": {}},
                {"command": "solid.extrude", "params": extrude},
            ])
        front_cut("Furo interno", d["inner_diameter"], depth + 2, symmetric=True)
        front_cut("Rebaixo intermediário", d["middle_diameter"],
                  d["cavity_depth"], offset=-depth / 2)
        front_cut("Abertura externa", d["outer_diameter"], 5, offset=-depth / 2)
    return {"commands": commands}
