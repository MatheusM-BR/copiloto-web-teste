// Service worker do Copiloto (pacote E3): app abre sem internet e mapa guardado.
// Escopo = a pasta deste arquivo (funciona no subcaminho do GitHub Pages). Registrado por ui/offline.js.
//
// ATENÇÃO AO PUBLICAR: mude VERSAO a cada publicação. O esqueleto do app é servido do cache dessa versão;
// sem mudar VERSAO, o iPhone continua com os arquivos antigos. Com VERSAO nova, o app mostra
// "Nova versão disponível — tocar para atualizar" e só troca quando o motorista tocar.
//
// Caches:
//  copiloto-app-<VERSAO>  esqueleto (index.html e tudo que ele referencia + estilos carregados depois). Cache primeiro.
//  copiloto-vozes         vozes gravadas (voz/<voz>/*.mp3 e os json de voz/). SEM versão: não se rebaixa a cada publicação. mp3: cache primeiro,
//                         carregado de forma preguiçosa (ao usar) ou pelo botão "Baixar vozes para usar sem internet"; json: rede primeiro.
//  copiloto-mapa-estilo   estilo, TileJSON, fontes e sprites da OpenFreeMap. Usa o guardado e atualiza por trás.
//  copiloto-mapa-blocos   blocos vistos no mapa. Usa o guardado; atualiza por trás se tiver mais de 7 dias. Com limite.
//  copiloto-mapa-rota-<id> blocos do corredor de cada rota, baixados sozinhos ao traçar (gravados pela página, ui/offline.js;
//                         valem 30 dias; o antigo "copiloto-mapa-rota", de um corredor só, também é lido).
const VERSAO = "2026-11-10.1";
const CACHE_APP = "copiloto-app-" + VERSAO;
const CACHE_VOZES = "copiloto-vozes"; // o mesmo nome de vozclipes.js (CACHE_VOZES); activate só apaga "copiloto-app-*"
const CACHE_ESTILO = "copiloto-mapa-estilo";
const CACHE_BLOCOS = "copiloto-mapa-blocos";
const LIMITE_BLOCOS = { maxItens: 2500, maxBytes: 80e6 };
const REVALIDAR_RECURSO_MS = 7 * 24 * 3600e3;
// Fora do index.html: páginas abertas por link (privacidade.html, E5) também precisam abrir sem internet.
const EXTRAS = ["./", "index.html", "manifest.webmanifest", "icon-180.png", "icon-512.png", "offline.js", "estilos/offline.css", "privacidade.html", "alternativas.js", "tracecache.js", "limite.js", "ui/limite.js", "estilos/limite.css", "custos.js", "ui/custos.js", "estilos/custos.css", "dados.js", "desvio.js", "ruido.js", "kmcache.js", "traducao.js", "ui/km.js", "ui/avisos.js", "ui/desvio.js", "estilos/km.css", "estilos/avisos.css", "estilos/postos.css", "descanso.js", "ui/descanso.js", "estilos/descanso.css", "placas.js", "ui/lista.js", "estilos/placas.css", "estilos/lista.css", "vozclipes.js"];

importScripts("offline.js");
const O = self.CopilotoOffline;

// ------------------------------------------------------------ instalação: guarda o esqueleto
self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const resp = await fetch("index.html", { cache: "reload" });
    if (!resp.ok) throw new Error("index.html indisponível");
    const html = await resp.clone().text();
    const doIndex = O.arquivosDoIndex(html);
    const lista = Array.from(new Set(EXTRAS.concat(doIndex)));
    const cache = await caches.open(CACHE_APP);
    await cache.addAll(lista.map((u) => new Request(u, { cache: "reload" })));
    await cache.put("index.html", resp);
    // estilos que os módulos carregam depois (Copiloto.carregarEstilo): sem travar a instalação se faltar algum
    // (o achado vem de um texto do código e pode ser só um exemplo num comentário)
    for (const js of doIndex.filter((u) => /^ui\/.*\.js$/.test(u))) {
      const corpo = await cache.match(js).then((r) => (r ? r.text() : ""), () => "");
      for (const css of O.estilosCarregados(corpo)) {
        if (lista.includes(css)) continue;
        try { const r = await fetch(css, { cache: "reload" }); if (r.ok) await cache.put(css, r); } catch (err) { /* segue */ }
      }
    }
    // vozes gravadas: só o índice e os manifests entram na instalação (pequenos); os mp3 vêm ao usar (preguiçoso) ou pelo botão da aba Voz.
    // Nada disto pode travar a instalação: sem voz gerada, o índice é só uma lista vazia.
    try { await guardarManifestsDeVoz(); } catch (err) { /* segue */ }
    // não chama skipWaiting: a versão nova espera o motorista tocar em "atualizar"
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const nome of await caches.keys()) if (nome.startsWith("copiloto-app-") && nome !== CACHE_APP) await caches.delete(nome);
    await self.clients.claim(); // primeira instalação: já controla a página aberta (o mapa visto começa a ser guardado)
    await podarBlocos();
  })());
});

self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.tipo === "atualizar") self.skipWaiting();
  else if (d.tipo === "versao" && e.source) e.source.postMessage({ tipo: "versao", versao: VERSAO });
});

// ------------------------------------------------------------ pedidos
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // download do corredor feito pela página (ui/offline.js): ela mesma grava no cache da rota
  if (req.cache === "no-store") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (!url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
    if (ehVoz(url)) { e.respondWith(voz(req, url)); return; }
    e.respondWith(app(req));
    return;
  }
  const tipo = O.classificarUrl(req.url);
  if (tipo === "bloco") e.respondWith(bloco(req, e));
  else if (tipo === "estilo") e.respondWith(guardadoEAtualiza(req, e, CACHE_ESTILO, 0));
  else if (tipo === "recurso") e.respondWith(guardadoEAtualiza(req, e, CACHE_ESTILO, REVALIDAR_RECURSO_MS));
});

