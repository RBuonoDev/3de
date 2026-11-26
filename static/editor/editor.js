// Editor 3DE: modelagem paramétrica de peças no navegador (código próprio).
// Organização: ícones -> estado -> desenho da cena -> recursos -> navegador (árvore) ->
// propriedades -> esboço -> organizar -> inspecionar -> arquivos -> comandos -> eventos.

import { Renderer, v3, flatMesh } from './gfx.js';
import { rebuild, PLANES, worldToSketch, sketchLoops, sketchPaths, commandsToFeatures, circlePoints, edgeAt, faceAt, intersect, volumeOf, meshOf, entityPoints } from './kernel.js';
import { trianglesOf, toObj, to3mf, toStep, toDxf, parseObj, parseDxf, parseSvg } from './files3d.js';
import { ICON } from './icons.js';

/* =========================================================================
   Ícones (desenhos próprios, em icons.js)
   ========================================================================= */
function fillIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) if (!el.firstChild) el.innerHTML = ICON[el.dataset.icon] || '';
}

/* =========================================================================
   Estado
   ========================================================================= */
const state = {
  name: 'Sem título',
  features: [],
  nextId: 1,
  selected: null,
  mode: 'idle',            // idle | sketch | feature | measure | section
  edit: null,              // { draft, original, isNew }
  sketch: null,            // { draft, original, isNew, tool, temp, sel, cursor }
  bodies: [],
  errors: {},
  imports: new Map(),      // id -> malha
  hidden: new Set(),       // corpos ocultos
  undo: [], redo: [],
  section: { axis: 'z', pos: 0 },
  measure: [],
  tab: 'features',
  edges: true,
  rollback: null,          // posição do marcador do histórico (null = no fim)
  configs: [],             // tabela de configurações: [{ name, values: {chave: valor} }]
  clash: [],               // interferências encontradas (malhas em vermelho)
  hover: null,             // aresta ou face sob o mouse durante uma seleção
  surfaces: [],            // superfícies (cascas abertas)
  info: { joints: [] },    // juntas da montagem
  snapAlign: true,         // esboço: linhas puxam para 0°, 90°, 180° e alinham com outros pontos
  explode: 0,              // vista explodida da montagem (0 = montada)
  pose: new Map(),         // posição animada das juntas (só exibição)
  lastCmd: null,           // último comando (Shift+R repete)
};
const $ = (s) => document.querySelector(s);
const newId = () => `f${state.nextId++}`;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const icon = (name) => h('span', { 'data-icon': name, html: ICON[name] || '' });
const fmt = (n, d = 2) => {
  const v = Number(n), r = Math.abs(v) < 0.5 * 10 ** -d ? 0 : v;
  return r.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: d });
};
function setStatus(text, error = false) { const el = $('#status'); el.textContent = text; el.classList.toggle('err', error); }

/* =========================================================================
   Cena
   ========================================================================= */
const canvas = $('#gl');
const gfx = new Renderer(canvas);
const cam = gfx.camera;

let frameQueued = false;
function requestRender() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; gfx.render(); drawCube(); positionTags(); });
}
function resize() {
  const r = canvas.getBoundingClientRect();
  gfx.resize(r.width, r.height);
  requestRender();
}
new ResizeObserver(resize).observe($('#viewport'));

const COLORS = { body: [0.74, 0.77, 0.81], import: [0.80, 0.72, 0.56], plane: [0.3, 0.55, 1], surface: [0.42, 0.66, 0.98] };

function boxOf(P) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { if (P[i + k] < min[k]) min[k] = P[i + k]; if (P[i + k] > max[k]) max[k] = P[i + k]; }
  return { min, max };
}
function modelBox() {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const b of visibleMeshes()) { const q = boxOf(b.positions); for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], q.min[k]); max[k] = Math.max(max[k], q.max[k]); } }
  return min[0] === Infinity ? null : { min, max };
}
function visibleMeshes() {
  const list = state.bodies.filter(b => !state.hidden.has(b.name)).map(displayMesh);
  for (const s of state.surfaces) if (!state.hidden.has(s.name)) list.push(s);
  for (const f of state.features) if (f.type === 'import' && !f.suppressed && !state.hidden.has(f.name) && state.imports.has(f.id)) list.push(state.imports.get(f.id));
  return list;
}
/** Só os sólidos visíveis (para massa e exportação). */
const solidMeshes = () => visibleMeshes().filter(m => !m.surface);

/** Malha como aparece na tela: vista explodida e posição animada das juntas (sem mudar a peça). */
function displayMesh(b) {
  let move = null;
  for (const j of state.info.joints || []) {
    if (j.body !== b.name || !state.pose.has(j.id)) continue;
    const delta = state.pose.get(j.id) - j.value;
    if (Math.abs(delta) < 1e-9) continue;
    if (j.kind === 'revolute') { const a = (delta * Math.PI) / 180; move = { rot: { o: j.origin, k: j.axis, c: Math.cos(a), s: Math.sin(a) } }; }
    else if (j.kind === 'slider') move = { t: v3.scale(j.axis, delta) };
  }
  let shift = null;
  if (state.explode > 0 && state.bodies.length > 1) {
    const all = state.bodies.map(x => boxOf(x.positions)), c = v3.mid(all.reduce((m, q) => q.min.map((v, k) => Math.min(v, m[k])), [Infinity, Infinity, Infinity]),
      all.reduce((m, q) => q.max.map((v, k) => Math.max(v, m[k])), [-Infinity, -Infinity, -Infinity]));
    const q = boxOf(b.positions), bc = v3.mid(q.min, q.max);
    shift = v3.scale(v3.sub(bc, c), state.explode);
  }
  if (!move && !shift) return b;
  const P = new Float32Array(b.positions), N = new Float32Array(b.normals);
  const rot = (p, r, isNormal) => {
    const o = isNormal ? [0, 0, 0] : r.o, x = v3.sub(p, o), k = r.k;
    return v3.add(o, v3.add(v3.add(v3.scale(x, r.c), v3.scale(v3.cross(k, x), r.s)), v3.scale(k, v3.dot(k, x) * (1 - r.c))));
  };
  for (let i = 0; i < P.length; i += 3) {
    let p = [P[i], P[i + 1], P[i + 2]], n = [N[i], N[i + 1], N[i + 2]];
    if (move?.rot) { p = rot(p, move.rot, false); n = rot(n, move.rot, true); }
    if (move?.t) p = v3.add(p, move.t);
    if (shift) p = v3.add(p, shift);
    P.set(p, i); N.set(n, i);
  }
  return { ...b, positions: P, normals: N };
}

/** Envia as peças ao motor gráfico (só quando a geometria muda). */
function uploadMeshes() {
  gfx.clearMeshes();
  for (const b of state.bodies) if (!state.hidden.has(b.name)) gfx.addMesh(displayMesh(b), COLORS.body, { tag: b.name });
  for (const s of state.surfaces) if (!state.hidden.has(s.name)) gfx.addMesh(s, COLORS.surface, { tag: s.name, twoSide: true });
  if (comMarker) for (const m of comMarker) gfx.addMesh(m, [1, 0.54, 0.24], { pickable: false, onTop: true, alpha: 0.95 });
  for (const f of state.features) {
    if (f.type === 'import' && !f.suppressed && !state.hidden.has(f.name) && state.imports.has(f.id)) gfx.addMesh(state.imports.get(f.id), COLORS.import, { tag: f.name });
  }
  for (const m of state.clash) gfx.addMesh(m, [1, 0.25, 0.22], { alpha: 0.8, pickable: false, onTop: true });
  if (planeHint) {
    const { plane, offset } = planeHint, s = 60, f = PLANES[plane].toWorld;
    const pts = [[-s, -s], [s, -s], [s, s], [-s, s]].map(([u, v]) => f(u, v, 0, offset));
    const n = PLANES[plane].normal;
    gfx.addMesh({ positions: new Float32Array([...pts[0], ...pts[1], ...pts[2], ...pts[0], ...pts[2], ...pts[3]]), normals: new Float32Array(Array(6).fill(n).flat()), indices: null },
      COLORS.plane, { alpha: 0.18, pickable: false });
  }
}

const AXIS_COLORS = [[0.93, 0.33, 0.31], [0.38, 0.8, 0.42], [0.36, 0.56, 0.98]];   // X, Y, Z
/** Cor do eixo do mundo mais alinhado à direção d. */
const axisColor = (d) => AXIS_COLORS[d.map(Math.abs).indexOf(Math.max(...d.map(Math.abs)))];

/** Linhas (grade, eixos, esboço, medição): refeitas a cada mudança de vista ou de cursor. */
function drawLines() {
  gfx.clearLines();
  clearTags();
  const box = modelBox();
  const span = box ? Math.max(...v3.sub(box.max, box.min)) : 100;
  if (state.mode !== 'sketch') {
    // Grade infinita do chão (plano XY), desenhada pelo motor gráfico.
    const th = THEMES[prefs.theme];
    gfx.grid = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], colorU: AXIS_COLORS[0], colorV: AXIS_COLORS[1], tint: th.grid, alpha: th.gridAlpha };
  }
  const a = Math.max(8, span * 0.08);
  gfx.addLines([0, 0, 0, a, 0, 0], [1, 0.36, 0.33, 0.9]);
  gfx.addLines([0, 0, 0, 0, a, 0], [0.4, 0.85, 0.45, 0.9]);
  gfx.addLines([0, 0, 0, 0, 0, a], [0.4, 0.62, 1, 0.9]);
  if (planeHint) {
    const { plane, offset } = planeHint, s = 60, f = PLANES[plane].toWorld;
    const pts = [[-s, -s], [s, -s], [s, s], [-s, s]].map(([u, v]) => f(u, v, 0, offset));
    gfx.addLines([0, 1, 1, 2, 2, 3, 3, 0].flatMap(i => pts[i]), [0.42, 0.65, 1, 0.9]);
  }
  if (state.mode === 'sketch') drawSketchLines();
  if (state.mode === 'measure') drawMeasureLines();
  if (state.mode === 'feature') drawPickLines();
  requestRender();
}

/** Arestas escolhidas (laranja), a sob o mouse (clara) e o plano de divisão. */
function drawPickLines() {
  const d = state.edit?.draft;
  if (!d) return;
  if (d.edges) for (const e of d.edges) gfx.addLines([...e.a, ...e.b], [1, 0.54, 0.24, 1], { depth: false });
  if (state.hover?.a) gfx.addLines([...state.hover.a, ...state.hover.b], [1, 0.85, 0.6, 1], { depth: false });
  if (d.type === 'split') {
    const box = modelBox(), ax = { x: 0, y: 1, z: 2 }[d.axis];
    if (box) {
      const lo = box.min.map(v => v - 5), hi = box.max.map(v => v + 5), [i, j] = [0, 1, 2].filter(k => k !== ax);
      const corner = (a, b) => { const p = [0, 0, 0]; p[ax] = Number(d.at) || 0; p[i] = a ? hi[i] : lo[i]; p[j] = b ? hi[j] : lo[j]; return p; };
      const c = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
      gfx.addLines([0, 1, 1, 2, 2, 3, 3, 0].flatMap(k => c[k]), [1, 0.54, 0.24, 1], { depth: false });
    }
  }
}

/* ---- Cubo de vistas (desenho 2D próprio) ---- */
const cubeCtx = $('#cube').getContext('2d');
const CUBE_FACES = [
  { n: [0, 0, 1], label: 'SUPERIOR', view: 'top' }, { n: [0, 0, -1], label: 'INFERIOR', view: 'bottom' },
  { n: [0, -1, 0], label: 'FRONTAL', view: 'front' }, { n: [0, 1, 0], label: 'POSTERIOR', view: 'back' },
  { n: [1, 0, 0], label: 'DIREITA', view: 'right' }, { n: [-1, 0, 0], label: 'ESQUERDA', view: 'left' },
];
let cubeHits = [], cubeHover = null;
function drawCube() {
  const c = cubeCtx, size = 124, mid = 63, s = 31;
  c.clearRect(0, 0, size, size);
  const r = cam.right, u = cam.up, f = cam.forward;
  const toScreen = (p) => [mid + v3.dot(p, r) * s, mid - v3.dot(p, u) * s];
  cubeHits = [];
  // Anel de orientação sob o cubo.
  c.beginPath();
  const ring = Array.from({ length: 49 }, (_, k) => { const a = (k / 48) * Math.PI * 2; return toScreen([Math.cos(a) * 1.55, Math.sin(a) * 1.55, -1]); });
  ring.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  const CT = THEMES[prefs.theme].cube;
  c.strokeStyle = CT.ring; c.lineWidth = 3; c.stroke();
  const faces = CUBE_FACES.map(face => {
    const n = face.n, t1 = Math.abs(n[2]) > 0.5 ? [1, 0, 0] : [0, 0, 1], t2 = v3.cross(n, t1);
    // Faces com cantos chanfrados: o cubo do 3DE.
    const k = 0.72, corners = [[1, k], [k, 1], [-k, 1], [-1, k], [-1, -k], [-k, -1], [k, -1], [1, -k]]
      .map(([a, b]) => v3.add(n, v3.add(v3.scale(t1, a), v3.scale(t2, b))));
    return { ...face, facing: -v3.dot(n, f), pts: corners.map(toScreen), center: toScreen(n) };
  }).filter(x => x.facing > 0.02).sort((a, b) => a.facing - b.facing);
  for (const face of faces) {
    c.beginPath();
    face.pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
    const hot = cubeHover === face.view, t = face.facing;
    c.fillStyle = hot ? CT.hot : `rgb(${Math.round(CT.face[0] + t * CT.gain[0])},${Math.round(CT.face[1] + t * CT.gain[1])},${Math.round(CT.face[2] + t * CT.gain[2])})`;
    c.fill();
    c.strokeStyle = hot ? CT.hotStroke : CT.stroke; c.lineWidth = 1.2; c.stroke();
    if (t > 0.35) {
      c.save();
      c.translate(...face.center);
      c.fillStyle = hot ? CT.hotText : CT.text; c.font = '700 8.5px Segoe UI, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.globalAlpha = Math.min(1, t * 1.4);
      c.fillText(face.label, 0, 0);
      c.restore();
    }
    cubeHits.push(face);
  }
  // Eixos com letras.
  const o = toScreen([-1.3, -1.3, -1]);
  for (const [d, col, label] of [[[1, 0, 0], '#ef5350', 'X'], [[0, 1, 0], '#61cc6b', 'Y'], [[0, 0, 1], '#5c8ffa', 'Z']]) {
    const e = toScreen(v3.add([-1.3, -1.3, -1], v3.scale(d, 0.75)));
    c.strokeStyle = col; c.lineWidth = 2; c.beginPath(); c.moveTo(...o); c.lineTo(...e); c.stroke();
    c.fillStyle = col; c.font = '700 9px Segoe UI, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(label, e[0] + (e[0] - o[0]) * 0.25, e[1] + (e[1] - o[1]) * 0.25);
  }
}
$('#cube').addEventListener('pointermove', (ev) => {
  const r = ev.target.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
  const face = [...cubeHits].reverse().find(fc => pointInPoly(x, y, fc.pts));
  const v = face ? face.view : null;
  if (v !== cubeHover) { cubeHover = v; drawCube(); }
});
$('#cube').addEventListener('pointerleave', () => { cubeHover = null; drawCube(); });
function pointInPoly(x, y, pts) {
  let r = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}
$('#cube').addEventListener('click', (ev) => {
  const r = ev.target.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
  for (const face of [...cubeHits].reverse()) if (pointInPoly(x, y, face.pts)) { setView(face.view); return; }
  setView('iso');
});

const VIEWS = {
  iso: [-50, 28], front: [-90, 0], back: [90, 0], right: [0, 0], left: [180, 0], top: [-90, 89.99], bottom: [-90, -89.99],
};
function setView(name, fit = true) {
  const [az, el] = VIEWS[name];
  cam.setView((az * Math.PI) / 180, (el * Math.PI) / 180);
  if (fit) fitView(false);
  drawLines();
}
function fitView(redraw = true) {
  const box = modelBox() || { min: [-50, -50, 0], max: [50, 50, 50] };
  cam.fit(box.min, box.max);
  if (redraw) drawLines();
}

/* =========================================================================
   Recursos e reconstrução
   ========================================================================= */
function featureIcon(f) {
  if (f.type === 'primitive') return f.shape;
  return { sketch: 'sketch', extrude: 'extrude', revolve: 'revolve', hole: 'hole', combine: 'combine', import: 'importm', move: 'move', mirror: 'mirror', pattern: 'pattern',
    fillet: 'fillet', chamfer: 'chamfer', shell: 'shell', split: 'split', scale: 'scale', sweep: 'sweep', pipe: 'pipe', loft: 'loft', coil: 'coil', thread: 'thread',
    offset_face: 'offsetface', remove: 'remove', bounding: 'bounding', cpattern: 'cpattern', surf_extrude: 'surfext', surf_revolve: 'surfrev', patch: 'patch',
    surf_loft: 'loft', surf_offset: 'surfoff', reverse_normal: 'flipn', thicken: 'thicken',
    insert_design: 'insertdesign', joint: 'joint' }[f.type] || 'part';
}
function nextName(prefix) {
  const names = new Set(state.features.map(f => f.name));
  let n = 1;
  while (names.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}
const SKETCH_TYPES = new Set(['extrude', 'revolve', 'hole', 'surf_extrude', 'surf_revolve', 'patch']);
const usesSketch = (f) => SKETCH_TYPES.has(f.type);
/** Todos os esboços que um recurso usa (perfil, caminho, seções). */
const sketchRefs = (f) => [f.sketch, f.profile, f.path, ...(f.sketches || [])].filter(Boolean);
const usedSketches = (list) => new Set(list.filter(usesSketch).map(f => f.sketch));

/** Recursos ativos até o marcador do histórico (os seguintes ficam em espera). */
const activeCount = () => (state.rollback === null ? state.features.length : Math.min(state.rollback, state.features.length));
function effectiveFeatures() {
  const e = state.edit, upto = state.features.slice(0, activeCount());
  if (!e) return upto;
  if (e.isNew) return [...upto, e.draft];
  // Editar um recurso mostra a peça como estava logo depois dele.
  const i = state.features.findIndex(f => f.id === e.draft.id);
  return state.features.slice(0, i + 1).map(f => (f.id === e.draft.id ? e.draft : f));
}
/** Novo recurso entra na posição do marcador (como no histórico de um CAD). */
function insertFeature(f) {
  if (state.rollback === null || state.rollback >= state.features.length) { state.features.push(f); state.rollback = null; return; }
  state.features.splice(state.rollback, 0, f);
  state.rollback++;
}

function regenerate() {
  const list = effectiveFeatures();
  let result;
  try { result = rebuild(list.filter(f => f.type !== 'import'), {}); }
  catch (error) { setStatus(`Erro ao reconstruir: ${error.message}`, true); return; }
  state.errors = result.errors;
  state.bodies = result.bodies;
  state.surfaces = result.surfaces || [];
  state.info = result.info || { joints: [] };
  state.clash = [];
  uploadMeshes();
  renderTree();
  drawLines();
  saveLocal();
  const first = Object.entries(result.errors)[0];
  if (first) { const f = list.find(x => x.id === first[0]); setStatus(`${f ? f.name : 'Recurso'}: ${first[1]}`, true); }
}

function snapshot() { return JSON.stringify({ name: state.name, features: state.features, nextId: state.nextId, configs: state.configs, rollback: state.rollback }); }
function pushUndo() { state.undo.push(snapshot()); if (state.undo.length > 80) state.undo.shift(); state.redo = []; }
function restore(json) {
  const d = JSON.parse(json);
  state.name = d.name; state.features = d.features; state.nextId = d.nextId; state.configs = d.configs || []; state.rollback = d.rollback ?? null;
  $('#docTitle').textContent = state.name;
  regenerate();
}
function undo() { if (state.mode !== 'idle' || !state.undo.length) return; state.redo.push(snapshot()); restore(state.undo.pop()); setStatus('Desfeito.'); }
function redo() { if (state.mode !== 'idle' || !state.redo.length) return; state.undo.push(snapshot()); restore(state.redo.pop()); setStatus('Refeito.'); }

/* =========================================================================
   Navegador (árvore)
   ========================================================================= */
const collapsed = new Set(['planes']);
function node(iconName, label, { id, lvl = 0, chev = null, cls = '', eye = null, err = false, onclick, ondblclick, oncontext } = {}) {
  const el = h('div', { class: `node lvl${lvl} ${cls} ${id && state.selected === id ? 'selected' : ''}`, 'data-id': id, title: label },
    h('span', { class: 'chev' }, chev === null ? '' : chev ? '▾' : '▸'), icon(iconName), h('span', { class: 'label' }, label),
    err ? h('span', { class: 'err', title: err }, '!') : null, eye);
  if (onclick) el.addEventListener('click', (e) => { e.stopPropagation(); onclick(); });
  if (ondblclick) el.addEventListener('dblclick', (e) => { e.stopPropagation(); ondblclick(); });
  if (oncontext) el.addEventListener('contextmenu', (e) => { e.preventDefault(); oncontext(e); });
  return el;
}
function eyeButton(name) {
  const off = state.hidden.has(name);
  return h('button', { class: 'eye', title: off ? 'Mostrar' : 'Ocultar', html: ICON[off ? 'eyeoff' : 'eye'],
    onclick: (e) => { e.stopPropagation(); off ? state.hidden.delete(name) : state.hidden.add(name); uploadMeshes(); renderTree(); drawLines(); } });
}
function renderTree() {
  const tree = $('#tree');
  tree.replaceChildren();
  const bodies = state.bodies.length + state.features.filter(f => f.type === 'import' && !f.suppressed).length;
  $('#bodyCount').textContent = `${bodies} ${bodies === 1 ? 'corpo' : 'corpos'}`;
  tree.append(node('part', state.name, { chev: true }));
  const toggle = (key) => () => { collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key); renderTree(); };
  tree.append(node('folderTree', 'Planos', { lvl: 1, chev: !collapsed.has('planes'), onclick: toggle('planes') }));
  if (!collapsed.has('planes')) for (const [k, p] of Object.entries(PLANES)) tree.append(node('plane', p.label, { lvl: 2, id: `plane:${k}`, onclick: () => select(`plane:${k}`) }));
  tree.append(node('origin', 'Origem', { lvl: 1 }));
  tree.append(node('folderTree', 'Corpos', { lvl: 1, chev: !collapsed.has('bodies'), onclick: toggle('bodies') }));
  if (!collapsed.has('bodies')) {
    for (const b of state.bodies) tree.append(node('body', b.name, { lvl: 2, eye: eyeButton(b.name) }));
    for (const f of state.features) if (f.type === 'import' && !f.suppressed) tree.append(node('body', f.name, { lvl: 2, eye: eyeButton(f.name) }));
  }
  if (state.surfaces.length) {
    tree.append(node('folderTree', `Superfícies (${state.surfaces.length})`, { lvl: 1, chev: !collapsed.has('surfaces'), onclick: toggle('surfaces') }));
    if (!collapsed.has('surfaces')) for (const s of state.surfaces) tree.append(node('surfext', s.name, { lvl: 2, eye: eyeButton(s.name) }));
  }
  if (state.info.joints?.length) tree.append(node('joint', `Juntas (${state.info.joints.length})`, { lvl: 1, onclick: driveJoints }));
  if (state.configs.length) tree.append(node('config', `Configurações (${state.configs.length})`, { lvl: 1, onclick: showConfigs }));
  tree.append(node('folderTree', 'Recursos', { lvl: 1, chev: !collapsed.has('features'), onclick: toggle('features') }));
  renderTimeline();
  if (collapsed.has('features')) return;
  const used = usedSketches(state.features);
  const sketches = new Map(state.features.filter(f => f.type === 'sketch').map(f => [f.id, f]));
  const active = activeCount();
  for (const [index, f] of state.features.entries()) {
    if (f.type === 'sketch' && used.has(f.id)) continue;
    tree.append(node(featureIcon(f), f.name, { lvl: 2, id: f.id, cls: `${f.suppressed ? 'off' : ''} ${index >= active ? 'rolled' : ''}`, err: state.errors[f.id],
      onclick: () => select(f.id), ondblclick: () => editFeature(f.id), oncontext: (e) => { select(f.id); contextMenu(e.clientX, e.clientY, f.id); } }));
    if (usesSketch(f) && sketches.has(f.sketch)) {
      const sk = sketches.get(f.sketch);
      const n = node('sketch', sk.name, { lvl: 2, id: sk.id, onclick: () => select(sk.id), ondblclick: () => editFeature(sk.id),
        oncontext: (e) => { select(sk.id); contextMenu(e.clientX, e.clientY, sk.id); } });
      n.style.paddingLeft = '60px';
      tree.append(n);
    }
  }
}

