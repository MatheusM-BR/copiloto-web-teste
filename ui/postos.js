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
  const CHAVE_FILTROS = "copiloto.postos.filtros.v1", CHAVE_ERROS = "copiloto.postos.erros.v1";
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
    const b = { diesel: false, caminhao: false, h24: false, banho: false }, g = lerJSON(CHAVE_FILTROS, null);
    if (g && typeof g === "object") for (const k of Object.keys(b)) b[k] = g[k] === true;
    return b;
  })();
  const temFiltro = () => Object.keys(filtros).some((k) => filtros[k]);
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
        filtros[chave] = !filtros[chave]; gravarJSON(CHAVE_FILTROS, filtros);
        desenharFolha({ carregando: true }); atualizarLista();
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
    // ordem pensada para a tela pequena: título, filtros e os POSTOS primeiro; dicas e litros (opcionais) depois
    const h2 = el("h2", "postos-titulo"); h2.append(ic("bomba"), document.createTextNode(o.carregando ? "Buscando postos…" : titulo()));
    const itens = [h2, filtrosUi()];
    const dicas = [];
    if (!o.carregando && !o.erro && modoLista === "perto") dicas.push(el("p", "dica", "Sem rumo do GPS (parado?): mostrando os mais perto em qualquer direção, em linha reta."));
    if (!o.carregando && !o.erro && modoLista === "rumo") dicas.push(el("p", "dica", "Pelo seu rumo, distância em linha reta. Trace uma rota para ver os postos no caminho."));
    if (o.erro) itens.push(el("p", "erro", o.erro));
    else if (!o.carregando) {
      const est = estimativa();
      const km = est.ok ? est.km : null;
      const marcados = A.marcar(lista, km);
      if (!marcados.length) itens.push(el("p", null, temFiltro()
        ? "Nenhum posto à frente com esse dado confirmado. Desligue o filtro para ver os que não informam."
        : "Nenhum posto encontrado à frente nos próximos 30 km."));
      const ul = el("ul", "postos-lista"); ul.id = "postos-lista";
      const prox = P.proximoComDiesel(marcados);
      for (const p of marcados) ul.appendChild(itemPosto(p, prox && prox.station_key === p.station_key));
      if (marcados.length) itens.push(ul);
    }
    itens.push(...dicas, campoLitros());
    itens.push(el("p", "dica postos-credito", CREDITO));
    const b = el("div", "linha-botoes"); b.appendChild(botao("Fechar", "btn", C.folha.fechar)); itens.push(b);
    C.folha.abrir(itens);
    $folha().scrollTop = 0;
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

  // Item da lista: logo, nome, distância em destaque, ícones só do que está CONFIRMADO. Texto completo para o leitor de tela.
  function itemPosto(p, proximo) {
    const li = document.createElement("li");
    const b = document.createElement("button"); b.type = "button";
    b.className = "postos-item" + (p.alcance ? " alcance-" + p.alcance : "") + (proximo ? " postos-proximo" : ""); b.dataset.key = p.station_key;
    const r = P.resumoAtributos(p.attributes);
    const corpo = el("span", "postos-corpo");
    const topo = el("span", "postos-topo");
    const nome = el("span", "postos-nome", P.nomePosto(p));
    const dist = el("span", "postos-dist"); dist.setAttribute("aria-hidden", "true");
    dist.append(ic(modoLista === "rota" ? "rota" : "reta"), document.createTextNode(P.formatarDistancia(p.distancia_m)));
    topo.append(nome, dist);
    const marca = el("span", "postos-marca", P.nomeBandeira(p.brand)); marca.setAttribute("aria-hidden", "true");
    const icones = el("span", "postos-icones"); icones.setAttribute("aria-hidden", "true");
    const sim = P.amenidadesSim(p.attributes);
    for (const x of sim) icones.appendChild(ic(x.icone, null, "ico-sim"));
    if (!sim.length) icones.append(ic("ajuda", null, "ico-desc"), el("span", "postos-sem", "sem informação"));
    corpo.append(topo, marca, icones);
    b.append(logoBandeira(p), corpo);
    if (proximo) { const t = el("span", "postos-selo"); t.append(ic("ok"), document.createTextNode("Próximo com diesel")); b.appendChild(t); }
    // texto para o leitor de tela (e fonte do que o motorista vê em ícones): nada some, só deixa de ocupar a tela
    b.append(dica(textoDistancia(p) + " · " + P.nomeBandeira(p.brand)), dica(r.conhecidos.length ? r.conhecidos.join(" · ") : "Serviços: não informados"));
    if (r.conhecidos.length && r.naoInformados.length) b.appendChild(dica("Não informado: " + r.naoInformados.join(", ")));
    const aviso = p.alcance === "fora" ? "Fora do alcance estimado" : p.alcance === "limite" ? "No limite do alcance estimado" : null;
    if (aviso) {
      const av = el("span", p.alcance === "fora" ? "postos-fora" : "postos-limite");
      av.append(ic("aviso"), document.createTextNode(aviso));
      b.appendChild(av);
    }
    b.addEventListener("click", () => mostrarDetalhe(p, modoLista));
    li.appendChild(b);
    return li;
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
    caixa.append(cab, valores, fonte, el("p", "dica pc-sem", "Sem preço deste posto: a ANP só informa a média da região."));
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
    li.append(ico, rot, el("span", "so-leitor", a.rotulo + ": " + a.texto));
    return li;
  }
  function blocoComodidades(p) {
    const todas = P.descreverAmenidades(p.attributes);
    const grade = el("ul", "pc-grade postos-atributos"); grade.id = "postos-atributos";
    for (const a of todas.filter((x) => x.real || x.estado !== "?")) grade.appendChild(celula(a));
    const sec = el("section", "pc-comod");
    const cab = el("h3", "pc-sub", "Comodidades"); sec.append(cab, grade);
    const horario = (p.attributes && typeof p.attributes.horario === "string" && p.attributes.horario.trim()) || null;
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
    tit.append(h2, el("p", "pc-bandeira", P.nomeBandeira(p.brand)));
    cab.append(logoBandeira(p, true), tit);
    raiz.appendChild(cab);
    // distância "à frente" e alcance
    if (p.distancia_m != null) {
      const d = el("p", "pc-dist");
      d.append(ic(modo === "rota" ? "rota" : "reta"), el("strong", null, P.formatarDistancia(p.distancia_m)),
        document.createTextNode(modo === "rota" ? " à frente, pela rota" : " em linha reta"));
      if (modo === "rota" && p.off_route_m != null) d.appendChild(el("span", "pc-fora", " · a " + P.formatarDistancia(p.off_route_m) + " da pista"));
      raiz.appendChild(d);
    }
    const est = estimativa();
    if (est.ok) {
      const s = A.situacao(p.distancia_m, est.km);
      if (s === "fora") raiz.appendChild(el("p", "postos-fora", "Fora do alcance estimado (" + A.formatarAlcance(est.km) + ")."));
      else if (s === "limite") raiz.appendChild(el("p", "postos-limite", "No limite do alcance estimado (" + A.formatarAlcance(est.km) + ")."));
    }
    raiz.append(blocoPreco(p), blocoComodidades(p));
    // fonte, datas e licença
    const rodape = el("footer", "pc-rodape");
    if (p.cnpj) rodape.appendChild(el("p", "dica", "CNPJ " + p.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")));
    rodape.appendChild(el("p", "dica", P.rotuloConfianca(p)));
    rodape.appendChild(el("p", "dica", "Dados do posto: data da última atualização sem informação na fonte."));
    rodape.appendChild(el("p", "dica postos-credito", (p.attribution || CREDITO) + " Preços: ANP."));
    raiz.appendChild(rodape);
    // ações (fixas no pé do card)
    const acoes = el("div", "pc-acoes");
    const ir = botao("", "btn btn-principal pc-ir", () => irPara(p)); ir.id = "postos-ir";
    ir.append(ic("ir"), el("span", null, "Ir até lá"));
    ir.setAttribute("aria-label", "Ir até lá: " + P.nomePosto(p));
    acoes.appendChild(ir);
    if (C.rota && C.rota.destino && C.rota.destino() && !(C.navegacao && C.navegacao.ativa && C.navegacao.ativa()))
      acoes.appendChild(el("p", "dica pc-troca", "Vira o destino da rota (troca o atual)."));
    const linha = el("div", "pc-acoes2");
    const tel = P.telefoneLimpo(p);
    if (tel) {
      const a = document.createElement("a"); a.className = "btn pc-ligar"; a.href = "tel:" + tel; a.id = "postos-ligar";
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
