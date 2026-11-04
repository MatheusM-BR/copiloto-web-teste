// Dados da estrada na navegação (lógica pura, sem DOM; testada em tests/dados.test.js). Usada por ui/km.js e ui/avisos.js.
//
// Fontes (RPCs públicas do Supabase, chave anon; ver docs/FONTES_DE_DADOS.md):
//   copiloto_km_at / copiloto_snv_km_at     "em que km estou" (PRF + marcos ARTESP, estimado; SNV do DNIT, oficial)
//   copiloto_km_to_point / copiloto_km_highways   destino por km ("BR-153 km 140") e autocompletar de rodovias
//   copiloto_route_features / copiloto_route_hot_spots / copiloto_route_artesp   avisos à frente (curva forte, lombada,
//     balança, passagem de nível, balsa, área de escape, radar, perigo, trecho perigoso da PRF, balança/praça/obra da ARTESP)
//   copiloto_route_restrictions   restrições que o caminhão não passa (altura, peso, comprimento, largura, hgv)
//   copiloto_route_snv            pista e pavimento oficiais (DNIT — SNV) para a "Via do trajeto"
// Tudo que a API marca como estimado continua marcado aqui: a tela e a voz dizem "estimado".
(function (raiz) {
  "use strict";

  // ------------------------------------------------------------ UFs
  const UFS = { AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal",
    ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais", PA: "Pará",
    PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RS: "Rio Grande do Sul",
    RO: "Rondônia", RR: "Roraima", SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins" };
  // como o motorista fala o estado (sem acento, minúsculas) → sigla; apelidos comuns incluídos
  const FALA_UF = { minas: "MG", "mato grosso": "MT", "mato grosso do sul": "MS", "rio grande do sul": "RS", "rio grande do norte": "RN",
    "rio de janeiro": "RJ", rio: "RJ", "sao paulo": "SP", "santa catarina": "SC", "espirito santo": "ES", "distrito federal": "DF", brasilia: "DF" };
  function semAcento(t) { return String(t == null ? "" : t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  for (const [s, n] of Object.entries(UFS)) FALA_UF[semAcento(n)] = s;
  function nomeUF(sigla) { return UFS[String(sigla || "").toUpperCase()] || String(sigla || ""); }
  // UF dita ou digitada ("Goiás", "GO", "Minas", "é Tocantins"); null sem UF. ufs (opcional): só aceita estas siglas.
  function ufDoTexto(texto, ufs) {
    const n = semAcento(texto).replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
    if (!n) return null;
    const aceita = (s) => !ufs || ufs.map((x) => String(x).toUpperCase()).includes(s);
    const nomes = Object.keys(FALA_UF).sort((a, b) => b.length - a.length);
    for (const nome of nomes) if (new RegExp("(^|\\s)" + nome + "(\\s|$)").test(n) && aceita(FALA_UF[nome])) return FALA_UF[nome];
    const sig = n.split(" ").find((p) => p.length === 2 && UFS[p.toUpperCase()] && aceita(p.toUpperCase()));
    return sig ? sig.toUpperCase() : null;
  }
  // "Goiás, Minas Gerais ou Tocantins"
  function ufsFaladas(ufs) {
    const nomes = (ufs || []).map((u) => nomeUF(typeof u === "string" ? u : u && u.uf));
    if (!nomes.length) return "";
    if (nomes.length === 1) return nomes[0];
    return nomes.slice(0, -1).join(", ") + " ou " + nomes[nomes.length - 1];
  }
  // A UF em que o motorista está primeiro (sugestão), o resto na ordem da API
  function ordenarUfs(lista, ufAtual) {
    const l = (lista || []).slice();
    if (!ufAtual) return l;
    const i = l.findIndex((x) => String(x && x.uf || x).toUpperCase() === String(ufAtual).toUpperCase());
    if (i > 0) l.unshift(l.splice(i, 1)[0]);
    return l;
  }

  // ------------------------------------------------------------ "BR-153 km 140": destino por km
  const SIGLAS_ROD = new Set(["BR"].concat(Object.keys(UFS)));
  const RE_ROD = /(^|[^a-z])(br|[a-z]{2})\s?-?\s?(\d{2,3})(?![\d])/;
  const RE_KM = /(^|[^a-z])(?:km|quilometro|quilometros|kilometro|kilometros)\s?-?\s?(\d{1,4}(?:[.,]\d{1,3})?)(?![\d])/;
  function normalizarRodovia(sigla, numero) {
    const s = String(sigla).toUpperCase();
    if (!SIGLAS_ROD.has(s)) return null;
    return s + "-" + String(parseInt(numero, 10)).padStart(3, "0");
  }
  // Devolve { rodovia: "BR-153", km: 140, uf: "GO" | null, texto } ou null quando não é "rodovia + km".
  // Entende "BR-153 km 140", "br 153 km 140", "km 140 da BR 153", "SP-330 km 26", "BR-060 km 12,5", "BR-153 km 140 GO"/"Goiás".
  function interpretarDestinoKm(texto) {
    const n = semAcento(texto).replace(/[^a-z0-9.,]+/g, " ").replace(/\s+/g, " ").trim();
    if (!n) return null;
    const mk = RE_KM.exec(n);
    if (!mk) return null;
    let rod = null, mr;
    const re = new RegExp(RE_ROD.source, "g");
    while ((mr = re.exec(n))) {
      const r = normalizarRodovia(mr[2], mr[3]);
      // "km 140" também casa com [a-z]{2}+dígitos? não: "km" exige 2 letras + número grudado; evita "km 140" virar rodovia KM-140
      if (r && mr[2] !== "km") { rod = r; break; }
    }
    if (!rod) return null;
    const km = parseFloat(mk[2].replace(",", "."));
    if (!isFinite(km) || km < 0 || km > 5000) return null;
    // UF: o que sobra depois de tirar a rodovia e o km
    const resto = n.replace(mr[0], " ").replace(mk[0], " ").replace(/\b(da|do|de|na|no|em|a|o|rodovia|estado|pela|pelo|ate|para|pra|pro)\b/g, " ");
    const uf = ufDoTexto(resto);
    return { rodovia: rod, km, uf, texto: rotuloKm(rod, km, uf) };
  }
  // Começo de rodovia sem km ("BR", "BR-1", "sp 33"): serve para o autocompletar com copiloto_km_highways.
  // Devolve o prefixo normalizado ("BR-1") ou null.
  function prefixoRodovia(texto) {
    const n = semAcento(texto).replace(/[^a-z0-9]+/g, " ").trim();
    if (!n || RE_KM.test(n) || /\d{4,}/.test(n)) return null;
    const m = /^(br|[a-z]{2})\s?(\d{0,3})$/.exec(n);
    if (!m || !SIGLAS_ROD.has(m[1].toUpperCase())) return null;
    return m[1].toUpperCase() + "-" + (m[2] || "");
  }
  function fmtKm(km) {
    if (typeof km !== "number" || !isFinite(km)) return "--";
    const d = Math.round(km * 10) / 10;
    return Number.isInteger(d) ? String(d) : d.toFixed(1).replace(".", ",");
  }
  function rotuloKm(rodovia, km, uf) { return rodovia + " km " + fmtKm(km) + (uf ? " (" + String(uf).toUpperCase() + ")" : ""); }
  function textoKmTela(rodovia, km) { return rodovia + " · km " + fmtKm(km); }
  // "BR-153, quilômetro 140, estimado" (a voz arredonda para o km inteiro)
  function falaKm(rodovia, km, estimado) {
    return rodovia.replace("-", " ") + ", quilômetro " + Math.round(km) + (estimado ? ", estimado" : "") + ".";
  }
  function falaSemKm() { return "Não sei em que quilômetro você está."; }
  // Aviso do ponto estimado (precisao_m > 200): "ponto estimado, precisão de ~500 m"
  function avisoPrecisao(precisaoM) {
    if (typeof precisaoM !== "number" || !isFinite(precisaoM) || precisaoM <= 200) return null;
    return "Ponto estimado, precisão de ~" + (precisaoM >= 1000 ? (Math.round(precisaoM / 100) / 10).toFixed(1).replace(".", ",") + " km" : Math.round(precisaoM / 10) * 10 + " m") + ".";
  }

  // ------------------------------------------------------------ "em que km estou": escolha entre SNV (oficial) e PRF/ARTESP (estimado)
  const KM_DIST_MAX_M = 300;
  // snv: resposta de copiloto_snv_km_at; kmAt: resposta de copiloto_km_at. Devolve { rodovia, uf, km, oficial, estimado,
  // distancia_m, fonte } ou null (nada a menos de maxM da rodovia).
  function escolherKm(snv, kmAt, maxM) {
    const lim = maxM || KM_DIST_MAX_M;
    if (snv && snv.encontrado && typeof snv.km === "number" && (typeof snv.distancia_m !== "number" || snv.distancia_m <= lim)) {
      const rod = snv.br != null ? "BR-" + String(snv.br).padStart(3, "0") : (snv.rodovia || null);
      if (rod) return { rodovia: rod, uf: snv.uf || null, km: Number(snv.km), oficial: true, estimado: false, distancia_m: snv.distancia_m == null ? null : Number(snv.distancia_m), fonte: snv.fonte || "DNIT — SNV" };
    }
    const c = kmAt && Array.isArray(kmAt.candidatos) ? kmAt.candidatos.find((x) => x && x.rodovia && typeof x.km === "number" && (typeof x.distancia_m !== "number" || x.distancia_m <= lim)) : null;
    if (!c) return null;
    return { rodovia: c.rodovia, uf: c.uf || null, km: Number(c.km), oficial: false, estimado: true, distancia_m: c.distancia_m == null ? null : Number(c.distancia_m), fonte: c.fonte || null };
  }
  // chave da posição arredondada (~100 m): mesma chave = mesma resposta
  function chavePosicao(lat, lon) { return (Math.round(lat * 1000) / 1000).toFixed(3) + "," + (Math.round(lon * 1000) / 1000).toFixed(3); }
  const KM_INTERVALO_MS = 30000, KM_DESLOC_M = 500;
  // Pedir de novo? ultimo: { t, lat, lon } do último pedido (null = nunca); agora (ms); pos: { lat, lon }.
  function devePedirKm(ultimo, agora, pos, o) {
    if (!pos || !isFinite(pos.lat) || !isFinite(pos.lon)) return false;
    if (!ultimo) return true;
    const ms = (o && o.intervaloMs) || KM_INTERVALO_MS, m = (o && o.deslocM) || KM_DESLOC_M;
    if (agora - ultimo.t >= ms) return true;
    return distanciaM(ultimo, pos) >= m;
  }

  // ------------------------------------------------------------ geometria
  const RAD = Math.PI / 180;
  function distanciaM(a, b) {
    const R = 6371008.8, dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // metros acumulados em cada ponto da rota (acum[0] = 0); coords: [[lon, lat], …]
  function acumuladoM(coords) {
    const a = new Float64Array(coords.length);
    for (let i = 1; i < coords.length; i++) a[i] = a[i - 1] + distanciaM({ lat: coords[i - 1][1], lon: coords[i - 1][0] }, { lat: coords[i][1], lon: coords[i][0] });
    return a;
  }
  // Metros desde a origem da rota do ponto pos ([lon, lat]) projetado no segmento "indice" (de CopilotoLimite.localizar).
  function progressoM(coords, acum, indice, pos) {
    if (indice == null || indice < 0 || indice >= coords.length - 1) return null;
    const a = coords[indice], b = coords[indice + 1];
    const kx = 111320 * Math.cos(pos[1] * RAD), ky = 110540;
    const ax = (a[0] - pos[0]) * kx, ay = (a[1] - pos[1]) * ky, bx = (b[0] - pos[0]) * kx, by = (b[1] - pos[1]) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    return acum[indice] + t * (acum[indice + 1] - acum[indice]);
  }
  // GeoJSON LineString da rota (Douglas-Peucker 10 m e no máximo maxPontos), como custos.js faz
  function rotaGeoJSON(coords, maxPontos) {
    const lim = maxPontos || 5000;
    let c = simplificar(coords, 10);
    if (c.length > lim) { const out = [], passo = (c.length - 1) / (lim - 1); for (let i = 0; i < lim; i++) out.push(c[Math.round(i * passo)]); c = out; }
    return { type: "LineString", coordinates: c.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]) };
  }
  function simplificar(coords, tolM) {
    if (!Array.isArray(coords) || coords.length < 3) return (coords || []).slice();
    const kx = 111320 * Math.cos(coords[0][1] * RAD), ky = 110540;
    const keep = new Uint8Array(coords.length); keep[0] = keep[coords.length - 1] = 1;
    const pilha = [[0, coords.length - 1]];
    while (pilha.length) {
      const [i0, i1] = pilha.pop();
      const a = coords[i0], b = coords[i1];
      const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky, l2 = dx * dx + dy * dy;
      let maxD = -1, maxI = -1;
      for (let i = i0 + 1; i < i1; i++) {
        const px = (coords[i][0] - a[0]) * kx, py = (coords[i][1] - a[1]) * ky;
        const t = l2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / l2)) : 0;
        const d = Math.hypot(px - t * dx, py - t * dy);
        if (d > maxD) { maxD = d; maxI = i; }
      }
      if (maxD > tolM && maxI > 0) { keep[maxI] = 1; pilha.push([i0, maxI], [maxI, i1]); }
    }
    return coords.filter((_, i) => keep[i]);
  }
  function chaveRota(coords) { // mesma forma de rota = mesma chave (como viaqualidade.chaveRota)
    let h = 0x811c9dc5;
    const mistura = (n) => { h ^= n & 0xffff; h = Math.imul(h, 16777619) >>> 0; h ^= (n >>> 16) & 0xffff; h = Math.imul(h, 16777619) >>> 0; };
    for (const [x, y] of coords || []) { mistura(Math.round(x * 1e5) | 0); mistura(Math.round(y * 1e5) | 0); }
    return "d" + (coords ? coords.length : 0) + "-" + h.toString(36);
  }

  // ------------------------------------------------------------ avisos à frente
  // prioridade: maior = mais importante (restrição > trecho perigoso crítico > balança > curva forte > passagem de nível > lombada > radar)
  const PRIORIDADE = { restricao: 100, perigoso3: 90, perigoso2: 80, balanca: 70, balsa: 65, curva: 60, passagem_nivel: 50, area_escape: 45,
    perigo: 42, obra: 40, lombada: 30, lombadas: 30, praca_pedagio: 20, radar: 10 };
  const TEXTO = {
    balanca: ["Balança à frente", "Balança à frente."], balsa: ["Balsa à frente", "Balsa à frente."],
    curva: ["Curva forte à frente", "Curva forte à frente."], passagem_nivel: ["Passagem de nível", "Passagem de nível à frente."],
    area_escape: ["Área de escape à frente", "Área de escape à frente."], perigo: ["Ponto de perigo à frente", "Atenção, ponto de perigo à frente."],
    lombada: ["Lombada", "Lombada à frente."], lombadas: ["Trecho com lombadas", "Trecho com lombadas."],
    radar: ["Radar", "Radar reportado à frente."], praca_pedagio: ["Praça de pedágio", "Praça de pedágio à frente."],
    obra: ["Obra recorrente", "Obra recorrente à frente."],
  };
  const KINDS_FEICOES = ["curva", "lombada", "balanca", "passagem_nivel", "balsa", "area_escape", "radar", "perigo"];
  function aviso(o) {
    return { id: o.id, tipo: o.tipo, prioridade: PRIORIDADE[o.chave || o.tipo] || 1, ao_longo_m: Math.round(o.ao_longo_m), lat: o.lat, lon: o.lon,
      texto: o.texto, fala: o.fala, detalhe: o.detalhe || null, fonte: o.fonte || null, estimado: o.estimado !== false };
  }
  // Linhas de copiloto_route_features → avisos (curva só "forte"; perigo só com descrição não é exigido)
  function avisosDeFeicoes(linhas) {
    const out = [];
    for (const f of Array.isArray(linhas) ? linhas : []) {
      if (!f || !KINDS_FEICOES.includes(f.kind) || typeof f.along_route_m !== "number") continue;
      const attrs = f.attrs || {};
      if (f.kind === "curva" && attrs.classe !== "forte") continue;
      const t = TEXTO[f.kind];
      const det = [f.name, f.road_ref, f.kind === "curva" && attrs.raio_m ? "raio ~" + Math.round(attrs.raio_m) + " m" : null].filter(Boolean).join(" · ");
      out.push(aviso({ id: "osm:" + f.id, tipo: f.kind, ao_longo_m: f.along_route_m, lat: f.lat, lon: f.lon, texto: t[0], fala: t[1], detalhe: det || null, fonte: f.attribution || "© OpenStreetMap contributors (ODbL)" }));
    }
    return out;
  }
  function textoDistanciaFalada(m) {
    if (m < 950) return Math.max(100, Math.round(m / 100) * 100) + " metros";
    const km = Math.round(m / 500) / 2;
    return (km === 1 ? "1 quilômetro" : String(km).replace(".", ",") + " quilômetros");
  }
  // copiloto_route_hot_spots → avisos (nível ≥ 2: alto e crítico)
  function avisosDeTrechos(resp) {
    const out = [];
    for (const t of resp && Array.isArray(resp.trechos) ? resp.trechos : []) {
      if (!t || typeof t.ao_longo_m !== "number" || !(t.nivel >= 2)) continue;
      const det = [t.rodovia, t.uf, t.km != null ? "km " + t.km : null, t.acidentes != null ? t.acidentes + " acidentes em 5 anos" : null, t.mortos ? t.mortos + " mortos" : null].filter(Boolean).join(" · ");
      out.push(aviso({ id: "prf:" + t.id, tipo: "perigoso", chave: t.nivel >= 3 ? "perigoso3" : "perigoso2", ao_longo_m: t.ao_longo_m, lat: t.lat, lon: t.lon,
        texto: "Trecho com muitos acidentes", fala: "Trecho com muitos acidentes", detalhe: det, fonte: resp.attribution || resp.fonte || null, nivel: t.nivel }));
      out[out.length - 1].nivel = t.nivel; out[out.length - 1].acidentes = t.acidentes;
    }
    return out;
  }
  // copiloto_route_artesp → avisos: balança e praça (ativos), obra recorrente (painéis)
  function avisosDeArtesp(resp) {
    const out = [];
    const fonte = resp && (resp.attribution || resp.fonte) || null;
    for (const a of resp && Array.isArray(resp.ativos) ? resp.ativos : []) {
      if (!a || typeof a.ao_longo_m !== "number" || !(a.tipo === "balanca" || a.tipo === "praca_pedagio")) continue;
      const t = TEXTO[a.tipo];
      out.push(aviso({ id: "artesp:" + a.id, tipo: a.tipo, ao_longo_m: a.ao_longo_m, lat: a.lat, lon: a.lon, texto: t[0], fala: t[1],
        detalhe: [a.rodovia, a.km != null ? "km " + a.km : null, a.nome, a.concessionaria].filter(Boolean).join(" · "), fonte }));
    }
    for (const o of resp && Array.isArray(resp.obras_pmv) ? resp.obras_pmv : []) {
      if (!o || typeof o.ao_longo_m !== "number") continue;
      out.push(aviso({ id: "artesp-obra:" + [o.rodovia, o.km_painel, o.sentido].join(":"), tipo: "obra", ao_longo_m: o.ao_longo_m, lat: o.lat, lon: o.lon,
        texto: TEXTO.obra[0], fala: TEXTO.obra[1], detalhe: [o.rodovia, o.km_painel != null ? "painel no km " + o.km_painel : null, o.ultima_mensagem].filter(Boolean).join(" · "), fonte }));
    }
    return out;
  }
  // Nome curto da restrição: "Ponte 4,2 m de altura", "Peso máx. 20 t", "Caminhão proibido"
  function textoRestricao(r) {
    const a = r && r.attrs || {};
    const partes = [];
    const ouInf = (v) => (num(v) == null ? Infinity : num(v));
    const alt = Math.min(ouInf(a.altura_max_m), ouInf(a.altura_fisica_m));
    const peso = Math.min(ouInf(a.peso_max_t), ouInf(a.peso_max_hgv_t));
    if (isFinite(alt)) partes.push("altura " + fmtNum(alt) + " m");
    if (isFinite(peso)) partes.push("peso " + fmtNum(peso) + " t");
    if (num(a.comprimento_max_m) != null) partes.push("comprimento " + fmtNum(a.comprimento_max_m) + " m");
    if (num(a.largura_max_m) != null) partes.push("largura " + fmtNum(a.largura_max_m) + " m");
    if (num(a.eixo_max_t) != null) partes.push("eixo " + fmtNum(a.eixo_max_t) + " t");
    if (a.hgv === "no") partes.push("caminhão proibido");
    const tipo = { ponte: "Ponte", tunel: "Túnel", balsa: "Balsa", restricao: "Restrição" }[r && r.kind] || "Restrição";
    const n = r && (r.nome || r.rodovia) ? String(r.nome || r.rodovia) : "";
    // "Ponte do Rio Verde" já diz que é ponte: não repete o tipo
    const cabeca = n && n.toLowerCase().startsWith(tipo.toLowerCase()) ? n : tipo + (n ? " " + n : "");
    return cabeca + (partes.length ? " · " + partes.join(" · ") : "");
  }
  function num(v) { const n = typeof v === "string" ? parseFloat(v) : v; return typeof n === "number" && isFinite(n) ? n : null; }
  function fmtNum(v) { return String(Math.round(Number(v) * 100) / 100).replace(".", ","); }
  // copiloto_route_restrictions → avisos (só as violadas: prioridade máxima)
  function avisosDeRestricoes(resp) {
    const out = [];
    for (const r of resp && Array.isArray(resp.restricoes) ? resp.restricoes : []) {
      if (!r || r.status !== "viola" || typeof r.ao_longo_m !== "number") continue;
      out.push(aviso({ id: "restr:" + r.id, tipo: "restricao", ao_longo_m: r.ao_longo_m, lat: r.lat, lon: r.lon,
        texto: "Restrição: " + textoRestricao(r), fala: "Atenção: " + textoRestricao(r).toLowerCase() + ". Seu caminhão não passa.", detalhe: (r.viola || []).join("; "), fonte: r.fonte || resp.attribution || null }));
    }
    return out;
  }
  const LOMBADAS_MUITAS = 10, LOMBADAS_JANELA_M = 2000, DEDUPE_M = 60;
  // Junta as listas, tira repetidos (mesmo tipo a < 60 m: fica o de maior prioridade), ordena pela posição na rota e,
  // onde há > 10 lombadas em 2 km (zona urbana), troca todas por um "Trecho com lombadas" no começo do trecho.
  function juntarAvisos(listas) {
    const todos = [].concat(...(listas || []).map((l) => l || [])).filter((a) => a && typeof a.ao_longo_m === "number");
    todos.sort((a, b) => a.ao_longo_m - b.ao_longo_m || b.prioridade - a.prioridade);
    const out = [];
    for (const a of todos) {
      const rep = out.find((b) => b.tipo === a.tipo && Math.abs(b.ao_longo_m - a.ao_longo_m) < DEDUPE_M);
      if (rep) { if (a.prioridade > rep.prioridade) Object.assign(rep, a); continue; }
      out.push(Object.assign({}, a));
    }
    // lombadas em série
    const lomb = out.filter((a) => a.tipo === "lombada");
    const tirar = new Set();
    for (let i = 0; i < lomb.length; i++) {
      if (tirar.has(lomb[i].id)) continue;
      let j = i;
      while (j + 1 < lomb.length && lomb[j + 1].ao_longo_m - lomb[i].ao_longo_m <= LOMBADAS_JANELA_M) j++;
      if (j - i + 1 > LOMBADAS_MUITAS) {
        // estende até o fim da série (lombadas seguidas a menos de 2 km da anterior)
        while (j + 1 < lomb.length && lomb[j + 1].ao_longo_m - lomb[j].ao_longo_m <= LOMBADAS_JANELA_M) j++;
        const grupo = lomb.slice(i, j + 1);
        for (const g of grupo) tirar.add(g.id);
        const t = TEXTO.lombadas;
        out.push(aviso({ id: "lombadas:" + grupo[0].ao_longo_m, tipo: "lombadas", ao_longo_m: grupo[0].ao_longo_m, lat: grupo[0].lat, lon: grupo[0].lon,
          texto: t[0] + " (" + grupo.length + ")", fala: t[1], detalhe: grupo.length + " lombadas em " + Math.round((grupo[j - i].ao_longo_m - grupo[0].ao_longo_m) / 100) / 10 + " km", fonte: grupo[0].fonte }));
        i = j;
      }
    }
    const fim = out.filter((a) => !tirar.has(a.id));
    fim.sort((a, b) => a.ao_longo_m - b.ao_longo_m || b.prioridade - a.prioridade);
    return fim;
  }
  // Contagens para o modo Avançado: "3 curvas fortes · 2 trechos perigosos · 1 balança"
  function contagens(avisos) {
    const c = { curva: 0, perigoso: 0, balanca: 0, lombada: 0, passagem_nivel: 0, radar: 0, restricao: 0, balsa: 0, obra: 0 };
    for (const a of avisos || []) { if (a.tipo === "lombadas") c.lombada += 1; else if (c[a.tipo] != null) c[a.tipo]++; }
    return c;
  }
  function textoContagens(c) {
    const p = [];
    const pl = (n, s, pp) => n + " " + (n === 1 ? s : pp);
    if (c.restricao) p.push(pl(c.restricao, "restrição", "restrições"));
    if (c.curva) p.push(pl(c.curva, "curva forte", "curvas fortes"));
    if (c.perigoso) p.push(pl(c.perigoso, "trecho perigoso", "trechos perigosos"));
    if (c.balanca) p.push(pl(c.balanca, "balança", "balanças"));
    if (c.passagem_nivel) p.push(pl(c.passagem_nivel, "passagem de nível", "passagens de nível"));
    if (c.lombada) p.push(pl(c.lombada, "lombada", "lombadas"));
    if (c.balsa) p.push(pl(c.balsa, "balsa", "balsas"));
    if (c.obra) p.push(pl(c.obra, "obra recorrente", "obras recorrentes"));
    if (c.radar) p.push(pl(c.radar, "radar", "radares"));
    return p.join(" · ");
  }

  // Antecedência do aviso pela velocidade: ~27 s de estrada (600 m a 80 km/h), entre 250 m e 1.200 m.
  const ANTECEDENCIA_S = 27, ANTECEDENCIA_MIN_M = 250, ANTECEDENCIA_MAX_M = 1200;
  function antecedenciaM(kmh) {
    const v = typeof kmh === "number" && isFinite(kmh) && kmh > 0 ? kmh : 0;
    return Math.round(Math.min(ANTECEDENCIA_MAX_M, Math.max(ANTECEDENCIA_MIN_M, v / 3.6 * ANTECEDENCIA_S)));
  }
  const FALA_INTERVALO_MS = 20000, PASSOU_M = 40;
  // Estado dos avisos de uma rota. atualizar({ progressoM, kmh, agora }) → { falar: aviso | null, mostrar: aviso | null,
  // distanciaM } — um aviso por feição, nunca repetido; no máximo 1 fala a cada 20 s (o que esperou e já ficou para trás
  // não é falado); entre vários no alcance, o de maior prioridade primeiro (depois o mais perto).
  function criarAvisador(lista, o) {
    const op = o || {};
    const avisos = (lista || []).slice().sort((a, b) => a.ao_longo_m - b.ao_longo_m);
    const feitos = op.feitos instanceof Set ? op.feitos : new Set(); let ultimaFala = typeof op.ultimaFala === "number" ? op.ultimaFala : -Infinity, ultimoProgresso = null;
    function atualizar(e) {
      const agora = typeof e.agora === "number" ? e.agora : Date.now();
      const p = e.progressoM;
      if (typeof p !== "number" || !isFinite(p)) return { falar: null, mostrar: null, distanciaM: null };
      // recuou muito (recálculo com outra rota): quem chama cria outro avisador; aqui só não "passa" nada para trás
      ultimoProgresso = p;
      const ant = antecedenciaM(e.kmh);
      const cand = [];
      for (const a of avisos) {
        if (feitos.has(a.id)) continue;
        const d = a.ao_longo_m - p;
        if (d < -PASSOU_M) { feitos.add(a.id); continue; } // ficou para trás sem ser falado (fila cheia): não fala
        if (d > ant) break;
        if (a.minKmh && typeof e.kmh === "number" && e.kmh < a.minKmh) continue; // ex.: curva só acima de 50 km/h (r5)
        cand.push({ a, d });
      }
      if (!cand.length) return { falar: null, mostrar: null, distanciaM: null };
      cand.sort((x, y) => (x.a.semVoz ? 1 : 0) - (y.a.semVoz ? 1 : 0) || y.a.prioridade - x.a.prioridade || x.d - y.d); // r5: o que é só de tela (semVoz) vem depois
      const esc = cand[0];
      if (esc.a.semVoz) { feitos.add(esc.a.id); return { falar: null, mostrar: esc.a, distanciaM: Math.max(0, esc.d) }; } // só na tela
      if (agora - ultimaFala < (op.intervaloMs || FALA_INTERVALO_MS)) return { falar: null, mostrar: esc.a, distanciaM: Math.max(0, esc.d), esperando: true };
      feitos.add(esc.a.id); ultimaFala = agora;
      return { falar: esc.a, mostrar: esc.a, distanciaM: Math.max(0, esc.d) };
    }
    return { atualizar, feitos: () => feitos.size, feitosSet: () => feitos, ultimaFala: () => ultimaFala, total: () => avisos.length, progresso: () => ultimoProgresso };
  }
  // Fala do aviso com a distância quando vale a pena ("Trecho com muitos acidentes, 800 metros")
  function falaAviso(a, distM) {
    if (!a) return "";
    if (a.agrupado) return a.fala;                                    // r5: "Trecho crítico, próximos 8 quilômetros."
    if (a.tipo === "curva" && a.estimado !== false && a.minKmh) return "Pode haver curva forte à frente."; // r5: dado heurístico
    if (a.tipo === "perigoso" && typeof distM === "number" && distM >= 150) return a.fala + ", " + textoDistanciaFalada(distM) + ".";
    return a.fala;
  }

  // ------------------------------------------------------------ Via do trajeto: SNV × heurística
  const SNV_COBERTURA_MIN = 0.5;
  // Usa o SNV quando cobre mais da metade da rota. Devolve null (fica a heurística) ou { kmDupla, kmSimples, kmPistaDesc,
  // kmPav, kmNaoPav, kmPavDesc, coberturaM, coberturaPct, semSnvM, versao, fonte }.
  function usarSnv(snv, distanciaRotaM) {
    if (!snv || typeof snv.cobertura_snv_m !== "number") return null;
    const total = typeof distanciaRotaM === "number" && distanciaRotaM > 0 ? distanciaRotaM : snv.distancia_m;
    if (!(total > 0) || snv.cobertura_snv_m / total <= SNV_COBERTURA_MIN) return null;
    const p = snv.pista || {}, v = snv.pavimento || {};
    const km = (m) => Math.round((Number(m) || 0) / 100) / 10;
    return { kmDupla: km(p.dupla_m), kmSimples: km(p.simples_m), kmPistaDesc: km(p.desconhecida_m), kmPav: km(v.pavimentada_m), kmNaoPav: km(v.nao_pavimentada_m),
      kmPavDesc: km(v.desconhecida_m), coberturaM: snv.cobertura_snv_m, coberturaPct: Math.round(snv.cobertura_snv_m / total * 100), semSnvM: Math.max(0, total - snv.cobertura_snv_m),
      versao: snv.versao_snv || null, fonte: snv.fonte || "DNIT — SNV", trechos: Array.isArray(snv.trechos) ? snv.trechos : [] };
  }
  function fmtKmLongo(km) { return km < 10 ? km.toFixed(1).replace(".", ",") + " km" : Math.round(km).toLocaleString("pt-BR") + " km"; }
  // "Pista dupla 120 km · simples 80 km · sem pavimento 3 km (DNIT — SNV, 92 % da rota)"
  function textoPistaSnv(s) {
    if (!s) return "";
    const p = [];
    if (s.kmDupla >= 0.5) p.push("Pista dupla " + fmtKmLongo(s.kmDupla));
    if (s.kmSimples >= 0.5) p.push((p.length ? "simples " : "Pista simples ") + fmtKmLongo(s.kmSimples));
    if (s.kmNaoPav >= 0.5) p.push("sem pavimento " + fmtKmLongo(s.kmNaoPav));
    return p.join(" · ");
  }
  function textoFonteSnv(s) { return s ? "DNIT — SNV" + (s.versao ? " " + s.versao : "") + " · " + s.coberturaPct + "% da rota" + (s.semSnvM > 500 ? "; o resto pelo OpenStreetMap" : "") : ""; }

  // ------------------------------------------------------------ restrições: parâmetros e resumo
  // perfil do veículo → parâmetros da RPC (só números dentro da faixa da API; o resto vai null = "não informado")
  // carga por eixo: eixoT se existir, senão a média PBTC ÷ eixos (mesma conta de rota.js cargaPorEixoT; estimativa)
  function cargaPorEixoT(p) {
    const num = (v) => typeof v === "number" && isFinite(v);
    if (num(p.eixoT) && p.eixoT > 0) return p.eixoT;
    return num(p.pbtc) && num(p.eixos) && p.eixos >= 2 && p.pbtc > 0 ? Math.round(p.pbtc / p.eixos * 10) / 10 : null;
  }
  function paramsRestricoes(coords, perfil) {
    const p = perfil || {};
    const faixa = (v, lo, hi) => (typeof v === "number" && isFinite(v) && v >= lo && v <= hi ? v : null);
    return { p_route: rotaGeoJSON(coords), p_height_m: faixa(p.altura, 1, 6), p_weight_t: faixa(p.pbtc, 0.5, 200), p_length_m: faixa(p.comprimento, 3, 40),
      p_width_m: faixa(p.largura, 1, 4), p_axle_t: faixa(cargaPorEixoT(p), 0.5, 30) };
  }
  function dimensoesFaltando(perfil) {
    const p = perfil || {};
    const falta = [];
    if (!(typeof p.altura === "number" && isFinite(p.altura))) falta.push("altura");
    if (!(typeof p.pbtc === "number" && isFinite(p.pbtc))) falta.push("peso");
    return falta;
  }
  function resumoRestricoes(resp) {
    const r = resp || {};
    const lista = Array.isArray(r.restricoes) ? r.restricoes : [];
    return { violadas: lista.filter((x) => x.status === "viola"), condicionais: lista.filter((x) => x.status === "condicional"),
      desconhecidas: lista.filter((x) => x.status === "desconhecido"), total: lista.length, fonte: r.attribution || null, estimado: r.estimado !== false };
  }
  function tituloRestricoes(n) { return "Esta rota tem " + n + (n === 1 ? " restrição que seu caminhão não passa" : " restrições que seu caminhão não passa"); }
  function fmtDistRota(m) { return m < 1000 ? Math.round(m / 10) * 10 + " m" : m < 10000 ? (Math.round(m / 100) / 10).toFixed(1).replace(".", ",") + " km" : Math.round(m / 1000) + " km"; }

  // ------------------------------------------------------------ guardar (avisos das 3 últimas rotas, para navegar sem internet)
  const CHAVE_DADOS = "copiloto.dados.v1", MAX_GUARDADAS = 3;
  function lerGuardados(storage) {
    try { const b = storage && storage.getItem(CHAVE_DADOS); const j = b ? JSON.parse(b) : null; return j && Array.isArray(j.rotas) ? j : { rotas: [] }; }
    catch (e) { return { rotas: [] }; }
  }
  function buscarGuardado(storage, chave) {
    const g = lerGuardados(storage).rotas.find((x) => x && x.chave === chave);
    return g && Array.isArray(g.avisos) ? g : null;
  }
  function guardar(storage, reg) {
    if (!storage || !reg || !reg.chave) return false;
    const rotas = [reg].concat(lerGuardados(storage).rotas.filter((r) => r && r.chave !== reg.chave)).slice(0, MAX_GUARDADAS);
    for (const lista of [rotas, rotas.slice(0, 1)]) {
      try { storage.setItem(CHAVE_DADOS, JSON.stringify({ versao: 1, rotas: lista })); return true; } catch (e) { /* cheio */ }
    }
    return false;
  }

  const api = { CHAVE_DADOS, lerGuardados, buscarGuardado, guardar, UFS, nomeUF, ufDoTexto, ufsFaladas, ordenarUfs, interpretarDestinoKm, prefixoRodovia, rotuloKm, textoKmTela, falaKm, falaSemKm, avisoPrecisao, fmtKm,
    escolherKm, chavePosicao, devePedirKm, KM_INTERVALO_MS, KM_DESLOC_M, KM_DIST_MAX_M,
    distanciaM, acumuladoM, progressoM, rotaGeoJSON, simplificar, chaveRota,
    PRIORIDADE, KINDS_FEICOES, avisosDeFeicoes, avisosDeTrechos, avisosDeArtesp, avisosDeRestricoes, textoRestricao, juntarAvisos, contagens, textoContagens,
    antecedenciaM, criarAvisador, falaAviso, textoDistanciaFalada, FALA_INTERVALO_MS,
    usarSnv, textoPistaSnv, textoFonteSnv, SNV_COBERTURA_MIN, paramsRestricoes, dimensoesFaltando, resumoRestricoes, tituloRestricoes, fmtDistRota };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoDados = api;
})(typeof window !== "undefined" ? window : globalThis);