let planeHint = null;
function select(id) {
  if (state.mode !== 'idle') return;
  state.selected = id;
  for (const n of document.querySelectorAll('#tree .node')) n.classList.toggle('selected', n.dataset.id === id);
  planeHint = id?.startsWith('plane:') ? { plane: id.slice(6), offset: 0 } : null;
  uploadMeshes();
  drawLines();
  const f = state.features.find(x => x.id === id);
  if (f) setStatus(`${f.name}: duplo clique edita; botão direito mostra mais opções.`);
  else if (planeHint) setStatus(`${PLANES[planeHint.plane].label} selecionado. Clique em Novo esboço para desenhar nele.`);
}

function contextMenu(x, y, id) {
  closeMenus();
  const f = state.features.find(v => v.id === id);
  if (!f || state.mode !== 'idle') return;
  const item = (label, run, cls = '') => h('button', { class: cls, onclick: () => { closeMenus(); run(); } }, label);
  const i = state.features.indexOf(f);
  document.body.append(h('div', { class: 'menu', id: 'ctxmenu', style: `position:fixed;left:${x}px;top:${y}px` },
    f.type !== 'import' ? item('Editar recurso', () => editFeature(id)) : null,
    item(f.suppressed ? 'Reativar' : 'Suprimir', () => toggleSuppress(id)),
    item('Voltar o histórico até aqui', () => setRollback(i + 1)),
    item('Renomear', () => { const n = prompt('Novo nome:', f.name); if (n) { pushUndo(); f.name = n.trim(); renderTree(); } }),
    item('Duplicar', () => duplicateFeature(id)),
    i > 0 ? item('Mover para antes', () => reorderFeature(id, -1)) : null,
    i < state.features.length - 1 ? item('Mover para depois', () => reorderFeature(id, 1)) : null,
    item('Dependentes', () => showDependents(id)),
    h('hr'), item('Excluir', () => deleteFeature(id))));
}
/** Recursos que usam o recurso id (esboço usado, corpo criado...). */
function dependentsOf(id) {
  const f = state.features.find(x => x.id === id);
  if (!f) return [];
  if (f.type === 'sketch') return state.features.filter(x => sketchRefs(x).includes(id));
  const after = state.features.slice(state.features.indexOf(f) + 1);
  return after.filter(x => !['sketch', 'import'].includes(x.type) && !usesSketch(x) || (usesSketch(x) && x.operation && x.operation !== 'new'));
}
function showDependents(id) {
  const f = state.features.find(x => x.id === id), list = dependentsOf(id);
  openProps(`Dependentes: ${f.name}`, [list.length ? fieldset('Recursos que dependem deste', ...list.map(x => h('div', { class: 'entity' }, x.name)))
    : h('p', { class: 'note' }, 'Nenhum recurso depende deste.'), h('p', { class: 'note' }, 'Mudar ou excluir este recurso recalcula os dependentes.')], { confirm: false });
}
function duplicateFeature(id) {
  const f = state.features.find(x => x.id === id);
  if (!f) return;
  pushUndo();
  const copy = structuredClone(f);
  copy.id = newId(); copy.name = nextName(`${f.name.replace(/\d+$/, '')} (cópia) `).trim();
  state.features.splice(state.features.indexOf(f) + 1, 0, copy);
  if (f.type === 'import') state.imports.set(copy.id, state.imports.get(f.id));
  regenerate();
  setStatus(`${copy.name} criado.`);
}
/** Muda a ordem do recurso, sem deixar um recurso antes do esboço que ele usa. */
function reorderFeature(id, dir) {
  const i = state.features.findIndex(x => x.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= state.features.length) return;
  const a = state.features[i], b = state.features[j];
  const [first, second] = dir < 0 ? [b, a] : [a, b];
  if (sketchRefs(second).includes(first.id)) { setStatus(`${second.name} usa ${first.name}: não pode vir antes dele.`, true); return; }
  pushUndo();
  state.features[i] = b; state.features[j] = a;
  regenerate();
  setStatus(`${a.name} movido.`);
}
function closeMenus() { $('#ctxmenu')?.remove(); $('#fileMenu').classList.add('hidden'); }
window.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu') && !e.target.closest('#fileMenuBtn')) closeMenus(); });

/* ---- Linha do tempo do histórico ---- */
function setRollback(n) {
  if (state.mode !== 'idle') return;
  const total = state.features.length, v = Math.max(0, Math.min(total, n));
  state.rollback = v >= total ? null : v;
  regenerate();
  setStatus(state.rollback === null ? 'Histórico no fim: todos os recursos ativos.' : `Histórico no passo ${v} de ${total}: novos recursos entram aqui.`);
}
function renderTimeline() {
  const track = $('#tlTrack'), active = activeCount();
  if (!state.features.length) { track.replaceChildren(h('span', { class: 'tl-empty' }, 'Os recursos da peça aparecem aqui, na ordem em que foram criados.')); return; }
  const marker = h('button', { class: 'tl-marker', title: 'Arraste para voltar ou avançar no histórico' });
  marker.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const move = (ev) => {
      const items = [...track.querySelectorAll('.tl-item')];
      let n = items.findIndex(it => { const r = it.getBoundingClientRect(); return ev.clientX < r.left + r.width / 2; });
      if (n < 0) n = items.length;
      if (n !== activeCount()) setRollback(n);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
  const items = [];
  state.features.forEach((f, i) => {
    if (i === active) items.push(marker);
    const el = h('button', { class: `tl-item ${state.selected === f.id ? 'selected' : ''} ${f.suppressed ? 'off' : ''} ${i >= active ? 'after' : ''} ${state.errors[f.id] ? 'err' : ''}`,
      title: `${i + 1}. ${f.name}${state.errors[f.id] ? ` — ${state.errors[f.id]}` : ''}`, html: ICON[featureIcon(f)] || ICON.part });
    el.addEventListener('click', () => { select(f.id); renderTimeline(); });
    el.addEventListener('dblclick', () => editFeature(f.id));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); select(f.id); contextMenu(e.clientX, e.clientY - 150, f.id); });
    items.push(el);
  });
  if (active >= state.features.length) items.push(marker);
  track.replaceChildren(...items);
  const x = marker.offsetLeft - track.offsetLeft;
  if (x < track.scrollLeft || x > track.scrollLeft + track.clientWidth - 20) track.scrollLeft = Math.max(0, x - track.clientWidth / 2);
}

function toggleSuppress(id) {
  const f = state.features.find(x => x.id === id);
  if (!f) return;
  pushUndo(); f.suppressed = !f.suppressed; regenerate();
  setStatus(f.suppressed ? `${f.name} suprimido.` : `${f.name} reativado.`);
}
function deleteFeature(id) {
  const f = state.features.find(x => x.id === id);
  if (!f) return;
  pushUndo();
  state.rollback = null;
  const remove = new Set([id]);
  if (usesSketch(f) && !state.features.some(x => x.sketch === f.sketch && x.id !== id)) remove.add(f.sketch);
  if (f.type === 'sketch') state.features.filter(x => sketchRefs(x).includes(id)).forEach(x => remove.add(x.id));
  state.features = state.features.filter(x => !remove.has(x.id));
  state.selected = null;
  regenerate();
  setStatus(`${f.name} excluído.`);
}

/* =========================================================================
   Propriedades
   ========================================================================= */
function openProps(title, content, { confirm = true } = {}) {
  $('#propsTitle').textContent = title;
  $('#propsBody').replaceChildren(h('div', { class: 'pm' }, content));
  $('#props').classList.remove('hidden');
  $('#navigator').classList.add('hidden');   // as propriedades ocupam o lugar do navegador
  $('#props .actions').classList.toggle('hidden', !confirm);
  if (!confirm) $('#props .actions').classList.remove('hidden'), $('#okBtn').classList.add('hidden');
  else $('#okBtn').classList.remove('hidden');
  fillIcons($('#propsBody'));
}
function closeProps() {
  $('#props').classList.add('hidden'); $('#navigator').classList.remove('hidden');
  if (state.clash.length) { state.clash = []; uploadMeshes(); requestRender(); }
  clearComMarker();
  stopDrive();
}

function numberField(label, value, onchange, { min, step = 0.1, unit = 'mm' } = {}) {
  const input = h('input', { type: 'number', value: Number(value).toFixed(3).replace(/\.?0+$/, ''), step, min });
  input.addEventListener('input', () => { const v = Number(input.value); if (Number.isFinite(v)) onchange(v); });
  return h('label', {}, `${label}${unit ? ` (${unit})` : ''}`, input);
}
function selectField(label, value, options, onchange) {
  const sel = h('select', {}, options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t)));
  sel.addEventListener('change', () => onchange(sel.value));
  return h('label', {}, label, sel);
}
function checkField(label, value, onchange) {
  const box = h('input', { type: 'checkbox', checked: value });
  box.addEventListener('change', () => onchange(box.checked));
  return h('label', {}, label, box);
}
const fieldset = (legend, ...children) => h('fieldset', {}, h('legend', {}, legend), ...children);

/* ---- Criação e edição de recursos ---- */
function pickSketch() {
  const sel = state.features.find(f => f.id === state.selected && f.type === 'sketch');
  if (sel) return sel;
  const used = usedSketches(state.features);
  return [...state.features].reverse().find(f => f.type === 'sketch' && !used.has(f.id)) || null;
}

const FEATURE_PREFIX = { extrude: 'Extrusão', revolve: 'Revolução', hole: 'Furo', move: 'Mover', mirror: 'Espelhar', pattern: 'Padrão',
  fillet: 'Concordância', chamfer: 'Chanfro', shell: 'Casca', combine: 'Combinar', split: 'Dividir', scale: 'Escala',
  box: 'Caixa', cylinder: 'Cilindro', sphere: 'Esfera', torus: 'Toro', cone: 'Cone', tube: 'Tubo', prism: 'Prisma', wedge: 'Cunha',
  sweep: 'Varredura', pipe: 'Tubo varrido', loft: 'Transição', coil: 'Mola', thread: 'Rosca', offset_face: 'Deslocar face', remove: 'Remover',
  bounding: 'Sólido envolvente', cpattern: 'Padrão circular', surf_extrude: 'Superfície extrudada', surf_revolve: 'Superfície de revolução', patch: 'Remendo',
  surf_loft: 'Superfície de transição', surf_offset: 'Superfície deslocada', reverse_normal: 'Inverter normal', thicken: 'Espessar',
  insert_design: 'Componente', joint: 'Junta' };
const PRIMITIVE_DEFAULTS = { box: { w: 40, d: 30, h: 20 }, cylinder: { r: 15, h: 30 }, sphere: { r: 15 }, torus: { R: 25, r: 6 },
  cone: { r: 15, r2: 0, h: 30 }, tube: { r: 15, ri: 10, h: 30 }, prism: { r: 15, n: 6, h: 20 }, wedge: { w: 40, d: 20, h: 20 } };
const surfaceNames = () => (state.edit?.beforeSurfaces || state.surfaces).map(s => [s.name, s.name]);
const sketchList = () => state.features.filter(f => f.type === 'sketch');
/** Esboços com caminho aberto (linha aberta ou arco) primeiro: servem de trajetória. */
const pathSketch = () => sketchList().slice().reverse().find(s => sketchPaths(s).length) || sketchList().at(-1);
function startFeature(type, shape) {
  if (state.mode !== 'idle') return;
  let draft;
  state.lastCmd = () => startFeature(type, shape);
  const needBody = () => { if (!state.bodies.length) { setStatus('Crie um sólido antes de usar este comando.', true); return false; } return true; };
  const needSketches = (n, what) => { if (sketchList().length < n) { setStatus(`${what} precisa de ${n === 1 ? 'um esboço' : `${n} esboços`}. Crie com Novo esboço.`, true); return false; } return true; };
  const box = () => modelBox() || { min: [0, 0, 0], max: [0, 0, 0] };
  const base = (t, extra) => ({ id: newId(), type: t, name: nextName(FEATURE_PREFIX[t]), ...extra });
  const simple = {
    sweep: () => needSketches(2, 'A varredura') && base('sweep', { profile: sketchList().find(s => s.id !== pathSketch().id)?.id, path: pathSketch().id, operation: state.bodies.length ? 'join' : 'new' }),
    pipe: () => {
      // O tubo segue uma linha aberta ou arco; um contorno fechado não serve de caminho.
      const paths = sketchList().filter(s => sketchPaths(s).length);
      if (!paths.length) { setStatus('O tubo precisa de um esboço com linha aberta ou arco (caminho). Crie com Novo esboço.', true); return null; }
      return base('pipe', { path: paths.at(-1).id, d: 10, di: 6, operation: state.bodies.length ? 'join' : 'new' });
    },
    loft: () => needSketches(2, 'A transição') && base('loft', { sketches: sketchList().slice(-2).map(s => s.id), operation: state.bodies.length ? 'join' : 'new' }),
    coil: () => base('coil', { R: 15, d: 3, pitch: 8, turns: 5, section: 'circle', axis: 'z', x: 0, y: 0, z: 0, operation: state.bodies.length ? 'join' : 'new' }),
    thread: () => needBody() && (() => { const b = box(); const r = Math.round(Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1]) * 50) / 100 || 10;
      return base('thread', { d: 2 * r, pitch: Math.max(0.5, Math.round(r * 0.3 * 4) / 4), length: Math.round((b.max[2] - b.min[2]) * 0.8), axis: 'z', x: Math.round((b.min[0] + b.max[0]) * 50) / 100, y: Math.round((b.min[1] + b.max[1]) * 50) / 100, z: Math.round(b.min[2] * 100) / 100 }); })(),
    offset_face: () => needBody() && base('offset_face', { distance: 5, face: null, body: state.bodies[0].name }),
    remove: () => (state.bodies.length || state.surfaces.length) ? base('remove', { body: (state.bodies[0] || state.surfaces[0]).name }) : (setStatus('Não há corpos para remover.', true), null),
    bounding: () => needBody() && base('bounding', { margin: 0 }),
    cpattern: () => needBody() && base('cpattern', { axis: 'z', c1: 0, c2: 0, count: 6, angle: 360, body: '*' }),
    surf_extrude: () => needSketches(1, 'A superfície') && base('surf_extrude', { sketch: pickSketch()?.id || sketchList().at(-1).id, distance: 20, direction: 'normal' }),
    surf_revolve: () => needSketches(1, 'A superfície') && base('surf_revolve', { sketch: pickSketch()?.id || sketchList().at(-1).id, angle: 360 }),
    patch: () => needSketches(1, 'O remendo') && base('patch', { sketch: pickSketch()?.id || sketchList().at(-1).id }),
    surf_loft: () => needSketches(2, 'A transição') && base('surf_loft', { sketches: sketchList().slice(-2).map(s => s.id) }),
    surf_offset: () => state.surfaces.length ? base('surf_offset', { surface: state.surfaces[0].name, distance: 5 }) : (setStatus('Crie uma superfície primeiro.', true), null),
    reverse_normal: () => state.surfaces.length ? base('reverse_normal', { surface: state.surfaces[0].name }) : (setStatus('Crie uma superfície primeiro.', true), null),
    thicken: () => state.surfaces.length ? base('thicken', { surface: state.surfaces[0].name, thickness: 2, operation: state.bodies.length ? 'join' : 'new' }) : (setStatus('Crie uma superfície primeiro.', true), null),
    joint: () => needBody() && base('joint', { body: state.bodies.at(-1).name, kind: 'revolute', axis: 'z', ox: 0, oy: 0, oz: 0, value: 0, min: 0, max: 90 }),
  };
  if (simple[type]) {
    const d = simple[type]();
    if (!d) return;
    beginEdit(d, null, true);
    if (type === 'offset_face') setStatus('Deslocar face: clique na face da peça e ajuste a distância (negativa retira material).');
    return;
  }
  if (type === 'primitive') {
    draft = { id: newId(), type, shape, name: nextName(FEATURE_PREFIX[shape]), x: 0, y: 0, z: 0, ...PRIMITIVE_DEFAULTS[shape], operation: state.bodies.length ? 'join' : 'new' };
    beginEdit(draft, null, true); return;
  }
  if (type === 'fillet' || type === 'chamfer') {
    if (!needBody()) return;
    beginEdit({ id: newId(), type, name: nextName(FEATURE_PREFIX[type]), size: 3, edges: [] }, null, true);
    setStatus(`${FEATURE_PREFIX[type]}: clique nas arestas da peça (clique de novo para tirar).`); return;
  }
  if (type === 'shell') {
    if (!needBody()) return;
    beginEdit({ id: newId(), type, name: nextName('Casca'), thickness: 2, openFaces: [], body: state.bodies[0].name }, null, true);
    setStatus('Casca: clique nas faces que devem ficar abertas (ou confirme para uma casca fechada).'); return;
  }
  if (type === 'combine') {
    if (state.bodies.length < 2) { setStatus('Combinar precisa de pelo menos dois corpos.', true); return; }
    beginEdit({ id: newId(), type, name: nextName('Combinar'), target: state.bodies[0].name, tools: [state.bodies[1].name], operation: 'join' }, null, true); return;
  }
  if (type === 'split' || type === 'scale') {
    if (!needBody()) return;
    const box = modelBox();
    beginEdit(type === 'split' ? { id: newId(), type, name: nextName('Dividir'), axis: 'z', at: Math.round(((box.min[2] + box.max[2]) / 2) * 100) / 100 }
      : { id: newId(), type, name: nextName('Escala'), factor: 2, about: 'center' }, null, true); return;
  }
  if (usesSketch({ type })) {
    const sk = pickSketch();
    if (!sk) { setStatus('Crie ou selecione um esboço primeiro (Novo esboço).', true); return; }
    draft = { id: newId(), type, name: nextName(FEATURE_PREFIX[type]), sketch: sk.id, operation: state.bodies.length ? 'join' : 'new', distance: 10, direction: 'normal', angle: 360 };
    // Corte extrudado / revolucionado: a mesma operação, já no modo de retirar material.
    if (shape === 'cut') {
      if (!state.bodies.length) { setStatus('O corte precisa de um sólido para retirar material.', true); return; }
      Object.assign(draft, { operation: 'cut', name: nextName(type === 'revolve' ? 'Corte revolucionado' : 'Corte extrudado'), direction: type === 'extrude' ? 'symmetric' : draft.direction, distance: 20 });
    }
  } else {
    if (!state.bodies.length) { setStatus('Crie um sólido antes de usar este comando.', true); return; }
    const box = modelBox(), size = box ? v3.sub(box.max, box.min) : [20, 20, 20];
    draft = { id: newId(), type, name: nextName(FEATURE_PREFIX[type]), dx: type === 'pattern' ? Math.round(size[0] * 1.2) : 0, dy: 0, dz: 0,
      copy: false, axis: 'x', at: box ? Math.round(box.max[0] * 100) / 100 : 0, count: 3 };
  }
  beginEdit(draft, null, true);
}
function editFeature(id) {
  if (state.mode !== 'idle') return;
  const f = state.features.find(x => x.id === id);
  if (!f) return;
  if (f.type === 'sketch') { enterSketch(f, false); return; }
  if (f.type !== 'import') beginEdit(structuredClone(f), f, false);
}
/** Corpos como estavam antes do recurso (a seleção de arestas e faces usa essa geometria). */
const PICK_TYPES = ['fillet', 'chamfer', 'shell', 'offset_face'];
function bodiesBefore(draft, original, isNew) {
  if (![...PICK_TYPES, 'combine', 'remove', 'cpattern', 'joint', 'surf_offset', 'reverse_normal', 'thicken'].includes(draft.type)) return null;
  const idx = isNew ? activeCount() : state.features.indexOf(original);
  return rebuild(state.features.slice(0, idx).filter(f => f.type !== 'import'));
}
const bodyNames = () => (state.edit?.before?.bodies || state.bodies).map(b => [b.name, b.name]);
function beginEdit(draft, original, isNew) {
  planeHint = null;
  state.mode = 'feature';
  const prior = bodiesBefore(draft, original, isNew);
  state.edit = { draft, original, isNew, before: prior?.bodies || null, beforeSurfaces: prior?.surfaces || null, beforeAll: prior };
  state.hover = null;
  renderRibbon();
  renderFeaturePM();
  regenerate();
  setStatus(`${draft.name}: ajuste os parâmetros e confirme com ✓.`);
}
let previewFrame = 0;
const previewSoon = () => { cancelAnimationFrame(previewFrame); previewFrame = requestAnimationFrame(regenerate); };

