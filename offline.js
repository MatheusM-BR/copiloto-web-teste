// Offline (pacote E3): lógica pura, sem DOM. Usada pela página (ui/offline.js), pelo service worker (sw.js,
// via importScripts) e pelos testes no Node (tests/offline.test.js).
//  - blocos (tiles) do corredor da rota, estimativa de tamanho e redução de zoom quando fica grande demais
//  - chave de cache dos blocos da OpenFreeMap (independente da versão do mapa no endereço)
//  - poda do cache por limite de itens e de bytes (sai o mais antigo)
//  - textos: idade dos dados, hora, tamanho, linha de estado ("Sem internet · relatos de há 40 min · …")
(function (raiz) {
  "use strict";

  const HOST_MAPA = "tiles.openfreemap.org";
  // Tamanho médio estimado de um bloco vetorial da OpenFreeMap por zoom (bytes). Estimativa conservadora:
  // o tamanho real depende da região (cidade pesa mais que estrada no campo) e aparece depois de baixar.
  const BYTES_POR_ZOOM = { 0: 200e3, 1: 200e3, 2: 200e3, 3: 200e3, 4: 200e3, 5: 200e3, 6: 180e3, 7: 150e3,
    8: 120e3, 9: 90e3, 10: 70e3, 11: 50e3, 12: 40e3, 13: 30e3, 14: 25e3 };
  const PADRAO_CORREDOR = { larguraM: 2000, zMin: 8, zMax: 14, zVisaoMin: 5, limiteBlocos: 6000, zMaxMinimo: 11 };

  // ------------------------------------------------------------ blocos (esquema XYZ, Web Mercator)
  function lonParaX(lon, z) { return Math.floor(((lon + 180) / 360) * Math.pow(2, z)); }
  function latParaY(lat, z) {
    const l = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
    return Math.floor(((1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2) * Math.pow(2, z));
  }
  function limitar(v, z) { const n = Math.pow(2, z) - 1; return Math.max(0, Math.min(n, v)); }

  function adicionarCaixa(conj, z, oeste, sul, leste, norte) {
    const x0 = limitar(lonParaX(oeste, z), z), x1 = limitar(lonParaX(leste, z), z);
    const y0 = limitar(latParaY(norte, z), z), y1 = limitar(latParaY(sul, z), z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) conj.add(z + "/" + x + "/" + y);
  }

  // Pontos ao longo da linha com no máximo passoM metros entre eles.
  function adensar(coords, passoM) {
    const out = [];
    for (let i = 0; i < coords.length; i++) {
      const a = coords[i];
      out.push(a);
      const b = coords[i + 1]; if (!b) break;
      const d = distanciaM(a, b);
      const n = Math.floor(d / passoM);
      for (let k = 1; k <= n; k++) { const f = k / (n + 1); out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); }
    }
    return out;
  }
  function distanciaM(a, b) { // [lon, lat]
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function coordsValidas(coords) {
    return (Array.isArray(coords) ? coords : []).filter((c) => Array.isArray(c) && isFinite(c[0]) && isFinite(c[1]) && Math.abs(c[1]) <= 90 && Math.abs(c[0]) <= 180);
  }

  // Blocos que cobrem a faixa de larguraM em volta da linha (metade para cada lado), de zMin a zMax,
  // mais a visão geral (caixa da rota inteira) de zVisaoMin até zMin-1. Ordem: zoom menor primeiro.
  function blocosDoCorredor(coords, opcoes) {
    const o = Object.assign({}, PADRAO_CORREDOR, opcoes);
    const pts = coordsValidas(coords);
    if (!pts.length) return [];
    const meia = o.larguraM / 2;
    const conj = new Set();
    let oeste = 180, leste = -180, sul = 90, norte = -90;
    for (const [lon, lat] of pts) { oeste = Math.min(oeste, lon); leste = Math.max(leste, lon); sul = Math.min(sul, lat); norte = Math.max(norte, lat); }
    for (let z = o.zVisaoMin; z < o.zMin; z++) adicionarCaixa(conj, z, oeste, sul, leste, norte);
    const densos = adensar(pts, meia); // amostras a cada ≤ meia largura: os quadrados se sobrepõem e cobrem a faixa
    for (let z = o.zMin; z <= o.zMax; z++) {
      for (const [lon, lat] of densos) {
        const dLat = meia / 111320, dLon = dLat / Math.max(0.01, Math.cos(lat * Math.PI / 180));
        adicionarCaixa(conj, z, lon - dLon, lat - dLat, lon + dLon, lat + dLat);
      }
    }
    return Array.from(conj, (k) => { const [z, x, y] = k.split("/").map(Number); return { z, x, y }; })
      .sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
  }

  function estimarBytes(blocos) {
    let t = 0;
    for (const b of blocos) t += BYTES_POR_ZOOM[Math.min(14, b.z)] || 25e3;
    return t;
  }

  // Plano do download: se passar do limite de blocos, baixa o zoom máximo (até zMaxMinimo) e avisa.
  function planejarCorredor(coords, opcoes) {
    const o = Object.assign({}, PADRAO_CORREDOR, opcoes);
    let zMax = o.zMax, blocos = blocosDoCorredor(coords, Object.assign({}, o, { zMax }));
    while (blocos.length > o.limiteBlocos && zMax > o.zMaxMinimo) {
      zMax--;
      blocos = blocosDoCorredor(coords, Object.assign({}, o, { zMax }));
    }
    return { blocos, total: blocos.length, bytes: estimarBytes(blocos), zMax, zMaxPedido: o.zMax, reduzido: zMax < o.zMax,
      acimaDoLimite: blocos.length > o.limiteBlocos, larguraM: o.larguraM };
  }

  // ------------------------------------------------------------ endereços do mapa
  // Bloco vetorial: https://tiles.openfreemap.org/<conjunto>/<versão>/<z>/<x>/<y>.pbf
  const RE_BLOCO = /^https:\/\/tiles\.openfreemap\.org\/[^/?#]+\/[^/?#]+\/(\d+)\/(\d+)\/(\d+)\.pbf(?:[?#].*)?$/;
  // Chave do cache sem a versão: o mapa guardado continua servindo quando a OpenFreeMap publica versão nova.
  function chaveBloco(url) {
    const m = RE_BLOCO.exec(String(url));
    return m ? "https://" + HOST_MAPA + "/__copiloto_bloco/" + m[1] + "/" + m[2] + "/" + m[3] + ".pbf" : null;
  }
  function urlBloco(modelo, b) {
    return String(modelo).replace("{z}", b.z).replace("{x}", b.x).replace("{y}", b.y);
  }
  // "bloco" (tile vetorial), "estilo" (estilo e TileJSON: mudam), "recurso" (fontes e sprites) ou null
  function classificarUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.hostname !== HOST_MAPA) return null;
    if (RE_BLOCO.test(url)) return "bloco";
    if (/^\/(fonts|sprites)\//.test(u.pathname)) return "recurso";
    return "estilo";
  }

  // Endereços de fontes (glifos) e sprites usados por um estilo do MapLibre, para baixar junto com o corredor.
  // Faixas 0-255 e 256-511 cobrem o português (acentos e ç); 8192-8447 tem travessões e aspas.
  function recursosDoEstilo(estilo, urlEstilo) {
    const out = new Set();
    if (!estilo || typeof estilo !== "object") return [];
    const base = urlEstilo || "https://" + HOST_MAPA + "/";
    const abs = (u) => { try { return new URL(u, base).href; } catch (e) { return null; } };
    const sprites = Array.isArray(estilo.sprite) ? estilo.sprite.map((s) => s && s.url) : [estilo.sprite];
    for (const s of sprites) {
      if (!s || typeof s !== "string") continue;
      for (const suf of [".json", ".png", "@2x.json", "@2x.png"]) { const u = abs(s + suf); if (u) out.add(u); }
    }
    if (typeof estilo.glyphs === "string") {
      const pilhas = new Set();
      for (const c of estilo.layers || []) {
        const f = c && c.layout && c.layout["text-font"];
        if (Array.isArray(f) && f.every((x) => typeof x === "string")) pilhas.add(f.join(","));
        else if (Array.isArray(f)) coletarLiterais(f, pilhas);
      }
      for (const p of pilhas) for (const faixa of ["0-255", "256-511", "8192-8447"]) {
        const u = abs(estilo.glyphs.replace("{fontstack}", p).replace("{range}", faixa));
        if (u) out.add(u);
      }
    }
    return Array.from(out);
  }
  // text-font como expressão: procura ["literal", ["Fonte A", "Fonte B"]]
  function coletarLiterais(expr, pilhas) {
    if (!Array.isArray(expr)) return;
    if (expr[0] === "literal" && Array.isArray(expr[1]) && expr[1].every((x) => typeof x === "string")) { pilhas.add(expr[1].join(",")); return; }
    for (const x of expr) coletarLiterais(x, pilhas);
  }

  // ------------------------------------------------------------ poda do cache
  // entradas em ordem de chegada (mais antiga primeiro): [{ chave, bytes }]. Devolve as chaves a remover
  // para ficar dentro de maxItens e de maxBytes (bytes desconhecido conta como bytesPadrao).
  function podar(entradas, limites) {
    const l = Object.assign({ maxItens: Infinity, maxBytes: Infinity, bytesPadrao: 30e3 }, limites);
    const lista = Array.isArray(entradas) ? entradas : [];
    const tam = (e) => (isFinite(e.bytes) && e.bytes >= 0 ? Number(e.bytes) : l.bytesPadrao);
    let itens = lista.length, bytes = 0;
    for (const e of lista) bytes += tam(e);
    const remover = [];
    for (const e of lista) {
      if (itens <= l.maxItens && bytes <= l.maxBytes) break;
      remover.push(e.chave); itens--; bytes -= tam(e);
    }
    return remover;
  }

  // Espaço: navigator.storage.estimate() → { quota, usage }. Margem de 10% da cota para o resto do app.
  function cabeNoAparelho(estimativa, bytes) {
    if (!estimativa || !isFinite(estimativa.quota) || !isFinite(estimativa.usage)) return { sabe: false, cabe: true, livre: null };
    const livre = Math.max(0, estimativa.quota * 0.9 - estimativa.usage);
    return { sabe: true, cabe: bytes <= livre, livre };
  }

  // ------------------------------------------------------------ textos
  function formatarNumero(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "."); }
  function formatarBytes(b) {
    if (!isFinite(b) || b < 0) return "tamanho desconhecido";
    if (b < 1e6) return Math.max(1, Math.round(b / 1e3)) + " KB";
    if (b < 1e9) return formatarNumero(b / 1e6) + " MB";
    return (Math.round(b / 1e8) / 10).toString().replace(".", ",") + " GB";
  }
  // Idade a partir de milissegundos: "agora", "há 1 min", "há 25 min", "há 2 h", "há 2 h 5 min", "há 3 dias"
  function formatarIdade(ms) {
    if (!isFinite(ms)) return "há tempo desconhecido";
    const min = Math.floor(Math.max(0, ms) / 60000);
    if (min < 1) return "agora";
    if (min < 60) return "há " + min + " min";
    const h = Math.floor(min / 60), resto = min % 60;
    if (h < 24) return "há " + h + " h" + (resto && h < 6 ? " " + resto + " min" : "");
    const d = Math.floor(h / 24);
    return "há " + d + (d === 1 ? " dia" : " dias");
  }
  const dois = (n) => String(n).padStart(2, "0");
  // "14:10" se for hoje; "30/10 às 14:10" se for outro dia (hora local do aparelho)
  function formatarHora(ts, agora) {
    const d = new Date(ts), h = new Date(agora == null ? Date.now() : agora);
    const hhmm = dois(d.getHours()) + ":" + dois(d.getMinutes());
    const mesmoDia = d.getFullYear() === h.getFullYear() && d.getMonth() === h.getMonth() && d.getDate() === h.getDate();
    return mesmoDia ? hhmm : dois(d.getDate()) + "/" + dois(d.getMonth() + 1) + " às " + hhmm;
  }

  // Linha de estado. e = { online, agora, logado, relatosEm (ms|null), rota (bool), mapa: { em, completo, pct } | null,
  // baixando: pct | null }. Ex.: "Sem internet · relatos de há 40 min · mapa da rota baixado às 14:10"
  function textoEstado(e) {
    const agora = e.agora == null ? Date.now() : e.agora;
    const partes = [e.online ? "Online" : "Sem internet"];
    if (e.relatosEm != null && isFinite(e.relatosEm)) {
      const idade = agora - e.relatosEm;
      if (!e.online || idade >= 5 * 60000) partes.push("relatos de " + formatarIdade(idade));
    } else if (e.logado && !e.online) partes.push("sem relatos guardados");
    if (e.baixando != null) partes.push("baixando mapa " + Math.round(e.baixando) + "%");
    else if (e.mapa && e.mapa.completo) partes.push("mapa da rota baixado " + (mesmoDiaDe(e.mapa.em, agora) ? "às " : "em ") + formatarHora(e.mapa.em, agora));
    else if (e.mapa && e.mapa.pct > 0) partes.push("mapa da rota baixado em parte (" + Math.round(e.mapa.pct) + "%)");
    else if (e.rota && !e.online) partes.push("mapa da rota não baixado");
    return partes.join(" · ");
  }
  function mesmoDiaDe(ts, agora) { return formatarHora(ts, agora).indexOf("/") < 0; }

  // O que para de funcionar sem internet (PER-02: nada é desligado em silêncio)
  const SEM_INTERNET = [
    "Rota nova: precisa de internet. A rota guardada continua no mapa.",
    "Relatos novos de outros motoristas: só chegam com internet. Os guardados aparecem com a idade.",
    "Entrar na conta ou criar conta: precisa de internet.",
    "Relato que você mandar fica guardado no aparelho e sai quando a internet voltar (se ainda estiver valendo).",
    "Mapa: só aparece onde já foi visto ou baixado.",
  ];

  // Lista de arquivos do esqueleto do app a partir do index.html (src e href relativos).
  function arquivosDoIndex(html) {
    const out = new Set();
    const re = /\b(?:src|href)\s*=\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(String(html)))) {
      const u = m[1].trim();
      if (!u || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u)) continue; // externo, data:, âncora
      out.add(u.split("#")[0]);
    }
    return Array.from(out);
  }

  // Estilos que os módulos carregam depois (Copiloto.carregarEstilo("estilos/x.css")): entram no esqueleto também.
  function estilosCarregados(js) {
    const out = new Set(), re = /carregarEstilo\(\s*["']([^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(String(js)))) if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(m[1])) out.add(m[1]);
    return Array.from(out);
  }

  // ------------------------------------------------------------ rota guardada (M5): compacta no aparelho
  // O que vai para o localStorage é a resposta do Valhalla (o desenho vem como polyline codificada, bem menor) e o resumo;
  // as coordenadas decodificadas ficam só na memória. Rota longa (1.500 km) cabe com folga.
  function shapesDaResposta(resposta) {
    const legs = resposta && resposta.trip && Array.isArray(resposta.trip.legs) ? resposta.trip.legs : null;
    if (!legs || !legs.length || !legs.every((l) => l && typeof l.shape === "string" && l.shape.length)) return null;
    return legs.map((l) => l.shape);
  }
  // Objeto a gravar: sem `coords` quando a resposta traz o desenho. nivel "leve" = só o desenho e o resumo, sem as manobras
  // (para quando falta espaço).
  function rotaParaGuardar(r, nivel) {
    const o = Object.assign({}, r);
    const shapes = shapesDaResposta(r.resposta);
    if (!shapes) { if (nivel === "leve") o.resposta = null; return o; }
    delete o.coords;
    if (nivel === "leve") {
      const t = r.resposta.trip;
      o.resposta = { trip: { status: t.status, summary: t.summary, legs: shapes.map((shape) => ({ shape })) } };
      o.semManobras = true;
    }
    return o;
  }
  // Volta a rota guardada para o formato de uso (com `coords`). decodificar: polyline6 → [[lon, lat], …]. Inválida → null.
  function rotaDeGuardada(o, decodificar) {
    if (!o || typeof o !== "object") return null;
    if (Array.isArray(o.coords) && o.coords.length >= 2) return o;
    const shapes = shapesDaResposta(o.resposta);
    if (!shapes || typeof decodificar !== "function") return null;
    const coords = [];
    try { for (const s of shapes) for (const c of decodificar(s)) coords.push(c); } catch (e) { return null; }
    if (coords.length < 2) return null;
    return Object.assign({}, o, { coords });
  }
  // Mesma rota (não precisa regravar): mesmo destino, mesmo veículo e o mesmo desenho.
  function mesmaRota(a, b) {
    if (!a || !b) return false;
    const sa = shapesDaResposta(a.resposta), sb = shapesDaResposta(b.resposta);
    const d = (x) => (x && x.destino ? x.destino.lat + "," + x.destino.lon : "");
    if (d(a) !== d(b) || (a.perfilNome || null) !== (b.perfilNome || null)) return false;
    if (sa && sb) return sa.length === sb.length && sa.every((s, i) => s === sb[i]);
    return false;
  }

  // ------------------------------------------------------------ última rota (chegada): fica guardada por 30 dias
  // A chegada não apaga a rota guardada nem o mapa do corredor: ela vira "última rota" (r.ultima = { chegouEm, sentido,
  // voltarPara, … }) para o motorista sair da fazenda e voltar pela mesma rota sem internet. Vale ULTIMA_VALIDADE_MS.
  const ULTIMA_VALIDADE_MS = 30 * 24 * 3600 * 1000;
  function ultimaValida(r, agora) {
    const u = r && r.ultima;
    if (!u || typeof u.chegouEm !== "number" || !isFinite(u.chegouEm)) return false;
    const idade = (agora == null ? Date.now() : agora) - u.chegouEm;
    return idade >= -60000 && idade <= ULTIMA_VALIDADE_MS;
  }
  function ultimaValidaAte(r) { return r && r.ultima && isFinite(r.ultima.chegouEm) ? r.ultima.chegouEm + ULTIMA_VALIDADE_MS : null; }

  const api = {
    ULTIMA_VALIDADE_MS, ultimaValida, ultimaValidaAte,
    rotaParaGuardar, rotaDeGuardada, mesmaRota,
    BYTES_POR_ZOOM, PADRAO_CORREDOR, HOST_MAPA, SEM_INTERNET,
    lonParaX, latParaY, distanciaM, blocosDoCorredor, estimarBytes, planejarCorredor,
    chaveBloco, urlBloco, classificarUrl, recursosDoEstilo, podar, cabeNoAparelho,
    formatarNumero, formatarBytes, formatarIdade, formatarHora, textoEstado, arquivosDoIndex, estilosCarregados,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoOffline = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis);
