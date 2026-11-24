// Núcleo geométrico do 3DE (implementação própria, mesmas regras do cad_kernel.py).
//
// - Esboços viram regiões (contornos externos + furos, regra par/ímpar).
// - Regiões são trianguladas por corte de orelhas, com pontes até os furos.
// - Extrusão e revolução constroem sólidos fechados de polígonos planos.
// - União, corte e interseção usam árvores BSP (particionamento binário do espaço).

export const CIRCLE_SEGMENTS = 64;
const EPS = 1e-6;

/* ------------------------------------------------------------------ vetores */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/* --------------------------------------------------------- polígonos e BSP */
class Poly {
  constructor(verts, normal, w) {
    this.verts = verts;
    if (!normal) {
      const n = cross(sub(verts[1], verts[0]), sub(verts[2], verts[0]));
      const len = Math.hypot(...n) || 1;
      normal = [n[0] / len, n[1] / len, n[2] / len];
      w = dot(normal, verts[0]);
    }
    this.normal = normal;
    this.w = w;
  }
  flipped() { return new Poly([...this.verts].reverse(), [-this.normal[0], -this.normal[1], -this.normal[2]], -this.w); }
}

const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;

function split(normal, w, poly, coFront, coBack, front, back) {
  const kinds = [];
  let kind = 0;
  for (const v of poly.verts) {
    const d = dot(normal, v) - w;
    const k = d < -EPS ? BACK : d > EPS ? FRONT : COPLANAR;
    kind |= k;
    kinds.push(k);
  }
  if (kind === COPLANAR) (dot(normal, poly.normal) > 0 ? coFront : coBack).push(poly);
  else if (kind === FRONT) front.push(poly);
  else if (kind === BACK) back.push(poly);
  else {
    const f = [], b = [], vs = poly.verts, n = vs.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ki = kinds[i], kj = kinds[j], vi = vs[i], vj = vs[j];
      if (ki !== BACK) f.push(vi);
      if (ki !== FRONT) b.push(vi);
      if ((ki | kj) === SPANNING) {
        const t = (w - dot(normal, vi)) / dot(normal, sub(vj, vi));
        const p = lerp(vi, vj, t);
        f.push(p); b.push(p);
      }
    }
    if (f.length >= 3) front.push(new Poly(f, poly.normal, poly.w));
    if (b.length >= 3) back.push(new Poly(b, poly.normal, poly.w));
  }
}

class Node {
  constructor(polys) {
    this.normal = null; this.w = 0; this.polys = []; this.front = null; this.back = null;
    if (polys && polys.length) this.build(polys);
  }
  // Iterativo: peças grandes estourariam a pilha de chamadas.
  build(polys) {
    const stack = [[this, polys]];
    while (stack.length) {
      const [node, items] = stack.pop();
      if (!items.length) continue;
      if (!node.normal) { node.normal = items[0].normal; node.w = items[0].w; }
      const front = [], back = [];
      for (const p of items) split(node.normal, node.w, p, node.polys, node.polys, front, back);
      if (front.length) { node.front ||= new Node(); stack.push([node.front, front]); }
      if (back.length) { node.back ||= new Node(); stack.push([node.back, back]); }
    }
  }
  nodes() {
    const out = [], stack = [this];
    while (stack.length) { const n = stack.pop(); out.push(n); if (n.front) stack.push(n.front); if (n.back) stack.push(n.back); }
    return out;
  }
  invert() {
    for (const n of this.nodes()) {
      n.polys = n.polys.map(p => p.flipped());
      if (n.normal) { n.normal = [-n.normal[0], -n.normal[1], -n.normal[2]]; n.w = -n.w; }
      [n.front, n.back] = [n.back, n.front];
    }
  }
  clipPolys(polys) {
    const result = [], stack = [[this, polys]];
    while (stack.length) {
      const [node, items] = stack.pop();
      if (!node.normal) { result.push(...items); continue; }
      const front = [], back = [];
      for (const p of items) split(node.normal, node.w, p, front, back, front, back);
      if (node.front) stack.push([node.front, front]); else result.push(...front);
      if (node.back) stack.push([node.back, back]);   // sem subárvore de trás: está dentro, descarta
    }
    return result;
  }
  clipTo(other) { for (const n of this.nodes()) n.polys = other.clipPolys(n.polys); }
  allPolys() { const out = []; for (const n of this.nodes()) out.push(...n.polys); return out; }
}

function bounds(polys) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of polys) for (const v of p.verts) for (let i = 0; i < 3; i++) { if (v[i] < min[i]) min[i] = v[i]; if (v[i] > max[i]) max[i] = v[i]; }
  return { min, max };
}
function overlap(a, b) {
  if (!a.length || !b.length) return false;
  const A = bounds(a), B = bounds(b);
  return [0, 1, 2].every(i => A.min[i] <= B.max[i] + EPS && B.min[i] <= A.max[i] + EPS);
}

export function union(a, b) {
  if (!overlap(a, b)) return [...a, ...b];
  const A = new Node(a), B = new Node(b);
  A.clipTo(B); B.clipTo(A); B.invert(); B.clipTo(A); B.invert(); A.build(B.allPolys());
  return A.allPolys();
}
export function subtract(a, b) {
  if (!overlap(a, b)) return [...a];
  const A = new Node(a), B = new Node(b);
  A.invert(); A.clipTo(B); B.clipTo(A); B.invert(); B.clipTo(A); B.invert(); A.build(B.allPolys()); A.invert();
  return A.allPolys();
}
export function intersect(a, b) {
  if (!overlap(a, b)) return [];
  const A = new Node(a), B = new Node(b);
  A.invert(); B.clipTo(A); B.invert(); A.clipTo(B); B.clipTo(A); A.build(B.allPolys()); A.invert();
  return A.allPolys();
}

/* ------------------------------------------- regiões 2D e triangulação */
const area2 = (loop) => { let s = 0; for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
function inside(p, loop) {
  let r = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [x1, y1] = loop[i], [x2, y2] = loop[j];
    if ((y1 > p[1]) !== (y2 > p[1]) && p[0] < ((x2 - x1) * (p[1] - y1)) / (y2 - y1) + x1) r = !r;
  }
  return r;
}
function clean(loop) {
  const out = [];
  for (const q of loop) { const p = [Number(q[0]), Number(q[1])]; if (!out.length || Math.hypot(p[0] - out.at(-1)[0], p[1] - out.at(-1)[1]) > 1e-9) out.push(p); }
  if (out.length > 1 && Math.hypot(out[0][0] - out.at(-1)[0], out[0][1] - out.at(-1)[1]) <= 1e-9) out.pop();
  return out;
}

/** Contornos -> regiões [{outer, holes}] (anti-horário / horário). */
export function regions(loops) {
  const ls = loops.map(clean).filter(l => l.length >= 3 && Math.abs(area2(l)) > 1e-9);
  const depth = ls.map((l, i) => ls.filter((o, j) => j !== i && inside(l[0], o)).length);
  const out = [];
  ls.forEach((loop, i) => {
    if (depth[i] % 2) return;
    const outer = area2(loop) > 0 ? loop : [...loop].reverse();
    const holes = ls.filter((h, j) => depth[j] === depth[i] + 1 && inside(h[0], loop)).map(h => (area2(h) < 0 ? h : [...h].reverse()));
    out.push({ outer, holes });
  });
  return out;
}

const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
function segCross(a, b, c, d) {
  if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false;
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0) && Math.abs(o1) > 1e-12 && Math.abs(o2) > 1e-12;
}
function bridge(outer, hole) {
  let hi = 0;
  hole.forEach((p, k) => { if (p[0] > hole[hi][0]) hi = k; });
  const hp = hole[hi];
  let best = -1, bestD = Infinity;
  outer.forEach((op, oi) => {
    const d = (op[0] - hp[0]) ** 2 + (op[1] - hp[1]) ** 2;
    if (d >= bestD) return;
    for (const ring of [outer, hole]) for (let k = 0; k < ring.length; k++) if (segCross(hp, op, ring[k], ring[(k + 1) % ring.length])) return;
    best = oi; bestD = d;
  });
  if (best < 0) outer.forEach((op, oi) => { const d = (op[0] - hp[0]) ** 2 + (op[1] - hp[1]) ** 2; if (d < bestD) { best = oi; bestD = d; } });
  const ring = [...hole.slice(hi), ...hole.slice(0, hi)];
  return [...outer.slice(0, best + 1), ...ring, ring[0], outer[best], ...outer.slice(best + 1)];
}

