// Formatos de arquivo do 3DE (implementação própria): exportar OBJ, 3MF, STEP e DXF;
// importar OBJ (malha), DXF e SVG (contornos para o esboço).

/* ---------------------------------------------------------- malhas -> texto */
/** Triângulos de todas as malhas: [[ax,ay,az],[bx,..],[cx,..]]. */
export function trianglesOf(meshes) {
  const out = [];
  for (const { positions: P, indices: I } of meshes) {
    const count = I ? I.length : P.length / 3;
    for (let i = 0; i < count; i += 3) {
      const g = (k) => { const o = (I ? I[i + k] : i + k) * 3; return [P[o], P[o + 1], P[o + 2]]; };
      out.push([g(0), g(1), g(2)]);
    }
  }
  return out;
}
/** Vértices soldados (mesma posição = mesmo índice) e faces por índice. */
function indexed(meshes) {
  const map = new Map(), V = [], F = [];
  const id = (p) => { const k = p.map(x => x.toFixed(5)).join(' '); let i = map.get(k); if (i === undefined) { i = V.length; V.push(p); map.set(k, i); } return i; };
  for (const t of trianglesOf(meshes)) { const f = t.map(id); if (f[0] !== f[1] && f[1] !== f[2] && f[0] !== f[2]) F.push(f); }
  return { V, F };
}
const num = (x) => (Math.abs(x) < 1e-9 ? '0' : Number(x.toFixed(6)).toString());

