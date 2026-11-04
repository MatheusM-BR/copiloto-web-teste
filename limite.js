// Limite de velocidade da via (lógica pura, sem DOM). Testado em tests/limite.test.js.
//
// Fonte (custo zero): o servidor público do Valhalla (o mesmo da rota) responde /trace_attributes sobre a FORMA da rota
// já traçada, com edge_walk: cada aresta traz begin/end_shape_index (índices nos pontos da rota), speed_limit (OSM
// maxspeed, km/h; ausente quando a via não tem a marcação; "unlimited" em autobahn) e truck_speed (OSM maxspeed:hgv,
// ausente sem a marcação), além de road_class, use, surface, traversability e density (0–15). Nada é inventado: sem
// marcação e sem como inferir o tipo de via, não há limite (a placa some).
// O mapa (OpenFreeMap / OpenMapTiles) não tem maxspeed na camada transportation; sem rota não há fonte.
//
// Regra do limite exibido (caminhão): o MENOR entre
//   - o sinalizado no OSM (maxspeed) e o maxspeed:hgv (placa de caminhão);
//   - o do CTB (Lei 9.503/1997, art. 61, § 1º, redação da Lei 13.281/2016) para o tipo de via, quando dá para inferir
//     e a via não tem placa de caminhão marcada (detalhes em limiteDaAresta).
// O CTB vale "onde não existir sinalização regulamentadora": vias rurais — rodovia de pista dupla: 110 km/h automóveis,
// camionetas e motocicletas, 90 km/h demais veículos; rodovia de pista simples: 100 / 90 km/h; estrada (não
// pavimentada): 60 km/h. Vias urbanas (80/60/40/30 por tipo de via) não são inferidas: a classe do OSM não diz se a via
// é de trânsito rápido, arterial, coletora ou local.
// Quando o valor vem (ou é limitado) pela inferência do CTB, ele é "estimado".
(function (raiz) {
  "use strict";

  const URL_TRACE_PADRAO = "https://valhalla1.openstreetmap.de/trace_attributes";
  const CHAVE_DADOS = "copiloto.limite.v1";
  const CHAVE_CONFIG = "copiloto.limite.config.v1";
  const MAX_ROTAS_GUARDADAS = 3;
  const PEDACO_MAX_KM = 150;          // forma enviada em pedaços (o servidor limita o tamanho do trace)
  const RURAL_DENSIDADE_MAX = 3;      // density do Valhalla (0–15): só infere o CTB longe de cidade
  const CLASSES_RODOVIA = ["motorway", "trunk", "primary", "secondary", "tertiary"];
  const PAVIMENTADA = ["paved_smooth", "paved", "paved_rough"];
  const NAO_PAVIMENTADA = ["compacted", "dirt", "gravel", "path", "impassable"];
  const ATRIBUTOS = ["edge.speed_limit", "edge.truck_speed", "edge.road_class", "edge.use", "edge.surface",
    "edge.traversability", "edge.density", "edge.begin_shape_index", "edge.end_shape_index", "edge.length"];

  // CTB art. 61, § 1º, II (redação da Lei 13.281/2016)
  const CTB = {
    pistaDupla: { leve: 110, pesado: 90 },
    pistaSimples: { leve: 100, pesado: 90 },
    estrada: 60,
  };

  // ------------------------------------------------------------ tolerância
  // modo "radar" (padrão): +7 km/h até 100 km/h e +7 % acima; "kmh": +valor km/h; "pct": +valor %.
  const CONFIG_PADRAO = { mostrar: true, som: true, tolerancia: { modo: "radar", valor: 7 } };
  function normalizarConfig(c) {
    const o = Object.assign({}, CONFIG_PADRAO, c && typeof c === "object" ? c : {});
    const t = Object.assign({}, CONFIG_PADRAO.tolerancia, o.tolerancia && typeof o.tolerancia === "object" ? o.tolerancia : {});
    if (!["radar", "kmh", "pct"].includes(t.modo)) t.modo = "radar";
    t.valor = Number(t.valor);
    if (!isFinite(t.valor) || t.valor < 0) t.valor = 7;
    t.valor = Math.min(t.valor, 30);
    return { mostrar: o.mostrar !== false, som: o.som !== false, tolerancia: t };
  }
  function toleranciaKmh(limite, tol) {
    const t = (tol && tol.modo) ? tol : CONFIG_PADRAO.tolerancia;
    if (t.modo === "kmh") return t.valor;
    if (t.modo === "pct") return Math.round(limite * t.valor) / 100;
    return limite <= 100 ? t.valor : Math.round(limite * t.valor) / 100;
  }
  function emExcesso(kmh, limite, tol) {
    return typeof kmh === "number" && isFinite(kmh) && typeof limite === "number" && kmh > limite + toleranciaKmh(limite, tol);
  }

  // ------------------------------------------------------------ limite de uma aresta
  function numeroLimite(v) { return typeof v === "number" && isFinite(v) && v > 0 && v < 200 ? Math.round(v) : null; }

  // Tipo de via rural pelo que o Valhalla diz da aresta, ou null quando não dá para saber.
  function tipoViaRural(a) {
    if (!a || typeof a.density !== "number" || a.density > RURAL_DENSIDADE_MAX) return null;
    if (a.use && a.use !== "road") return null;                 // alça, acesso, serviço, balsa…
    if (NAO_PAVIMENTADA.includes(a.surface)) return "estrada";
    if (!CLASSES_RODOVIA.includes(a.road_class) || !PAVIMENTADA.includes(a.surface)) return null;
    // pista dupla: o OSM desenha cada pista como mão única (traversability "forward"/"backward")
    if (a.traversability === "forward" || a.traversability === "backward") return "pistaDupla";
    if (a.traversability === "both") return "pistaSimples";
    return null;
  }
  function limiteCtb(tipo, caminhao) {
    if (tipo === "estrada") return CTB.estrada;
    if (tipo === "pistaDupla" || tipo === "pistaSimples") return CTB[tipo][caminhao ? "pesado" : "leve"];
    return null;
  }

  // Devolve { kmh, fonte: "placa" | "placa-caminhao" | "ctb", estimado, via } ou null (sem limite conhecido).
  // Caminhão: o menor entre a placa geral, a de caminhão (maxspeed:hgv) e o CTB para "demais veículos". Quando a via tem
  // placa de caminhão marcada, ela é a sinalização para caminhão e o CTB (que só vale sem sinalização) não entra.
  // Carro: a placa; sem placa, o CTB do tipo de via (estimado). O CTB não rebaixa a placa do carro (o órgão da via pode
  // sinalizar acima do padrão, art. 61, § 2º: ex. 120 km/h na Bandeirantes).
  function limiteDaAresta(a, caminhao) {
    const placa = numeroLimite(a && a.speed_limit);
    const hgv = caminhao ? numeroLimite(a && a.truck_speed) : null;
    const via = tipoViaRural(a);
    const ctb = limiteCtb(via, caminhao);
    const opcoes = [];
    if (placa != null) opcoes.push({ kmh: placa, fonte: "placa" });
    if (hgv != null) opcoes.push({ kmh: hgv, fonte: "placa-caminhao" });
    if (ctb != null && (caminhao ? hgv == null : placa == null)) opcoes.push({ kmh: ctb, fonte: "ctb" });
    if (!opcoes.length) return null;
    // menor valor; empate prefere a placa (de caminhão, depois a geral) ao CTB: não é estimado
    const ordem = { "placa-caminhao": 0, placa: 1, ctb: 2 };
    opcoes.sort((x, y) => x.kmh - y.kmh || ordem[x.fonte] - ordem[y.fonte]);
    const m = opcoes[0];
    return { kmh: m.kmh, fonte: m.fonte, estimado: m.fonte === "ctb", via };
  }

  // ------------------------------------------------------------ pedido e resposta do trace_attributes
  function codificarPolyline6(coords) {
    let lat = 0, lon = 0, s = "";
    const enc = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let o = ""; while (v >= 0x20) { o += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return o + String.fromCharCode(v + 63); };
    for (const [x, y] of coords) {
      const la = Math.round(y * 1e6), lo = Math.round(x * 1e6);
      s += enc(la - lat) + enc(lo - lon); lat = la; lon = lo;
    }
    return s;
  }
  function distanciaM(a, b) { // a, b: [lon, lat]
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  // Pedaços da rota de até maxKm, cada um começando no último ponto do anterior: [{ de, ate }] (índices inclusivos).
  function dividir(coords, maxKm) {
    const max = (maxKm || PEDACO_MAX_KM) * 1000, out = [];
    if (!Array.isArray(coords) || coords.length < 2) return out;
    let de = 0, d = 0;
    for (let i = 1; i < coords.length; i++) {
      d += distanciaM(coords[i - 1], coords[i]);
      if (d >= max && i < coords.length - 1) { out.push({ de, ate: i }); de = i; d = 0; }
    }
    out.push({ de, ate: coords.length - 1 });
    return out;
  }
  function pedidoTrace(coords, caminhao) {
    return {
      encoded_polyline: codificarPolyline6(coords), shape_match: "edge_walk",
      costing: caminhao ? "truck" : "auto", units: "kilometers",
      filters: { attributes: ATRIBUTOS.slice(), action: "include" },
    };
  }
  // Resposta de um pedaço → trechos [{ i0, i1, kmh, fonte, estimado }] com índices na rota inteira (soma "deslocamento").
  // Lança Error se a resposta não tiver arestas.
  function trechosDaResposta(json, deslocamento, caminhao) {
    if (!json || !Array.isArray(json.edges)) {
      const msg = json && (json.error || json.message);
      throw new Error(msg ? "O servidor de rotas respondeu: " + msg : "Resposta inesperada do servidor de rotas.");
    }
    const d = deslocamento || 0, out = [];
    for (const a of json.edges) {
      const i0 = Number(a.begin_shape_index), i1 = Number(a.end_shape_index);
      if (!isFinite(i0) || !isFinite(i1) || i1 < i0) continue;
      const l = limiteDaAresta(a, caminhao);
      if (!l) continue;
      out.push({ i0: i0 + d, i1: i1 + d, kmh: l.kmh, fonte: l.fonte, estimado: l.estimado });
    }
    return juntar(out);
  }
  // Junta trechos vizinhos (encostados) com o mesmo limite e a mesma fonte; ordena por i0.
  function juntar(trechos) {
    const t = trechos.filter((x) => x && x.i1 > x.i0).sort((a, b) => a.i0 - b.i0);
    const out = [];
    for (const x of t) {
      const u = out[out.length - 1];
      if (u && x.i0 <= u.i1 && x.kmh === u.kmh && x.fonte === u.fonte) u.i1 = Math.max(u.i1, x.i1);
      else if (u && x.i0 < u.i1) { if (x.i1 > u.i1) out.push(Object.assign({}, x, { i0: u.i1 })); }
      else out.push(Object.assign({}, x));
    }
    return out;
  }

  // ------------------------------------------------------------ identidade da rota e armazenamento
  // Chave da forma (pontos arredondados a 1e-5) + veículo (caminhão/carro): o mesmo desenho dá a mesma chave.
  function chaveRota(coords, caminhao) {
    let h = 0x811c9dc5;
    const mistura = (n) => { h ^= n & 0xffff; h = Math.imul(h, 16777619) >>> 0; h ^= (n >>> 16) & 0xffff; h = Math.imul(h, 16777619) >>> 0; };
    for (const [x, y] of coords || []) { mistura(Math.round(x * 1e5) | 0); mistura(Math.round(y * 1e5) | 0); }
    return (caminhao ? "c" : "a") + (coords ? coords.length : 0) + "-" + h.toString(36);
  }
  const FONTES = ["placa", "placa-caminhao", "ctb"];
  function paraGuardar(reg) {
    return { chave: reg.chave, n: reg.n, salvoEm: reg.salvoEm, completo: !!reg.completo,
      t: reg.trechos.map((x) => [x.i0, x.i1, x.kmh, FONTES.indexOf(x.fonte)]) };
  }
  function deGuardado(g) {
    if (!g || typeof g.chave !== "string" || !Array.isArray(g.t)) return null;
    const trechos = [];
    for (const r of g.t) {
      if (!Array.isArray(r) || r.length < 4) continue;
      const fonte = FONTES[r[3]];
      if (!fonte || !(numeroLimite(r[2]) > 0) || !(r[1] > r[0])) continue;
      trechos.push({ i0: r[0], i1: r[1], kmh: r[2], fonte, estimado: fonte === "ctb" });
    }
    return { chave: g.chave, n: g.n, salvoEm: g.salvoEm, completo: !!g.completo, trechos };
  }
  function lerDados(storage) {
    try { const b = storage && storage.getItem(CHAVE_DADOS); const j = b ? JSON.parse(b) : null; return j && Array.isArray(j.rotas) ? j : { rotas: [] }; }
    catch (e) { return { rotas: [] }; }
  }
  function buscarGuardado(storage, chave) {
    const g = lerDados(storage).rotas.find((r) => r && r.chave === chave);
    return g ? deGuardado(g) : null;
  }
  // Guarda (as mais recentes primeiro, até MAX_ROTAS_GUARDADAS). Sem espaço, tenta só com esta. Devolve true se gravou.
  function guardar(storage, reg) {
    if (!storage) return false;
    const dados = lerDados(storage);
    const rotas = [paraGuardar(reg)].concat(dados.rotas.filter((r) => r && r.chave !== reg.chave)).slice(0, MAX_ROTAS_GUARDADAS);
    for (const lista of [rotas, rotas.slice(0, 1)]) {
      try { storage.setItem(CHAVE_DADOS, JSON.stringify({ versao: 1, rotas: lista })); return true; } catch (e) { /* cheio */ }
    }
    return false;
  }
  function lerConfig(storage) {
    try { const b = storage && storage.getItem(CHAVE_CONFIG); return normalizarConfig(b ? JSON.parse(b) : null); }
    catch (e) { return normalizarConfig(null); }
  }
  function gravarConfig(storage, c) {
    try { storage.setItem(CHAVE_CONFIG, JSON.stringify(normalizarConfig(c))); return true; } catch (e) { return false; }
  }

  // ------------------------------------------------------------ onde estou na rota
  // Distância (m) do ponto p ao segmento a–b e a fração ao longo dele (plano local, bom para poucos km).
  function projetar(p, a, b) {
    const kx = 111320 * Math.cos(p[1] * Math.PI / 180), ky = 110540;
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy;
    return { d: Math.sqrt(x * x + y * y), t };
  }
  function rumoSegmento(a, b) {
    const kx = Math.cos(a[1] * Math.PI / 180);
    const g = Math.atan2((b[0] - a[0]) * kx, b[1] - a[1]) * 180 / Math.PI;
    return (g + 360) % 360;
  }
  function difAngulo(a, b) { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; }
  // pos: [lon, lat]. op: { dica (índice anterior), rumo (graus ou null), maxM (distância máxima à linha) }.
  // Devolve { indice, distM } do segmento mais perto (com rumo compatível quando há rumo), ou null fora da linha.
  function localizar(coords, pos, op) {
    const o = op || {}, maxM = o.maxM || 40;
    if (!Array.isArray(coords) || coords.length < 2 || !pos) return null;
    const testar = (de, ate) => {
      let melhor = null;
      for (let i = Math.max(0, de); i < Math.min(coords.length - 1, ate); i++) {
        const a = coords[i], b = coords[i + 1];
        const pr = projetar(pos, a, b);
        if (pr.d > maxM || (melhor && pr.d >= melhor.distM)) continue;
        if (typeof o.rumo === "number" && isFinite(o.rumo) && (a[0] !== b[0] || a[1] !== b[1]) && difAngulo(o.rumo, rumoSegmento(a, b)) > 60) continue;
        melhor = { indice: i, distM: pr.d };
      }
      return melhor;
    };
    if (typeof o.dica === "number" && o.dica >= 0) {
      const perto = testar(o.dica - 3, o.dica + 300);
      if (perto) return perto;
    }
    return testar(0, coords.length - 1);
  }
  // Trecho que contém o segmento "indice" (o segmento i vai do ponto i ao i+1), ou null.
  function trechoDoIndice(trechos, indice) {
    let lo = 0, hi = trechos.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1, t = trechos[m];
      if (indice < t.i0) hi = m - 1; else if (indice >= t.i1) lo = m + 1; else return t;
    }
    return null;
  }

  // ------------------------------------------------------------ excesso e aviso (uma vez por trecho)
  // Estado: criarAviso(). atualizar({ kmh, limite, trecho (identidade), tol, agora }) → { excesso, avisar }.
  // Fica vermelho acima de limite + tolerância; volta ao normal só 2 km/h abaixo disso (sem piscar). Avisa (som) uma
  // vez por trecho, e nunca dois avisos em menos de INTERVALO_MIN_MS (trechos curtos seguidos).
  const INTERVALO_MIN_MS = 30000;
  function criarAviso() {
    let excesso = false, avisados = new Set(), ultimoAviso = -Infinity;
    function atualizar(e) {
      const lim = e && e.limite;
      if (typeof lim !== "number" || typeof e.kmh !== "number" || !isFinite(e.kmh)) { excesso = false; return { excesso, avisar: false }; }
      const teto = lim + toleranciaKmh(lim, e.tol);
      excesso = excesso ? e.kmh > teto - 2 : e.kmh > teto;
      let avisar = false;
      const agora = typeof e.agora === "number" ? e.agora : Date.now();
      if (excesso && e.trecho != null && !avisados.has(e.trecho) && agora - ultimoAviso >= INTERVALO_MIN_MS) {
        avisados.add(e.trecho); ultimoAviso = agora; avisar = true;
      }
      return { excesso, avisar };
    }
    function reiniciar() { excesso = false; avisados = new Set(); ultimoAviso = -Infinity; }
    return { atualizar, reiniciar, emExcesso: () => excesso };
  }
  // estimado (limite inferido pelo tipo de via, CTB): a voz não afirma como se fosse placa
  function textoAviso(limite, estimado) { return estimado ? "Acima de " + limite + ", limite estimado." : "Acima do limite de " + limite + "."; }

  const api = {
    URL_TRACE_PADRAO, ATRIBUTOS, CHAVE_DADOS, CHAVE_CONFIG, CTB, CONFIG_PADRAO, PEDACO_MAX_KM, RURAL_DENSIDADE_MAX, INTERVALO_MIN_MS,
    normalizarConfig, toleranciaKmh, emExcesso, tipoViaRural, limiteCtb, limiteDaAresta,
    codificarPolyline6, dividir, pedidoTrace, trechosDaResposta, juntar,
    chaveRota, paraGuardar, deGuardado, lerDados, buscarGuardado, guardar, lerConfig, gravarConfig,
    localizar, trechoDoIndice, criarAviso, textoAviso,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoLimite = api;
})(typeof window !== "undefined" ? window : globalThis);