function renderFeaturePM() {
  const d = state.edit.draft;
  const parts = [];
  if (usesSketch(d)) {
    const sketches = state.features.filter(f => f.type === 'sketch');
    parts.push(fieldset('Perfil', selectField('Esboço', d.sketch, sketches.map(s => [s.id, s.name]), v => { d.sketch = v; previewSoon(); })));
  }
  if (d.type === 'extrude') {
    parts.push(fieldset('Extensão',
      selectField('Direção', d.direction, [['normal', 'Um lado'], ['symmetric', 'Simétrica'], ['reverse', 'Invertida']], v => { d.direction = v; previewSoon(); }),
      numberField('Distância', d.distance, v => { d.distance = v; previewSoon(); }, { min: 0.01, step: 1 })));
  }
  if (d.type === 'revolve') {
    parts.push(fieldset('Rotação', h('p', { class: 'note' }, 'O eixo é o eixo vertical do esboço, passando pela origem.'),
      numberField('Ângulo', d.angle, v => { d.angle = v; previewSoon(); }, { min: 1, step: 5, unit: '°' })));
  }
  if (d.type === 'extrude' || d.type === 'revolve') {
    parts.push(fieldset('Operação', selectField('Resultado', d.operation, [['new', 'Novo corpo'], ['join', 'Unir'], ['cut', 'Cortar'], ['intersect', 'Interseção']], v => { d.operation = v; previewSoon(); })));
  }
  if (d.type === 'hole') {
    d.depth_mode ||= 'through';
    parts.push(fieldset('Profundidade', selectField('Tipo', d.depth_mode, [['through', 'Passante (atravessa tudo)'], ['blind', 'Cego (até uma profundidade)']], v => { d.depth_mode = v; renderFeaturePM(); previewSoon(); }),
      d.depth_mode === 'blind' ? numberField('Profundidade', d.depth ?? 10, v => { d.depth = v; previewSoon(); }, { min: 0.01, step: 1 }) : null,
      d.depth_mode === 'blind' ? selectField('Sentido', d.direction, [['normal', 'Para dentro (contra a normal)'], ['reverse', 'Para fora (a favor da normal)']], v => { d.direction = v; previewSoon(); }) : null),
    h('p', { class: 'note' }, 'Cada contorno do esboço vira um furo que corta todos os corpos.'));
    if (d.depth === undefined) d.depth = 10;
  }
  renderExtraPM(d, parts);
  if (d.type === 'move') {
    parts.push(fieldset('Deslocamento',
      numberField('X', d.dx, v => { d.dx = v; previewSoon(); }, { step: 1 }), numberField('Y', d.dy, v => { d.dy = v; previewSoon(); }, { step: 1 }),
      numberField('Z', d.dz, v => { d.dz = v; previewSoon(); }, { step: 1 }), checkField('Manter o original (copiar)', d.copy, v => { d.copy = v; previewSoon(); })));
  }
  if (d.type === 'mirror') {
    parts.push(fieldset('Plano de simetria',
      selectField('Perpendicular a', d.axis, [['x', 'X (paralelo ao Plano Direito)'], ['y', 'Y (paralelo ao Plano Frontal)'], ['z', 'Z (paralelo ao Plano Superior)']], v => { d.axis = v; previewSoon(); }),
      numberField('Posição', d.at, v => { d.at = v; previewSoon(); }, { step: 1 })));
  }
  if (d.type === 'pattern') {
    parts.push(fieldset('Padrão linear',
      numberField('Quantidade', d.count, v => { d.count = v; previewSoon(); }, { min: 1, step: 1, unit: '' }),
      numberField('Passo X', d.dx, v => { d.dx = v; previewSoon(); }, { step: 1 }), numberField('Passo Y', d.dy, v => { d.dy = v; previewSoon(); }, { step: 1 }),
      numberField('Passo Z', d.dz, v => { d.dz = v; previewSoon(); }, { step: 1 })));
  }
  const ops = [['new', 'Novo corpo'], ['join', 'Unir'], ['cut', 'Cortar'], ['intersect', 'Interseção']];
  if (d.type === 'primitive') {
    const dims = { box: [['w', 'Largura (X)'], ['d', 'Profundidade (Y)'], ['h', 'Altura (Z)']], cylinder: [['r', 'Raio'], ['h', 'Altura']],
      sphere: [['r', 'Raio']], torus: [['R', 'Raio do toro'], ['r', 'Raio do tubo']], cone: [['r', 'Raio da base'], ['r2', 'Raio do topo (0 = ponta)'], ['h', 'Altura']],
      tube: [['r', 'Raio externo'], ['ri', 'Raio interno'], ['h', 'Altura']], prism: [['r', 'Raio (vértice)'], ['n', 'Lados'], ['h', 'Altura']],
      wedge: [['w', 'Comprimento (X)'], ['d', 'Largura (Y)'], ['h', 'Altura (Z)']] }[d.shape];
    parts.push(fieldset('Medidas', ...dims.map(([k, label]) => numberField(label, d[k], v => { d[k] = v; previewSoon(); }, { min: k === 'r2' ? 0 : 0.01, step: 1, unit: k === 'n' ? '' : 'mm' }))));
    parts.push(fieldset('Posição da base', ...['x', 'y', 'z'].map(k => numberField(k.toUpperCase(), d[k], v => { d[k] = v; previewSoon(); }, { step: 1 }))));
    parts.push(fieldset('Operação', selectField('Resultado', d.operation, ops, v => { d.operation = v; previewSoon(); })));
  }
  if (d.type === 'fillet' || d.type === 'chamfer') {
    const box = h('div', { class: 'picks' }, d.edges.length ? d.edges.map((e, i) => h('div', { class: 'chip' }, `Aresta ${i + 1} · ${fmt(v3.dist(e.a, e.b))} mm`,
      h('button', { title: 'Tirar', onclick: () => { d.edges.splice(i, 1); renderFeaturePM(); previewSoon(); } }, '✕'))) : h('div', { class: 'pickbox on' }, 'Clique nas arestas da peça'));
    parts.push(fieldset(`Arestas (${d.edges.length})`, box),
      fieldset(d.type === 'fillet' ? 'Arredondamento' : 'Chanfro', numberField(d.type === 'fillet' ? 'Raio' : 'Distância', d.size, v => { d.size = v; previewSoon(); }, { min: 0.01, step: 0.5 })),
      h('p', { class: 'note' }, 'Funciona em arestas retas entre faces planas. Numa aresta interna (côncava), o material é acrescentado.'));
  }
  if (d.type === 'shell') {
    const faces = h('div', { class: 'picks' }, d.openFaces.length ? d.openFaces.map((o, i) => h('div', { class: 'chip' }, `Face aberta ${i + 1} · normal ${o.n.map(x => fmt(x, 2)).join('; ')}`,
      h('button', { title: 'Tirar', onclick: () => { d.openFaces.splice(i, 1); renderFeaturePM(); previewSoon(); } }, '✕'))) : h('div', { class: 'pickbox on' }, 'Clique nas faces que ficarão abertas'));
    parts.push(fieldset('Corpo', selectField('Corpo', d.body, bodyNames(), v => { d.body = v; previewSoon(); })),
      fieldset(`Faces abertas (${d.openFaces.length})`, faces),
      fieldset('Parede', numberField('Espessura', d.thickness, v => { d.thickness = v; previewSoon(); }, { min: 0.01, step: 0.5 })));
  }
  if (d.type === 'combine') {
    const names = bodyNames();
    parts.push(fieldset('Corpos', selectField('Corpo alvo', d.target, names, v => { d.target = v; d.tools = d.tools.filter(t => t !== v); renderFeaturePM(); previewSoon(); }),
      ...names.filter(([n]) => n !== d.target).map(([n]) => checkField(`Ferramenta: ${n}`, d.tools.includes(n), on => { d.tools = on ? [...d.tools, n] : d.tools.filter(t => t !== n); previewSoon(); }))),
    fieldset('Operação', selectField('Resultado', d.operation, [['join', 'Unir'], ['cut', 'Cortar'], ['intersect', 'Interseção']], v => { d.operation = v; previewSoon(); })));
  }
  if (d.type === 'split') {
    parts.push(fieldset('Plano de divisão', selectField('Perpendicular a', d.axis, [['x', 'X'], ['y', 'Y'], ['z', 'Z']], v => { d.axis = v; previewSoon(); }),
      numberField('Posição', d.at, v => { d.at = v; previewSoon(); }, { step: 1 })), h('p', { class: 'note' }, 'Cada corpo atravessado pelo plano vira dois corpos.'));
  }
  if (d.type === 'scale') {
    parts.push(fieldset('Escala', numberField('Fator', d.factor, v => { d.factor = v; previewSoon(); }, { min: 0.01, step: 0.1, unit: '×' }),
      selectField('Em torno de', d.about, [['center', 'Centro de cada corpo'], ['origin', 'Origem']], v => { d.about = v; previewSoon(); })));
  }
  const name = h('input', { type: 'text', value: d.name });
  name.addEventListener('change', () => { if (name.value.trim()) d.name = name.value.trim(); });
  parts.push(fieldset('Nome', h('label', { class: 'wide' }, name)));
  openProps(d.name, parts);
}
/** Painéis dos recursos novos (varredura, superfícies, chapa, soldagem, montagem...). */
function renderExtraPM(d, parts) {
  const set = (k, num = true) => (v) => { d[k] = num ? Number(v) : v; previewSoon(); };
  const n = (label, k, o = {}) => numberField(label, d[k], set(k), { step: 1, ...o });
  const ops = [['new', 'Novo corpo'], ['join', 'Unir'], ['cut', 'Cortar'], ['intersect', 'Interseção']];
  const opField = () => fieldset('Operação', selectField('Resultado', d.operation, ops, set('operation', false)));
  const sketches = sketchList().map(s => [s.id, s.name]);
  const axisSel = (label = 'Eixo') => selectField(label, d.axis, [['x', 'X'], ['y', 'Y'], ['z', 'Z']], v => { d.axis = v; renderFeaturePM(); previewSoon(); });
  const other = () => { const a = { x: ['Y', 'Z'], y: ['Z', 'X'], z: ['X', 'Y'] }[d.axis || 'z']; return a; };
  switch (d.type) {
    case 'sweep':
      parts.push(fieldset('Varredura', selectField('Perfil (contorno fechado)', d.profile, sketches, set('profile', false)), selectField('Caminho (linha aberta, arco ou contorno)', d.path, sketches, set('path', false)),
        h('p', { class: 'note' }, 'O perfil percorre o caminho sem torcer. Desenhe o perfil num plano perpendicular ao início do caminho.')), opField());
      break;
    case 'pipe':
      parts.push(fieldset('Tubo', selectField('Caminho', d.path, sketches, set('path', false)), n('Diâmetro externo', 'd', { min: 0.01 }), n('Diâmetro interno (0 = maciço)', 'di', { min: 0 })), opField());
      break;
    case 'loft': case 'surf_loft':
      parts.push(fieldset(`Perfis da transição (${d.sketches.length})`, ...sketches.map(([id, label]) => checkField(label, d.sketches.includes(id), on => {
        d.sketches = on ? sketchList().map(s => s.id).filter(x => x === id || d.sketches.includes(x)) : d.sketches.filter(x => x !== id); renderFeaturePM(); previewSoon();
      })), h('p', { class: 'note' }, 'Um contorno fechado por esboço, em planos paralelos e diferentes (use Plano deslocado). A ordem segue a árvore.')));
      if (d.type === 'loft') parts.push(opField());
      break;
    case 'coil':
      parts.push(fieldset('Mola', n('Raio médio', 'R', { min: 0.01 }), n('Diâmetro do arame', 'd', { min: 0.01, step: 0.5 }), n('Passo', 'pitch', { min: 0.01 }), n('Voltas', 'turns', { min: 0.25, step: 0.5, unit: '' }),
        selectField('Seção do arame', d.section, [['circle', 'Redonda'], ['square', 'Quadrada']], set('section', false))),
      fieldset('Posição', axisSel(), n('X', 'x'), n('Y', 'y'), n('Z', 'z')), opField());
      break;
    case 'thread':
      parts.push(fieldset('Rosca métrica (60°)', n('Diâmetro nominal', 'd', { min: 0.01, step: 0.5 }), n('Passo', 'pitch', { min: 0.1, step: 0.25 }), n('Comprimento', 'length', { min: 0.1 })),
        fieldset('Eixo do cilindro', axisSel(), n('X', 'x'), n('Y', 'y'), n('Início (Z)', 'z')),
        h('p', { class: 'note' }, 'O sulco helicoidal é cortado dos corpos. Use o diâmetro do cilindro como diâmetro nominal (ex.: M10 × 1,5).'));
      break;
    case 'offset_face':
      parts.push(fieldset('Face', d.face ? h('div', { class: 'chip' }, `Face · normal ${d.face.n.map(x => fmt(x, 2)).join('; ')}`) : h('div', { class: 'pickbox on' }, 'Clique numa face plana da peça')),
        fieldset('Deslocamento', n('Distância (negativa retira)', 'distance', { step: 0.5 })));
      break;
    case 'remove':
      parts.push(fieldset('Remover', selectField('Corpo ou superfície', d.body, [...bodyNames(), ...surfaceNames()], set('body', false)), h('p', { class: 'note' }, 'O corpo sai da peça a partir deste ponto do histórico.')));
      break;
    case 'bounding':
      parts.push(fieldset('Sólido envolvente', n('Folga em volta', 'margin', { min: 0 }), h('p', { class: 'note' }, 'Caixa que contém todos os corpos: útil para estimar matéria-prima.')));
      break;
    case 'cpattern':
      parts.push(fieldset('Padrão circular', selectField('Corpo', d.body, [['*', 'Todos os corpos'], ...bodyNames()], set('body', false)), axisSel('Eixo de rotação'),
        n(`Eixo passa por ${other()[0]}`, 'c1'), n(`Eixo passa por ${other()[1]}`, 'c2'), n('Quantidade', 'count', { min: 1, unit: '' }), n('Ângulo total', 'angle', { min: 1, step: 15, unit: '°' })));
      break;
    case 'surf_extrude':
      parts.push(fieldset('Extensão', selectField('Direção', d.direction, [['normal', 'Um lado'], ['symmetric', 'Simétrica'], ['reverse', 'Invertida']], set('direction', false)), n('Distância', 'distance', { min: 0.01 })),
        h('p', { class: 'note' }, 'Linhas abertas e contornos viram paredes sem espessura.'));
      break;
    case 'surf_revolve':
      parts.push(fieldset('Rotação', n('Ângulo', 'angle', { min: 1, step: 15, unit: '°' }), h('p', { class: 'note' }, 'Gira as linhas em torno do eixo vertical do esboço.')));
      break;
    case 'patch':
      parts.push(h('p', { class: 'note' }, 'Cada região fechada do esboço vira uma superfície plana.'));
      break;
    case 'surf_offset':
      parts.push(fieldset('Superfície deslocada', selectField('Superfície', d.surface, surfaceNames(), set('surface', false)), n('Distância', 'distance', { step: 0.5 })));
      break;
    case 'reverse_normal':
      parts.push(fieldset('Inverter normal', selectField('Superfície', d.surface, surfaceNames(), set('surface', false))));
      break;
    case 'thicken':
      parts.push(fieldset('Espessar', selectField('Superfície', d.surface, surfaceNames(), set('surface', false)), n('Espessura', 'thickness', { min: 0.01, step: 0.5 }),
        h('p', { class: 'note' }, 'A parede cresce para o lado de trás da superfície. Use Inverter normal para o outro lado.')), opField());
      break;
    case 'insert_design':
      parts.push(fieldset('Posição do componente', n('X', 'dx', { step: 5 }), n('Y', 'dy', { step: 5 }), n('Z', 'dz', { step: 5 }), n('Girar em Z', 'rz', { step: 15, unit: '°' })),
        h('p', { class: 'note' }, `Projeto inserido com ${d.design?.features?.length || 0} recursos.`));
      break;
    case 'joint':
      parts.push(fieldset('Junta', selectField('Corpo que se move', d.body, bodyNames(), set('body', false)),
        selectField('Tipo', d.kind, [['revolute', 'Revolução (gira)'], ['slider', 'Deslizante (translada)'], ['rigid', 'Rígida (fixa)']], v => { d.kind = v; renderFeaturePM(); previewSoon(); })),
      d.kind !== 'rigid' ? fieldset('Eixo e posição', axisSel(), n('Origem X', 'ox'), n('Origem Y', 'oy'), n('Origem Z', 'oz'),
        n(d.kind === 'revolute' ? 'Ângulo atual' : 'Posição atual', 'value', { unit: d.kind === 'revolute' ? '°' : 'mm' }),
        n('Limite mínimo', 'min', { unit: d.kind === 'revolute' ? '°' : 'mm' }), n('Limite máximo', 'max', { unit: d.kind === 'revolute' ? '°' : 'mm' })) : h('p', { class: 'note' }, 'A junta rígida prende o corpo na posição atual.'));
      break;
    default: break;
  }
}
function confirmEdit() {
  const { draft, original, isNew } = state.edit;
  if (state.errors[draft.id]) { setStatus(`Não foi possível aplicar: ${state.errors[draft.id]}`, true); return; }
  if (['fillet', 'chamfer'].includes(draft.type) && !draft.edges.length) { setStatus('Escolha pelo menos uma aresta.', true); return; }
  if (draft.type === 'offset_face' && !draft.face) { setStatus('Clique na face que será deslocada.', true); return; }
  pushUndo();
  if (isNew) insertFeature(draft); else Object.assign(original, draft);
  endMode();
  state.selected = draft.id;
  regenerate();
  setStatus(`${draft.name} ${isNew ? 'criado' : 'atualizado'}.`);
}

/* ---- Seleção de arestas (concordância, chanfro) e faces (casca) com o mouse ---- */
function pickTarget(px, py) {
  const d = state.edit?.draft;
  if (!d || !PICK_TYPES.includes(d.type)) return null;
  const hit = gfx.pick(px, py);
  if (!hit) return null;
  const before = state.edit.before || [];
  if (d.type === 'shell' || d.type === 'offset_face') {
    for (const b of before) { const face = faceAt(b.polys, hit); if (face) return { face, body: b.name, hit }; }
    return null;
  }
  const radius = Math.max(cam.mmPerPixel() * 10, (Number(d.size) || 0) * 1.6);
  let best = null;
  for (const b of before) {
    const e = edgeAt(b.polys, hit, radius);
    if (!e) continue;
    const ab = v3.sub(e.b, e.a), t = Math.max(0, Math.min(1, v3.dot(v3.sub(hit, e.a), ab) / v3.dot(ab, ab)));
    const dd = v3.dist(hit, v3.add(e.a, v3.scale(ab, t)));
    if (!best || dd < best.dd) best = { edge: e, dd };
  }
  return best ? { edge: best.edge, hit } : null;
}
const sameEdge = (e, f) => (v3.dist(e.a, f.a) < 1e-3 && v3.dist(e.b, f.b) < 1e-3) || (v3.dist(e.a, f.b) < 1e-3 && v3.dist(e.b, f.a) < 1e-3);
function featureClick(px, py) {
  const d = state.edit.draft, t = pickTarget(px, py);
  if (!t) return;
  if (t.edge) {
    const e = { a: t.edge.a, b: t.edge.b, nA: t.edge.nA, nB: t.edge.nB }, i = d.edges.findIndex(x => sameEdge(x, e));
    if (i >= 0) d.edges.splice(i, 1); else d.edges.push(e);
  } else if (t.face && d.type === 'offset_face') {
    d.face = t.face; d.body = t.body;
  } else if (t.face) {
    const i = d.openFaces.findIndex(o => v3.dot(o.n, t.face.n) > 0.9999 && Math.abs(o.w - t.face.w) < 1e-3);
    if (i >= 0) d.openFaces.splice(i, 1); else { d.openFaces.push(t.face); d.body = t.body; }
  }
  state.hover = null;
  renderFeaturePM();
  previewSoon();
}
let hoverFrame = 0;
function featureHover(px, py) {
  cancelAnimationFrame(hoverFrame);
  hoverFrame = requestAnimationFrame(() => {
    const t = pickTarget(px, py);
    state.hover = t?.edge || null;
    canvas.style.cursor = t ? 'pointer' : 'default';
    drawLines();
  });
}

/* ---- Parâmetros: todas as medidas da peça numa tabela ---- */
/** Todas as medidas editáveis da peça: [{ key, label, unit, get, set }]. */
const PARAM_LABEL = { distance: 'distância', angle: 'ângulo', offset: 'deslocamento', count: 'quantidade', dx: 'X', dy: 'Y', dz: 'Z', at: 'posição',
  size: 'tamanho', thickness: 'espessura', factor: 'fator', w: 'largura', d: 'diâmetro', h: 'altura', r: 'raio', R: 'raio', r2: 'raio do topo', ri: 'raio interno', n: 'lados',
  pitch: 'passo', turns: 'voltas', length: 'comprimento', di: 'diâmetro interno', height: 'altura', radius: 'raio de dobra', a: 'lado', t: 'parede', value: 'posição', margin: 'folga', depth: 'profundidade' };