export function toObj(groups) {
  const lines = ['# 3DE Estúdio - malha em milímetros'];
  let base = 1;
  for (const { name, meshes } of groups) {
    const { V, F } = indexed(meshes);
    lines.push(`o ${name.replace(/\s+/g, '_')}`);
    for (const v of V) lines.push(`v ${v.map(num).join(' ')}`);
    for (const f of F) lines.push(`f ${f.map(i => i + base).join(' ')}`);
    base += V.length;
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------- 3MF */
// ZIP sem compressão (método "store"), com CRC-32: o suficiente para o pacote 3MF.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function zipStore(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = typeof content === 'string' ? enc.encode(content) : content, nameB = enc.encode(name), crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true); head.setUint32(22, data.length, true); head.setUint16(26, nameB.length, true);
    parts.push(new Uint8Array(head.buffer), nameB, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nameB.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const size = central.reduce((s, p) => s + p.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'model/3mf' });
}
export function to3mf(groups) {
  const objects = groups.map(({ name, meshes }, k) => {
    const { V, F } = indexed(meshes);
    return `<object id="${k + 1}" name="${name.replace(/[<&"]/g, '')}" type="model"><mesh><vertices>${V.map(v => `<vertex x="${num(v[0])}" y="${num(v[1])}" z="${num(v[2])}"/>`).join('')}</vertices>`
      + `<triangles>${F.map(f => `<triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}"/>`).join('')}</triangles></mesh></object>`;
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="pt-BR" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">`
    + `<metadata name="Application">3DE Estúdio</metadata><resources>${objects.join('')}</resources><build>${groups.map((_, k) => `<item objectid="${k + 1}"/>`).join('')}</build></model>`;
  return zipStore([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'],
    ['3D/3dmodel.model', model],
  ]);
}

/* ------------------------------------------------------------------ STEP */
/** STEP AP214 com sólidos facetados (cada triângulo é uma face plana). */
export function toStep(groups, title = 'peca') {
  const L = [];
  let n = 0;
  const e = (s) => { n++; L.push(`#${n}=${s};`); return `#${n}`; };
  const mm = e("( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )");
  const rad = e("( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )");
  const sr = e("( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )");
  const unc = e(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),${mm},'distance_accuracy_value','')`);
  const ctx = e(`( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${mm},${rad},${sr})) REPRESENTATION_CONTEXT('3DE','3D') )`);
  const appCtx = e("APPLICATION_CONTEXT('automotive design')");
  e(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appCtx})`);
  const pctx = e(`PRODUCT_CONTEXT('',${appCtx},'mechanical')`);
  const prod = e(`PRODUCT('${title}','${title}','',(${pctx}))`);
  const pdf = e(`PRODUCT_DEFINITION_FORMATION('','',${prod})`);
  const pdc = e(`PRODUCT_DEFINITION_CONTEXT('part definition',${appCtx},'design')`);
  const pd = e(`PRODUCT_DEFINITION('design','',${pdf},${pdc})`);
  const pds = e(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);
  const origin = e("CARTESIAN_POINT('',(0.,0.,0.))"), dz = e("DIRECTION('',(0.,0.,1.))"), dx = e("DIRECTION('',(1.,0.,0.))");
  const place = e(`AXIS2_PLACEMENT_3D('',${origin},${dz},${dx})`);
  const items = [place];
  const f = (x) => { const s = Number(x.toFixed(6)).toString(); return s.includes('.') || s.includes('e') ? s.replace('e', 'E') : `${s}.`; };
  for (const { name, meshes } of groups) {
    const { V, F } = indexed(meshes), pts = V.map(v => e(`CARTESIAN_POINT('',(${v.map(f).join(',')}))`));
    const faces = F.map(t => { const loop = e(`POLY_LOOP('',(${t.map(i => pts[i]).join(',')}))`); const b = e(`FACE_OUTER_BOUND('',${loop},.T.)`); return e(`FACE('',(${b}))`); });
    const shell = e(`CLOSED_SHELL('',(${faces.join(',')}))`);
    items.push(e(`FACETED_BREP('${name.replace(/'/g, '')}',${shell})`));
  }
  const rep = e(`FACETED_BREP_SHAPE_REPRESENTATION('',(${items.join(',')}),${ctx})`);
  e(`SHAPE_DEFINITION_REPRESENTATION(${pds},${rep})`);
  const stamp = new Date().toISOString().slice(0, 19);
  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('3DE Estudio'),'2;1');\nFILE_NAME('${title}.stp','${stamp}',(''),(''),'3DE','3DE Estudio','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n${L.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

/* ------------------------------------------------------------------- DXF */
/** DXF R12 com linhas (LINE) e círculos (CIRCLE), em milímetros. */
export function toDxf({ segments = [], circles = [] }) {
  const out = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  for (const [a, b] of segments) out.push('0', 'LINE', '8', '0', '10', num(a[0]), '20', num(a[1]), '30', '0', '11', num(b[0]), '21', num(b[1]), '31', '0');
  for (const { c, r } of circles) out.push('0', 'CIRCLE', '8', '0', '10', num(c[0]), '20', num(c[1]), '30', '0', '40', num(r));
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------ importação */
export function parseObj(text) {
  const V = [], tris = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('v ')) V.push(line.slice(2).trim().split(/\s+/).slice(0, 3).map(Number));
    else if (line.startsWith('f ')) {
      const ids = line.slice(2).trim().split(/\s+/).map(t => { const i = parseInt(t.split('/')[0], 10); return i < 0 ? V.length + i : i - 1; });
      for (let k = 1; k < ids.length - 1; k++) tris.push([ids[0], ids[k], ids[k + 1]]);
    }
  }
  if (!tris.length) throw Error('O arquivo OBJ não tem faces.');
  const P = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((id, k) => { const v = V[id]; if (!v) throw Error('OBJ com índice de vértice inválido.'); P.set(v, i * 9 + k * 3); }));
  return P;
}

/** Junta segmentos soltos em cadeias (fechadas quando o fim encontra o início). */
function chain(segments, tol = 1e-3) {
  const left = segments.map(s => [...s]), out = [];
  const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;
  while (left.length) {
    const pts = [...left.shift()];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const s = left[i], end = pts.at(-1), start = pts[0];
        if (same(s[0], end)) pts.push(...s.slice(1));
        else if (same(s.at(-1), end)) pts.push(...[...s].reverse().slice(1));
        else if (same(s.at(-1), start)) pts.unshift(...s.slice(0, -1));
        else if (same(s[0], start)) pts.unshift(...[...s].reverse().slice(0, -1));
        else continue;
        left.splice(i, 1); grew = true; break;
      }
    }
    const closed = pts.length > 3 && same(pts[0], pts.at(-1));
    out.push({ pts: closed ? pts.slice(0, -1) : pts, closed });
  }
  return out;
}
const toEntities = (chains) => chains.filter(c => c.pts.length >= 2).map(c => ({ type: c.closed && c.pts.length >= 3 ? 'poly' : 'path', pts: c.pts.map(p => [Number(p[0].toFixed(4)), Number(p[1].toFixed(4))]) }));

