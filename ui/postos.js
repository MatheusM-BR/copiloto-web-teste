// Postos e autonomia — pacote E2. Lógica pura em postos.js e autonomia.js.
// - Mapa: postos a partir do zoom 11, buscados pela área visível (com espera entre buscas).
// - "Postos à frente" na busca (ui/busca.js; e o comando de voz "comando:proximo-posto"): 5 postos À FRENTE — na rota ativa
//   se houver, senão pelo rumo do GPS — com distância, bandeira e atributos conhecidos ou "não informado".
// - Autonomia: litros de agora (opcional) × consumo do veículo → alcance estimado; marca postos fora do alcance.
// API pública (anônima): copiloto_stations_near / copiloto_stations_along_route (docs/API_RELATOS.md, seção Postos).
// Expõe Copiloto.postos: abrirProximo(), buscarProximos(), naVista(). Emite "postos:lista" e "postos:destino".
(function (C) {
  "use strict";
  const { el, botao } = C.util;
  const P = window.CopilotoPostos, A = window.CopilotoAutonomia;
  const ESPERA_MS = 800;          // espera depois de mexer no mapa antes de buscar
  const INTERVALO_MIN_MS = 2500;  // no máximo uma busca de área a cada 2,5 s
  const CREDITO = "Postos: cadastro da ANP e © OpenStreetMap contributors (ODbL).";

  let vistaBuscada = null, timerVista = null, ultimaBuscaVista = 0, buscandoVista = false;
  let naVista = [];               // postos da área visível (camada do mapa)
  let lista = [];                 // última lista "próximo posto"
  let modoLista = null;           // "rota" | "rumo" | "perto"
  let litrosTexto = "";           // o que o motorista digitou nesta abertura (não fica guardado)
  let filtros = { diesel: false, caminhao: false };
  let seqBusca = 0;

  // ------------------------------------------------------------ API (anônima: só a chave publicável)
  async function rpc(nome, params) {
    const cfg = window.CopilotoConfig;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(cfg.url + "/rest/v1/rpc/" + nome, {
        method: "POST", headers: { "content-type": "application/json", apikey: cfg.chave }, body: JSON.stringify(params), signal: ctl.signal,
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) { const e = new Error((j && j.message) || "Erro ao buscar postos."); e.code = j && j.code; throw e; }
      return Array.isArray(j) ? j : [];
    } catch (e) {
      if (e.name === "AbortError" || e instanceof TypeError) { const x = new Error("Sem conexão para buscar postos."); x.rede = true; throw x; }
      throw e;
    } finally { clearTimeout(t); }
  }

  // ------------------------------------------------------------ camada do mapa
  function garantirCamada() {
    const mapa = C.mapa;
    if (mapa.getSource("postos-pontos")) return;
    mapa.addSource("postos-pontos", { type: "geojson", data: P.paraGeoJSON([]), attribution: "© OpenStreetMap contributors · Cadastro ANP" });
    mapa.addLayer({ id: "postos-pontos", type: "circle", source: "postos-pontos", minzoom: P.ZOOM_MINIMO,
      paint: { "circle-radius": 7, "circle-stroke-width": 2, "circle-stroke-color": "#14181f",
        "circle-color": ["match", ["get", "fonte"], "osm", "#8fb3d9", "#3fb67a"] } });
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
    const quer = filtros.diesel || filtros.caminhao ? 50 : 5;
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
    return P.filtrar(r, filtros).slice(0, 5);
  }

  function estimativa() {
    const v = veiculo();
    const lit = A.lerLitros(litrosTexto, v ? v.tanque : null);
    if (!lit.ok) return { ok: false, motivo: lit.erro, erroLitros: true };
    return A.alcance(v, lit.valor);
  }

  async function abrirProximo() {
    litrosTexto = "";
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

  function filtrosUi() {
    const f = el("div", "linha-botoes postos-filtros");
    const alternar = (chave, rotulo) => {
      const b = botao(rotulo, "btn btn-pequeno", () => { filtros[chave] = !filtros[chave]; desenharFolha({ carregando: true }); atualizarLista(); });
      b.setAttribute("aria-pressed", String(filtros[chave])); b.id = "postos-filtro-" + chave;
      return b;
    };
    f.append(alternar("diesel", "Só com diesel confirmado"), alternar("caminhao", "Só com acesso de caminhão confirmado"));
    return f;
  }

  function titulo() {
    if (modoLista === "rota") return "Próximos postos na rota";
    if (modoLista === "rumo") return "Próximos postos à frente";
    return "Postos mais perto";
  }

  function desenharFolha(o) {
    const itens = [el("h2", null, o.carregando ? "Buscando postos…" : titulo())];
    if (!o.carregando && !o.erro && modoLista === "perto") itens.push(el("p", "dica", "Sem rumo do GPS (parado?): mostrando os mais perto em qualquer direção, em linha reta."));
    if (!o.carregando && !o.erro && modoLista === "rumo") itens.push(el("p", "dica", "Pelo seu rumo, distância em linha reta. Trace uma rota para ver os postos no caminho."));
    itens.push(campoLitros(), filtrosUi());
    if (o.erro) itens.push(el("p", "erro", o.erro));
    else if (!o.carregando) {
      const est = estimativa();
      const km = est.ok ? est.km : null;
      const marcados = A.marcar(lista, km);
      if (!marcados.length) itens.push(el("p", null, filtros.diesel || filtros.caminhao
        ? "Nenhum posto à frente com esse dado confirmado. Desligue o filtro para ver os que não informam."
        : "Nenhum posto encontrado à frente nos próximos 30 km."));
      const ul = el("ul", "postos-lista"); ul.id = "postos-lista";
      for (const p of marcados) ul.appendChild(itemPosto(p));
      if (marcados.length) itens.push(ul);
    }
    itens.push(el("p", "dica postos-credito", CREDITO));
    const b = el("div", "linha-botoes"); b.appendChild(botao("Fechar", "btn", C.folha.fechar)); itens.push(b);
    C.folha.abrir(itens);
  }

  function textoDistancia(p) {
    return "a " + P.formatarDistancia(p.distancia_m) + (modoLista === "rota" ? " pela rota" : " em linha reta");
  }

  function itemPosto(p) {
    const li = document.createElement("li");
    const b = document.createElement("button"); b.type = "button";
    b.className = "postos-item" + (p.alcance ? " alcance-" + p.alcance : ""); b.dataset.key = p.station_key;
    const r = P.resumoAtributos(p.attributes);
    b.append(
      el("span", "postos-nome", P.nomePosto(p)),
      el("span", "postos-dist", textoDistancia(p) + " · " + P.nomeBandeira(p.brand)),
      el("span", "postos-attr", r.conhecidos.length ? r.conhecidos.join(" · ") : "Serviços: não informados"),
    );
    if (r.conhecidos.length && r.naoInformados.length) b.appendChild(el("span", "postos-nao-inf", "Não informado: " + r.naoInformados.join(", ")));
    if (p.alcance === "fora") b.appendChild(el("span", "postos-fora", "Fora do alcance estimado"));
    else if (p.alcance === "limite") b.appendChild(el("span", "postos-limite", "No limite do alcance estimado"));
    b.addEventListener("click", () => mostrarDetalhe(p, modoLista));
    li.appendChild(b);
    return li;
  }

  function mostrarDetalhe(p, modo) {
    const itens = [el("h2", null, P.nomePosto(p)), el("p", null, P.nomeBandeira(p.brand) + (p.distancia_m != null
      ? " · a " + P.formatarDistancia(p.distancia_m) + (modo === "rota" ? " pela rota" : " em linha reta") : ""))];
    const est = estimativa();
    if (est.ok) {
      const s = A.situacao(p.distancia_m, est.km);
      if (s === "fora") itens.push(el("p", "postos-fora", "Fora do alcance estimado (" + A.formatarAlcance(est.km) + ")."));
      else if (s === "limite") itens.push(el("p", "postos-limite", "No limite do alcance estimado (" + A.formatarAlcance(est.km) + ")."));
    }
    const dl = el("ul", "postos-atributos"); dl.id = "postos-atributos";
    for (const a of P.descreverAtributos(p.attributes)) {
      const li = el("li", a.conhecido ? "" : "nao-informado"); li.textContent = a.rotulo + ": " + a.texto; dl.appendChild(li);
    }
    itens.push(dl);
    if (p.cnpj) itens.push(el("p", "dica", "CNPJ " + p.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")));
    itens.push(el("p", "dica", P.rotuloConfianca(p)));
    itens.push(el("p", "dica postos-credito", p.attribution || CREDITO));
    const b = el("div", "linha-botoes");
    b.append(botao("Ir para este posto", "btn btn-principal", () => irPara(p)));
    if (lista.length) b.append(botao("Voltar", "btn", () => desenharFolha({})));
    else b.append(botao("Fechar", "btn", C.folha.fechar));
    itens.push(b);
    C.folha.abrir(itens);
  }

  // Vira destino da rota usando a API pública do módulo de rota.
  // Com a navegação andando (A2): pergunta antes; "sim" troca o destino DA NAVEGAÇÃO (recalcula e avisa), "não" nada muda.
  function irPara(p) {
    if (C.navegacao && C.navegacao.ativa && C.navegacao.ativa() && C.navegacao.trocarDestino) { perguntarTroca(p); return; }
    C.emit("postos:destino", p);
    C.rota.definirDestino({ lat: p.lat, lng: p.lon });
    C.rota.tracar();
  }
  function perguntarTroca(p) {
    const nome = P.nomePosto(p);
    const b = el("div", "linha-botoes postos-troca");
    const sim = botao("Sim, trocar", "btn btn-principal nav-grande", () => {
      C.folha.fechar();
      C.emit("postos:destino", p);
      C.navegacao.trocarDestino({ lat: p.lat, lon: p.lon, rotulo: nome });
    });
    sim.id = "postos-trocar-sim";
    const nao = botao("Não", "btn nav-grande", C.folha.fechar); nao.id = "postos-trocar-nao";
    b.append(sim, nao);
    C.folha.abrir([el("h2", null, "Trocar o destino para " + nome + "?"),
      el("p", null, "A navegação recalcula a rota daqui até o posto, com o mesmo veículo e carga."), b]);
  }

  C.postos = { abrirProximo, buscarProximos, naVista: () => naVista.slice(), lista: () => lista.slice() };

  C.aoIniciar(() => {
    C.carregarEstilo("estilos/postos.css");
    // redesenho: sem botão de posto na tela inicial; "Postos à frente" fica na busca (ui/busca.js chama abrirProximo)
    // comando de voz (pacote de voz): { origem: "voz", atender } — confirmar em até 300 ms que tratamos o pedido
    C.on("comando:proximo-posto", (d) => { if (d && typeof d.atender === "function") d.atender(); abrirProximo(); });
    C.mapaPronto(garantirCamada);
    C.mapa.on("moveend", agendarVista);
    C.mapa.on("zoomend", agendarVista);
  });
})(window.Copiloto);
