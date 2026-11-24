// Motor gráfico do 3DE (WebGL2, implementação própria).
//
// Passos de cada quadro:
//  1. Desenha peças e linhas num framebuffer com duas saídas: cor sombreada e normal.
//  2. Na vista de seção, desenha as faces internas (lado de trás) em cor de corte.
//  3. Um passo de tela cheia compara normais e profundidade dos pixels vizinhos e
//     escurece onde há mudança brusca: são as arestas e as silhuetas da peça.

/* ------------------------------------------------------------- matemática */
export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  mid: (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
};

function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function lookAt(eye, target, up) {
  const z = v3.norm(v3.sub(eye, target)), x = v3.norm(v3.cross(up, z)), y = v3.cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -v3.dot(x, eye), -v3.dot(y, eye), -v3.dot(z, eye), 1];
}
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function invert(m) {
  const inv = new Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  return inv.map(v => v / (det || 1));
}
function transform(m, p) {
  const x = p[0], y = p[1], z = p[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
}

/* ---------------------------------------------------------------- shaders */
const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNormal;
uniform mat4 uVP; out vec3 vPos; out vec3 vNormal;
void main(){ vPos=aPos; vNormal=aNormal; gl_Position=uVP*vec4(aPos,1.0); }`;
const MESH_FS = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vNormal;
uniform vec3 uColor; uniform vec3 uEye; uniform vec4 uClip; uniform int uClipOn; uniform int uCap; uniform float uAlpha;
uniform int uMode; uniform vec3 uPull; uniform float uDraft; uniform int uTwoSide; uniform int uOrtho; uniform vec3 uViewDir;
uniform float uMetal; uniform float uRough; uniform int uTex; uniform vec3 uKey; uniform vec3 uFill; uniform float uTexScale;
layout(location=0) out vec4 oColor; layout(location=1) out vec4 oNormal;
float hash(vec3 p){ return fract(sin(dot(p,vec3(12.9898,78.233,37.719)))*43758.5453); }
float noise(vec3 p){
  vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
void main(){
  if(uClipOn==1 && dot(uClip.xyz,vPos)-uClip.w>0.0) discard;
  if(uCap==1){ oColor=vec4(uColor,1.0); oNormal=vec4(uClip.xyz*0.5+0.5,1.0); return; }
  vec3 n=normalize(vNormal);
  vec3 v=uOrtho==1 ? -uViewDir : normalize(uEye-vPos);
  if(uTwoSide==1 && dot(n,v)<0.0) n=-n;          // superfícies: os dois lados são visíveis
  float head=max(dot(n,v),0.0);
  // Textura do material (procedural, no espaço da peça em mm).
  vec3 base=uColor; float rough=uRough;
  vec3 q=vPos*uTexScale;
  if(uTex==1){
    // Metal escovado: riscos finos numa direção da face.
    vec3 a=abs(n.x)>0.8 ? vec3(0,1,0) : vec3(1,0,0);
    vec3 t=normalize(cross(n,a));
    float s=dot(q,t)*1.6;
    float g=0.55*noise(vec3(s,dot(q,a)*0.05,0.0))+0.45*noise(vec3(s*3.1,0.0,dot(q,a)*0.12));
    base*=0.78+0.36*g; rough=clamp(rough+0.25*(g-0.5),0.05,1.0);
  } else if(uTex==2){
    // Ferro fundido / borracha: granulado irregular.
    float g=0.6*noise(q*0.9)+0.4*noise(q*2.6);
    base*=0.72+0.45*g; rough=clamp(rough+0.25*(g-0.5),0.05,1.0);
  } else if(uTex==3){
    // Plástico texturizado: pontinhos suaves.
    float g=noise(q*1.4);
    base*=0.9+0.14*g;
  }
  // Luz de estúdio: céu e chão, luz principal, luz de preenchimento e reflexo do ambiente.
  vec3 amb=mix(vec3(0.16,0.165,0.18),vec3(0.40,0.43,0.48),0.5+0.5*n.z);
  float kd=max(dot(n,uKey),0.0), fd=max(dot(n,uFill),0.0);
  vec3 diffuse=base*(amb+vec3(1.0,0.97,0.92)*kd*0.78+vec3(0.75,0.82,1.0)*fd*0.26)*(1.0-uMetal*0.35);
  vec3 h=normalize(uKey+v);
  float shin=mix(160.0,10.0,rough);
  float spec=pow(max(dot(n,h),0.0),shin)*mix(1.4,0.25,rough);
  vec3 F0=mix(vec3(0.045),base,uMetal);
  float fres=pow(1.0-head,5.0);
  vec3 F=F0+(vec3(1.0)-F0)*fres*(1.0-rough*0.85);
  vec3 r=reflect(-v,n);
  // Estúdio: chão cinza, horizonte claro, teto branco e duas caixas de luz.
  vec3 env=mix(vec3(0.32,0.33,0.36),vec3(0.80,0.83,0.88),smoothstep(-0.35,0.05,r.z));
  env=mix(env,vec3(1.0),smoothstep(0.25,0.85,r.z));
  env+=vec3(0.9)*smoothstep(0.88,0.98,r.z);
  env+=vec3(0.7,0.75,0.85)*smoothstep(0.8,0.96,dot(r,normalize(uKey)));
  vec3 c=diffuse+env*F*mix(1.0,0.45,rough)*(0.35+0.75*uMetal)+F*spec;
  c+=vec3(0.05,0.06,0.08)*pow(1.0-head,3.0);                         // contorno de luz
  c=c/(1.0+0.12*c);
  if(uMode==1){
    // Zebra: listras refletidas de um céu listrado mostram a continuidade entre faces.
    vec3 r=reflect(-v,n);
    float s=0.5+0.5*sin(atan(r.z,length(r.xy))*18.0);
    c=mix(vec3(0.07),vec3(0.96),smoothstep(0.42,0.58,s))*(0.55+0.45*head);
  } else if(uMode==2){
    // Ângulo de saída: verde sai do molde, vermelho prende, amarelo está sem ângulo.
    float a=dot(n,normalize(uPull));
    vec3 k=a>uDraft ? vec3(0.25,0.78,0.36) : a<-uDraft ? vec3(0.9,0.27,0.24) : vec3(0.95,0.78,0.22);
    c=k*(0.35+0.65*head);
  } else if(uMode==3){
    // Curvatura aproximada: variação da normal entre pixels vizinhos.
    float k=clamp(length(fwidth(n))*14.0,0.0,1.0);
    c=mix(vec3(0.2,0.42,0.95),vec3(0.95,0.3,0.22),k)*(0.4+0.6*head);
  }
  oColor=vec4(c,uAlpha); oNormal=vec4(n*0.5+0.5,1.0);
}`;
const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos; uniform mat4 uVP;
void main(){ gl_Position=uVP*vec4(aPos,1.0); }`;
const LINE_FS = `#version 300 es
precision highp float; uniform vec4 uColor;
layout(location=0) out vec4 oColor; layout(location=1) out vec4 oNormal;
void main(){ oColor=uColor; oNormal=vec4(0.0); }`;
const POST_VS = `#version 300 es
const vec2 P[3]=vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));
out vec2 vUv; void main(){ vec2 p=P[gl_VertexID]; vUv=p*0.5+0.5; gl_Position=vec4(p,0.,1.); }`;
const POST_FS = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uColor; uniform sampler2D uNormal; uniform sampler2D uDepth;
uniform vec2 uTexel; uniform float uNear; uniform float uFar; uniform vec3 uEdge; uniform float uEdges; uniform int uOrtho;
out vec4 oColor;
float lin(vec2 uv){
  float d=texture(uDepth,uv).r;
  if(uOrtho==1) return uNear+d*(uFar-uNear);
  float z=d*2.0-1.0; return 2.0*uNear*uFar/(uFar+uNear-z*(uFar-uNear));
}
void main(){
  vec4 c=texture(uColor,vUv);
  vec4 n0=texture(uNormal,vUv);
  float e=0.0;
  if(uEdges>0.5){
    vec2 o[4]=vec2[4](vec2(uTexel.x,0.),vec2(-uTexel.x,0.),vec2(0.,uTexel.y),vec2(0.,-uTexel.y));
    float d0=lin(vUv);
    for(int i=0;i<4;i++){
      vec4 n1=texture(uNormal,vUv+o[i]);
      if(n0.a!=n1.a){ e=1.0; break; }                       // silhueta contra o fundo
      if(n0.a>0.5){
        vec3 a=n0.xyz*2.0-1.0, b=n1.xyz*2.0-1.0;
        if(dot(a,b)<0.82) e=1.0;                            // dobra entre faces
      }
    }
    if(n0.a>0.5 && e<0.5){
      // Salto de profundidade (silhueta sobre a própria peça): segunda derivada.
      float dx=abs(lin(vUv+o[0])+lin(vUv+o[1])-2.0*d0);
      float dy=abs(lin(vUv+o[2])+lin(vUv+o[3])-2.0*d0);
      if(max(dx,dy)>0.02*d0) e=1.0;
    }
  }
  oColor=mix(c,vec4(uEdge,1.0),e*0.92);
}`;

