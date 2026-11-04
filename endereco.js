// Endereço próximo para o SOS: lógica pura, sem DOM. Usada por ui/endereco.js e pelos testes no Node
// (tests/endereco.test.js).
//  - do próprio mapa (sem internet): via mais próxima com nome ou sigla (BR-153, GO-060) nas feições da camada
//    transportation_name dos blocos da OpenFreeMap, e cidade/bairro/estado mais próximos da camada place
//  - da internet (Nominatim, geocodificação reversa pontual): resposta jsonv2 → mesmo formato
//  - junta os dois, monta o texto para ditar ("Estou na BR-153, sentido norte, a cerca de 12 km de Anápolis - GO.")
//  - decide quando consultar de novo (cache por ~100 m / 5 min, no máximo 1 pedido por segundo)
// km de rodovia: o mapa e o Nominatim não trazem o marco quilométrico; fica null (nunca é inventado).
(function (raiz) {
  "use strict";

  const UFS = { AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal",
    ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais",
    PA: "Pará", PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte",
    RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima", SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins" };
  const semAcento = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const UF_POR_NOME = {};
  for (const k of Object.keys(UFS)) UF_POR_NOME[semAcento(UFS[k])] = k;

  const PADRAO = {
    raioViaM: 400,          // via mais longe que isto não é "a via onde estou"
    raioBairroM: 3000,
    raioCidadeM: 40000,
    cacheRaioM: 100,        // consulta da internet vale para ~100 m
    cacheValidadeMs: 5 * 60e3, // e por 5 min
    intervaloMs: 1000,      // Nominatim: no máximo 1 pedido por segundo
  };
  const CLASSES_CIDADE = { city: 3, town: 2, municipality: 2, village: 1 };
  const CLASSES_BAIRRO = { suburb: 1, quarter: 1, neighbourhood: 1 };
  const NOMINATIM = "https://nominatim.openstreetmap.org/reverse";

  // ------------------------------------------------------------ distâncias (metros, projeção local)
  function xy(p, ref) {
    const r = Math.PI / 180;
    return [(p[0] - ref[0]) * 111195 * Math.cos(ref[1] * r), (p[1] - ref[1]) * 111195];
  }
  function distSegmento(p, a, b) { // em metros; p, a, b = [lon, lat]
    const A = xy(a, p), B = xy(b, p);
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const L = dx * dx + dy * dy;
    let t = L ? -(A[0] * dx + A[1] * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(A[0] + t * dx, A[1] + t * dy);
  }
  function distLinha(p, linha) {
    if (!Array.isArray(linha) || !linha.length) return Infinity;
    if (linha.length === 1) return distSegmento(p, linha[0], linha[0]);
    let m = Infinity;
    for (let i = 1; i < linha.length; i++) m = Math.min(m, distSegmento(p, linha[i - 1], linha[i]));
    return m;
  }
  // Distância de um ponto [lon, lat] até uma geometria GeoJSON (Point, MultiPoint, LineString, MultiLineString, Polygon…)
  function distanciaM(ponto, g) {
    if (!g || !g.coordinates) return Infinity;
    const c = g.coordinates;
    switch (g.type) {
      case "Point": return distSegmento(ponto, c, c);
      case "MultiPoint": case "LineString": return g.type === "MultiPoint" ? Math.min.apply(null, c.map((q) => distSegmento(ponto, q, q)).concat(Infinity)) : distLinha(ponto, c);
      case "MultiLineString": case "Polygon": return Math.min.apply(null, c.map((l) => distLinha(ponto, l)).concat(Infinity));
      case "MultiPolygon": return Math.min.apply(null, c.map((pg) => Math.min.apply(null, pg.map((l) => distLinha(ponto, l)).concat(Infinity))).concat(Infinity));
      default: return Infinity;
    }
  }
  const comoPonto = (p) => (Array.isArray(p) ? p : [Number(p.lon != null ? p.lon : p.lng), Number(p.lat)]);

  // ------------------------------------------------------------ nomes de via
  // "BR-153", "br 153", "GO060" → "BR-153", "GO-060". Prefixo só BR ou sigla de estado (sem inventar sigla).
  function normalizarSigla(s) {
    const m = /^\s*([A-Za-z]{2})\s*-?\s*(\d{2,3})\s*$/.exec(String(s || ""));
    if (!m) return null;
    const p = m[1].toUpperCase();
    if (p !== "BR" && !UFS[p]) return null;
    return p + "-" + m[2].padStart(3, "0");
  }
  // Sigla da rodovia a partir do ref ("BR-153;BR-060") ou do nome ("Rodovia BR-153"). BR tem preferência.
  function siglaDaVia(props) {
    const p = props || {};
    const refs = String(p.ref || "").split(/[;,/]/).map(normalizarSigla).filter(Boolean);
    if (!refs.length) {
      const nome = String(p.name || p["name:pt"] || "");
      const re = /\b([A-Za-z]{2})[\s-]?(\d{3})\b/g;
      let m;
      while ((m = re.exec(nome))) { const s = normalizarSigla(m[1] + "-" + m[2]); if (s) refs.push(s); }
    }
    return refs.find((r) => r.indexOf("BR-") === 0) || refs[0] || null;
  }
  function nomeDe(props) {
    const p = props || {};
    const n = p["name:pt"] || p.name || p["name:latin"] || p.name_int || null;
    return n ? String(n).trim() || null : null;
  }
  // Via de uma feição: { rodovia, rua } (rua = nome, quando não é só a sigla)
  function via(props) {
    const rodovia = siglaDaVia(props);
    let rua = nomeDe(props);
    if (rua && rodovia && normalizarSigla(rua) === rodovia) rua = null;
    return { rodovia, rua };
  }

  // Via mais próxima com nome ou sigla. feicoes = [{ geometry, properties }] (querySourceFeatures). Empate (até 15 m)
  // fica com a que tem sigla de rodovia. Devolve { rodovia, rua, distanciaM } ou null.
  function escolherVia(feicoes, ponto, opcoes) {
    const o = Object.assign({}, PADRAO, opcoes);
    const p = comoPonto(ponto);
    const cand = [];
    for (const f of Array.isArray(feicoes) ? feicoes : []) {
      if (!f) continue;
      const v = via(f.properties);
      if (!v.rodovia && !v.rua) continue;
      const d = distanciaM(p, f.geometry);
      if (d <= o.raioViaM) cand.push({ rodovia: v.rodovia, rua: v.rua, distanciaM: d });
    }
    if (!cand.length) return null;
    cand.sort((a, b) => a.distanciaM - b.distanciaM);
    const perto = cand[0];
    if (perto.rodovia) return perto;
    return cand.find((c) => c.rodovia && c.distanciaM <= perto.distanciaM + 15) || perto;
  }

  function ufDeNome(nome) {
    if (!nome) return null;
    const s = String(nome).trim();
    if (UFS[s.toUpperCase()] && s.length === 2) return s.toUpperCase();
    return UF_POR_NOME[semAcento(s)] || null;
  }

  // Cidade, bairro e UF mais próximos (camada place). Devolve { cidade, bairro, uf, distanciaCidadeM }.
  function escolherLugares(feicoes, ponto, opcoes) {
    const o = Object.assign({}, PADRAO, opcoes);
    const p = comoPonto(ponto);
    let cidade = null, bairro = null, uf = null;
    for (const f of Array.isArray(feicoes) ? feicoes : []) {
      if (!f || !f.properties) continue;
      const cl = f.properties.class, nome = nomeDe(f.properties);
      if (!nome) continue;
      const d = distanciaM(p, f.geometry);
      if (CLASSES_CIDADE[cl] && d <= o.raioCidadeM && (!cidade || d < cidade.d)) cidade = { nome, d };
      else if (CLASSES_BAIRRO[cl] && d <= o.raioBairroM && (!bairro || d < bairro.d)) bairro = { nome, d };
      else if ((cl === "state" || cl === "province") && (!uf || d < uf.d) && ufDeNome(nome)) uf = { nome: ufDeNome(nome), d };
    }
    return { cidade: cidade ? cidade.nome : null, bairro: bairro ? bairro.nome : null, uf: uf ? uf.nome : null,
      distanciaCidadeM: cidade ? cidade.d : null };
  }

  // Endereço só do mapa. { vias, lugares, ponto } → { rodovia, km, rua, bairro, cidade, uf, texto, fonte: "mapa" } ou null
  function doMapa(dados, opcoes) {
    const d = dados || {};
    const v = escolherVia(d.vias, d.ponto, opcoes);
    const l = escolherLugares(d.lugares, d.ponto, opcoes);
    const e = { rodovia: v ? v.rodovia : null, km: null, rua: v ? v.rua : null, bairro: l.bairro, cidade: l.cidade, uf: l.uf,
      fonte: "mapa", distanciaCidadeM: l.distanciaCidadeM };
    return completar(e, opcoes);
  }

  // Resposta jsonv2 do Nominatim (com addressdetails e namedetails) → endereço ou null
  function deNominatim(json, opcoes) {
    if (!json || typeof json !== "object" || json.error || !json.address) return null;
    const a = json.address, nd = json.namedetails || {};
    let rodovia = siglaDaVia({ ref: nd.ref || "", name: a.road || "" });
    let rua = a.road || null;
    if (rua && rodovia && normalizarSigla(rua) === rodovia) rua = null;
    const iso = /^BR-([A-Z]{2})$/.exec(String(a["ISO3166-2-lvl4"] || ""));
    const e = {
      rodovia: rodovia || null, km: null, rua,
      bairro: a.suburb || a.neighbourhood || a.quarter || a.city_district || null,
      cidade: a.city || a.town || a.municipality || a.village || null,
      uf: iso && UFS[iso[1]] ? iso[1] : ufDeNome(a.state),
      fonte: "internet",
    };
    return completar(e, opcoes);
  }

  // Junta o do mapa com o da internet. Se a internet achou a via, a via é dela (as duas fontes podem ter escolhido vias
  // diferentes; não mistura); senão fica a do mapa. Bairro, cidade e UF: internet primeiro, mapa completa o que faltar.
  function combinar(mapa, internet, opcoes) {
    const copia = (e) => Object.assign({}, e, { distanciaCidadeM: e.distanciaCidadeM });
    if (!internet) return mapa ? completar(copia(mapa), opcoes) : null;
    if (!mapa) return completar(copia(internet), opcoes);
    const viaDaInternet = !!(internet.rodovia || internet.rua);
    const e = {
      rodovia: viaDaInternet ? internet.rodovia : mapa.rodovia,
      km: viaDaInternet ? internet.km : mapa.km,
      rua: viaDaInternet ? internet.rua : mapa.rua,
      bairro: internet.bairro || mapa.bairro, cidade: internet.cidade || mapa.cidade, uf: internet.uf || mapa.uf,
      fonte: "internet",
      // a distância até a cidade só vale se a cidade é a mesma que o mapa achou
      distanciaCidadeM: internet.cidade && internet.cidade !== mapa.cidade ? null : mapa.distanciaCidadeM,
    };
    return completar(e, opcoes);
  }

  // ------------------------------------------------------------ texto para ditar
  const SENTIDOS = ["norte", "nordeste", "leste", "sudeste", "sul", "sudoeste", "oeste", "noroeste"];
  function sentido(rumo) {
    if (rumo == null || rumo === "" || !isFinite(rumo)) return null;
    const g = ((Number(rumo) % 360) + 360) % 360;
    return SENTIDOS[Math.round(g / 45) % 8];
  }
  // "na Rua 10", "no Viaduto…", "na BR-153"
  const MASCULINOS = /^(viaduto|anel|eixo|contorno|acesso|trevo|elevado|corredor|largo|beco|caminho|ramal|parque|setor|túnel|tunel|retorno|marginal\s+do)\b/i;
  const artigo = (nome) => (MASCULINOS.test(nome) ? "no " : "na ");
  const lugarTexto = (e) => (e.cidade ? e.cidade + (e.uf ? " - " + e.uf : "") : null);
  // e = endereço; o = { rumo } (graus, do GPS). Devolve a frase ou null se não há nada.
  function montarTexto(e, o) {
    if (!e) return null;
    const s = sentido(o && o.rumo);
    const partes = [];
    const cidade = lugarTexto(e);
    if (e.rodovia) {
      let t = "Estou na " + e.rodovia;
      if (e.km != null && isFinite(e.km)) t += ", km " + String(Math.round(e.km * 10) / 10).replace(".", ",");
      if (s) t += ", sentido " + s;
      partes.push(t);
      if (cidade) {
        const dc = e.distanciaCidadeM;
        if (dc != null && dc >= 2000) partes.push("a cerca de " + Math.round(dc / 1000) + " km de " + cidade);
        else partes.push((e.bairro ? "perto de " + e.bairro + ", " : "perto de ") + cidade);
      } else if (e.bairro) partes.push("perto de " + e.bairro);
      else if (e.uf) partes.push("em " + UFS[e.uf]);
    } else if (e.rua) {
      let t = "Estou " + artigo(e.rua) + e.rua;
      if (s) t += ", sentido " + s;
      partes.push(t);
      if (e.bairro) partes.push(e.bairro);
      if (cidade) partes.push(cidade);
      else if (e.uf) partes.push(UFS[e.uf]);
    } else if (cidade || e.bairro) {
      const dc = e.distanciaCidadeM;
      if (cidade && dc != null && dc >= 2000) partes.push("Estou a cerca de " + Math.round(dc / 1000) + " km de " + cidade);
      else partes.push("Estou perto de " + [e.bairro, cidade].filter(Boolean).join(", "));
    } else return null;
    return partes.join(", ") + ".";
  }
  // r5: km vindo do "em que km estou" (ui/km.js, evento km:atual): { rodovia: "BR-153", km: 140.5 }. Preenche rodovia/km quando o
  // endereço não traz o marco (ele nunca traz) e a rodovia é a mesma (ou o endereço não tem rodovia). Sem km válido, igual a antes.
  const normRod = (r) => String(r || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  function comKm(e, k) {
    if (!e || !k || !k.rodovia || typeof k.km !== "number" || !isFinite(k.km) || e.km != null) return e;
    if (e.rodovia && normRod(e.rodovia) !== normRod(k.rodovia)) return e;
    return Object.assign({}, e, { rodovia: e.rodovia || k.rodovia, km: k.km });
  }
  // Põe o texto; sem nada útil → null
  function completar(e, o) {
    e = comKm(e, o && o.km);
    const texto = montarTexto(e, o);
    if (!texto) return null;
    const out = { rodovia: e.rodovia || null, km: e.km != null && isFinite(e.km) ? e.km : null, rua: e.rua || null, bairro: e.bairro || null,
      cidade: e.cidade || null, uf: e.uf || null, texto, fonte: e.fonte };
    // fica fora do formato público, só para combinar e montar o texto de novo
    Object.defineProperty(out, "distanciaCidadeM", { value: e.distanciaCidadeM == null ? null : e.distanciaCidadeM, enumerable: false });
    return out;
  }

  // ------------------------------------------------------------ quando consultar a internet de novo
  // cache = [{ lat, lon, em, valor }]. Devolve a entrada que serve para este ponto agora (≤ 100 m, ≤ 5 min) ou null.
  function doCache(cache, ponto, agora, opcoes) {
    const o = Object.assign({}, PADRAO, opcoes);
    const p = comoPonto(ponto);
    let melhor = null, dm = Infinity;
    for (const c of Array.isArray(cache) ? cache : []) {
      if (!c || !(agora - c.em <= o.cacheValidadeMs) || agora < c.em - 60e3) continue;
      const d = distSegmento(p, [c.lon, c.lat], [c.lon, c.lat]);
      if (d <= o.cacheRaioM && d < dm) { melhor = c; dm = d; }
    }
    return melhor;
  }
  // Pode mandar outro pedido agora? (no máximo 1 por segundo)
  function podePedir(ultimoPedidoEm, agora, opcoes) {
    const o = Object.assign({}, PADRAO, opcoes);
    return !(ultimoPedidoEm != null && isFinite(ultimoPedidoEm) && agora - ultimoPedidoEm < o.intervaloMs);
  }
  // Decide: "cache" (usa a entrada), "pedir" ou "mapa" (não consulta: sem internet ou cedo demais)
  function decidir(estado, ponto, agora, opcoes) {
    const s = estado || {};
    const c = doCache(s.cache, ponto, agora, opcoes);
    if (c) return { acao: "cache", entrada: c };
    if (s.online === false) return { acao: "mapa" };
    if (!podePedir(s.ultimoPedidoEm, agora, opcoes)) return { acao: "mapa" };
    return { acao: "pedir" };
  }
  // Guarda a resposta no cache (mais nova no fim; no máximo 20; tira as vencidas)
  function guardar(cache, ponto, agora, valor, opcoes) {
    const o = Object.assign({}, PADRAO, opcoes);
    const p = comoPonto(ponto);
    const lista = (Array.isArray(cache) ? cache : []).filter((c) => agora - c.em <= o.cacheValidadeMs);
    lista.push({ lat: p[1], lon: p[0], em: agora, valor });
    return lista.slice(-20);
  }

  // Endereço do pedido ao Nominatim (uso pontual, sem lote; o navegador manda o Referer do app como identificação)
  function urlNominatim(lat, lon) {
    const q = "format=jsonv2&lat=" + Number(lat).toFixed(6) + "&lon=" + Number(lon).toFixed(6) +
      "&zoom=18&addressdetails=1&namedetails=1&accept-language=pt-BR";
    return NOMINATIM + "?" + q;
  }

  const api = {
    PADRAO, UFS, NOMINATIM, distanciaM, normalizarSigla, siglaDaVia, via, escolherVia, escolherLugares, ufDeNome,
    comKm, doMapa, deNominatim, combinar, sentido, montarTexto, doCache, podePedir, decidir, guardar, urlNominatim,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoEndereco = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis);