/** Corte de orelhas: triângulos anti-horários que cobrem a região. */
export function triangulate(outer, holes) {
  let poly = outer;
  for (const h of [...holes].sort((a, b) => Math.max(...b.map(p => p[0])) - Math.max(...a.map(p => p[0])))) poly = bridge(poly, h);
  const idx = poly.map((_, i) => i), tris = [];
  const convex = (a, b, c) => orient(a, b, c) > 1e-12;
  const inTri = (p, a, b, c) => {
    const d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
    const d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]);
    const d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
    return !((d1 < -1e-12 || d2 < -1e-12 || d3 < -1e-12) && (d1 > 1e-12 || d2 > 1e-12 || d3 > 1e-12));
  };
  let i = 0, guard = 0;
  const limit = 20 * poly.length * poly.length;
  while (idx.length > 3 && guard++ < limit) {
    const n = idx.length, ia = idx[(i - 1 + n) % n], ib = idx[i % n], ic = idx[(i + 1) % n];
    const a = poly[ia], b = poly[ib], c = poly[ic];
    if (convex(a, b, c) && !idx.some(k => k !== ia && k !== ib && k !== ic && !same(poly[k], a) && !same(poly[k], b) && !same(poly[k], c) && inTri(poly[k], a, b, c))) {
      tris.push([a, b, c]);
      idx.splice(i % n, 1);
    } else i++;
  }
  if (idx.length === 3) { const [a, b, c] = idx.map(k => poly[k]); if (Math.abs(orient(a, b, c)) > 1e-12) tris.push([a, b, c]); }
  return tris;
}

/* ------------------------------------------- planos e construção de sólidos */
// (u, v, n) do esboço -> mundo. n é a direção da extrusão. No plano Frontal (XZ), v aponta para -Z.
export const PLANES = {
  XY: { label: 'Plano Superior', toWorld: (u, v, n, o) => [u, v, n + o], normal: [0, 0, 1], displayFlip: 1 },
  XZ: { label: 'Plano Frontal', toWorld: (u, v, n, o) => [u, n + o, -v], normal: [0, 1, 0], displayFlip: -1 },
  YZ: { label: 'Plano Direito', toWorld: (u, v, n, o) => [n + o, u, v], normal: [1, 0, 0], displayFlip: 1 },
};
export function worldToSketch(plane, offset, p) {
  if (plane === 'XY') return [p[0], p[1]];
  if (plane === 'XZ') return [p[0], -p[2]];
  return [p[1], p[2]];
}

function area3(p) {
  let s = [0, 0, 0];
  const a = p.verts[0];
  for (let k = 1; k < p.verts.length - 1; k++) { const c = cross(sub(p.verts[k], a), sub(p.verts[k + 1], a)); s = [s[0] + c[0], s[1] + c[1], s[2] + c[2]]; }
  return Math.hypot(...s) / 2;
}
export function volumeOf(polys) {
  let v = 0;
  for (const p of polys) { const a = p.verts[0]; for (let k = 1; k < p.verts.length - 1; k++) v += dot(a, cross(p.verts[k], p.verts[k + 1])) / 6; }
  return v;
}
const oriented = (polys) => (volumeOf(polys) < 0 ? polys.map(p => p.flipped()) : polys);
function mkPoly(points) {
  const n = cross(sub(points[1], points[0]), sub(points[2], points[0]));
  return dot(n, n) < 1e-18 ? null : new Poly(points);
}

export function extrudeRegions(regs, plane, offset, z0, z1) {
  const f = PLANES[plane].toWorld, polys = [];
  const push = (p) => { if (p) polys.push(p); };
  for (const { outer, holes } of regs) {
    for (const [a, b, c] of triangulate(outer, holes)) {
      push(mkPoly([f(a[0], a[1], z1, offset), f(b[0], b[1], z1, offset), f(c[0], c[1], z1, offset)]));
      push(mkPoly([f(c[0], c[1], z0, offset), f(b[0], b[1], z0, offset), f(a[0], a[1], z0, offset)]));
    }
    for (const ring of [outer, ...holes]) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        push(mkPoly([f(a[0], a[1], z0, offset), f(b[0], b[1], z0, offset), f(b[0], b[1], z1, offset), f(a[0], a[1], z1, offset)]));
      }
    }
  }
  return oriented(polys);
}

export function revolveRegions(regs, plane, offset, angle) {
  const f = PLANES[plane].toWorld;
  for (const { outer, holes } of regs) {
    const us = [outer, ...holes].flat().map(p => p[0]);
    if (us.some(u => u < -1e-9) && us.some(u => u > 1e-9)) throw Error('O perfil da revolução não pode cruzar o eixo vertical do esboço.');
  }
  const full = angle >= 360 - 1e-9, steps = Math.max(3, Math.round((CIRCLE_SEGMENTS * angle) / 360)), rad = (angle * Math.PI) / 180;
  const at = (p, k) => { const t = (rad * k) / steps; return f(p[0] * Math.cos(t), p[1], p[0] * Math.sin(t), offset); };
  const polys = [];
  for (const { outer, holes } of regs) {
    for (const ring of [outer, ...holes]) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        for (let k = 0; k < steps; k++) {
          const k2 = full && k === steps - 1 ? 0 : k + 1;
          const pts = [at(a, k), at(b, k), at(b, k2), at(a, k2)];
          const uniq = pts.filter((q, j) => pts.slice(0, j).every(r => dot(sub(q, r), sub(q, r)) > 1e-18));
          if (uniq.length >= 3) { const p = mkPoly(uniq); if (p) polys.push(p); }
        }
      }
    }
    if (!full) {
      for (const [a, b, c] of triangulate(outer, holes)) {
        const p0 = mkPoly([at(c, 0), at(b, 0), at(a, 0)]), p1 = mkPoly([at(a, steps), at(b, steps), at(c, steps)]);
        if (p0) polys.push(p0);
        if (p1) polys.push(p1);
      }
    }
  }
  return oriented(polys);
}

/** Aplica uma função de ponto a todos os vértices (mover, espelhar, girar). */
function mapPolys(polys, fn, mirror = false) {
  const out = polys.map(p => new Poly(p.verts.map(fn)));
  return mirror ? out.map(p => p.flipped()) : out;
}

export function circlePoints(c, d, segments = CIRCLE_SEGMENTS) {
  const r = d / 2;
  return Array.from({ length: segments }, (_, i) => { const a = (2 * Math.PI * i) / segments; return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]; });
}

/** Arco por três pontos (início, um ponto do meio, fim) amostrado em pontos. */
export function arcPoints(p1, p2, p3, segments = 48) {
  const ax = p1[0], ay = p1[1], bx = p2[0], by = p2[1], cx = p3[0], cy = p3[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return [[...p1], [...p3]];
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy), ang = (x, y) => Math.atan2(y - uy, x - ux);
  const a1 = ang(ax, ay), a2 = ang(bx, by), a3 = ang(cx, cy);
  const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // Sentido anti-horário se o ponto do meio estiver entre o início e o fim nesse sentido.
  let sweep = norm(a3 - a1);
  if (norm(a2 - a1) > sweep) sweep -= 2 * Math.PI;
  const n = Math.max(4, Math.ceil((segments * Math.abs(sweep)) / (2 * Math.PI)));
  return Array.from({ length: n + 1 }, (_, k) => { const a = a1 + (sweep * k) / n; return [ux + r * Math.cos(a), uy + r * Math.sin(a)]; });
}

/**
 * Pontos de uma entidade do esboço: { pts, closed }.
 * Tipos: rect, rrect (arredondado), circle, ellipse, polygon, slot (rasgo), poly (fechada),
 * path (linha aberta) e arc (arco por três pontos).
 */