/** DXF -> entidades de esboço (LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC). */
export function parseDxf(text) {
  const codes = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < codes.length; i += 2) pairs.push([parseInt(codes[i], 10), codes[i + 1].trim()]);
  const ents = [];
  let cur = null;
  for (const [c, v] of pairs) {
    if (c === 0) { if (cur) ents.push(cur); cur = { type: v, d: [] }; } else if (cur) cur.d.push([c, v]);
  }
  if (cur) ents.push(cur);
  const segs = [], circles = [];
  const arc = (cx, cy, r, a0, a1) => { let s = a0, e2 = a1; if (e2 <= s) e2 += 360; const n = Math.max(4, Math.ceil((e2 - s) / 7.5)); return Array.from({ length: n + 1 }, (_, k) => { const a = ((s + ((e2 - s) * k) / n) * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }); };
  let poly = null;
  for (const en of ents) {
    const g = (code) => Number(en.d.find(([c]) => c === code)?.[1]);
    if (en.type === 'LINE') segs.push([[g(10), g(20)], [g(11), g(21)]]);
    else if (en.type === 'CIRCLE') circles.push({ type: 'circle', c: [g(10), g(20)], d: 2 * g(40) });
    else if (en.type === 'ARC') segs.push(arc(g(10), g(20), g(40), g(50), g(51)));
    else if (en.type === 'LWPOLYLINE') {
      const xs = en.d.filter(([c]) => c === 10).map(([, v]) => Number(v)), ys = en.d.filter(([c]) => c === 20).map(([, v]) => Number(v));
      const pts = xs.map((x, i) => [x, ys[i]]), closed = (g(70) & 1) === 1;
      if (closed && pts.length >= 3) circles.push({ type: 'poly', pts }); else if (pts.length >= 2) segs.push(pts);
    } else if (en.type === 'POLYLINE') poly = { pts: [], closed: (g(70) & 1) === 1 };
    else if (en.type === 'VERTEX' && poly) poly.pts.push([g(10), g(20)]);
    else if (en.type === 'SEQEND' && poly) { if (poly.closed && poly.pts.length >= 3) circles.push({ type: 'poly', pts: poly.pts }); else if (poly.pts.length >= 2) segs.push(poly.pts); poly = null; }
  }
  const out = [...circles, ...toEntities(chain(segs.filter(s => s.every(p => p.every(Number.isFinite)))))];
  if (!out.length) throw Error('Não encontrei linhas, arcos ou círculos no DXF.');
  return out;
}

