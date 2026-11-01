// Alternativas de rota: lógica pura (sem DOM), testada no Node (tests/alternativas.test.js).
//
// O Valhalla aceita "alternates": N no pedido de /route (só com 2 pontos; não vale em rota com horário). A resposta traz a
// principal em "trip" e as outras em "alternates": [{ trip }, …]. O servidor pode devolver MENOS que o pedido (inclusive
// nenhuma): o app segue só com a principal, sem erro. Até 3 rotas no total.
//
// Para cada rota, só o que a resposta diz (nada é inventado): tempo, distância, chegada, pedágio (summary.has_toll ou
// manobra .toll), balsa (has_ferry / .ferry), terra ou pavimento ruim (manobra .rough), porteira (.gate), restrição de
// horário (has_time_restrictions) e os relatos ativos conhecidos perto da linha. Campo ausente = desconhecido (null).
//
// Escolher uma alternativa e depois recalcular (carregado/vazio): o pedido leva pontos de passagem ("through": sem
// parada, sem perna nova, sem retorno) tirados dos trechos onde a escolhida se separa das outras.
(function (raiz) {
  "use strict";

  const MAX_ROTAS = 3;
  const PERTO_RELATO_M = 100;     // relato a até 100 m da linha conta como "no caminho"
  const SEPARADA_M = 300;         // trecho a mais de 300 m das outras rotas é "próprio" da alternativa
  const MAX_PASSAGENS = 3;
  const CELULA = 0.01;            // grade do índice espacial (graus, ~1,1 km)

  // ------------------------------------------------------------ pedido
  // Acrescenta "alternates" (até MAX_ROTAS - 1). Com mais de 2 pontos o Valhalla não dá alternativas: pedido intacto.
  function pedirAlternativas(pedido, total) {
    const n = Math.max(0, Math.min(MAX_ROTAS, total || MAX_ROTAS) - 1);
    if (!pedido || !Array.isArray(pedido.locations) || pedido.locations.length !== 2 || !n) return pedido;
    return Object.assign({}, pedido, { alternates: n });
  }

  // Pontos de passagem: entram entre a origem e o destino como "through" (com o rumo da linha, para não pegar a outra pista).
  function aplicarPassagem(pedido, pontos) {
    const p = Object.assign({}, pedido);
    delete p.alternates;
    if (!Array.isArray(pontos) || !pontos.length || !Array.isArray(pedido.locations) || pedido.locations.length < 2) return p;
    const locs = pedido.locations;
    const meio = pontos.map((x) => {
      const l = { lat: x.lat, lon: x.lon, type: "through" };
      if (isFinite(x.rumo)) { l.heading = Math.round(x.rumo) % 360; l.heading_tolerance = 45; }
      return l;
    });
    p.locations = [locs[0], ...meio, locs[locs.length - 1]];
    return p;
  }

  // ------------------------------------------------------------ resposta
  // Separa a resposta em respostas de uma rota só ({ trip }), principal primeiro, no máximo MAX_ROTAS.
  // validar(json) lança se não for rota (rota.js: resumirResposta); alternativa inválida é descartada, a principal não.
  function separarRotas(json, validar) {
    const lista = [];
    if (!json || !json.trip) return lista;
    lista.push({ trip: json.trip });
    for (const a of Array.isArray(json.alternates) ? json.alternates : []) {
      if (lista.length >= MAX_ROTAS) break;
      if (!a || !a.trip) continue;
      const r = { trip: a.trip };
      if (validar) { try { validar(r); } catch (e) { continue; } }
      lista.push(r);
    }
    return lista;
  }

  function manobras(json) {
    const legs = json && json.trip && Array.isArray(json.trip.legs) ? json.trip.legs : [];
    const m = [];
    for (const l of legs) if (Array.isArray(l.maneuvers)) m.push(...l.maneuvers);
    return m;
  }
  // true / false / null (o servidor não informou)
  function bandeira(resumo, campoResumo, mans, campoManobra) {
    if (mans.some((m) => m && m[campoManobra] === true)) return true;
    if (resumo && typeof resumo[campoResumo] === "boolean") return resumo[campoResumo];
    return null; // o resumo não disse: desconhecido (manobra sem a marca não prova que não tem)
  }
  // Características da rota para o caminhoneiro, só pelo que o servidor devolveu.
  function caracteristicas(json) {
    const s = (json && json.trip && json.trip.summary) || {};
    const mans = manobras(json);
    const temManobras = mans.length > 0;
    return {
      pedagio: bandeira(s, "has_toll", mans, "toll"),
      balsa: bandeira(s, "has_ferry", mans, "ferry"),
      // "rough" só vem nas manobras: sem manobras, desconhecido
      terra: temManobras ? mans.some((m) => m && m.rough === true) : null,
      porteira: temManobras ? mans.some((m) => m && m.gate === true) : null,
      restricaoHorario: typeof s.has_time_restrictions === "boolean" ? s.has_time_restrictions : null,
    };
  }

  // ------------------------------------------------------------ geometria
  const RAD = Math.PI / 180;
  function distM(a, b) { // [lon, lat]
    const R = 6371000, dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  // distância (m) de p ao segmento a-b, plano local (equiretangular): erro desprezível para alguns km
  function distSegM(p, a, b) {
    const kx = 111320 * Math.cos(p[1] * RAD), ky = 110540;
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? -(ax * dx + ay * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy;
    return Math.sqrt(x * x + y * y);
  }
  function rumo(a, b) {
    const y = Math.sin((b[0] - a[0]) * RAD) * Math.cos(b[1] * RAD);
    const x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) - Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos((b[0] - a[0]) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }
  // Índice em grade dos segmentos de uma linha: distância de um ponto à linha em O(1) para limites ≤ ~1 km.
  function indexar(coords) {
    const grade = new Map();
    const chave = (i, j) => i + ":" + j;
    for (let k = 0; k + 1 < (coords || []).length; k++) {
      const a = coords[k], b = coords[k + 1];
      const i0 = Math.floor(Math.min(a[0], b[0]) / CELULA), i1 = Math.floor(Math.max(a[0], b[0]) / CELULA);
      const j0 = Math.floor(Math.min(a[1], b[1]) / CELULA), j1 = Math.floor(Math.max(a[1], b[1]) / CELULA);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 400) continue; // segmento absurdo (≥ 20 km): ignora no índice
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const c = chave(i, j); let l = grade.get(c); if (!l) grade.set(c, (l = [])); l.push(k);
      }
    }
    if (coords && coords.length === 1) grade.set(chave(Math.floor(coords[0][0] / CELULA), Math.floor(coords[0][1] / CELULA)), [-1]);
    return { coords: coords || [], grade, chave };
  }
  // Distância (m) do ponto à linha indexada; Infinity se não houver nada nas células vizinhas (longe, > ~1 km).
  function distLinhaM(idx, p) {
    const i = Math.floor(p[0] / CELULA), j = Math.floor(p[1] / CELULA);
    let melhor = Infinity; const vistos = new Set();
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const l = idx.grade.get(idx.chave(i + di, j + dj)); if (!l) continue;
      for (const k of l) {
        if (vistos.has(k)) continue; vistos.add(k);
        const d = k < 0 ? distM(p, idx.coords[0]) : distSegM(p, idx.coords[k], idx.coords[k + 1]);
        if (d < melhor) melhor = d;
      }
    }
    return melhor;
  }
  // Maior distância (m) de um ponto de "a" até a linha "b" (Infinity se passa de ~1 km).
  function diferencaMaxM(a, b) {
    const idx = indexar(b); let max = 0;
    for (const p of a || []) { const d = distLinhaM(idx, p); if (d > max) max = d; }
    return max;
  }

  // ------------------------------------------------------------ relatos no caminho
  function ativoAgora(r, agoraMs) {
    if (!r || !isFinite(r.lat) || !isFinite(r.lon)) return false;
    if (r.expires_at) { const t = Date.parse(r.expires_at); if (isFinite(t) && t <= agoraMs) return false; }
    return true;
  }
  function difAng(a, b) { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; }
  // Quantos relatos ativos (linhas no formato de copiloto_reports_near) ficam a até PERTO_RELATO_M da linha.
  // Relato com sentido (heading_deg) só conta se o sentido bate com o da linha ali (≤ 60°): o da outra pista não é deste caminho.
  function relatosNaRota(coords, relatos, agoraMs, idx) {
    if (!Array.isArray(coords) || coords.length < 2 || !Array.isArray(relatos) || !relatos.length) return 0;
    const ind = idx || indexar(coords);
    let n = 0;
    for (const r of relatos) {
      if (!ativoAgora(r, agoraMs)) continue;
      const p = [Number(r.lon), Number(r.lat)];
      const d = distLinhaM(ind, p);
      if (!(d <= PERTO_RELATO_M)) continue;
      if (r.heading_deg != null && isFinite(r.heading_deg)) {
        const k = segmentoMaisPerto(ind, p);
        if (k >= 0 && difAng(rumo(coords[k], coords[k + 1]), Number(r.heading_deg)) > 60) continue;
      }
      n++;
    }
    return n;
  }
  function segmentoMaisPerto(idx, p) {
    const i = Math.floor(p[0] / CELULA), j = Math.floor(p[1] / CELULA);
    let melhor = Infinity, km = -1;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const k of idx.grade.get(idx.chave(i + di, j + dj)) || []) {
        if (k < 0) continue;
        const d = distSegM(p, idx.coords[k], idx.coords[k + 1]); if (d < melhor) { melhor = d; km = k; }
      }
    }
    return km;
  }

  // ------------------------------------------------------------ pontos de passagem
  // Até MAX_PASSAGENS pontos da rota escolhida nos trechos em que ela fica a mais de SEPARADA_M de todas as outras
  // (o meio dos trechos mais longos, na ordem da viagem), cada um com o rumo da linha e o índice do ponto em coords.
  // Sem trecho próprio: [].
  function pontosDePassagem(coords, outras) {
    if (!Array.isArray(coords) || coords.length < 3) return [];
    const idxs = (outras || []).filter((o) => Array.isArray(o) && o.length > 1).map(indexar);
    if (!idxs.length) return [];
    const longe = coords.map((p) => idxs.every((ix) => distLinhaM(ix, p) > SEPARADA_M));
    // trechos (corridas de pontos "longe"), com o comprimento em metros
    const trechos = [];
    let ini = -1;
    for (let i = 0; i <= coords.length; i++) {
      if (i < coords.length && longe[i]) { if (ini < 0) ini = i; continue; }
      if (ini >= 0) {
        let m = 0; for (let k = ini; k < i - 1; k++) m += distM(coords[k], coords[k + 1]);
        trechos.push({ ini, fim: i - 1, m });
        ini = -1;
      }
    }
    const escolhidos = trechos.filter((t) => t.m >= 200).sort((a, b) => b.m - a.m).slice(0, MAX_PASSAGENS).sort((a, b) => a.ini - b.ini);
    return escolhidos.map((t) => {
      // ponto do meio do trecho, pela distância
      let alvo = t.m / 2, k = t.ini;
      while (k < t.fim && alvo > distM(coords[k], coords[k + 1])) { alvo -= distM(coords[k], coords[k + 1]); k++; }
      const a = coords[k], b = coords[Math.min(k + 1, coords.length - 1)];
      return { lat: a[1], lon: a[0], rumo: a === b ? NaN : rumo(a, b), indice: k };
    });
  }

  // ------------------------------------------------------------ rótulos e textos
  // itens: [{ minutos, km, pedagio, balsa, terra, relatos }] (a principal primeiro). Devolve, para cada uma,
  // { rotulo, comparacao } — rótulo curto ("Mais rápida", "Mais curta", "Sem pedágio", "Sem balsa", "Sem terra",
  // "Menos relatos" ou "Alternativa N") e a diferença para a mais rápida ("+12 min · +8,3 km").
  function rotular(itens) {
    const n = itens.length;
    if (!n) return [];
    const menor = (f) => { let v = Infinity; for (const x of itens) if (isFinite(f(x)) && f(x) < v) v = f(x); return v; };
    const tMin = menor((x) => x.minutos), kMin = menor((x) => x.km);
    const iRapida = itens.findIndex((x) => x.minutos === tMin);
    const iCurta = itens.findIndex((x) => x.km === kMin);
    const sem = (campo, i) => itens[i][campo] === false && itens.some((y, j) => j !== i && y[campo] === true);
    const relMin = menor((x) => x.relatos);
    const unicoMenosRelatos = (i) => isFinite(itens[i].relatos) && itens[i].relatos === relMin &&
      itens.filter((y) => y.relatos === relMin).length === 1 && itens.some((y) => isFinite(y.relatos) && y.relatos > relMin);
    return itens.map((x, i) => {
      let rotulo = null;
      if (n > 1) {
        if (i === iRapida) rotulo = "Mais rápida";
        else if (i === iCurta && x.km < itens[iRapida].km - 0.05) rotulo = "Mais curta";
        else if (sem("pedagio", i)) rotulo = "Sem pedágio";
        else if (sem("balsa", i)) rotulo = "Sem balsa";
        else if (sem("terra", i)) rotulo = "Sem terra";
        else if (unicoMenosRelatos(i)) rotulo = "Menos relatos";
        else rotulo = "Alternativa " + (i + 1);
      }
      let comparacao = "";
      if (n > 1 && i !== iRapida && isFinite(x.minutos) && isFinite(tMin)) {
        const dt = x.minutos - tMin, dk = x.km - itens[iRapida].km;
        comparacao = "+" + formatarDuracao(dt) + (isFinite(dk) ? " · " + (dk >= 0 ? "+" : "−") + Math.abs(dk).toFixed(1).replace(".", ",") + " km" : "");
      }
      return { rotulo, comparacao };
    });
  }
  function formatarDuracao(min) {
    min = Math.max(0, Math.round(min));
    const h = Math.floor(min / 60), m = min % 60;
    return h ? h + " h " + String(m).padStart(2, "0") + " min" : m + " min";
  }
  // Etiquetas curtas para o cartão, só com o que se sabe: ["Pedágio", "Balsa", "Terra/piso ruim", "Porteira", "Horário restrito", "2 relatos"].
  function etiquetas(c, relatos) {
    const l = [];
    if (c.pedagio === true) l.push("Pedágio"); else if (c.pedagio === false) l.push("Sem pedágio");
    if (c.balsa === true) l.push("Balsa");
    if (c.terra === true) l.push("Terra/piso ruim");
    if (c.porteira === true) l.push("Porteira");
    if (c.restricaoHorario === true) l.push("Horário restrito");
    if (isFinite(relatos) && relatos > 0) l.push(relatos + (relatos === 1 ? " relato" : " relatos"));
    return l;
  }
  // "chega 14:35" (hora local); outro dia: "chega 01/11 03:10"
  function chegada(agoraMs, minutos) {
    if (!isFinite(agoraMs) || !isFinite(minutos)) return "chegada --";
    const a = new Date(agoraMs), c = new Date(agoraMs + Math.round(minutos) * 60000);
    const hh = String(c.getHours()).padStart(2, "0") + ":" + String(c.getMinutes()).padStart(2, "0");
    const mesmoDia = a.getFullYear() === c.getFullYear() && a.getMonth() === c.getMonth() && a.getDate() === c.getDate();
    return "chega " + (mesmoDia ? "" : String(c.getDate()).padStart(2, "0") + "/" + String(c.getMonth() + 1).padStart(2, "0") + " ") + hh;
  }

  const api = { MAX_ROTAS, PERTO_RELATO_M, SEPARADA_M, pedirAlternativas, aplicarPassagem, separarRotas, caracteristicas,
    indexar, distLinhaM, diferencaMaxM, relatosNaRota, pontosDePassagem, rotular, etiquetas, chegada, formatarDuracao };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoAlternativas = api;
})(typeof window !== "undefined" ? window : globalThis);