export function entityPoints(e, segments = CIRCLE_SEGMENTS) {
  const rot = (p, c, a) => { const s = Math.sin(a), k = Math.cos(a), x = p[0] - c[0], y = p[1] - c[1]; return [c[0] + x * k - y * s, c[1] + x * s + y * k]; };
  switch (e.type) {
    case 'rect': return { pts: [e.p0, [e.p1[0], e.p0[1]], e.p1, [e.p0[0], e.p1[1]]].map(p => [p[0], p[1]]), closed: true };
    case 'rrect': {
      const x0 = Math.min(e.p0[0], e.p1[0]), x1 = Math.max(e.p0[0], e.p1[0]), y0 = Math.min(e.p0[1], e.p1[1]), y1 = Math.max(e.p0[1], e.p1[1]);
      const r = Math.max(0, Math.min(Number(e.r) || 0, (x1 - x0) / 2 - 1e-6, (y1 - y0) / 2 - 1e-6));
      if (r < 1e-6) return entityPoints({ type: 'rect', p0: [x0, y0], p1: [x1, y1] });
      const pts = [], q = Math.max(3, Math.round(segments / 8));
      for (const [cx, cy, a0] of [[x1 - r, y0 + r, -Math.PI / 2], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, Math.PI / 2], [x0 + r, y0 + r, Math.PI]])
        for (let k = 0; k <= q; k++) { const a = a0 + (Math.PI / 2) * (k / q); pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
      return { pts, closed: true };
    }
    case 'circle': return { pts: circlePoints(e.c, e.d, segments), closed: true };
    case 'ellipse': return { pts: Array.from({ length: segments }, (_, i) => { const a = (2 * Math.PI * i) / segments; return rot([e.c[0] + e.rx * Math.cos(a), e.c[1] + e.ry * Math.sin(a)], e.c, ((Number(e.rot) || 0) * Math.PI) / 180); }), closed: true };
    case 'polygon': {
      const n = Math.max(3, Math.min(64, Math.round(Number(e.n) || 6))), R = e.inscribed === false ? e.r / Math.cos(Math.PI / n) : e.r, a0 = ((Number(e.rot) || 0) * Math.PI) / 180;
      return { pts: Array.from({ length: n }, (_, i) => { const a = a0 + (2 * Math.PI * i) / n; return [e.c[0] + R * Math.cos(a), e.c[1] + R * Math.sin(a)]; }), closed: true };
    }
    case 'slot': {
      const [x1, y1] = e.c1, [x2, y2] = e.c2, r = e.w / 2, a = Math.atan2(y2 - y1, x2 - x1), q = Math.max(6, Math.round(segments / 4)), pts = [];
      for (let k = 0; k <= q; k++) { const t = a - Math.PI / 2 + (Math.PI * k) / q; pts.push([x2 + r * Math.cos(t), y2 + r * Math.sin(t)]); }
      for (let k = 0; k <= q; k++) { const t = a + Math.PI / 2 + (Math.PI * k) / q; pts.push([x1 + r * Math.cos(t), y1 + r * Math.sin(t)]); }
      return { pts, closed: true };
    }
    case 'poly': return { pts: e.pts.map(p => [p[0], p[1]]), closed: true };
    case 'path': return { pts: e.pts.map(p => [p[0], p[1]]), closed: false };
    case 'arc': return { pts: arcPoints(e.p1, e.p2, e.p3, segments), closed: false };
    default: return { pts: [], closed: false };
  }
}

export function sketchLoops(sketch) {
  const loops = [];
  for (const e of sketch.entities) {
    if (e.construction) continue;
    const { pts, closed } = entityPoints(e);
    if (closed && pts.length >= 3 && Math.abs(area2(pts)) > 1e-9) loops.push(pts);
  }
  return loops;
}
/** Linhas abertas e arcos do esboço (caminhos de varredura, superfícies, perfis estruturais). */
export function sketchPaths(sketch) {
  const out = [];
  for (const e of sketch.entities) {
    if (e.construction) continue;
    const { pts, closed } = entityPoints(e);
    if (!closed && pts.length >= 2) out.push(pts);
  }
  return out;
}

/* ------------------------------------------- faces e arestas de um sólido */
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const TOL = 1e-4;

const planeKey = (n, w) => `${n.map(x => Math.round(x * 1e4)).join(',')}|${Math.round(w * 1e3)}`;
/** Agrupa os polígonos por plano: cada grupo é uma face plana do sólido. */
function planeGroups(polys) {
  const map = new Map();
  for (const p of polys) {
    const k = planeKey(p.normal, p.w);
    let g = map.get(k);
    if (!g) map.set(k, (g = { n: p.normal, w: p.w, key: k, polys: [] }));
    g.polys.push(p);
  }
  return [...map.values()];
}
const centroid = (p) => scale3(p.verts.reduce(add3, [0, 0, 0]), 1 / p.verts.length);
/** O ponto q (no plano de p) está dentro de p ou sobre a borda? */
function onPoly(p, q) {
  const n = p.normal.map(Math.abs), drop = n[0] > n[1] ? (n[0] > n[2] ? 0 : 2) : (n[1] > n[2] ? 1 : 2);
  const [i, j] = [0, 1, 2].filter(k => k !== drop), vs = p.verts;
  let r = false;
  for (let a = 0, b = vs.length - 1; a < vs.length; b = a++) {
    const A = vs[a], B = vs[b];
    // Sobre a borda?
    const ab = sub(B, A), t = Math.max(0, Math.min(1, dot(sub(q, A), ab) / (dot(ab, ab) || 1)));
    if (dist3(q, add3(A, scale3(ab, t))) < TOL) return true;
    if ((A[j] > q[j]) !== (B[j] > q[j]) && q[i] < ((B[i] - A[i]) * (q[j] - A[j])) / (B[j] - A[j]) + A[i]) r = !r;
  }
  return r;
}
const onPlane = (g, v) => Math.abs(dot(g.n, v) - g.w) < TOL;
const nearBox = (p, c, r) => p.verts.some(v => dist3(v, c) <= r) || (() => {
  const b = bounds([p]);
  return [0, 1, 2].every(k => c[k] >= b.min[k] - r && c[k] <= b.max[k] + r);
})();

/**
 * Arestas vivas: lados de polígonos que ficam sobre outra face plana do sólido.
 * Cada aresta traz as normais das duas faces e as direções que entram em cada face.
 * Com `center` e `radius`, só procura perto desse ponto (seleção com o mouse).
 */
function sharpEdges(polys, center = null, radius = Infinity) {
  const groups = planeGroups(polys), out = [];
  for (const g of groups) for (const p of g.polys) {
    if (center && !nearBox(p, center, radius)) continue;
    const vs = p.verts;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i], b = vs[(i + 1) % vs.length];
      if (dist3(a, b) < 1e-9) continue;
      const mid = scale3(add3(a, b), 0.5);
      if (center) {
        const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(center, a), ab) / dot(ab, ab)));
        if (dist3(center, add3(a, scale3(ab, t))) > radius) continue;
      }
      for (const q of groups) {
        if (q === g || !onPlane(q, a) || !onPlane(q, b)) continue;
        const other = q.polys.find(r => onPoly(r, mid));
        if (!other) continue;
        const e = norm3(sub(b, a));
        const dA = norm3(cross(p.normal, e));
        let dB = norm3(cross(e, q.n));
        if (dot(sub(centroid(other), mid), dB) < 0) dB = scale3(dB, -1);
        const s = dot(dA, q.n);
        if (Math.abs(s) < 1e-6) continue;
        out.push({ a, b, nA: p.normal, nB: q.n, dA, dB, convex: s < 0 });
        break;
      }
    }
  }
  return out;
}

const sameDir = (a, b) => dot(a, b) > 0.9999;
const lineDist = (p, a, e) => { const d = sub(p, a); return Math.hypot(...sub(d, scale3(e, dot(d, e)))); };
/** Junta os pedaços colineares da mesma aresta e devolve a aresta inteira. */
function chainEdge(segments, seed) {
  const e = norm3(sub(seed.b, seed.a)), o = seed.a;
  const match = segments.filter(s => ((sameDir(s.nA, seed.nA) && sameDir(s.nB, seed.nB)) || (sameDir(s.nA, seed.nB) && sameDir(s.nB, seed.nA)))
    && lineDist(s.a, o, e) < 1e-3 && lineDist(s.b, o, e) < 1e-3);
  const spans = match.map(s => { const t0 = dot(sub(s.a, o), e), t1 = dot(sub(s.b, o), e); return [Math.min(t0, t1), Math.max(t0, t1)]; }).sort((x, y) => x[0] - y[0]);
  let lo = Math.min(0, dot(sub(seed.b, o), e)), hi = Math.max(0, dot(sub(seed.b, o), e)), grew = true;
  while (grew) {
    grew = false;
    for (const [s0, s1] of spans) if (s0 <= hi + 1e-4 && s1 >= lo - 1e-4 && (s0 < lo - 1e-9 || s1 > hi + 1e-9)) { lo = Math.min(lo, s0); hi = Math.max(hi, s1); grew = true; }
  }
  return { ...seed, a: add3(o, scale3(e, lo)), b: add3(o, scale3(e, hi)) };
}

/** Prisma de seção qualquer (estrela a partir do primeiro ponto) ao longo de p0 -> p1. */
function prism(profile, p0, p1) {
  const polys = [], n = profile.length, A = profile.map(q => add3(p0, q)), B = profile.map(q => add3(p1, q));
  for (let k = 1; k < n - 1; k++) {
    const s = mkPoly([A[0], A[k + 1], A[k]]), t = mkPoly([B[0], B[k], B[k + 1]]);
    if (s) polys.push(s);
    if (t) polys.push(t);
  }
  for (let k = 0; k < n; k++) { const j = (k + 1) % n, q = mkPoly([A[k], A[j], B[j], B[k]]); if (q) polys.push(q); }
  return oriented(polys);
}

/**
 * Peça que arredonda (fillet) ou chanfra uma aresta: a região entre as duas faces e a
 * curva. Numa aresta viva (convexa) ela é retirada; numa aresta côncava, acrescentada.
 */
