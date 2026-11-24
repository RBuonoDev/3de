"use strict";

const MAX_STL_BYTES = 80_000_000;
const MAX_STL_TRIANGLES = 1_599_998;
const MAX_PREVIEW_TRIANGLES = 24_000;

function facetNormal(points) {
  const [a, b, c] = points;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(...n);
  return length > 0 ? n.map(value => value / length) : [0, 0, 1];
}

function finitePoint(point) {
  return point.every(value => Number.isFinite(value) && Math.abs(value) < 1e9);
}

async function asciiToBinary(data, report) {
  if (data.byteLength > 35_000_000) throw Error("STL em texto acima de 35 MB. Exporte em STL binário para abrir peças maiores.");
  const source = new TextDecoder("utf-8").decode(data);
  if (!/^\s*solid\b/i.test(source) || !/\bfacet\b/i.test(source)) throw Error("O arquivo não contém um STL válido.");
  const numeric = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
  const vertex = new RegExp(`^\\s*vertex\\s+(${numeric})\\s+(${numeric})\\s+(${numeric})\\s*$`, "gim");
  let matches = 0;
  for (const ignored of source.matchAll(vertex)) {
    matches++;
    if (matches > MAX_STL_TRIANGLES * 3) throw Error("STL com triângulos demais.");
  }
  if (!matches || matches % 3) throw Error("STL em texto incompleto: os vértices não formam triângulos.");
  const count = matches / 3;
  const output = new ArrayBuffer(84 + count * 50);
  const view = new DataView(output);
  view.setUint32(80, count, true);
  let points = [], index = 0;
  vertex.lastIndex = 0;
  for (const match of source.matchAll(vertex)) {
    const point = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (!finitePoint(point)) throw Error("STL contém coordenadas inválidas.");
    points.push(point);
    if (points.length === 3) {
      const offset = 84 + index * 50;
      const normal = facetNormal(points);
      for (let j = 0; j < 3; j++) view.setFloat32(offset + j * 4, normal[j], true);
      for (let p = 0; p < 3; p++) for (let j = 0; j < 3; j++) view.setFloat32(offset + 12 + p * 12 + j * 4, points[p][j], true);
      points = [];
      index++;
      if (index % 20_000 === 0) {
        report("Convertendo STL em texto", Math.round(index * 100 / count));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }
  return output;
}

async function parseStl(data, report = () => {}) {
  if (data.byteLength > MAX_STL_BYTES) throw Error("STL acima de 80 MB. Reduza a malha ou divida a peça.");
  if (data.byteLength < 15) throw Error("Arquivo STL incompleto.");
  let binary = data;
  let count = 0;
  if (data.byteLength >= 84 && (data.byteLength - 84) % 50 === 0) {
    const expected = (data.byteLength - 84) / 50;
    const headerCount = new DataView(data).getUint32(80, true);
    if (headerCount === expected || headerCount === 0 || headerCount > expected) count = expected;
  }
  if (!count) {
    report("Lendo STL em texto");
    binary = await asciiToBinary(data, report);
    count = new DataView(binary).getUint32(80, true);
  }
  if (!count || count > MAX_STL_TRIANGLES || 84 + count * 50 !== binary.byteLength) {
    throw Error("STL inválido ou com triângulos demais.");
  }
  const view = new DataView(binary);
  const stride = Math.max(1, Math.ceil(count / MAX_PREVIEW_TRIANGLES));
  const triangles = [];
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const offset = 84 + i * 50;
    const points = [];
    for (let p = 0; p < 3; p++) {
      const point = [0, 1, 2].map(j => view.getFloat32(offset + 12 + p * 12 + j * 4, true));
      if (!finitePoint(point)) throw Error(`STL contém coordenadas inválidas no triângulo ${i + 1}.`);
      for (let j = 0; j < 3; j++) {
        minimum[j] = Math.min(minimum[j], point[j]);
        maximum[j] = Math.max(maximum[j], point[j]);
      }
      if (i % stride === 0) points.push(point);
    }
    if (points.length === 3) triangles.push({points, normal: facetNormal(points)});
    if (i % 20_000 === 0) {
      report("Preparando prévia 3D", Math.round(i * 100 / count));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  report("Preparando prévia 3D", 100);
  return {data: binary, count, previewCount: triangles.length, triangles, minimum, maximum};
}
