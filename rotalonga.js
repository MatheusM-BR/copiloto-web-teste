// Rota longa (lógica pura, sem DOM). Testado em tests/rotalonga.test.js.
//
// O QUE O SERVIDOR PÚBLICO ACEITA (medido em 01/11/2026 em valhalla1.openstreetmap.de, evidência em ARQUITETURA.md):
//  - /route: "Path distance exceeds the max distance limit: 1500000 meters" (erro 154) vale para auto E truck, e o limite é
//    sobre a SOMA DAS DISTÂNCIAS EM LINHA RETA entre os pontos do pedido (inclusive "through"), NÃO sobre a distância
//    rodada. Goiânia→Florianópolis (reta 1.216 km, rota 1.588 km) passa; Goiânia→Porto Alegre (reta 1.498 km, rota
//    2.036 km) passa; reta de 1.514 km é recusada. Logo "auto" não ajuda (mesmo limite) e a regra é pela reta.
//  - /trace_attributes: até 1.000 km e 16.000 pontos por pedido (erros 154 e 153).  - /height: 10.000 pontos passam.
//  - /locate: aceita search_filter por ponto (usado para ancorar os pontos intermediários em rodovia principal).
//
// Estratégia: acima de ~1.400 km de reta (ou ao receber o erro 154) a viagem vira N trechos de ~800 km de reta
// (~1.000 km rodados). Os pontos intermediários caem sobre a linha reta origem→destino e são "colados" na rodovia
// principal mais perto (/locate com min_road_class primary, depois tertiary, depois sem filtro); cada trecho é pedido
// em "truck" com as mesmas restrições do veículo, até 3 ao mesmo tempo, com tentativas; as respostas são emendadas
// numa resposta só no formato do Valhalla (uma perna, um desenho, manobras renumeradas), para a navegação, o recálculo,
// a rota guardada e os custos funcionarem sem saber que a rota foi dividida.
(function (raiz) {
  "use strict";

  const Rota = typeof module !== "undefined" && module.exports ? require("./rota.js") : raiz.CopilotoRota;

  const LIMITE_SERVIDOR_KM = 1500;     // limite do servidor, medido sobre a reta
  const DIVIDIR_ACIMA_KM = 1400;       // folga de 100 km sobre o limite
  const RETA_POR_TRECHO_KM = 800;      // alvo da reta por trecho (~1.000 km rodados)
  const RETA_MAX_TRECHO_KM = 1250;     // um trecho nunca passa disto em reta
  const MAX_TRECHOS = 12;              // teto de segurança (o Brasil inteiro cabe em ~6)
  const CONCORRENCIA = 3;
  const TENTATIVAS = 3;
  const JUNCAO_M = 10;                 // pontos de emenda a menos disto são o mesmo ponto
  const NIVEIS_SNAP = [
    { min_road_class: "primary", corte: 60000 },
    { min_road_class: "tertiary", corte: 120000 },
    { min_road_class: null, corte: 200000 },
  ];

  // ------------------------------------------------------------ geometria
  const RAD = Math.PI / 180;
  function distKm(a, b) { // { lat, lon }
    const R = 6371.0088, dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function distCoordM(a, b) { return distKm({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] }) * 1000; } // [lon, lat]
  // ponto a fração f (0–1) do círculo máximo a→b
  function pontoNaReta(a, b, f) {
    const la1 = a.lat * RAD, lo1 = a.lon * RAD, la2 = b.lat * RAD, lo2 = b.lon * RAD;
    const d = distKm(a, b) / 6371.0088;
    if (d < 1e-9) return { lat: a.lat, lon: a.lon };
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    const z = A * Math.sin(la1) + B * Math.sin(la2);
    return { lat: Math.atan2(z, Math.sqrt(x * x + y * y)) / RAD, lon: Math.atan2(y, x) / RAD };
  }
  function arred(p) { return { lat: Math.round(p.lat * 1e6) / 1e6, lon: Math.round(p.lon * 1e6) / 1e6 }; }

  // ------------------------------------------------------------ decisão e plano
  function ehErroDistancia(msg) { return /exceeds the max distance|max distance limit/i.test(String(msg || "")); }
  function ehErroSemVia(msg) { return /No suitable edges|Could not find a location|no.*edges near/i.test(String(msg || "")); }
  function retaKm(origem, destino) { return distKm(origem, destino); }
  // Só a distância em linha reta conta para o servidor; acima de DIVIDIR_ACIMA_KM já pede em trechos.
  function deveDividir(origem, destino) {
    return !!origem && !!destino && retaKm(origem, destino) > DIVIDIR_ACIMA_KM;
  }
  function numeroDeTrechos(retaTotalKm) {
    return Math.max(2, Math.ceil(retaTotalKm / RETA_POR_TRECHO_KM));
  }
  // Pontos intermediários sobre a reta origem→destino. anteriores: pontos já colados na estrada de uma rota anterior ao
  // mesmo destino (recálculo): os que ainda estão à frente (mais perto do destino que a origem, com folga) são
  // reaproveitados — os trechos seguintes têm então o mesmo pedido e saem do cache, só o primeiro é pedido de novo.
  // Devolve { ok, n, pontos: [{lat,lon}], reaproveitou } ou { ok:false, motivo }.
  function planejar(origem, destino, anteriores) {
    const total = retaKm(origem, destino);
    if (total / MAX_TRECHOS > RETA_MAX_TRECHO_KM) return { ok: false, motivo: "Destino longe demais para dividir em até " + MAX_TRECHOS + " trechos." };
    if (Array.isArray(anteriores) && anteriores.length) {
      const adiante = anteriores.filter((p) => distKm(p, destino) < total - 80)
        .sort((a, b) => distKm(b, destino) - distKm(a, destino));
      if (adiante.length) {
        const cadeia = [origem].concat(adiante, [destino]);
        if (cadeia.every((p, i) => i === 0 || distKm(cadeia[i - 1], p) <= RETA_MAX_TRECHO_KM) && cadeia.length - 1 <= MAX_TRECHOS) {
          return { ok: true, n: cadeia.length - 1, pontos: adiante.map((p) => ({ lat: p.lat, lon: p.lon })), reaproveitou: true };
        }
      }
    }
    const n = Math.min(MAX_TRECHOS, numeroDeTrechos(total));
    const pontos = [];
    for (let i = 1; i < n; i++) pontos.push(arred(pontoNaReta(origem, destino, i / n)));
    return { ok: true, n, pontos, reaproveitou: false };
  }

  // ------------------------------------------------------------ colar os pontos na rodovia (/locate)
  function localizacaoSnap(p, nivel) {
    const n = NIVEIS_SNAP[nivel];
    const l = { lat: p.lat, lon: p.lon, search_cutoff: n.corte };
    if (n.min_road_class) l.search_filter = { min_road_class: n.min_road_class };
    return l;
  }
  function pedidoLocate(pontos, nivel, costing) {
    return { locations: pontos.map((p) => localizacaoSnap(p, nivel)), costing: costing === "auto" ? "auto" : "truck", verbose: false };
  }
  // Resposta do /locate (lista, um item por ponto) → [{lat,lon} | null]
  function lerLocate(json, total) {
    const out = [];
    for (let i = 0; i < total; i++) {
      const it = Array.isArray(json) ? json[i] : null;
      let c = null;
      if (it && Array.isArray(it.edges) && it.edges.length && isFinite(it.edges[0].correlated_lat)) c = { lat: Number(it.edges[0].correlated_lat), lon: Number(it.edges[0].correlated_lon) };
      else if (it && Array.isArray(it.nodes) && it.nodes.length && isFinite(it.nodes[0].lat)) c = { lat: Number(it.nodes[0].lat), lon: Number(it.nodes[0].lon) };
      out.push(c ? arred(c) : null);
    }
    return out;
  }
  // Cola cada ponto: tenta rodovia principal, depois qualquer via asfaltada de porte médio, depois qualquer via.
  // localizar(body) → json do /locate (ou lança). Ponto sem via em nenhum nível: tenta deslocar ao longo da reta (±10 %, ±20 %).
  async function colarPontos(pontos, costing, localizar, origem, destino) {
    const res = pontos.map(() => null);
    for (let nivel = 0; nivel < NIVEIS_SNAP.length; nivel++) {
      const faltam = res.map((r, i) => (r ? -1 : i)).filter((i) => i >= 0);
      if (!faltam.length) break;
      const json = await localizar(pedidoLocate(faltam.map((i) => pontos[i]), nivel, costing));
      lerLocate(json, faltam.length).forEach((c, k) => { if (c) res[faltam[k]] = c; });
    }
    // ainda sem via: desloca ao longo da reta
    const total = retaKm(origem, destino);
    for (let i = 0; i < res.length; i++) {
      if (res[i]) continue;
      const f0 = (i + 1) / (pontos.length + 1);
      for (const d of [0.1, -0.1, 0.2, -0.2]) {
        const f = Math.min(0.95, Math.max(0.05, f0 + d * (RETA_POR_TRECHO_KM / total)));
        const p = arred(pontoNaReta(origem, destino, f));
        const json = await localizar(pedidoLocate([p], 2, costing));
        const c = lerLocate(json, 1)[0];
        if (c) { res[i] = c; break; }
      }
    }
    const sem = res.findIndex((r) => !r);
    if (sem >= 0) { const e = new Error("Não achei estrada perto do caminho em linha reta, no meio da viagem."); e.motivo = e.message; e.semVia = true; throw e; }
    return res;
  }

  // ------------------------------------------------------------ pedido de cada trecho
  function pedidoTrecho(pedidoBase, de, ate) {
    const p = Object.assign({}, pedidoBase);
    delete p.alternates;
    p.locations = [{ lat: de.lat, lon: de.lon, type: "break" }, { lat: ate.lat, lon: ate.lon, type: "break" }];
    return p;
  }
  function chavePedido(p) { return JSON.stringify([p.costing, p.costing_options || null, p.locations]); }

  // ------------------------------------------------------------ mensagens humanas
  // Nunca "Path distance exceeds…" cru. n: nº do trecho (opcional).
  function mensagemHumana(msg, ctx) {
    const c = ctx || {}, t = String(msg || "");
    const onde = c.trecho ? "O trecho " + c.trecho + (c.total ? " de " + c.total : "") : "A rota";
    if (ehErroDistancia(t)) return c.trecho
      ? onde + " ficou longo demais para o servidor de rotas. Tente de novo; se repetir, escolha um destino um pouco mais perto."
      : "A rota é muito longa para o servidor de rotas de uma vez. O app divide em trechos sozinho; tente de novo.";
    if (ehErroSemVia(t)) return onde + ": não achei estrada perto de um dos pontos (origem, destino ou ponto no meio). Escolha um ponto mais perto de uma estrada.";
    if (/Sem conex|rede|demorou|network|fetch/i.test(t)) return t;
    if (/No path could be found|no route/i.test(t)) return onde + ": o servidor não achou caminho para este veículo (restrição de altura, peso ou eixos, ou estrada interrompida).";
    if (/exceeds|limit/i.test(t)) return onde + " passou de um limite do servidor de rotas. Tente de novo mais tarde.";
    return t || onde + " não deu para traçar agora.";
  }

  // ------------------------------------------------------------ emenda das respostas
  const PARTIDA = new Set([1, 2, 3]), CHEGADA = new Set([4, 5, 6]);
  function codificar(coords) {
    let lat = 0, lon = 0, s = "";
    const enc = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let o = ""; while (v >= 0x20) { o += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return o + String.fromCharCode(v + 63); };
    for (const [x, y] of coords) { const la = Math.round(y * 1e6), lo = Math.round(x * 1e6); s += enc(la - lat) + enc(lo - lon); lat = la; lon = lo; }
    return s;
  }
  // Uma resposta de rota (com 1 ou mais pernas) → { coords, manobras }, as pernas já emendadas entre si sem repetir o ponto
  function desmontar(json) {
    const pernas = json && json.trip && Array.isArray(json.trip.legs) ? json.trip.legs : [];
    let coords = [], man = [];
    pernas.forEach((l, k) => {
      const c = Rota.decodificarPolyline6(l.shape || "");
      const ms = (l.maneuvers || []).map((m) => Object.assign({}, m));
      if (k === 0) { coords = c; man = ms; } else { const r = emendar({ coords, man }, { coords: c, man: ms }); coords = r.coords; man = r.man; }
    });
    return { coords, man };
  }
  // Emenda B depois de A. O ponto de junção não se repete; a manobra de chegada de A e a de partida de B somem
  // (viram um trecho só da última manobra de A); as manobras de B são renumeradas pelo deslocamento.
  function emendar(A, B) {
    if (!A.coords.length) return B;
    if (!B.coords.length) return A;
    const mesmo = distCoordM(A.coords[A.coords.length - 1], B.coords[0]) < JUNCAO_M;
    const base = mesmo ? A.coords.length - 1 : A.coords.length;
    const man = A.man.slice();
    if (man.length && CHEGADA.has(Number(man[man.length - 1].type))) man.pop();
    const mb = B.man.map((m) => Object.assign({}, m));
    let resto = mb;
    if (mb.length && PARTIDA.has(Number(mb[0].type)) && man.length) {
      const prev = Object.assign({}, man[man.length - 1]), p = mb[0];
      prev.end_shape_index = base + Number(p.end_shape_index || 0);
      prev.length = (Number(prev.length) || 0) + (Number(p.length) || 0);
      prev.time = (Number(prev.time) || 0) + (Number(p.time) || 0);
      delete prev.verbal_post_transition_instruction; // "Continue por 12 km" ficaria desatualizado
      man[man.length - 1] = prev;
      resto = mb.slice(1);
    }
    for (const m of resto) {
      if (isFinite(m.begin_shape_index)) m.begin_shape_index = Number(m.begin_shape_index) + base;
      if (isFinite(m.end_shape_index)) m.end_shape_index = Number(m.end_shape_index) + base;
      man.push(m);
    }
    return { coords: A.coords.concat(mesmo ? B.coords.slice(1) : B.coords), man };
  }
  // Respostas dos trechos (na ordem) → uma resposta { trip } no formato do Valhalla, com .longa descrevendo a divisão.
  // pontos: pontos de divisão colados na estrada (n - 1). Soma distância e tempo; bandeiras (pedágio, balsa) por "ou".
  function concatenar(jsons, pontos) {
    if (!Array.isArray(jsons) || !jsons.length) throw new Error("Nenhum trecho para emendar.");
    let acc = { coords: [], man: [] };
    const fins = [], kms = [], mins = [];
    let length = 0, time = 0, toll = false, ferry = false, restr = false, temToll = false, temFerry = false, temRestr = false;
    for (const j of jsons) {
      const d = desmontar(j);
      acc = emendar(acc, d);
      fins.push(acc.coords.length - 1);
      const s = (j.trip && j.trip.summary) || {};
      length += Number(s.length) || 0; time += Number(s.time) || 0;
      kms.push(Number(s.length) || 0); mins.push(Math.round((Number(s.time) || 0) / 60));
      if (typeof s.has_toll === "boolean") { temToll = true; toll = toll || s.has_toll; }
      if (typeof s.has_ferry === "boolean") { temFerry = true; ferry = ferry || s.has_ferry; }
      if (typeof s.has_time_restrictions === "boolean") { temRestr = true; restr = restr || s.has_time_restrictions; }
    }
    const lons = acc.coords.map((c) => c[0]), lats = acc.coords.map((c) => c[1]);
    const resumo = { length, time, min_lat: Math.min(...lats), max_lat: Math.max(...lats), min_lon: Math.min(...lons), max_lon: Math.max(...lons) };
    if (temToll) resumo.has_toll = toll;
    if (temFerry) resumo.has_ferry = ferry;
    if (temRestr) resumo.has_time_restrictions = restr;
    const primeiro = jsons[0].trip || {};
    return {
      trip: {
        status: 0, status_message: "Found route", units: primeiro.units || "kilometers", language: primeiro.language,
        locations: [(primeiro.locations || [])[0], ((jsons[jsons.length - 1].trip || {}).locations || []).slice(-1)[0]].filter(Boolean),
        summary: resumo,
        legs: [{ summary: Object.assign({}, resumo), shape: codificar(acc.coords), maneuvers: acc.man }],
      },
      longa: { trechos: jsons.length, pontos: (pontos || []).map((p) => ({ lat: p.lat, lon: p.lon })), fins, kms, minutos: mins },
    };
  }

  // ------------------------------------------------------------ execução (pedidos em paralelo, tentativas, progresso)
  function dormir(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function cancelada(e) { return !!(e && e.cancelada); }
  // deps: { rota(pedido) → json bruto (lança com .cancelada/.rede em falha de rede), localizar(body) → json, cache?: Map,
  //         aoTrecho?(estado), sinal?, espera?(ms) (para testes), concorrencia?, tentativas? }
  // o: { origem, destino, pedidoBase, anteriores? }
  // Devolve { json (emendado), pontos, trechos }. Em falha: Error com .longa = { trechos: estados, pontos, falhou: [i…], parcial: [{i, coords}] }.
  async function tracarEmTrechos(o, deps) {
    const plano = planejar(o.origem, o.destino, o.anteriores);
    if (!plano.ok) { const e = new Error(plano.motivo); e.motivo = e.motivo || plano.motivo; throw e; }
    const costing = o.pedidoBase.costing;
    const esperar = deps.espera || dormir;
    const cache = deps.cache || new Map();
    let pontos = plano.pontos;
    if (!plano.reaproveitou) {
      pontos = await colarPontos(plano.pontos, costing, deps.localizar, o.origem, o.destino);
      // pontos coladas na estrada podem ter ficado fora de ordem ou longe: confere o limite da reta de cada trecho
      const cadeia = [o.origem].concat(pontos, [o.destino]);
      for (let i = 1; i < cadeia.length; i++) {
        if (distKm(cadeia[i - 1], cadeia[i]) > LIMITE_SERVIDOR_KM - 50) { const e = new Error("Os pontos do caminho não ficaram bem espaçados."); e.motivo = e.message; throw e; }
      }
    }
    const cadeia = [o.origem].concat(pontos, [o.destino]);
    const n = cadeia.length - 1;
    const estados = [];
    for (let i = 0; i < n; i++) estados.push({ i, de: cadeia[i], ate: cadeia[i + 1], retaKm: distKm(cadeia[i], cadeia[i + 1]), situacao: "espera", km: null, minutos: null, json: null, erro: null });
    const avisar = (e) => { if (deps.aoTrecho) { try { deps.aoTrecho(e, estados); } catch (x) { /* a interface não derruba o cálculo */ } } };
    let parou = null;

    async function umTrecho(est) {
      const pedido = pedidoTrecho(o.pedidoBase, est.de, est.ate);
      const chave = chavePedido(pedido);
      const guardado = cache.get(chave);
      if (guardado && Date.now() - guardado.em < 6 * 3600e3) { est.json = guardado.json; est.situacao = "ok"; finalizar(est); avisar(est); return; }
      est.situacao = "pedindo"; avisar(est);
      let ultimo = null;
      for (let t = 0; t < (deps.tentativas || TENTATIVAS); t++) {
        if (parou) return;
        try {
          const json = await deps.rota(pedido, est.i);
          if (!json || !json.trip || json.trip.status !== 0 || !Array.isArray(json.trip.legs) || !json.trip.legs.length) {
            const msg = json && (json.error || json.message || (json.trip && json.trip.status_message));
            const e = new Error(msg || "Resposta inesperada do servidor de rotas."); e.servidor = true; e.erroCodigo = json && json.error_code; throw e;
          }
          est.json = json; est.situacao = "ok";
          cache.set(chave, { json, em: Date.now() });
          finalizar(est); avisar(est); return;
        } catch (e) {
          if (cancelada(e)) { parou = e; return; }
          ultimo = e;
          if (e.servidor && (ehErroSemVia(e.message) || ehErroDistancia(e.message))) break; // repetir não adianta
          if (t + 1 < (deps.tentativas || TENTATIVAS)) await esperar(700 * (t + 1));
        }
      }
      est.situacao = "falhou"; est.erro = ultimo;
      est.motivo = ultimo ? (ultimo.rede ? ultimo.message : mensagemHumana(ultimo.message, { trecho: est.i + 1, total: n })) : "Falhou.";
      avisar(est);
    }
    function finalizar(est) {
      const s = est.json.trip.summary || {};
      est.km = Number(s.length) || 0; est.minutos = Math.round((Number(s.time) || 0) / 60);
    }

    let proximo = 0;
    async function trabalhador() { while (proximo < n && !parou) { const est = estados[proximo++]; await umTrecho(est); } }
    await Promise.all(Array.from({ length: Math.min(deps.concorrencia || CONCORRENCIA, n) }, trabalhador));
    if (parou) throw parou;
    const falhou = estados.filter((e) => e.situacao === "falhou");
    if (falhou.length) {
      const primeiro = falhou[0];
      const e = new Error(primeiro.motivo);
      e.motivo = "Falhou o trecho " + (primeiro.i + 1) + " de " + n + ". " + primeiro.motivo;
      e.rede = !!(primeiro.erro && primeiro.erro.rede); e.demorou = !!(primeiro.erro && primeiro.erro.demorou);
      e.longa = { n, pontos, falhou: falhou.map((x) => x.i), trechos: estados.map(resumoEstado) };
      e.estados = estados;
      throw e;
    }
    const json = concatenar(estados.map((e) => e.json), pontos);
    return { json, pontos, trechos: estados.map(resumoEstado) };
  }
  function resumoEstado(e) {
    return { i: e.i, de: e.de, ate: e.ate, situacao: e.situacao, km: e.km, minutos: e.minutos, retaKm: e.retaKm, motivo: e.motivo || null };
  }
  // Trechos que chegaram, para desenhar: [{ i, coords, ok }] — o que já veio nunca é descartado.
  function desenhosParciais(estados) {
    const out = [];
    for (const e of estados) {
      if (e.json) { const d = desmontar(e.json); out.push({ i: e.i, coords: d.coords, ok: true }); }
      else out.push({ i: e.i, coords: [[e.de.lon, e.de.lat], [e.ate.lon, e.ate.lat]], ok: false, situacao: e.situacao });
    }
    return out;
  }
  // Rota "até onde há rota": trechos que chegaram desde a origem, em sequência, sem buraco. null se nem o primeiro chegou.
  function rotaParcial(estados, pontos) {
    const ok = [];
    for (const e of estados) { if (e.json) ok.push(e); else break; }
    if (!ok.length) return null;
    const json = concatenar(ok.map((e) => e.json), pontos.slice(0, ok.length - 1));
    return { json, ate: ok[ok.length - 1].ate, trechos: ok.length };
  }

  function textoProgresso(estados) {
    const n = estados.length, feitos = estados.filter((e) => e.situacao === "ok").length;
    const pedindo = estados.find((e) => e.situacao === "pedindo");
    if (feitos === n) return "Trechos prontos: " + n + " de " + n + ".";
    return "Traçando trecho " + ((pedindo ? pedindo.i : feitos) + 1) + " de " + n + "…";
  }

  const api = {
    LIMITE_SERVIDOR_KM, DIVIDIR_ACIMA_KM, RETA_POR_TRECHO_KM, RETA_MAX_TRECHO_KM, MAX_TRECHOS, CONCORRENCIA, TENTATIVAS, NIVEIS_SNAP,
    distKm, pontoNaReta, ehErroDistancia, ehErroSemVia, retaKm, deveDividir, numeroDeTrechos, planejar,
    pedidoLocate, lerLocate, colarPontos, pedidoTrecho, chavePedido, mensagemHumana,
    codificar, desmontar, emendar, concatenar, tracarEmTrechos, desenhosParciais, rotaParcial, textoProgresso,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoRotaLonga = api;
})(typeof window !== "undefined" ? window : globalThis);