function edgeTool(edge, size, kind) {
  const e = norm3(sub(edge.b, edge.a)), { dA, dB } = edge;
  const phi = Math.acos(Math.max(-1, Math.min(1, dot(dA, dB)))), half = phi / 2;
  if (phi < 1e-3 || phi > Math.PI - 1e-3) throw Error('As faces desta aresta são quase paralelas.');
  const bis = norm3(add3(dA, dB)), out = scale3(bis, -size);
  let profile;
  if (kind === 'chamfer') profile = [out, scale3(dA, size), scale3(dB, size)];
  else {
    const t = size / Math.tan(half), c = scale3(bis, size / Math.sin(half));
    const T1 = scale3(dA, t), T2 = scale3(dB, t), u1 = norm3(sub(T1, c)), u2 = norm3(sub(T2, c));
    const sweep = Math.PI - phi, steps = Math.max(4, Math.ceil((24 * sweep) / Math.PI));
    const arc = [];
    for (let k = 0; k <= steps; k++) {
      const s = k / steps, w1 = Math.sin((1 - s) * sweep) / Math.sin(sweep), w2 = Math.sin(s * sweep) / Math.sin(sweep);
      arc.push(add3(c, scale3(norm3(add3(scale3(u1, w1), scale3(u2, w2))), size)));
    }
    profile = [out, ...arc];
  }
  const ext = 0.01;
  return prism(profile, add3(edge.a, scale3(e, -ext)), add3(edge.b, scale3(e, ext)));
}

/** Encontra de novo, no sólido atual, a aresta guardada no recurso. */
function findEdge(polys, stored) {
  const a = stored.a, b = stored.b, mid = scale3(add3(a, b), 0.5);
  const segs = sharpEdges(polys, mid, dist3(a, b) / 2 + 1);
  const e = norm3(sub(b, a));
  const seed = segs.find(s => ((sameDir(s.nA, stored.nA) && sameDir(s.nB, stored.nB)) || (sameDir(s.nA, stored.nB) && sameDir(s.nB, stored.nA)))
    && lineDist(s.a, a, e) < 1e-3 && lineDist(s.b, a, e) < 1e-3);
  return seed ? chainEdge(sharpEdges(polys, mid, dist3(a, b) + 50), seed) : null;
}

/** Laje: a face plana engrossada para dentro do sólido (parede da casca). */
function slab(group, boundary, t) {
  const down = scale3(group.n, -t), polys = [];
  for (const p of group.polys) {
    polys.push(new Poly(p.verts.map(v => [...v]), p.normal, p.w));
    polys.push(new Poly(p.verts.map(v => add3(v, down))).flipped());
  }
  for (const s of boundary) { const q = mkPoly([s.a, add3(s.a, down), add3(s.b, down), s.b]); if (q) polys.push(q); }
  return polys;
}
/** União equilibrada (dois a dois): mais rápida que somar um por um. */
function unionAll(list) {
  let items = list.filter(x => x.length);
  while (items.length > 1) {
    const next = [];
    for (let i = 0; i < items.length; i += 2) next.push(i + 1 < items.length ? union(items[i], items[i + 1]) : items[i]);
    items = next;
  }
  return items[0] || [];
}

/**
 * Casca: mantém só a parede de espessura t junto à superfície. As faces abertas não
 * recebem parede, então o vazio interno sai por elas.
 */
export function shellPolys(polys, t, openFaces = []) {
  const groups = planeGroups(polys);
  if (groups.length > 400) throw Error('A casca aceita peças com até 400 faces planas.');
  const edges = sharpEdges(polys), walls = [];
  const isOpen = (g) => openFaces.some(o => sameDir(o.n, g.n) && Math.abs(o.w - g.w) < 1e-3);
  for (const g of groups) {
    if (isOpen(g)) continue;
    // Os lados da laje seguem a ordem dos vértices do polígono (normal para fora).
    const boundary = edges.filter(s => sameDir(s.nA, g.n) && Math.abs(dot(g.n, s.a) - g.w) < 1e-3);
    walls.push(slab(g, boundary, t));
  }
  // Arestas côncavas: um prisma quadrado garante a parede também no canto interno.
  const seen = new Set();
  for (const s of edges) {
    if (s.convex) continue;
    const k = [s.a, s.b].map(v => v.map(x => x.toFixed(3)).join(',')).sort().join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    const u = s.dA, v = s.dB;
    walls.push(prism([scale3(add3(u, v), -t), scale3(sub(u, v), t), scale3(add3(u, v), t), scale3(sub(v, u), t)], s.a, s.b));
  }
  const result = intersect(polys, unionAll(walls));
  if (!result.length) throw Error('A espessura é grande demais para esta peça.');
  return result;
}

/** Sólidos prontos, com a base centrada em (x, y, z). */
export function primitivePolys(f) {
  const x = Number(f.x) || 0, y = Number(f.y) || 0, z = Number(f.z) || 0;
  const pos = (v) => [v[0] + x, v[1] + y, v[2] + z];
  const need = (...vals) => { if (vals.some(v => !(Number(v) > 0))) throw Error('As medidas devem ser maiores que zero.'); };
  if (f.shape === 'box') {
    need(f.w, f.d, f.h);
    return extrudeRegions(regions([[[x - f.w / 2, y - f.d / 2], [x + f.w / 2, y - f.d / 2], [x + f.w / 2, y + f.d / 2], [x - f.w / 2, y + f.d / 2]]]), 'XY', z, 0, Number(f.h));
  }
  if (f.shape === 'cylinder') { need(f.r, f.h); return extrudeRegions(regions([circlePoints([x, y], 2 * f.r)]), 'XY', z, 0, Number(f.h)); }
  if (f.shape === 'tube') {
    need(f.r, f.ri, f.h);
    if (Number(f.ri) >= Number(f.r)) throw Error('O raio interno deve ser menor que o externo.');
    return extrudeRegions(regions([circlePoints([x, y], 2 * f.r), circlePoints([x, y], 2 * f.ri)]), 'XY', z, 0, Number(f.h));
  }
  if (f.shape === 'prism') {
    need(f.r, f.h);
    return extrudeRegions(regions([entityPoints({ type: 'polygon', c: [x, y], r: Number(f.r), n: Number(f.n) || 6 }).pts]), 'XY', z, 0, Number(f.h));
  }
  if (f.shape === 'cone') {
    need(f.r, f.h);
    const r2 = Math.max(0, Number(f.r2) || 0);
    const polys = revolveRegions(regions([[[0, 0], [Number(f.r), 0], [r2, -Number(f.h)], [0, -Number(f.h)]]]), 'XZ', 0, 360);
    return mapPolys(polys, pos);
  }
  if (f.shape === 'wedge') {
    need(f.w, f.d, f.h);
    const w = Number(f.w), dd = Number(f.d), hh = Number(f.h);
    // No Plano Frontal v aponta para -Z: a rampa sobe com v negativo.
    return mapPolys(extrudeRegions(regions([[[-w / 2, 0], [w / 2, 0], [-w / 2, -hh]]]), 'XZ', 0, -dd / 2, dd / 2), pos);
  }
  // Esfera e toro: revolução de um perfil no Plano Frontal em torno do eixo Z.
  let loop;
  if (f.shape === 'sphere') {
    need(f.r);
    const n = CIRCLE_SEGMENTS / 2;
    loop = Array.from({ length: n + 1 }, (_, k) => { const a = (Math.PI * k) / n; return [f.r * Math.sin(a), -f.r * Math.cos(a)]; });
  } else if (f.shape === 'torus') {
    need(f.R, f.r);
    if (Number(f.r) >= Number(f.R)) throw Error('O raio do tubo deve ser menor que o raio do toro.');
    loop = circlePoints([Number(f.R), 0], 2 * f.r, 32);
  } else throw Error('Forma desconhecida.');
  const polys = revolveRegions(regions([loop]), 'XZ', 0, 360);
  const lift = f.shape === 'sphere' ? Number(f.r) : Number(f.r);
  return mapPolys(polys, v => pos([v[0], v[1], v[2] + lift]));
}

/** Meio-espaço (caixa enorme) do lado positivo de um plano perpendicular a um eixo. */
function halfSpace(axis, at) {
  const B = 1e5, min = [-B, -B, -B], max = [B, B, B];
  min[axis] = at;
  return extrudeRegions(regions([[[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]]]), 'XY', min[2], 0, max[2] - min[2]);
}

/** Arestas e faces sob o mouse (para a seleção no editor). */
export function edgeAt(polys, point, radius) {
  const segs = sharpEdges(polys, point, radius);
  if (!segs.length) return null;
  const dSeg = (s) => { const ab = sub(s.b, s.a), t = Math.max(0, Math.min(1, dot(sub(point, s.a), ab) / dot(ab, ab))); return dist3(point, add3(s.a, scale3(ab, t))); };
  const best = segs.reduce((m, s) => (dSeg(s) < dSeg(m) ? s : m));
  return chainEdge(sharpEdges(polys, point, radius + 1000), best);
}
export function faceAt(polys, point) {
  for (const g of planeGroups(polys)) if (Math.abs(dot(g.n, point) - g.w) < 1e-3 && g.polys.some(p => onPoly(p, point))) return { n: g.n, w: g.w };
  return null;
}

