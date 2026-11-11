// Postos e autonomia — pacote E2. Lógica pura em postos.js e autonomia.js.
// - Mapa: postos a partir do zoom 11, buscados pela área visível (com espera entre buscas).
// - "Postos à frente" na busca (ui/busca.js; e o comando de voz "comando:proximo-posto"): 5 postos À FRENTE — na rota ativa
//   se houver, senão pelo rumo do GPS — com distância, bandeira e atributos conhecidos ou "não informado".
// - Autonomia: litros de agora (opcional) × consumo do veículo → alcance estimado; marca postos fora do alcance.
// API pública (anônima): copiloto_stations_near / copiloto_stations_along_route (docs/API_RELATOS.md, seção Postos).
// Expõe Copiloto.postos: abrirProximo(), buscarProximos(), naVista(). Emite "postos:lista" e "postos:destino".
(function (C) {
  "use strict";
  const { el, botao, lerJSON, gravarJSON } = C.util;
  const P = window.CopilotoPostos, A = window.CopilotoAutonomia, IC = window.CopilotoIcones;
  const CHAVE_FILTROS = "copiloto.postos.filtros.v1", CHAVE_BANDEIRAS = "copiloto.postos.bandeiras.v1", CHAVE_ERROS = "copiloto.postos.erros.v1";
  const ic = (nome, rotulo, classe) => (IC ? IC.no(nome, { rotulo, classe }) : document.createTextNode(""));
  const ESPERA_MS = 800;          // espera depois de mexer no mapa antes de buscar
  const INTERVALO_MIN_MS = 2500;  // no máximo uma busca de área a cada 2,5 s
  const CREDITO = "Postos: cadastro da ANP e © OpenStreetMap contributors (ODbL).";

  let vistaBuscada = null, timerVista = null, ultimaBuscaVista = 0, buscandoVista = false;
  let naVista = [];               // postos da área visível (camada do mapa)
  let lista = [];                 // última lista "próximo posto"
  let modoLista = null;           // "rota" | "rumo" | "perto"
  let litrosTexto = "";           // o que o motorista digitou nesta abertura (não fica guardado)
  // último filtro lembrado (R5): só chaves conhecidas e booleanas
  let filtros = (function () {
    const b = { diesel: false, caminhao: false, h24: false, banho: false, aberto: false, barato: false }, g = lerJSON(CHAVE_FILTROS, null);
    if (g && typeof g === "object") for (const k of Object.keys(b)) b[k] = g[k] === true;
    return b;
  })();
  // bandeiras escolhidas no filtro (R6): lista de grupos de P.GRUPOS_BANDEIRA; vazia = todas
  let bandeiras = (function () {
    const g = lerJSON(CHAVE_BANDEIRAS, null), validos = P.GRUPOS_BANDEIRA.map((x) => x[0]);
    return Array.isArray(g) ? validos.filter((k) => g.includes(k)) : [];
  })();
  const temFiltro = () => Object.keys(filtros).some((k) => filtros[k]) || bandeiras.length > 0;
  let seqBusca = 0;

  // ------------------------------------------------------------ API (anônima: só a chave publicável)
  async function rpc(nome, params, bruto) {
    const cfg = window.CopilotoConfig;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(cfg.url + "/rest/v1/rpc/" + nome, {
        method: "POST", headers: { "content-type": "application/json", apikey: cfg.chave }, body: JSON.stringify(params), signal: ctl.signal,
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) { const e = new Error((j && j.message) || "Erro ao buscar postos."); e.code = j && j.code; throw e; }
      return bruto ? j : (Array.isArray(j) ? j : []);
    } catch (e) {
      if (e.name === "AbortError" || e instanceof TypeError) { const x = new Error("Sem conexão para buscar postos."); x.rede = true; throw x; }
      throw e;
    } finally { clearTimeout(t); }
  }

  // ------------------------------------------------------------ preço POR POSTO (ANP)
  // station_key → { diesel_s10: {preco, dia, idade, fonte}, … } ({} = consultado, sem coleta recente). Vale 30 min na sessão.
  const precosPosto = new Map(), precosQuando = new Map();
  async function carregarPrecos(postos) {
    const chaves = [...new Set((postos || []).map((p) => p && p.station_key).filter((k) => typeof k === "string" && /^anp:\d+$/.test(k)))]
      .filter((k) => !(precosQuando.has(k) && Date.now() - precosQuando.get(k) < 30 * 60 * 1000));
    for (let i = 0; i < chaves.length; i += 60) {
      const lote = chaves.slice(i, i + 60);
      try {
        const resp = await rpc("copiloto_station_prices", { p_station_keys: lote }, true);
        const idx = P.indexarPrecos(resp);
        for (const k of lote) { precosPosto.set(k, idx[k] || {}); precosQuando.set(k, Date.now()); }
      } catch (e) { /* sem rede ou função indisponível: a lista segue sem preço por posto */ }
    }
  }
  function precoDe(p) { return precosPosto.get(p.station_key) || null; }
  function aplicarPrecos() {
    document.querySelectorAll(".postos-preco[data-key]").forEach((el0) => {
      const pr = precosPosto.get(el0.dataset.key);
      const t = pr ? P.textoPrecoLista(pr) : null;
      el0.textContent = t || ""; el0.hidden = !t;
      if (t) { const u = pr.diesel_s10 || pr.diesel_s500; el0.title = "Preço coletado pela ANP neste posto em " + (u.dia || "data sem informação") + (u.idade != null ? " (" + P.textoIdade(u.idade) + ")" : ""); }
    });
  }

  // ------------------------------------------------------------ camada do mapa
  // Uma cor só para todo posto (antes: verde = cadastro ANP, azul-acinzentado = só OpenStreetMap, sem legenda: ninguém sabia o que era).
  // A fonte aparece no detalhe do posto. Posto é conveniência: cor própria, que não se confunde com a rota (azul) nem com os avisos (amarelo).
  const COR_POSTO = "#14b8a6";
  function garantirCamada() {
    const mapa = C.mapa;
    if (mapa.getSource("postos-pontos")) return;
    mapa.addSource("postos-pontos", { type: "geojson", data: P.paraGeoJSON([]), attribution: "© OpenStreetMap contributors · Cadastro ANP" });
    mapa.addLayer({ id: "postos-pontos", type: "circle", source: "postos-pontos", minzoom: P.ZOOM_MINIMO,
      paint: { "circle-radius": 7, "circle-stroke-width": 2, "circle-stroke-color": "#14181f",
        "circle-color": COR_POSTO } });
    mapa.on("click", "postos-pontos", (e) => {
      const f = e.features && e.features[0]; if (!f) return;
      const p = naVista.find((x) => x.station_key === f.properties.key);
      if (p) mostrarDetalhe(Object.assign({}, p, { distancia_m: distanciaDaqui(p) }), "perto");
    });
  }

  function agendarVista() {
    clearTimeout(timerVista);
    timerVista = setTimeout(buscarVista, ESPERA_MS);
  }
  async function buscarVista() {
    const mapa = C.mapa;
    if (!mapa || mapa.getZoom() < P.ZOOM_MINIMO) return;
    const espera = INTERVALO_MIN_MS - (Date.now() - ultimaBuscaVista);
    if (espera > 0 || buscandoVista) { clearTimeout(timerVista); timerVista = setTimeout(buscarVista, Math.max(espera, 300)); return; }
    const b = mapa.getBounds();
    const caixa = { oeste: b.getWest(), sul: b.getSouth(), leste: b.getEast(), norte: b.getNorth() };
    if (!P.precisaBuscar(vistaBuscada, P.buscaDaVista(caixa))) return;
    const vista = P.buscaDaVista(caixa, 1.5);
    buscandoVista = true; ultimaBuscaVista = Date.now();
    try {
      const r = await rpc("copiloto_stations_near", { p_lat: vista.centro.lat, p_lon: vista.centro.lon, p_radius_m: vista.raio, p_limit: 50 });
      naVista = r; vistaBuscada = vista;
      C.mapaPronto(() => { garantirCamada(); mapa.getSource("postos-pontos").setData(P.paraGeoJSON(r)); });
    } catch (e) { /* sem rede: o mapa segue sem postos; a lista avisa quando o motorista pedir */ }
    finally { buscandoVista = false; }
  }

  // ------------------------------------------------------------ próximo posto
  function distanciaDaqui(p) { const g = C.estado.gps; return g ? Math.round(P.distanciaM(g, p)) : null; }
  function rotaAtiva() { const r = C.rota && C.rota.atual(); return r && Array.isArray(r.coords) && r.coords.length > 1 ? r : null; }
  function veiculo() { return C.veiculos ? C.veiculos.ativo() : null; }

  async function buscarProximos() {
    const g = C.estado.gps;
    if (!g) throw Object.assign(new Error("Ative o GPS para saber onde você está."), { semGps: true });
    const quer = temFiltro() ? 50 : 5;
    const rota = rotaAtiva();
    let r;
    if (rota) {
      modoLista = "rota";
      const resp = await rpc("copiloto_stations_along_route", { p_route: P.rotaGeoJSON(rota.coords), p_buffer_m: 300, p_from_lat: g.lat, p_from_lon: g.lon, p_limit: quer });
      r = P.naRota(resp);
    } else {
      modoLista = g.rumo != null ? "rumo" : "perto";
      const resp = await rpc("copiloto_stations_near", { p_lat: g.lat, p_lon: g.lon, p_heading_deg: g.rumo != null ? Math.round(g.rumo) % 360 : null, p_radius_m: 30000, p_limit: quer });
      r = P.aFrentePorRumo(resp, g, g.rumo);
    }
    let fil = P.filtrar(r, Object.assign({}, filtros, { bandeiras, agora: new Date() }));
    if (filtros.barato) {
      await carregarPrecos(fil);
      const idx = {}; for (const p of fil) { const x = precoDe(p); if (x) idx[p.station_key] = x; }
      fil = P.ordenarPorPreco(fil, idx);
    }
    return fil.slice(0, 5);
  }

  function estimativa() {
    const v = veiculo();
    const lit = A.lerLitros(litrosTexto, v ? v.tanque : null);
    if (!lit.ok) return { ok: false, motivo: lit.erro, erroLitros: true };
    return A.alcance(v, lit.valor);
  }

  // opcoes.banho (cronômetro de descanso): abre a lista já com "Só com banho confirmado" ligado, sem gravar o filtro; a
  // próxima abertura sem a opção volta ao filtro que o motorista tinha. Estacionamento não é filtro: a fonte não o confirma.
  let banhoAntes = null;
  function gravarFiltros() { gravarJSON(CHAVE_FILTROS, banhoAntes === null ? filtros : Object.assign({}, filtros, { banho: banhoAntes })); }
  async function abrirProximo(opcoes) {
    litrosTexto = "";
    if (opcoes && opcoes.banho) { if (banhoAntes === null) banhoAntes = filtros.banho; filtros.banho = true; }
    else if (banhoAntes !== null) { filtros.banho = banhoAntes; banhoAntes = null; }
    desenharFolha({ carregando: true });
    await atualizarLista();
  }
  async function atualizarLista() {
    const n = ++seqBusca;
    try {
      const r = await buscarProximos();
      if (n !== seqBusca) return;
      lista = r;
      C.emit("postos:lista", { modo: modoLista, postos: lista });
      desenharFolha({});
      carregarPrecos(lista).then(() => { if (n === seqBusca) aplicarPrecos(); });
    } catch (e) {
      if (n !== seqBusca) return;
      desenharFolha({ erro: e.message });
    }
  }

  function campoLitros() {
    const v = veiculo();
    const caixa = el("div", "postos-autonomia");
    if (!v || v.consumo == null) {
      caixa.appendChild(el("p", "dica", "Alcance: cadastre o tanque e o consumo (km/L) do veículo na aba Veículo."));
      return caixa;
    }
    const lbl = el("label", "postos-litros"); lbl.htmlFor = "postos-litros";
    lbl.append("Litros no tanque agora (opcional)");
    const i = document.createElement("input"); i.id = "postos-litros"; i.inputMode = "decimal"; i.autocomplete = "off";
    i.placeholder = v.tanque != null ? "até " + String(v.tanque).replace(".", ",") : "ex.: 300"; i.value = litrosTexto;
    const linha = el("div", "linha-botoes");
    linha.append(i, botao("Calcular alcance", "btn btn-pequeno", () => { litrosTexto = i.value; desenharFolha({}); }));
    lbl.appendChild(linha);
    caixa.appendChild(lbl);
    const est = estimativa();
    if (litrosTexto.trim()) caixa.appendChild(el("p", est.ok ? "postos-alcance" : "erro", A.textoAlcance(est)));
    return caixa;
  }

  // Filtros "só o que está CONFIRMADO": ícone + palavra curta; o nome completo vai no aria-label. Lembrados entre aberturas.
  const FILTROS = [
    ["diesel", "Diesel", "bomba", "Só com diesel confirmado"],
    ["caminhao", "Caminhão", "caminhao", "Só com acesso de caminhão confirmado"],
    ["h24", "24 h", "h24", "Só abertos 24 horas confirmado"],
    ["banho", "Banho", "banho", "Só com banho confirmado"],
  ];
  function filtrosUi() {
    const f = el("div", "postos-filtros"); f.setAttribute("role", "group"); f.setAttribute("aria-label", "Filtros (só o que a fonte confirma)");
    for (const [chave, rotulo, icone, completo] of FILTROS) {
      const b = el("button", "btn btn-pequeno postos-chip"); b.type = "button"; b.id = "postos-filtro-" + chave;
      b.append(ic(icone), el("span", null, rotulo));
      b.setAttribute("aria-label", completo); b.setAttribute("aria-pressed", String(filtros[chave]));
      b.addEventListener("click", () => {
        if (chave === "banho") banhoAntes = null; filtros[chave] = !filtros[chave]; gravarFiltros();
        desenharFolha({ carregando: true }); atualizarLista();
      });
      f.appendChild(b);
    }
    return f;
  }
  // Segunda linha (R6): "Aberto agora" e bandeira. Rola para o lado se não couber; cada chip tem 64 px de altura.
  function filtrosUi2() {
    const f = el("div", "postos-filtros2"); f.setAttribute("role", "group"); f.setAttribute("aria-label", "Aberto agora e bandeira");
    const refazer = () => { desenharFolha({ carregando: true }); atualizarLista(); };
    const ab = el("button", "btn btn-pequeno postos-chip postos-chip-aberto"); ab.type = "button"; ab.id = "postos-chip-aberto";
    ab.append(ic("relogio"), el("span", null, "Aberto agora"));
    ab.setAttribute("aria-label", "Só abertos agora (horário confirmado)"); ab.setAttribute("aria-pressed", String(filtros.aberto));
    ab.addEventListener("click", () => { filtros.aberto = !filtros.aberto; gravarFiltros(); refazer(); });
    f.appendChild(ab);
    const ba = el("button", "btn btn-pequeno postos-chip postos-chip-barato"); ba.type = "button"; ba.id = "postos-chip-barato";
    ba.append(ic("bomba"), el("span", null, "Menor preço"));
    ba.setAttribute("aria-label", "Ordenar pelo menor preço do diesel (só postos com preço coletado pela ANP nas últimas semanas)"); ba.setAttribute("aria-pressed", String(filtros.barato));
    ba.addEventListener("click", () => { filtros.barato = !filtros.barato; gravarFiltros(); refazer(); });
    f.appendChild(ba);
    for (const [chave, rotulo] of P.GRUPOS_BANDEIRA) {
      const b = el("button", "btn btn-pequeno postos-chip postos-chip-bandeira"); b.type = "button"; b.id = "postos-bandeira-" + chave;
      const amostra = chave === "outras" ? null : P.marcaBandeira(chave === "petrobras" ? "PETROBRAS" : chave.toUpperCase());
      if (amostra) { const l = el("span", "pc-logo", amostra.iniciais); l.style.background = amostra.cor; l.setAttribute("aria-hidden", "true"); b.appendChild(l); }
      else b.appendChild(ic("bandeira"));
      b.appendChild(el("span", null, rotulo));
      b.setAttribute("aria-label", "Bandeira " + rotulo); b.setAttribute("aria-pressed", String(bandeiras.includes(chave)));
      b.addEventListener("click", () => {
        bandeiras = bandeiras.includes(chave) ? bandeiras.filter((x) => x !== chave) : bandeiras.concat(chave);
        gravarJSON(CHAVE_BANDEIRAS, bandeiras); refazer();
      });
      f.appendChild(b);
    }
    return f;
  }

  function titulo() {
    if (modoLista === "rota") return "Próximos postos na rota";
    if (modoLista === "rumo") return "Próximos postos à frente";
    return "Postos mais perto";
  }

  function desenharFolha(o) {
    limparMini();
    // ordem pensada para a tela pequena: título, filtros e os POSTOS primeiro; dicas e litros (opcionais) depois
    const h2 = el("h2", "postos-titulo"); h2.append(ic("bomba"), document.createTextNode(o.carregando ? "Buscando postos…" : titulo()));
    const itens = [h2, filtrosUi(), filtrosUi2()];
    const dicas = [];
    if (!o.carregando && !o.erro && modoLista === "perto") dicas.push(el("p", "dica", "Sem rumo do GPS (parado?): mostrando os mais perto em qualquer direção, em linha reta."));
    if (!o.carregando && !o.erro && modoLista === "rumo") dicas.push(el("p", "dica", "Pelo seu rumo, distância em linha reta. Trace uma rota para ver os postos no caminho."));
    if (o.erro) itens.push(el("p", "erro", o.erro));
    else if (!o.carregando) {
      const est = estimativa();
      const km = est.ok ? est.km : null;
      const marcados = A.marcar(lista, km);
      if (!marcados.length) itens.push(el("p", null, temFiltro()
        ? "Nenhum posto à frente com esse filtro confirmado. Desligue o filtro para ver os que não informam."
        : "Nenhum posto encontrado à frente nos próximos 30 km."));
      if (marcados.length) itens.push(blocoMediaLista(marcados[0]));
      const ul = el("ul", "postos-lista"); ul.id = "postos-lista";
      const prox = P.proximoComDiesel(marcados);
      for (const p of marcados) ul.appendChild(itemPosto(p, prox && prox.station_key === p.station_key));
      if (marcados.length) itens.push(ul);
    }
    itens.push(...dicas, campoLitros());
    itens.push(el("p", "dica postos-credito", CREDITO));
    const b = el("div", "linha-botoes");
    const ver = botao("Ver no mapa os postos (50 km)", "btn postos-ver-mapa", verPostosNoMapa); ver.id = "postos-ver-mapa";
    b.append(ver, botao("Fechar", "btn", C.folha.fechar)); itens.push(b);
    C.folha.abrir(itens);
    $folha().scrollTop = 0;
  }

  // "Ver no mapa os postos (50 km)": com rota, os que estão na via (a até 1 km do traçado) nos próximos 50 km; sem rota, todos a até
  // 50 km em volta. Aparecem no mapa de qualquer zoom (camada própria até o zoom 11, onde a camada normal assume), o mapa enquadra
  // tudo e cada ponto abre o posto. Os pontos saem quando o motorista pede de novo ou limpa a rota.
  const MAX_VER_M = 50000;
  function garantirCamada50() {
    const mapa = C.mapa;
    if (mapa.getSource("postos-50km")) return;
    mapa.addSource("postos-50km", { type: "geojson", data: P.paraGeoJSON([]), attribution: "© OpenStreetMap contributors · Cadastro ANP" });
    mapa.addLayer({ id: "postos-50km", type: "circle", source: "postos-50km", maxzoom: P.ZOOM_MINIMO,
      paint: { "circle-radius": 8, "circle-stroke-width": 2, "circle-stroke-color": "#14181f", "circle-color": COR_POSTO } });
    mapa.on("click", "postos-50km", (e) => {
      const f = e.features && e.features[0]; if (!f) return;
      const p = ver50.find((x) => x.station_key === f.properties.key);
      if (p) mostrarDetalhe(Object.assign({}, p, { distancia_m: distanciaDaqui(p) }), modoVer);
    });
  }
  let ver50 = [], modoVer = "perto";
  function tirarPostos50() {
    ver50 = [];
    try { const src = C.mapa && C.mapa.getSource("postos-50km"); if (src) src.setData(P.paraGeoJSON([])); } catch (e) { /* mapa trocando de estilo */ }
  }
  async function verPostosNoMapa() {
    const g = C.estado.gps;
    if (!g) { C.mensagem("Ative o GPS para ver os postos perto de você.", 5000); return; }
    C.mensagem("Buscando postos em 50 km…", 4000);
    try {
      const rota = rotaAtiva();
      let r;
      if (rota) {
        modoVer = "rota";
        const resp = await rpc("copiloto_stations_along_route", { p_route: P.rotaGeoJSON(rota.coords), p_buffer_m: 1000, p_from_lat: g.lat, p_from_lon: g.lon, p_limit: 50 });
        r = P.naRota(resp).filter((p) => p.along_route_m == null || p.along_route_m <= MAX_VER_M);
      } else {
        modoVer = "perto";
        r = await rpc("copiloto_stations_near", { p_lat: g.lat, p_lon: g.lon, p_heading_deg: null, p_radius_m: MAX_VER_M, p_limit: 50 });
      }
      r = (Array.isArray(r) ? r : []).filter((p) => isFinite(p.lat) && isFinite(p.lon));
      if (!r.length) { C.mensagem(rota ? "Nenhum posto na via nos próximos 50 km." : "Nenhum posto a até 50 km.", 6000); return; }
      ver50 = r;
      C.folha.fechar();
      C.mapaPronto(() => {
        garantirCamada50(); C.mapa.getSource("postos-50km").setData(P.paraGeoJSON(r));
        const lons = r.map((p) => p.lon).concat(g.lon), lats = r.map((p) => p.lat).concat(g.lat);
        const alto = Math.round((document.getElementById("barra-topo") || { offsetHeight: 90 }).offsetHeight + 40);
        C.mapa.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: { top: alto, bottom: 150, left: 40, right: 40 }, maxZoom: 12, duration: 600 });
      });
      C.mensagem(r.length + (r.length === 1 ? " posto" : " postos") + (rota ? " na via, nos próximos 50 km." : " em 50 km.") + " Toque num para ver.", 7000);
    } catch (e) {
      C.mensagem(e && e.rede ? "Sem conexão para buscar postos." : "Não deu para buscar os postos agora.", 6000);
    }
  }
  const $folha = () => document.getElementById("folha");

  function textoDistancia(p) {
    return "a " + P.formatarDistancia(p.distancia_m) + (modoLista === "rota" ? " pela rota" : " em linha reta");
  }
  function logoBandeira(p, grande) {
    const m = P.marcaBandeira(p.brand);
    const l = el("span", "pc-logo" + (grande ? " pc-logo-grande" : ""), m.iniciais);
    l.style.background = m.cor; l.setAttribute("aria-hidden", "true");
    return l;
  }
  const dica = (t) => el("span", "so-leitor", t);
  // confiança da posição/cadastro em estrelas (1 a 3); o texto completo fica no aria-label e no title
  function estrelas(p, classe) {
    const n = P.estrelasConfianca(p), r = P.rotuloConfianca(p);
    const e = el("span", classe || "pc-estrelas", "★".repeat(n) + "☆".repeat(3 - n));
    e.setAttribute("role", "img"); e.setAttribute("aria-label", "Confiança " + n + " de 3: " + r); e.title = r;
    return e;
  }
  // selo de abertura: símbolo verde (aberto), vermelho (fechado) ou cinza (sem horário que eu entenda)
  function seloAbertura(p, completo) {
    const s = P.situacaoAbertura(p, new Date());
    const e = el("span", "pc-abertura ab-" + (s.estado === "?" ? "desc" : s.estado));
    e.dataset.estado = s.estado; e.title = s.texto;
    e.append(ic(s.icone, null, "pc-ab-ico"));
    if (completo) e.appendChild(el("span", null, s.texto)); else e.appendChild(el("span", "so-leitor", s.texto));
    return e;
  }

  // Desvio estimado em minutos (ida e volta pelo acesso, 30 km/h) com o símbolo do relógio; "na pista" quando o posto é à beira dela.
  // Só com rota (off_route_m): pelo rumo não há "pista" para medir.
  function chipDesvio(p) {
    const d = window.CopilotoRotaPref ? window.CopilotoRotaPref.desvioPosto(p.off_route_m) : null;
    if (!d) return null;
    const c = el("span", "postos-desvio" + (d.min === 0 ? " pista" : "")); c.dataset.min = String(d.min);
    c.append(ic(d.min === 0 ? "ok" : "relogio"), document.createTextNode(d.texto));
    c.setAttribute("aria-label", d.aria); c.title = d.aria;
    return c;
  }

  // Item da lista: logo, nome, distância em destaque, ícones só do que está CONFIRMADO. Texto completo para o leitor de tela.
  function itemPosto(p, proximo) {
    const li = document.createElement("li"); li.className = "postos-cartao";
    const b = document.createElement("button"); b.type = "button";
    b.className = "postos-item" + (p.alcance ? " alcance-" + p.alcance : "") + (proximo ? " postos-proximo" : ""); b.dataset.key = p.station_key;
    const r = P.resumoAtributos(p.attributes);
    const corpo = el("span", "postos-corpo");
    const topo = el("span", "postos-topo");
    const nome = el("span", "postos-nome", P.nomePosto(p));
    const dist = el("span", "postos-dist"); dist.setAttribute("aria-hidden", "true");
    dist.append(ic(modoLista === "rota" ? "rota" : "reta"), document.createTextNode(P.formatarDistancia(p.distancia_m)),
      el("small", "postos-dist-rot", modoLista === "rota" ? "à frente" : "em linha reta"));
    topo.append(nome, dist);
    const dv = modoLista === "rota" ? chipDesvio(p) : null;
    if (dv) topo.appendChild(dv);
    const marca = el("span", "postos-marca"); marca.setAttribute("aria-hidden", "true");
    marca.append(document.createTextNode(P.nomeBandeira(p.brand) + " "), estrelas(p, "postos-estrelas"));
    const icones = el("span", "postos-icones"); icones.setAttribute("aria-hidden", "true");
    const sim = P.amenidadesSim(p.attributes);
    for (const x of sim) { const am = el("span", "postos-am"); am.append(ic(x.icone, null, "ico-sim"), el("span", null, x.rotulo)); icones.appendChild(am); }
    if (!sim.length) icones.append(ic("ajuda", null, "ico-desc"), el("span", "postos-sem", "sem informação"));
    const ab = P.situacaoAbertura(p, new Date());
    if (ab.estado !== "?") icones.appendChild(seloAbertura(p, false));
    const desv = modoLista === "rota" ? P.desvioMin(p) : null;
    if (desv) { const dv = el("span", "postos-desvio"); dv.append(ic("relogio"), document.createTextNode(desv + " min")); dv.title = "Desvio estimado de cerca de " + desv + " min"; icones.appendChild(dv); }
    const preco = el("span", "postos-preco"); preco.dataset.key = p.station_key; preco.hidden = true;
    corpo.append(topo, preco, marca, icones);
    b.append(logoBandeira(p), corpo);
    if (proximo) { const t = el("span", "postos-selo"); t.append(ic("ok"), document.createTextNode("Próximo com diesel")); b.appendChild(t); }
    // texto para o leitor de tela (e fonte do que o motorista vê em ícones): nada some, só deixa de ocupar a tela
    b.append(dica(textoDistancia(p) + " · " + P.nomeBandeira(p.brand) + " · " + ab.texto + (desv ? " · desvio de cerca de " + desv + " min" : "") + " · " + P.rotuloConfianca(p)), dica(r.conhecidos.length ? r.conhecidos.join(" · ") : "Serviços: não informados"));
    if (r.conhecidos.length && r.naoInformados.length) b.appendChild(dica("Não informado: " + r.naoInformados.join(", ")));
    const aviso = p.alcance === "fora" ? "Fora do alcance estimado" : p.alcance === "limite" ? "No limite do alcance estimado" : null;
    if (aviso) {
      const av = el("span", p.alcance === "fora" ? "postos-fora" : "postos-limite");
      av.append(ic("aviso"), document.createTextNode(aviso));
      b.appendChild(av);
    }
    b.addEventListener("click", () => mostrarDetalhe(p, modoLista));
    li.appendChild(b);
    // "Adicionar parada": com rota entra como parada (destino mantido; navegando, pergunta antes); sem rota o posto vira o destino
    const add = botao("", "btn postos-add", () => irPara(p)); add.dataset.key = p.station_key;
    add.append(ic(temRota() ? "parada" : "ir"), el("span", null, temRota() ? "Adicionar parada" : "Ir até lá"));
    add.setAttribute("aria-label", (temRota() ? "Adicionar parada: " : "Ir até lá: ") + P.nomePosto(p));
    li.appendChild(add);
    return li;
  }

  // Diesel na lista: SÓ a média ANP da região (uma consulta, pelo 1º posto), rotulada. Nunca como preço de um posto.
  function blocoMediaLista(p) {
    const caixa = el("p", "postos-media dica"); caixa.id = "postos-media"; caixa.hidden = true;
    precoDaRegiao(p, "diesel_s10").then((r) => P.precoDaRegiao(r, "Diesel S10"), () => null).then((x) => {
      if (!caixa.isConnected || !x || !x.ok) return;
      caixa.textContent = "Diesel S10, média ANP da região (" + x.uf + ")" + (x.semana ? ", semana de " + x.semana : "") + ": " + P.formatarReais(x.preco) + "/L. Não é o preço de cada posto.";
      caixa.hidden = false;
    });
    return caixa;
  }

  // ------------------------------------------------------------ card do posto (R5)
  const precoCache = new Map();   // station_key|produto → Promise (a mesma resposta serve ao reabrir o card)
  function precoDaRegiao(p, produto) {
    const k = p.station_key + "|" + produto;
    if (!precoCache.has(k)) {
      const r = rpc("copiloto_route_fuel_price", { p_route: P.linhaDoPosto(p), p_product: produto }, true);
      r.catch(() => precoCache.delete(k)); // erro de rede não fica guardado
      precoCache.set(k, r);
    }
    return precoCache.get(k);
  }
  function blocoPreco(p) {
    const caixa = el("section", "pc-preco"); caixa.id = "postos-preco";
    const cab = el("h3", "pc-sub"); cab.append(ic("bomba"), document.createTextNode("Preço do diesel"));
    const valores = el("div", "pc-valores");
    valores.appendChild(el("p", "pc-linha", "Buscando o preço médio da região…"));
    const fonte = el("p", "dica pc-data"); fonte.id = "postos-datas";
    const doPosto = el("div", "pc-posto"); doPosto.id = "postos-preco-posto"; doPosto.hidden = true;
    const sem = el("p", "dica pc-sem", "Sem preço deste posto: a ANP só informa a média da região.");
    caixa.append(cab, doPosto, valores, fonte, sem);
    carregarPrecos([p]).then(() => {
      if (!caixa.isConnected) return;
      const pr = precoDe(p);
      if (!pr || !(pr.diesel_s10 || pr.diesel_s500)) return;
      doPosto.textContent = "";
      doPosto.appendChild(el("p", "pc-linha pc-neste", "Neste posto"));
      let ref = null;
      for (const [k, nome] of [["diesel_s10", "Diesel S10"], ["diesel_s500", "Diesel S500"]]) {
        if (!pr[k]) continue;
        ref = ref || pr[k];
        const c = el("p", "pc-valor"); c.append(el("span", "pc-prod", nome), el("strong", null, P.formatarReais(pr[k].preco) + "/L"));
        doPosto.appendChild(c);
      }
      doPosto.appendChild(el("p", "dica pc-data-posto", "Preço coletado pela ANP neste posto em " + (ref.dia || "data sem informação") + (ref.idade != null ? " (" + P.textoIdade(ref.idade) + ")" : "") + ". Pode ter mudado desde então."));
      doPosto.hidden = false; sem.hidden = true;
    });
    const prod = [["diesel_s10", "Diesel S10"], ["diesel_s500", "Diesel S500"]];
    Promise.all(prod.map(([k, nome]) => precoDaRegiao(p, k).then((r) => P.precoDaRegiao(r, nome), () => null))).then((res) => {
      if (!caixa.isConnected) return;
      valores.textContent = "";
      if (res.every((x) => x === null)) {
        valores.appendChild(el("p", "pc-linha", "Preço médio da região: sem informação agora (sem conexão com o servidor)."));
        fonte.textContent = "Preço ANP: data sem informação."; return;
      }
      const ref = res.find((x) => x && x.ok);
      res.forEach((x, i) => {
        const c = el("p", "pc-valor");
        if (x && x.ok) c.append(el("span", "pc-prod", prod[i][0] === "diesel_s10" ? "Diesel S10" : "Diesel S500"), el("strong", null, P.formatarReais(x.preco) + "/L"));
        else c.append(el("span", "pc-prod", prod[i][1]), el("strong", "pc-vazio", "sem preço da região"));
        valores.appendChild(c);
      });
      fonte.textContent = ref ? "Preço médio da região (" + ref.uf + ") · ANP" + (ref.semana ? ", semana de " + ref.semana : ", semana sem informação") + "."
        : "Preço ANP: sem informação para esta região.";
    });
    return caixa;
  }

  const ESTADO_ROTULO = { sim: "tem", nao: "não tem", "?": "sem informação" };
  function celula(a) {
    const li = el("li", "pc-amen pc-" + (a.estado === "sim" ? "sim" : a.estado === "nao" ? "nao" : "desc") + (a.estado === "?" ? " nao-informado" : ""));
    const ico = el("span", "pc-amen-ico"); ico.setAttribute("aria-hidden", "true");
    ico.appendChild(ic(a.icone));
    ico.appendChild(a.estado === "sim" ? ic("ok", null, "pc-selo") : a.estado === "nao" ? ic("fechar", null, "pc-selo") : el("span", "pc-selo pc-selo-q", "?"));
    const rot = el("span", "pc-amen-rot", a.rotulo); rot.setAttribute("aria-hidden", "true");
    const est = el("span", "pc-amen-estado", a.estado === "sim" ? "Tem" : a.estado === "nao" ? "Não tem" : "?"); est.setAttribute("aria-hidden", "true");
    li.append(ico, rot, est, el("span", "so-leitor", a.rotulo + ": " + a.texto));
    return li;
  }
  function blocoComodidades(p) {
    const todas = P.descreverAmenidades(p.attributes);
    const grade = el("ul", "pc-grade postos-atributos"); grade.id = "postos-atributos";
    for (const a of todas.filter((x) => x.real || x.estado !== "?")) grade.appendChild(celula(a));
    const sec = el("section", "pc-comod");
    const cab = el("h3", "pc-sub", "Comodidades"); sec.append(cab, grade);
    const horario = P.dadosDoPosto(p).horario;
    const h = el("p", "pc-linha pc-horario"); h.append(ic("relogio"), document.createTextNode("Horário: " + (horario || "não informado")));
    sec.appendChild(h);
    const faltam = todas.filter((x) => !x.real && x.estado === "?");
    if (faltam.length) {
      const f = el("p", "pc-semfonte"); f.setAttribute("aria-label", "Sem informação na fonte: " + faltam.map((x) => x.rotulo.toLowerCase()).join(", "));
      const icos = el("span", "pc-semfonte-icos"); icos.setAttribute("aria-hidden", "true");
      for (const x of faltam) icos.appendChild(ic(x.icone));
      f.append(icos, el("span", null, "Sem informação na fonte: " + faltam.map((x) => x.rotulo.toLowerCase()).join(", ")));
      sec.appendChild(f);
    }
    const leg = el("p", "dica pc-legenda"); leg.append(ic("ok"), "tem ", ic("fechar"), "não tem ", el("span", "pc-selo-q-leg", "?"), " sem informação");
    sec.appendChild(leg);
    return sec;
  }

  // Mini-mapa do posto: mesmo estilo do mapa principal, sem interação; sem o mapa (ou sem tiles) fica só o texto de coordenadas.
  let miniPosto = null;
  function limparMini() { try { if (miniPosto) miniPosto.remove(); } catch (e) { /* já saiu */ } miniPosto = null; }
  function blocoMini(p) {
    const sec = el("section", "pc-mini"); sec.id = "postos-mini";
    const caixa = el("div", "pc-minimapa"); caixa.setAttribute("role", "img"); caixa.setAttribute("aria-label", "Mapa com a posição de " + P.nomePosto(p));
    sec.appendChild(caixa);
    sec.appendChild(el("p", "dica pc-mini-fonte", "Posição " + p.lat.toFixed(5).replace(".", ",") + ", " + p.lon.toFixed(5).replace(".", ",") + " · © OpenStreetMap contributors"));
    setTimeout(() => {
      if (!caixa.isConnected || !window.maplibregl) return;
      limparMini();
      try {
        const st = C.mapa && C.mapa.getStyle && C.mapa.getStyle();
        if (!st || !st.version) return;
        miniPosto = new maplibregl.Map({ container: caixa, style: JSON.parse(JSON.stringify(st)), center: [p.lon, p.lat], zoom: 14, interactive: false, attributionControl: false, fadeDuration: 0 });
        const pino = el("div", "pc-mini-pino"); pino.setAttribute("aria-hidden", "true");
        new maplibregl.Marker({ element: pino }).setLngLat([p.lon, p.lat]).addTo(miniPosto);
        const m = miniPosto, t = setInterval(() => { if (!caixa.isConnected || miniPosto !== m) { clearInterval(t); if (miniPosto === m) limparMini(); } }, 1500);
      } catch (e) { miniPosto = null; }
    }, 0);
    return sec;
  }

  function reportarErro(p) {
    const motivos = [["fechado", "Posto fechado ou não existe"], ["local", "Lugar errado no mapa"], ["diesel", "Não tem diesel"], ["outro", "Outro erro"]];
    const itens = [el("h2", null, "O que está errado?"), el("p", null, P.nomePosto(p))];
    const lista = el("div", "pc-motivos");
    for (const [k, t] of motivos) {
      lista.appendChild(botao(t, "btn", () => {
        const l = lerJSON(CHAVE_ERROS, []); const arr = Array.isArray(l) ? l : [];
        arr.push({ key: p.station_key, motivo: k, em: new Date().toISOString() });
        gravarJSON(CHAVE_ERROS, arr.slice(-50));
        C.emit("postos:erro", { key: p.station_key, motivo: k });
        C.folha.abrir([el("h2", null, "Anotado neste aparelho"), el("p", null, "Ainda não há envio de correções de posto ao servidor: a anotação fica só aqui."),
          botao("Voltar ao posto", "btn btn-principal", () => mostrarDetalhe(p, modoLista))]);
      }));
    }
    itens.push(lista, botao("Voltar", "btn", () => mostrarDetalhe(p, modoLista)));
    C.folha.abrir(itens);
  }

  function ligarEsc(raiz, fn) {
    const h = (ev) => { if (!raiz.isConnected) { document.removeEventListener("keydown", h); return; } if (ev.key === "Escape") { ev.preventDefault(); document.removeEventListener("keydown", h); fn(); } };
    document.addEventListener("keydown", h);
  }

  function mostrarDetalhe(p, modo) {
    const raiz = el("article", "posto-card"); raiz.id = "posto-card"; raiz.setAttribute("aria-labelledby", "posto-card-titulo");
    // cabeçalho: logo genérico (iniciais) + nome + bandeira
    const cab = el("header", "pc-cab");
    const tit = el("div", "pc-tit");
    const h2 = el("h2", null, P.nomePosto(p)); h2.id = "posto-card-titulo"; h2.tabIndex = -1;
    const linhaMarca = el("p", "pc-bandeira", P.nomeBandeira(p.brand) + " "); linhaMarca.appendChild(estrelas(p));
    tit.append(h2, linhaMarca);
    cab.append(logoBandeira(p, true), tit);
    raiz.appendChild(cab);
    // distância "à frente" e alcance
    if (p.distancia_m != null) {
      const d = el("p", "pc-dist");
      d.append(ic(modo === "rota" ? "rota" : "reta"), el("strong", null, P.formatarDistancia(p.distancia_m)),
        document.createTextNode(modo === "rota" ? " à frente, pela rota" : " em linha reta"));
      if (modo === "rota" && p.off_route_m != null) d.appendChild(el("span", "pc-fora", " · a " + P.formatarDistancia(p.off_route_m) + " da pista"));
      const dv = modo === "rota" ? chipDesvio(p) : null;
      if (dv) { dv.id = "postos-desvio-card"; d.appendChild(dv); }
      raiz.appendChild(d);
    }
    const abertura = seloAbertura(p, true); abertura.id = "postos-aberto"; raiz.appendChild(abertura);
    const est = estimativa();
    if (est.ok) {
      const s = A.situacao(p.distancia_m, est.km);
      if (s === "fora") raiz.appendChild(el("p", "postos-fora", "Fora do alcance estimado (" + A.formatarAlcance(est.km) + ")."));
      else if (s === "limite") raiz.appendChild(el("p", "postos-limite", "No limite do alcance estimado (" + A.formatarAlcance(est.km) + ")."));
    }
    limparMini();
    raiz.append(blocoPreco(p), blocoMini(p), blocoComodidades(p));
    // fonte, datas e licença
    const rodape = el("footer", "pc-rodape");
    if (p.cnpj) rodape.appendChild(el("p", "dica", "CNPJ " + p.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")));
    rodape.appendChild(el("p", "dica", P.rotuloConfianca(p)));
    const atual = P.formatarData(P.dadosDoPosto(p).atualizadoEm);
    const linhaAtual = el("p", "dica pc-atualizado"); linhaAtual.id = "postos-atualizado";
    if (atual) { linhaAtual.append(ic("relogio"), document.createTextNode("Atualizado em " + atual)); linhaAtual.title = "Data da última atualização do dado deste posto (não é a data do preço)"; }
    else linhaAtual.textContent = "Dados do posto: data da última atualização sem informação na fonte.";
    rodape.appendChild(linhaAtual);
    rodape.appendChild(el("p", "dica postos-credito", (p.attribution || CREDITO) + " Preços: ANP."));
    raiz.appendChild(rodape);
    // ações (fixas no pé do card)
    const acoes = el("div", "pc-acoes");
    const ir = botao("", "btn btn-principal pc-ir", () => irPara(p)); ir.id = "postos-ir";
    ir.append(ic("ir"), el("span", null, "Ir até lá"));
    ir.setAttribute("aria-label", "Ir até lá: " + P.nomePosto(p));
    acoes.appendChild(ir);
    // parada no posto (ui/parada.js): perto do posto, o motorista marca a chegada e na saída conta o que tem aqui
    const dAqui = distanciaDaqui(p);
    if (C.parada && dAqui !== null && dAqui <= 400 && !(C.parada.visita() && C.parada.visita().key === p.station_key)) {
      const est = botao("", "btn pc-estou", () => { if (C.parada.marcar(p)) C.folha.fechar(); }); est.id = "postos-estou";
      est.append(ic("parada"), el("span", null, "Estou neste posto"));
      acoes.appendChild(est);
    }
    if (temRota() && !navegando()) acoes.appendChild(el("p", "dica pc-troca", "Entra como parada no caminho; o destino e a rota continuam."));
    else if (navegando()) acoes.appendChild(el("p", "dica pc-troca", "Navegando: você escolhe se é parada ou novo destino."));
    const linha = el("div", "pc-acoes2");
    const tel = P.dadosDoPosto(p).telefone;
    if (tel) {
      const a = document.createElement("a"); a.className = "btn pc-ligar"; a.href = "tel:" + tel; a.id = "postos-ligar";
      a.setAttribute("aria-label", "Ligar para " + P.nomePosto(p)); a.title = "Ligar";
      a.append(ic("telefone"), el("span", null, "Ligar"));
      linha.appendChild(a);
    }
    const er = botao("", "btn pc-erro", () => reportarErro(p)); er.id = "postos-erro";
    er.append(ic("bandeira"), el("span", null, "Reportar erro"));
    const sair = lista.length ? botao("", "btn pc-voltar", () => desenharFolha({})) : botao("", "btn pc-voltar", C.folha.fechar);
    sair.id = "postos-voltar"; sair.append(ic(lista.length ? "voltar" : "fechar"), el("span", null, lista.length ? "Voltar" : "Fechar"));
    linha.append(er, sair);
    acoes.appendChild(linha);
    raiz.appendChild(acoes);
    C.folha.abrir([raiz]);
    $folha().scrollTop = 0;
    try { h2.focus({ preventScroll: true }); } catch (e) { /* sem foco */ }
    ligarEsc(raiz, () => (lista.length ? desenharFolha({}) : C.folha.fechar()));
  }

  // "Ir até lá". Sem rota: o posto vira o destino e a rota é traçada. Com rota (parada ou não): o posto entra como PARADA no
  // caminho (origem → posto → destino), sem perder a rota nem o destino. Navegando: pergunta antes (parada ou novo destino).
  const navegando = () => !!(C.navegacao && C.navegacao.ativa && C.navegacao.ativa());
  const temRota = () => !!(C.rota && C.rota.destino && C.rota.destino() && C.rota.adicionarParada);
  function paradaDe(p) { return { lat: p.lat, lon: p.lon, rotulo: P.nomePosto(p), alongM: modoLista === "rota" && p.along_route_m != null ? p.along_route_m : undefined }; }
  function virarDestino(p) {
    C.emit("postos:destino", p);
    C.rota.definirDestino({ lat: p.lat, lng: p.lon });
    C.rota.tracar();
  }
  async function comoParada(p) {
    C.emit("postos:destino", p);
    const r = await C.rota.adicionarParada(paradaDe(p));
    if (r === "longa") { C.mensagem("Rota muito longa para acrescentar parada: o posto virou o destino.", 7000); C.rota.definirDestino({ lat: p.lat, lng: p.lon }); C.rota.tracar(); }
    else if (r === "repetida") C.mensagem("Este posto já é uma parada da rota.", 5000);
  }
  function irPara(p) {
    if (navegando() && C.navegacao.trocarDestino) { perguntarTroca(p); return; }
    if (temRota()) { comoParada(p); return; }
    virarDestino(p);
  }
  // Aviso de posto na navegação (Stitch P3.4): nome, à frente, desvio, só o que está confirmado e "Deseja parar neste posto?".
  // Sim, parar aqui = parada (o destino final e a rota continuam); Não, seguir = nada muda; Trocar destino = o posto vira o fim.
  function perguntarTroca(p) {
    const nome = P.nomePosto(p);
    const cab = el("div", "postos-aviso-cab");
    const txt = el("div", "postos-aviso-txt");
    const dist = p.distancia_m != null ? el("p", "postos-aviso-dist", "À frente a " + P.formatarDistancia(p.distancia_m) + (modoLista === "rota" ? " pela rota" : " em linha reta")) : null;
    txt.append(el("h2", null, nome), ...(dist ? [dist] : []));
    cab.append(logoBandeira(p), txt);
    const dv = modoLista === "rota" ? chipDesvio(p) : null;
    if (dv) cab.appendChild(dv);
    const sim = P.amenidadesSim(p.attributes);
    const am = el("p", "postos-aviso-am");
    if (sim.length) for (const x of sim) { const a = el("span", "postos-am"); a.append(ic(x.icone, null, "ico-sim"), el("span", null, x.rotulo)); am.appendChild(a); }
    else am.textContent = "Serviços: não informados na fonte.";
    const b = el("div", "postos-aviso-botoes");
    const parada = temRota() ? botao("", "btn btn-principal nav-grande pc-ir-parada", async () => {
      C.folha.fechar();
      const r = await C.rota.adicionarParada(paradaDe(p));
      if (r === "longa") C.mensagem("Rota muito longa para acrescentar parada. Use \"Trocar destino\" para ir ao posto.", 7000);
      else if (r === "repetida") C.mensagem("Este posto já é uma parada da rota.", 5000);
    }) : null;
    if (parada) { parada.id = "postos-parada"; parada.append(ic("parada"), el("span", "postos-aviso-bt", "Sim, parar aqui"), el("small", null, "Mantém o destino final")); b.appendChild(parada); }
    const nao = botao("", "btn nav-grande", C.folha.fechar); nao.id = "postos-trocar-nao";
    nao.append(ic("fechar"), el("span", "postos-aviso-bt", "Não, seguir"), el("small", null, "Mantém a rota"));
    const troca = botao("", "btn nav-grande", () => {
      C.folha.fechar();
      C.emit("postos:destino", p);
      C.navegacao.trocarDestino({ lat: p.lat, lon: p.lon, rotulo: nome });
    });
    troca.id = "postos-trocar-sim"; if (!parada) troca.classList.add("btn-principal");
    troca.append(ic("ir"), el("span", "postos-aviso-bt", "Trocar destino"), el("small", null, "O posto vira o fim"));
    const dois = el("div", "postos-aviso-dois"); dois.append(nao, troca);
    b.appendChild(dois);
    const raiz = el("section", "postos-aviso"); raiz.id = "postos-aviso";
    raiz.append(cab, am, el("h3", "postos-aviso-perg", "Deseja parar neste posto?"), b,
      el("p", "dica", "Trocar o destino recalcula a rota daqui até o posto, com o mesmo veículo e carga."));
    C.folha.abrir([raiz]);
  }

  C.postos = { verNoMapa: verPostosNoMapa, tirarDoMapa: tirarPostos50, abrirProximo, buscarProximos, naVista: () => naVista.slice(), lista: () => lista.slice() };
  C.aoIniciar(() => {
    C.carregarEstilo("estilos/postos.css");
    // redesenho: sem botão de posto na tela inicial; "Postos à frente" fica na busca (ui/busca.js chama abrirProximo)
    // comando de voz (pacote de voz): { origem: "voz", atender } — confirmar em até 300 ms que tratamos o pedido
    C.on("comando:proximo-posto", (d) => { if (d && typeof d.atender === "function") d.atender(); abrirProximo(); });
    C.on("rota-limpa", tirarPostos50);
    C.mapaPronto(garantirCamada);
    C.mapa.on("moveend", agendarVista);
    C.mapa.on("zoomend", agendarVista);
  });
})(window.Copiloto);
