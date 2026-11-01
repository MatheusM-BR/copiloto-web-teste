// Fachada na chegada (equipe C do redesenho). Navegando, a ~100 m do destino (evento "navegacao", restante_m), mostra
// UMA vez por viagem um cartão compacto para o motorista se posicionar:
//  (a) foto de rua do Mapillary perto do destino e virada para ele — só com MAPILLARY_TOKEN em config.js e internet; ou
//  (b) sem token, sem foto, sem internet ou foto com erro: mapa pequeno com zoom alto, prédios 3D (camada "building" do
//      OpenFreeMap extrudada) e o pino do destino, virado no rumo de chegada.
// Sempre com "Destino à direita/esquerda/à frente" (fachada.js). Toque fecha; some na chegada/encerramento.
// O cartão fica à esquerda, abaixo do painel de manobra e do alerta, acima do velocímetro e do "Recentralizar" e fora da
// coluna de botões do mapa.
// Liga/desliga: copiloto.fachada.v1 = { ligada } (padrão ligada). As Configurações (equipe A) usam Copiloto.fachada.
(function (C) {
  "use strict";
  const F = window.CopilotoFachada;
  const { $, el } = C.util;
  const ESTILO_PADRAO = "https://tiles.openfreemap.org/styles/liberty";
  const TEMPO_FOTO_MS = 6000;

  const gatilho = F.criarGatilho({ limiteM: F.LIMITE_M });
  let cartao = null, miniMapa = null, pedidoFoto = null, estado = null;

  function storage() { return C.util.storage(); }
  function ligada() { return F.lerPreferencia(storage()).ligada; }
  function definir(v) {
    F.gravarPreferencia(storage(), !!v);
    if (!v) fechar();
    C.emit("fachada:preferencia", { ligada: !!v });
    return !!v;
  }
  function token() { return (window.CopilotoConfig && window.CopilotoConfig.MAPILLARY_TOKEN) || ""; }

  // Destino desta navegação: o escolhido no mapa (C.rota.destino()) se fica perto do fim da linha; senão o fim da linha
  // (volta pela mesma rota, rota guardada).
  function destinoDa(coords) {
    const fim = Array.isArray(coords) && coords.length ? { lat: coords[coords.length - 1][1], lon: coords[coords.length - 1][0] } : null;
    const d = C.rota && C.rota.destino ? C.rota.destino() : null;
    if (d && isFinite(d.lat) && isFinite(d.lon) && (!fim || F.distanciaM(d, fim) <= 200)) return { lat: d.lat, lon: d.lon };
    return fim;
  }

  // ------------------------------------------------------------ posição do cartão (não cobre manobra, alerta, velocímetro, botões)
  function visivel(e) { return !!e && !e.hidden && e.getClientRects().length > 0 && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden"; }
  function posicionar() {
    if (!cartao) return;
    const main = cartao.parentNode.getBoundingClientRect();
    let topo = 8, base = main.height - 8, direita = 12;
    for (const id of ["nav-painel", "alerta"]) {
      const e = $(id); if (visivel(e)) topo = Math.max(topo, e.getBoundingClientRect().bottom - main.top + 8);
    }
    for (const e of [document.querySelector(".velocidade"), $("btn-recentralizar")]) {
      if (visivel(e)) base = Math.min(base, e.getBoundingClientRect().top - main.top - 8);
    }
    // coluna de botões: o cartão termina antes do botão mais à esquerda que fica na faixa de altura do cartão
    for (const b of document.querySelectorAll(".acoes > *")) {
      if (!visivel(b)) continue;
      const r = b.getBoundingClientRect();
      if (r.bottom - main.top < topo || r.top - main.top > base) continue;
      direita = Math.max(direita, main.right - r.left + 8);
    }
    const largura = Math.max(160, main.width - 8 - direita);
    const altura = Math.max(0, Math.min(240, base - topo));
    cartao.style.top = topo + "px";
    cartao.style.left = "8px";
    cartao.style.width = largura + "px";
    cartao.style.height = altura + "px";
    cartao.hidden = altura < 90; // sem espaço (celular deitado com tudo aberto): não tapa nada
    if (miniMapa) { try { miniMapa.resize(); } catch (e) { /* ignora */ } }
  }

  // ------------------------------------------------------------ cartão
  function mostrar(destino, coords) {
    fechar();
    const lado = F.ladoDaRua({ coords, destino, posicao: C.estado.gps, rumo: C.estado.gps ? C.estado.gps.rumo : null });
    const rumo = F.rumoChegada(coords);
    cartao = el("div", "fachada-cartao"); cartao.id = "fachada-cartao";
    cartao.setAttribute("role", "button"); cartao.tabIndex = 0;
    cartao.setAttribute("aria-label", F.textoLado(lado) + ". Toque para fechar.");
    const topo = el("div", "fachada-topo");
    topo.append(el("span", "fachada-lado lado-" + (lado || "frente"), (lado === "direita" ? "➡ " : lado === "esquerda" ? "⬅ " : "⬆ ") + F.textoLado(lado)),
      el("span", "fachada-fechar", "✕"));
    const corpo = el("div", "fachada-corpo"); corpo.id = "fachada-corpo";
    cartao.append(topo, corpo);
    cartao.addEventListener("click", () => { fechar(); });
    const main = $("mapa").parentNode;
    main.appendChild(cartao);
    estado = { modo: null, lado, destino, foto: null };
    posicionar();
    const tk = token();
    if (tk && navigator.onLine !== false) buscarFoto(tk, destino, corpo, rumo);
    else mostrar3D(corpo, destino, rumo);
    C.emit("fachada:aberta", { lado, destino });
  }

  async function buscarFoto(tk, destino, corpo, rumo) {
    estado.modo = "buscando";
    corpo.append(el("div", "fachada-espera", "Procurando foto da rua…"));
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const meu = pedidoFoto = { ctl };
    const t = setTimeout(() => { if (ctl) ctl.abort(); }, TEMPO_FOTO_MS);
    let foto = null;
    try {
      const r = await fetch(F.urlMapillary(tk, destino), { signal: ctl ? ctl.signal : undefined });
      if (r.ok) foto = F.melhorFoto(await r.json(), destino);
    } catch (e) { foto = null; } finally { clearTimeout(t); }
    if (pedidoFoto !== meu || !cartao) return; // fechou enquanto esperava
    pedidoFoto = null;
    corpo.textContent = "";
    if (!foto) { mostrar3D(corpo, destino, rumo); return; }
    const img = new Image();
    img.className = "fachada-foto"; img.alt = "Foto da rua perto do destino"; img.decoding = "async";
    img.addEventListener("error", () => { if (cartao && estado && estado.modo === "foto") { corpo.textContent = ""; mostrar3D(corpo, destino, rumo); } });
    img.src = foto.thumb_1024_url;
    const credito = el("a", "fachada-credito", "© Mapillary");
    credito.href = "https://www.mapillary.com/app/?pKey=" + encodeURIComponent(foto.id); credito.target = "_blank"; credito.rel = "noopener";
    credito.addEventListener("click", (ev) => ev.stopPropagation()); // abrir o crédito não fecha o cartão
    corpo.append(img, credito);
    estado.modo = "foto"; estado.foto = foto.id;
    C.emit("fachada:modo", { modo: "foto", foto: foto.id });
  }

  function estiloDoMapa() {
    try { const s = C.mapa && C.mapa.getStyle && C.mapa.getStyle(); if (s && s.version) return JSON.parse(JSON.stringify(s)); } catch (e) { /* ainda carregando */ }
    return ESTILO_PADRAO;
  }
  function mostrar3D(corpo, destino, rumo) {
    estado.modo = "3d";
    const caixa = el("div", "fachada-mapa"); caixa.id = "fachada-mapa";
    corpo.append(caixa);
    try {
      miniMapa = new maplibregl.Map({
        container: caixa, style: estiloDoMapa(), center: [destino.lon, destino.lat], zoom: 17.6, pitch: 60,
        bearing: rumo == null ? 0 : rumo, interactive: false, attributionControl: false, fadeDuration: 0,
      });
      // crédito do mapa em uma linha pequena (o controle do MapLibre abre por cima da imagem num cartão estreito)
      corpo.append(el("span", "fachada-credito", "© OpenFreeMap · OpenMapTiles · OpenStreetMap"));
      const m = miniMapa;
      m.on("load", () => { if (miniMapa === m) predios3D(m); });
      const pino = el("div", "fachada-pino-marca"); // o MapLibre posiciona por transform: o giro fica no filho
      pino.append(el("div", "fachada-pino"));
      new maplibregl.Marker({ element: pino, anchor: "bottom" }).setLngLat([destino.lon, destino.lat]).addTo(m);
    } catch (e) {
      miniMapa = null;
      caixa.append(el("div", "fachada-espera", "Mapa indisponível."));
    }
    C.emit("fachada:modo", { modo: "3d" });
  }
  // Prédios 3D: se o estilo já tem uma camada de extrusão de "building", só mostra; senão cria a nossa.
  function predios3D(m) {
    try {
      const st = m.getStyle();
      const fonte = st && st.sources && st.sources.openmaptiles ? "openmaptiles" : null;
      const ja = (st.layers || []).find((l) => l.type === "fill-extrusion" && l["source-layer"] === "building");
      if (ja) { m.setLayoutProperty(ja.id, "visibility", "visible"); estado && (estado.predios = ja.id); return; }
      if (!fonte) return;
      m.addLayer({ id: "fachada-predios", type: "fill-extrusion", source: fonte, "source-layer": "building", minzoom: 14,
        paint: { "fill-extrusion-color": "#c9c1b4", "fill-extrusion-opacity": 0.9,
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0] } });
      if (estado) estado.predios = "fachada-predios";
    } catch (e) { /* estilo sem prédios: fica o mapa com o pino */ }
  }

  function fechar() {
    if (pedidoFoto && pedidoFoto.ctl) { try { pedidoFoto.ctl.abort(); } catch (e) { /* ignora */ } }
    pedidoFoto = null;
    if (miniMapa) { try { miniMapa.remove(); } catch (e) { /* ignora */ } miniMapa = null; }
    if (cartao) { cartao.remove(); cartao = null; C.emit("fachada:fechada", {}); }
    estado = null;
  }

  C.aoIniciar(() => {
    C.carregarEstilo("estilos/fachada.css");
    C.on("navegacao", (d) => {
      if (!d || !d.ativa) { gatilho.avaliar({ ativa: false }); fechar(); return; }
      const destino = destinoDa(d.coords);
      if (!destino) return;
      const vai = gatilho.avaliar({ ativa: true, restanteM: d.restante_m, chave: F.chaveDestino(destino) });
      if (vai && ligada()) mostrar(destino, d.coords);
      else if (cartao) posicionar();
    });
    for (const ev of ["alerta", "alerta-fechado", "folha"]) C.on(ev, () => { if (cartao) setTimeout(posicionar, 0); });
    window.addEventListener("resize", () => { if (cartao) posicionar(); });
  });

  C.fachada = {
    ligada, definir, fechar,
    aberta: () => !!cartao,
    // { modo: "buscando" | "foto" | "3d", lado, destino, foto, predios } ou null (para os testes e a equipe A)
    estado: () => (estado ? Object.assign({}, estado) : null),
    miniMapa: () => miniMapa,
  };
})(window.Copiloto);