function collectParams() {
  const out = [];
  const add = (f, key) => out.push({ key: `${f.id}.${key}`, label: `${f.name} · ${PARAM_LABEL[key] || key}`, unit: key === 'angle' ? '°' : key === 'count' ? '' : key === 'factor' ? '×' : 'mm',
    get: () => Number(f[key]), set: (v) => { f[key] = v; } });
  for (const f of state.features) {
    if (f.type === 'extrude') add(f, 'distance');
    if (f.type === 'revolve') add(f, 'angle');
    if (f.type === 'sketch') {
      if (f.offset) add(f, 'offset');
      f.entities.forEach((e, i) => { if (e.type === 'circle') out.push({ key: `${f.id}.e${i}.d`, label: `${f.name} · Ø${i + 1}`, unit: 'mm', get: () => e.d, set: (v) => { if (v > 0) e.d = v; } }); });
    }
    if (f.type === 'move' || f.type === 'pattern') ['dx', 'dy', 'dz'].forEach(k => add(f, k));
    if (f.type === 'pattern') add(f, 'count');
    if (f.type === 'mirror' || f.type === 'split') add(f, 'at');
    if (f.type === 'fillet' || f.type === 'chamfer') add(f, 'size');
    if (f.type === 'shell') add(f, 'thickness');
    if (f.type === 'scale') add(f, 'factor');
    if (f.type === 'primitive') Object.keys(PRIMITIVE_DEFAULTS[f.shape]).forEach(k => add(f, k));
    const more = { coil: ['R', 'd', 'pitch', 'turns'], thread: ['d', 'pitch', 'length'], pipe: ['d', 'di'], offset_face: ['distance'], cpattern: ['count', 'angle'],
      surf_extrude: ['distance'], surf_revolve: ['angle'], surf_offset: ['distance'], thicken: ['thickness'],
      joint: ['value'], bounding: ['margin'], hole: f.depth_mode === 'blind' ? ['depth'] : [] }[f.type] || [];
    more.forEach(k => add(f, k));
  }
  return out;
}
function showParameters() {
  if (state.mode !== 'idle') return;
  const rows = collectParams().map(p => numberField(p.label, p.get(), v => { p.set(v); regenerate(); }, { unit: p.unit, step: 1 }));
  pushUndo();
  openProps('Parâmetros', [rows.length ? fieldset('Medidas da peça', rows) : h('p', { class: 'note' }, 'A peça ainda não tem medidas.'),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: showConfigs }, 'Tabela de configurações…'))], { confirm: false });
  setStatus('Altere qualquer medida: a peça é recalculada na hora.');
}

/* ---- Tabela de configurações: variações da mesma peça (ex.: tamanhos P, M, G) ---- */
function showConfigs() {
  if (state.mode !== 'idle') return;
  const params = collectParams();
  const current = () => Object.fromEntries(params.map(p => [p.key, p.get()]));
  const isActive = (c) => params.every(p => !(p.key in c.values) || Math.abs(c.values[p.key] - p.get()) < 1e-9);
  const apply = (c) => { pushUndo(); for (const p of params) if (p.key in c.values) p.set(c.values[p.key]); regenerate(); showConfigs(); setStatus(`Configuração “${c.name}” aplicada.`); };
  const name = h('input', { type: 'text', placeholder: `Configuração ${state.configs.length + 1}` });
  const save = () => {
    const n = name.value.trim() || `Configuração ${state.configs.length + 1}`;
    pushUndo();
    const existing = state.configs.find(c => c.name === n);
    if (existing) existing.values = current(); else state.configs.push({ name: n, values: current() });
    renderTree(); showConfigs(); setStatus(`Configuração “${n}” salva com ${params.length} medidas.`);
  };
  const table = state.configs.length ? h('table', {}, h('tr', {}, h('th', {}, 'Nome'), h('th', {}, 'Medidas'), h('th', {}, '')),
    state.configs.map((c, i) => h('tr', {}, h('td', {}, `${isActive(c) ? '● ' : ''}${c.name}`), h('td', {}, String(Object.keys(c.values).length)),
      h('td', {}, h('button', { class: 'btn mini', onclick: () => apply(c) }, 'Aplicar'), ' ',
        h('button', { class: 'btn mini danger', title: 'Excluir', onclick: () => { pushUndo(); state.configs.splice(i, 1); renderTree(); showConfigs(); } }, '✕')))))
    : h('p', { class: 'note' }, 'Nenhuma configuração ainda. Ajuste as medidas em Parâmetros e salve cada variação da peça aqui.');
  const detail = state.configs.length ? fieldset('Comparação', h('table', {}, h('tr', {}, h('th', {}, 'Medida'), ...state.configs.map(c => h('th', {}, c.name))),
    params.filter(p => state.configs.some(c => p.key in c.values)).map(p => h('tr', {}, h('td', {}, p.label), ...state.configs.map(c => h('td', {}, p.key in c.values ? fmt(c.values[p.key]) : '—')))))) : null;
  openProps('Tabela de configurações', [fieldset('Configurações', table), fieldset('Salvar as medidas atuais', h('label', { class: 'wide' }, name),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: save }, 'Salvar configuração'))), detail], { confirm: false });
}

/* ---- Interferência: volume que dois corpos ocupam ao mesmo tempo ---- */
function checkInterference() {
  if (state.mode !== 'idle') return;
  const bodies = state.bodies.filter(b => !state.hidden.has(b.name));
  if (bodies.length < 2) { setStatus('A verificação de interferência precisa de pelo menos dois corpos visíveis.', true); return; }
  const rows = [], meshes = [];
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    const common = intersect(bodies[i].polys, bodies[j].polys), vol = Math.abs(volumeOf(common));
    if (vol > 1e-6) { rows.push([`${bodies[i].name} × ${bodies[j].name}`, `${fmt(vol, 2)} mm³`]); meshes.push(meshOf(common)); }
  }
  state.clash = meshes;
  uploadMeshes(); requestRender();
  openProps('Interferência', [rows.length ? fieldset('Corpos que se sobrepõem', h('table', {}, rows.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b)))))
    : h('p', { class: 'note' }, 'Nenhuma interferência: os corpos não se sobrepõem.'), rows.length ? h('p', { class: 'note' }, 'As regiões em vermelho são o volume em comum.') : null], { confirm: false });
  setStatus(rows.length ? `${rows.length} interferência(s) encontrada(s).` : 'Nenhuma interferência entre os corpos.');
}

/* =========================================================================
   Esboço
   ========================================================================= */
function startSketch(offset = 0) {
  if (state.mode !== 'idle') return;
  const sel = state.selected || '';
  if (sel.startsWith('plane:')) { enterSketch({ id: newId(), type: 'sketch', name: nextName('Esboço'), plane: sel.slice(6), offset, entities: [] }, true); return; }
  openProps('Novo esboço', [h('p', { class: 'note' }, 'Escolha o plano do esboço:'),
    h('div', { class: 'row' }, Object.entries(PLANES).map(([k, p]) => h('button', { class: 'btn', onclick: () => {
      closeProps(); enterSketch({ id: newId(), type: 'sketch', name: nextName('Esboço'), plane: k, offset, entities: [] }, true);
    } }, p.label)))], { confirm: false });
  setStatus('Escolha um plano para o esboço.');
}
function offsetPlane() {
  if (state.mode !== 'idle') return;
  let plane = 'XY', offset = 10;
  const preview = () => { planeHint = { plane, offset }; uploadMeshes(); drawLines(); };
  openProps('Plano deslocado', [
    fieldset('Referência', selectField('Plano base', plane, Object.entries(PLANES).map(([k, p]) => [k, p.label]), v => { plane = v; preview(); }),
      numberField('Deslocamento', offset, v => { offset = v; preview(); }, { step: 1 })),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { closeProps(); planeHint = null; enterSketch({ id: newId(), type: 'sketch', name: nextName('Esboço'), plane, offset, entities: [] }, true); } }, 'Criar esboço neste plano'))],
  { confirm: false });
  preview();
}

function enterSketch(feature, isNew) {
  planeHint = null;
  state.mode = 'sketch';
  state.sketch = { draft: structuredClone(feature), original: feature, isNew, tool: isNew ? 'rect' : 'select', temp: [], sel: -1, cursor: null, op: null,
    opts: { n: 6, r: 3, axis: 'v', dx: 20, dy: 0, ang: 0, copy: true, nx: 3, ny: 1, sx: 20, sy: 20, count: 6, total: 360, cx: 0, cy: 0, dist: 2 } };
  const view = { XY: 'top', XZ: 'front', YZ: 'right' }[feature.plane];
  const [az, el] = VIEWS[view];
  cam.setView((az * Math.PI) / 180, (el * Math.PI) / 180);
  state.tab = 'sketch';
  renderRibbon();
  uploadMeshes();
  renderSketchPM();
  drawLines();
  canvas.style.cursor = 'crosshair';
  setStatus(isNew ? 'Esboço: retângulo (dois cliques), círculo (centro e raio) ou linha (vértices). Botão direito move a vista.' : `Editando ${feature.name}.`);
}

const sk = () => state.sketch;
const sketchWorld = (u, v) => PLANES[sk().draft.plane].toWorld(u, v, 0, Number(sk().draft.offset) || 0);
const flip = () => PLANES[sk().draft.plane].displayFlip;
const toDisplay = (p) => [p[0], p[1] * flip()];
const fromDisplay = (p) => [p[0], p[1] * flip()];

function pointerToSketch(px, py) {
  const d = sk().draft, n = PLANES[d.plane].normal;
  const hit = gfx.pickPlane(px, py, n, PLANES[d.plane].toWorld(0, 0, 0, Number(d.offset) || 0));
  return hit ? snapPoint(worldToSketch(d.plane, d.offset, hit)) : null;
}
function snapPoint(p) {
  const tol = cam.mmPerPixel() * 8, s = sk();
  // Pontos de encaixe com o nome que aparece ao lado do cursor.
  const cands = [{ p: [0, 0], label: 'Origem' }, ...s.temp.map(q => ({ p: q, label: 'Ponto final' }))];
  const add = (q, label) => cands.push({ p: q, label });
  const mids = (pts, closed) => { for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; add([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 'Ponto médio'); } };
  for (const e of s.draft.entities) {
    if (e.type === 'rect' || e.type === 'rrect') { const c4 = [e.p0, [e.p1[0], e.p0[1]], e.p1, [e.p0[0], e.p1[1]]]; c4.forEach(q => add(q, 'Ponto final')); mids(c4, true); add([(e.p0[0] + e.p1[0]) / 2, (e.p0[1] + e.p1[1]) / 2], 'Centro'); }
    if (e.c) add(e.c, 'Centro');
    if (e.type === 'circle') [[1, 0], [0, 1], [-1, 0], [0, -1]].forEach(([a, b]) => add([e.c[0] + a * e.d / 2, e.c[1] + b * e.d / 2], 'Quadrante'));
    if (e.c1) { add(e.c1, 'Centro'); add(e.c2, 'Centro'); }
    if (e.p3) { add(e.p1, 'Ponto final'); add(e.p3, 'Ponto final'); }
    if (e.type === 'poly' || e.type === 'path') { e.pts.forEach(q => add(q, 'Ponto final')); mids(e.pts, e.type === 'poly'); }
    if (e.type === 'polygon') entityPoints(e).pts.forEach(q => add(q, 'Vértice'));
  }
  s.guides = []; s.snap = null;
  let best = null, bestD = tol;
  for (const c of cands) { const dd = Math.hypot(c.p[0] - p[0], c.p[1] - p[1]); if (dd < bestD) { bestD = dd; best = c; } }
  if (best) { s.snap = { p: [best.p[0], best.p[1]], label: best.label }; return [best.p[0], best.p[1]]; }
  const mpp = cam.mmPerPixel(), step = mpp > 1.5 ? 5 : mpp > 0.4 ? 1 : 0.5;
  const grid = (v) => Math.round(v / step) * step;
  if (!state.snapAlign) return [grid(p[0]), grid(p[1])];
  // Inferência de alinhamento a partir do último ponto: perto de 0°/180° fica
  // horizontal, perto de 90°/270° vertical e perto de 45° fica na diagonal.
  let x = p[0], y = p[1], lockX = false, lockY = false;
  const ref = s.temp.at(-1);
  if (ref) {
    const dx = p[0] - ref[0], dy = p[1] - ref[1], len = Math.hypot(dx, dy), near = Math.max(tol, len * Math.tan((5 * Math.PI) / 180));
    if (len > tol && Math.abs(dy) < near && Math.abs(dy) <= Math.abs(dx)) { y = ref[1]; lockY = true; s.guides.push({ from: ref, label: 'Horizontal' }); }
    else if (len > tol && Math.abs(dx) < near) { x = ref[0]; lockX = true; s.guides.push({ from: ref, label: 'Vertical' }); }
    else if (len > tol && Math.abs(Math.abs(dx) - Math.abs(dy)) < near) {
      const L = grid((Math.abs(dx) + Math.abs(dy)) / 2);
      s.guides.push({ from: ref, label: '45°' });
      return [ref[0] + Math.sign(dx) * L, ref[1] + Math.sign(dy) * L];
    }
  }
  for (const c of cands) {
    if (c.p === ref) continue;
    if (!lockX && Math.abs(c.p[0] - p[0]) < tol) { x = c.p[0]; lockX = true; s.guides.push({ from: c.p, label: 'Alinhado' }); }
    if (!lockY && Math.abs(c.p[1] - p[1]) < tol) { y = c.p[1]; lockY = true; s.guides.push({ from: c.p, label: 'Alinhado' }); }
  }
  return [lockX ? x : grid(x), lockY ? y : grid(y)];
}
function entityLoop(e) { return entityPoints(e, 72).pts; }
const entityClosed = (e) => entityPoints(e, 8).closed;
function loopSegments(pts, closed = true) {
  const out = [];
  for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) out.push(...sketchWorld(...pts[i]), ...sketchWorld(...pts[(i + 1) % pts.length]));
  return out;
}
function dashed(pts) {
  const out = [], dash = cam.mmPerPixel() * 6;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.floor(len / dash));
    for (let k = 0; k < n; k += 2) {
      const t0 = k / n, t1 = Math.min(1, (k + 1) / n);
      out.push(...sketchWorld(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0), ...sketchWorld(a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1));
    }
  }
  return out;
}
function drawSketchLines() {
  const s = sk(), d = s.draft;
  // Grade infinita no plano do esboço, por cima das peças.
  const o = sketchWorld(0, 0), u = v3.sub(sketchWorld(1, 0), o), v = v3.sub(sketchWorld(0, 1), o);
  gfx.grid = { origin: o, u, v, colorU: axisColor(u), colorV: axisColor(v), tint: THEMES[prefs.theme].sketchGrid, alpha: 0.22, onTop: true };
  // Cores do esboço: azul (geometria), amarelo (selecionada), laranja (sob o cursor e construção).
  const mpp = cam.mmPerPixel();
  const dot = (q, col, r = 3) => gfx.addLines([...sketchWorld(q[0] - r * mpp, q[1] - r * mpp), ...sketchWorld(q[0] + r * mpp, q[1] - r * mpp), ...sketchWorld(q[0] + r * mpp, q[1] - r * mpp), ...sketchWorld(q[0] + r * mpp, q[1] + r * mpp),
    ...sketchWorld(q[0] + r * mpp, q[1] + r * mpp), ...sketchWorld(q[0] - r * mpp, q[1] + r * mpp), ...sketchWorld(q[0] - r * mpp, q[1] + r * mpp), ...sketchWorld(q[0] - r * mpp, q[1] - r * mpp)], col, { depth: false });
  d.entities.forEach((e, i) => {
    const col = i === s.sel ? SK.sel : i === s.hover ? SK.hover : e.construction ? SK.constr : SK.line, { pts, closed } = entityPoints(e, 72);
    gfx.addLines(e.construction ? dashed(closed ? [...pts, pts[0]] : pts) : loopSegments(pts, closed), col, { depth: false });
    for (const q of entityVertices(e)) dot(q, col, 2.5);
  });
  drawSketchDims();
  const c = s.cursor, t = s.temp;
  for (const q of t) dot(q, SK.preview, 2.5);
  if (c && t.length) {
    const green = SK.preview;
    const prev = previewEntity(s.tool, t, c);
    if (prev) {
      const { pts, closed } = entityPoints(prev, 72);
      gfx.addLines(dashed(closed ? [...pts, pts[0]] : pts), green, { depth: false });
    }
    const label = { rect: () => `${fmt(Math.abs(c[0] - t[0][0]))} × ${fmt(Math.abs(c[1] - t[0][1]))} mm`, rrect: () => `${fmt(Math.abs(c[0] - t[0][0]))} × ${fmt(Math.abs(c[1] - t[0][1]))} mm`,
      crect: () => `${fmt(2 * Math.abs(c[0] - t[0][0]))} × ${fmt(2 * Math.abs(c[1] - t[0][1]))} mm`, circle: () => `Ø ${fmt(2 * Math.hypot(c[0] - t[0][0], c[1] - t[0][1]))} mm`,
      ellipse: () => `${fmt(2 * Math.abs(c[0] - t[0][0]))} × ${fmt(2 * Math.abs(c[1] - t[0][1]))} mm`, polygon: () => `R ${fmt(Math.hypot(c[0] - t[0][0], c[1] - t[0][1]))} mm`,
      slot: () => (t.length === 1 ? `${fmt(Math.hypot(c[0] - t[0][0], c[1] - t[0][1]))} mm` : `largura ${fmt(prev?.w || 0)} mm`),
      poly: () => lineLabel(t.at(-1), c), path: () => lineLabel(t.at(-1), c),
      arc: () => (t.length === 1 ? `corda ${fmt(Math.hypot(c[0] - t[0][0], c[1] - t[0][1]))} mm` : 'ponto do arco') }[s.tool];
    if (label) tag(sketchWorld(...c), label(), 'sketch');
  }
  if (c) {
    const r = mpp * 5;
    gfx.addLines([...sketchWorld(c[0] - r, c[1]), ...sketchWorld(c[0] + r, c[1]), ...sketchWorld(c[0], c[1] - r), ...sketchWorld(c[0], c[1] + r)], SK.preview, { depth: false });
    // Encaixe: quadrado laranja no ponto e o nome dele; alinhamento: tracejado até a referência.
    if (s.snap) dot(s.snap.p, SK.hover, 5);
    for (const g of s.guides || []) gfx.addLines(dashed([g.from, c]), SK.hover, { depth: false });
    const kinds = [...new Set([s.snap?.label, ...(s.guides || []).map(g => g.label)].filter(Boolean))];
    if (kinds.length && s.tool !== 'select') tag(sketchWorld(c[0], c[1]), kinds.join(' · '), 'pick snap');
  }
}
const SK = { line: [0.44, 0.74, 0.93, 1], sel: [0.95, 0.79, 0.49, 1], hover: [0.96, 0.65, 0.35, 1], constr: [1, 0.6, 0.3, 0.75], preview: [0.45, 0.87, 0.69, 1], dim: [0.5, 0.88, 0.76, 1] };
/** Comprimento e ângulo do segmento que está sendo desenhado. */
function lineLabel(a, b) {
  const d = toDisplay([b[0] - a[0], b[1] - a[1]]), ang = ((Math.atan2(d[1], d[0]) * 180) / Math.PI + 360) % 360;
  return `${fmt(Math.hypot(d[0], d[1]))} mm · ${fmt(Math.round(ang * 10) / 10)}° (digite para medir)`;
}
/** Vértices visíveis de cada entidade (pontinhos, como no esboço antigo). */
function entityVertices(e) {
  if (e.type === 'rect' || e.type === 'rrect') return [e.p0, [e.p1[0], e.p0[1]], e.p1, [e.p0[0], e.p1[1]]];
  if (e.type === 'poly' || e.type === 'path') return e.pts;
  if (e.type === 'arc') return [e.p1, e.p3];
  if (e.type === 'slot') return [e.c1, e.c2];
  if (e.c) return [e.c];
  return [];
}