/* ------------------------------------------- recursos avançados (geometria própria) */
const sub3 = sub, dot3 = dot, cross3 = cross;
/** Referencial do plano do esboço no mundo: origem, eixos U e V do esboço e normal N. */
export function planeFrame(plane, offset = 0) {
  const f = PLANES[plane].toWorld, O = f(0, 0, 0, offset);
  return { O, U: sub3(f(1, 0, 0, offset), O), V: sub3(f(0, 1, 0, offset), O), N: sub3(f(0, 0, 1, offset), O) };
}
const toW = (fr, p) => add3(fr.O, add3(scale3(fr.U, p[0]), scale3(fr.V, p[1])));
/** Triângulos [[a,b,c], ...] -> polígonos (descarta triângulos degenerados). */
function triPolys(tris) { const out = []; for (const t of tris) { const p = mkPoly(t); if (p) out.push(p); } return out; }
function rotateAbout(v, origin, axis, ang) {
  const k = norm3(axis), p = sub3(v, origin), c = Math.cos(ang), s = Math.sin(ang);
  const r = add3(add3(scale3(p, c), scale3(cross3(k, p), s)), scale3(k, dot3(k, p) * (1 - c)));
  return add3(origin, r);
}
/** Gira u em torno de k (unitário) pelo ângulo que leva a até b (transporte paralelo). */
function transport(u, a, b) {
  const axis = cross3(a, b), s = Math.hypot(...axis), c = dot3(a, b);
  if (s < 1e-12) return u;
  return rotateAbout(u, [0, 0, 0], axis, Math.atan2(s, c));
}

/**
 * Varredura: as regiões 2D (coordenadas locais a, b) percorrem o caminho 3D.
 * O referencial segue o caminho sem torcer (transporte paralelo); nos cantos
 * a seção é esticada na direção da dobra (meia-esquadria).
 */
export function sweepPolys(regs, path, { closed = false, ref = null, caps = true } = {}) {
  const P = path.filter((p, i) => i === 0 || dist3(p, path[i - 1]) > 1e-9);
  if (closed && P.length > 2 && dist3(P[0], P.at(-1)) < 1e-9) P.pop();
  if (P.length < 2) throw Error('O caminho precisa de pelo menos dois pontos.');
  const n = P.length, segs = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) segs.push(norm3(sub3(P[(i + 1) % n], P[i])));
  const tin = (i) => (closed ? segs[(i - 1 + n) % n] : segs[Math.max(0, i - 1)]);
  const tout = (i) => (closed ? segs[i % n] : segs[Math.min(segs.length - 1, i)]);
  const T = P.map((_, i) => norm3(add3(tin(i), tout(i))));
  let U = ref ? sub3(ref, scale3(T[0], dot3(ref, T[0]))) : null;
  if (!U || Math.hypot(...U) < 1e-9) { const a = Math.abs(T[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]; U = cross3(a, T[0]); }
  U = norm3(U);
  const frames = [{ U, V: cross3(T[0], U) }];
  for (let i = 1; i < n; i++) { const u = norm3(transport(frames[i - 1].U, T[i - 1], T[i])); frames.push({ U: u, V: cross3(T[i], u) }); }
  const ring = (loop, i) => {
    const { U: u, V: v } = frames[i], a = tin(i), b = tout(i), cosT = Math.max(-1, Math.min(1, dot3(a, b)));
    const m = sub3(b, a), ml = Math.hypot(...m), k = ml > 1e-9 ? Math.min(4, 1 / Math.cos(Math.acos(cosT) / 2)) : 1, mu = ml > 1e-9 ? scale3(m, 1 / ml) : null;
    return loop.map(([x, y]) => { let o = add3(scale3(u, x), scale3(v, y)); if (mu) o = add3(o, scale3(mu, dot3(o, mu) * (k - 1))); return add3(P[i], o); });
  };
  const tris = [];
  for (const { outer, holes } of regs) {
    for (const loop of [outer, ...holes]) {
      const R = P.map((_, i) => ring(loop, i)), L = loop.length;
      for (let i = 0; i < (closed ? n : n - 1); i++) {
        const A = R[i], B = R[(i + 1) % n];
        for (let j = 0; j < L; j++) { const j2 = (j + 1) % L; tris.push([A[j], A[j2], B[j2]], [A[j], B[j2], B[j]]); }
      }
    }
    if (!closed && caps) {
      for (const [a, b, c] of triangulate(outer, holes)) {
        const [s0, s1] = [0, n - 1].map(i => ring([a, b, c], i));
        tris.push([s0[2], s0[1], s0[0]], [s1[0], s1[1], s1[2]]);
      }
    }
  }
  return caps ? oriented(triPolys(tris)) : triPolys(tris);
}

/** Reamostra um contorno fechado em n pontos igualmente espaçados. */
function resample(loop, n) {
  const L = [], pts = [...loop, loop[0]];
  let total = 0;
  for (let i = 0; i < loop.length; i++) { total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); L.push(total); }
  const out = [];
  let seg = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const t = (total * k) / n;
    while (seg < loop.length - 1 && L[seg] < t) { acc = L[seg]; seg++; }
    const a = pts[seg], b = pts[seg + 1], len = L[seg] - acc || 1, u = (t - acc) / len;
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return out;
}
/** Transição (loft) entre perfis fechados em esboços diferentes. */
export function loftPolys(sections, { caps = true } = {}) {
  if (sections.length < 2) throw Error('A transição precisa de pelo menos dois perfis.');
  const N = 72, cen = (pts) => scale3(pts.reduce(add3, [0, 0, 0]), 1 / pts.length);
  let rings = sections.map(({ loop, frame }) => ({ loop2: resample(loop, N), frame }));
  rings = rings.map(r => ({ ...r, pts: r.loop2.map(p => toW(r.frame, p)) }));
  const axis = sub3(cen(rings.at(-1).pts), cen(rings[0].pts));
  if (Math.hypot(...axis) < 1e-9) throw Error('Os perfis da transição devem estar em planos diferentes.');
  for (const r of rings) {
    let nrm = [0, 0, 0];
    for (let i = 0; i < N; i++) nrm = add3(nrm, cross3(r.pts[i], r.pts[(i + 1) % N]));
    if (dot3(nrm, axis) < 0) { r.pts.reverse(); r.loop2.reverse(); }
  }
  for (let k = 1; k < rings.length; k++) {
    const a = rings[k - 1].pts, b = rings[k].pts, ca = cen(a), cb = cen(b);
    let best = 0, bestD = Infinity;
    for (let s = 0; s < N; s++) { let d = 0; for (let j = 0; j < N; j += 3) d += dist3(sub3(a[j], ca), sub3(b[(j + s) % N], cb)); if (d < bestD) { bestD = d; best = s; } }
    rings[k].pts = [...b.slice(best), ...b.slice(0, best)];
    rings[k].loop2 = [...rings[k].loop2.slice(best), ...rings[k].loop2.slice(0, best)];
  }
  const tris = [];
  for (let k = 0; k < rings.length - 1; k++) {
    const A = rings[k].pts, B = rings[k + 1].pts;
    for (let j = 0; j < N; j++) { const j2 = (j + 1) % N; tris.push([A[j], A[j2], B[j2]], [A[j], B[j2], B[j]]); }
  }
  if (caps) {
    for (const [r, out] of [[rings[0], -1], [rings.at(-1), 1]]) {
      const ccw = area2(r.loop2) > 0 ? r.loop2 : [...r.loop2].reverse();
      for (const t of triangulate(ccw, [])) {
        let w = t.map(p => toW(r.frame, p));
        if (dot3(cross3(sub3(w[1], w[0]), sub3(w[2], w[0])), axis) * out < 0) w = [w[2], w[1], w[0]];
        tris.push(w);
      }
    }
  }
  return caps ? oriented(triPolys(tris)) : triPolys(tris);
}

