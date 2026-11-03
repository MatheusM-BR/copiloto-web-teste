// "Via do trajeto": o que dá para saber da estrada pela rota traçada (lógica pura, sem DOM). Testado em tests/viaqualidade.test.js.
//
// Fonte (custo zero): /trace_attributes do Valhalla público (mesmo servidor da rota e do limite.js) sobre a FORMA da rota,
// com edge_walk. Campos que o servidor público devolve por aresta (confirmado por pedido real em 01/11/2026):
// length, road_class, surface, use, traversability, lane_count, speed_limit, truck_speed (só onde marcado), weighted_grade,
// max_upward_grade, max_downward_grade, mean_elevation, names (ex.: ["BR-153", "Rodovia Transbrasiliana"]), density,
// begin/end_shape_index. NÃO vem: "edge.sign" (só placas de saída, e não veio nas rotas testadas). Limites do servidor:
// 1.000 km e 16.000 pontos por pedido (erros 154 e 153): a rota é fatiada em pedaços de até 450 km / 9.000 pontos.
// Por isso o km de cada trecho vem da GEOMETRIA da rota (índices de forma), não de edge.length (a aresta cortada no
// limite entre dois pedaços apareceria inteira nos dois).
//
// O que é heurística (e o que o mapa aberto não vê):
//  - PISTA DUPLA: aresta em rodovia principal (motorway/trunk/primary) que só anda num sentido (traversability
//    forward/backward: o OSM desenha cada pista como via de mão única). Pista simples: o resto asfaltado. Não vê:
//    faixa central/canteiro mapeados como uma via só (rodovia de 4 faixas sem canteiro marcada como mão dupla), pista
//    dupla ainda não desenhada em duas pistas, e avenida urbana de mão única classificada como primary (conta como dupla).
//  - PAVIMENTO: surface do OSM; sem marcação o Valhalla assume por tipo de via (paved_smooth em rodovia). "Asfalto bom"
//    quer dizer "o mapa não marca como ruim nem como terra". paved_rough = "piso ruim" (marcação de voluntário).
//  - BURACOS: o mapa aberto não sabe. Só se contam relatos da comunidade (road_damage) perto da rota; nunca se afirma
//    "esburacada" sem dado.
//  - RELEVO: weighted_grade (em %, quantizado em passos de ~1,67 pontos) vezes o comprimento; ganho e perda acumulados
//    são estimativas (o dado do servidor é grosseiro e suaviza picos curtos). Rampa > 6 %: trechos contínuos com
//    weighted_grade acima de 6 %. Sem esses campos: /height (pedidoHeight / relevoDeHeight), ou "sem dados de relevo".
(function (raiz) {
  "use strict";

  const URL_TRACE_PADRAO = "https://valhalla1.openstreetmap.de/trace_attributes";
  const URL_HEIGHT_PADRAO = "https://valhalla1.openstreetmap.de/height";
  const CHAVE_DADOS = "copiloto.via.v1";
  const MAX_GUARDADAS = 3;
  const PEDACO_MAX_KM = 450;           // servidor: até 1.000 km; margem grande para o tempo de resposta
  const PEDACO_MAX_PONTOS = 9000;      // servidor: até 16.000
  const RAMPA_ALTA_PCT = 6;
  const PRINCIPAIS = ["motorway", "trunk", "primary"];
  const ATRIBUTOS = ["edge.road_class", "edge.surface", "edge.use", "edge.traversability", "edge.lane_count", "edge.speed_limit",
    "edge.weighted_grade", "edge.max_upward_grade", "edge.max_downward_grade", "edge.mean_elevation", "edge.names",
    "edge.begin_shape_index", "edge.end_shape_index"];
  const USO_NAO_ROD = ["ramp", "turn_channel", "rotary", "ferry", "rail-ferry", "service_road", "driveway", "alley"];

  // ------------------------------------------------------------ geometria
  const RAD = Math.PI / 180;
  function distM(a, b) { // [lon, lat]
    const R = 6371008.8, dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // km acumulados em cada ponto (acum[0] = 0)
  function acumulado(coords) {
    const a = new Float64Array(coords.length);
    for (let i = 1; i < coords.length; i++) a[i] = a[i - 1] + distM(coords[i - 1], coords[i]) / 1000;
    return a;
  }
  function codificarPolyline6(coords) {
    let lat = 0, lon = 0, s = "";
    const enc = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let o = ""; while (v >= 0x20) { o += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return o + String.fromCharCode(v + 63); };
    for (const [x, y] of coords) { const la = Math.round(y * 1e6), lo = Math.round(x * 1e6); s += enc(la - lat) + enc(lo - lon); lat = la; lon = lo; }
    return s;
  }
  // Pedaços [{ de, ate }] (índices inclusivos; cada um começa no último ponto do anterior) de até maxKm e maxPontos.
  function fatiar(coords, maxKm, maxPontos) {
    const out = [];
    if (!Array.isArray(coords) || coords.length < 2) return out;
    const kmMax = (maxKm || PEDACO_MAX_KM), pMax = maxPontos || PEDACO_MAX_PONTOS;
    const ac = acumulado(coords);
    let de = 0;
    for (let i = 1; i < coords.length; i++) {
      if (i >= coords.length - 1) break;
      if (ac[i + 1] - ac[de] > kmMax && i > de) { out.push({ de, ate: i }); de = i; }      // o próximo ponto passaria do limite
      else if (i - de >= pMax - 1) { out.push({ de, ate: i }); de = i; }
    }
    out.push({ de, ate: coords.length - 1 });
    return out;
  }
  function pedidoTrace(coords, caminhao) {
    return { encoded_polyline: codificarPolyline6(coords), shape_match: "edge_walk", costing: caminhao ? "truck" : "auto",
      units: "kilometers", filters: { attributes: ATRIBUTOS.slice(), action: "include" } };
  }

  // ------------------------------------------------------------ classificação de uma aresta
  // "BR-153", "GO-060", "SP-543", "MT-130", "BR-364": a primeira marca de rodovia da lista de nomes; senão o primeiro nome.
  const REF = /^[A-Z]{2,3}\s?-\s?\d{2,3}[A-Z]?$/;
  function nomeDaVia(names) {
    if (!Array.isArray(names) || !names.length) return null;
    const ref = names.find((n) => typeof n === "string" && REF.test(n.trim()));
    if (ref) return ref.trim().replace(/\s/g, "");
    return typeof names[0] === "string" ? names[0] : null;
  }
  function ehRodovia(nome) { return !!nome && REF.test(nome); }

  function tipoDePista(a) {
    if (a.use && USO_NAO_ROD.includes(a.use) && a.use !== "service_road") return "o"; // alça, retorno, rotatória, balsa
    if (PRINCIPAIS.includes(a.road_class) && (a.traversability === "forward" || a.traversability === "backward")) return "d";
    return "s";
  }
  // "b" bom, "r" ruim (paved_rough), "t" terra batida (compacted), "c" cascalho (gravel), "e" terra (dirt, path), "i" intransitável
  function pisoDaSuperficie(s) {
    switch (s) {
      case "paved_rough": return "r";
      case "compacted": return "t";
      case "gravel": return "c";
      case "dirt": case "path": return "e";
      case "impassable": return "i";
      default: return "b"; // paved_smooth, paved, ausente
    }
  }
  function ehTerra(p) { return p === "t" || p === "c" || p === "e"; }
  const ROTULO_PISO = { b: "asfalto", r: "piso ruim", t: "terra batida", c: "cascalho", e: "terra", i: "intransitável" };

  function numero(v) { return typeof v === "number" && isFinite(v) ? v : null; }

  // Resposta de UM pedaço → arestas com índices na rota inteira (soma "desloc"); o km vem da geometria (acum da rota inteira).
  // Lança Error em resposta sem arestas.
  function arestasDaResposta(json, desloc, acum) {
    if (!json || !Array.isArray(json.edges)) {
      const msg = json && (json.error || json.message);
      throw new Error(msg ? "O servidor de rotas respondeu: " + msg : "Resposta inesperada do servidor de rotas.");
    }
    const d = desloc || 0, out = [];
    for (const a of json.edges) {
      const i0 = Number(a.begin_shape_index) + d, i1 = Number(a.end_shape_index) + d;
      if (!isFinite(i0) || !isFinite(i1) || i1 <= i0 || i1 >= acum.length) continue;
      const km = acum[i1] - acum[i0];
      const wg = numero(a.weighted_grade);
      out.push({
        i0, i1, km, via: nomeDaVia(a.names), pista: tipoDePista(a), piso: pisoDaSuperficie(a.surface),
        rampa: wg == null ? 0 : (wg > RAMPA_ALTA_PCT ? 1 : (wg < -RAMPA_ALTA_PCT ? -1 : 0)),
        sobe: numero(a.max_upward_grade), desce: numero(a.max_downward_grade),
        ganho: wg != null && wg > 0 ? wg * km * 10 : 0, perda: wg != null && wg < 0 ? -wg * km * 10 : 0,
        temRelevo: wg != null || numero(a.max_upward_grade) != null,
        elev: numero(a.mean_elevation),
      });
    }
    return out;
  }
  // Junta arestas vizinhas com a mesma via, pista, piso e classe de rampa. Entrada ordenada por i0.
  function juntar(arestas) {
    const t = arestas.filter((x) => x && x.i1 > x.i0).sort((a, b) => a.i0 - b.i0 || a.i1 - b.i1);
    const out = [];
    for (const x of t) {
      const u = out[out.length - 1];
      if (u && x.i1 <= u.i1) continue;                       // sobreposição por inteiro
      const y = u && x.i0 < u.i1 ? Object.assign({}, x, { i0: u.i1, km: x.km * (x.i1 - u.i1) / (x.i1 - x.i0) }) : x;
      if (u && y.i0 <= u.i1 && u.via === y.via && u.pista === y.pista && u.piso === y.piso && u.rampa === y.rampa) {
        u.i1 = y.i1; u.km += y.km; u.ganho += y.ganho; u.perda += y.perda; u.temRelevo = u.temRelevo || y.temRelevo;
        if (y.sobe != null) u.sobe = u.sobe == null ? y.sobe : Math.max(u.sobe, y.sobe);
        if (y.desce != null) u.desce = u.desce == null ? y.desce : Math.min(u.desce, y.desce);
      } else out.push(Object.assign({}, y));
    }
    return out;
  }

  // ------------------------------------------------------------ resumo da rota inteira
  function arred1(v) { return Math.round(v * 10) / 10; }
  // runs: saída de juntar (ordenada). acum: km acumulados da rota (acumulado(coords)).
  function resumir(runs, acum) {
    const total = acum && acum.length ? acum[acum.length - 1] : runs.reduce((s, r) => s + r.km, 0);
    const r = { kmTotal: total, kmDupla: 0, kmSimples: 0, kmTerra: 0, kmPisoRuim: 0, kmIntransitavel: 0, kmOutros: 0,
      ganhoM: 0, perdaM: 0, rampaMaxPct: null, descidaMaxPct: null, kmRampaAlta: 0, trechosRampaAlta: [], rodovias: [],
      trechosTerra: [], trechosRuins: [], trechosIntransitaveis: [], temRelevo: false, kmCoberto: 0 };
    const ini = (run) => (acum ? acum[run.i0] : 0);
    let ultimaRodovia = null;
    for (const run of runs) {
      const km = run.km;
      r.kmCoberto += km;
      if (ehTerra(run.piso)) r.kmTerra += km;
      else if (run.piso === "i") r.kmIntransitavel += km;
      else if (run.pista === "d") r.kmDupla += km;
      else if (run.pista === "s") r.kmSimples += km;
      else r.kmOutros += km;
      if (run.piso === "r") r.kmPisoRuim += km;
      r.ganhoM += run.ganho; r.perdaM += run.perda;
      if (run.temRelevo) r.temRelevo = true;
      if (run.sobe != null && (r.rampaMaxPct == null || run.sobe > r.rampaMaxPct)) r.rampaMaxPct = run.sobe;
      if (run.desce != null && (r.descidaMaxPct == null || -run.desce > r.descidaMaxPct)) r.descidaMaxPct = -run.desce;
      if (run.rampa !== 0) {
        r.kmRampaAlta += km;
        const u = r.trechosRampaAlta[r.trechosRampaAlta.length - 1];
        const sent = run.rampa > 0 ? "subida" : "descida";
        if (u && u.sentido === sent && Math.abs(u.i1 - run.i0) <= 1) { u.km += km; u.i1 = run.i1; }
        else r.trechosRampaAlta.push({ kmIni: ini(run), km, sentido: sent, i0: run.i0, i1: run.i1 });
      }
      for (const [alvo, cond] of [[r.trechosTerra, ehTerra(run.piso)], [r.trechosRuins, run.piso === "r"], [r.trechosIntransitaveis, run.piso === "i"]]) {
        if (!cond) continue;
        const u = alvo[alvo.length - 1];
        if (u && u.piso === run.piso && Math.abs(u.i1 - run.i0) <= 1 && u.via === run.via) { u.km += km; u.i1 = run.i1; }
        else alvo.push({ kmIni: ini(run), km, via: run.via, piso: run.piso, tipo: ROTULO_PISO[run.piso], i0: run.i0, i1: run.i1 });
      }
      // rodovias na ordem: corridas seguidas do mesmo nome
      const nome = run.via || "Via sem nome";
      if (ultimaRodovia && ultimaRodovia.nome === nome) { ultimaRodovia.km += km; ultimaRodovia.i1 = run.i1; }
      else { ultimaRodovia = { nome, km, kmIni: ini(run), i0: run.i0, i1: run.i1, rodovia: ehRodovia(nome) }; r.rodovias.push(ultimaRodovia); }
    }
    r.pctDupla = pct(r.kmDupla, total); r.pctSimples = pct(r.kmSimples, total); r.pctTerra = pct(r.kmTerra, total);
    // rampa > 6 %: trechos curtos demais (< 0,3 km) viram ruído de quantização; ficam no total mas não na lista
    r.trechosRampaAlta = r.trechosRampaAlta.filter((t) => t.km >= 0.3);
    return r;
  }
  function pct(km, total) { return total > 0 ? Math.round(km / total * 1000) / 10 : 0; }

  // Rodovias para a lista: junta corridas da mesma rodovia (BR-153 três vezes seguidas com ruas no meio) e esconde ruas curtas.
  function rodoviasDaLista(resumo) {
    const por = new Map();
    for (const x of resumo.rodovias) {
      if (!x.rodovia && x.km < 2) continue;
      const k = x.nome;
      if (!por.has(k)) por.set(k, { nome: k, km: 0, kmIni: x.kmIni, rodovia: x.rodovia });
      por.get(k).km += x.km;
    }
    return Array.from(por.values()).sort((a, b) => a.kmIni - b.kmIni);
  }

  // ------------------------------------------------------------ gancho para o combustível v2 (custos.js)
  // Só expõe o dado: custos.fatorRampa({ fator }) ainda não usa (na v1 é sempre 1).
  function paraCustos(resumo) {
    if (!resumo || !resumo.temRelevo) return null;
    return { ganhoM: Math.round(resumo.ganhoM), perdaM: Math.round(resumo.perdaM), kmRampaAlta: arred1(resumo.kmRampaAlta) };
  }

  // ------------------------------------------------------------ textos curtos (pt-BR)
  function fmtKm(km) {
    if (!isFinite(km)) return "--";
    if (km < 10) return km.toFixed(1).replace(".", ",") + " km";
    return Math.round(km).toLocaleString("pt-BR") + " km";
  }
  function fmtM(m) { return Math.round(m).toLocaleString("pt-BR") + " m"; }
  function textoPista(r) {
    const p = [];
    if (r.kmDupla >= 0.5) p.push("Pista dupla " + fmtKm(r.kmDupla));
    if (r.kmSimples >= 0.5) p.push((p.length ? "simples " : "Pista simples ") + fmtKm(r.kmSimples));
    if (r.kmTerra >= 0.5) p.push("terra " + fmtKm(r.kmTerra));
    return p.join(" · ");
  }
  function textoRelevo(r) {
    if (!r.temRelevo) return "Sem dados de relevo.";
    const t = "↑ " + fmtM(r.ganhoM) + " ↓ " + fmtM(r.perdaM);
    return r.rampaMaxPct != null ? t + " · rampa máx. " + Math.round(Math.max(r.rampaMaxPct, r.descidaMaxPct || 0)) + "%" : t;
  }
  // "38 km de terra · 12 km de piso ruim" ("" quando não há nenhum dos dois)
  function textoTerraRuim(r) {
    const p = [];
    if (r.kmTerra >= 0.5) p.push(fmtKm(r.kmTerra) + " de terra");
    if (r.kmPisoRuim >= 0.5) p.push(fmtKm(r.kmPisoRuim) + " de piso ruim");
    return p.join(" · ");
  }
  function avisoPadrao(r) {
    if (r.kmTerra >= 0.5) return "Tem " + fmtKm(r.kmTerra) + " de estrada de terra" + (r.kmPisoRuim >= 0.5 ? " e " + fmtKm(r.kmPisoRuim) + " de piso ruim" : "") + ".";
    if (r.kmPisoRuim >= 0.5) return "Tem " + fmtKm(r.kmPisoRuim) + " de piso ruim no mapa.";
    return "";
  }

  // ------------------------------------------------------------ buracos relatados pela comunidade
  // relatos: linhas de copiloto_reports_near (report_type "road_damage", lat, lon, created_at?, expires_at?, heading_deg?).
  // Devolve { total, janelaDias, itens: [{ km, quando (ms|null), lat, lon }] } com os mais recentes primeiro. perto: m da linha.
  function buracosNaRota(coords, acum, relatos, agoraMs, perto, janelaDias) {
    const out = { total: 0, janelaDias: janelaDias || 30, itens: [] };
    if (!Array.isArray(coords) || coords.length < 2 || !Array.isArray(relatos)) return out;
    const lim = perto || 100;
    for (const r of relatos) {
      if (!r || r.report_type !== "road_damage" || !isFinite(r.lat) || !isFinite(r.lon)) continue;
      if (r.expires_at) { const t = Date.parse(r.expires_at); if (isFinite(t) && t <= agoraMs) continue; }
      const p = [Number(r.lon), Number(r.lat)];
      const kx = 111320 * Math.cos(p[1] * RAD), ky = 110540;
      let melhor = -1, dMin = Infinity;
      // vértice mais perto (plano local), depois confere os segmentos vizinhos
      for (let i = 0; i < coords.length; i++) {
        const dx = (coords[i][0] - p[0]) * kx, dy = (coords[i][1] - p[1]) * ky;
        const d = dx * dx + dy * dy;
        if (d < dMin) { dMin = d; melhor = i; }
      }
      let dFim = Math.sqrt(dMin), km = acum[melhor];
      for (const i of [melhor - 1, melhor]) {
        if (i < 0 || i >= coords.length - 1) continue;
        const a = coords[i], b = coords[i + 1];
        const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
        const ddx = bx - ax, ddy = by - ay, l2 = ddx * ddx + ddy * ddy;
        let t = l2 > 0 ? -(ax * ddx + ay * ddy) / l2 : 0; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(ax + t * ddx, ay + t * ddy);
        if (d < dFim) { dFim = d; km = acum[i] + t * (acum[i + 1] - acum[i]); }
      }
      if (dFim > lim) continue;
      const quando = r.created_at ? Date.parse(r.created_at) : null;
      out.itens.push({ km, quando: isFinite(quando) ? quando : null, lat: p[1], lon: p[0] });
    }
    out.itens.sort((a, b) => (b.quando || 0) - (a.quando || 0) || a.km - b.km);
    out.total = out.itens.length;
    return out;
  }
  function textoBuracos(b) {
    if (!b) return "";
    if (!b.total) return "Buracos relatados: nenhum nos últimos " + b.janelaDias + " dias.";
    return "Buracos relatados: " + b.total + " nos últimos " + b.janelaDias + " dias.";
  }

  // ------------------------------------------------------------ relevo pelo /height (quando o trace não traz inclinação)
  function amostrar(coords, n) {
    if (coords.length <= n) return coords.slice();
    const out = [], passo = (coords.length - 1) / (n - 1);
    for (let i = 0; i < n; i++) out.push(coords[Math.round(i * passo)]);
    return out;
  }
  function pedidoHeight(coords, n) {
    return { encoded_polyline: codificarPolyline6(amostrar(coords, n || 1000)), range: true, height_precision: 0 };
  }
  // range_height: [[distância_m, altura_m], …] → { ganhoM, perdaM }. Histerese de 8 m (ruído do modelo de terreno).
  function relevoDeHeight(resp) {
    const h = resp && Array.isArray(resp.range_height) ? resp.range_height.filter((x) => Array.isArray(x) && isFinite(x[1])) : [];
    if (h.length < 2) return null;
    let ganho = 0, perda = 0, ref = h[0][1];
    const HIST = 8;
    for (const [, alt] of h) {
      if (alt - ref >= HIST) { ganho += alt - ref; ref = alt; }
      else if (ref - alt >= HIST) { perda += ref - alt; ref = alt; }
    }
    return { ganhoM: ganho, perdaM: perda };
  }

  // ------------------------------------------------------------ guardar (último cálculo da rota, para abrir sem internet)
  const COD_PISTA = ["d", "s", "o"], COD_PISO = ["b", "r", "t", "c", "e", "i"];
  function chaveRota(coords, caminhao) { // mesma conta do limite.js (mesma forma = mesma chave)
    let h = 0x811c9dc5;
    const mistura = (n) => { h ^= n & 0xffff; h = Math.imul(h, 16777619) >>> 0; h ^= (n >>> 16) & 0xffff; h = Math.imul(h, 16777619) >>> 0; };
    for (const [x, y] of coords || []) { mistura(Math.round(x * 1e5) | 0); mistura(Math.round(y * 1e5) | 0); }
    return "v" + (caminhao ? "c" : "a") + (coords ? coords.length : 0) + "-" + h.toString(36);
  }
  function paraGuardar(reg) {
    const nomes = [], idx = new Map();
    const nome = (n) => { if (n == null) return -1; if (!idx.has(n)) { idx.set(n, nomes.length); nomes.push(n); } return idx.get(n); };
    return { chave: reg.chave, salvoEm: reg.salvoEm, completo: !!reg.completo, nomes,
      r: reg.runs.map((x) => [x.i0, x.i1, nome(x.via), COD_PISTA.indexOf(x.pista), COD_PISO.indexOf(x.piso), x.rampa,
        x.sobe == null ? null : x.sobe, x.desce == null ? null : x.desce, Math.round(x.ganho), Math.round(x.perda), x.temRelevo ? 1 : 0]) };
  }
  function deGuardado(g, acum) {
    if (!g || typeof g.chave !== "string" || !Array.isArray(g.r) || !Array.isArray(g.nomes)) return null;
    const runs = [];
    for (const x of g.r) {
      if (!Array.isArray(x) || x.length < 11 || !(x[1] > x[0]) || x[1] >= acum.length) continue;
      runs.push({ i0: x[0], i1: x[1], km: acum[x[1]] - acum[x[0]], via: x[2] >= 0 ? g.nomes[x[2]] : null, pista: COD_PISTA[x[3]] || "s",
        piso: COD_PISO[x[4]] || "b", rampa: x[5], sobe: x[6], desce: x[7], ganho: x[8], perda: x[9], temRelevo: !!x[10] });
    }
    return { chave: g.chave, salvoEm: g.salvoEm, completo: !!g.completo, runs };
  }
  function lerDados(storage) {
    try { const b = storage && storage.getItem(CHAVE_DADOS); const j = b ? JSON.parse(b) : null; return j && Array.isArray(j.rotas) ? j : { rotas: [] }; }
    catch (e) { return { rotas: [] }; }
  }
  function buscarGuardado(storage, chave, acum) {
    const g = lerDados(storage).rotas.find((x) => x && x.chave === chave);
    return g ? deGuardado(g, acum) : null;
  }
  function guardar(storage, reg) {
    if (!storage) return false;
    const dados = lerDados(storage);
    const rotas = [paraGuardar(reg)].concat(dados.rotas.filter((r) => r && r.chave !== reg.chave)).slice(0, MAX_GUARDADAS);
    for (const lista of [rotas, rotas.slice(0, 1)]) {
      try { storage.setItem(CHAVE_DADOS, JSON.stringify({ versao: 1, rotas: lista })); return true; } catch (e) { /* cheio */ }
    }
    return false;
  }

  const api = {
    URL_TRACE_PADRAO, URL_HEIGHT_PADRAO, CHAVE_DADOS, PEDACO_MAX_KM, PEDACO_MAX_PONTOS, RAMPA_ALTA_PCT, ATRIBUTOS, ROTULO_PISO,
    acumulado, codificarPolyline6, fatiar, pedidoTrace, nomeDaVia, ehRodovia, tipoDePista, pisoDaSuperficie, ehTerra,
    arestasDaResposta, juntar, resumir, rodoviasDaLista, paraCustos,
    fmtKm, fmtM, textoPista, textoRelevo, textoTerraRuim, avisoPadrao, buracosNaRota, textoBuracos,
    amostrar, pedidoHeight, relevoDeHeight, chaveRota, paraGuardar, deGuardado, lerDados, buscarGuardado, guardar,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoVia = api;
})(typeof window !== "undefined" ? window : globalThis);