/* ---- Cotas do esboço: medidas que ficam no desenho e mudam a geometria ---- */
/** Medida que a cota mostra e como aplicar um valor novo. */
function dimAccess(e, dm) {
  if (!e) return null;
  if ((e.type === 'rect' || e.type === 'rrect') && (dm.k === 'w' || dm.k === 'h')) {
    const i = dm.k === 'w' ? 0 : 1;
    return { value: Math.abs(e.p1[i] - e.p0[i]), set: (v) => { e.p1[i] = e.p0[i] + Math.sign(e.p1[i] - e.p0[i] || 1) * v; } };
  }
  if (e.type === 'circle') return { value: e.d, set: (v) => { e.d = v; }, prefix: 'Ø' };
  if (e.type === 'polygon') return { value: e.r, set: (v) => { e.r = v; }, prefix: 'R' };
  if (e.type === 'rrect' && dm.k === 'r') return { value: e.r, set: (v) => { e.r = v; }, prefix: 'R' };
  if (e.type === 'slot') return { value: e.w, set: (v) => { e.w = v; }, prefix: 'L ' };
  if ((e.type === 'poly' || e.type === 'path') && dm.k === 'seg') {
    const n = e.pts.length, a = e.pts[dm.seg], bi = (dm.seg + 1) % n, b = e.pts[bi];
    if (!a || !b) return null;
    return { value: Math.hypot(b[0] - a[0], b[1] - a[1]), set: (v) => {
      // O ponto final anda na direção do segmento; os pontos seguintes acompanham (a forma não se deforma).
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, dx = ux * (v - L), dy = uy * (v - L);
      const last = e.type === 'poly' ? (bi === 0 ? -1 : n - 1) : n - 1;
      if (bi === 0) { e.pts[0] = [b[0] + dx, b[1] + dy]; return; }
      for (let k = bi; k <= last; k++) e.pts[k] = [e.pts[k][0] + dx, e.pts[k][1] + dy];
    } };
  }
  return null;
}
/** Segmento onde a cota é desenhada (em coordenadas do esboço). */
function dimSegment(e, dm) {
  if (e.type === 'rect' || e.type === 'rrect') {
    const x0 = Math.min(e.p0[0], e.p1[0]), x1 = Math.max(e.p0[0], e.p1[0]), y0 = Math.min(e.p0[1], e.p1[1]), y1 = Math.max(e.p0[1], e.p1[1]);
    return dm.k === 'w' ? [[x0, y0], [x1, y0], -1] : [[x0, y0], [x0, y1], 1];
  }
  if (e.type === 'poly' || e.type === 'path') return [e.pts[dm.seg], e.pts[(dm.seg + 1) % e.pts.length], 1];
  return null;
}
function drawSketchDims() {
  const s = sk(), d = s.draft, mpp = cam.mmPerPixel();
  d.dims = (d.dims || []).filter(dm => dimAccess(d.entities[dm.e], dm));
  for (const dm of d.dims) {
    const e = d.entities[dm.e], acc = dimAccess(e, dm), seg = dimSegment(e, dm), text = `${acc.prefix || ''}${fmt(acc.value)}`;
    if (!seg) { tag(sketchWorld(...(e.c || e.c1)), text, 'dim'); continue; }
    // Linha de cota afastada da aresta, com linhas de chamada e pequenas marcas nas pontas.
    const [a, b, side] = seg, L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = (-(b[1] - a[1]) / L) * side, ny = ((b[0] - a[0]) / L) * side, off = mpp * 22, ext = mpp * 4, tk = mpp * 5;
    const A = [a[0] + nx * off, a[1] + ny * off], B = [b[0] + nx * off, b[1] + ny * off];
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    gfx.addLines([...sketchWorld(a[0] + nx * mpp * 3, a[1] + ny * mpp * 3), ...sketchWorld(A[0] + nx * ext, A[1] + ny * ext),
      ...sketchWorld(b[0] + nx * mpp * 3, b[1] + ny * mpp * 3), ...sketchWorld(B[0] + nx * ext, B[1] + ny * ext), ...sketchWorld(...A), ...sketchWorld(...B),
      ...sketchWorld(A[0] + (ux + nx) * tk * 0.5, A[1] + (uy + ny) * tk * 0.5), ...sketchWorld(A[0] - (ux + nx) * tk * 0.5, A[1] - (uy + ny) * tk * 0.5),
      ...sketchWorld(B[0] + (ux + nx) * tk * 0.5, B[1] + (uy + ny) * tk * 0.5), ...sketchWorld(B[0] - (ux + nx) * tk * 0.5, B[1] - (uy + ny) * tk * 0.5)], SK.dim, { depth: false });
    tag(sketchWorld((A[0] + B[0]) / 2, (A[1] + B[1]) / 2), text, 'dim');
  }
}
/** Qual medida da entidade o clique da ferramenta Cota escolhe. */
function dimFor(i, p) {
  const e = sk().draft.entities[i];
  if (e.type === 'rect' || e.type === 'rrect') {
    const x0 = Math.min(e.p0[0], e.p1[0]), x1 = Math.max(e.p0[0], e.p1[0]), y0 = Math.min(e.p0[1], e.p1[1]), y1 = Math.max(e.p0[1], e.p1[1]);
    const dh = Math.min(Math.abs(p[1] - y0), Math.abs(p[1] - y1)), dv = Math.min(Math.abs(p[0] - x0), Math.abs(p[0] - x1));
    return { e: i, k: dh <= dv ? 'w' : 'h' };
  }
  if (e.type === 'poly' || e.type === 'path') {
    let best = 0, bestD = Infinity;
    const n = e.pts.length;
    for (let k = 0; k < n - (e.type === 'poly' ? 0 : 1); k++) {
      const a = e.pts[k], b = e.pts[(k + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)), dd = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
      if (dd < bestD) { bestD = dd; best = k; }
    }
    return { e: i, k: 'seg', seg: best };
  }
  return { e: i, k: 'main' };
}
/** Caixinha para digitar um valor perto do cursor. Enter aplica, Esc cancela. */
function askValue(px, py, initial, hint, onSet, selectAll = true) {
  $('#valueBox')?.remove();
  const input = h('input', { id: 'valueBox', class: 'value-box', type: 'text', value: initial, title: hint, placeholder: hint });
  input.style.left = `${px + 14}px`; input.style.top = `${py + 14}px`;
  $('#overlay').parentElement.append(input);   // fora do overlay, que é limpo a cada redesenho
  // O foco vem depois do clique terminar; senão o próprio clique tira o foco da caixa.
  // Valor existente fica selecionado (digitar troca); um dígito já digitado fica com o cursor no fim.
  // Pelo teclado o foco é imediato, para o próximo dígito já cair na caixa.
  if (!selectAll) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  else setTimeout(() => { input.focus(); input.select(); }, 30);
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') input.remove();
    if (ev.key === 'Enter') { const txt = input.value.trim().replace(',', '.'); input.remove(); onSet(txt); }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) input.remove(); }, 150));
}
function sketchDimClick(px, py, p) {
  const s = sk(), d = s.draft, i = hitEntity(p);
  if (i < 0) { setStatus('Cota: clique numa linha, aresta do retângulo ou círculo.', true); return; }
  const dm = dimFor(i, p), acc = dimAccess(d.entities[i], dm);
  if (!acc) { setStatus('Esta entidade não tem cota editável; use o painel de medidas.', true); return; }
  d.dims = d.dims || [];
  const old = d.dims.find(x => x.e === dm.e && x.k === dm.k && x.seg === dm.seg);
  if (!old) d.dims.push(dm);
  s.sel = i; renderSketchPM(); drawLines();
  askValue(px, py, fmt(acc.value), 'Valor em mm', (txt) => {
    const v = Number(txt);
    if (!(v > 0)) { setStatus('Digite um valor maior que zero.', true); return; }
    acc.set(v); renderSketchPM(); drawLines(); setStatus(`Cota aplicada: ${fmt(v)} mm.`);
  });
}
/** Linha por medida: digitar "40" ou "40<30" (comprimento e ângulo) cria o próximo ponto. */
function typeLineLength(first) {
  const s = sk(), t = s.temp, ref = t.at(-1);
  if (!ref) return;
  const r = canvas.getBoundingClientRect(), last = lastPointer || [r.width / 2, r.height / 2];
  askValue(last[0], last[1], first, 'comprimento ou comprimento<ângulo', (txt) => {
    const m = txt.match(/^(\d+(?:\.\d+)?)\s*(?:<\s*(-?\d+(?:\.\d+)?))?$/);
    if (!m) { setStatus('Use 40 (comprimento) ou 40<30 (comprimento e ângulo em graus).', true); return; }
    const L = Number(m[1]);
    if (!(L > 0)) { setStatus('O comprimento precisa ser maior que zero.', true); return; }
    let dir;
    if (m[2] !== undefined) { const a = (Number(m[2]) * Math.PI) / 180; dir = fromDisplay([Math.cos(a), Math.sin(a)]); }
    else { const c = s.cursor || [ref[0] + 1, ref[1]], dx = c[0] - ref[0], dy = c[1] - ref[1], l = Math.hypot(dx, dy); dir = l > 1e-9 ? [dx / l, dy / l] : [1, 0]; }
    t.push([r3(ref[0] + dir[0] * L), r3(ref[1] + dir[1] * L)]);
    drawLines(); setStatus(`Segmento de ${fmt(L)} mm criado. Continue clicando, digite outra medida, ou Enter para terminar.`);
  }, false);
}
/** Entidade que o clique seguinte criaria (prévia tracejada). */
function previewEntity(tool, t, c) {
  const o = sk().opts;
  const dx = c[0] - (t[0]?.[0] ?? 0), dy = c[1] - (t[0]?.[1] ?? 0);
  switch (tool) {
    case 'rect': return { type: 'rect', p0: t[0], p1: c };
    case 'rrect': return { type: 'rrect', p0: t[0], p1: c, r: o.r };
    case 'crect': return { type: 'rect', p0: [t[0][0] - Math.abs(dx), t[0][1] - Math.abs(dy)], p1: [t[0][0] + Math.abs(dx), t[0][1] + Math.abs(dy)] };
    case 'circle': return { type: 'circle', c: t[0], d: 2 * Math.hypot(dx, dy) };
    case 'ellipse': return { type: 'ellipse', c: t[0], rx: Math.max(1e-3, Math.abs(dx)), ry: Math.max(1e-3, Math.abs(dy)), rot: 0 };
    case 'polygon': return { type: 'polygon', c: t[0], r: Math.hypot(dx, dy), n: o.n, rot: (Math.atan2(dy, dx) * 180) / Math.PI, inscribed: true };
    case 'slot': {
      if (t.length === 1) return { type: 'path', pts: [t[0], c] };
      const [a, b] = t, L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, w = (2 * Math.abs((b[0] - a[0]) * (a[1] - c[1]) - (a[0] - c[0]) * (b[1] - a[1]))) / L;
      return { type: 'slot', c1: a, c2: b, w: Math.max(w, 1e-3) };
    }
    case 'poly': case 'path': return { type: 'path', pts: [...t, c] };
    case 'arc': return t.length === 1 ? { type: 'path', pts: [t[0], c] } : { type: 'arc', p1: t[0], p2: c, p3: t[1] };
    default: return null;
  }
}
function entityLabel(e) {
  const tag2 = e.construction ? ' · construção' : '';
  const L = {
    rect: () => `Retângulo ${fmt(Math.abs(e.p1[0] - e.p0[0]))} × ${fmt(Math.abs(e.p1[1] - e.p0[1]))}`, rrect: () => `Retângulo arredondado R${fmt(e.r)}`,
    circle: () => `Círculo Ø ${fmt(e.d)}`, ellipse: () => `Elipse ${fmt(2 * e.rx)} × ${fmt(2 * e.ry)}`, polygon: () => `Polígono ${e.n} lados R${fmt(e.r)}`,
    slot: () => `Rasgo ${fmt(Math.hypot(e.c2[0] - e.c1[0], e.c2[1] - e.c1[1]) + e.w)} × ${fmt(e.w)}`, poly: () => `Contorno (${e.pts.length} pontos)`,
    path: () => `Linha aberta (${e.pts.length} pontos)`, arc: () => 'Arco por 3 pontos',
  }[e.type];
  return (L ? L() : e.type) + tag2;
}
function renderSketchPM() {
  const s = sk(), d = s.draft;
  const parts = [fieldset('Plano', h('p', { class: 'note' }, `${PLANES[d.plane].label}${d.offset ? ` · deslocado ${fmt(d.offset)} mm` : ''}`))];
  if (s.tool === 'polygon') parts.push(fieldset('Polígono', numberField('Lados', s.opts.n, v => { s.opts.n = Math.max(3, Math.min(64, Math.round(v))); drawLines(); }, { min: 3, step: 1, unit: '' })));
  if (s.tool === 'rrect') parts.push(fieldset('Retângulo arredondado', numberField('Raio dos cantos', s.opts.r, v => { s.opts.r = Math.max(0, v); drawLines(); }, { min: 0, step: 0.5 })));
  const list = fieldset(`Entidades (${d.entities.length})`);
  if (!d.entities.length) list.append(h('p', { class: 'note' }, 'Contornos fechados viram perfis; um contorno dentro de outro vira furo. Linhas abertas e arcos servem de caminho e de superfície.'));
  d.entities.forEach((e, i) => {
    list.append(h('div', { class: `entity ${i === s.sel ? 'selected' : ''}`, onclick: () => { s.sel = i; s.tool = 'select'; renderRibbon(); renderSketchPM(); drawLines(); } }, entityLabel(e)));
  });
  parts.push(list);
  const e = d.entities[s.sel];
  if (e) {
    const [ax, ay] = d.plane === 'XY' ? ['X', 'Y'] : d.plane === 'XZ' ? ['X', 'Z'] : ['Y', 'Z'];
    const box = fieldset('Medidas da entidade');
    const pointFields = (key, label) => { const p = toDisplay(e[key]), set = () => { e[key] = fromDisplay(p); drawLines(); };
      return [numberField(`${label} ${ax}`, p[0], v => { p[0] = v; set(); }), numberField(`${label} ${ay}`, p[1], v => { p[1] = v; set(); })]; };
    const pos = (k, label, o = {}) => numberField(label, e[k], v => { if (!(o.min !== undefined && v < o.min)) { e[k] = v; drawLines(); } }, { min: 0.01, ...o });
    if (e.type === 'rect' || e.type === 'rrect') {
      box.append(...pointFields('p0', 'Canto 1'), ...pointFields('p1', 'Canto 2'));
      if (e.type === 'rrect') box.append(pos('r', 'Raio dos cantos', { min: 0 }));
    } else if (e.type === 'circle') box.append(...pointFields('c', 'Centro'), pos('d', 'Diâmetro'));
    else if (e.type === 'ellipse') box.append(...pointFields('c', 'Centro'), pos('rx', 'Semieixo horizontal'), pos('ry', 'Semieixo vertical'), pos('rot', 'Rotação', { min: -360, unit: '°' }));
    else if (e.type === 'polygon') box.append(...pointFields('c', 'Centro'), pos('r', 'Raio'), pos('n', 'Lados', { min: 3, unit: '' }), pos('rot', 'Rotação', { min: -360, unit: '°' }),
      checkField('Inscrito (raio até o vértice)', e.inscribed !== false, v => { e.inscribed = v; drawLines(); }));
    else if (e.type === 'slot') box.append(...pointFields('c1', 'Centro 1'), ...pointFields('c2', 'Centro 2'), pos('w', 'Largura'));
    else if (e.type === 'arc') box.append(...pointFields('p1', 'Início'), ...pointFields('p2', 'Ponto do arco'), ...pointFields('p3', 'Fim'));
    else box.append(h('p', { class: 'note' }, 'Para mudar os vértices, exclua e desenhe de novo (ou use Mover, Espelhar e Deslocar).'));
    box.append(checkField('Geometria de construção (não vira perfil)', !!e.construction, v => { e.construction = v; renderSketchPM(); drawLines(); }));
    box.append(h('div', { class: 'row' }, h('button', { class: 'btn danger', onclick: deleteEntity }, 'Excluir entidade')));
    parts.push(box);
    parts.push(sketchOpPanel(e));
  }
  openProps(d.name, parts);
}
const TOOL_HELP = { select: 'Clique numa entidade para editar as medidas.', rect: 'Retângulo: primeiro canto, depois o canto oposto.',
  crect: 'Retângulo pelo centro: centro, depois um canto.', rrect: 'Retângulo arredondado: dois cantos (o raio fica no painel).',
  circle: 'Círculo: centro, depois um ponto da circunferência.', ellipse: 'Elipse: centro, depois um canto do retângulo que a contém.',
  polygon: 'Polígono: centro, depois um vértice (o número de lados fica no painel).', slot: 'Rasgo: centro 1, centro 2, depois a largura.',
  poly: 'Linha fechada: clique nos vértices; feche no primeiro ponto ou com Enter.', path: 'Linha aberta: clique nos vértices; Enter ou duplo clique termina.',
  arc: 'Arco: início, fim, depois um ponto do arco.', dim: 'Cota: clique numa linha, aresta ou círculo e digite a medida (Enter aplica).' };
TOOL_HELP.poly = 'Linha: clique nos pontos em sequência, ou digite o comprimento (40) ou comprimento<ângulo (40<30). Clique no primeiro ponto para fechar; Enter termina.';
TOOL_HELP.path = 'Linha aberta: clique nos pontos ou digite o comprimento (40<30 para dar o ângulo). Enter ou duplo clique termina.';
function setTool(tool) {
  if (state.mode !== 'sketch') return;
  Object.assign(sk(), { tool, temp: [] });
  if (tool !== 'select') sk().sel = -1;
  canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
  renderRibbon(); renderSketchPM(); drawLines();
  setStatus(TOOL_HELP[tool]);
}