/** Leva coordenadas locais (eixo da peça em z) para o eixo escolhido, sem espelhar. */
function axisMap(axis, origin) {
  const a = AXIS[axis] ?? 2;
  return (p) => { const w = [0, 0, 0]; w[a] = p[2]; w[(a + 1) % 3] = p[0]; w[(a + 2) % 3] = p[1]; return add3(w, origin); };
}
function helix(R, pitch, turns, z0 = 0) {
  const steps = Math.max(12, Math.round(48 * turns)), out = [];
  for (let k = 0; k <= steps; k++) { const t = (2 * Math.PI * turns * k) / steps; out.push([R * Math.cos(t), R * Math.sin(t), z0 + (pitch * t) / (2 * Math.PI)]); }
  return out;
}
/** Mola helicoidal de arame circular ou quadrado. */
export function coilPolys(f) {
  const R = Number(f.R), d = Number(f.d), pitch = Number(f.pitch), turns = Number(f.turns);
  if (!(R > 0 && d > 0 && pitch > 0 && turns > 0)) throw Error('Raio, arame, passo e voltas devem ser maiores que zero.');
  if (d >= 2 * R) throw Error('O arame é mais grosso que o diâmetro da mola.');
  if (pitch <= d * 1.02) throw Error('O passo deve ser maior que a espessura do arame (as espiras se tocariam).');
  if (turns > 60) throw Error('Use no máximo 60 voltas.');
  const loop = f.section === 'square' ? [[-d / 2, -d / 2], [d / 2, -d / 2], [d / 2, d / 2], [-d / 2, d / 2]] : circlePoints([0, 0], d, 16);
  const map = axisMap(f.axis || 'z', [Number(f.x) || 0, Number(f.y) || 0, Number(f.z) || 0]);
  const path = helix(R, pitch, turns, d / 2).map(map);
  return sweepPolys(regions([loop]), path, { ref: sub3(path[0], map([0, 0, d / 2])) });
}
/** Sulco helicoidal de rosca métrica (perfil em V de 60°), para cortar de um cilindro. */
export function threadPolys(f) {
  const D = Number(f.d), p = Number(f.pitch), L = Number(f.length);
  if (!(D > 0 && p > 0 && L > 0)) throw Error('Diâmetro, passo e comprimento devem ser maiores que zero.');
  if (p > D / 3) throw Error('O passo é grande demais para este diâmetro.');
  const depth = 0.6134 * p, half = 0.48 * p, turns = L / p;
  if (turns > 80) throw Error('Rosca longa demais: use no máximo 80 voltas.');
  // Perfil local: a = radial (para fora), b = ao longo da hélice; o V aponta para dentro.
  const tri = [[0.4, -half], [0.4, half], [-depth, 0]];
  const map = axisMap(f.axis || 'z', [Number(f.x) || 0, Number(f.y) || 0, Number(f.z) || 0]);
  const path = helix(D / 2, p, turns, 0).map(map);
  return sweepPolys(regions([tri]), path, { ref: sub3(path[0], map([0, 0, 0])) });
}

/** Desloca uma face plana: d > 0 acrescenta material, d < 0 retira. */
function offsetFace(polys, face, d) {
  const g = planeGroups(polys).find(q => sameDir(q.n, face.n) && Math.abs(q.w - face.w) < 1e-3);
  if (!g) throw Error('A face escolhida não existe mais. Edite o recurso e escolha de novo.');
  const e = 1e-3, prisms = g.polys.map(p => {
    const base = p.verts.map(v => add3(v, scale3(g.n, d > 0 ? -e : e))), top = p.verts.map(v => add3(v, scale3(g.n, d)));
    const tris = [];
    for (let k = 1; k < base.length - 1; k++) tris.push([base[0], base[k], base[k + 1]], [top[0], top[k + 1], top[k]]);
    for (let k = 0; k < base.length; k++) { const j = (k + 1) % base.length; tris.push([base[k], top[k], top[j]], [base[k], top[j], base[j]]); }
    return oriented(triPolys(tris));
  });
  const tool = unionAll(prisms);
  return d > 0 ? union(polys, tool) : subtract(polys, tool);
}

/* ---- Superfícies (cascas abertas, sem volume) ---- */
function weld(polys) {
  const keys = new Map(), V = [], F = [];
  const id = (v) => { const k = v.map(x => x.toFixed(4)).join(','); let i = keys.get(k); if (i === undefined) { i = V.length; V.push(v); keys.set(k, i); } return i; };
  for (const p of polys) { const ids = p.verts.map(id); for (let k = 1; k < ids.length - 1; k++) F.push([ids[0], ids[k], ids[k + 1]]); }
  return { V, F };
}
function vertexNormals(V, F) {
  const N = V.map(() => [0, 0, 0]);
  for (const [a, b, c] of F) { const n = cross3(sub3(V[b], V[a]), sub3(V[c], V[a])); for (const i of [a, b, c]) N[i] = add3(N[i], n); }
  return N.map(norm3);
}
/** Superfície deslocada pela normal de cada vértice. */
export function offsetSurface(polys, d) {
  const { V, F } = weld(polys), N = vertexNormals(V, F), W = V.map((v, i) => add3(v, scale3(N[i], d)));
  return triPolys(F.map(f => f.map(i => W[i])));
}
/** Espessar: a superfície vira um sólido de espessura t (para dentro, contra a normal). */
export function thickenSurface(polys, t) {
  if (!(t > 0)) throw Error('A espessura deve ser maior que zero.');
  const { V, F } = weld(polys), N = vertexNormals(V, F), W = V.map((v, i) => add3(v, scale3(N[i], -t)));
  const tris = [], count = new Map();
  for (const [a, b, c] of F) {
    tris.push([V[a], V[b], V[c]], [W[c], W[b], W[a]]);
    for (const [i, j] of [[a, b], [b, c], [c, a]]) { const k = i < j ? `${i}|${j}` : `${j}|${i}`; count.set(k, (count.get(k) || 0) + 1); }
  }
  for (const [a, b, c] of F) for (const [i, j] of [[a, b], [b, c], [c, a]]) {
    if (count.get(i < j ? `${i}|${j}` : `${j}|${i}`) !== 1) continue;
    tris.push([W[i], W[j], V[j]], [W[i], V[j], V[i]]);
  }
  return oriented(triPolys(tris));
}
function surfaceFromSketch(sk, kind, f) {
  const fr = planeFrame(sk.plane, Number(sk.offset) || 0);
  const curves = [...sketchLoops(sk).map(l => ({ pts: l, closed: true })), ...sketchPaths(sk).map(p => ({ pts: p, closed: false }))];
  if (!curves.length) throw Error(`O esboço ${sk.name} não tem linhas.`);
  const tris = [];
  if (kind === 'extrude') {
    const d = Number(f.distance);
    if (!(d > 0)) throw Error('A distância deve ser maior que zero.');
    const z0 = f.direction === 'symmetric' ? -d / 2 : f.direction === 'reverse' ? -d : 0, at = (p, z) => add3(toW(fr, p), scale3(fr.N, z));
    for (const { pts, closed } of curves) for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      tris.push([at(a, z0), at(b, z0), at(b, z0 + d)], [at(a, z0), at(b, z0 + d), at(a, z0 + d)]);
    }
  } else if (kind === 'revolve') {
    const ang = (Math.min(360, Math.max(1, Number(f.angle) || 360)) * Math.PI) / 180, full = ang >= 2 * Math.PI - 1e-9;
    const steps = Math.max(3, Math.round((CIRCLE_SEGMENTS * ang) / (2 * Math.PI)));
    const axisO = fr.O, axisD = fr.V, at = (p, k) => rotateAbout(toW(fr, p), axisO, axisD, (ang * k) / steps);
    for (const { pts, closed } of curves) for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      for (let k = 0; k < steps; k++) { const k2 = full && k === steps - 1 ? 0 : k + 1; tris.push([at(a, k), at(b, k), at(b, k2)], [at(a, k), at(b, k2), at(a, k2)]); }
    }
  } else if (kind === 'patch') {
    const regs = regions(sketchLoops(sk));
    if (!regs.length) throw Error('O remendo precisa de um contorno fechado.');
    for (const { outer, holes } of regs) for (const t of triangulate(outer, holes)) tris.push(t.map(p => toW(fr, p)));
  }
  return triPolys(tris);
}

/* ----------------------------------------------------------- reconstrução */
const AXIS = { x: 0, y: 1, z: 2 };

/**
 * Recalcula a peça a partir da lista de recursos.
 * Devolve { bodies: [{name, positions, indices, normals}], errors: {id: mensagem} }.
 */
