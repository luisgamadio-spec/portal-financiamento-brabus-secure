"""Gera assets/js/avaliacoes-vistoria.mjs (homolog) a partir do protótipo APROVADO (prototipo3.html):
copia, por marcadores, os dados das carrocerias, as curvas/seções, a classificação das peças e a geometria
(sem redigitar nada) e junta a cabeça (carregamento sob demanda do three.js) e a cauda (cena + API da tela).
Única mudança visual pedida pelo Luis em 28/10: tirar o reflexo branco do para-brisa (vidro fosco ao sol).
Uso: python -I gera_modulo.py <prototipo3.html> <saida.mjs>"""
import sys
fonte, saida = sys.argv[1], sys.argv[2]
p = open(fonte, encoding="utf-8").read()

def entre(a, b):
    i = p.index(a); j = p.index(b, i)
    return p[i:j].rstrip() + "\n"

dados = entre("const C = {", "// tipos de avaria conforme a peça")
cores = entre("const COR_GRAV", "for (const c of Object.values(C))")
prep = entre("for (const c of Object.values(C))", "// ---------------------------------------------------------------- curvas e seções")
geo = entre("// ---------------------------------------------------------------- curvas e seções", "// ---------------------------------------------------------------- cena")
pecas = entre("function material(grupo)", "function montar()")

# reflexo do para-brisa: vidro mais fosco e quase sem reflexo do ambiente
assert cores.count("vidro: [.3, .28]") == 1
cores = cores.replace("vidro: [.3, .28]", "vidro: [.2, .62]")
assert pecas.count("envMapIntensity: grupo === 'vidro' ? .25 : .9") == 1
pecas = pecas.replace("envMapIntensity: grupo === 'vidro' ? .25 : .9", "envMapIntensity: grupo === 'vidro' ? .12 : .9")
# a cor da gravidade vem da tela com os códigos do banco (LEVE/MEDIA/GRAVE)
assert cores.count("const COR_GRAV = { Leve: 0xf5c518, 'Média': 0xff8c1a, Grave: 0xe3262f };") == 1
cores = cores.replace("const COR_GRAV = { Leve: 0xf5c518, 'Média': 0xff8c1a, Grave: 0xe3262f };",
                      "const COR_GRAV = { LEVE: 0xf5c518, MEDIA: 0xff8c1a, GRAVE: 0xe3262f };")

cabeca = '''/* PORTAL-NEXT V2 — Avaliações de Seminovos: vistoria 3D (Fase 2, 28/10/2026).
   Carro desenhado por código (sem arquivo de modelo): silhueta lateral em curvas por carroceria,
   volume gerado a partir dela e peças recortadas da própria superfície (cada peça é uma malha
   separada que acende ao tocar e fica com a cor da pior gravidade marcada).
   GERADO por docs/avaliacoes/fase2/vistoria3d_v3/gera_modulo.py a partir do protótipo aprovado
   (prototipo3.html) — ajustes de desenho vão no protótipo e este arquivo é gerado de novo.
   three.js r160 fica em vendor/three-0.160.0 e só é baixado quando a vistoria abre. */

let THREE, mergeGeometries, LineSegments2, LineSegmentsGeometry, LineMaterial, carregando = null;
function carregar() {
  if (!carregando) {
    const v = new URL('./vendor/three-0.160.0/', import.meta.url);
    carregando = Promise.all(['three.module.min.js', 'BufferGeometryUtils.js', 'LineSegments2.js', 'LineSegmentsGeometry.js', 'LineMaterial.js']
      .map(f => import(new URL(f, v).href))).then(([t, u, l2, lg, lm]) => {
        THREE = t; mergeGeometries = u.mergeGeometries; LineSegments2 = l2.LineSegments2;
        LineSegmentsGeometry = lg.LineSegmentsGeometry; LineMaterial = lm.LineMaterial;
      }).catch(e => { carregando = null; throw e; });
  }
  return carregando;
}

'''

