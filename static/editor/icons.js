// Ícones do 3DE em estilo cartoon (desenhos próprios): contorno escuro grosso, cores
// chapadas e um brilho branco. Sólidos são azuis em três tons (topo, esquerda, direita),
// ações em laranja, esboço em verde, superfícies em lilás e análise em amarelo.

const INK = '#1b2433';
const C = {
  top: '#c4e0ff', left: '#62a6ff', right: '#2c6fdc',
  org: '#ff8a3d', orgL: '#ffc58f', yel: '#ffd23f', grn: '#3fcf8e', grnL: '#b8f2d6', red: '#ff5d5d', redL: '#ffb3b3',
  paper: '#ffffff', grey: '#cfd7e3', greyD: '#7d889a', lil: '#b59bff', lilL: '#e2d8ff', cyan: '#46d2e6', brown: '#c98b4f',
};
const svg = (body) => `<svg viewBox="0 0 32 32" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
const shine = (d) => `<path d="${d}" stroke="#fff" stroke-width="1.4" opacity=".85"/>`;

/** Cubo isométrico: (x, y) é o vértice de cima, s a meia largura, h a altura. */
function cube(x, y, s, h, tones = [C.top, C.left, C.right]) {
  const T = [x, y], R = [x + s, y + s / 2], B = [x, y + s], L = [x - s, y + s / 2];
  const P = (...pts) => pts.map(p => p.join(',')).join(' ');
  const d = (p) => [p[0], p[1] + h];
  return `<polygon points="${P(L, B, d(B), d(L))}" fill="${tones[1]}"/><polygon points="${P(B, R, d(R), d(B))}" fill="${tones[2]}"/>`
    + `<polygon points="${P(T, R, B, L)}" fill="${tones[0]}"/>${shine(`M${L[0] + 2} ${L[1]}L${T[0]} ${T[1] + 1.2}`)}`;
}
/** Cilindro vertical: centro do topo (cx, cy), raio rx, altura h. */
function cyl(cx, cy, rx, h, tones = [C.top, C.left]) {
  const ry = rx * 0.42;
  return `<path d="M${cx - rx} ${cy}v${h}a${rx} ${ry} 0 0 0 ${2 * rx} 0v-${h}" fill="${tones[1]}"/>`
    + `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${tones[0]}"/>${shine(`M${cx - rx + 1.6} ${cy + 2}v${Math.max(0, h - 3)}`)}`;
}
/** Seta grossa de (x1, y1) para (x2, y2). */
function arrow(x1, y1, x2, y2, fill = C.org, w = 2.6) {
  const a = Math.atan2(y2 - y1, x2 - x1), c = Math.cos(a), s = Math.sin(a), hl = 6, hw = 4.6;
  const bx = x2 - c * hl, by = y2 - s * hl, n = [-s, c];
  const p = [[x1 + n[0] * w / 2, y1 + n[1] * w / 2], [bx + n[0] * w / 2, by + n[1] * w / 2], [bx + n[0] * hw, by + n[1] * hw], [x2, y2],
    [bx - n[0] * hw, by - n[1] * hw], [bx - n[0] * w / 2, by - n[1] * w / 2], [x1 - n[0] * w / 2, y1 - n[1] * w / 2]];
  return `<polygon points="${p.map(q => q.map(v => v.toFixed(2)).join(',')).join(' ')}" fill="${fill}"/>`;
}
const dot = (x, y, r = 2, fill = C.org) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;
const sheet = (body = '') => `<path d="M7 3h13l6 6v20H7z" fill="${C.paper}"/><path d="M20 3v6h6" fill="${C.grey}"/>${body}`;
const label = (t, x = 16.5, fill = C.org) => `<rect x="4" y="17" width="25" height="10" rx="2.5" fill="${fill}"/><text x="${x}" y="25" font-size="8" font-weight="800" text-anchor="middle" fill="#fff" stroke="none" font-family="Segoe UI, Arial, sans-serif">${t}</text>`;
const plane = (fill = C.yel) => `<path d="M3 21 10 11h19l-7 10z" fill="${fill}" opacity=".95"/>`;