export function rebuild(features, opts = {}) {
  const bodies = new Map(), errors = {}, surfaces = new Map();
  const info = { joints: [] };
  let current = null;
  const sketches = new Map(features.filter(f => f.type === 'sketch').map(f => [f.id, f]));
  const sketchOf = (id) => {
    const sk = sketches.get(id);
    if (!sk) throw Error('Esboço não encontrado.');
    return sk;
  };

  const apply = (polys, op, bodyName) => {
    if (op === 'new' || (current === null && op !== 'cut')) {
      let name = bodyName || `Corpo ${bodies.size + 1}`;
      while (bodies.has(name)) name += '*';
      bodies.set(name, polys); current = name;
      return name;
    }
    if (op === 'join') bodies.set(current, union(bodies.get(current), polys));
    else if (op === 'intersect') bodies.set(current, intersect(bodies.get(current), polys));
    else if (op === 'cut') for (const [n, b] of bodies) bodies.set(n, subtract(b, polys));
    return current;
  };
  const newSurface = (polys, name) => { let n = name; while (surfaces.has(n)) n += '*'; surfaces.set(n, polys); return n; };
  const pathOf = (sk) => {
    const fr = planeFrame(sk.plane, Number(sk.offset) || 0), open = sketchPaths(sk);
    if (open.length) return { pts: open[0].map(p => toW(fr, p)), closed: false };
    const loops = sketchLoops(sk);
    if (loops.length) return { pts: loops[0].map(p => toW(fr, p)), closed: true };
    throw Error(`O esboço ${sk.name} não tem um caminho (linha aberta, arco ou contorno).`);
  };

  for (const f of features) {
    if (f.suppressed) continue;
    try {
      if (f.type === 'extrude' || f.type === 'revolve' || f.type === 'hole') {
        const sk = sketchOf(f.sketch);
        if (sk.suppressed) continue;
        const regs = regions(sketchLoops(sk));
        if (!regs.length) throw Error(`O esboço ${sk.name} não tem contornos fechados.`);
        let polys;
        if (f.type === 'revolve') polys = revolveRegions(regs, sk.plane, Number(sk.offset) || 0, Math.min(360, Math.max(1, Number(f.angle) || 360)));
        else {
          // Furo passante: atravessa tudo nos dois sentidos; furo cego vai até a profundidade.
          const blind = f.type === 'hole' && f.depth_mode === 'blind';
          const d = f.type === 'hole' ? (blind ? Number(f.depth) : 20000) : Number(f.distance);
          if (!(d > 0)) throw Error('A profundidade deve ser maior que zero.');
          const z0 = f.type === 'hole' && !blind ? -d / 2 : blind ? (f.direction === 'reverse' ? 0 : -d) : f.direction === 'symmetric' ? -d / 2 : f.direction === 'reverse' ? -d : 0;
          polys = extrudeRegions(regs, sk.plane, Number(sk.offset) || 0, z0, z0 + d);
        }
        apply(polys, f.type === 'hole' ? 'cut' : f.operation || 'new', f.body_name);
      } else if (f.type === 'sweep' || f.type === 'pipe') {
        const path = pathOf(sketchOf(f.path));
        let regs, ref;
        if (f.type === 'pipe') {
          const d = Number(f.d), di = Number(f.di) || 0;
          if (!(d > 0) || di >= d) throw Error('O diâmetro externo deve ser maior que o interno.');
          regs = regions(di > 0 ? [circlePoints([0, 0], d, 32), circlePoints([0, 0], di, 32)] : [circlePoints([0, 0], d, 32)]);
        } else {
          const sk = sketchOf(f.profile), fr = planeFrame(sk.plane, Number(sk.offset) || 0);
          if (f.profile === f.path) throw Error('O perfil e o caminho devem estar em esboços diferentes.');
          // Coordenadas do perfil num referencial perpendicular ao início do caminho.
          const T0 = norm3(sub3(path.pts[1], path.pts[0]));
          let U0 = sub3(fr.U, scale3(T0, dot3(fr.U, T0)));
          if (Math.hypot(...U0) < 1e-6) U0 = sub3(fr.V, scale3(T0, dot3(fr.V, T0)));
          U0 = norm3(U0); const V0 = cross3(T0, U0);
          const loops = sketchLoops(sk).map(l => l.map(p => { const q = sub3(toW(fr, p), path.pts[0]); return [dot3(q, U0), dot3(q, V0)]; }));
          regs = regions(loops); ref = U0;
          if (!regs.length) throw Error(`O perfil ${sk.name} não tem contornos fechados.`);
        }
        apply(sweepPolys(regs, path.pts, { closed: path.closed, ref }), f.operation || 'new');
      } else if (f.type === 'loft') {
        const sections = (f.sketches || []).map(id => {
          const sk = sketchOf(id), regs = regions(sketchLoops(sk));
          if (!regs.length) throw Error(`O esboço ${sk.name} não tem contorno fechado.`);
          return { loop: regs[0].outer, frame: planeFrame(sk.plane, Number(sk.offset) || 0) };
        });
        apply(loftPolys(sections), f.operation || 'new');
      } else if (f.type === 'coil') {
        apply(coilPolys(f), f.operation || 'new');
      } else if (f.type === 'thread') {
        if (!bodies.size) throw Error('Crie o cilindro antes da rosca.');
        const groove = threadPolys(f);
        for (const [n, b] of bodies) bodies.set(n, subtract(b, groove));
      } else if (f.type === 'offset_face' || f.type === 'press_face') {
        const d = Number(f.distance);
        if (!d) throw Error('A distância não pode ser zero.');
        const name = bodies.has(f.body) ? f.body : current;
        if (!name) throw Error('Não há corpo para deslocar a face.');
        if (!f.face) throw Error('Escolha uma face.');
        bodies.set(name, offsetFace(bodies.get(name), f.face, d));
      } else if (f.type === 'remove') {
        if (bodies.has(f.body)) bodies.delete(f.body); else if (surfaces.has(f.body)) surfaces.delete(f.body);
        else throw Error('Corpo não encontrado.');
        if (current === f.body) current = [...bodies.keys()].at(-1) ?? null;
      } else if (f.type === 'bounding') {
        if (!bodies.size) throw Error('Não há corpos para envolver.');
        const b = bounds([...bodies.values()].flat()), m = Number(f.margin) || 0;
        const lo = b.min.map(v => v - m), hi = b.max.map(v => v + m);
        apply(extrudeRegions(regions([[[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]]]), 'XY', lo[2], 0, hi[2] - lo[2]), 'new', f.name);
      } else if (f.type === 'cpattern') {
        if (!bodies.size) throw Error('Não há corpos para esta operação.');
        const ax = AXIS[f.axis] ?? 2, axisV = [0, 0, 0], origin = [0, 0, 0];
        axisV[ax] = 1; origin[(ax + 1) % 3] = Number(f.c1) || 0; origin[(ax + 2) % 3] = Number(f.c2) || 0;
        const count = Math.max(1, Math.min(72, Math.round(Number(f.count) || 1))), total = Math.min(360, Math.max(1, Number(f.angle) || 360));
        const stepA = ((total >= 360 - 1e-9 ? 360 / count : total / Math.max(1, count - 1)) * Math.PI) / 180;
        for (const [name, polys] of [...bodies]) {
          if (f.body && f.body !== '*' && f.body !== name) continue;
          const copies = [polys];
          for (let k = 1; k < count; k++) copies.push(mapPolys(polys, v => rotateAbout(v, origin, axisV, stepA * k)));
          bodies.set(name, unionAll(copies));
        }
      } else if (f.type === 'surf_extrude' || f.type === 'surf_revolve' || f.type === 'patch') {
        const sk = sketchOf(f.sketch);
        newSurface(surfaceFromSketch(sk, { surf_extrude: 'extrude', surf_revolve: 'revolve', patch: 'patch' }[f.type], f), f.name);
      } else if (f.type === 'surf_loft') {
        const sections = (f.sketches || []).map(id => {
          const sk = sketchOf(id), loops = [...sketchLoops(sk)];
          if (!loops.length) throw Error(`O esboço ${sk.name} não tem contorno fechado.`);
          return { loop: loops[0], frame: planeFrame(sk.plane, Number(sk.offset) || 0) };
        });
        newSurface(loftPolys(sections, { caps: false }), f.name);
      } else if (f.type === 'surf_offset') {
        if (!surfaces.has(f.surface)) throw Error('Superfície não encontrada.');
        newSurface(offsetSurface(surfaces.get(f.surface), Number(f.distance) || 0), f.name);
      } else if (f.type === 'reverse_normal') {
        if (!surfaces.has(f.surface)) throw Error('Superfície não encontrada.');
        surfaces.set(f.surface, surfaces.get(f.surface).map(p => p.flipped()));
      } else if (f.type === 'thicken') {
        if (!surfaces.has(f.surface)) throw Error('Superfície não encontrada.');
        const solid = thickenSurface(surfaces.get(f.surface), Number(f.thickness));
        surfaces.delete(f.surface);
        apply(solid, f.operation || 'new');
      } else if (f.type === 'insert_design') {
        if ((opts.depth || 0) > 3) throw Error('Projetos inseridos demais um dentro do outro.');
        const sub = rebuild((f.design?.features || []).filter(x => x.type !== 'import'), { depth: (opts.depth || 0) + 1 });
        const t = [Number(f.dx) || 0, Number(f.dy) || 0, Number(f.dz) || 0], rz = ((Number(f.rz) || 0) * Math.PI) / 180;
        for (const b of sub.bodies) {
          let name = `${f.name}: ${b.name}`;
          while (bodies.has(name)) name += '*';
          bodies.set(name, mapPolys(b.polys, v => add3(rotateAbout(v, [0, 0, 0], [0, 0, 1], rz), t)));
        }
      } else if (f.type === 'joint') {
        const name = f.body;
        if (!bodies.has(name)) throw Error('Corpo da junta não encontrado.');
        const ax = [0, 0, 0]; ax[AXIS[f.axis] ?? 2] = 1;
        const o = [Number(f.ox) || 0, Number(f.oy) || 0, Number(f.oz) || 0], v = Number(f.value) || 0;
        info.joints.push({ id: f.id, name: f.name, body: name, kind: f.kind, axis: ax, origin: o, value: v, min: Number(f.min), max: Number(f.max) });
        if (f.kind === 'revolute') bodies.set(name, mapPolys(bodies.get(name), p => rotateAbout(p, o, ax, (v * Math.PI) / 180)));
        else if (f.kind === 'slider') bodies.set(name, mapPolys(bodies.get(name), p => add3(p, scale3(ax, v))));
      } else if (f.type === 'combine') {
        if (!bodies.has(f.target) || f.tools.some(t => !bodies.has(t))) throw Error('Corpo não encontrado para combinar.');
        let r = bodies.get(f.target);
        for (const t of f.tools) {
          const o = bodies.get(t);
          r = f.operation === 'intersect' ? intersect(r, o) : f.operation === 'cut' ? subtract(r, o) : union(r, o);
          bodies.delete(t);
        }
        bodies.set(f.target, r); current = f.target;
      } else if (f.type === 'move' || f.type === 'mirror' || f.type === 'pattern') {
        if (!bodies.size) throw Error('Não há corpos para esta operação.');
        for (const [name, polys] of [...bodies]) {
          if (f.type === 'move') {
            const t = [Number(f.dx) || 0, Number(f.dy) || 0, Number(f.dz) || 0];
            const moved = mapPolys(polys, v => [v[0] + t[0], v[1] + t[1], v[2] + t[2]]);
            if (f.copy) bodies.set(`${name} (cópia)`, moved); else bodies.set(name, moved);
          } else if (f.type === 'mirror') {
            const ax = AXIS[f.axis] ?? 0, c = Number(f.at) || 0;
            const m = mapPolys(polys, v => { const w = [...v]; w[ax] = 2 * c - w[ax]; return w; }, true);
            bodies.set(name, union(polys, m));
          } else {
            const count = Math.max(1, Math.min(50, Math.round(Number(f.count) || 1)));
            const step = [Number(f.dx) || 0, Number(f.dy) || 0, Number(f.dz) || 0];
            let acc = polys;
            for (let k = 1; k < count; k++) acc = union(acc, mapPolys(polys, v => [v[0] + step[0] * k, v[1] + step[1] * k, v[2] + step[2] * k]));
            bodies.set(name, acc);
          }
        }
      } else if (f.type === 'primitive') {
        apply(primitivePolys(f), f.operation || 'new');
      } else if (f.type === 'fillet' || f.type === 'chamfer') {
        const size = Number(f.size);
        if (!(size > 0)) throw Error('O tamanho deve ser maior que zero.');
        if (!f.edges?.length) throw Error('Selecione pelo menos uma aresta.');
        for (const stored of f.edges) {
          let done = false;
          for (const [name, polys] of bodies) {
            const edge = findEdge(polys, stored);
            if (!edge) continue;
            const tool = edgeTool(edge, size, f.type);
            bodies.set(name, edge.convex ? subtract(polys, tool) : union(polys, tool));
            done = true;
            break;
          }
          if (!done) throw Error('Uma aresta selecionada não existe mais. Edite o recurso e escolha de novo.');
        }
      } else if (f.type === 'shell') {
        const t = Number(f.thickness);
        if (!(t > 0)) throw Error('A espessura deve ser maior que zero.');
        const name = bodies.has(f.body) ? f.body : current;
        if (!name || !bodies.has(name)) throw Error('Não há corpo para a casca.');
        bodies.set(name, shellPolys(bodies.get(name), t, f.openFaces || []));
      } else if (f.type === 'split') {
        const ax = AXIS[f.axis] ?? 2, at = Number(f.at) || 0, H = halfSpace(ax, at);
        let any = false;
        for (const [name, polys] of [...bodies]) {
          const upper = intersect(polys, H), lower = subtract(polys, H);
          if (volumeOf(upper) > 1e-6 && volumeOf(lower) > 1e-6) { bodies.set(name, lower); bodies.set(`${name} (parte 2)`, upper); any = true; }
        }
        if (!any) throw Error('O plano de divisão não atravessa nenhum corpo.');
      } else if (f.type === 'scale') {
        const k = Number(f.factor);
        if (!(k > 0)) throw Error('O fator de escala deve ser maior que zero.');
        for (const [name, polys] of [...bodies]) {
          const b = bounds(polys), c = f.about === 'center' ? scale3(add3(b.min, b.max), 0.5) : [0, 0, 0];
          bodies.set(name, mapPolys(polys, v => add3(c, scale3(sub(v, c), k))));
        }
      }
    } catch (error) {
      errors[f.id] = error.message || String(error);
    }
  }
  const list = [];
  // `polys` fica junto da malha: o editor usa para escolher arestas e faces e medir interferências.
  for (const [name, polys] of bodies) if (polys.length && volumeOf(polys) > 1e-6) list.push({ name, polys, ...meshOf(polys) });
  const surfs = [];
  for (const [name, polys] of surfaces) if (polys.length) surfs.push({ name, polys, surface: true, ...meshOf(polys) });
  return { bodies: list, surfaces: surfs, errors, info };
}