cauda = r'''
// ---------------------------------------------------------------- cena e API da tela
let carro, partes = [], bloqueios = [], linhaMat, renderer;
const VISTAS = { '3D': [-0.75, 1.15], 'Frente': [0, 1.38], 'Traseira': [Math.PI, 1.38], 'Lat. esq.': [-Math.PI / 2, 1.47], 'Lat. dir.': [Math.PI / 2, 1.47], 'Teto': [-Math.PI / 2, .06] };

function estudio() {   // panorama gerado (só depende da altura), sem emendas nem objetos que virem listras
  const W = 256, H = 128, d = new Float32Array(W * H * 4), ss = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  for (let j = 0; j < H; j++) {
    const h = Math.sin(Math.PI * ((j + .5) / H - .5));
    let c = .04 + (.2 - .04) * ss(-.35, .05, h); c += .45 * Math.exp(-(((h - .18) / .1) ** 2)); c = c + (.42 - c) * ss(.35, .95, h);
    for (let i = 0; i < W; i++) d.set([c, c, c, 1], (j * W + i) * 4);
  }
  const t = new THREE.DataTexture(d, W, H, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping; t.needsUpdate = true;
  const pm = new THREE.PMREMGenerator(renderer), env = pm.fromEquirectangular(t).texture;
  pm.dispose(); t.dispose();
  return env;
}

/* criar(palco, { carroceria, aoTocar(nome, grupo) }) -> Promise<controle>
   controle: marcar({ chave: 'LEVE'|'MEDIA'|'GRAVE' }), destacar(nome|null), vista(nome), partes(), onde(nome), destruir() */
export async function criar(palco, opcoes) {
  await carregar();
  if (renderer) destruirAtual();
  const c = C[opcoes.carroceria] || C.SUV;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
  renderer.domElement.className = 'avVisCanvas';
  const rnd = renderer;
  palco.prepend(renderer.domElement);
  const cena = new THREE.Scene();
  cena.environment = estudio();
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  cena.add(new THREE.HemisphereLight(0xffffff, 0x5a5d66, .55));
  const sol = new THREE.DirectionalLight(0xffffff, .9); sol.position.set(5, 5, 7); cena.add(sol);
  const contra = new THREE.DirectionalLight(0xc9d3ff, .7); contra.position.set(-6, 3, -6); cena.add(contra);
  carro = new THREE.Group(); cena.add(carro);
  linhaMat = new LineMaterial({ color: COR_LINHA, linewidth: .9 });
  partes = []; bloqueios = [];
  carroceria(c); rodas(c); extras(c);
  const ALVO = new THREE.Vector3(0, c.tetoMax * .52, 0);
  let [teta, fi] = VISTAS['3D'], alvoTeta = teta, alvoFi = fi, raio = 10, sujo = true, vivo = true;
  let marcas = {}, destaque = null;

  function pintar() {
    for (const m of partes) {
      const toque = destaque === m.userData.chave, g = marcas[m.userData.chave];
      m.material.color.setHex(toque ? TOQUE : g ? COR_GRAV[g] : m.userData.corBase);
      m.material.emissive.setHex(toque ? 0x0b3b55 : g ? 0x1a0d00 : 0x000000);
    }
    sujo = true;
  }
  function tamanho() {
    const w = palco.clientWidth, h = palco.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix();
    linhaMat.resolution.set(w, h); raio = c.L * 2.25 / Math.min(1, cam.aspect); sujo = true;
  }
  const obs = new ResizeObserver(tamanho); obs.observe(palco); tamanho();
  let raf = 0;
  (function loop() {   // desenha só quando algo muda (economiza bateria no celular)
    if (!vivo) return;
    // a tela saiu (outro módulo, outra avaliação): para de desenhar e libera a memória
    if (!rnd.domElement.isConnected) { if (ctrlAtual === destruirAtual) ctrlAtual = null; destruirAtual(); return; }
    let d = alvoTeta - teta; d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > 1e-4 || Math.abs(alvoFi - fi) > 1e-4 || sujo) {
      teta += d * .15; fi += (alvoFi - fi) * .15; sujo = false;
      cam.position.set(ALVO.x + raio * Math.sin(fi) * Math.cos(teta), ALVO.y + raio * Math.cos(fi), ALVO.z + raio * Math.sin(fi) * Math.sin(teta));
      if (fi < .2) cam.up.set(-Math.cos(teta), 0, -Math.sin(teta)); else cam.up.set(0, 1, 0);
      cam.lookAt(ALVO); rnd.render(cena, cam);
    }
    raf = requestAnimationFrame(loop);
  })();

  // arrastar gira; toque curto marca a peça
  const el = rnd.domElement, ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  let arrastando = false, moveu = 0, ux = 0, uy = 0;
  el.addEventListener('pointerdown', e => { arrastando = true; moveu = 0; ux = e.clientX; uy = e.clientY; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', e => {
    if (!arrastando) return;
    const dx = e.clientX - ux, dy = e.clientY - uy; moveu += Math.abs(dx) + Math.abs(dy); ux = e.clientX; uy = e.clientY;
    alvoTeta -= dx * .01; alvoFi = Math.max(.06, Math.min(1.5, alvoFi - dy * .006));
  });
  el.addEventListener('pointerup', e => {
    arrastando = false; if (moveu >= 8) return;
    const r = el.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, cam);
    const hit = ray.intersectObjects([...partes, ...bloqueios], false)[0];
    if (hit && hit.object.userData.chave && opcoes.aoTocar) opcoes.aoTocar(hit.object.userData.nome, hit.object.userData.grupo);
  });

  function destruirAtual() {
    vivo = false; cancelAnimationFrame(raf); obs.disconnect();
    carro.traverse(o => { o.geometry && o.geometry.dispose(); o.material && o.material.dispose && o.material.dispose(); });
    cena.environment && cena.environment.dispose(); linhaMat.dispose();
    rnd.dispose(); rnd.forceContextLoss(); rnd.domElement.remove(); if (renderer === rnd) renderer = null;
  }
  ctrlAtual = destruirAtual;
  pintar();
  return {
    marcar(m) { marcas = m || {}; pintar(); },
    destacar(nome) { destaque = nome || null; pintar(); },
    vista(nome) { const v = VISTAS[nome]; if (v) { alvoTeta = v[0]; alvoFi = v[1]; } },
    partes: () => partes.map(p => ({ nome: p.userData.nome, grupo: p.userData.grupo })),
    // para os testes: ponto da tela sobre a peça, num pedaço virado para a câmera
    onde(nome) {
      const m = partes.find(p => p.userData.nome === nome); if (!m) return null;
      const pa = m.geometry.attributes.position, na = m.geometry.attributes.normal, cs = [], soma = new THREE.Vector3();
      for (let i = 0; i < pa.count; i += 3) {
        const q = new THREE.Vector3(), n = new THREE.Vector3();
        for (let j = 0; j < 3; j++) { q.add(new THREE.Vector3().fromBufferAttribute(pa, i + j)); n.add(new THREE.Vector3().fromBufferAttribute(na, i + j)); }
        q.divideScalar(3);
        if (n.normalize().dot(cam.position.clone().sub(q).normalize()) > .4) { cs.push(q); soma.add(q); }
      }
      if (!cs.length) return null; soma.divideScalar(cs.length);
      const alvo = cs.reduce((a, b) => a.distanceTo(soma) < b.distanceTo(soma) ? a : b).clone().project(cam);
      const r = el.getBoundingClientRect(); return { x: r.left + (alvo.x + 1) / 2 * r.width, y: r.top + (1 - alvo.y) / 2 * r.height };
    },
    destruir() { if (ctrlAtual === destruirAtual) { destruirAtual(); ctrlAtual = null; } }
  };
}
let ctrlAtual = null;
function destruirAtualGlobal() { if (ctrlAtual) { ctrlAtual(); ctrlAtual = null; } }

window.NX_AVALIACOES_VISTORIA = { criar, destruir: destruirAtualGlobal, carregar };
'''
# "if (renderer) destruirAtual();" no começo de criar() usa a função da instância anterior
cauda = cauda.replace("  if (renderer) destruirAtual();\n", "  destruirAtualGlobal();\n")

modulo = cabeca + dados + "\n" + cores + "\n" + prep + "\n" + geo + "\n" + pecas + cauda
open(saida, "w", encoding="utf-8", newline="\n").write(modulo)
print(saida, len(modulo))