export const ICON = {
  // Aplicativo
  help: svg(`<circle cx="16" cy="16" r="12.5" fill="${C.left}"/><path d="M12.4 12.6a3.8 3.8 0 1 1 5.3 3.4c-1.1.5-1.7 1.3-1.7 2.5v.6" stroke="#fff" stroke-width="2.6"/><circle cx="16" cy="23" r="1.4" fill="#fff" stroke="none"/>`),
  home: svg(`<path d="M5 15 16 5l11 10" fill="${C.org}"/><path d="M8 13.5V27h16V13.5L16 6.5z" fill="${C.paper}"/><path d="M13 27v-7h6v7" fill="${C.left}"/>`),
  gear: svg(`<path d="M16 3l2.3 3.2 3.9-.9.9 3.9 3.6 1.7-1.7 3.6L27 16l-2 2.5 1.7 3.6-3.6 1.7-.9 3.9-3.9-.9L16 29l-2.3-3.2-3.9.9-.9-3.9-3.6-1.7 1.7-3.6L5 16l2-2.5-1.7-3.6 3.6-1.7.9-3.9 3.9.9z" fill="${C.grey}"/><circle cx="16" cy="16" r="4.5" fill="${C.org}"/>`),
  search: svg(`<circle cx="13.5" cy="13.5" r="8.5" fill="${C.top}"/>${shine('M9 11a5 5 0 0 1 4-3.5')}<path d="M20 20l7.5 7.5" stroke-width="4"/>`),
  folder: svg(`<path d="M3 9h10l2.5 3H29v15H3z" fill="${C.yel}"/><path d="M3 14h26" />`),
  folderTree: svg(`<path d="M3 9h10l2.5 3H29v15H3z" fill="${C.yel}"/>`),
  download: svg(`${arrow(16, 4, 16, 21, C.grn, 4)}<path d="M5 24v4h22v-4" stroke-width="2.4"/>`),
  save: svg(`<path d="M5 4h18l4 4v20H5z" fill="${C.left}"/><rect x="9" y="4" width="12" height="8" fill="${C.paper}"/><rect x="9" y="17" width="14" height="11" fill="${C.top}"/><path d="M17 6v4" />`),
  saveas: svg(`<path d="M4 4h17l4 4v19H4z" fill="${C.left}"/><rect x="8" y="4" width="11" height="7" fill="${C.paper}"/>${arrow(12, 22, 29, 22, C.org, 3.4)}`),
  undo: svg(`<path d="M9 14h10.5a6.5 6.5 0 0 1 0 13H14" stroke-width="5.4"/><path d="M9 14h10.5a6.5 6.5 0 0 1 0 13H14" stroke-width="2.6" stroke="${C.top}"/><path d="M2.5 14 11 6.5v15z" fill="${C.org}"/>`),
  redo: svg(`<path d="M23 14H12.5a6.5 6.5 0 0 0 0 13H18" stroke-width="5.4"/><path d="M23 14H12.5a6.5 6.5 0 0 0 0 13H18" stroke-width="2.6" stroke="${C.top}"/><path d="M29.5 14 21 6.5v15z" fill="${C.org}"/>`),
  project: svg(`<path d="M5 27 9 19l14-14 4 4-14 14z" fill="${C.yel}"/><path d="M5 27l4-8 4 4z" fill="${C.org}"/><path d="M20 8l4 4" />`),
  newdoc: svg(`${sheet()}<circle cx="22" cy="23" r="6.5" fill="${C.grn}"/><path d="M22 19.5v7M18.5 23h7" stroke="#fff" stroke-width="2.4"/>`),
  openbox: svg(`<path d="M3 8h9l2.5 3H27v5H3z" fill="${C.yel}"/><path d="M6 15h24l-4 13H2z" fill="#ffe382"/>`),
  importbox: svg(`${cube(16, 13, 10, 8)}${arrow(16, 1, 16, 12, C.grn, 3.4)}`),
  importm: svg(`${cube(16, 14, 10, 8, [C.orgL, C.org, '#d9661c'])}${arrow(16, 1, 16, 13, C.grn, 3.4)}`),
  picture: svg(`<rect x="3" y="6" width="26" height="20" rx="3" fill="${C.cyan}"/><path d="M3 23l8-8 6 6 4-4 8 8v1H3z" fill="${C.grn}"/><circle cx="22" cy="12" r="3" fill="${C.yel}"/>`),
  reader: svg(`${sheet('<path d="M10 11h7M10 15h12M10 19h9" stroke-width="2"/>')}${arrow(16, 25, 30, 25, C.org, 3)}`),
  scanner: svg(`<path d="M4 11V4h7M21 4h7v7M28 21v7h-7M11 28H4v-7" stroke-width="2.8" stroke="${C.org}"/>${cube(16, 8, 8, 7)}<path d="M2 16h28" stroke="${C.red}" stroke-width="2.4"/>`),
  stl: svg(`${sheet()}${label('STL', 16.5, C.left)}`),
  obj: svg(`${sheet()}${label('OBJ', 16.5, C.grn)}`),
  mf3: svg(`${sheet()}${label('3MF', 16.5, C.lil)}`),
  step: svg(`${sheet()}${label('STEP', 16.5, C.org)}`),
  dxf: svg(`${sheet()}${label('DXF', 16.5, C.red)}`),
  // Linha do tempo
  tlfirst: svg(`<rect x="6" y="7" width="3.5" height="18" rx="1" fill="${C.org}"/><path d="M26 7 12 16l14 9z" fill="${C.org}"/>`),
  tlprev: svg(`<path d="M23 7 9 16l14 9z" fill="${C.org}"/>`),
  tlnext: svg(`<path d="M9 7l14 9-14 9z" fill="${C.org}"/>`),
  tllast: svg(`<rect x="22.5" y="7" width="3.5" height="18" rx="1" fill="${C.org}"/><path d="M6 7l14 9-14 9z" fill="${C.org}"/>`),
  play: svg(`<circle cx="16" cy="16" r="12.5" fill="${C.grn}"/><path d="M13 10l9 6-9 6z" fill="#fff"/>`),
  recalc: svg(`<path d="M25 11a10 10 0 1 0 1.5 7" stroke-width="3.4" stroke="${C.left}"/><path d="M27 4v8h-8z" fill="${C.org}"/>`),
  // Árvore
  part: svg(cube(16, 4, 11, 12)),
  body: svg(cube(16, 5, 10, 11, [C.grey, '#9aa6b8', C.greyD])),
  origin: svg(`${arrow(10, 22, 28, 22, C.red, 2.6)}${arrow(10, 22, 10, 4, C.grn, 2.6)}${arrow(10, 22, 3, 29, C.left, 2.6)}${dot(10, 22, 2.6, C.yel)}`),
  eye: svg(`<path d="M2 16s5-9 14-9 14 9 14 9-5 9-14 9S2 16 2 16z" fill="${C.paper}"/><circle cx="16" cy="16" r="5" fill="${C.left}"/><circle cx="16" cy="16" r="2" fill="${INK}"/>`),
  eyeoff: svg(`<path d="M2 16s5-9 14-9 14 9 14 9-5 9-14 9S2 16 2 16z" fill="${C.grey}"/><path d="M5 27 27 5" stroke="${C.red}" stroke-width="3.2"/>`),
  config: svg(`<rect x="3" y="5" width="26" height="22" rx="3" fill="${C.paper}"/><path d="M3 11h26M11 11v16" /><rect x="3" y="5" width="26" height="6" rx="3" fill="${C.left}"/><circle cx="20" cy="19" r="3.5" fill="${C.org}"/>`),
  // Esboço e criação
  sketch: svg(`<rect x="3" y="7" width="22" height="19" rx="2" fill="${C.paper}"/><path d="M7 20l5-7 4 5 3-3" stroke="${C.grn}" stroke-width="2.4"/><path d="M27 4 17 14l-2 5 5-2L30 7z" fill="${C.yel}"/>`),
  extrude: svg(`${cube(16, 9, 11, 9)}${arrow(16, 13, 16, 1, C.org, 3.4)}`),
  revolve: svg(`${cyl(16, 10, 10, 13)}<path d="M16 2v28" stroke="${C.org}" stroke-width="2.4" stroke-dasharray="3 2.5"/><path d="M24 5a10 4 0 0 1 3 4" stroke="${C.org}" stroke-width="2.6"/>`),
  sweep: svg(`<path d="M5 25C9 12 17 7 28 6" stroke="${C.org}" stroke-width="2.2" stroke-dasharray="3 2.5"/><path d="M7 27C11 15 18 10 28 10" stroke-width="7" stroke="${INK}"/><path d="M7 27C11 15 18 10 28 10" stroke-width="4.4" stroke="${C.left}"/><ellipse cx="7" cy="26" rx="3.5" ry="4.5" fill="${C.top}"/>`),
  loft: svg(`<path d="M5 25h14l8-16H13z" fill="${C.left}" opacity=".9"/><rect x="4" y="20" width="14" height="7" fill="${C.top}"/><ellipse cx="20" cy="7" rx="7" ry="3" fill="${C.top}"/>`),
  pipe: svg(`<path d="M4 23c7 0 8-12 15-12h10" stroke-width="10" stroke="${INK}"/><path d="M4 23c7 0 8-12 15-12h10" stroke-width="7" stroke="${C.left}"/><path d="M4 23c7 0 8-12 15-12h10" stroke-width="2" stroke="${C.top}"/>`),
  hole: svg(`${cube(16, 7, 12, 8)}<ellipse cx="16" cy="13" rx="5.5" ry="2.8" fill="${INK}"/>${arrow(16, 1, 16, 12, C.red, 2.6)}`),
  coil: svg(`<path d="M8 6c12-3 16 3 16 3S8 13 8 13s16 3 16 5-16 5-16 5 16 1 16 3" stroke-width="4.6"/><path d="M8 6c12-3 16 3 16 3S8 13 8 13s16 3 16 5-16 5-16 5 16 1 16 3" stroke-width="2.4" stroke="${C.left}"/>`),
  thread: svg(`${cyl(16, 6, 7, 20, [C.top, C.grey])}<path d="M9 11l14 3M9 15l14 3M9 19l14 3M9 23l14 3" stroke="${C.org}" stroke-width="2"/>`),
  box: svg(cube(16, 4, 11, 12)),
  cylinder: svg(cyl(16, 8, 10, 15)),
  sphere: svg(`<circle cx="16" cy="16" r="12" fill="${C.left}"/><path d="M4 16a12 5 0 0 0 24 0" fill="${C.right}" opacity=".6" stroke="none"/><circle cx="16" cy="16" r="12"/><ellipse cx="11.5" cy="10.5" rx="3.5" ry="2.3" fill="#fff" stroke="none" opacity=".85"/>`),
  torus: svg(`<ellipse cx="16" cy="16.5" rx="13.5" ry="8.5" fill="${C.left}"/><ellipse cx="16" cy="15" rx="5.5" ry="2.6" fill="#0d1420"/>${shine('M6 13.5a11 5 0 0 1 7-4')}`),
  cone: svg(`<path d="M16 3 5 23a11 4.6 0 0 0 22 0z" fill="${C.left}"/><path d="M5 23a11 4.6 0 0 1 22 0" stroke-dasharray="2.5 2"/>${shine('M14 7l-6 12')}`),
  tube: svg(`${cyl(16, 8, 10, 15)}<ellipse cx="16" cy="8" rx="5" ry="2.1" fill="#0d1420"/>`),
  prism: svg(`<path d="M9 7h14l5 5-5 5H9l-5-5z" fill="${C.top}"/><path d="M4 12v10l5 5V17zM9 17h14v10H9z" fill="${C.left}"/><path d="M23 17l5-5v10l-5 5z" fill="${C.right}"/>`),
  wedge: svg(`<path d="M3 25h18l8-6H11z" fill="${C.top}"/><path d="M3 25V9l18 16z" fill="${C.left}"/><path d="M3 9l8-5 18 15-8 6z" fill="${C.right}"/>`),
  // Modificar
  pushpull: svg(`${cube(16, 13, 11, 6)}${arrow(16, 19, 16, 2, C.org, 3.4)}`),
  offsetface: svg(`${cube(16, 11, 11, 9, [C.orgL, C.left, C.right])}${arrow(16, 14, 16, 1, C.org, 3.2)}`),
  fillet: svg(`<path d="M5 28V14a9 9 0 0 1 9-9h14v23z" fill="${C.left}"/><path d="M5 14a9 9 0 0 1 9-9" stroke="${C.org}" stroke-width="3.4"/>`),
  chamfer: svg(`<path d="M5 28V13l8-8h15v23z" fill="${C.left}"/><path d="M5 13l8-8" stroke="${C.org}" stroke-width="3.4"/>`),
  shell: svg(`${cube(16, 4, 11, 12)}<polygon points="10,10 16,7 22,10 16,13" fill="#0d1420"/>`),
  combine: svg(`<rect x="3" y="9" width="15" height="15" rx="2" fill="${C.left}"/><rect x="13" y="4" width="15" height="15" rx="2" fill="${C.org}" opacity=".95"/><path d="M15 21h3v-3" stroke="#fff" stroke-width="2"/>`),
  split: svg(`${cube(16, 4, 11, 12)}<path d="M2 18l28-6" stroke="${C.red}" stroke-width="3" stroke-dasharray="4 2.5"/>`),
  scale: svg(`<rect x="4" y="4" width="24" height="24" rx="2" fill="none" stroke-dasharray="3.5 2.5"/><rect x="4" y="15" width="13" height="13" rx="2" fill="${C.left}"/>${arrow(14, 18, 27, 5, C.org, 3)}`),
  remove: svg(`${cube(16, 4, 11, 12, [C.grey, '#9aa6b8', C.greyD])}<circle cx="22" cy="22" r="7" fill="${C.red}"/><path d="M19 19l6 6M25 19l-6 6" stroke="#fff" stroke-width="2.6"/>`),
  bounding: svg(`<rect x="3" y="3" width="26" height="26" rx="3" fill="${C.yel}" opacity=".35" stroke-dasharray="4 3"/><circle cx="16" cy="16" r="8" fill="${C.left}"/>${shine('M12 12a5 5 0 0 1 4-2')}`),
  // Organizar
  move: svg(`${arrow(16, 16, 16, 2, C.org, 3.2)}${arrow(16, 16, 16, 30, C.org, 3.2)}${arrow(16, 16, 2, 16, C.org, 3.2)}${arrow(16, 16, 30, 16, C.org, 3.2)}<circle cx="16" cy="16" r="4" fill="${C.left}"/>`),
  mirror: svg(`<path d="M13 7 4 25h9z" fill="${C.left}"/><path d="M19 7l9 18h-9z" fill="${C.top}" stroke-dasharray="2.5 2"/><path d="M16 2v28" stroke="${C.org}" stroke-width="2.6" stroke-dasharray="3.5 2.5"/>`),
  pattern: svg(`<rect x="3" y="3" width="11" height="11" rx="2" fill="${C.left}"/><rect x="18" y="3" width="11" height="11" rx="2" fill="${C.top}"/><rect x="3" y="18" width="11" height="11" rx="2" fill="${C.top}"/><rect x="18" y="18" width="11" height="11" rx="2" fill="${C.top}"/>`),
  cpattern: svg(`<circle cx="16" cy="16" r="10" stroke-dasharray="3 3" stroke="${C.greyD}"/><circle cx="16" cy="5" r="4" fill="${C.left}"/><circle cx="26" cy="21" r="4" fill="${C.top}"/><circle cx="6" cy="21" r="4" fill="${C.top}"/>${dot(16, 16, 2.2)}`),
  // Configurar e construir
  params: svg(`<rect x="3" y="4" width="26" height="24" rx="4" fill="${C.lil}"/><text x="16" y="23" font-size="17" font-style="italic" font-weight="800" text-anchor="middle" fill="#fff" stroke="none" font-family="Georgia, serif">ƒx</text>`),
  table: svg(`<rect x="3" y="5" width="26" height="22" rx="3" fill="${C.paper}"/><rect x="3" y="5" width="26" height="6" rx="3" fill="${C.grn}"/><path d="M3 18h26M12 11v16" />`),
  plane: svg(`${plane()}<path d="M3 21 10 11h19l-7 10z"/>${arrow(16, 16, 16, 2, C.org, 2.8)}`),
  // Esboço: ferramentas
  select: svg(`<path d="M7 3l17 13-7.5 1.2 4.5 8.3-3.6 2-4.5-8.4L7 24z" fill="${C.paper}"/>`),
  line: svg(`<path d="M5 25 12 8l9 12 6-11" stroke-width="4.6"/><path d="M5 25 12 8l9 12 6-11" stroke-width="2.2" stroke="${C.grn}"/>${dot(5, 25, 2.6, C.paper)}${dot(27, 9, 2.6, C.paper)}`),
  path: svg(`<path d="M4 26 12 11l8 8 8-13" stroke-width="4.6"/><path d="M4 26 12 11l8 8 8-13" stroke-width="2.2" stroke="${C.cyan}"/>${dot(4, 26, 2.6, C.org)}${dot(28, 6, 2.6, C.org)}`),
  arc: svg(`<path d="M4 25a13 13 0 0 1 24 0" stroke-width="4.6"/><path d="M4 25a13 13 0 0 1 24 0" stroke-width="2.2" stroke="${C.grn}"/>${dot(4, 25, 2.6, C.paper)}${dot(16, 12, 2.6, C.org)}${dot(28, 25, 2.6, C.paper)}`),
  rect: svg(`<rect x="4" y="8" width="24" height="16" rx="1" fill="${C.grnL}"/>${dot(4, 8, 2.6, C.paper)}${dot(28, 24, 2.6, C.paper)}`),
  crect: svg(`<rect x="4" y="8" width="24" height="16" rx="1" fill="${C.grnL}"/>${dot(16, 16, 2.6, C.org)}${dot(28, 24, 2.6, C.paper)}`),
  rrect: svg(`<rect x="4" y="8" width="24" height="16" rx="6" fill="${C.grnL}"/><path d="M4 14a6 6 0 0 1 6-6" stroke="${C.org}" stroke-width="2.6"/>`),
  circle: svg(`<circle cx="16" cy="16" r="11" fill="${C.grnL}"/><path d="M16 16h11" stroke-dasharray="2.5 2"/>${dot(16, 16, 2.6, C.org)}`),
  ellipse: svg(`<ellipse cx="16" cy="16" rx="13" ry="8" fill="${C.grnL}"/>${dot(16, 16, 2.6, C.org)}`),
  polygon: svg(`<path d="M16 4l10.4 6v12L16 28 5.6 22V10z" fill="${C.grnL}"/>${dot(16, 16, 2.6, C.org)}`),
  slot: svg(`<path d="M10 10h12a6 6 0 0 1 0 12H10a6 6 0 0 1 0-12z" fill="${C.grnL}"/>${dot(10, 16, 2.2, C.org)}${dot(22, 16, 2.2, C.org)}`),
  construction: svg(`<path d="M4 27 28 5" stroke="${C.org}" stroke-width="3" stroke-dasharray="4.5 3.5"/>${dot(4, 27, 2.6, C.paper)}${dot(28, 5, 2.6, C.paper)}`),
  smirror: svg(`<rect x="3" y="9" width="9" height="14" rx="1.5" fill="${C.grnL}"/><rect x="20" y="9" width="9" height="14" rx="1.5" fill="${C.paper}" stroke-dasharray="2.5 2"/><path d="M16 2v28" stroke="${C.org}" stroke-width="2.6" stroke-dasharray="3.5 2.5"/>`),
  soffset: svg(`<rect x="3" y="3" width="26" height="26" rx="6" fill="${C.paper}" stroke-dasharray="3.5 2.5"/><rect x="9" y="9" width="14" height="14" rx="1.5" fill="${C.grnL}"/>`),
  smove: svg(`<rect x="3" y="16" width="12" height="12" rx="1.5" fill="${C.grnL}"/><rect x="17" y="4" width="12" height="12" rx="1.5" fill="${C.paper}" stroke-dasharray="2.5 2"/>${arrow(10, 21, 22, 9, C.org, 2.8)}`),
  spattern: svg(`<circle cx="8.5" cy="8.5" r="5" fill="${C.grnL}"/><circle cx="23.5" cy="8.5" r="5" fill="${C.paper}" stroke-dasharray="2.5 2"/><circle cx="8.5" cy="23.5" r="5" fill="${C.paper}" stroke-dasharray="2.5 2"/><circle cx="23.5" cy="23.5" r="5" fill="${C.paper}" stroke-dasharray="2.5 2"/>`),
  sinsert: svg(`${sheet('<path d="M10 22l4-6 3 4 3-3 3 5" stroke="' + C.grn + '" stroke-width="2.2"/>')}`),
  trash: svg(`<path d="M8 10l1.5 18h13L24 10z" fill="${C.redL}"/><rect x="5" y="6" width="22" height="4" rx="1.5" fill="${C.red}"/><path d="M13 6V3.5h6V6M13 14v10M19 14v10" />`),
  finish: svg(`<circle cx="16" cy="16" r="13" fill="${C.grn}"/><path d="M9 16.5l5 5 9.5-10" stroke="#fff" stroke-width="3.6"/>`),
  // Superfície
  surfext: svg(`<path d="M4 23c4-5 8-5 12 0s8 5 12 0V12c-4 5-8 5-12 0S8 7 4 12z" fill="${C.lil}"/><path d="M4 12c4-5 8-5 12 0s8 5 12 0" stroke-width="2.2"/>`),
  surfrev: svg(`<path d="M9 4c-7 7-7 17 0 24h14c7-7 7-17 0-24z" fill="${C.lilL}"/><path d="M9 4c-7 7-7 17 0 24" fill="${C.lil}"/><path d="M16 1v30" stroke="${C.org}" stroke-width="2.4" stroke-dasharray="3.5 2.5"/>`),
  patch: svg(`<path d="M6 9c6-6 15-6 21 0s-2 17-11 17S0 15 6 9z" fill="${C.lil}"/>${shine('M8 10c3-3 7-4 10-3')}`),
  thicken: svg(`<path d="M3 12c6-6 20-6 26 0v8c-6-6-20-6-26 0z" fill="${C.left}"/><path d="M3 12c6-6 20-6 26 0" stroke="${C.lil}" stroke-width="3"/>`),
  surfoff: svg(`<path d="M3 22c6-7 20-7 26 0" stroke-width="4.4"/><path d="M3 22c6-7 20-7 26 0" stroke-width="2.2" stroke="${C.lil}"/><path d="M3 12c6-7 20-7 26 0" stroke-dasharray="3.5 2.5"/>${arrow(16, 17, 16, 8, C.org, 2.6)}`),
  flipn: svg(`<path d="M3 17c6-6 20-6 26 0" stroke-width="4.4"/><path d="M3 17c6-6 20-6 26 0" stroke-width="2.2" stroke="${C.lil}"/>${arrow(12, 13, 12, 2, C.org, 2.6)}${arrow(20, 15, 20, 29, C.grn, 2.6)}`),
  // Montar
  insertdesign: svg(`${cube(13, 6, 9, 10)}${cube(22, 13, 7, 7, [C.orgL, C.org, '#d9661c'])}`),
  joint: svg(`<rect x="2" y="13" width="11" height="6" rx="2" fill="${C.left}"/><rect x="19" y="13" width="11" height="6" rx="2" fill="${C.top}"/><circle cx="16" cy="16" r="6" fill="${C.org}"/><circle cx="16" cy="16" r="2" fill="#fff"/>`),
  drive: svg(`<circle cx="16" cy="16" r="12" fill="${C.paper}"/><path d="M16 16l6-7" stroke="${C.red}" stroke-width="3"/>${dot(16, 16, 2.6, INK)}<path d="M8 23a11 11 0 0 1-2-7" stroke="${C.grn}" stroke-width="2.6"/>`),
  explode: svg(`${cube(16, 9, 6, 6)}${arrow(10, 10, 3, 3, C.org, 2.6)}${arrow(22, 10, 29, 3, C.org, 2.6)}${arrow(10, 22, 3, 29, C.org, 2.6)}${arrow(22, 22, 29, 29, C.org, 2.6)}`),
  bom: svg(`<rect x="5" y="3" width="22" height="26" rx="3" fill="${C.paper}"/><rect x="11" y="1.5" width="10" height="5" rx="2" fill="${C.org}"/><path d="M10 12h12M10 17h12M10 22h8" stroke-width="2"/>`),
  // Inspecionar e vista
  measure: svg(`<path d="M3 21 21 3l8 8-18 18z" fill="${C.yel}"/><path d="M9 15l2.5 2.5M12.5 11.5l3.5 3.5M16 8l2.5 2.5M19.5 4.5l3.5 3.5" />`),
  angle: svg(`<path d="M4 27h24M4 27 22 6" stroke-width="3" stroke="${C.left}"/><path d="M14 27a10 10 0 0 0-3.2-7.4" stroke="${C.org}" stroke-width="3"/>`),
  mass: svg(`<path d="M9 11h14l5 17H4z" fill="${C.greyD}"/><circle cx="16" cy="7" r="3.5" fill="none" stroke-width="2.4"/><text x="16" y="25" font-size="8" font-weight="800" text-anchor="middle" fill="#fff" stroke="none" font-family="Segoe UI, Arial">kg</text>`),
  com: svg(`<circle cx="16" cy="16" r="12" fill="${C.paper}"/><path d="M16 4a12 12 0 0 1 12 12H16zM16 28A12 12 0 0 1 4 16h12z" fill="${INK}"/>`),
  section: svg(`${cube(16, 4, 11, 12)}<path d="M1 17h30" stroke="${C.red}" stroke-width="3"/><polygon points="5,17 16,22.5 27,17" fill="${C.red}" opacity=".55"/>`),
  interference: svg(`<circle cx="12" cy="16" r="9" fill="${C.left}"/><circle cx="20" cy="16" r="9" fill="${C.top}"/><path d="M16 8a9 9 0 0 1 0 16 9 9 0 0 1 0-16z" fill="${C.red}"/>`),
  zebra: svg(`<circle cx="16" cy="16" r="12.5" fill="${C.paper}"/><path d="M6 9h20M4 14h24M4 19h24M6 24h20" stroke-width="3.4"/>`),
  draft: svg(`<path d="M7 27 11 5h10l4 22z" fill="${C.grey}"/><path d="M11 5 7 27" stroke="${C.grn}" stroke-width="3.4"/><path d="M21 5l4 22" stroke="${C.red}" stroke-width="3.4"/>`),
  curvature: svg(`<path d="M3 25C9 5 23 5 29 25" stroke-width="3" stroke="${C.left}"/><path d="M7 18l-4-3M11 12l-3-5M16 10V4M21 12l3-5M25 18l4-3" stroke="${C.org}" stroke-width="2.2"/>`),
  edgepick: svg(`${cube(16, 4, 11, 12)}<path d="M27 9.5v12" stroke="${C.org}" stroke-width="3.4"/>`),
  iso: svg(cube(16, 4, 11, 12)),
  front: svg(`<rect x="5" y="5" width="22" height="22" rx="2" fill="${C.left}"/>${shine('M8 9h8')}`),
  top: svg(`<path d="M4 11 16 5l12 6-12 6z" fill="${C.org}"/><path d="M4 11v10l12 6 12-6V11l-12 6z" fill="${C.grey}"/>`),
  right: svg(`<path d="M16 5l12 6v12l-12-6z" fill="${C.org}"/><path d="M4 11l12-6v12L4 23z" fill="${C.grey}"/>`),
  fit: svg(`<path d="M3 11V3h8M21 3h8v8M29 21v8h-8M11 29H3v-8" stroke="${C.org}" stroke-width="3"/><rect x="10" y="10" width="12" height="12" rx="2" fill="${C.left}"/>`),
  edges: svg(`<path d="M16 4 27 10v12L16 28 5 22V10z" fill="${C.top}" stroke-width="2.8"/><path d="M5 10l11 6 11-6M16 16v12" stroke-width="2.8"/>`),
  ortho: svg(`<rect x="5" y="5" width="22" height="22" rx="2" fill="${C.top}"/><path d="M5 13h22M13 5v22" stroke-dasharray="3 2"/>`),
  persp: svg(`<path d="M3 6h26l-7 21H10z" fill="${C.top}"/><path d="M16 6v21M8 16h16" stroke-dasharray="3 2"/>`),
  showall: svg(`<path d="M2 16s5-9 14-9 14 9 14 9-5 9-14 9S2 16 2 16z" fill="${C.yel}"/><circle cx="16" cy="16" r="5" fill="${C.left}"/><circle cx="16" cy="16" r="2" fill="${INK}"/>`),
  orbit: svg(`<ellipse cx="16" cy="16" rx="13" ry="6" stroke-width="2.6" stroke="${C.left}"/><path d="M24 8.5l4.5 2.5-2.5 4" stroke-width="2.6" stroke="${C.org}"/>${dot(16, 16, 3.2)}`),
  pan: svg(`<path d="M11 28v-9l-4-4a2 2 0 0 1 3-3l2 2V5a2 2 0 0 1 4 0v8V3.5a2 2 0 0 1 4 0V13V5.5a2 2 0 0 1 4 0V20c0 4-3 8-7 8z" fill="${C.orgL}"/>`),
  zoom: svg(`<circle cx="13.5" cy="13.5" r="9" fill="${C.top}"/><path d="M20.5 20.5 28 28" stroke-width="4"/><path d="M13.5 9.5v8M9.5 13.5h8" stroke-width="2.6"/>`),
};
