"""Núcleo geométrico do 3DE (implementação própria).

Um projeto 3DE é uma lista de comandos (a mesma que o editor do navegador usa):

    sketch.create          abre um esboço num plano (XY, XZ ou YZ) com deslocamento opcional
    sketch.rectangle.two_point / sketch.circle.center / sketch.line   adicionam contornos
    sketch.finish          fecha o esboço
    solid.extrude          extruda o último esboço (new, join, cut ou intersect)
    solid.revolve          gira o último esboço em torno do eixo vertical do esboço
    solid.combine          combina corpos com nome (intersect, join ou cut)

Como funciona
-------------
1. Cada esboço vira regiões: contornos fechados; um contorno dentro de outro é furo.
2. As regiões são trianguladas (corte de orelhas, com pontes até os furos).
3. Extrusão e revolução constroem um sólido fechado de polígonos planos.
4. União, corte e interseção usam árvores BSP (particionamento binário do espaço):
   cada sólido recorta os polígonos do outro pelos planos das suas faces.
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass, field

CIRCLE_SEGMENTS = 64
MAX_COMMANDS = 600
MAX_SIZE_MM = 5000.0
EPS = 1e-6          # tolerância de classificação ponto/plano (mm)

Vec = tuple[float, float, float]


# ---------------------------------------------------------------------------
# Vetores
# ---------------------------------------------------------------------------

def _sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a: Vec, b: Vec) -> Vec:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _lerp(a: Vec, b: Vec, t: float) -> Vec:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


# ---------------------------------------------------------------------------
# Polígonos planos e árvore BSP
# ---------------------------------------------------------------------------

class Poly:
    """Polígono convexo plano; vértices em sentido anti-horário visto de fora."""

    __slots__ = ("verts", "normal", "w")

    def __init__(self, verts: list[Vec], normal: Vec | None = None, w: float | None = None):
        self.verts = verts
        if normal is None:
            n = _cross(_sub(verts[1], verts[0]), _sub(verts[2], verts[0]))
            length = math.sqrt(_dot(n, n)) or 1.0
            normal = (n[0] / length, n[1] / length, n[2] / length)
            w = _dot(normal, verts[0])
        self.normal, self.w = normal, w

    def flipped(self) -> "Poly":
        n = self.normal
        return Poly(self.verts[::-1], (-n[0], -n[1], -n[2]), -self.w)


COPLANAR, FRONT, BACK, SPANNING = 0, 1, 2, 3


def _split(normal: Vec, w: float, poly: Poly, co_front: list, co_back: list, front: list, back: list) -> None:
    """Divide ``poly`` pelo plano (normal, w) e distribui os pedaços nas listas."""
    kinds, kind = [], 0
    for v in poly.verts:
        d = _dot(normal, v) - w
        k = BACK if d < -EPS else FRONT if d > EPS else COPLANAR
        kind |= k
        kinds.append(k)
    if kind == COPLANAR:
        (co_front if _dot(normal, poly.normal) > 0 else co_back).append(poly)
    elif kind == FRONT:
        front.append(poly)
    elif kind == BACK:
        back.append(poly)
    else:
        f, b = [], []
        verts, count = poly.verts, len(poly.verts)
        for i in range(count):
            j = (i + 1) % count
            ki, kj, vi, vj = kinds[i], kinds[j], verts[i], verts[j]
            if ki != BACK:
                f.append(vi)
            if ki != FRONT:
                b.append(vi)
            if (ki | kj) == SPANNING:
                t = (w - _dot(normal, vi)) / _dot(normal, _sub(vj, vi))
                p = _lerp(vi, vj, t)
                f.append(p)
                b.append(p)
        if len(f) >= 3:
            front.append(Poly(f, poly.normal, poly.w))
        if len(b) >= 3:
            back.append(Poly(b, poly.normal, poly.w))


class Node:
    """Nó da árvore BSP: um plano, os polígonos sobre ele e as subárvores."""

    __slots__ = ("normal", "w", "polys", "front", "back")

    def __init__(self, polys: list[Poly] | None = None):
        self.normal = None
        self.w = 0.0
        self.polys: list[Poly] = []
        self.front: Node | None = None
        self.back: Node | None = None
        if polys:
            self.build(polys)

    def build(self, polys: list[Poly]) -> None:
        # Iterativo (pilha explícita): peças grandes passariam do limite de recursão.
        stack = [(self, polys)]
        while stack:
            node, items = stack.pop()
            if not items:
                continue
            if node.normal is None:
                node.normal, node.w = items[0].normal, items[0].w
            front, back = [], []
            for p in items:
                _split(node.normal, node.w, p, node.polys, node.polys, front, back)
            if front:
                node.front = node.front or Node()
                stack.append((node.front, front))
            if back:
                node.back = node.back or Node()
                stack.append((node.back, back))

    def nodes(self) -> list["Node"]:
        out, stack = [], [self]
        while stack:
            n = stack.pop()
            out.append(n)
            if n.front:
                stack.append(n.front)
            if n.back:
                stack.append(n.back)
        return out

    def invert(self) -> None:
        """Troca dentro por fora: inverte polígonos, planos e lados."""
        for n in self.nodes():
            n.polys = [p.flipped() for p in n.polys]
            if n.normal is not None:
                n.normal = (-n.normal[0], -n.normal[1], -n.normal[2])
                n.w = -n.w
            n.front, n.back = n.back, n.front

    def clip_polys(self, polys: list[Poly]) -> list[Poly]:
        """Remove as partes de ``polys`` que ficam dentro do sólido desta árvore."""
        result, stack = [], [(self, polys)]
        while stack:
            node, items = stack.pop()
            if node.normal is None:
                result.extend(items)
                continue
            front, back = [], []
            for p in items:
                _split(node.normal, node.w, p, front, back, front, back)
            if node.front:
                stack.append((node.front, front))
            else:
                result.extend(front)
            if node.back:
                stack.append((node.back, back))
            # Sem subárvore de trás, o que está atrás está dentro: é descartado.
        return result

    def clip_to(self, other: "Node") -> None:
        for n in self.nodes():
            n.polys = other.clip_polys(n.polys)

    def all_polys(self) -> list[Poly]:
        out = []
        for n in self.nodes():
            out.extend(n.polys)
        return out


@dataclass
class Solid:
    polys: list[Poly] = field(default_factory=list)

    def bounds(self):
        xs = [v for p in self.polys for v in p.verts]
        if not xs:
            return None
        return (min(v[0] for v in xs), min(v[1] for v in xs), min(v[2] for v in xs),
                max(v[0] for v in xs), max(v[1] for v in xs), max(v[2] for v in xs))


def _overlap(a: Solid, b: Solid) -> bool:
    ba, bb = a.bounds(), b.bounds()
    if ba is None or bb is None:
        return False
    return all(ba[i] <= bb[i + 3] + EPS and bb[i] <= ba[i + 3] + EPS for i in range(3))


def union(a: Solid, b: Solid) -> Solid:
    if not _overlap(a, b):
        return Solid(a.polys + b.polys)
    na, nb = Node(a.polys), Node(b.polys)
    na.clip_to(nb)
    nb.clip_to(na)
    nb.invert()
    nb.clip_to(na)
    nb.invert()
    na.build(nb.all_polys())
    return Solid(na.all_polys())


def subtract(a: Solid, b: Solid) -> Solid:
    if not _overlap(a, b):
        return Solid(list(a.polys))
    na, nb = Node(a.polys), Node(b.polys)
    na.invert()
    na.clip_to(nb)
    nb.clip_to(na)
    nb.invert()
    nb.clip_to(na)
    nb.invert()
    na.build(nb.all_polys())
    na.invert()
    return Solid(na.all_polys())


def intersect(a: Solid, b: Solid) -> Solid:
    if not _overlap(a, b):
        return Solid([])
    na, nb = Node(a.polys), Node(b.polys)
    na.invert()
    nb.clip_to(na)
    nb.invert()
    na.clip_to(nb)
    nb.clip_to(na)
    na.build(nb.all_polys())
    na.invert()
    return Solid(na.all_polys())


# ---------------------------------------------------------------------------
# Regiões 2D: contornos, furos e triangulação
# ---------------------------------------------------------------------------

def _area2(loop) -> float:
    return sum(loop[i][0] * loop[(i + 1) % len(loop)][1] - loop[(i + 1) % len(loop)][0] * loop[i][1]
               for i in range(len(loop))) / 2


def _inside(p, loop) -> bool:
    x, y, inside = p[0], p[1], False
    for i in range(len(loop)):
        (x1, y1), (x2, y2) = loop[i], loop[(i + 1) % len(loop)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def _clean(loop):
    """Remove pontos repetidos e o fechamento duplicado."""
    out = []
    for p in loop:
        p = (float(p[0]), float(p[1]))
        if not out or math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > 1e-9:
            out.append(p)
    if len(out) > 1 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) <= 1e-9:
        out.pop()
    return out


def regions(loops):
    """Agrupa contornos em regiões (contorno externo + furos), pela regra par/ímpar."""
    loops = [l for l in (_clean(l) for l in loops) if len(l) >= 3 and abs(_area2(l)) > 1e-9]
    depth = [sum(1 for j, other in enumerate(loops) if j != i and _inside(l[0], other)) for i, l in enumerate(loops)]
    result = []
    for i, loop in enumerate(loops):
        if depth[i] % 2:
            continue
        outer = loop if _area2(loop) > 0 else loop[::-1]
        holes = []
        for j, h in enumerate(loops):
            if depth[j] == depth[i] + 1 and _inside(h[0], loop):
                holes.append(h if _area2(h) < 0 else h[::-1])
        result.append((outer, holes))
    return result


def _seg_cross(a, b, c, d) -> bool:
    """Os segmentos ab e cd se cruzam (sem contar pontas compartilhadas)?"""
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    if a in (c, d) or b in (c, d):
        return False
    o1, o2, o3, o4 = orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)
    return (o1 > 0) != (o2 > 0) and (o3 > 0) != (o4 > 0) and abs(o1) > 1e-12 and abs(o2) > 1e-12


def _bridge(outer, hole):
    """Liga o furo ao contorno externo por uma ponte, formando um único polígono."""
    hi = max(range(len(hole)), key=lambda k: hole[k][0])
    hp = hole[hi]
    best, best_d = None, float("inf")
    for oi, op in enumerate(outer):
        d = (op[0] - hp[0]) ** 2 + (op[1] - hp[1]) ** 2
        if d >= best_d:
            continue
        ok = True
        for ring in (outer, hole):
            for k in range(len(ring)):
                if _seg_cross(hp, op, ring[k], ring[(k + 1) % len(ring)]):
                    ok = False
                    break
            if not ok:
                break
        if ok:
            best, best_d = oi, d
    if best is None:
        best = min(range(len(outer)), key=lambda k: (outer[k][0] - hp[0]) ** 2 + (outer[k][1] - hp[1]) ** 2)
    ring = hole[hi:] + hole[:hi]
    return outer[:best + 1] + ring + [ring[0], outer[best]] + outer[best + 1:]


def triangulate(outer, holes):
    """Corte de orelhas: devolve triângulos (anti-horários) cobrindo a região."""
    poly = list(outer)
    for h in sorted(holes, key=lambda h: -max(p[0] for p in h)):
        poly = _bridge(poly, h)
    idx = list(range(len(poly)))
    tris, guard = [], 0

    def convex(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-12

    def in_tri(p, a, b, c):
        d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1])
        d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1])
        d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1])
        return not ((d1 < -1e-12 or d2 < -1e-12 or d3 < -1e-12) and (d1 > 1e-12 or d2 > 1e-12 or d3 > 1e-12))

    i = 0
    while len(idx) > 3 and guard < 20 * len(poly) * len(poly):
        guard += 1
        n = len(idx)
        ia, ib, ic = idx[(i - 1) % n], idx[i % n], idx[(i + 1) % n]
        a, b, c = poly[ia], poly[ib], poly[ic]
        if convex(a, b, c) and not any(
                in_tri(poly[k], a, b, c) for k in idx if k not in (ia, ib, ic) and poly[k] not in (a, b, c)):
            tris.append((a, b, c))
            idx.pop(i % n)
        else:
            i += 1
    if len(idx) == 3:
        a, b, c = (poly[k] for k in idx)
        if abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) > 1e-12:
            tris.append((a, b, c))
    return tris


# ---------------------------------------------------------------------------
# Planos de esboço e construção de sólidos
# ---------------------------------------------------------------------------

# (u, v, n) do esboço -> (x, y, z); n é a direção da extrusão. No plano XZ, v aponta para -Z.
PLANES = {
    "XY": lambda u, v, n, o: (u, v, n + o),
    "XZ": lambda u, v, n, o: (u, n + o, -v),
    "YZ": lambda u, v, n, o: (n + o, u, v),
}


def _volume(polys) -> float:
    vol = 0.0
    for p in polys:
        a = p.verts[0]
        for k in range(1, len(p.verts) - 1):
            vol += _dot(a, _cross(p.verts[k], p.verts[k + 1])) / 6
    return vol


def _oriented(polys) -> Solid:
    """Garante normais para fora (volume positivo)."""
    if _volume(polys) < 0:
        polys = [p.flipped() for p in polys]
    return Solid(polys)


def _poly(points) -> Poly | None:
    n = _cross(_sub(points[1], points[0]), _sub(points[2], points[0]))
    if _dot(n, n) < 1e-18:
        return None
    return Poly(list(points))


def extrude(region_list, plane: str, offset: float, z0: float, z1: float) -> Solid:
    f = PLANES[plane]
    polys = []
    for outer, holes in region_list:
        for a, b, c in triangulate(outer, holes):
            for p in (_poly([f(*a, z1, offset), f(*b, z1, offset), f(*c, z1, offset)]),
                      _poly([f(*c, z0, offset), f(*b, z0, offset), f(*a, z0, offset)])):
                if p:
                    polys.append(p)
        for ring in [outer, *holes]:
            for i in range(len(ring)):
                a, b = ring[i], ring[(i + 1) % len(ring)]
                p = _poly([f(*a, z0, offset), f(*b, z0, offset), f(*b, z1, offset), f(*a, z1, offset)])
                if p:
                    polys.append(p)
    return _oriented(polys)


def revolve(region_list, plane: str, offset: float, angle: float) -> Solid:
    """Gira as regiões em torno do eixo vertical (v) do esboço."""
    f = PLANES[plane]
    for outer, holes in region_list:
        if any(p[0] < -1e-9 for ring in [outer, *holes] for p in ring) and any(p[0] > 1e-9 for ring in [outer, *holes] for p in ring):
            raise ValueError("O perfil da revolução não pode cruzar o eixo.")
    full = angle >= 360 - 1e-9
    steps = max(3, round(CIRCLE_SEGMENTS * angle / 360))
    rad = math.radians(angle)

    def at(p, k):
        t = rad * k / steps
        r = p[0]
        return f(r * math.cos(t), p[1], r * math.sin(t), offset)

    polys = []
    for outer, holes in region_list:
        for ring in [outer, *holes]:
            for i in range(len(ring)):
                a, b = ring[i], ring[(i + 1) % len(ring)]
                for k in range(steps):
                    k2 = 0 if full and k == steps - 1 else k + 1
                    pts = [at(a, k), at(b, k), at(b, k2), at(a, k2)]
                    # No eixo (raio zero) a face vira triângulo.
                    uniq = [q for j, q in enumerate(pts) if all(_dot(_sub(q, r), _sub(q, r)) > 1e-18 for r in pts[:j])]
                    if len(uniq) >= 3:
                        p = _poly(uniq)
                        if p:
                            polys.append(p)
        if not full:
            for a, b, c in triangulate(outer, holes):
                for k, order in ((0, (c, b, a)), (steps, (a, b, c))):
                    p = _poly([at(q, k) for q in order])
                    if p:
                        polys.append(p)
    return _oriented(polys)


# ---------------------------------------------------------------------------
# Execução dos comandos
# ---------------------------------------------------------------------------

@dataclass
class Sketch:
    plane: str
    offset: float
    name: str
    loops: list = field(default_factory=list)


@dataclass
class Model:
    bodies: dict[str, Solid] = field(default_factory=dict)
    current: str | None = None
    sketch: Sketch | None = None
    features: int = 0


def _number(value, what: str, minimum: float = -MAX_SIZE_MM, maximum: float = MAX_SIZE_MM) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"Valor inválido em {what}.") from None
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise ValueError(f"Valor fora do intervalo em {what}.")
    return number


def _point(p, what: str):
    if not isinstance(p, (list, tuple)) or len(p) != 2:
        raise ValueError(f"Ponto inválido em {what}.")
    return (_number(p[0], what), _number(p[1], what))


def circle(cx: float, cy: float, diameter: float):
    r = diameter / 2
    return [(cx + r * math.cos(2 * math.pi * i / CIRCLE_SEGMENTS), cy + r * math.sin(2 * math.pi * i / CIRCLE_SEGMENTS))
            for i in range(CIRCLE_SEGMENTS)]


def _apply(model: Model, solid: Solid, operation: str, body_name: str | None) -> None:
    if operation == "new" or (operation in ("join", "intersect") and model.current is None):
        name = body_name or f"Corpo {len(model.bodies) + 1}"
        while name in model.bodies:
            name += "*"
        model.bodies[name] = solid
        model.current = name
    elif operation == "join":
        model.bodies[model.current] = union(model.bodies[model.current], solid)
    elif operation == "intersect":
        model.bodies[model.current] = intersect(model.bodies[model.current], solid)
    elif operation == "cut":
        # Como no CAD: o corte atinge todos os corpos que atravessa.
        for name in list(model.bodies):
            model.bodies[name] = subtract(model.bodies[name], solid)
    else:
        raise ValueError(f"Operação desconhecida: {operation}.")


def run(commands: list[dict]) -> Model:
    """Executa os comandos e devolve os corpos resultantes."""
    if not isinstance(commands, list) or len(commands) > MAX_COMMANDS:
        raise ValueError("O projeto tem comandos demais ou está malformado.")
    model = Model()
    for index, item in enumerate(commands, 1):
        if not isinstance(item, dict):
            raise ValueError(f"Comando {index} inválido.")
        cmd, p = item.get("command"), item.get("params") or {}
        where = f"{cmd} (comando {index})"
        if cmd == "sketch.create":
            plane = p.get("plane", "XY")
            if plane not in PLANES:
                raise ValueError(f"Plano desconhecido em {where}.")
            model.sketch = Sketch(plane, _number(p.get("offset", 0), where), str(p.get("name", "Esboço")))
        elif cmd in ("sketch.rectangle.two_point", "sketch.circle.center", "sketch.line"):
            if model.sketch is None:
                raise ValueError(f"{where} está fora de um esboço.")
            if cmd == "sketch.rectangle.two_point":
                (x0, y0), (x1, y1) = _point(p.get("p0"), where), _point(p.get("p1"), where)
                model.sketch.loops.append([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])
            elif cmd == "sketch.circle.center":
                cx, cy = _point(p.get("center"), where)
                model.sketch.loops.append(circle(cx, cy, _number(p.get("diameter"), where, 0.001)))
            else:
                points = p.get("points")
                if not isinstance(points, list) or not 3 <= len(points) <= 2000:
                    raise ValueError(f"Contorno inválido em {where}.")
                model.sketch.loops.append([_point(q, where) for q in points])
        elif cmd == "sketch.finish":
            continue
        elif cmd in ("solid.extrude", "solid.revolve"):
            sk = model.sketch
            if sk is None:
                raise ValueError(f"{where} precisa de um esboço antes.")
            region_list = regions(sk.loops)
            if not region_list:
                raise ValueError(f"O esboço {sk.name} não forma uma região fechada.")
            if cmd == "solid.extrude":
                d = _number(p.get("distance"), where, 0.001)
                z0 = -d / 2 if p.get("direction") == "symmetric" else -d if p.get("direction") == "reverse" else 0.0
                solid = extrude(region_list, sk.plane, sk.offset, z0, z0 + d)
            else:
                solid = revolve(region_list, sk.plane, sk.offset, _number(p.get("angle", 360), where, 1, 360))
            _apply(model, solid, p.get("operation", "new"), p.get("body_name"))
            model.features += 1
        elif cmd == "solid.combine":
            target, tools = p.get("target"), p.get("tools") or []
            if target not in model.bodies or any(t not in model.bodies for t in tools):
                raise ValueError(f"Corpo inexistente em {where}.")
            result, op = model.bodies[target], p.get("operation", "join")
            for t in tools:
                other = model.bodies.pop(t)
                result = intersect(result, other) if op == "intersect" else subtract(result, other) if op == "cut" else union(result, other)
            model.bodies[target] = result
            model.current = target
            model.features += 1
        else:
            raise ValueError(f"Comando desconhecido: {cmd}.")
    model.bodies = {k: v for k, v in model.bodies.items() if v.polys and _volume(v.polys) > 1e-6}
    if not model.bodies:
        raise ValueError("As cotas não formam um sólido. Confira as medidas.")
    return model


# ---------------------------------------------------------------------------
# Saída: STL e propriedades de massa
# ---------------------------------------------------------------------------

def triangles(solid: Solid):
    for p in solid.polys:
        a = p.verts[0]
        for k in range(1, len(p.verts) - 1):
            yield p.normal, a, p.verts[k], p.verts[k + 1]


def to_stl(model: Model, header: bytes = b"3DE - dimensions in mm") -> bytes:
    """Junta os corpos num STL binário."""
    out = bytearray(header.ljust(80, b"\0")[:80] + b"\0\0\0\0")
    count = 0
    for solid in model.bodies.values():
        for n, a, b, c in triangles(solid):
            out += struct.pack("<12fH", *n, *a, *b, *c, 0)
            count += 1
    out[80:84] = struct.pack("<I", count)
    return bytes(out)


def mass_properties(model: Model) -> dict:
    volume = area = 0.0
    for solid in model.bodies.values():
        volume += _volume(solid.polys)
        for _, a, b, c in triangles(solid):
            n = _cross(_sub(b, a), _sub(c, a))
            area += math.sqrt(_dot(n, n)) / 2
    return {"volume_mm3": round(volume, 3), "area_mm2": round(area, 3), "bodies": len(model.bodies)}


def bounding_box(solid: Solid):
    return solid.bounds()