/* ---- Modificar entidades do esboço: espelhar, mover/copiar, padrões, deslocar ---- */
const POINT_KEYS = ['p0', 'p1', 'p2', 'p3', 'c', 'c1', 'c2'];
/** Aplica fn a todos os pontos; mirror/rotate ajustam ângulos e convertem retângulos girados. */
function mapEntity(e, fn, { mirror = null, rotate = 0 } = {}) {
  let out = structuredClone(e);
  if (rotate && (e.type === 'rect' || e.type === 'rrect')) out = { type: 'poly', pts: entityPoints(e, 32).pts, construction: e.construction };
  for (const k of POINT_KEYS) if (out[k]) out[k] = fn(out[k]);
  if (out.pts) out.pts = out.pts.map(fn);
  if (out.type === 'polygon' || out.type === 'ellipse') {
    if (rotate) out.rot = (Number(out.rot) || 0) + rotate;
    if (mirror === 'v') out.rot = 180 - (Number(out.rot) || 0);
    if (mirror === 'h') out.rot = -(Number(out.rot) || 0);
  }
  if (mirror && out.type === 'rect') { const [a, b] = [out.p0, out.p1]; out.p0 = [Math.min(a[0], b[0]), Math.min(a[1], b[1])]; out.p1 = [Math.max(a[0], b[0]), Math.max(a[1], b[1])]; }
  return out;
}
function offsetEntity(e, dist) {
  const o = structuredClone(e), dd = Number(dist);
  if (e.type === 'circle') { o.d = e.d + 2 * dd; return o.d > 0 ? o : null; }
  if (e.type === 'rect' || e.type === 'rrect') {
    const x0 = Math.min(e.p0[0], e.p1[0]) - dd, x1 = Math.max(e.p0[0], e.p1[0]) + dd, y0 = Math.min(e.p0[1], e.p1[1]) - dd, y1 = Math.max(e.p0[1], e.p1[1]) + dd;
    if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
    return { ...o, p0: [x0, y0], p1: [x1, y1], ...(e.type === 'rrect' ? { r: Math.max(0, e.r + dd) } : {}) };
  }
  if (e.type === 'ellipse') { o.rx += dd; o.ry += dd; return o.rx > 0 && o.ry > 0 ? o : null; }
  if (e.type === 'polygon') { const n = Math.max(3, Math.round(e.n)); o.r = e.r + (e.inscribed === false ? dd : dd / Math.cos(Math.PI / n)); return o.r > 0 ? o : null; }
  if (e.type === 'slot') { o.w = e.w + 2 * dd; return o.w > 0 ? o : null; }
  // Linhas: cada vértice anda pela bissetriz (esquadria), à direita do sentido do contorno anti-horário.
  const { pts, closed } = entityPoints(e, 48);
  let P = pts;
  let area = 0;
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; area += a[0] * b[1] - b[0] * a[1]; }
  const sgn = closed && area < 0 ? -1 : 1;
  const nrm = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [(dy / l) * sgn, (-dx / l) * sgn]; };
  const n = P.length, out = [];
  for (let i = 0; i < n; i++) {
    const prev = closed ? P[(i - 1 + n) % n] : P[Math.max(0, i - 1)], next = closed ? P[(i + 1) % n] : P[Math.min(n - 1, i + 1)];
    const n1 = i === 0 && !closed ? nrm(P[0], P[1]) : nrm(prev, P[i]), n2 = i === n - 1 && !closed ? nrm(P[n - 2], P[n - 1]) : nrm(P[i], next);
    let m = [n1[0] + n2[0], n1[1] + n2[1]];
    const ml = Math.hypot(...m) || 1; m = [m[0] / ml, m[1] / ml];
    const k = Math.min(4, 1 / Math.max(0.25, m[0] * n1[0] + m[1] * n1[1]));
    out.push([P[i][0] + m[0] * dd * k, P[i][1] + m[1] * dd * k]);
  }
  return { type: closed ? 'poly' : 'path', pts: out.map(p => p.map(x => Math.round(x * 1e4) / 1e4)), construction: e.construction };
}
function sketchOpPanel(e) {
  const s = sk(), o = s.opts;
  const apply = (label, list) => { if (!list.length) { setStatus('Nada a criar com esses valores.', true); return; } s.draft.entities.push(...list); renderSketchPM(); drawLines(); setStatus(`${label}: ${list.length} entidade(s) criada(s).`); };
  const rot = (deg) => { const a = (deg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a), cx = o.cx, cy = o.cy; return (p) => [cx + (p[0] - cx) * c - (p[1] - cy) * sn, cy + (p[0] - cx) * sn + (p[1] - cy) * c]; };
  const nf = (label, k, opt = {}) => numberField(label, o[k], v => { o[k] = v; }, { step: 1, ...opt });
  const btn = (label, run) => h('button', { class: 'btn', onclick: run }, label);
  const views = {
    mirror: [selectField('Eixo de simetria', o.axis, [['v', 'Eixo vertical do esboço'], ['h', 'Eixo horizontal do esboço']], v => { o.axis = v; }),
      btn('Criar cópia espelhada', () => apply('Espelhar', [mapEntity(e, o.axis === 'v' ? (p) => [-p[0], p[1]] : (p) => [p[0], -p[1]], { mirror: o.axis })]))],
    move: [nf('Deslocar horizontal', 'dx'), nf('Deslocar vertical', 'dy'), nf('Girar', 'ang', { unit: '°' }), checkField('Manter o original (copiar)', o.copy, v => { o.copy = v; }),
      btn('Aplicar', () => {
        const moved = mapEntity(mapEntity(e, rot(o.ang), { rotate: o.ang }), (p) => [p[0] + o.dx, p[1] + o.dy]);
        if (o.copy) apply('Copiar', [moved]); else { s.draft.entities[s.sel] = moved; renderSketchPM(); drawLines(); setStatus('Entidade movida.'); }
      })],
    rpattern: [nf('Colunas', 'nx', { min: 1, unit: '' }), nf('Linhas', 'ny', { min: 1, unit: '' }), nf('Espaço horizontal', 'sx'), nf('Espaço vertical', 'sy'),
      btn('Criar padrão', () => { const list = []; for (let i = 0; i < Math.max(1, Math.round(o.nx)); i++) for (let j = 0; j < Math.max(1, Math.round(o.ny)); j++) if (i || j) list.push(mapEntity(e, p => [p[0] + i * o.sx, p[1] + j * o.sy])); apply('Padrão retangular', list); })],
    cpattern: [nf('Quantidade', 'count', { min: 2, unit: '' }), nf('Ângulo total', 'total', { unit: '°' }), nf('Centro horizontal', 'cx'), nf('Centro vertical', 'cy'),
      btn('Criar padrão', () => { const n = Math.max(2, Math.round(o.count)), full = o.total >= 359.999, step = full ? o.total / n : o.total / (n - 1), list = [];
        for (let k = 1; k < n; k++) list.push(mapEntity(e, rot(step * k), { rotate: step * k })); apply('Padrão circular', list); })],
    offset: [nf('Distância (negativa = para dentro)', 'dist', { step: 0.5 }), btn('Criar contorno deslocado', () => { const r = offsetEntity(e, o.dist); apply('Deslocar', r ? [r] : []); })],
  };
  const tabs = [['mirror', 'Espelhar'], ['move', 'Mover/Copiar'], ['rpattern', 'Padrão retangular'], ['cpattern', 'Padrão circular'], ['offset', 'Deslocar']];
  return fieldset('Modificar entidade', h('div', { class: 'row' }, tabs.map(([k, label]) => h('button', { class: `btn mini ${s.op === k ? 'primary' : ''}`, onclick: () => { s.op = k; renderSketchPM(); } }, label))),
    ...(views[s.op] || [h('p', { class: 'note' }, 'Escolha uma operação acima.')]));
}
function sketchOp(op) {
  const s = sk();
  if (!s) return;
  if (s.sel < 0) { setStatus('Selecione uma entidade (ferramenta Selecionar) e depois a operação.', true); s.tool = 'select'; s.op = op; renderRibbon(); renderSketchPM(); return; }
  s.op = op; renderSketchPM();
}
function toggleConstruction() {
  const s = sk();
  if (!s || s.sel < 0) { setStatus('Selecione uma entidade para marcar como construção (X).', true); return; }
  const e = s.draft.entities[s.sel]; e.construction = !e.construction; renderSketchPM(); drawLines();
  setStatus(e.construction ? 'Entidade marcada como construção: não vira perfil.' : 'Entidade volta a ser geometria normal.');
}
async function insertSketchFile(file) {
  try {
    const text = await file.text(), ents = /\.svg$/i.test(file.name) ? parseSvg(text) : parseDxf(text);
    sk().draft.entities.push(...ents); renderSketchPM(); drawLines();
    setStatus(`${file.name}: ${ents.length} entidade(s) inserida(s) no esboço.`);
  } catch (error) { setStatus(`Não foi possível inserir: ${error.message}`, true); }
}
function exportSketchDxf(feature = sk()?.draft) {
  const f = feature || state.features.find(x => x.id === state.selected && x.type === 'sketch');
  if (!f) { setStatus('Abra ou selecione um esboço para salvar como DXF.', true); return; }
  const segments = [], circles = [];
  for (const e of f.entities) {
    if (e.type === 'circle') { circles.push({ c: e.c, r: e.d / 2 }); continue; }
    const { pts, closed } = entityPoints(e, 72);
    for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) segments.push([pts[i], pts[(i + 1) % pts.length]]);
  }
  download(toDxf({ segments, circles }), `${f.name}.dxf`, 'application/dxf');
  setStatus(`${f.name}.dxf salvo.`);
}
function addEntity(e) { sk().draft.entities.push(e); sk().temp = []; renderSketchPM(); drawLines(); }
function deleteEntity() {
  const s = sk();
  if (!s || s.sel < 0) return;
  const gone = s.sel;
  s.draft.entities.splice(gone, 1); s.sel = -1;
  s.draft.dims = (s.draft.dims || []).filter(dm => dm.e !== gone).map(dm => (dm.e > gone ? { ...dm, e: dm.e - 1 } : dm));
  renderSketchPM(); drawLines();
}
function hitEntity(p) {
  const tol = cam.mmPerPixel() * 6;
  let best = -1, bestD = tol;
  sk().draft.entities.forEach((e, i) => {
    const { pts, closed } = entityPoints(e, 72);
    for (let k = 0; k < pts.length - (closed ? 0 : 1); k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
      const dd = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
      if (dd < bestD) { bestD = dd; best = i; }
    }
  });
  return best;
}
function closePolygon() {
  const s = sk(), t = s.temp;
  if (s.tool === 'path') {
    if (t.length >= 2) addEntity({ type: 'path', pts: t.map(p => [...p]) });
    else setStatus('Uma linha aberta precisa de pelo menos dois pontos.', true);
    return;
  }
  if (t.length >= 3) addEntity({ type: 'poly', pts: t.map(p => [...p]) });
  else setStatus('Uma linha fechada precisa de pelo menos três pontos.', true);
}
const r3 = (x) => Math.round(x * 1000) / 1000;
function sketchClick(px, py) {
  const s = sk(), p = pointerToSketch(px, py);
  if (!p) return;
  if (s.tool === 'select') { s.sel = hitEntity(p); renderSketchPM(); drawLines(); return; }
  if (s.tool === 'dim') { sketchDimClick(px, py, p); return; }
  const t = s.temp, far = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6;
  const two = ['rect', 'rrect', 'crect', 'circle', 'ellipse', 'polygon'];
  if (two.includes(s.tool)) {
    if (!t.length) { s.temp = [p]; drawLines(); return; }
    const e = previewEntity(s.tool, t, p);
    const ok = { rect: () => Math.abs(p[0] - t[0][0]) > 1e-6 && Math.abs(p[1] - t[0][1]) > 1e-6, rrect: () => Math.abs(p[0] - t[0][0]) > 1e-6 && Math.abs(p[1] - t[0][1]) > 1e-6,
      crect: () => Math.abs(p[0] - t[0][0]) > 1e-6 && Math.abs(p[1] - t[0][1]) > 1e-6, circle: () => far(p, t[0]), polygon: () => far(p, t[0]),
      ellipse: () => Math.abs(p[0] - t[0][0]) > 1e-6 && Math.abs(p[1] - t[0][1]) > 1e-6 }[s.tool]();
    if (!ok) return;
    if (e.d) e.d = r3(e.d);
    if (e.r !== undefined && e.type === 'polygon') { e.r = r3(e.r); e.rot = Math.round(e.rot * 10) / 10; }
    addEntity(e);
  } else if (s.tool === 'slot' || s.tool === 'arc') {
    if (t.length < 2) { if (!t.length || far(p, t[0])) t.push(p); }
    else { const e = previewEntity(s.tool, t, p); if (s.tool === 'slot') e.w = r3(e.w); addEntity(e); }
  } else if (s.tool === 'poly' || s.tool === 'path') {
    const first = t[0];
    // Clicar de novo no primeiro ponto fecha o contorno (também na linha aberta).
    if (first && t.length >= 3 && Math.hypot(p[0] - first[0], p[1] - first[1]) < cam.mmPerPixel() * 8) { s.tool = 'poly'; closePolygon(); s.tool = 'poly'; setStatus('Contorno fechado. Continue desenhando ou saia do esboço.'); }
    else if (!t.length || far(p, t.at(-1))) t.push(p);
  }
  drawLines();
}
function confirmSketch() {
  const s = sk();
  if (s.temp.length >= 2 && (s.tool === 'path' || s.tool === 'poly')) closePolygon();
  if (!sketchLoops(s.draft).length && !sketchPaths(s.draft).length && !s.draft.entities.length) { setStatus('Desenhe pelo menos uma entidade, ou cancele o esboço.', true); return; }
  pushUndo();
  if (s.isNew) insertFeature(s.draft); else Object.assign(s.original, s.draft);
  const id = s.draft.id;
  endMode();
  state.selected = id;
  state.tab = 'features';
  regenerate();
  renderRibbon();
  setStatus(sketchLoops(s.draft).length ? 'Esboço concluído. Use Extrudar, Revolução, Furo ou Superfície.' : 'Esboço concluído: as linhas abertas servem de caminho (Varredura, Tubo), ou de superfície.');
}

/* =========================================================================
   Inspecionar: medir, massa, seção
   ========================================================================= */
function startMeasure() {
  if (state.mode !== 'idle') return;
  state.mode = 'measure'; state.measure = [];
  canvas.style.cursor = 'crosshair';
  renderRibbon(); renderMeasurePM();
  setStatus('Medir: clique em dois pontos da peça (um terceiro mede o ângulo).');
}
function renderMeasurePM() {
  const m = state.measure, rows = [];
  if (m.length >= 2) {
    const d = v3.sub(m[1], m[0]);
    rows.push(['Distância', `${fmt(v3.len(d), 3)} mm`], ['ΔX', `${fmt(Math.abs(d[0]), 3)} mm`], ['ΔY', `${fmt(Math.abs(d[1]), 3)} mm`], ['ΔZ', `${fmt(Math.abs(d[2]), 3)} mm`]);
  }
  if (m.length === 3) {
    const a = v3.norm(v3.sub(m[0], m[1])), b = v3.norm(v3.sub(m[2], m[1]));
    rows.push(['Ângulo no ponto 2', `${fmt((Math.acos(Math.max(-1, Math.min(1, v3.dot(a, b)))) * 180) / Math.PI, 2)}°`], ['Distância 2 → 3', `${fmt(v3.dist(m[1], m[2]), 3)} mm`]);
  }
  m.forEach((p, i) => rows.push([`Ponto ${i + 1}`, p.map(x => fmt(x)).join('; ')]));
  openProps('Medir', [h('p', { class: 'note' }, m.length < 2 ? 'Clique em dois pontos sobre a peça.' : m.length === 2 ? 'Um terceiro ponto mede o ângulo no ponto 2.' : 'Clique de novo para outra medição.'),
    rows.length ? fieldset('Resultado', h('table', {}, rows.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b))))) : null]);
}
function drawMeasureLines() {
  const m = state.measure, r = cam.mmPerPixel() * 5, col = [1, 0.62, 0.2, 1];
  for (const p of m) gfx.addLines([p[0] - r, p[1], p[2], p[0] + r, p[1], p[2], p[0], p[1] - r, p[2], p[0], p[1] + r, p[2], p[0], p[1], p[2] - r, p[0], p[1], p[2] + r], col, { depth: false });
  if (m.length >= 2) { gfx.addLines([...m[0], ...m[1]], col, { depth: false }); tag(v3.mid(m[0], m[1]), `${fmt(v3.dist(m[0], m[1]))} mm`); }
  if (m.length === 3) {
    gfx.addLines([...m[1], ...m[2]], col, { depth: false });
    const a = v3.norm(v3.sub(m[0], m[1])), b = v3.norm(v3.sub(m[2], m[1]));
    tag(m[1], `${fmt((Math.acos(Math.max(-1, Math.min(1, v3.dot(a, b)))) * 180) / Math.PI, 1)}°`);
  }
}

function massData() {
  let volume = 0, area = 0;
  const cg = [0, 0, 0];
  for (const { positions: P, indices: I } of solidMeshes()) {
    const count = I ? I.length : P.length / 3;
    for (let i = 0; i < count; i += 3) {
      const g = (k) => { const o = (I ? I[i + k] : i + k) * 3; return [P[o], P[o + 1], P[o + 2]]; };
      const a = g(0), b = g(1), c = g(2);
      const v = v3.dot(a, v3.cross(b, c)) / 6;
      volume += v;
      for (let k = 0; k < 3; k++) cg[k] += ((a[k] + b[k] + c[k]) / 4) * v;
      area += v3.len(v3.cross(v3.sub(b, a), v3.sub(c, a))) / 2;
    }
  }
  return { volume: Math.abs(volume), area, cg: Math.abs(volume) > 1e-9 ? cg.map(x => x / volume) : cg, box: modelBox() };
}
const MATERIALS = [['7.85', 'Aço (7,85 g/cm³)'], ['2.70', 'Alumínio (2,70 g/cm³)'], ['8.96', 'Cobre (8,96 g/cm³)'], ['8.50', 'Latão (8,50 g/cm³)'],
  ['1.04', 'ABS (1,04 g/cm³)'], ['1.24', 'PLA (1,24 g/cm³)'], ['1.14', 'Náilon (1,14 g/cm³)']];
let density = 7.85;
function showMass() {
  if (state.mode !== 'idle') return;
  const d = massData();
  if (!d.box) { setStatus('Não há sólidos para avaliar.', true); return; }
  const render = () => {
    const size = v3.sub(d.box.max, d.box.min);
    const rows = [['Volume', `${fmt(d.volume, 1)} mm³`], ['', `${fmt(d.volume / 1000, 3)} cm³`], ['Área de superfície', `${fmt(d.area, 1)} mm²`],
      ['Massa', `${fmt((d.volume / 1000) * density, 2)} g`], ['Centro de massa', `${d.cg.map(x => fmt(x)).join('; ')} mm`], ['Dimensões', `${size.map(x => fmt(x)).join(' × ')} mm`]];
    openProps('Propriedades de massa', [fieldset('Material', selectField('Densidade', String(density), MATERIALS, v => { density = Number(v); render(); })),
      fieldset('Resultados', h('table', {}, rows.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b))))),
      h('p', { class: 'note' }, 'O ponto laranja na vista marca o centro de massa.')], { confirm: false });
  };
  render();
  showComMarker(d.cg, Math.max(...v3.sub(d.box.max, d.box.min)) * 0.025);
  setStatus('Propriedades de massa calculadas.');
}
/* ---- Centro de massa: uma pequena esfera desenhada por cima da peça ---- */
let comMarker = null;
function showComMarker(c, r) {
  const n = 10, P = [], N = [], I = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= 2 * n; j++) {
    const a = (Math.PI * i) / n, b = (Math.PI * j) / n, v = [Math.sin(a) * Math.cos(b), Math.sin(a) * Math.sin(b), Math.cos(a)];
    P.push(c[0] + v[0] * r, c[1] + v[1] * r, c[2] + v[2] * r); N.push(...v);
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < 2 * n; j++) { const a = i * (2 * n + 1) + j, b = a + 2 * n + 1; I.push(a, b, a + 1, a + 1, b, b + 1); }
  comMarker = [{ positions: new Float32Array(P), normals: new Float32Array(N), indices: new Uint32Array(I) }];
  uploadMeshes(); requestRender();
}
function clearComMarker() { if (comMarker) { comMarker = null; uploadMeshes(); requestRender(); } }

/* ---- Análises visuais: zebra, ângulo de saída, curvatura ---- */
function setAnalysis(mode) {
  const an = gfx.analysis;
  an.mode = an.mode === mode ? 0 : mode;
  renderRibbon(); requestRender();
  if (an.mode === 2) {
    openProps('Análise de ângulo de saída', [fieldset('Direção de extração do molde', selectField('Direção', an.pull.join(','), [['0,0,1', '+Z (para cima)'], ['0,0,-1', '−Z'], ['1,0,0', '+X'], ['-1,0,0', '−X'], ['0,1,0', '+Y'], ['0,-1,0', '−Y']],
      v => { an.pull = v.split(',').map(Number); requestRender(); }), numberField('Ângulo mínimo', an.draft, v => { an.draft = v; requestRender(); }, { min: 0, step: 0.5, unit: '°' })),
    h('p', { class: 'note' }, 'Verde: sai do molde. Amarelo: ângulo menor que o mínimo (paredes retas). Vermelho: face presa (contra a direção).')], { confirm: false });
  } else if (an.mode === 1) setStatus('Zebra: listras contínuas indicam faces que se encontram sem quina. Clique de novo para desligar.');
  else if (an.mode === 3) setStatus('Curvatura: azul é plano, vermelho é curvo. Clique de novo para desligar.');
  else setStatus('Sombreado normal.');
}

function toggleSection() {
  if (state.mode === 'section') { endMode(); return; }
  if (state.mode !== 'idle') return;
  const box = modelBox();
  if (!box) { setStatus('Não há sólidos para cortar.', true); return; }
  state.mode = 'section';
  const ax = { x: 0, y: 1, z: 2 }[state.section.axis];
  state.section.pos = (box.min[ax] + box.max[ax]) / 2;
  applySection(); renderSectionPM(); renderRibbon();
  setStatus('Vista de seção: escolha o eixo e mova o plano de corte.');
}
function applySection() {
  const s = state.section, n = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[s.axis];
  gfx.clip = { normal: n, w: s.pos };
  requestRender();
}
function renderSectionPM() {
  const box = modelBox(), s = state.section, ax = { x: 0, y: 1, z: 2 }[s.axis];
  const min = box.min[ax], max = box.max[ax];
  const slider = h('input', { type: 'range', min, max, step: (max - min) / 400 || 0.1, value: s.pos, style: 'width:100%' });
  const value = h('span', {}, `${fmt(s.pos)} mm`);
  slider.addEventListener('input', () => { s.pos = Number(slider.value); value.textContent = `${fmt(s.pos)} mm`; applySection(); });
  openProps('Vista de seção', [fieldset('Plano de corte',
    selectField('Perpendicular a', s.axis, [['x', 'X'], ['y', 'Y'], ['z', 'Z']], v => { s.axis = v; const k = { x: 0, y: 1, z: 2 }[v]; s.pos = (box.min[k] + box.max[k]) / 2; applySection(); renderSectionPM(); }),
    h('label', { class: 'wide' }, 'Posição', slider), value)]);
}

/** Sai do modo atual (esboço, recurso, medição ou seção) sem aplicar. */
function endMode() {
  state.mode = 'idle';
  state.edit = null; state.sketch = null; state.measure = []; state.hover = null;
  gfx.clip = null;
  canvas.style.cursor = 'default';
  if (state.tab === 'sketch') state.tab = 'features';
  closeProps();
  renderRibbon();
  drawLines();
}
function cancelMode() {
  const wasEditing = state.mode === 'feature' || state.mode === 'sketch';
  endMode();
  if (wasEditing) { regenerate(); setStatus('Operação cancelada.'); } else setStatus('Pronto.');
}

/* ---- Etiquetas sobre a vista ---- */
const tags = [];
function tag(position, text, cls = '') { const el = h('div', { class: `tag ${cls}` }, text); $('#overlay').append(el); tags.push({ el, position }); }
function clearTags() { tags.length = 0; $('#overlay').replaceChildren(); }
function positionTags() { for (const t of tags) { const p = cam.project(t.position); t.el.style.left = `${p.x}px`; t.el.style.top = `${p.y}px`; } }

/* =========================================================================
   Arquivos
   ========================================================================= */