// Grade infinita: para cada pixel, o raio da câmera é cortado pelo plano da grade.
// O espaçamento segue o zoom (potências de 10, com transição suave entre níveis),
// as linhas são suavizadas por fwidth e a grade some com a distância.
const GRID_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform mat4 uInvVP; uniform mat4 uVP; uniform vec3 uEye;
uniform vec3 uOrigin; uniform vec3 uU; uniform vec3 uV;
uniform vec3 uColorU; uniform vec3 uColorV; uniform vec3 uTint;
uniform float uScale; uniform float uAlpha; uniform int uOnTop;
layout(location=0) out vec4 oColor; layout(location=1) out vec4 oNormal;
vec3 unproject(vec3 p){ vec4 q=uInvVP*vec4(p,1.0); return q.xyz/q.w; }
float gridLine(vec2 c, float s){
  vec2 w=fwidth(c)/s;
  vec2 g=abs(fract(c/s-0.5)-0.5)/max(w,vec2(1e-6));
  float l=1.0-min(min(g.x,g.y),1.0);
  return l*(1.0-smoothstep(0.12,0.45,max(w.x,w.y)));   // some antes de virar ruído
}
void main(){
  vec2 ndc=vUv*2.0-1.0;
  vec3 a=unproject(vec3(ndc,-1.0)), b=unproject(vec3(ndc,1.0));
  vec3 dir=normalize(b-a), n=normalize(cross(uU,uV));
  float dn=dot(dir,n);
  if(abs(dn)<1e-6) discard;
  float t=dot(uOrigin-a,n)/dn;
  if(t<=0.0) discard;
  vec3 p=a+dir*t;
  vec2 c=vec2(dot(p-uOrigin,uU),dot(p-uOrigin,uV));
  float lv=log(uScale/30.0)/log(10.0), fl=floor(lv), f=lv-fl, s0=pow(10.0,fl);
  float g=max(max(0.45*(1.0-f)*gridLine(c,s0), mix(1.0,0.45,f)*gridLine(c,s0*10.0)), gridLine(c,s0*100.0));
  float dist=length(p-uEye);
  float fade=(1.0-smoothstep(uScale*0.8,uScale*7.0,dist))*smoothstep(0.0,0.12,abs(dot(dir,n)));
  vec2 w=fwidth(c);
  float ax=1.0-min(abs(c.y)/max(w.y,1e-6)*0.8,1.0), ay=1.0-min(abs(c.x)/max(w.x,1e-6)*0.8,1.0);
  vec3 col=uTint; float alpha=g*uAlpha;
  if(ax>0.01){ col=mix(col,uColorU,ax); alpha=max(alpha,ax*0.5); }
  if(ay>0.01){ col=mix(col,uColorV,ay); alpha=max(alpha,ay*0.5); }
  alpha*=fade;
  if(alpha<0.003) discard;
  vec4 clip=uVP*vec4(p,1.0);
  float z=clip.z/clip.w;
  if(uOnTop==0 && (clip.w<=0.0 || z>1.0)) discard;
  gl_FragDepth=uOnTop==1 ? 0.0 : z*0.5+0.5;
  oColor=vec4(col,alpha); oNormal=vec4(0.0);
}`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}

/* ------------------------------------------------------------------ câmera */
export class Camera {
  constructor() {
    this.target = [0, 0, 0];
    this.dist = 300;
    this.az = (-50 * Math.PI) / 180;
    this.el = (28 * Math.PI) / 180;
    this.fov = (32 * Math.PI) / 180;
    this.width = 1; this.height = 1;
    this.ortho = false;   // projeção ortográfica (sem perspectiva), como nos desenhos técnicos
  }
  get eye() {
    const c = Math.cos(this.el);
    return v3.add(this.target, v3.scale([c * Math.cos(this.az), c * Math.sin(this.az), Math.sin(this.el)], this.dist));
  }
  get forward() { return v3.norm(v3.sub(this.target, this.eye)); }
  get right() { return v3.norm(v3.cross(this.forward, [0, 0, 1])); }
  get up() { return v3.cross(this.right, this.forward); }
  get near() { return this.ortho ? -this.dist * 20 : this.dist / 200; }
  get far() { return this.dist * 60; }
  view() { return lookAt(this.eye, this.target, this.up); }
  proj() {
    if (!this.ortho) return perspective(this.fov, this.width / this.height, this.near, this.far);
    const t = this.dist * Math.tan(this.fov / 2), r = t * (this.width / this.height), n = this.near, f = this.far;
    return [1 / r, 0, 0, 0, 0, 1 / t, 0, 0, 0, 0, -2 / (f - n), 0, 0, 0, -(f + n) / (f - n), 1];
  }
  viewProj() { return mul(this.proj(), this.view()); }
  /** Milímetros por pixel na distância do alvo. */
  mmPerPixel() { return (2 * this.dist * Math.tan(this.fov / 2)) / this.height; }
  orbit(dx, dy) {
    this.az -= dx * 0.008;
    this.el = Math.max(-1.5706, Math.min(1.5706, this.el + dy * 0.008));
  }
  pan(dx, dy) {
    const s = this.mmPerPixel();
    this.target = v3.add(this.target, v3.add(v3.scale(this.right, -dx * s), v3.scale(this.up, dy * s)));
  }
  /** Aproxima mantendo fixo o ponto sob o cursor. */
  zoom(factor, px, py) {
    const before = this.rayAt(px, py);
    this.dist = Math.max(0.5, Math.min(200000, this.dist * factor));
    const after = this.rayAt(px, py);
    const plane = (r) => { const t = v3.dot(v3.sub(this.target, r.origin), this.forward) / v3.dot(r.dir, this.forward); return v3.add(r.origin, v3.scale(r.dir, t)); };
    this.target = v3.add(this.target, v3.sub(plane(before), plane(after)));
  }
  setView(az, el) { this.az = az; this.el = el; }
  /** Raio que sai da câmera passando pelo pixel (px, py). */
  rayAt(px, py) {
    const inv = invert(this.viewProj());
    const x = (px / this.width) * 2 - 1, y = 1 - (py / this.height) * 2;
    const a = transform(inv, [x, y, -1]), b = transform(inv, [x, y, 1]);
    return { origin: a, dir: v3.norm(v3.sub(b, a)) };
  }
  /** Mundo -> pixel (x, y) e se está na frente da câmera. */
  project(p) {
    const q = transform(this.viewProj(), p);
    return { x: ((q[0] + 1) / 2) * this.width, y: ((1 - q[1]) / 2) * this.height, visible: q[2] < 1 };
  }
  fit(min, max) {
    const center = v3.mid(min, max);
    const radius = Math.max(v3.dist(min, max) / 2, 10);
    this.target = center;
    this.dist = (radius / Math.sin(this.fov / 2)) * 1.05;
  }
}

/* ---------------------------------------------------------------- renderizador */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    // Alfa pré-multiplicado: a mistura das linhas já multiplica a cor pela transparência.
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true });
    if (!gl) throw Error('Este navegador não tem WebGL2.');
    this.gl = gl;
    this.camera = new Camera();
    this.mesh = compile(gl, MESH_VS, MESH_FS);
    this.line = compile(gl, LINE_VS, LINE_FS);
    this.post = compile(gl, POST_VS, POST_FS);
    this.gridProg = compile(gl, POST_VS, GRID_FS);
    // Grade: {origin, u, v, colorU, colorV, tint, alpha, onTop} ou null.
    this.grid = null;
    this.meshes = [];   // {vao, count, color, alpha, pick: {positions, indices}}
    this.lines = [];    // {vao, count, color, depth}
    this.clip = null;   // {normal, w, cap}
    this.edges = true;
    // Análise visual: 0 sombreado, 1 zebra, 2 ângulo de saída, 3 curvatura.
    this.analysis = { mode: 0, pull: [0, 0, 1], draft: 1 };
    // Material das peças: metal (0–1), aspereza (0–1), textura (0 lisa, 1 escovada, 2 granulada, 3 plástico).
    this.material = { metal: 0.85, rough: 0.35, tex: 1, scale: 1 };
    this.edgeColor = [0.05, 0.06, 0.08];
    this.fb = null;
    this.emptyVao = gl.createVertexArray();
  }

  resize(width, height) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
    this.camera.width = width; this.camera.height = height;
    if (this.canvas.width === w && this.canvas.height === h && this.fb) return;
    this.canvas.width = w; this.canvas.height = h;
    this.makeTargets(w, h);
  }

  makeTargets(w, h) {
    const gl = this.gl;
    if (this.fb) { gl.deleteFramebuffer(this.fb.fbo); for (const t of this.fb.tex) gl.deleteTexture(t); }
    const tex = (internal, format, type) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t;
    };
    const color = tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    const normal = tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    const depth = tex(gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, normal, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fb = { fbo, tex: [color, normal, depth], w, h };
  }

  _buffer(vao, location, data, size) {
    const gl = this.gl, b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    return b;
  }

  _free(items) {
    const gl = this.gl;
    for (const item of items) { gl.deleteVertexArray(item.vao); for (const b of item.buffers) gl.deleteBuffer(b); }
  }
  clearMeshes() { this._free(this.meshes); this.meshes = []; }
  clearLines() { this._free(this.lines); this.lines = []; }

  /** Malha com normais por vértice; positions/indices também servem para a seleção. */
  addMesh({ positions, normals, indices }, color, { alpha = 1, pickable = true, tag = null, onTop = false, twoSide = false, plain = false } = {}) {
    const gl = this.gl, vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffers = [this._buffer(vao, 0, positions, 3), this._buffer(vao, 1, normals, 3)];
    let count = positions.length / 3, indexed = false;
    if (indices) {
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      buffers.push(ib); count = indices.length; indexed = true;
    }
    gl.bindVertexArray(null);
    // onTop: desenhada por cima de tudo (ex.: volume de interferência dentro das peças).
    this.meshes.push({ vao, buffers, count, indexed, color, alpha: onTop ? Math.min(alpha, 0.999) : alpha, onTop, twoSide, plain, pick: pickable ? { positions, indices } : null, tag });
  }

  /** Segmentos de reta: pares de pontos [x,y,z, x,y,z, ...]. */
  addLines(points, color, { depth = true } = {}) {
    if (!points.length) return;
    const gl = this.gl, vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffers = [this._buffer(vao, 0, points instanceof Float32Array ? points : new Float32Array(points), 3)];
    gl.bindVertexArray(null);
    this.lines.push({ vao, buffers, count: points.length / 3, color, depth });
  }

  render() {
    const gl = this.gl, cam = this.camera, fb = this.fb;
    if (!fb) return;
    const vp = cam.viewProj();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb.fbo);
    gl.viewport(0, 0, fb.w, fb.h);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    // Peças.
    const m = this.mesh;
    gl.useProgram(m.p);
    gl.uniformMatrix4fv(m.u.uVP, false, vp);
    gl.uniform3fv(m.u.uEye, cam.eye);
    gl.uniform1i(m.u.uClipOn, this.clip ? 1 : 0);
    if (this.clip) gl.uniform4f(m.u.uClip, ...this.clip.normal, this.clip.w);
    const an = this.analysis;
    gl.uniform1i(m.u.uMode, an.mode);
    gl.uniform3fv(m.u.uPull, an.pull);
    gl.uniform1f(m.u.uDraft, Math.sin(((Number(an.draft) || 0) * Math.PI) / 180));
    gl.uniform1i(m.u.uOrtho, cam.ortho ? 1 : 0);
    gl.uniform3fv(m.u.uViewDir, cam.forward);
    // Luzes presas à câmera: a principal vem de cima e da esquerda, o preenchimento da direita.
    const R = cam.right, U = cam.up, Fw = cam.forward;
    const mix3 = (a, b, c) => v3.norm(v3.add(v3.add(v3.scale(R, a), v3.scale(U, b)), v3.scale(Fw, -c)));
    gl.uniform3fv(m.u.uKey, mix3(-0.45, 0.75, 0.55));
    gl.uniform3fv(m.u.uFill, mix3(0.7, -0.15, 0.6));
    const mat = this.material;
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    const draw = (item, cap) => {
      gl.uniform1i(m.u.uCap, cap ? 1 : 0);
      const plain = item.plain || item.twoSide || item.alpha < 1;
      gl.uniform1f(m.u.uMetal, plain ? 0 : mat.metal);
      gl.uniform1f(m.u.uRough, plain ? 0.55 : mat.rough);
      gl.uniform1i(m.u.uTex, plain ? 0 : mat.tex);
      gl.uniform1f(m.u.uTexScale, mat.scale || 1);
      gl.uniform1i(m.u.uTwoSide, item.twoSide ? 1 : 0);
      gl.uniform3fv(m.u.uColor, cap ? [0.86, 0.38, 0.22] : item.color);
      gl.uniform1f(m.u.uAlpha, item.alpha);
      if (item.twoSide && !cap) gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(item.vao);
      if (item.indexed) gl.drawElements(gl.TRIANGLES, item.count, gl.UNSIGNED_INT, 0);
      else gl.drawArrays(gl.TRIANGLES, 0, item.count);
      if (item.twoSide && !cap) gl.enable(gl.CULL_FACE);
    };
    gl.cullFace(gl.BACK);
    for (const item of this.meshes) if (item.alpha >= 1) draw(item, false);
    if (this.clip) {
      // Faces de trás vistas pelo corte: pintadas como material seccionado.
      gl.cullFace(gl.FRONT);
      for (const item of this.meshes) if (item.alpha >= 1 && !item.twoSide) draw(item, true);
      gl.cullFace(gl.BACK);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);

    gl.enable(gl.BLEND);
    // A cor mistura pela transparência; o alfa acumula (senão a linha ficaria invisível sobre o fundo).
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Grade infinita (escondida pelas peças, exceto no modo esboço).
    if (this.grid) {
      const g = this.grid, gp = this.gridProg;
      gl.useProgram(gp.p);
      gl.uniformMatrix4fv(gp.u.uInvVP, false, invert(vp));
      gl.uniformMatrix4fv(gp.u.uVP, false, vp);
      gl.uniform3fv(gp.u.uEye, cam.eye);
      gl.uniform3fv(gp.u.uOrigin, g.origin);
      gl.uniform3fv(gp.u.uU, g.u);
      gl.uniform3fv(gp.u.uV, g.v);
      gl.uniform3fv(gp.u.uColorU, g.colorU);
      gl.uniform3fv(gp.u.uColorV, g.colorV);
      gl.uniform3fv(gp.u.uTint, g.tint || [1, 1, 1]);
      gl.uniform1f(gp.u.uAlpha, g.alpha ?? 0.16);
      gl.uniform1f(gp.u.uScale, cam.dist);
      gl.uniform1i(gp.u.uOnTop, g.onTop ? 1 : 0);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(false);
      if (g.onTop) gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.enable(gl.CULL_FACE);
    }

    // Linhas com teste de profundidade (contornos de planos, eixos).
    const l = this.line;
    gl.useProgram(l.p);
    gl.uniformMatrix4fv(l.u.uVP, false, vp);
    for (const item of this.lines) if (item.depth) { gl.uniform4fv(l.u.uColor, item.color); gl.bindVertexArray(item.vao); gl.drawArrays(gl.LINES, 0, item.count); }

    // Peças translúcidas (planos de referência) depois das linhas.
    gl.useProgram(m.p);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    for (const item of this.meshes) if (item.alpha < 1 && !item.onTop) draw(item, false);
    if (this.meshes.some(m => m.onTop)) {
      gl.disable(gl.DEPTH_TEST);
      gl.uniform1i(m.u.uClipOn, 0);
      for (const item of this.meshes) if (item.onTop) draw(item, false);
      gl.uniform1i(m.u.uClipOn, this.clip ? 1 : 0);
      gl.enable(gl.DEPTH_TEST);
    }
    gl.depthMask(true);

    // Linhas por cima de tudo (esboço, medição).
    gl.useProgram(l.p);
    gl.disable(gl.DEPTH_TEST);
    for (const item of this.lines) if (!item.depth) { gl.uniform4fv(l.u.uColor, item.color); gl.bindVertexArray(item.vao); gl.drawArrays(gl.LINES, 0, item.count); }
    gl.disable(gl.BLEND);

    // Passo final: arestas por diferença de normal e profundidade.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const p = this.post;
    gl.useProgram(p.p);
    fb.tex.forEach((t, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); });
    gl.uniform1i(p.u.uColor, 0); gl.uniform1i(p.u.uNormal, 1); gl.uniform1i(p.u.uDepth, 2);
    gl.uniform2f(p.u.uTexel, 1 / fb.w, 1 / fb.h);
    gl.uniform1f(p.u.uNear, cam.near); gl.uniform1f(p.u.uFar, cam.far);
    gl.uniform3fv(p.u.uEdge, this.edgeColor);
    gl.uniform1f(p.u.uEdges, this.edges ? 1 : 0);
    gl.uniform1i(p.u.uOrtho, cam.ortho ? 1 : 0);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** Ponto da peça sob o pixel (px, py), ou null. Interseção raio-triângulo. */
  pick(px, py) {
    const { origin, dir } = this.camera.rayAt(px, py);
    let best = Infinity, hit = null;
    for (const item of this.meshes) {
      if (!item.pick) continue;
      const { positions: P, indices: I } = item.pick;
      const count = I ? I.length : P.length / 3;
      for (let i = 0; i < count; i += 3) {
        const a = (I ? I[i] : i) * 3, b = (I ? I[i + 1] : i + 1) * 3, c = (I ? I[i + 2] : i + 2) * 3;
        const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
        const h = v3.cross(dir, e2), det = v3.dot(e1, h);
        if (Math.abs(det) < 1e-12) continue;
        const s = [origin[0] - P[a], origin[1] - P[a + 1], origin[2] - P[a + 2]];
        const u = v3.dot(s, h) / det;
        if (u < 0 || u > 1) continue;
        const q = v3.cross(s, e1), v = v3.dot(dir, q) / det;
        if (v < 0 || u + v > 1) continue;
        const t = v3.dot(e2, q) / det;
        if (t > 1e-6 && t < best) {
          const point = v3.add(origin, v3.scale(dir, t));
          if (this.clip && v3.dot(this.clip.normal, point) - this.clip.w > 0) continue;
          best = t; hit = point;
        }
      }
    }
    return hit;
  }

  /** Interseção do raio do pixel com um plano (normal, ponto). */
  pickPlane(px, py, normal, point) {
    const { origin, dir } = this.camera.rayAt(px, py);
    const d = v3.dot(dir, normal);
    if (Math.abs(d) < 1e-9) return null;
    const t = v3.dot(v3.sub(point, origin), normal) / d;
    return t > 0 ? v3.add(origin, v3.scale(dir, t)) : null;
  }
}

/** Normais por face para malhas sem normais (STL importado): desfaz o compartilhamento. */
export function flatMesh(positions, indices) {
  const count = indices ? indices.length : positions.length / 3;
  const P = new Float32Array(count * 3), N = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 3) {
    const ids = [0, 1, 2].map(k => (indices ? indices[i + k] : i + k) * 3);
    const [a, b, c] = ids.map(o => [positions[o], positions[o + 1], positions[o + 2]]);
    const n = v3.norm(v3.cross(v3.sub(b, a), v3.sub(c, a)));
    [a, b, c].forEach((p, k) => { P.set(p, (i + k) * 3); N.set(n, (i + k) * 3); });
  }
  return { positions: P, normals: N, indices: null };
}