/** SVG -> entidades de esboço. O eixo Y do SVG aponta para baixo: é invertido. */
export function parseSvg(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw Error('Arquivo SVG inválido.');
  const out = [], segs = [], flipY = (p) => [p[0], -p[1]];
  const n = (el, a) => Number(el.getAttribute(a)) || 0;
  for (const el of doc.querySelectorAll('rect')) { const x = n(el, 'x'), y = n(el, 'y'), w = n(el, 'width'), hh = n(el, 'height'); if (w > 0 && hh > 0) out.push({ type: 'rect', p0: flipY([x, y + hh]), p1: flipY([x + w, y]) }); }
  for (const el of doc.querySelectorAll('circle')) { const r = n(el, 'r'); if (r > 0) out.push({ type: 'circle', c: flipY([n(el, 'cx'), n(el, 'cy')]), d: 2 * r }); }
  for (const el of doc.querySelectorAll('ellipse')) { const rx = n(el, 'rx'), ry = n(el, 'ry'); if (rx > 0 && ry > 0) out.push({ type: 'ellipse', c: flipY([n(el, 'cx'), n(el, 'cy')]), rx, ry, rot: 0 }); }
  for (const el of doc.querySelectorAll('line')) segs.push([flipY([n(el, 'x1'), n(el, 'y1')]), flipY([n(el, 'x2'), n(el, 'y2')])]);
  for (const el of doc.querySelectorAll('polygon, polyline')) {
    const v = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number), pts = [];
    for (let i = 0; i + 1 < v.length; i += 2) pts.push(flipY([v[i], v[i + 1]]));
    if (el.tagName.toLowerCase() === 'polygon' && pts.length >= 3) out.push({ type: 'poly', pts }); else if (pts.length >= 2) segs.push(pts);
  }
  for (const el of doc.querySelectorAll('path')) for (const sub of pathPoints(el.getAttribute('d') || '')) {
    const pts = sub.pts.map(flipY);
    if (sub.closed && pts.length >= 3) out.push({ type: 'poly', pts }); else if (pts.length >= 2) segs.push(pts);
  }
  out.push(...toEntities(chain(segs)));
  if (!out.length) throw Error('Não encontrei formas no SVG.');
  return out.map(e => roundEntity(e));
}
const r4 = (p) => [Number(p[0].toFixed(4)), Number(p[1].toFixed(4))];
function roundEntity(e) {
  if (e.pts) return { ...e, pts: e.pts.map(r4) };
  if (e.c) return { ...e, c: r4(e.c) };
  if (e.p0) return { ...e, p0: r4(e.p0), p1: r4(e.p1) };
  return e;
}
/** Caminho SVG (M L H V C S Q T Z, absolutos e relativos; arcos viram retas) em pontos. */
function pathPoints(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  const subs = [];
  let i = 0, cmd = '', cur = [0, 0], start = [0, 0], pts = null, lastCtrl = null;
  const nextNum = () => Number(tokens[i++]);
  const isNum = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]);
  const bez = (p0, p1, p2, p3) => { for (let k = 1; k <= 12; k++) { const t = k / 12, a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, e = t ** 3; pts.push([a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1]]); } };
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), base = rel ? cur : [0, 0];
    const pt = () => [base[0] + nextNum(), base[1] + nextNum()];
    if (C === 'Z') { if (pts) { subs.push({ pts, closed: true }); pts = null; } cur = start; continue; }
    if (!isNum()) { i++; continue; }
    if (C === 'M') { if (pts) subs.push({ pts, closed: false }); cur = pt(); start = cur; pts = [cur]; cmd = rel ? 'l' : 'L'; }
    else if (C === 'L') { cur = pt(); pts.push(cur); }
    else if (C === 'H') { cur = [(rel ? cur[0] : 0) + nextNum(), cur[1]]; pts.push(cur); }
    else if (C === 'V') { cur = [cur[0], (rel ? cur[1] : 0) + nextNum()]; pts.push(cur); }
    else if (C === 'C') { const p1 = pt(), p2 = pt(), p3 = pt(); bez(cur, p1, p2, p3); lastCtrl = p2; cur = p3; }
    else if (C === 'S') { const p1 = lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur, p2 = pt(), p3 = pt(); bez(cur, p1, p2, p3); lastCtrl = p2; cur = p3; }
    else if (C === 'Q' || C === 'T') { const q = C === 'Q' ? pt() : (lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur), p3 = pt(); bez(cur, [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])], [p3[0] + (2 / 3) * (q[0] - p3[0]), p3[1] + (2 / 3) * (q[1] - p3[1])], p3); lastCtrl = q; cur = p3; }
    else if (C === 'A') { for (let k = 0; k < 5; k++) nextNum(); cur = pt(); pts.push(cur); }
    else i++;
    if (!'CSQT'.includes(C)) lastCtrl = null;
  }
  if (pts) subs.push({ pts, closed: false });
  return subs.map(s => ({ pts: s.pts.filter((p, k) => k === 0 || Math.hypot(p[0] - s.pts[k - 1][0], p[1] - s.pts[k - 1][1]) > 1e-9), closed: s.closed }));
}