function download(data, filename, type) {
  const a = h('a', { href: URL.createObjectURL(new Blob([data], { type })), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
const toBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const fromBase64 = (t) => { const s = atob(t), o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; };
const projectJson = () => JSON.stringify({ format: '3de/1', name: state.name, units: 'mm', features: state.features, configs: state.configs });

/* ---- Banco de dados (PostgreSQL no servidor) ----
   O site não tem login: cada navegador cria uma chave aleatória e só enxerga os
   próprios projetos salvos, que o servidor guarda na tabela "projetos". */
const ownerKey = (() => {
  try {
    let k = localStorage.getItem('3de-dono');
    if (!k || !/^[A-Za-z0-9_-]{16,64}$/.test(k)) {
      k = (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''));
      localStorage.setItem('3de-dono', k);
    }
    return k;
  } catch { return null; }
})();
async function cloud(path, options = {}) {
  if (!ownerKey) throw new Error('Este navegador não guarda dados.');
  const r = await fetch(path, { ...options, headers: { 'X-3DE-Dono': ownerKey, ...(options.headers || {}) } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Erro ${r.status}`);
  return r;
}
async function saveToCloud() {
  try {
    const r = await cloud('/api/projetos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: projectJson() });
    const { banco } = await r.json();
    setStatus(`Projeto salvo: ${state.name}.3de e no banco de dados (${banco}).`);
  } catch (err) { setStatus(`Projeto salvo em ${state.name}.3de; o banco de dados não respondeu (${err.message}).`, true); }
}
function saveProject() { download(projectJson(), `${state.name}.3de`, 'application/json'); remember(); setStatus(`Projeto salvo: ${state.name}.3de.`); saveToCloud(); }
function saveLocal() { try { localStorage.setItem('3de-autosave', projectJson()); } catch { /* indisponível */ } }
function remember() {
  try {
    const list = JSON.parse(localStorage.getItem('3de-recentes') || '[]').filter(r => r.name !== state.name);
    list.unshift({ name: state.name, date: new Date().toLocaleString('pt-BR'), json: projectJson() });
    localStorage.setItem('3de-recentes', JSON.stringify(list.slice(0, 5)));
  } catch { /* indisponível */ }
}

function parseStl(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength >= 84) {
    const count = view.getUint32(80, true);
    if (84 + count * 50 === buffer.byteLength) {
      const p = new Float32Array(count * 9);
      for (let i = 0; i < count; i++) for (let k = 0; k < 9; k++) p[i * 9 + k] = view.getFloat32(84 + i * 50 + 12 + k * 4, true);
      return flatMesh(p, null);
    }
  }
  const vals = [...new TextDecoder().decode(buffer).matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
  if (!vals.length || vals.length % 9) throw Error('Arquivo STL inválido.');
  return flatMesh(new Float32Array(vals), null);
}
function stlFrom(meshes) {
  let count = 0;
  for (const m of meshes) count += (m.indices ? m.indices.length : m.positions.length / 3) / 3;
  const buf = new ArrayBuffer(84 + count * 50), view = new DataView(buf);
  view.setUint32(80, count, true);
  let o = 84;
  for (const { positions: P, indices: I } of meshes) {
    const total = I ? I.length : P.length / 3;
    for (let i = 0; i < total; i += 3) {
      const g = (k) => { const q = (I ? I[i + k] : i + k) * 3; return [P[q], P[q + 1], P[q + 2]]; };
      const a = g(0), b = g(1), c = g(2), n = v3.norm(v3.cross(v3.sub(b, a), v3.sub(c, a)));
      for (const v of [n, a, b, c]) { view.setFloat32(o, v[0], true); view.setFloat32(o + 4, v[1], true); view.setFloat32(o + 8, v[2], true); o += 12; }
      o += 2;
    }
  }
  return buf;
}
function exportStl() {
  const meshes = visibleMeshes();
  if (!meshes.length) { setStatus('Não há sólidos para exportar.', true); return; }
  download(stlFrom(meshes), `${state.name}.stl`, 'model/stl');
  setStatus(`STL exportado: ${state.name}.stl.`);
}
async function importFile(file) {
  if (!/\.(stl|obj)$/i.test(file.name)) { setStatus('Importe uma malha STL ou OBJ (para STEP/IGES, exporte como STL no programa de origem).', true); return; }
  try {
    const mesh = /\.obj$/i.test(file.name) ? flatMesh(parseObj(await file.text()), null) : parseStl(await file.arrayBuffer());
    addImport(mesh, file.name.replace(/\.[^.]+$/, ''));
  } catch (error) { setStatus(error.message, true); }
}
/** Grupos (um por corpo) para os formatos que guardam nomes: OBJ, 3MF, STEP. */
function exportGroups() {
  const groups = state.bodies.filter(b => !state.hidden.has(b.name)).map(b => ({ name: b.name, meshes: [displayMesh(b)] }));
  for (const f of state.features) if (f.type === 'import' && !f.suppressed && !state.hidden.has(f.name) && state.imports.has(f.id)) groups.push({ name: f.name, meshes: [state.imports.get(f.id)] });
  return groups;
}
function exportAs(kind) {
  const groups = exportGroups();
  if (!groups.length) { setStatus('Não há sólidos para exportar.', true); return; }
  const safe = state.name.replace(/[^\w\- ]+/g, '_');
  if (kind === 'obj') download(toObj(groups), `${state.name}.obj`, 'model/obj');
  else if (kind === '3mf') download(to3mf(groups), `${state.name}.3mf`, 'model/3mf');
  else if (kind === 'step') download(toStep(groups, safe), `${state.name}.step`, 'model/step');
  setStatus(`${kind.toUpperCase()} exportado: ${state.name}.${kind === 'step' ? 'step' : kind}.`);
}
function saveAs() {
  const n = prompt('Salvar como (nome do projeto):', state.name);
  if (!n || !n.trim()) return;
  pushUndo(); state.name = n.trim(); $('#docTitle').textContent = state.name; renderTree(); saveProject();
}
function recalcAll() { regenerate(); setStatus(`Peça recalculada: ${state.features.length} recursos.`); }
let playTimer = 0;
function playHistory() {
  if (!idle() || !state.features.length) return;
  clearInterval(playTimer);
  let k = 0;
  setRollback(0);
  playTimer = setInterval(() => {
    k++;
    setRollback(k);
    if (k >= state.features.length) { clearInterval(playTimer); setStatus('Histórico reproduzido do início ao fim.'); }
  }, 650);
}

/* =========================================================================
   Montar: componentes, juntas, vista explodida, lista de materiais
   ========================================================================= */
function insertDesign() { if (idle()) $('#fileDesign').click(); }
async function insertDesignFile(file) {
  try {
    const data = JSON.parse(await file.text());
    let features = data.features;
    if (!Array.isArray(features) && Array.isArray(data.commands)) features = commandsToFeatures(data.commands, () => `t${Math.random().toString(36).slice(2, 9)}`);
    if (!Array.isArray(features)) throw Error('Projeto não reconhecido.');
    const box = modelBox();
    const draft = { id: newId(), type: 'insert_design', name: nextName(`${(data.name || file.name.replace(/\.[^.]+$/, '')).slice(0, 30)} `).trim(), design: { name: data.name, features },
      dx: box ? Math.round(box.max[0] - box.min[0] + 20) : 0, dy: 0, dz: 0, rz: 0 };
    hideHome();
    beginEdit(draft, null, true);
    setStatus(`${features.length} recursos de “${data.name || file.name}” entram como corpos desta montagem. Posicione e confirme; depois use Junta para dar movimento.`);
  } catch (error) { setStatus(`Não foi possível inserir: ${error.message}`, true); }
}
let driveFrame = 0;
function stopDrive() { cancelAnimationFrame(driveFrame); driveFrame = 0; }
function driveJoints() {
  if (!idle()) return;
  const joints = (state.info.joints || []).filter(j => j.kind !== 'rigid');
  if (!joints.length) { setStatus('Crie uma junta de revolução ou deslizante primeiro (Montar › Junta).', true); return; }
  const refresh = () => { uploadMeshes(); requestRender(); };
  const rows = joints.map(j => {
    const lo = Number.isFinite(j.min) ? j.min : 0, hi = Number.isFinite(j.max) && j.max > lo ? j.max : lo + (j.kind === 'revolute' ? 360 : 100);
    const value = h('span', {}, `${fmt(state.pose.get(j.id) ?? j.value)} ${j.kind === 'revolute' ? '°' : 'mm'}`);
    const slider = h('input', { type: 'range', min: lo, max: hi, step: (hi - lo) / 360, value: state.pose.get(j.id) ?? j.value, style: 'width:100%' });
    slider.addEventListener('input', () => { stopDrive(); state.pose.set(j.id, Number(slider.value)); value.textContent = `${fmt(Number(slider.value))} ${j.kind === 'revolute' ? '°' : 'mm'}`; refresh(); });
    const animate = () => {
      stopDrive();
      const t0 = performance.now();
      const step = (t) => { const s = ((t - t0) / 2500) % 2, u = s < 1 ? s : 2 - s, v = lo + (hi - lo) * (0.5 - 0.5 * Math.cos(Math.PI * u));
        state.pose.set(j.id, v); slider.value = v; value.textContent = `${fmt(v)} ${j.kind === 'revolute' ? '°' : 'mm'}`; refresh(); driveFrame = requestAnimationFrame(step); };
      driveFrame = requestAnimationFrame(step);
    };
    return fieldset(`${j.name} · ${j.kind === 'revolute' ? 'revolução' : 'deslizante'} · ${j.body}`, h('label', { class: 'wide' }, 'Posição', slider), value,
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: animate }, 'Animar'), h('button', { class: 'btn', onclick: stopDrive }, 'Parar'),
        h('button', { class: 'btn', onclick: () => { stopDrive(); state.pose.delete(j.id); slider.value = j.value; value.textContent = `${fmt(j.value)}`; refresh(); } }, 'Voltar')));
  });
  openProps('Acionar juntas', [...rows, h('p', { class: 'note' }, 'O movimento é só de visualização: para gravar uma posição, edite a junta e mude a posição atual.')], { confirm: false });
}
function showExplode() {
  if (!idle()) return;
  if (state.bodies.length < 2) { setStatus('A vista explodida precisa de pelo menos dois corpos.', true); return; }
  const value = h('span', {}, `${Math.round(state.explode * 100)}%`);
  const slider = h('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: state.explode, style: 'width:100%' });
  slider.addEventListener('input', () => { state.explode = Number(slider.value); value.textContent = `${Math.round(state.explode * 100)}%`; uploadMeshes(); drawLines(); });
  openProps('Vista explodida', [fieldset('Afastamento', h('label', { class: 'wide' }, 'Distância', slider), value,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { state.explode = 0; slider.value = 0; value.textContent = '0%'; uploadMeshes(); drawLines(); } }, 'Montar de novo'))),
  h('p', { class: 'note' }, 'Cada corpo se afasta do centro da montagem. É só visualização: a peça não muda.')], { confirm: false });
}
function showBom() {
  if (!idle()) return;
  if (!state.bodies.length) { setStatus('Não há corpos na montagem.', true); return; }
  const groups = new Map();
  for (const b of state.bodies) {
    const vol = Math.abs(volumeOf(b.polys)), key = `${b.name.replace(/(\s#\d+|\*+|\s\(cópia\)|\s\(parte \d+\))$/, '')}|${vol.toFixed(1)}`;
    const g = groups.get(key) || { name: b.name.replace(/(\s#\d+|\*+)$/, ''), vol, qty: 0 };
    g.qty++; groups.set(key, g);
  }
  const rows = [...groups.values()];
  const csv = ['Item;Descrição;Quantidade;Volume (mm³);Massa (g)', ...rows.map((r, i) => `${i + 1};${r.name};${r.qty};${r.vol.toFixed(1)};${((r.vol / 1000) * density).toFixed(2)}`)].join('\n');
  openProps('Lista de materiais', [fieldset(`Material: ${MATERIALS.find(m => Number(m[0]) === density)?.[1] || density}`, h('table', {}, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Corpo'), h('th', {}, 'Qtd.'), h('th', {}, 'Massa')),
    rows.map((r, i) => h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, r.name), h('td', {}, String(r.qty)), h('td', {}, `${fmt((r.vol / 1000) * density * r.qty, 1)} g`))))),
  h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => download(csv, `${state.name} - lista de materiais.csv`, 'text/csv') }, 'Salvar CSV'))], { confirm: false });
}

function addImport(mesh, name) {
  pushUndo();
  const f = { id: newId(), type: 'import', name: `Importado: ${name}`, stl: toBase64(new Uint8Array(stlFrom([mesh]))) };
  state.imports.set(f.id, mesh);
  state.features.push(f);
  hideHome();
  regenerate();
  setView('iso');
  setStatus(`${name} importado (${fmt(mesh.positions.length / 9, 0)} triângulos).`);
}

function loadProject(data, name) {
  let features;
  if (Array.isArray(data.features)) features = data.features;
  else if (Array.isArray(data.commands)) features = commandsToFeatures(data.commands, () => `t${Math.random().toString(36).slice(2, 9)}`);
  else throw Error('Arquivo de projeto não reconhecido.');
  state.imports.clear();
  state.hidden.clear();
  state.nextId = 1;
  const remap = new Map();
  for (const f of features) { const id = `f${state.nextId++}`; remap.set(f.id, id); f.id = id; }
  for (const f of features) {
    for (const k of ['sketch', 'profile', 'path']) if (f[k]) f[k] = remap.get(f[k]) || f[k];
    if (Array.isArray(f.sketches)) f.sketches = f.sketches.map(id => remap.get(id) || id);
  }
  for (const f of features) if (f.type === 'import' && f.stl) state.imports.set(f.id, parseStl(fromBase64(f.stl).buffer));
  state.features = features;
  state.configs = Array.isArray(data.configs) ? data.configs : [];
  state.rollback = null; state.clash = [];
  state.name = data.name || name || 'Sem título';
  $('#docTitle').textContent = state.name;
  state.undo = []; state.redo = []; state.selected = null;
  hideHome();
  regenerate();
  setView('iso');
}
function newPart() {
  if (state.features.length && !confirm('Descartar a peça atual e começar uma nova?')) return;
  if (state.mode !== 'idle') endMode();
  Object.assign(state, { features: [], undo: [], redo: [], selected: null, nextId: 1, name: 'Sem título', configs: [], rollback: null, clash: [] });
  state.imports.clear(); state.hidden.clear();
  $('#docTitle').textContent = state.name;
  hideHome();
  regenerate();
  setView('iso');
  select('plane:XY');
  setStatus('Nova peça em milímetros. Clique em Novo esboço para começar.');
}

/* ---- Página inicial ---- */
function showHome() {
  const recents = (() => { try { return JSON.parse(localStorage.getItem('3de-recentes') || '[]'); } catch { return []; } })();
  $('#recents').replaceChildren(...(recents.length ? recents.map(r => h('button', { onclick: () => loadProject(JSON.parse(r.json), r.name) }, h('b', {}, r.name), h('small', {}, r.date)))
    : [h('div', { class: 'empty' }, icon('part'), h('b', {}, 'Nenhum projeto recente'), 'Os projetos que você salvar aparecerão aqui.')]));
  // Projetos guardados no banco de dados substituem a lista local quando o servidor responde.
  cloud('/api/projetos').then(r => r.json()).then(({ projetos, banco }) => {
    if (!projetos.length) return;
    $('#recents').replaceChildren(...projetos.slice(0, 8).map(p => h('button', {
      onclick: async () => {
        try { loadProject(await (await cloud(`/api/projetos/${p.id}`)).json(), p.nome); }
        catch (err) { setStatus(`Não foi possível abrir o projeto: ${err.message}`, true); }
      },
    }, h('b', {}, p.nome), h('small', {}, `${new Date(p.atualizado_em * 1000).toLocaleString('pt-BR')} · ${banco}`))));
  }).catch(() => { /* sem servidor: fica a lista local */ });
  const examples = [['Suporte com cubo cilíndrico', { kind: 'exercise32' }], ['Eixo escalonado', { kind: 'stepped_shaft', shaft_length: 100, end_length: 15, shoulder_length: 10, end_diameter: 10, shoulder_diameter: 15, center_diameter: 20 }],
    ['Flange com furos', { kind: 'round', outer_diameter: 100, thickness: 12, bore_diameter: 30, hole_1_x: 35, hole_1_y: 0, hole_1_diameter: 10, hole_2_x: -35, hole_2_y: 0, hole_2_diameter: 10, hole_3_x: 0, hole_3_y: 35, hole_3_diameter: 10, hole_4_x: 0, hole_4_y: -35, hole_4_diameter: 10 }],
    ['Bloco com cavidade', { kind: 'apostila1', geometry: { template_id: '2d' } }]];
  $('#examples').replaceChildren(...examples.map(([label, values]) => h('button', { onclick: () => openExample(label, values) }, h('b', {}, label), h('small', {}, 'Exemplo'))));
  fillIcons($('#home'));
  $('#home').classList.remove('hidden');
  $('#app').classList.add('at-home');
}
function hideHome() {
  $('#home').classList.add('hidden');
  // Ferramentas de projeto só aparecem quando há uma peça aberta.
  if ($('#app').classList.contains('at-home')) {
    $('#app').classList.remove('at-home');
    window.dispatchEvent(new Event('resize'));
  }
}
async function openExample(label, values) {
  try {
    const r = await fetch(`/api/modelo-projeto?name=${encodeURIComponent(label.replace(/\s+/g, '-'))}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
    const body = await r.json();
    if (!r.ok) throw Error(body.error);
    const project = await (await fetch(body.url)).json();
    project.name = label;  // o servidor guarda um nome sem acentos; na tela vale o nome legível
    loadProject(project, label);
    setStatus(`Exemplo aberto: ${label}. Clique duas vezes num recurso para editar.`);
  } catch (error) { setStatus(`Não foi possível abrir o exemplo: ${error.message}`, true); }
}

/* =========================================================================
   Faixa de comandos
   ========================================================================= */
const idle = () => state.mode === 'idle';
const cmd = (iconName, label, run, enabled = idle, active = () => false, soon = false) => ({ icon: iconName, label, run, enabled, active, soon });
const SOON = (iconName, label) => cmd(iconName, label, null, () => false, () => false, true);
const F = (type, shape) => () => startFeature(type, shape);
const inSketch = () => state.mode === 'sketch';
const tool = (iconName, label, name) => cmd(iconName, label, () => setTool(name), inSketch, () => sk()?.tool === name);
const toggleOrtho = () => { cam.ortho = !cam.ortho; renderRibbon(); drawLines(); setStatus(cam.ortho ? 'Projeção ortográfica (sem perspectiva).' : 'Projeção em perspectiva.'); };
const showAll = () => { state.hidden.clear(); uploadMeshes(); renderTree(); drawLines(); setStatus('Todos os corpos visíveis.'); };
// Organização no estilo do SolidWorks: botões grandes para os comandos principais, colunas
// de três botões pequenos ao lado e as abas embaixo da faixa.
const stack = (...items) => ({ stack: items });
const canSketch = () => idle() || inSketch();
const always = () => true;
const sketchButton = cmd('sketch', 'Esboço', () => (inSketch() ? confirmSketch() : startSketch()), canSketch, inSketch);
const TABS = {
  features: { label: 'Recursos', groups: [
    [cmd('extrude', 'Ressalto extrudado', F('extrude')), cmd('revolve', 'Ressalto revolucionado', F('revolve')),
      stack(cmd('sweep', 'Ressalto por varredura', F('sweep')), cmd('loft', 'Ressalto por transição', F('loft')), cmd('pipe', 'Tubo', F('pipe')))],
    [cmd('hole', 'Assistente de furação', F('hole')), cmd('pushpull', 'Corte extrudado', F('extrude', 'cut')),
      stack(cmd('revolve', 'Corte revolucionado', F('revolve', 'cut')), cmd('coil', 'Hélice / mola', F('coil')), cmd('thread', 'Rosca', F('thread')))],
    [cmd('fillet', 'Filete', F('fillet')),
      stack(cmd('chamfer', 'Chanfro', F('chamfer')), cmd('shell', 'Casca', F('shell')), cmd('offsetface', 'Deslocar face', F('offset_face'))),
      cmd('pattern', 'Padrão linear', F('pattern')),
      stack(cmd('cpattern', 'Padrão circular', F('cpattern')), cmd('mirror', 'Espelhar', F('mirror')), cmd('move', 'Mover / copiar', F('move')))],
    [stack(cmd('combine', 'Combinar', F('combine')), cmd('split', 'Dividir corpo', F('split')), cmd('scale', 'Escala', F('scale'))),
      stack(cmd('remove', 'Remover corpo', F('remove')), cmd('bounding', 'Sólido envolvente', F('bounding')), cmd('interference', 'Interferência', checkInterference))],
    [cmd('box', 'Caixa', F('primitive', 'box')),
      stack(cmd('cylinder', 'Cilindro', F('primitive', 'cylinder')), cmd('sphere', 'Esfera', F('primitive', 'sphere')), cmd('torus', 'Toro', F('primitive', 'torus'))),
      stack(cmd('cone', 'Cone', F('primitive', 'cone')), cmd('tube', 'Cilindro oco', F('primitive', 'tube')), cmd('prism', 'Prisma', F('primitive', 'prism'))),
      stack(cmd('wedge', 'Cunha', F('primitive', 'wedge')))],
    [cmd('plane', 'Geometria de referência', offsetPlane), stack(cmd('params', 'Equações (parâmetros)', showParameters), cmd('table', 'Tabela de configurações', showConfigs))],
  ] },
  sketch: { label: 'Esboço', groups: [
    [sketchButton, stack(cmd('select', 'Selecionar', () => setTool('select'), inSketch, () => sk()?.tool === 'select'), tool('measure', 'Cota inteligente', 'dim'))],
    [tool('line', 'Linha', 'poly'), stack(tool('path', 'Linha aberta', 'path'), tool('arc', 'Arco', 'arc'), tool('slot', 'Rasgo', 'slot')),
      tool('rect', 'Retângulo', 'rect'), stack(tool('crect', 'Retângulo central', 'crect'), tool('rrect', 'Retângulo arredondado', 'rrect'), tool('polygon', 'Polígono', 'polygon')),
      tool('circle', 'Círculo', 'circle'), stack(tool('ellipse', 'Elipse', 'ellipse'))],
    [cmd('smirror', 'Espelhar entidades', () => sketchOp('mirror'), inSketch), stack(cmd('soffset', 'Deslocar entidades', () => sketchOp('offset'), inSketch),
      cmd('smove', 'Mover / copiar entidades', () => sketchOp('move'), inSketch), cmd('construction', 'Geometria de construção', toggleConstruction, inSketch)),
    stack(cmd('spattern', 'Padrão linear do esboço', () => sketchOp('rpattern'), inSketch), cmd('cpattern', 'Padrão circular do esboço', () => sketchOp('cpattern'), inSketch),
      cmd('trash', 'Excluir entidade', deleteEntity, inSketch))],
    [stack(cmd('sinsert', 'Inserir DXF / SVG', () => $('#fileSketch').click(), inSketch), cmd('dxf', 'Salvar como DXF', () => exportSketchDxf(), inSketch),
      cmd('edgepick', 'Alinhamento automático', () => { state.snapAlign = !state.snapAlign; savePrefs(); setStatus(state.snapAlign ? 'Alinhamento automático ligado: as linhas puxam para 0°, 90° e 180°.' : 'Alinhamento automático desligado.'); }, always, () => state.snapAlign))],
    [cmd('finish', 'Sair do esboço', confirmSketch, inSketch)],
  ] },
  surfaces: { label: 'Superfícies', groups: [
    [cmd('surfext', 'Superfície extrudada', F('surf_extrude')), cmd('surfrev', 'Superfície revolucionada', F('surf_revolve')),
      stack(cmd('loft', 'Superfície por transição', F('surf_loft')), cmd('patch', 'Superfície plana', F('patch')), cmd('surfoff', 'Superfície equidistante', F('surf_offset')))],
    [cmd('thicken', 'Espessar', F('thicken')), stack(cmd('flipn', 'Inverter normal', F('reverse_normal')), cmd('remove', 'Excluir superfície', F('remove')))],
  ] },
  assembly: { label: 'Montagem', groups: [
    [cmd('insertdesign', 'Inserir componente', insertDesign), cmd('joint', 'Posicionar (junta)', F('joint')),
      stack(cmd('move', 'Mover componente', F('move')), cmd('cpattern', 'Padrão de componente', F('cpattern')), cmd('drive', 'Acionar juntas', driveJoints))],
    [cmd('explode', 'Vista explodida', showExplode), stack(cmd('bom', 'Lista de materiais', showBom), cmd('interference', 'Detecção de interferência', checkInterference))],
  ] },
  evaluate: { label: 'Avaliar', groups: [
    [cmd('measure', 'Medir', startMeasure, idle, () => state.mode === 'measure'), cmd('mass', 'Propriedades de massa', showMass),
      stack(cmd('section', 'Vista de seção', toggleSection, () => idle() || state.mode === 'section', () => state.mode === 'section'), cmd('interference', 'Interferência', checkInterference), cmd('com', 'Centro de massa', showMass))],
    [stack(cmd('zebra', 'Listras zebradas', () => setAnalysis(1), always, () => gfx.analysis.mode === 1), cmd('draft', 'Análise de inclinação', () => setAnalysis(2), always, () => gfx.analysis.mode === 2),
      cmd('curvature', 'Curvatura', () => setAnalysis(3), always, () => gfx.analysis.mode === 3))],
    [stack(cmd('play', 'Reproduzir histórico', playHistory), cmd('recalc', 'Reconstruir tudo', recalcAll))],
  ] },
  view: { label: 'Vista', groups: [
    [cmd('iso', 'Isométrica', () => setView('iso'), always), stack(cmd('front', 'Frontal', () => setView('front'), always), cmd('top', 'Superior', () => setView('top'), always), cmd('right', 'Direita', () => setView('right'), always)),
      stack(cmd('front', 'Posterior', () => setView('back'), always), cmd('top', 'Inferior', () => setView('bottom'), always), cmd('right', 'Esquerda', () => setView('left'), always))],
    [cmd('fit', 'Ajustar à tela', () => fitView(), always), stack(cmd('edges', 'Sombreado com arestas', () => { gfx.edges = !gfx.edges; savePrefs(); requestRender(); }, always, () => gfx.edges),
      cmd('ortho', 'Projeção ortográfica', toggleOrtho, always, () => cam.ortho), cmd('showall', 'Mostrar todos', showAll, always))],
    [cmd('gear', 'Opções', showPreferences, always)],
  ] },
  file: { label: 'Arquivo', groups: [
    [cmd('newdoc', 'Novo', newPart, always), cmd('openbox', 'Abrir', () => $('#fileOpen').click(), always), stack(cmd('save', 'Salvar', saveProject), cmd('saveas', 'Salvar como', saveAs))],
    [stack(cmd('stl', 'Exportar STL', exportStl), cmd('obj', 'Exportar OBJ', () => exportAs('obj')), cmd('mf3', 'Exportar 3MF', () => exportAs('3mf'))),
      stack(cmd('step', 'Exportar STEP', () => exportAs('step')), cmd('importm', 'Importar malha', () => $('#fileImport').click()), cmd('insertdesign', 'Inserir projeto', insertDesign))],
    [cmd('scanner', 'Digitalizador 3D', () => { location.href = '/ler-desenho'; }, always)],
  ] },
};
/* =========================================================================
   Preferências: tema (escuro, claro, Win 95), material da peça e opções
   ========================================================================= */
const THEMES = {
  dark: { label: 'Escuro (3DE)', note: 'Grafite com laranja', edge: [0.05, 0.06, 0.08], grid: [1, 1, 1], gridAlpha: 0.16, sketchGrid: [0.55, 0.72, 1],
    cube: { face: [24, 32, 48], gain: [22, 26, 30], stroke: '#3b4b66', text: '#dfe6f1', hot: 'rgba(255,138,61,.9)', hotStroke: '#ffb07a', hotText: '#1a0d03', ring: 'rgba(143,156,177,.35)' } },
  light: { label: 'Claro', note: 'Fundo claro, como uma folha', edge: [0.12, 0.14, 0.18], grid: [0.2, 0.26, 0.36], gridAlpha: 0.22, sketchGrid: [0.2, 0.4, 0.8],
    cube: { face: [206, 214, 226], gain: [40, 34, 26], stroke: '#8a98ad', text: '#1d2533', hot: 'rgba(255,138,61,.95)', hotStroke: '#c25a12', hotText: '#fff', ring: 'rgba(80,96,120,.35)' } },
  win95: { label: 'Win 95', note: 'Cinza clássico e fundo verde-água', edge: [0, 0, 0], grid: [0.25, 0.63, 0.63], gridAlpha: 0.35, sketchGrid: [0.75, 1, 1],
    cube: { face: [170, 170, 170], gain: [40, 40, 40], stroke: '#000000', text: '#000000', hot: '#000080', hotStroke: '#000000', hotText: '#ffffff', ring: 'rgba(0,0,0,.45)' } },
};
// Aparência e densidade juntas: escolher o material muda o visual e a massa calculada.
const LOOKS = {
  aco: { label: 'Aço', color: [0.70, 0.72, 0.75], metal: 0.85, rough: 0.38, tex: 1, density: 7.85 },
  inox: { label: 'Aço inox', color: [0.78, 0.79, 0.81], metal: 0.95, rough: 0.14, tex: 0, density: 7.9 },
  aluminio: { label: 'Alumínio', color: [0.84, 0.86, 0.89], metal: 0.82, rough: 0.3, tex: 1, density: 2.7 },
  ferro: { label: 'Ferro fundido', color: [0.40, 0.41, 0.43], metal: 0.45, rough: 0.8, tex: 2, density: 7.2 },
  latao: { label: 'Latão', color: [0.86, 0.69, 0.36], metal: 0.9, rough: 0.28, tex: 1, density: 8.5 },
  cobre: { label: 'Cobre', color: [0.86, 0.52, 0.36], metal: 0.9, rough: 0.3, tex: 0, density: 8.96 },
  abs: { label: 'Plástico ABS branco', color: [0.90, 0.90, 0.88], metal: 0, rough: 0.5, tex: 3, density: 1.04 },
  pla: { label: 'Plástico PLA azul', color: [0.22, 0.47, 0.88], metal: 0, rough: 0.38, tex: 0, density: 1.24 },
  nylon: { label: 'Náilon', color: [0.93, 0.91, 0.84], metal: 0, rough: 0.7, tex: 3, density: 1.14 },
  borracha: { label: 'Borracha', color: [0.13, 0.13, 0.14], metal: 0, rough: 0.92, tex: 2, density: 1.2 },
  cinza: { label: 'Cinza CAD', color: [0.74, 0.77, 0.81], metal: 0.2, rough: 0.5, tex: 0, density: 7.85 },
};
const prefs = { theme: 'dark', look: 'aco', edges: true, snapAlign: true, ortho: false };
function loadPrefs() {
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('3de-prefs') || '{}')); } catch { /* sem armazenamento */ }
  if (!THEMES[prefs.theme]) prefs.theme = 'dark';
  if (!LOOKS[prefs.look]) prefs.look = 'aco';
  applyPrefs();
}
function savePrefs() {
  prefs.edges = gfx.edges; prefs.snapAlign = state.snapAlign; prefs.ortho = cam.ortho;
  try { localStorage.setItem('3de-prefs', JSON.stringify(prefs)); } catch { /* sem armazenamento */ }
}
function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  const th = THEMES[prefs.theme], lk = LOOKS[prefs.look];
  gfx.edgeColor = th.edge;
  gfx.edges = prefs.edges !== false;
  cam.ortho = !!prefs.ortho;
  state.snapAlign = prefs.snapAlign !== false;
  Object.assign(gfx.material, { metal: lk.metal, rough: lk.rough, tex: lk.tex });
  COLORS.body = lk.color;
  density = lk.density;
  uploadMeshes(); drawLines();
}
function showPreferences() {
  const card = (key, t) => h('button', { class: `theme-card ${prefs.theme === key ? 'on' : ''}`, 'data-preview': key,
    onclick: () => { prefs.theme = key; savePrefs(); applyPrefs(); showPreferences(); } }, h('span', { class: 'swatch' }, h('i'), h('i'), h('i')), h('b', {}, t.label), h('small', {}, t.note));
  openProps('Preferências', [
    fieldset('Tema', h('div', { class: 'themes' }, Object.entries(THEMES).map(([k, t]) => card(k, t)))),
    fieldset('Material da peça', selectField('Aparência', prefs.look, Object.entries(LOOKS).map(([k, l]) => [k, l.label]), v => { prefs.look = v; savePrefs(); applyPrefs(); }),
      h('p', { class: 'note' }, 'O material muda a cor na vista 3D e a densidade usada em Propriedades de massa.')),
    fieldset('Vista', checkField('Mostrar arestas', gfx.edges, v => { gfx.edges = v; savePrefs(); requestRender(); }),
      checkField('Projeção ortográfica', cam.ortho, v => { cam.ortho = v; savePrefs(); drawLines(); })),
    fieldset('Esboço', checkField('Alinhamento automático (0°, 90°, 180°)', state.snapAlign, v => { state.snapAlign = v; savePrefs(); }),
      h('p', { class: 'note' }, 'Com o alinhamento ligado, a linha que chega perto da horizontal ou da vertical fica reta sozinha, e um ponto alinhado com outro mostra uma guia tracejada.')),
  ], { confirm: false });
}

/** Todos os comandos de uma aba (abrindo as colunas empilhadas). */
const tabCommands = (t) => (t.groups || []).flat().flatMap(it => it.stack || [it]);
function renderRibbon() {
  // No esboço a aba Esboço vai para a frente, como no SolidWorks.
  if (inSketch() && state.tab !== 'sketch' && !state.tabPinned) state.tab = 'sketch';
  if (!inSketch()) state.tabPinned = false;
  if (!TABS[state.tab]) state.tab = 'features';
  $('#tabs').replaceChildren(...Object.entries(TABS).map(([key, t]) =>
    h('button', { class: `${key === state.tab ? 'active' : ''} ${key === 'sketch' && inSketch() ? 'context' : ''}`, onclick: () => { state.tab = key; state.tabPinned = inSketch(); renderRibbon(); } }, t.label)));
  const button = (c, size) => h('button', { class: `cmd ${size} ${c.active() ? 'active' : ''}`, disabled: !c.enabled(), title: c.label, onclick: () => { c.run(); renderRibbon(); } },
    icon(c.icon), h('span', { class: 'lbl' }, c.label));
  $('#groups').replaceChildren(...TABS[state.tab].groups.map(items => h('div', { class: 'group' },
    items.map(it => (it.stack ? h('div', { class: 'stack' }, it.stack.map(c => button(c, 'small'))) : button(it, 'big'))))));
  $('#qUndo').disabled = !state.undo.length; $('#qRedo').disabled = !state.redo.length;
}
// Pesquisa de comandos: executa o primeiro comando cujo nome contém o texto.
$('#cmdSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim().toLowerCase();
  for (const [key, t] of Object.entries(TABS)) for (const c of tabCommands(t)) {
    if (c.label.toLowerCase().replace(/\s+/g, ' ').includes(q) && c.enabled()) { state.tab = key; renderRibbon(); c.run(); e.target.value = ''; e.target.blur(); return; }
  }
  setStatus(`Nenhum comando encontrado para “${q}”.`, true);
});

/* ---- Barra de vista e menus ---- */
function buildChrome() {
  fillIcons();
  const tools = [['orbit', 'Girar: arraste com o botão esquerdo', null], ['pan', 'Mover: arraste com o botão direito', null], ['zoom', 'Aproximar: roda do mouse', null], null,
    ['fit', 'Ajustar à tela', () => fitView()], ['iso', 'Isométrica', () => setView('iso')], ['front', 'Frontal', () => setView('front')], ['top', 'Superior', () => setView('top')], ['right', 'Direita', () => setView('right')], null,
    ['section', 'Vista de seção', toggleSection], ['edges', 'Mostrar arestas', () => { gfx.edges = !gfx.edges; renderRibbon(); requestRender(); }]];
  $('#viewtools').replaceChildren(...tools.map(t => (t ? h('button', { title: t[1], html: ICON[t[0]], onclick: t[2] || (() => setStatus(t[1])) }) : h('span', { class: 'sep' }))));
  const menu = [['Nova peça', newPart, 'Ctrl+N'], ['Abrir projeto…', () => $('#fileOpen').click(), 'Ctrl+O'], ['Salvar projeto', saveProject, 'Ctrl+S'], ['Salvar como…', saveAs, 'Ctrl+Shift+S'], null,
    ['Importar malha STL/OBJ…', () => $('#fileImport').click(), ''], ['Inserir projeto na montagem…', insertDesign, ''], null,
    ['Exportar STL', exportStl, ''], ['Exportar OBJ', () => exportAs('obj'), ''], ['Exportar 3MF', () => exportAs('3mf'), ''], ['Exportar STEP', () => exportAs('step'), ''], null,
    ['Digitalizador 3D', () => { location.href = '/ler-desenho'; }, '']];
  $('#fileMenu').replaceChildren(...menu.map(m => (m ? h('button', { onclick: () => { closeMenus(); m[1](); } }, m[0], h('kbd', {}, m[2])) : h('hr'))));
  $('#fileMenuBtn').onclick = () => $('#fileMenu').classList.toggle('hidden');
  $('#qSave').onclick = saveProject; $('#qUndo').onclick = undo; $('#qRedo').onclick = redo;
  $('#newDoc').onclick = newPart; $('#closeDoc').onclick = newPart;
  $('#homeBtn').onclick = showHome; $('#projectBtn').onclick = showHome;
  $('#settingsBtn').onclick = showPreferences;
  $('#groups').addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); $('#groups').scrollLeft += e.deltaY; } }, { passive: false });
  $('#cubeHome').onclick = () => setView('iso');
  $('#tlStart').onclick = () => setRollback(0);
  $('#tlPrev').onclick = () => setRollback(activeCount() - 1);
  $('#tlNext').onclick = () => setRollback(activeCount() + 1);
  $('#tlEnd').onclick = () => setRollback(state.features.length);
  $('#docTitle').ondblclick = () => {
    const n = prompt('Nome da peça:', state.name);
    if (n && n.trim()) { pushUndo(); state.name = n.trim(); $('#docTitle').textContent = state.name; renderTree(); saveLocal(); }
  };
  $('#helpBtn').onclick = () => openProps('Atalhos e ajuda', [
    fieldset('Vista', h('table', {}, [['Girar', 'Arrastar com o botão esquerdo'], ['Mover', 'Arrastar com o botão direito'], ['Aproximar', 'Roda do mouse'], ['Vista inicial', 'Casa ao lado do cubo']]
      .map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b))))),
    fieldset('Teclado', h('table', {}, [['Pesquisar comando', 'S'], ['Salvar', 'Ctrl+S'], ['Abrir', 'Ctrl+O'], ['Nova peça', 'Ctrl+N'], ['Desfazer / refazer', 'Ctrl+Z / Ctrl+Y'],
      ['Confirmar / cancelar', 'Enter / Esc'], ['Excluir recurso', 'Delete'], ['Repetir último comando', 'Shift+R'], ['Salvar como', 'Ctrl+Shift+S'],
      ['Esboço: retângulo, círculo, linha', 'R, C, L'], ['Esboço: arco, polígono', 'A, P'], ['Esboço: construção, deslocar, mover', 'X, O, M']].map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b))))),
    fieldset('Histórico', h('p', { class: 'note' }, 'A linha do tempo no rodapé mostra os recursos em ordem. Arraste o marcador laranja para ver a peça em um passo anterior; um novo recurso entra na posição do marcador.')),
  ], { confirm: false });
  $('#cmdList').replaceChildren(...Object.values(TABS).flatMap(tabCommands).filter(c => !c.soon)
    .map(c => c.label.replace(/\s+/g, ' ')).filter((v, i, a) => a.indexOf(v) === i).map(l => h('option', { value: l })));
  $('#okBtn').onclick = () => {
    if (state.mode === 'sketch') confirmSketch(); else if (state.mode === 'feature') confirmEdit(); else { endMode(); setStatus('Pronto.'); }
  };
  $('#cancelBtn').onclick = cancelMode;
  renderRibbon();
}

/* =========================================================================
   Eventos da área 3D: girar, mover, aproximar, clicar
   ========================================================================= */
let drag = null, lastPointer = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true; drag.x = e.clientX; drag.y = e.clientY;
    const rotate = (drag.button === 0 && state.mode !== 'sketch') || drag.button === 1;
    if (rotate) cam.orbit(dx, dy); else cam.pan(dx, dy);
    drawLines();
    return;
  }
  if (state.mode === 'sketch') {
    const p = pointerToSketch(px, py), s = sk();
    s.cursor = p; lastPointer = [px, py];
    if (p) { const d = toDisplay(p); $('#cursor').textContent = `${fmt(d[0])} ; ${fmt(d[1])} mm`; }
    const hov = p && (s.tool === 'select' || s.tool === 'dim') ? hitEntity(p) : -1;
    if (s.tool !== 'select' || hov !== s.hover) { s.hover = hov; drawLines(); }
  } else if (state.mode === 'feature' && PICK_TYPES.includes(state.edit?.draft.type)) featureHover(px, py);
});
canvas.addEventListener('pointerup', (e) => {
  const d = drag; drag = null;
  if (!d || d.moved || d.button !== 0) return;
  const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  if (state.mode === 'sketch') sketchClick(px, py);
  else if (state.mode === 'feature') featureClick(px, py);
  else if (state.mode === 'measure') {
    const p = gfx.pick(px, py);
    if (!p) return;
    if (state.measure.length >= 3) state.measure = [];
    state.measure.push(p);
    renderMeasurePM(); drawLines();
  }
});
canvas.addEventListener('dblclick', () => { if (state.mode === 'sketch' && ['poly', 'path'].includes(sk().tool)) closePolygon(); });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  cam.zoom(Math.exp(e.deltaY * 0.0012), e.clientX - r.left, e.clientY - r.top);
  drawLines();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  // Enter num campo de medida confirma o recurso (como o ✓).
  if (e.key === 'Enter' && e.target.matches('#propsBody input[type=number], #propsBody select') && (state.mode === 'feature' || state.mode === 'sketch')) {
    e.target.blur(); $('#okBtn').click(); return;
  }
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey && k === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey && e.shiftKey && k === 's') { e.preventDefault(); saveAs(); return; }
  if (e.ctrlKey && k === 's') { e.preventDefault(); saveProject(); return; }
  if (e.ctrlKey && k === 'o') { e.preventDefault(); $('#fileOpen').click(); return; }
  if (e.ctrlKey && k === 'n') { e.preventDefault(); newPart(); return; }
  if (state.mode === 'sketch') {
    const s = sk();
    if (e.key === 'Escape') { if (s.temp.length) { s.temp = []; drawLines(); } else setTool('select'); }
    else if (e.key === 'Enter') { if (['poly', 'path'].includes(s.tool) && s.temp.length) closePolygon(); else confirmSketch(); }
    else if (e.key === 'Delete') deleteEntity();
    else if (/^[0-9.]$/.test(e.key) && ['poly', 'path'].includes(s.tool) && s.temp.length) { e.preventDefault(); typeLineLength(e.key); }
    else if (k === 'd') setTool('dim');
    else if (k === 'r') setTool('rect'); else if (k === 'c') setTool('circle'); else if (k === 'l') setTool('poly');
    else if (k === 'a') setTool('arc'); else if (k === 'p') setTool('polygon'); else if (k === 'x') toggleConstruction();
    else if (k === 'o') sketchOp('offset'); else if (k === 'm') sketchOp('move');
    return;
  }
  if (e.shiftKey && k === 'r' && idle()) { e.preventDefault(); if (state.lastCmd) state.lastCmd(); else setStatus('Nenhum comando para repetir.', true); return; }
  // Atalhos de modelagem (sem Ctrl), com o mesmo significado dos comandos da faixa.
  if (!e.ctrlKey && !e.altKey && idle()) {
    const solidKeys = { e: () => F('extrude')(), h: () => F('hole')(), f: () => F('fillet')(), m: () => F('move')(), i: () => startMeasure() };
    if (solidKeys[k]) { e.preventDefault(); solidKeys[k](); return; }
  }
  if (k === 's' && !e.ctrlKey) { e.preventDefault(); $('#cmdSearch').focus(); return; }
  if (e.key === 'Escape') cancelMode();
  else if (e.key === 'Enter' && state.mode !== 'idle') $('#okBtn').click();
  else if (e.key === 'Delete' && idle() && state.features.some(f => f.id === state.selected)) deleteFeature(state.selected);
});

$('#fileOpen').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (/\.(stl|obj)$/i.test(f.name)) { importFile(f); return; }   // "Abrir arquivo" também aceita malhas
  try { loadProject(JSON.parse(await f.text()), f.name.replace(/\.[^.]+$/, '')); setStatus(`${f.name} aberto.`); }
  catch (error) { setStatus(`Não foi possível abrir: ${error.message}`, true); }
});
$('#fileImport').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });
$('#fileSketch').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f && state.mode === 'sketch') insertSketchFile(f); });
$('#fileDesign').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) insertDesignFile(f); });
for (const b of document.querySelectorAll('[data-home]')) {
  b.addEventListener('click', () => ({ new: newPart, open: () => $('#fileOpen').click(), import: () => $('#fileImport').click() })[b.dataset.home]());
}
$('#viewport').addEventListener('dragover', (e) => e.preventDefault());
$('#viewport').addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (/\.(3de|json)$/i.test(f.name)) f.text().then(t => loadProject(JSON.parse(t), f.name.replace(/\.[^.]+$/, '')));
  else importFile(f);
});

/* =========================================================================
   Início
   ========================================================================= */
async function openFromUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw Error('A peça enviada pelo Digitalizador 3D expirou. Gere-a novamente.');
  const name = decodeURIComponent(url.split('/').pop().replace(/\.[^.]+$/, ''));
  if (/\.stl$/i.test(url)) addImport(parseStl(await r.arrayBuffer()), name);
  else loadProject(await r.json(), name);
}
async function main() {
  loadPrefs();
  buildChrome();
  resize();
  const open = new URLSearchParams(location.search).get('open');
  if (open) {
    try { await openFromUrl(open); setStatus('Peça recebida do Digitalizador 3D. Clique duas vezes num recurso para editar as medidas.'); }
    catch (error) { setStatus(error.message, true); }
    history.replaceState(null, '', '/');
    return;
  }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('3de-autosave') || 'null'); } catch { saved = null; }
  if (saved?.features?.length) { loadProject(saved, saved.name); setStatus('Último trabalho restaurado.'); }
  else { regenerate(); setView('iso'); }
  showHome();
}
main().catch(error => setStatus(`Falha ao iniciar: ${error.message}`, true));
