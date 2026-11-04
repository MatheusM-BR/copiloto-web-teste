// Via do trajeto (interface). Lógica pura em viaqualidade.js. Expõe Copiloto.via:
//   obter(rota) → entrada { chave, estado: "carregando" | "ok" | "falha" | "offline", resumo, runs, completo } (um pedido por rota),
//   modo() ("padrao" | "avancado", lido de copiloto.rota.modo.v1), resumoDe(rota), abrirDetalhe(rota), tentarDeNovo(rota).
// Onde aparece (ganchos C.rotaExtras de ui/rota.js):
//   - folha da rota, nos dois modos: linha "38 km de terra · 12 km de piso ruim" (toque abre a lista de trechos com "Ver no mapa");
//     "Sem terra" em verde; "Verificando a via…" enquanto carrega; "Não deu para verificar o piso" sem internet ou em falha;
//   - Avançado: cartão compacto "Via do trajeto" (barra proporcional pista dupla/simples/terra, relevo, buracos relatados);
//   - cartões das alternativas: os km de terra/piso ruim de cada uma e o rótulo "Menos terra" na que tiver menos.
// Dados: /trace_attributes do Valhalla público sobre a forma da rota (pedaços de até 450 km), guardados em
// localStorage ("copiloto.via.v1", as 3 últimas): sem internet usa o último cálculo; sem ele, diz que precisa de internet.
// No mapa: trechos de terra (marrom tracejado) e piso ruim (laranja tracejado) com borda branca, nos dois temas.
(function (C) {
  "use strict";
  const { $, el, botao } = C.util;
  const V = window.CopilotoVia;
  const Rota = window.CopilotoRota;
  const CHAVE_MODO = "copiloto.rota.modo.v1";
  const COR = { terra: "#8d4b12", ruim: "#f08c00", subida: "#7b3fc4", descida: "#0f8b8d" };
  const MAX_ENTRADAS = 8, MAX_SIMULTANEOS = 3, MAX_ITENS_LISTA = 30;
  C.carregarEstilo("estilos/via.css");

  const entradas = new Map();
  let selecionada = null;            // chave da rota mostrada agora (a que tem os trechos no mapa)
  let blocoVivo = null;              // bloco da folha da rota mostrado agora (troca a rota quando se escolhe outra alternativa)
  let folhaAnterior = null;          // nós da folha da rota, para "Voltar" do detalhe
  let emVoo = 0; const fila = [];

  function storage() { try { return localStorage; } catch (e) { return null; } }
  function modo() { try { return localStorage.getItem(CHAVE_MODO) === "avancado" ? "avancado" : "padrao"; } catch (e) { return "padrao"; } }
  function online() { return !(navigator && navigator.onLine === false); }
  function urlTrace() {
    if (window.COPILOTO_URL_TRACE) return window.COPILOTO_URL_TRACE;
    const r = window.COPILOTO_URL_ROTA;
    return r && /\/route$/.test(r) ? r.replace(/\/route$/, "/trace_attributes") : V.URL_TRACE_PADRAO;
  }
  function urlHeight() {
    if (window.COPILOTO_URL_HEIGHT) return window.COPILOTO_URL_HEIGHT;
    const r = window.COPILOTO_URL_ROTA;
    return r && /\/route$/.test(r) ? r.replace(/\/route$/, "/height") : V.URL_HEIGHT_PADRAO;
  }
  const chaveDe = (r) => V.chaveRota(r.coords, Rota.ehCaminhao(r.perfil));

  // ------------------------------------------------------------ rede (no máximo 3 pedidos ao mesmo tempo)
  function naFila(fn) {
    return new Promise((resolve, reject) => {
      const rodar = () => { emVoo++; fn().then(resolve, reject).finally(() => { emVoo--; const p = fila.shift(); if (p) p(); }); };
      if (emVoo < MAX_SIMULTANEOS) rodar(); else fila.push(rodar);
    });
  }
  async function postar(url, corpo) {
    return naFila(async () => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
      try {
        const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo), signal: ctl.signal });
        return { json: await resp.json().catch(() => null) };
      } catch (e) { return { rede: true }; } finally { clearTimeout(t); }
    });
  }

  // ------------------------------------------------------------ dados da rota
  // ouvintes: elemento → função que redesenha. Some quando o elemento sai da tela de vez (nem na folha guardada do "Voltar").
  function vivo(n) {
    if (n.isConnected) { n.__visto = true; return true; }
    return !n.__visto || !!(folhaAnterior && folhaAnterior.some((x) => x.contains(n)));
  }
  function registrar(e, n, fn) { e.ouvintes.set(n, fn); }
  function avisar(e) {
    for (const [n, f] of Array.from(e.ouvintes)) {
      if (!vivo(n)) { e.ouvintes.delete(n); continue; }
      try { f(); } catch (x) { /* ouvinte morto */ }
    }
    rotularMenosTerra();
  }
  function preencher(e, runs, completo) {
    e.runs = runs; e.completo = completo; e.resumo = V.resumir(runs, e.acum); e.estado = "ok";
    if (selecionada === e.chave) desenharTrechos(e);
    avisar(e);
  }
  function obter(r) {
    const caminhao = Rota.ehCaminhao(r.perfil), chave = V.chaveRota(r.coords, caminhao);
    let e = entradas.get(chave);
    if (e) { entradas.delete(chave); entradas.set(chave, e); return e; } // mais recente por último
    e = { chave, coords: r.coords, acum: V.acumulado(r.coords), caminhao, estado: "carregando", runs: [], resumo: null, completo: false, ouvintes: new Map(), buscando: false };
    entradas.set(chave, e);
    while (entradas.size > MAX_ENTRADAS) entradas.delete(entradas.keys().next().value);
    const g = V.buscarGuardado(storage(), chave, e.acum);
    if (g && g.completo) { preencher(e, g.runs, true); return e; }
    buscar(e);
    return e;
  }
  async function buscar(e) {
    if (e.buscando) return;
    if (!online()) { e.estado = "offline"; avisar(e); return; }
    e.buscando = true; e.estado = "carregando"; avisar(e);
    const pedacos = V.fatiar(e.coords);
    const arestas = []; let falhas = 0;
    await Promise.all(pedacos.map(async (p) => {
      const corpo = V.pedidoTrace(e.coords.slice(p.de, p.ate + 1), e.caminhao);
      for (let t = 0; t < 2; t++) {
        const res = await postar(urlTrace(), corpo);
        if (res.json && Array.isArray(res.json.edges)) {
          try { arestas.push(...V.arestasDaResposta(res.json, p.de, e.acum)); return; } catch (x) { /* tenta de novo */ }
        }
        if (res.json && res.json.error_code === 153) break; // formato recusado: repetir não adianta
      }
      falhas++;
    }));
    e.buscando = false;
    if (!arestas.length) { e.estado = online() ? "falha" : "offline"; avisar(e); return; }
    const runs = V.juntar(arestas);
    preencher(e, runs, falhas === 0);
    if (falhas === 0) {
      V.guardar(storage(), { chave: e.chave, salvoEm: Date.now(), completo: true, runs });
      if (!e.resumo.temRelevo) relevoPorHeight(e);
    }
  }
  // O servidor não deu inclinação nas arestas: tenta o /height (um pedido com até 1.000 pontos da forma)
  async function relevoPorHeight(e) {
    const res = await postar(urlHeight(), V.pedidoHeight(e.coords, 1000));
    const rel = res.json ? V.relevoDeHeight(res.json) : null;
    if (!rel) return;
    e.resumo.ganhoM = rel.ganhoM; e.resumo.perdaM = rel.perdaM; e.resumo.temRelevo = true; e.resumo.relevoPorHeight = true;
    avisar(e);
  }
  function tentarDeNovo(r) { const e = obter(r); if (e.estado === "falha" || e.estado === "offline") buscar(e); }
  window.addEventListener("online", () => { for (const e of entradas.values()) if (e.estado === "falha" || e.estado === "offline") buscar(e); });

  // ------------------------------------------------------------ mapa
  function trechoComoFeature(e, t, tipo) {
    return { type: "Feature", properties: { tipo, cor: COR[tipo] }, geometry: { type: "LineString", coordinates: e.coords.slice(t.i0, t.i1 + 1) } };
  }
  function desenharTrechos(e) {
    if (!e || e.estado !== "ok") return;
    const feats = [];
    for (const t of e.resumo.trechosTerra) feats.push(trechoComoFeature(e, t, "terra"));
    for (const t of e.resumo.trechosRuins) feats.push(trechoComoFeature(e, t, "ruim"));
    C.mapaPronto(() => {
      const mapa = C.mapa; if (selecionada !== e.chave) return;
      const dados = { type: "FeatureCollection", features: feats };
      if (mapa.getSource("via-trechos")) { mapa.getSource("via-trechos").setData(dados); return; }
      mapa.addSource("via-trechos", { type: "geojson", data: dados });
      mapa.addLayer({ id: "via-trechos-borda", type: "line", source: "via-trechos", layout: { "line-cap": "butt", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": 10, "line-opacity": 0.9 } });
      mapa.addLayer({ id: "via-trechos", type: "line", source: "via-trechos", layout: { "line-cap": "butt", "line-join": "round" },
        paint: { "line-color": ["get", "cor"], "line-width": 5, "line-dasharray": [2, 1.4] } });
    });
  }
  function limparTrechos() {
    const mapa = C.mapa; if (!mapa) return;
    C.mapaPronto(() => {
      for (const id of ["via-trechos", "via-trechos-borda"]) if (mapa.getLayer(id)) mapa.removeLayer(id);
      if (mapa.getSource("via-trechos")) mapa.removeSource("via-trechos");
    });
  }
  function destacar(e, t, tipo) {
    const f = { type: "FeatureCollection", features: [trechoComoFeature(e, t, tipo)] };
    C.mapaPronto(() => {
      const mapa = C.mapa;
      if (mapa.getSource("via-destaque")) mapa.getSource("via-destaque").setData(f);
      else {
        mapa.addSource("via-destaque", { type: "geojson", data: f });
        mapa.addLayer({ id: "via-destaque-borda", type: "line", source: "via-destaque", layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#ffffff", "line-width": 14, "line-opacity": 0.95 } });
        mapa.addLayer({ id: "via-destaque", type: "line", source: "via-destaque", layout: { "line-cap": "butt", "line-join": "round" },
          paint: { "line-color": ["get", "cor"], "line-width": 7, "line-dasharray": [2, 1.2] } });
      }
    });
  }
  function apagarDestaque() {
    const mapa = C.mapa; if (!mapa) return;
    C.mapaPronto(() => {
      for (const id of ["via-destaque", "via-destaque-borda"]) if (mapa.getLayer(id)) mapa.removeLayer(id);
      if (mapa.getSource("via-destaque")) mapa.removeSource("via-destaque");
    });
  }
  function enquadrarTrecho(e, t) {
    const pts = e.coords.slice(t.i0, t.i1 + 1);
    if (C.rotaLonga && C.rotaLonga.enquadrar) { setTimeout(() => C.rotaLonga.enquadrar(pts.length > 1 ? pts : e.coords), 80); return; }
    C.mapaPronto(() => { try { C.mapa.fitBounds(pts.reduce((a, c) => a.extend(c), new maplibregl.LngLatBounds(pts[0], pts[0])), { padding: 60, duration: 500 }); } catch (x) { /* ignora */ } });
  }

  // ------------------------------------------------------------ peças da interface
  function textoTerra(e) {
    if (e.estado === "carregando") return { t: "Verificando a via…", c: "carregando" };
    if (e.estado !== "ok") return { t: "Não deu para verificar o piso", c: "falha" };
    const t = V.textoTerraRuim(e.resumo);
    return t ? { t, c: e.resumo.kmTerra >= 0.5 ? "terra" : "ruim" } : { t: "Sem terra", c: "boa" };
  }
  // Linha viva (atualiza quando os dados chegam). interativa: botão que abre a lista (ou tenta de novo, em falha).
  function linhaTerra(e, r, interativa) {
    const b = interativa ? botao("", "via-terra via-terra-btn", () => {
      if (e.estado === "ok" && (e.resumo.trechosTerra.length || e.resumo.trechosRuins.length)) abrirDetalhe(r);
      else if (e.estado === "falha" || e.estado === "offline") buscar(e);
    }) : el("span", "via-terra");
    const atualizar = () => {
      const x = textoTerra(e);
      b.dataset.estado = x.c;
      b.textContent = x.t;
      if (interativa) {
        const abre = e.estado === "ok" && (e.resumo.trechosTerra.length || e.resumo.trechosRuins.length);
        b.disabled = !(abre || e.estado === "falha" || e.estado === "offline");
        if (abre) b.append(el("span", "via-seta", " ›"));
        b.setAttribute("aria-label", abre ? x.t + ". Ver os trechos" : (e.estado === "ok" && V.avisoPadrao(e.resumo)) || (x.c === "falha" ? x.t + ". Tocar para tentar de novo" : x.t));
      }
    };
    registrar(e, b, atualizar); atualizar();
    return b;
  }

  function relatosDeBuraco() {
    try { return C.comunidade && C.comunidade.relatosParaAlerta ? C.comunidade.relatosParaAlerta() || [] : []; } catch (x) { return []; }
  }
  function barra(res) {
    const b = el("span", "via-barra"); b.setAttribute("aria-hidden", "true");
    const total = res.kmDupla + res.kmSimples + res.kmTerra || 1;
    for (const [cls, km] of [["dupla", res.kmDupla], ["simples", res.kmSimples], ["terra", res.kmTerra]]) {
      if (km <= 0) continue;
      const s = el("span", "via-b via-b-" + cls); s.style.flexGrow = String(Math.max(0.5, km / total * 100)); b.append(s);
    }
    return b;
  }

  // Cartão do modo Avançado (dentro de um botão: um toque abre o detalhe)
  function cartaoAvancado(e, r) {
    const c = botao("", "via-cartao", () => abrirDetalhe(r));
    c.setAttribute("aria-label", "Via do trajeto. Ver detalhes");
    const preencherCartao = () => {
      c.textContent = "";
      c.append(el("span", "via-titulo", "Via do trajeto"));
      // dado oficial (DNIT — SNV) quando cobre mais da metade da rota (ui/avisos.js, dados.js); senão a heurística do OSM
      const snv = C.dadosRota && C.dadosRota.snvDe ? C.dadosRota.snvDe(r) : null;
      if (e.estado === "ok") {
        const res = e.resumo;
        c.append(snv ? barra({ kmDupla: snv.kmDupla, kmSimples: snv.kmSimples, kmTerra: snv.kmNaoPav }) : barra(res));
        const lp = snv ? window.CopilotoDados.textoPistaSnv(snv) : V.textoPista(res);
        if (lp) c.append(el("span", "via-l" + (snv ? " via-snv" : ""), lp));
        if (snv) c.append(el("span", "via-l via-fonte-snv", window.CopilotoDados.textoFonteSnv(snv)));
        c.append(el("span", "via-l", V.textoRelevo(res)));
        const bur = V.buracosNaRota(e.coords, e.acum, relatosDeBuraco(), Date.now());
        c.append(el("span", "via-l", V.textoBuracos(bur)));
        c.append(linhaTerra(e, r, false));
        if (!e.completo) c.append(el("span", "via-l via-parcial", "Dados parciais: parte da rota não foi verificada."));
      } else {
        if (snv) { // sem o trace do Valhalla, o SNV ainda diz a pista e o pavimento
          c.append(barra({ kmDupla: snv.kmDupla, kmSimples: snv.kmSimples, kmTerra: snv.kmNaoPav }));
          const lp = window.CopilotoDados.textoPistaSnv(snv);
          if (lp) c.append(el("span", "via-l via-snv", lp));
          c.append(el("span", "via-l via-fonte-snv", window.CopilotoDados.textoFonteSnv(snv)));
        }
        c.append(linhaTerra(e, r, false));
      }
      c.append(el("span", "via-ver", "Ver detalhes ›"));
    };
    registrar(e, c, preencherCartao); preencherCartao();
    return c;
  }

  // ------------------------------------------------------------ gancho: folha da rota
  C.rotaExtras = C.rotaExtras || { folha: [], cartao: [] };
  C.rotaExtras.folha.push(function (r, opcoes) {
    const bloco = el("div", "via-bloco");
    const montar = (rr) => {
      bloco.textContent = "";
      const e = obter(rr);
      selecionada = e.chave;
      if (e.estado === "ok") desenharTrechos(e); else limparTrechos();
      bloco.append(modo() === "avancado" ? cartaoAvancado(e, rr) : linhaTerra(e, rr, true));
    };
    montar(r);
    blocoVivo = { bloco, montar, rota: r };
    return bloco;
  });
  C.rotaExtras.cartao.push(function (r) {
    const e = obter(r);
    const linha = el("span", "via-cartao-linha");
    linha.append(linhaTerra(e, r, false));
    return linha;
  });
  // "Menos terra": a alternativa com menos km de terra, quando todas já têm dados e a diferença existe
  function rotularMenosTerra() {
    const alt = C.rota && C.rota.alternativas ? C.rota.alternativas() : null;
    const botoes = Array.from(document.querySelectorAll("#folha .rota-opcao"));
    for (const b of botoes) { const m = b.querySelector(".via-menos"); if (m) m.remove(); }
    if (!alt || alt.rotas.length < 2) return;
    const ents = alt.rotas.map((r) => entradas.get(chaveDe(r)));
    if (ents.some((e) => !e || e.estado !== "ok")) return;
    const kms = ents.map((e) => Math.round(e.resumo.kmTerra * 10) / 10);
    const min = Math.min(...kms), max = Math.max(...kms);
    if (!(max > min) || kms.filter((k) => k === min).length !== 1) return;
    const i = kms.indexOf(min);
    const b = botoes.find((x) => Number(x.dataset.i) === i);
    const linha = b && b.querySelector(".rota-opcao-linha");
    if (linha) linha.append(el("span", "rota-etiqueta boa via-menos", "Menos terra"));
  }

  // ------------------------------------------------------------ detalhe
  function rotuloVia(v) { return v || "Via sem nome"; }
  function kmTxt(km) { return V.fmtKm(km); }
  function itemTrecho(e, r, t, tipo, titulo) {
    const it = el("div", "via-item");
    const info = el("div", "via-item-info");
    info.append(el("b", null, titulo), el("span", null, "a " + kmTxt(t.kmIni) + " da origem · " + kmTxt(t.km)));
    const ver = botao("Ver no mapa", "btn via-ver-mapa", () => verNoMapa(e, r, t, tipo, titulo));
    ver.setAttribute("aria-label", "Ver no mapa: " + titulo + ", a " + kmTxt(t.kmIni) + " da origem");
    it.append(info, ver);
    return it;
  }
  function secao(titulo, itens, mais) {
    const s = el("div", "via-secao");
    s.append(el("h3", null, titulo));
    for (const i of itens) s.append(i);
    if (mais > 0) s.append(el("p", "dica", "e mais " + mais + "."));
    return s;
  }
  function abrirDetalhe(r) {
    const e = obter(r);
    if (e.estado !== "ok") return;
    const f = $("folha");
    if (!folhaAnterior) folhaAnterior = f ? Array.from(f.children) : null;
    const res = e.resumo;
    const nos = [el("h2", null, "Via do trajeto")];
    const snv = C.dadosRota && C.dadosRota.snvDe ? C.dadosRota.snvDe(r) : null;
    const lp = snv ? window.CopilotoDados.textoPistaSnv(snv) : V.textoPista(res);
    nos.push(el("p", null, kmTxt(res.kmTotal) + " no total" + (lp ? " · " + lp : "") + "." + (snv ? " Pista e pavimento: " + window.CopilotoDados.textoFonteSnv(snv) + "." : "")));
    const t = V.textoTerraRuim(res);
    nos.push(el("p", null, t || "Sem terra e sem piso ruim no mapa."));
    const lista = [];
    const ordenar = (a, b) => a.kmIni - b.kmIni;
    const terra = res.trechosTerra.slice().sort(ordenar), ruim = res.trechosRuins.slice().sort(ordenar);
    if (terra.length) nos.push(secao("Estrada de terra (" + terra.length + ")", terra.slice(0, MAX_ITENS_LISTA).map((x) => itemTrecho(e, r, x, "terra", rotuloVia(x.via) + " · " + x.tipo)), terra.length - MAX_ITENS_LISTA));
    if (ruim.length) nos.push(secao("Piso ruim no mapa (" + ruim.length + ")", ruim.slice(0, MAX_ITENS_LISTA).map((x) => itemTrecho(e, r, x, "ruim", rotuloVia(x.via) + " · piso ruim")), ruim.length - MAX_ITENS_LISTA));
    const altas = res.trechosRampaAlta.slice().sort(ordenar);
    if (res.temRelevo) {
      nos.push(el("p", null, V.textoRelevo(res) + (res.kmRampaAlta >= 0.3 ? " · " + kmTxt(res.kmRampaAlta) + " com rampa acima de 6%." : "")));
    } else nos.push(el("p", null, "Sem dados de relevo."));
    if (altas.length) nos.push(secao("Rampas acima de 6% (" + altas.length + ")", altas.slice(0, MAX_ITENS_LISTA).map((x) => itemTrecho(e, r, x, x.sentido === "subida" ? "subida" : "descida", (x.sentido === "subida" ? "Subida" : "Descida") + " forte")), altas.length - MAX_ITENS_LISTA));
    const rod = V.rodoviasDaLista(res);
    if (rod.length) {
      const ul = el("div", "via-rodovias");
      for (const x of rod.slice(0, 40)) ul.append(el("span", "via-rod", x.nome + " " + kmTxt(x.km)));
      nos.push(el("div", "via-secao", null));
      nos[nos.length - 1].append(el("h3", null, "Rodovias na ordem"), ul);
    }
    const bur = V.buracosNaRota(e.coords, e.acum, relatosDeBuraco(), Date.now());
    const sb = el("div", "via-secao"); sb.append(el("h3", null, "Buracos relatados"), el("p", null, V.textoBuracos(bur)));
    for (const b of bur.itens.slice(0, 5)) sb.append(el("p", "dica", "a " + kmTxt(b.km) + " da origem" + (b.quando ? " · há " + Math.max(0, Math.round((Date.now() - b.quando) / 86400000)) + " dias" : "")));
    sb.append(el("p", "dica", "Relatos de motoristas; o mapa aberto não sabe onde há buraco."));
    nos.push(sb);
    nos.push(el("p", "dica", "Pista dupla: rodovia principal com as duas pistas desenhadas separadas no mapa; não vê canteiro central mal desenhado. Dados do OpenStreetMap, sem garantia: vale a estrada."));
    const bot = el("div", "linha-botoes");
    bot.append(botao("Voltar", "btn", () => voltar()));
    nos.push(bot);
    C.folha.abrir(nos);
    if (f) f.scrollTop = 0;
  }
  function voltar() {
    apagarDestaque();
    const ant = folhaAnterior; folhaAnterior = null;
    if (ant && ant.length) C.folha.abrir(ant); else C.folha.fechar();
    const e = entradas.get(selecionada); if (e) setTimeout(() => (C.rotaLonga && C.rotaLonga.enquadrar ? C.rotaLonga.enquadrar(e.coords) : 0), 80);
  }
  // Folha pequena: o trecho destacado no mapa, enquadrado na parte livre
  function verNoMapa(e, r, t, tipo, titulo) {
    destacar(e, t, tipo);
    const bot = el("div", "linha-botoes");
    bot.append(botao("Voltar à lista", "btn", () => { apagarDestaque(); abrirDetalhe(r); }), botao("Fechar", "btn", () => { apagarDestaque(); folhaAnterior = null; voltarSemAbrir(); }));
    C.folha.abrir([el("h2", null, titulo), el("p", null, "a " + kmTxt(t.kmIni) + " da origem · " + kmTxt(t.km) + " · " + (tipo === "terra" ? "marrom tracejado" : tipo === "ruim" ? "laranja tracejado" : tipo === "subida" ? "roxo tracejado" : "verde-água tracejado")), bot]);
    enquadrarTrecho(e, t);
  }
  function voltarSemAbrir() { C.folha.fechar(); }

  C.aoIniciar(() => {
    C.on("rota", (r) => {
      if (!r || !r.coords) return;
      if (blocoVivo && blocoVivo.bloco.isConnected && blocoVivo.rota !== r) { blocoVivo.rota = r; blocoVivo.montar(r); return; }
      const e = entradas.get(chaveDe(r));
      selecionada = e ? e.chave : null;
      if (e && e.estado === "ok") desenharTrechos(e); else limparTrechos();
    });
    C.on("rota-limpa", () => { selecionada = null; folhaAnterior = null; limparTrechos(); apagarDestaque(); });
    // o SNV (ui/avisos.js) chegou: o cartão "Via do trajeto" passa a mostrar pista/pavimento oficiais
    C.on("dados:rota", (d) => { if (d && d.parte === "snv") for (const e of entradas.values()) if (e.chave === selecionada) avisar(e); });
  });

  C.via = { obter, modo, tentarDeNovo, abrirDetalhe, resumoDe: (r) => { const e = obter(r); return e.estado === "ok" ? e.resumo : null; },
    estado: (r) => obter(r).estado, entradas };
})(window.Copiloto);