/** Polígonos -> malha indexada (vértices soldados) com normais por face. */
export function meshOf(polys, crease = 30) {
  const positions = [], normals = [], indices = [];
  const map = new Map();
  const pkey = (v) => `${v[0].toFixed(4)},${v[1].toFixed(4)},${v[2].toFixed(4)}`;
  // Normais suaves: em cada vértice, média das faces vizinhas que formam ângulo menor que
  // `crease` com a face. Superfícies curvas ficam lisas; quinas vivas continuam vivas.
  const around = new Map();
  for (const p of polys) {
    const a = area3(p);
    for (const v of p.verts) { const k = pkey(v); let l = around.get(k); if (!l) around.set(k, (l = [])); l.push([p.normal, a]); }
  }
  const cosC = Math.cos((crease * Math.PI) / 180);
  const smooth = (v, n) => {
    let s = [0, 0, 0];
    for (const [m, a] of around.get(pkey(v)) || []) if (dot(m, n) >= cosC) s = [s[0] + m[0] * a, s[1] + m[1] * a, s[2] + m[2] * a];
    const l = Math.hypot(...s);
    return l > 1e-12 ? [s[0] / l, s[1] / l, s[2] / l] : n;
  };
  const vertex = (v, n) => {
    const k = `${pkey(v)}|${n[0].toFixed(3)},${n[1].toFixed(3)},${n[2].toFixed(3)}`;
    let i = map.get(k);
    if (i === undefined) { i = positions.length / 3; positions.push(v[0], v[1], v[2]); normals.push(n[0], n[1], n[2]); map.set(k, i); }
    return i;
  };
  for (const p of polys) {
    const ids = p.verts.map(v => vertex(v, crease > 0 ? smooth(v, p.normal) : p.normal));
    for (let k = 1; k < ids.length - 1; k++) indices.push(ids[0], ids[k], ids[k + 1]);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

/* ---------------------------------- roteiros do leitor de desenhos -> recursos */
export function commandsToFeatures(commands, newId) {
  const features = [];
  let sketch = null;
  const names = { new: 'Extrusão', join: 'Extrusão', cut: 'Corte', intersect: 'Interseção' };
  for (const item of commands) {
    const p = item.params || {};
    switch (item.command) {
      case 'sketch.create':
        sketch = { id: newId(), type: 'sketch', name: p.name || 'Esboço', plane: p.plane || 'XY', offset: Number(p.offset) || 0, entities: [] };
        features.push(sketch);
        break;
      case 'sketch.rectangle.two_point': sketch.entities.push({ type: 'rect', p0: [...p.p0], p1: [...p.p1] }); break;
      case 'sketch.circle.center': sketch.entities.push({ type: 'circle', c: [...p.center], d: Number(p.diameter) }); break;
      case 'sketch.line': sketch.entities.push({ type: 'poly', pts: p.points.map(q => [...q]) }); break;
      case 'solid.extrude':
      case 'solid.revolve': {
        const op = p.operation || 'new';
        const f = { id: newId(), type: item.command === 'solid.extrude' ? 'extrude' : 'revolve', name: p.name ? `${names[op]}: ${p.name}` : names[op],
          sketch: sketch.id, operation: op, distance: Number(p.distance) || 10, direction: p.direction || 'normal', angle: Number(p.angle) || 360 };
        if (p.body_name) f.body_name = p.body_name;
        sketch.name = `Esboço: ${p.name || sketch.name}`;
        features.push(f);
        break;
      }
      case 'solid.combine':
        features.push({ id: newId(), type: 'combine', name: 'Combinar corpos', target: p.target, tools: [...(p.tools || [])], operation: p.operation || 'join' });
        break;
      default: break;
    }
  }
  return features;
}
