// Vozes gravadas do Copiloto (clipes de áudio das frases fixas). Lógica pura + tocador; sem DOM. Testado em tests/vozclipes.test.js.
//
// Ideia: as frases FIXAS do app (alertas, descanso, navegação, confirmações…) são geradas uma vez no ElevenLabs
// (ferramentas/gerar-vozes.ps1 ou .mjs), guardadas em web-teste/voz/<voz>/ e tocadas como arquivo. Frase sem clipe
// (nome de rua, cidade, posto, número fora do catálogo…) continua na voz do aparelho, de forma transparente.
// Custo por uso zero e funciona sem internet (service worker guarda os mp3).
//
// Arquivos:
//   voz/vozes.json               índice: { versao, vozes: [{ id, nome }] }   (vazio = só a voz do aparelho)
//   voz/catalogo.json            frases do catálogo (gerado por ferramentas/gerar-catalogo.mjs)
//   voz/<voz>/manifest.json      { perfil, voiceId, modelo, geradoEm, versao, clipes: { <id>: { arquivo, bytes, texto } } }
//   voz/<voz>/<id>.mp3
//
// id do clipe = hash curto (FNV-1a 32 bits sobre o UTF-8, 8 dígitos hexa) do texto NORMALIZADO (NFC, espaços colapsados,
// sem espaço nas pontas; maiúsculas e pontuação contam: mudam a entonação). O app e o gerador usam esta mesma função.
//
// Composição por pedaços (equilíbrio entre nº de clipes e naturalidade): a frase inteira primeiro; se não houver, divide em frases
// ("Atenção: acidente a 150 metros. Seu veículo tem 4,5." → 2 frases) e cada frase pode ser:
//   - inteira,
//   - "<cabeça> a <distância>."   → clipe da cabeça ("Atenção: acidente") + clipe da cauda ("a 150 metros."),
//   - "Em <distância>, <resto>"   → clipe "Em 800 metros," + a frase do resto ("vire à direita.").
// Se QUALQUER pedaço faltar, a fala inteira cai na voz do aparelho (nunca meia frase gravada e meia sintetizada).
(function (raiz) {
  "use strict";

  const CHAVE_PREF = "copiloto.vozclipes.v1";
  const CACHE_VOZES = "copiloto-vozes"; // o mesmo nome em sw.js (cache próprio, sem versão: as vozes não se rebaixam a cada publicação)
  const PASTA = "voz/";
  const APARELHO = "aparelho";
  const MAX_PEDACOS = 8;

  // ------------------------------------------------------------ id (hash do texto normalizado)
  function normalizar(texto) {
    let t = String(texto == null ? "" : texto);
    try { t = t.normalize("NFC"); } catch (e) { /* sem normalize */ }
    return t.replace(/\s+/g, " ").trim();
  }
  function bytesUtf8(s) {
    const b = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { const d = s.charCodeAt(i + 1); if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } }
      if (c < 0x80) b.push(c);
      else if (c < 0x800) b.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) b.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else b.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return b;
  }
  function hashTexto(texto) {
    let h = 0x811c9dc5;
    for (const x of bytesUtf8(normalizar(texto))) { h ^= x; h = Math.imul(h, 0x01000193) >>> 0; }
    return ("00000000" + (h >>> 0).toString(16)).slice(-8);
  }
  const idDe = hashTexto;

  // ------------------------------------------------------------ composição
  const DIST = "\\d+(?:,\\d+)?\\s(?:metros|quilômetros?)";
  const RE_CAUDA = new RegExp("^(.+?) (a " + DIST + "\\.)$");  // "Atenção: acidente a 150 metros."
  const RE_EM = new RegExp("^(Em " + DIST + ",) (.+)$");         // "Em 800 metros, vire à direita."
  // frases: corta depois de . ! ? seguido de espaço ou fim (a vírgula decimal "4,3" não corta)
  function frases(texto) {
    const t = normalizar(texto);
    const r = t.match(/[^]*?[.!?](?=\s|$)|[^]+$/g) || [];
    return r.map((x) => x.trim()).filter(Boolean);
  }
  // Devolve a lista de ids para a frase, ou null. tem(id) diz se o clipe existe.
  function resolverFrase(f, tem) {
    const id = idDe(f);
    if (tem(id)) return [id];
    let m = RE_EM.exec(f);
    if (m) {
      const a = idDe(m[1]);
      if (tem(a)) { const r = resolverFrase(m[2], tem); if (r) return [a].concat(r); }
    }
    m = RE_CAUDA.exec(f);
    if (m) {
      const a = idDe(m[1]), b = idDe(m[2]);
      if (tem(a) && tem(b)) return [a, b];
    }
    return null;
  }
  // Texto → ids dos clipes (na ordem de fala) ou null (sem clipe: voz do aparelho).
  function resolver(texto, tem) {
    const t = normalizar(texto);
    if (!t) return null;
    const inteiro = idDe(t);
    if (tem(inteiro)) return [inteiro];
    const partes = frases(t);
    if (partes.length < 1 || partes.length > MAX_PEDACOS) return null;
    const ids = [];
    for (const f of partes) { const r = resolverFrase(f, tem); if (!r) return null; for (const x of r) ids.push(x); }
    return ids.length && ids.length <= MAX_PEDACOS * 2 ? ids : null;
  }

  // ------------------------------------------------------------ manifest
  const RE_ID = /^[0-9a-f]{8}$/;
  const RE_ARQUIVO = /^[A-Za-z0-9_.-]{1,80}\.mp3$/;
  const RE_VOZ_ID = /^[A-Za-z0-9_-]{1,40}$/;
  // Aceita só o que tem cara de manifest; entrada ruim vira null (ou é ignorada). Nunca lança.
  function validarManifest(o) {
    try {
      if (!o || typeof o !== "object" || Array.isArray(o) || !o.clipes || typeof o.clipes !== "object" || Array.isArray(o.clipes)) return null;
      const clipes = {};
      let n = 0, bytes = 0;
      for (const id of Object.keys(o.clipes)) {
        const c = o.clipes[id];
        if (!RE_ID.test(id) || !c || typeof c !== "object" || typeof c.arquivo !== "string" || !RE_ARQUIVO.test(c.arquivo)) continue;
        const b = Number(c.bytes) > 0 ? Math.floor(Number(c.bytes)) : 0;
        clipes[id] = { arquivo: c.arquivo, bytes: b, texto: typeof c.texto === "string" ? c.texto : "" };
        n++; bytes += b;
      }
      if (!n) return null;
      return { perfil: typeof o.perfil === "string" ? o.perfil : "", voiceId: typeof o.voiceId === "string" ? o.voiceId : "", modelo: typeof o.modelo === "string" ? o.modelo : "",
        geradoEm: typeof o.geradoEm === "string" ? o.geradoEm : "", versao: o.versao != null ? o.versao : null, clipes, total: n, totalBytes: bytes };
    } catch (e) { return null; }
  }
  // vozes.json → [{ id, nome }] (id seguro para virar nome de pasta)
  function validarIndice(o) {
    try {
      const lista = o && Array.isArray(o.vozes) ? o.vozes : [];
      const vistos = new Set(), out = [];
      for (const v of lista) {
        if (!v || typeof v.id !== "string" || !RE_VOZ_ID.test(v.id) || v.id === APARELHO || vistos.has(v.id)) continue;
        vistos.add(v.id);
        out.push({ id: v.id, nome: typeof v.nome === "string" && v.nome.trim() ? v.nome.trim().slice(0, 40) : v.id });
      }
      return out;
    } catch (e) { return []; }
  }

  function lerPref(storage) {
    try { const o = JSON.parse((storage && storage.getItem(CHAVE_PREF)) || "null"); return o && typeof o.voz === "string" ? { voz: o.voz } : { voz: null }; } catch (e) { return { voz: null }; }
  }
  function gravarPref(storage, voz) { try { storage && storage.setItem(CHAVE_PREF, JSON.stringify({ voz })); } catch (e) { /* ignora */ } }

  function limitar(v, min, max, padrao) { const n = Number(v); return isFinite(n) ? Math.max(min, Math.min(max, n)) : padrao; }
  function valor(v, padrao) { try { return typeof v === "function" ? v() : v != null ? v : padrao; } catch (e) { return padrao; } }

  // ------------------------------------------------------------ tocador
  // Tudo injetável: fetch, Audio, URL (createObjectURL), caches, storage, setTimeout.
  function criarTocador(opcoes) {
    const o = opcoes || {};
    const g = typeof window !== "undefined" ? window : raiz;
    const buscar = o.fetch !== undefined ? o.fetch : (typeof fetch === "function" ? fetch.bind(g) : null);
    const A = o.Audio !== undefined ? o.Audio : (typeof Audio !== "undefined" ? Audio : null);
    const U = o.URL !== undefined ? o.URL : (typeof URL !== "undefined" ? URL : null);
    const armazem = o.caches !== undefined ? o.caches : (typeof caches !== "undefined" ? caches : null);
    const storage = o.storage !== undefined ? o.storage : null;
    const base = o.base != null ? o.base : PASTA;
    const agendar = o.setTimeout || (typeof setTimeout === "function" ? setTimeout.bind(g) : null);
    const limparAgenda = o.clearTimeout || (typeof clearTimeout === "function" ? clearTimeout.bind(g) : null);
    const timeoutMs = o.timeoutMs != null ? o.timeoutMs : 1200;
    const agora = o.agora || (() => Date.now());
    const MAX_MEMORIA = o.maxMemoria || 400;

    let vozes = [];                     // [{ id, nome }] com manifest válido
    const manifests = new Map();        // id da voz → manifest validado
    let ativaId = null;                 // voz em uso (id) ou null = voz do aparelho
    let pref = lerPref(storage);
    let iniciou = null;                 // promessa de iniciar()
    const urls = new Map();             // "voz/arquivo" → blob URL (memória, ordem de uso)
    const falhou = new Map();           // "voz/arquivo" → até quando não tenta de novo (rede ruim: não atrasa cada fala)
    const ouvintes = [];
    const info = { clipesTocados: 0, falhas: 0, baixando: false };
    let el = null, sessao = 0, atual = null;

    function avisar() { for (const f of ouvintes.slice()) { try { f(); } catch (e) { /* ignora */ } } }
    function aoMudar(f) { if (typeof f === "function") ouvintes.push(f); }

    function url(voz, arquivo) { return base + voz + "/" + arquivo; }
    async function lerJson(caminho) {
      if (!buscar) return null;
      const r = await buscar(caminho, { cache: "no-cache" });
      if (!r || !r.ok) return null;
      return await r.json();
    }
    // Lê o índice e os manifests das vozes. Nunca lança: qualquer falha = só a voz do aparelho.
    function iniciar() {
      if (iniciou) return iniciou;
      iniciou = (async () => {
        vozes = []; manifests.clear();
        try {
          const lista = validarIndice(await lerJson(base + "vozes.json"));
          for (const v of lista) {
            let m = null;
            try { m = validarManifest(await lerJson(base + v.id + "/manifest.json")); } catch (e) { m = null; }
            if (m) { manifests.set(v.id, m); vozes.push(v); }
          }
        } catch (e) { vozes = []; manifests.clear(); }
        aplicarPreferencia();
        avisar();
        return vozes.slice();
      })();
      return iniciou;
    }
    // Sem escolha salva: a primeira voz disponível (quem gerou a voz quer usá-la). "aparelho" salvo vale sempre.
    function aplicarPreferencia() {
      const p = pref.voz;
      if (p === APARELHO) ativaId = null;
      else if (p && manifests.has(p)) ativaId = p;
      else ativaId = vozes.length ? vozes[0].id : null;
    }
    function escolher(id) {
      const certo = id && id !== APARELHO && manifests.has(id) ? id : null;
      ativaId = certo;
      pref = { voz: certo || APARELHO };
      gravarPref(storage, pref.voz);
      avisar();
      return certo;
    }
    function listaVozes() { return vozes.slice(); }
    function ativa() { return ativaId; }
    function manifestAtivo() { return ativaId ? manifests.get(ativaId) || null : null; }

    // ---- planejar: texto → { voz, ids, arquivos } ou null
    function planejar(texto) {
      try {
        const m = manifestAtivo();
        if (!m) return null;
        const ids = resolver(texto, (id) => Object.prototype.hasOwnProperty.call(m.clipes, id));
        if (!ids) return null;
        return { voz: ativaId, ids, arquivos: ids.map((id) => m.clipes[id].arquivo) };
      } catch (e) { return null; }
    }
    const chave = (voz, arquivo) => voz + "/" + arquivo;
    function prontos(plano) { return !!plano && plano.arquivos.every((a) => urls.has(chave(plano.voz, a))); }

    function lembrar(k, u) {
      urls.delete(k); urls.set(k, u);
      while (urls.size > MAX_MEMORIA) {
        const velha = urls.keys().next().value;
        const uv = urls.get(velha); urls.delete(velha);
        try { if (U && U.revokeObjectURL) U.revokeObjectURL(uv); } catch (e) { /* ignora */ }
      }
    }
    async function baixarUm(voz, arquivo) {
      const k = chave(voz, arquivo);
      if (urls.has(k)) return true;
      if (!buscar || !U || !U.createObjectURL) return false;
      if ((falhou.get(k) || 0) > agora()) return false;
      try {
        const r = await buscar(url(voz, arquivo));
        if (!r || !r.ok) throw new Error("http");
        const blob = await r.blob();
        if (!blob || !(blob.size > 0)) throw new Error("vazio");
        lembrar(k, U.createObjectURL(blob));
        return true;
      } catch (e) { falhou.set(k, agora() + 60000); info.falhas++; return false; }
    }
    // Carrega os arquivos do plano (rede ou cache do service worker) em até `ms`. true = todos prontos.
    function carregar(plano, ms) {
      if (!plano) return Promise.resolve(false);
      if (prontos(plano)) return Promise.resolve(true);
      const tudo = Promise.all(plano.arquivos.map((a) => baixarUm(plano.voz, a))).then((r) => r.every(Boolean), () => false);
      const limite = ms != null ? ms : timeoutMs;
      if (!agendar || !(limite > 0)) return tudo;
      return new Promise((resolve) => {
        let feito = false;
        const t = agendar(() => { if (!feito) { feito = true; resolve(false); } }, limite);
        tudo.then((ok) => { if (!feito) { feito = true; if (limparAgenda) limparAgenda(t); resolve(ok); } });
      });
    }

    // ---- reprodução (um <audio> só, reaproveitado: no iPhone ele é liberado uma vez, dentro de um toque)
    function elemento() {
      if (el) return el;
      if (!A) return null;
      el = new A();
      try { el.preload = "auto"; el.playsInline = true; if (typeof el.setAttribute === "function") { el.setAttribute("playsinline", ""); el.setAttribute("aria-hidden", "true"); } } catch (e) { /* ignora */ }
      return el;
    }
    function ajustar(e, volume, taxa) {
      try { e.volume = limitar(volume, 0, 1, 1); } catch (x) { /* ignora */ }
      try {
        const t = limitar(taxa, 0.5, 2, 1);
        e.defaultPlaybackRate = t; e.playbackRate = t;       // trocar o src volta ao padrão: os dois
        e.preservesPitch = true; e.webkitPreservesPitch = true; e.mozPreservesPitch = true; // velocidade sem mudar o tom
      } catch (x) { /* ignora */ }
    }
    function soltar(e) { try { e.onended = null; e.onerror = null; e.pause(); } catch (x) { /* ignora */ } }
    function parar() {
      sessao++;
      const a = atual; atual = null;
      if (el) soltar(el);
      return !!a;
    }
    // Toca os clipes do plano em sequência (todos já carregados). op: { volume, taxa, aoIniciar, aoFim, aoErro(motivo, tocouAlgo) }.
    // Devolve { parar }. Falha ao tocar (gesto, arquivo ruim) → aoErro: quem chamou fala com a voz do aparelho.
    function tocar(plano, op) {
      const p = op || {};
      const e = elemento();
      const lista = plano ? plano.arquivos.map((a) => urls.get(chave(plano.voz, a))) : [];
      const eu = ++sessao;
      const h = { parar: () => { if (sessao === eu) parar(); } };
      if (!e || !lista.length || lista.some((u) => !u)) { if (agendar) agendar(() => { if (p.aoErro) p.aoErro("indisponivel", false); }, 0); else if (p.aoErro) p.aoErro("indisponivel", false); return h; }
      atual = h;
      const volume = valor(p.volume, 1), taxa = valor(p.taxa, 1);
      let i = 0, comecou = false;
      const vivo = () => sessao === eu;
      const erro = (motivo) => { if (!vivo()) return; parar(); info.falhas++; if (p.aoErro) p.aoErro(motivo, comecou); };
      const proximo = () => {
        if (!vivo()) return;
        if (i >= lista.length) { parar(); if (p.aoFim) p.aoFim(); return; }
        try {
          soltar(e);
          e.onended = proximo;
          e.onerror = () => erro("erro_audio");
          e.src = lista[i++];
          ajustar(e, volume, taxa);
          const pr = e.play();
          const ok = () => { if (!vivo()) return; if (!comecou) { comecou = true; info.clipesTocados++; if (p.aoIniciar) p.aoIniciar(); } };
          if (pr && typeof pr.then === "function") pr.then(ok, (x) => erro((x && x.name) || "play"));
          else ok();
        } catch (x) { erro("excecao"); }
      };
      proximo();
      return h;
    }
    function tocando() { return !!atual; }

    // iPhone: dentro de um toque, toca um instante de silêncio no <audio> dos clipes (libera o elemento para falas futuras).
    // Só com uma voz gravada ativa: sem ela nenhum <audio> extra é criado (o app fica como era).
    function destravar() {
      try {
        if (!ativaId) return false;
        const e = elemento();
        if (!e || atual || !o.silencioUri) return false;
        e.src = o.silencioUri; e.volume = 0;
        const pr = e.play();
        if (pr && typeof pr.then === "function") pr.then(() => { try { e.pause(); } catch (x) { /* ignora */ } }, () => {});
        else { try { e.pause(); } catch (x) { /* ignora */ } }
        return true;
      } catch (x) { return false; }
    }

    // ---- uso sem internet: guarda todos os mp3 da voz ativa no cache do navegador (o service worker os serve)
    async function baixarTudo(aoProgresso) {
      const m = manifestAtivo(), voz = ativaId;
      if (!m || !armazem || !buscar || info.baixando) return { ok: false, motivo: !m ? "sem_voz" : info.baixando ? "em_andamento" : "sem_cache", feitos: 0, falhas: 0 };
      info.baixando = true;
      let feitos = 0, falhas = 0, bytes = 0;
      const ids = Object.keys(m.clipes), total = ids.length;
      try {
        const cache = await armazem.open(CACHE_VOZES);
        const manifestUrl = url(voz, "manifest.json");
        try { const rm = await buscar(manifestUrl, { cache: "no-cache" }); if (rm && rm.ok) await cache.put(manifestUrl, rm); } catch (e) { /* segue */ }
        let proximo = 0;
        const trabalhador = async () => {
          while (proximo < ids.length) {
            const c = m.clipes[ids[proximo++]];
            const u = url(voz, c.arquivo);
            try {
              if (await cache.match(u)) { feitos++; bytes += c.bytes; }
              else {
                const r = await buscar(u);
                if (!r || !r.ok) throw new Error("http");
                await cache.put(u, r.clone ? r.clone() : r);
                feitos++; bytes += c.bytes;
              }
            } catch (e) { falhas++; }
            if (aoProgresso) { try { aoProgresso({ feitos, falhas, total, bytes }); } catch (e) { /* ignora */ } }
          }
        };
        await Promise.all([trabalhador(), trabalhador(), trabalhador()]);
        return { ok: falhas === 0, feitos, falhas, total, bytes };
      } catch (e) { return { ok: false, motivo: "erro", feitos, falhas, total, bytes }; }
      finally { info.baixando = false; avisar(); }
    }
    // Quanto da voz ativa já está guardado: { clipes, total, bytes, totalBytes }
    async function tamanhoBaixado() {
      const m = manifestAtivo(), voz = ativaId;
      const vazio = { clipes: 0, total: m ? m.total : 0, bytes: 0, totalBytes: m ? m.totalBytes : 0 };
      if (!m || !armazem) return vazio;
      try {
        const cache = await armazem.open(CACHE_VOZES);
        const chaves = await cache.keys();
        const guardados = new Set(chaves.map((r) => { try { return new URL(r.url, "http://x/").pathname; } catch (e) { return String(r.url); } }));
        let n = 0, b = 0;
        for (const id of Object.keys(m.clipes)) {
          const c = m.clipes[id];
          const alvo = new URL(url(voz, c.arquivo), (typeof location !== "undefined" && location.href) || "http://x/").pathname;
          if (guardados.has(alvo)) { n++; b += c.bytes; }
        }
        return { clipes: n, total: m.total, bytes: b, totalBytes: m.totalBytes };
      } catch (e) { return vazio; }
    }
    // Uma frase que a voz ativa sabe falar (para o botão de teste): prefere a frase de teste de voz.
    function amostra() {
      const m = manifestAtivo();
      if (!m) return null;
      for (const t of ["Teste de voz do Copiloto. Se você está ouvindo isto, os alertas vão funcionar.", "Voz ativada.", "Atenção: acidente a 500 metros."]) {
        if (planejar(t)) return t;
      }
      const ids = Object.keys(m.clipes);
      return ids.length ? m.clipes[ids[0]].texto || null : null;
    }

    return { iniciar, escolher, vozes: listaVozes, ativa, aoMudar, planejar, prontos, carregar, tocar, parar, tocando, destravar, baixarTudo, tamanhoBaixado, amostra,
      manifest: manifestAtivo, info, pronto: () => iniciou };
  }

  function formatarBytes(b) {
    const n = Number(b) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1048576).toFixed(1).replace(".", ",") + " MB";
  }

  const api = { CHAVE_PREF, CACHE_VOZES, PASTA, APARELHO, normalizar, hashTexto, idDe, frases, resolver, resolverFrase, validarManifest, validarIndice,
    lerPref, gravarPref, criarTocador, formatarBytes, RE_CAUDA, RE_EM };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoVozClipes = api;
})(typeof window !== "undefined" ? window : globalThis);
