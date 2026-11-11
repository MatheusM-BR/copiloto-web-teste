// Dados da rota na navegação (lógica pura em dados.js, window.CopilotoDados). Por rota traçada/recalculada, UMA consulta a
// cada RPC pública do Supabase, em paralelo e sem segurar a rota (no máximo 4 pedidos ao mesmo tempo; cache em memória por
// forma da rota, as 3 últimas também em localStorage "copiloto.dados.v1" para navegar sem internet):
//   copiloto_route_features(p_route, kinds, 40)   curva (só forte), lombada, balança, passagem de nível, balsa, área de escape, radar, perigo
//   copiloto_route_hot_spots(p_route, 100, 2)     trechos perigosos da PRF (alto/crítico)
//   copiloto_route_artesp(p_route)                balança/praça nas SPs e obras dos painéis ("obra recorrente")
//   copiloto_route_restrictions(p_route, …)       com caminhão ativo: o que o caminhão NÃO passa (altura, peso, comprimento, largura)
//   copiloto_route_snv(p_route)                   pista/pavimento oficiais (DNIT — SNV) para a "Via do trajeto" (ui/via.js lê daqui)
// Navegando: avisos de proximidade pelo progresso da navegação (evento "navegacao": progresso_m), com antecedência pela
// velocidade (600 m a 80 km/h), um aviso por feição, nunca repetido, 1 fala a cada 20 s, prioridade restrição > trecho
// perigoso crítico > balança > curva forte > passagem de nível > lombada > radar; > 10 lombadas em 2 km viram "Trecho com
// lombadas". Faixa #aviso-dado dentro do painel da navegação (texto curto + distância); fala pela fila (naoInterromper).
// Folha da rota: cartão vermelho de restrições ANTES de "Iniciar navegação" (C.rotaExtras.antesIniciar) com lista, "Ver no
// mapa" e "Mesmo assim"; condicionais em amarelo; desconhecidas só no Avançado; sem altura/peso, linha que abre o perfil.
// Modo Avançado: "N curvas fortes · N trechos perigosos · N balanças" com "Ver no mapa". Atribuição (texto da API) na folha.
// Expõe Copiloto.dadosRota: obter(rota), avisosDe(rota), snvDe(rota) (resultado de usarSnv ou null), restricoesDe(rota),
// estado(rota), verNoMapa(rota, tipo?). Evento "dados:rota" ({ chave, parte }) a cada parte que chega.
(function (C) {
  "use strict";
  const { $, el, botao } = C.util;
  const D = window.CopilotoDados;
  const Rota = window.CopilotoRota;
  const R = window.CopilotoRuido; // r5: tira o ruído do dado bruto, pagina as feições, teto de falas (ruido.js)
  const Dv = window.CopilotoDesvio;
  const MAX_ENTRADAS = 8, MAX_SIMULTANEOS = 4, ERRO_CACHE_MS = 10000;
  const KINDS = ["curva", "lombada", "balanca", "passagem_nivel", "balsa", "area_escape", "radar", "perigo"];
  C.carregarEstilo("estilos/avisos.css");

  const entradas = new Map();
  let selecionada = null, avisador = null, avisadorChave = null, faixa = null, faixaTimer = null, marcadores = [], folhaAnterior = null;
  let emVoo = 0; const fila = [];
  const mesmoAssim = new Set(); // chaves de rota em que o motorista tocou "Mesmo assim"

  function storage() { try { return localStorage; } catch (e) { return null; } }
  function online() { return !(navigator && navigator.onLine === false); }
  function modo() { try { return localStorage.getItem("copiloto.rota.modo.v1") === "avancado" ? "avancado" : "padrao"; } catch (e) { return "padrao"; } }
  function veiculo() { try { return C.veiculos && C.veiculos.ativo ? C.veiculos.ativo() : null; } catch (e) { return null; } }
  function caminhao(p) { return !!p && Rota.ehCaminhao(p); }
  function naFila(fn) {
    return new Promise((resolve, reject) => {
      const rodar = () => { emVoo++; fn().then(resolve, reject).finally(() => { emVoo--; const p = fila.shift(); if (p) p(); }); };
      if (emVoo < MAX_SIMULTANEOS) rodar(); else fila.push(rodar);
    });
  }
  function rpc(nome, params) { return naFila(() => C.nuvem.rpcPublica(nome, params)); }

  // ------------------------------------------------------------ dados por rota
  function chaveDims(p) { return caminhao(p) ? ["c", p.altura, p.pbtc, p.comprimento, p.largura, p.eixos].map((x) => (typeof x === "number" ? x : "-")).join("/") : "a"; }
  function obter(r) {
    const coords = r && r.coords;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const chave = D.chaveRota(coords);
    let e = entradas.get(chave);
    if (e) { entradas.delete(chave); entradas.set(chave, e); }
    else {
      e = { chave, coords, distanciaM: null, geo: null, partes: { feicoes: parte(), trechos: parte(), artesp: parte(), snv: parte() }, restricoes: parte(), dims: null,
        avisos: [], avisosDe: new Set(), ouvintes: new Map(), guardado: false };
      const ac = D.acumuladoM(coords); e.distanciaM = ac[ac.length - 1];
      entradas.set(chave, e);
      while (entradas.size > MAX_ENTRADAS) entradas.delete(entradas.keys().next().value);
      const g = D.buscarGuardado(storage(), chave);
      if (g) { e.avisos = g.avisos; e.guardado = true; }
      buscarPartes(e);
    }
    buscarRestricoes(e, veiculo());
    return e;
  }
  function parte() { return { estado: "nada", dados: null, erroEm: 0 }; }
  function geo(e) { if (!e.geo) e.geo = D.rotaGeoJSON(e.coords); return e.geo; }
  // ouvinte some só depois de ter estado na tela e sair de vez (os nós da folha são criados antes de a folha abrir; a folha
  // guardada do "Voltar" também conta)
  function vivo(n) {
    if (n.isConnected) { n.__visto = true; return true; }
    return !n.__visto || !!(folhaAnterior && folhaAnterior.some((x) => x.contains(n)));
  }
  function avisar(e, nome) {
    for (const [n, f] of Array.from(e.ouvintes)) {
      if (!vivo(n)) { e.ouvintes.delete(n); continue; }
      try { f(); } catch (x) { /* ouvinte morto */ }
    }
    C.emit("dados:rota", { chave: e.chave, parte: nome });
  }
  function montarAvisos(e) {
    const p = e.partes;
    const listas = [];
    if (p.feicoes.dados) listas.push(D.avisosDeFeicoes(p.feicoes.dados));
    if (p.trechos.dados) listas.push(D.avisosDeTrechos(p.trechos.dados));
    if (p.artesp.dados) listas.push(D.avisosDeArtesp(p.artesp.dados));
    if (e.restricoes.dados) listas.push(D.avisosDeRestricoes(e.restricoes.dados));
    if (!listas.length) return;
    // Projeto de dados confiáveis, nível D: sem data, atrasado ou heurístico, então não aparece nem fala (o dado fica no banco).
    // Obra de painel ARTESP chega com ~2 meses de atraso. Curva só entra se for fechada (raio ≤ 60 m): filtro em dados.js.
    const ocultos = window.COPILOTO_MOSTRAR_OCULTOS === true ? [] : ["obra"];
    for (let i = 0; i < listas.length; i++) listas[i] = listas[i].filter((a) => !ocultos.includes(a.tipo));
    e.avisos = R.finalizar(D.juntarAvisos(listas));
    e.guardado = false;
    if (p.feicoes.estado === "ok" && p.trechos.estado === "ok" && p.artesp.estado === "ok") D.guardar(storage(), { chave: e.chave, salvoEm: Date.now(), avisos: e.avisos });
    if (avisadorChave === e.chave) avisador = D.criarAvisador(e.avisos, Object.assign(opcoesAvisador(), avisador ? { feitos: avisador.feitosSet(), ultimaFala: avisador.ultimaFala() } : {}));
  }
  async function pedirParte(e, nome, fn) {
    const p = e.partes[nome];
    if (p.estado === "ok" || p.estado === "carregando") return;
    if (!online()) { p.estado = "offline"; avisar(e, nome); return; }
    if (p.estado === "falha" && Date.now() - p.erroEm < ERRO_CACHE_MS) return;
    p.estado = "carregando";
    try { p.dados = await fn(); p.estado = "ok"; }
    catch (x) { p.estado = x && x.rede ? "offline" : "falha"; p.erroEm = Date.now(); }
    if (p.estado === "ok") montarAvisos(e);
    avisar(e, nome);
  }
  function buscarPartes(e) {
    pedirParte(e, "feicoes", () => R.buscarFeicoes(rpc, geo(e), { kinds: KINDS }));
    pedirParte(e, "trechos", async () => R.limparTrechos(await rpc("copiloto_route_hot_spots", { p_route: geo(e), p_buffer_m: 100, p_min_level: 2 })));
    pedirParte(e, "artesp", () => rpc("copiloto_route_artesp", { p_route: geo(e) }));
    pedirParte(e, "snv", () => rpc("copiloto_route_snv", { p_route: geo(e) }));
  }
  async function buscarRestricoes(e, perfil) {
    const dims = chaveDims(perfil);
    if (dims === "a") { if (e.dims !== "a") { e.dims = "a"; e.restricoes = parte(); montarAvisos(e); avisar(e, "restricoes"); } return; }
    if (e.dims === dims && (e.restricoes.estado === "ok" || e.restricoes.estado === "carregando")) return;
    if (e.dims !== dims) { e.dims = dims; e.restricoes = parte(); }
    const r = e.restricoes;
    if (!online()) { r.estado = "offline"; avisar(e, "restricoes"); return; }
    if (r.estado === "falha" && Date.now() - r.erroEm < ERRO_CACHE_MS) return;
    r.estado = "carregando"; avisar(e, "restricoes");
    const params = D.paramsRestricoes(e.coords, perfil); params.p_route = geo(e);
    try { r.dados = R.limparRestricoes(await rpc("copiloto_route_restrictions", params)); r.estado = "ok"; }
    catch (x) { r.estado = x && x.rede ? "offline" : "falha"; r.erroEm = Date.now(); }
    if (e.dims !== dims) return; // o veículo mudou no meio
    if (r.estado === "ok") montarAvisos(e);
    avisar(e, "restricoes");
  }
  function tentarDeNovo() {
    for (const e of entradas.values()) {
      for (const n of Object.keys(e.partes)) if (e.partes[n].estado === "offline" || e.partes[n].estado === "falha") { e.partes[n].estado = "nada"; }
      buscarPartes(e);
      if (e.restricoes.estado === "offline" || e.restricoes.estado === "falha") { e.restricoes.estado = "nada"; buscarRestricoes(e, veiculo()); }
    }
  }
  // Só as restrições de uma rota candidata (o desvio de ui/desvio.js confere a rota nova antes de oferecê-la): uma consulta,
  // sem as outras RPCs. Reaproveita a entrada se a rota já foi consultada. Lança em falha de rede ou do servidor.
  async function restricoesDeRota(r) {
    const perfil = veiculo();
    if (!caminhao(perfil) || !r || !Array.isArray(r.coords) || r.coords.length < 2) return null;
    const e0 = entradas.get(D.chaveRota(r.coords));
    if (e0 && e0.dims === chaveDims(perfil) && e0.restricoes.estado === "ok" && e0.restricoes.dados) return D.resumoRestricoes(e0.restricoes.dados);
    if (!online()) { const x = new Error("Sem internet."); x.rede = true; throw x; }
    return D.resumoRestricoes(await rpc("copiloto_route_restrictions", D.paramsRestricoes(r.coords, perfil)));
  }
  const snvDe = (r) => { const e = obter(r); return e && e.partes.snv.dados ? D.usarSnv(e.partes.snv.dados, e.distanciaM) : null; };
  const avisosDe = (r) => { const e = obter(r); return e ? e.avisos.slice() : []; };
  // Só lê o que já está na memória (não pede nada, não emite evento): ui/desvio.js chama de dentro de "dados:rota"
  const restricoesJa = (r) => { const e = r && Array.isArray(r.coords) && r.coords.length > 1 ? entradas.get(D.chaveRota(r.coords)) : null; return e && e.restricoes.estado === "ok" && e.restricoes.dados ? D.resumoRestricoes(e.restricoes.dados) : null; };
  const restricoesDe = (r) => { const e = obter(r); return e && e.restricoes.dados ? D.resumoRestricoes(e.restricoes.dados) : null; };

  // ------------------------------------------------------------ navegando: avisos de proximidade
  function criarFaixa() {
    const p = $("nav-painel"); if (!p || faixa) return;
    faixa = el("div", "aviso-dado"); faixa.id = "aviso-dado"; faixa.hidden = true; faixa.setAttribute("role", "status"); faixa.setAttribute("aria-live", "polite");
    const km = $("km-atual");
    if (km && km.parentNode === p) p.insertBefore(faixa, km.nextSibling); else { const seg = $("nav-seguinte"); if (seg && seg.parentNode === p) p.insertBefore(faixa, seg.nextSibling); else p.appendChild(faixa); }
  }
  // Restrição que o caminhão não passa (lote 1): a faixa vira o cartão vermelho "VOCÊ NÃO PASSA" com os dois números (limite da
  // via × seu caminhão, só quando o dado existe), a distância ao vivo e dois botões de 84 px. A voz e a lógica são as mesmas.
  let cartaoAtivo = null; // aviso do cartão aberto (para atualizar a distância e saber o que "Desviar" refaz)
  function textoDist(distM) { return distM < 50 ? "aqui" : D.fmtDistRota(distM); }
  function montarCritico(a, distM) {
    cartaoAtivo = a;
    const cab = el("div", "critico-cab");
    if (window.CopilotoPlacas) cab.append(window.CopilotoPlacas.placa("restricao_caminhao", { tamanho: 56, decorativa: true }));
    else if (window.CopilotoIcones) cab.append(window.CopilotoIcones.no("aviso"));
    cab.append(el("b", "critico-titulo", "VOCÊ NÃO PASSA"));
    const linha = el("div", "critico-linha");
    linha.append(el("span", "aviso-dado-texto", a.texto), el("span", "aviso-dado-dist", textoDist(distM)));
    faixa.append(cab, linha);
    if (a.fonteInfo) { const f = el("p", "critico-fonte", "Fonte: " + a.fonteInfo); f.id = "critico-fonte"; faixa.append(f); } // fonte e idade do dado (nunca esconde dado antigo)
    const lim = Dv && a.detalhe ? Dv.paraLimites(String(a.detalhe).split("; ")[0]) : null;
    if (lim) {
      const caixa = (rotulo, valor, cls) => { const c = el("div", "critico-num " + cls); c.append(el("small", null, rotulo), el("b", null, valor)); return c; };
      const nums = el("div", "critico-nums");
      nums.append(caixa("Limite da via", Dv.textoMedida(lim.limite, lim.unidade), "via"), caixa("Seu caminhão", Dv.textoMedida(lim.veiculo, lim.unidade), "caminhao"));
      faixa.append(nums);
    }
    const msg = el("p", "critico-msg"); msg.id = "critico-msg"; msg.hidden = true;
    const bot = el("div", "critico-botoes");
    const des = botao("Desviar", "btn critico-btn critico-desviar", async () => {
      if (!C.desvio || !C.desvio.desviarAgora) return;
      if (!online()) { msg.textContent = "Sem internet para calcular o desvio."; msg.hidden = false; return; }
      des.disabled = true; des.textContent = "Procurando desvio…"; msg.hidden = true;
      let fase = null;
      try { fase = await C.desvio.desviarAgora(); } catch (e) { fase = "falha"; }
      if (fase === "ok" || fase === "parcial") { esconderFaixa(); return; } // a rota nova entrou (banner "Rota alterada…" de ui/desvio.js)
      des.disabled = false; des.textContent = "Desviar";
      msg.textContent = fase === "sem" ? "Sem caminho que evite a restrição; confirme a medida no local." : "Não deu para calcular o desvio agora.";
      msg.hidden = false;
    });
    des.id = "critico-desviar";
    const mesmo = botao("Seguir mesmo assim", "btn critico-btn critico-mesmo", () => {
      const r = C.rota.atual();
      if (r && Array.isArray(r.coords)) mesmoAssim.add(D.chaveRota(r.coords));
      if (C.desvio && C.desvio.aceitar) C.desvio.aceitar(r); // o resumo da viagem guarda "restrição mantida por decisão do motorista"
      esconderFaixa();
    });
    mesmo.id = "critico-mesmo";
    bot.append(des, mesmo);
    faixa.append(bot, msg);
  }
  function mostrarFaixa(a, distM) {
    if (!faixa) criarFaixa(); if (!faixa) return;
    faixa.textContent = "";
    cartaoAtivo = null;
    const critico = a.tipo === "restricao";
    faixa.classList.toggle("critico", critico); faixa.classList.remove("com-placa");
    if (critico) montarCritico(a, distM);
    else {
      if (window.CopilotoPlacas) { faixa.append(window.CopilotoPlacas.placa(window.CopilotoPlacas.idDoTipo(a.tipo), { tamanho: 56, decorativa: true, classe: "aviso-dado-placa" })); faixa.classList.add("com-placa"); } // placa grande ao lado do texto
      else if (window.CopilotoIcones) { const w = el("span", "dados-aviso-ico"); w.append(window.CopilotoIcones.no(ICONE_AVISO[a.tipo] || "aviso")); faixa.append(w); } // r6: símbolo do aviso
      faixa.append(el("span", "aviso-dado-texto", a.texto), el("span", "aviso-dado-dist", textoDist(distM)));
      if (a.tipo === "restricao_possivel") { // confiança média: âmbar, só sugere; mostra de onde vem o dado
        faixa.classList.add("possivel");
        if (a.fonteInfo) faixa.append(el("span", "possivel-fonte", "Fonte: " + a.fonteInfo));
      }
    }
    if (a.tipo !== "restricao_possivel") faixa.classList.remove("possivel");
    faixa.dataset.tipo = a.tipo; faixa.hidden = false;
    clearTimeout(faixaTimer); faixaTimer = setTimeout(esconderFaixa, critico ? 60000 : 20000);
  }
  const ICONE_AVISO = { restricao: "aviso", restricao_possivel: "aviso", perigoso: "aviso", balanca: "balanca", balsa: "rota", curva: "reta", passagem_nivel: "aviso", lombada: "aviso", lombadas: "aviso",
    radar: "r_radar", praca_pedagio: "pedagio", obra: "obras", area_escape: "reta", perigo: "aviso" };
  // intervalo mínimo entre falas (20 s; window.COPILOTO_AVISO_INTERVALO_MS encurta nos testes)
  function opcoesAvisador() { const ms = Number(window.COPILOTO_AVISO_INTERVALO_MS); return ms > 0 ? { intervaloMs: ms } : {}; }
  function esconderFaixa() { clearTimeout(faixaTimer); cartaoAtivo = null; if (faixa) { faixa.hidden = true; faixa.classList.remove("critico"); faixa.classList.remove("possivel"); } }
  function falar(a, distM) {
    if (!C.voz || !C.voz.falar) return;
    // restrição do caminhão é segurança: espera o alerta/manobra acabar sem ser descartada por tempo e aborta o microfone aberto
    const critica = a.tipo === "restricao";
    if (!critica && C.voz.emAlerta && C.voz.emAlerta()) return; // alerta de relato falando: a faixa fica, a fala não briga
    // Só alertas: lombada, pedágio, obra recorrente e área de escape são informação, não perigo
    const conversa = D.AVISOS_SO_TELA_NO_MODO_ALERTAS.indexOf(a.tipo) >= 0;
    C.voz.falar(D.falaAviso(a, distM), { naoInterromper: true, esperaMaxMs: 8000, critica, conversa });
    C.emit("dados:aviso", { aviso: a, distanciaM: distM });
  }
  // Navegando: restrição violada a ≥ 3 km à frente → ui/desvio.js recalcula evitando-a (não, se o motorista tocou "Mesmo assim")
  function pedirDesvioNavegando(e, progressoM) {
    if (!C.desvio || !C.desvio.navegando || mesmoAssim.has(e.chave) || e.restricoes.estado !== "ok" || !e.restricoes.dados) return;
    const viol = D.resumoRestricoes(e.restricoes.dados).violadas;
    if (viol.length) C.desvio.navegando({ coords: e.coords, violadas: viol, progressoM });
  }
  function aoNavegar(d) {
    if (!d || d.ativa === false) { avisador = null; avisadorChave = null; esconderFaixa(); return; }
    if (!faixa) criarFaixa();
    const e = obter({ coords: d.coords }); if (!e) return;
    if (avisadorChave !== e.chave) { avisadorChave = e.chave; avisador = D.criarAvisador(e.avisos, opcoesAvisador()); selecionada = e.chave; }
    if (!avisador) return;
    pedirDesvioNavegando(e, d.progresso_m);
    // o cartão "Você não passa" mostra a distância ao vivo; passou do ponto, some
    if (cartaoAtivo && faixa && !faixa.hidden) {
      const falta = cartaoAtivo.ao_longo_m - d.progresso_m;
      if (falta < -40) esconderFaixa();
      else { const dist = faixa.querySelector(".aviso-dado-dist"); if (dist) dist.textContent = textoDist(Math.max(0, falta)); }
    }
    const g = C.estado.gps;
    const r = avisador.atualizar({ progressoM: d.progresso_m, kmh: g ? g.kmh : null });
    if (r.falar) { mostrarFaixa(r.falar, r.distanciaM); falar(r.falar, r.distanciaM); }
    else if (r.mostrar) mostrarFaixa(r.mostrar, r.distanciaM);
  }

  // ------------------------------------------------------------ mapa: marcadores
  function limparMarcadores() { for (const m of marcadores) m.remove(); marcadores = []; }
  function marcador(a, classe) {
    const d = el("div", "dados-marca " + classe); d.title = a.texto;
    if (C.lista && window.CopilotoPlacas) { // placa no lugar da sigla (a sigla fica só para o leitor de tela); um toque abre a lista de avisos
      C.lista.preencherMarca(d, window.CopilotoPlacas.idDoTipo(a.tipo), { leitor: a.texto, tamanho: a.tipo === "restricao" || a.tipo === "restricao_possivel" ? 40 : 34 });
      d.setAttribute("role", "button"); d.tabIndex = 0;
      const abrir = (ev) => { ev.stopPropagation(); C.lista.abrir({ foco: "aviso:" + a.id }); };
      d.addEventListener("click", abrir); d.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); abrir(ev); } });
    } else d.textContent = a.sigla || "!";
    return new maplibregl.Marker({ element: d }).setLngLat([a.lon, a.lat]);
  }
  function enquadrar(pts, coords) {
    const alvo = pts.length > 1 ? pts : coords;
    if (C.rotaLonga && C.rotaLonga.enquadrar) { setTimeout(() => C.rotaLonga.enquadrar(alvo), 80); return; }
    C.mapaPronto(() => { try { C.mapa.fitBounds(alvo.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(alvo[0], alvo[0])), { padding: 60, duration: 500 }); } catch (x) { /* ignora */ } });
  }
  const SIGLA = { restricao: "✕", restricao_possivel: "?", perigoso: "⚠", balanca: "⚖", curva: "↪", passagem_nivel: "🚂", lombada: "▲", lombadas: "▲", radar: "◎", balsa: "⛴", area_escape: "⤵", perigo: "!", obra: "🚧", praca_pedagio: "$" };
  // tipo: "restricoes" (só as violadas) ou null (todos os avisos)
  function verNoMapa(r, tipo) {
    const e = obter(r); if (!e) return;
    limparMarcadores();
    const lista = tipo === "restricoes" ? e.avisos.filter((a) => a.tipo === "restricao" || a.tipo === "restricao_possivel") : e.avisos;
    C.mapaPronto(() => { for (const a of lista) { const m = marcador(Object.assign({ sigla: SIGLA[a.tipo] }, a), a.tipo === "restricao" ? "viola" : a.tipo === "restricao_possivel" ? "possivel" : a.tipo); m.addTo(C.mapa); marcadores.push(m); } });
    const f = $("folha"); if (!folhaAnterior) folhaAnterior = f && !f.hidden ? Array.from(f.children) : null;
    const itens = [el("h2", null, tipo === "restricoes" ? "Restrições no mapa" : "Avisos no mapa")];
    itens.push(el("p", "dica", lista.length + (lista.length === 1 ? " ponto" : " pontos") + " marcados na rota. " + fontes(e)));
    const bot = el("div", "linha-botoes");
    bot.append(botao("Voltar", "btn", () => { limparMarcadores(); const ant = folhaAnterior; folhaAnterior = null; if (ant && ant.length) C.folha.abrir(ant); else C.folha.fechar(); if (C.rota && C.rota.enquadrar) setTimeout(() => C.rota.enquadrar(), 80); }));
    itens.push(bot);
    C.folha.abrir(itens);
    enquadrar(lista.map((a) => [a.lon, a.lat]), e.coords);
  }
  function fontes(e) {
    const f = new Set();
    for (const a of e.avisos) if (a.fonte) f.add(a.fonte);
    return Array.from(f).join(" · ");
  }

  // ------------------------------------------------------------ folha da rota: restrições (antes de "Iniciar navegação")
  function abrirPerfil() { if (C.abas) C.abas.irPara("veiculo"); }
  function itemRestricao(r, e, classe) {
    const it = el("div", "dados-restr-item " + classe);
    const info = el("div", "dados-restr-info");
    info.append(el("b", null, D.textoRestricao(r)), el("span", null, "a " + D.fmtDistRota(r.ao_longo_m) + " da origem" + (r.uf ? " · " + r.uf : "")));
    if (r.info && r.info.textoFonte) { const f = el("span", "dados-restr-fonte", "Fonte: " + r.info.textoFonte); info.append(f); } // proveniência + idade, sempre
    const motivos = (classe === "viola" ? r.viola : classe === "condicional" ? r.condicional : r.desconhecido) || [];
    if (motivos.length) info.append(el("span", "dados-restr-motivo", motivos.map(classe === "viola" && Dv ? Dv.textoLimites : String).join("; ")));
    if (window.CopilotoPlacas) { it.classList.add("com-placa"); it.append(window.CopilotoPlacas.placa(classe === "viola" ? "restricao_caminhao" : "atencao", { tamanho: 40, decorativa: true })); }
    it.append(info);
    return it;
  }
  // Antes de "Iniciar navegação" só o que pede decisão (cartão vermelho, condicionais, desconhecidas no Avançado, "Informe
  // altura e peso"); o estado ("Verificando…", sem internet, "nenhuma") vai DEPOIS do botão (linhaEstadoRestricoes), para o
  // botão ficar no mesmo lugar de sempre quando não há nada a dizer.
  function cartaoRestricoes(e, r) {
    const bloco = el("div", "dados-restr-bloco"); bloco.id = "dados-restricoes";
    const montar = () => {
      bloco.textContent = ""; bloco.dataset.estado = "";
      const perfil = veiculo();
      if (!caminhao(perfil)) return;
      const falta = D.dimensoesFaltando(perfil);
      if (falta.length) {
        const b = botao("Informe " + (falta.length === 2 ? "altura e peso" : falta[0] === "altura" ? "a altura" : "o peso") + " do caminhão para checar pontes e restrições", "btn dados-restr-perfil", abrirPerfil);
        b.id = "dados-restr-perfil"; bloco.append(b); bloco.dataset.estado = "sem-dimensoes";
        if (falta.length === 2) return;
      }
      const st = e.restricoes.estado;
      if (st !== "ok") { bloco.dataset.estado = st === "carregando" || st === "nada" ? "carregando" : st; return; }
      const res = D.resumoRestricoes(e.restricoes.dados);
      bloco.dataset.estado = res.violadas.length ? "viola" : res.possiveis.length ? "possivel" : res.condicionais.length ? "condicional" : "ok";
      if (res.violadas.length && !mesmoAssim.has(e.chave)) {
        const c = el("div", "dados-restr-cartao viola"); c.id = "dados-restr-viola"; c.setAttribute("role", "alert");
        c.append(el("b", "dados-restr-nao-passa", "VOCÊ NÃO PASSA")); // lote 1 (Stitch P2.3): o aviso grande; o título abaixo diz quantas
        const h3 = el("h3", null, D.tituloRestricoes(res.violadas.length));
        if (window.CopilotoIcones) window.CopilotoIcones.prefixar(h3, "aviso"); // r6: triângulo antes do título (o texto fica)
        c.append(h3);
        const lim0 = Dv && res.violadas[0].viola && res.violadas[0].viola[0] ? Dv.paraLimites(res.violadas[0].viola[0]) : null;
        if (lim0) { // os dois números da primeira restrição (a lista abaixo traz todas, por extenso)
          const caixa = (rotulo, valor) => { const n = el("div", "critico-num"); n.setAttribute("aria-hidden", "true"); n.append(el("small", null, rotulo), el("b", null, valor)); return n; };
          const nums = el("div", "critico-nums");
          nums.append(caixa("Limite da via", Dv.textoMedida(lim0.limite, lim0.unidade)), caixa("Seu caminhão", Dv.textoMedida(lim0.veiculo, lim0.unidade)));
          c.append(nums);
        }
        if (res.violadas[0].info) { const f = el("p", "dados-restr-fonte-0", "Fonte: " + res.violadas[0].info.textoFonte); f.id = "dados-restr-fonte-0"; c.append(f); }
        for (const x of res.violadas.slice(0, 12)) c.append(itemRestricao(x, e, "viola"));
        if (res.violadas.length > 12) c.append(el("p", "dica", "e mais " + (res.violadas.length - 12) + "."));
        const dv = C.desvio ? C.desvio.estado(r) : null;
        const msg = dv ? mensagemDesvio(dv, res.violadas) : null;
        if (msg) { const m = el("p", "dados-desvio-msg " + dv.fase, msg); m.id = "dados-desvio-msg"; m.setAttribute("role", "status"); c.append(m); }
        const bot = el("div", "linha-botoes");
        if (C.desvio && Dv) {
          const buscando = !!dv && dv.fase === "buscando";
          const grande = !!dv && dv.fase === "ok" && dv.facil === false;
          const des = botao(buscando ? "Procurando desvio…" : grande ? "Desviar +" + dv.extraKm + " km" : "Desviar", "btn btn-principal dados-restr-desviar", () => C.desvio.desviar(r)); des.id = "dados-restr-desviar"; des.disabled = buscando;
          bot.append(des);
        }
        const ver = botao("Ver no mapa", "btn", () => verNoMapa(r, "restricoes")); ver.id = "dados-restr-ver";
        if (window.CopilotoIcones) window.CopilotoIcones.prefixar(ver, "mapa");
        const ok = botao("Seguir mesmo assim", "btn dados-restr-mesmo", () => { mesmoAssim.add(e.chave); if (C.desvio && C.desvio.aceitar) C.desvio.aceitar(r); avisar(e, "restricoes"); }); ok.id = "dados-restr-mesmo";
        bot.append(ver, ok); c.append(bot);
        // restrição do OSM é dado da comunidade: limite da via × veículo está em cada item; quem decide é o motorista
        c.append(el("p", "dados-fonte", (Dv ? Dv.AVISO_FONTE : "Segundo o mapa (OSM), dado da comunidade, estimado.") + " " + (res.fonte || "© OpenStreetMap contributors (ODbL)") + ". A ausência de restrição no mapa não libera a via."));
        bloco.append(c);
      }
      if (res.possiveis.length) { // confiança média: âmbar, sem "VOCÊ NÃO PASSA" e sem desvio automático; só sugere
        const c = el("div", "dados-restr-cartao possivel"); c.id = "dados-restr-possivel"; c.setAttribute("role", "status");
        c.append(el("b", "dados-restr-possivel-titulo", "Possível restrição — confira na pista"));
        const h3 = el("h3", null, D.tituloPossiveis(res.possiveis.length));
        if (window.CopilotoIcones) window.CopilotoIcones.prefixar(h3, "aviso");
        c.append(h3);
        for (const x of res.possiveis.slice(0, 12)) c.append(itemRestricao(x, e, "possivel"));
        if (res.possiveis.length > 12) c.append(el("p", "dica", "e mais " + (res.possiveis.length - 12) + "."));
        c.append(el("p", "dados-fonte", "Dado antigo, de um motorista só ou com folga pequena: pode estar errado. O app não desvia sozinho; você decide."));
        const bot = el("div", "linha-botoes");
        if (C.desvio && C.desvio.sugerir) { const sg = botao("Sugerir desvio", "btn dados-restr-sugerir", () => C.desvio.sugerir(r)); sg.id = "dados-restr-sugerir"; bot.append(sg); }
        const ver = botao("Ver no mapa", "btn", () => verNoMapa(r, "restricoes")); ver.id = "dados-restr-ver-possivel"; bot.append(ver);
        c.append(bot);
        bloco.append(c);
      }
      if (res.condicionais.length) {
        const c = el("div", "dados-restr-cartao condicional"); c.id = "dados-restr-cond";
        c.append(el("h3", null, res.condicionais.length + (res.condicionais.length === 1 ? " restrição condicional" : " restrições condicionais") + " (horário, destino ou autorização)"));
        for (const x of res.condicionais.slice(0, 8)) c.append(itemRestricao(x, e, "condicional"));
        bloco.append(c);
      }
      if (res.desconhecidas.length && modo() === "avancado") {
        const c = el("div", "dados-restr-cartao desconhecida"); c.id = "dados-restr-desc";
        c.append(el("h3", null, res.desconhecidas.length + (res.desconhecidas.length === 1 ? " restrição que não deu para avaliar" : " restrições que não deu para avaliar")));
        for (const x of res.desconhecidas.slice(0, 8)) c.append(itemRestricao(x, e, "desconhecida"));
        bloco.append(c);
      }
      if (res.removidas.length && modo() === "avancado") { // contestadas por motoristas: fora da rota, registro mantido
        const c = el("div", "dados-restr-cartao desconhecida"); c.id = "dados-restr-removidas";
        c.append(el("h3", null, res.removidas.length + (res.removidas.length === 1 ? " restrição tirada da rota após contestação de motoristas" : " restrições tiradas da rota após contestação de motoristas")));
        for (const x of res.removidas.slice(0, 8)) c.append(itemRestricao(x, e, "desconhecida"));
        bloco.append(c);
      }
    };
    e.ouvintes.set(bloco, montar); montar();
    return bloco;
  }
  // Texto do estado do desvio dentro do cartão vermelho (nunca diz que a rota é segura)
  function mensagemDesvio(dv, violadas) {
    if (dv.fase === "buscando") return "Procurando um caminho que evite " + (violadas.length === 1 ? "a restrição" : "as restrições") + "…";
    if (dv.fase === "sem") return Dv.textoSemDesvio(violadas);
    if (dv.fase === "falha") return "Não deu para calcular o desvio agora (servidor de rotas). Toque em Desviar para tentar de novo.";
    if (dv.fase === "ok") return "Há um desvio calculado (" + dv.etiqueta + ")" + (dv.facil === false ? ", maior que o normal: você decide." : ".") + " Toque em Desviar para usá-lo.";
    if (dv.fase === "parcial") return "Há um desvio parcial (" + dv.etiqueta + "). " + Dv.textoParcial(dv.restantes);
    return null;
  }
  // Estado das pontes e limites, UMA linha cinza por vez: verificando / não verificado / verificado (com violação: o cartão
  // vermelho; "Mesmo assim": o resumo). Substitui o aviso fixo "Rota não verificada…" de rota.js, que contradizia o resultado.
  function linhaEstadoRestricoes(e) {
    const bloco = el("div", "dados-restr-estado"); bloco.id = "dados-restr-estado";
    const montar = () => {
      bloco.textContent = "";
      const perfil = veiculo();
      if (!caminhao(perfil)) return;
      const falta = D.dimensoesFaltando(perfil);
      if (falta.length === 2) return;
      const st = e.restricoes.estado;
      if (st === "carregando" || st === "nada") { bloco.append(el("p", "dados-restr-verificando", "Verificando pontes e restrições no mapa (OSM)…")); return; }
      if (st !== "ok") { const p = el("p", "dados-restr-falha", st === "offline" ? "Sem internet para checar pontes e restrições. Pontes e limites não verificados; confira a sinalização." : "Não deu para checar pontes e restrições agora. Pontes e limites não verificados; confira a sinalização."); p.id = "dados-restr-falha"; bloco.append(p); return; }
      const res = D.resumoRestricoes(e.restricoes.dados);
      if (res.violadas.length && mesmoAssim.has(e.chave)) {
        const p = el("p", "dados-restr-resumo viola", res.violadas.length + (res.violadas.length === 1 ? " restrição que seu caminhão não passa" : " restrições que seu caminhão não passa") + " (seguindo mesmo assim)"); p.id = "dados-restr-resumo"; bloco.append(p);
      } else if (!res.violadas.length && !res.possiveis.length && !res.condicionais.length && !falta.length) { const p = el("p", "dados-restr-ok", "Verificado no mapa (OSM): nenhuma ponte ou limite cadastrado que o seu caminhão não passe. O mapa pode estar incompleto; confira a sinalização."); p.id = "dados-restr-ok"; bloco.append(p); }
    };
    e.ouvintes.set(bloco, montar); montar();
    return bloco;
  }
  // ------------------------------------------------------------ folha da rota: modo Avançado, contagens
  function linhaAvancado(e, r) {
    const bloco = el("div", "dados-avancado"); bloco.id = "dados-avancado";
    const montar = () => {
      bloco.textContent = "";
      const c = D.contagens(e.avisos), t = D.textoContagens(c);
      const p = e.partes, pend = ["feicoes", "trechos", "artesp"].filter((n) => p[n].estado === "carregando" || p[n].estado === "nada").length;
      const linha = el("div", "dados-avancado-linha");
      if (t) {
        linha.append(el("span", "dados-contagens", t + (pend ? " · verificando…" : "")));
        const ver = botao("Ver no mapa", "btn dados-ver-mapa", () => verNoMapa(r, null)); ver.id = "dados-ver-mapa";
        linha.append(ver);
      } else if (pend) linha.append(el("span", "dados-contagens", "Verificando curvas, balanças e trechos perigosos…"));
      else if (["feicoes", "trechos", "artesp"].every((n) => p[n].estado === "ok")) linha.append(el("span", "dados-contagens", "Nenhuma curva fechada, balança nem trecho perigoso conhecidos nesta rota. Isso não garante via livre."));
      else linha.append(el("span", "dados-contagens falha", "Não deu para verificar curvas e trechos perigosos" + (online() ? "." : " (sem internet).")));
      bloco.append(linha);
      const f = fontes(e);
      if (f) bloco.append(el("p", "dados-fonte", f + ". Estimado."));
    };
    e.ouvintes.set(bloco, montar); montar();
    return bloco;
  }
  C.rotaExtras = C.rotaExtras || { folha: [], cartao: [] };
  C.rotaExtras.antesIniciar = C.rotaExtras.antesIniciar || [];
  C.rotaExtras.antesIniciar.push(function (r) {
    const e = obter(r); if (!e) return null;
    selecionada = e.chave;
    return cartaoRestricoes(e, r);
  });
  C.rotaExtras.folha.push(function (r) {
    const e = obter(r); if (!e) return null;
    const nos = [linhaEstadoRestricoes(e)];
    if (modo() === "avancado") nos.push(linhaAvancado(e, r));
    return nos;
  });

  C.aoIniciar(() => {
    C.on("rota", (r) => { if (!r || !r.coords) return; const e = obter(r); if (e) selecionada = e.chave; limparMarcadores(); });
    C.on("rota-limpa", () => { selecionada = null; folhaAnterior = null; limparMarcadores(); });
    C.on("navegacao", aoNavegar);
    C.on("desvio:estado", (d) => { const e = d && entradas.get(d.chave); if (e) avisar(e, "desvio"); else if (selecionada) { const x = entradas.get(selecionada); if (x) avisar(x, "desvio"); } });
    C.on("veiculo", () => { for (const e of entradas.values()) if (e.chave === selecionada) buscarRestricoes(e, veiculo()); });
    window.addEventListener("online", tentarDeNovo);
  });

  C.dadosRota = { obter, avisosDe, snvDe, restricoesDe, restricoesJa, restricoesDeRota, verNoMapa, estado: (r) => { const e = obter(r); return e ? { feicoes: e.partes.feicoes.estado, trechos: e.partes.trechos.estado, artesp: e.partes.artesp.estado, snv: e.partes.snv.estado, restricoes: e.restricoes.estado, guardado: e.guardado } : null; },
    entradas, faixa: () => (faixa && !faixa.hidden ? { texto: faixa.querySelector(".aviso-dado-texto").textContent, dist: faixa.querySelector(".aviso-dado-dist").textContent, tipo: faixa.dataset.tipo } : null) };
})(window.Copiloto);