// ------------------------------------------------------------ vozes gravadas (voz/)
function ehVoz(url) {
  const base = new URL(self.registration.scope).pathname;
  return url.pathname.startsWith(base + "voz/") && /\.(mp3|json)$/.test(url.pathname);
}
async function guardarManifestsDeVoz() {
  const cache = await caches.open(CACHE_VOZES);
  const r = await fetch("voz/vozes.json", { cache: "reload" });
  if (!r.ok) return;
  const corpo = await r.clone().json().catch(() => null);
  await cache.put("voz/vozes.json", r);
  for (const v of corpo && Array.isArray(corpo.vozes) ? corpo.vozes : []) {
    if (!v || typeof v.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(v.id)) continue;
    try { const m = await fetch("voz/" + v.id + "/manifest.json", { cache: "reload" }); if (m.ok) await cache.put("voz/" + v.id + "/manifest.json", m); } catch (err) { /* segue */ }
  }
}
// mp3: cache primeiro (e guarda ao baixar). json: rede primeiro (voz nova vale já), cache se estiver sem internet.
// Pedido com Range (o <audio> do Safari) passa direto: o app toca os clipes por blob, sem Range.
async function voz(req, url) {
  if (req.headers.has("range")) return fetch(req);
  const cache = await caches.open(CACHE_VOZES);
  if (/\.mp3$/.test(url.pathname)) {
    const guardado = await cache.match(req);
    if (guardado) return guardado;
    const resp = await fetch(req);
    if (resp.ok && resp.status === 200) cache.put(req, resp.clone()).catch(() => {});
    return resp;
  }
  try {
    const resp = await fetch(req);
    if (resp.ok) cache.put(req, resp.clone()).catch(() => {});
    return resp;
  } catch (err) {
    const guardado = await cache.match(req);
    if (guardado) return guardado;
    throw err;
  }
}

async function app(req) {
  const cache = await caches.open(CACHE_APP);
  const navegacao = req.mode === "navigate";
  const guardado = await cache.match(req, { ignoreSearch: navegacao }) || (navegacao ? await cache.match("index.html") : null);
  if (guardado) return guardado;
  try {
    const resp = await fetch(req);
    // arquivo do app fora do index.html (ex.: estilo de pacote carregado depois): guarda nesta versão
    if (resp.ok && resp.type === "basic") cache.put(req, resp.clone()).catch(() => {});
    return resp;
  } catch (err) {
    if (navegacao) { const idx = await cache.match("index.html"); if (idx) return idx; }
    throw err;
  }
}

// Guarda a resposta com a hora em que chegou (cabeçalho próprio), para saber a idade.
async function carimbar(resp) {
  const corpo = await resp.arrayBuffer();
  const cab = new Headers(resp.headers);
  cab.set("x-copiloto-em", String(Date.now()));
  cab.set("x-copiloto-bytes", String(corpo.byteLength));
  return new Response(corpo, { status: resp.status, statusText: resp.statusText, headers: cab });
}
function idade(resp) { const t = Number(resp.headers.get("x-copiloto-em")); return isFinite(t) && t > 0 ? Date.now() - t : Infinity; }

// Usa o guardado e, se for mais velho que maxIdade, atualiza por trás (stale-while-revalidate).
async function guardadoEAtualiza(req, e, nomeCache, maxIdade) {
  const cache = await caches.open(nomeCache);
  const guardado = await cache.match(req);
  const buscar = fetch(req).then(async (resp) => {
    if (resp.ok) await cache.put(req, await carimbar(resp.clone()));
    return resp;
  });
  if (guardado) {
    if (idade(guardado) >= maxIdade) e.waitUntil(buscar.catch(() => {}));
    return guardado;
  }
  return buscar;
}

let novosBlocos = 0;
async function bloco(req, e) {
  const chave = O.chaveBloco(req.url);
  const vistos = await caches.open(CACHE_BLOCOS);
  // corredores das rotas (um cache por rota, baixado sozinho ao traçar; ver ui/offline.js)
  let rota = null, daRota = null;
  for (const nome of (await caches.keys()).filter(O.ehCacheDeCorredor)) {
    const c = await caches.open(nome), r = await c.match(chave);
    if (r) { rota = c; daRota = r; break; }
  }
  const guardado = daRota || await vistos.match(chave);
  const destino = daRota ? rota : vistos; // atualização fica no mesmo cache de onde veio
  const buscar = fetch(req).then(async (resp) => {
    if (resp.ok) {
      await destino.put(chave, await carimbar(resp.clone()));
      if (destino === vistos && ++novosBlocos % 100 === 0) await podarBlocos();
    }
    return resp;
  });
  if (guardado) {
    if (idade(guardado) >= REVALIDAR_RECURSO_MS) e.waitUntil(buscar.catch(() => {}));
    return guardado;
  }
  return buscar;
}

// Limite do cache de blocos vistos: sai o mais antigo (ordem de gravação do Cache Storage).
async function podarBlocos() {
  const cache = await caches.open(CACHE_BLOCOS);
  const chaves = await cache.keys();
  if (chaves.length < 200) return;
  const resps = await cache.matchAll();
  const entradas = chaves.map((k, i) => ({ chave: k, bytes: resps[i] ? Number(resps[i].headers.get("x-copiloto-bytes")) : NaN }));
  for (const k of O.podar(entradas, LIMITE_BLOCOS)) await cache.delete(k);
}
