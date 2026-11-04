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
  function chaveDims(p) { return caminhao(p) ? ["c", p.altura, p.pbtc, p.comprimento, p.largura].map((x) => (typeof x === "number" ? x : "-")).join("/") : "a"; }
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
    e.avisos = D.juntarAvisos(listas);
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
    pedirParte(e, "feicoes", () => rpc("copiloto_route_features", { p_route: geo(e), p_kinds: KINDS, p_buffer_m: 40, p_limit: 2000 }));
    pedirParte(e, "trechos", () => rpc("copiloto_route_hot_spots", { p_route: geo(e), p_buffer_m: 100, p_min_level: 2 }));
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
    try { r.dados = await rpc("copiloto_route_restrictions", params); r.estado = "ok"; }
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
  const snvDe = (r) => { const e = obter(r); return e && e.partes.snv.dados ? D.usarSnv(e.partes.snv.dados, e.distanciaM) : null; };
  const avisosDe = (r) => { const e = obter(r); return e ? e.avisos.slice() : []; };
  const restricoesDe = (r) => { const e = obter(r); return e && e.restricoes.dados ? D.resumoRestricoes(e.restricoes.dados) : null; };

  // ------------------------------------------------------------ navegando: avisos de proximidade
  function criarFaixa() {
    const p = $("nav-painel"); if (!p || faixa) return;
    faixa = el("div", "aviso-dado"); faixa.id = "aviso-dado"; faixa.hidden = true; faixa.setAttribute("role", "status"); faixa.setAttribute("aria-live", "polite");
    const km = $("km-atual");
    if (km && km.parentNode === p) p.insertBefore(faixa, km.nextSibling); else { const seg = $("nav-seguinte"); if (seg && seg.parentNode === p) p.insertBefore(faixa, seg.nextSibling); else p.appendChild(faixa); }
  }
  function mostrarFaixa(a, distM) {
    if (!faixa) criarFaixa(); if (!faixa) return;
    faixa.textContent = "";
    faixa.append(el("span", "aviso-dado-texto", a.texto), el("span", "aviso-dado-dist", distM < 50 ? "aqui" : D.fmtDistRota(distM)));
    faixa.dataset.tipo = a.tipo; faixa.hidden = false;
    clearTimeout(faixaTimer); faixaTimer = setTimeout(esconderFaixa, 20000);
  }
  // intervalo mínimo entre falas (20 s; window.COPILOTO_AVISO_INTERVALO_MS encurta nos testes)
  function opcoesAvisador() { const ms = Number(window.COPILOTO_AVISO_INTERVALO_MS); return ms > 0 ? { intervaloMs: ms } : {}; }
  function esconderFaixa() { clearTimeout(faixaTimer); if (faixa) faixa.hidden = true; }
  function falar(a, distM) {
    if (!C.voz || !C.voz.falar) return;
    if (C.voz.emAlerta && C.voz.emAlerta()) return; // alerta de relato falando: a faixa fica, a fala não briga
    C.voz.falar(D.falaAviso(a, distM), { naoInterromper: true, esperaMaxMs: 8000 });
    C.emit("dados:aviso", { aviso: a, distanciaM: distM });
  }
  function aoNavegar(d) {
    if (!d || d.ativa === false) { avisador = null; avisadorChave = null; esconderFaixa(); return; }
    if (!faixa) criarFaixa();
    const e = obter({ coords: d.coords }); if (!e) return;
    if (avisadorChave !== e.chave) { avisadorChave = e.chave; avisador = D.criarAvisador(e.avisos, opcoesAvisador()); selecionada = e.chave; }
    if (!avisador) return;
    const g = C.estado.gps;
    const r = avisador.atualizar({ progressoM: d.progresso_m, kmh: g ? g.kmh : null });
    if (r.falar) { mostrarFaixa(r.falar, r.distanciaM); falar(r.falar, r.distanciaM); }
    else if (r.mostrar) mostrarFaixa(r.mostrar, r.distanciaM);
  }

  // ------------------------------------------------------------ mapa: marcadores
  function limparMarcadores() { for (const m of marcadores) m.remove(); marcadores = []; }
  function marcador(a, classe) {
    const d = el("div", "dados-marca " + classe); d.textContent = a.sigla || "!"; d.title = a.texto;
    return new maplibregl.Marker({ element: d }).setLngLat([a.lon, a.lat]);
  }
  function enquadrar(pts, coords) {
    const alvo = pts.length > 1 ? pts : coords;
    if (C.rotaLonga && C.rotaLonga.enquadrar) { setTimeout(() => C.rotaLonga.enquadrar(alvo), 80); return; }
    C.mapaPronto(() => { try { C.mapa.fitBounds(alvo.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(alvo[0], alvo[0])), { padding: 60, duration: 500 }); } catch (x) { /* ignora */ } });
  }
  const SIGLA = { restricao: "✕", perigoso: "⚠", balanca: "⚖", curva: "↪", passagem_nivel: "🚂", lombada: "▲", lombadas: "▲", radar: "◎", balsa: "⛴", area_escape: "⤵", perigo: "!", obra: "🚧", praca_pedagio: "$" };
  // tipo: "restricoes" (só as violadas) ou null (todos os avisos)
  function verNoMapa(r, tipo) {
    const e = obter(r); if (!e) return;
    limparMarcadores();
    const lista = tipo === "restricoes" ? e.avisos.filter((a) => a.tipo === "restricao") : e.avisos;
    C.mapaPronto(() => { for (const a of lista) { const m = marcador(Object.assign({ sigla: SIGLA[a.tipo] }, a), a.tipo === "restricao" ? "viola" : a.tipo); m.addTo(C.mapa); marcadores.push(m); } });
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
    const motivos = (classe === "viola" ? r.viola : classe === "condicional" ? r.condicional : r.desconhecido) || [];
    if (motivos.length) info.append(el("span", "dados-restr-motivo", motivos.join("; ")));
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
      bloco.dataset.estado = res.violadas.length ? "viola" : res.condicionais.length ? "condicional" : "ok";
      if (res.violadas.length && !mesmoAssim.has(e.chave)) {
        const c = el("div", "dados-restr-cartao viola"); c.id = "dados-restr-viola"; c.setAttribute("role", "alert");
        c.append(el("h3", null, D.tituloRestricoes(res.violadas.length)));
        for (const x of res.violadas.slice(0, 12)) c.append(itemRestricao(x, e, "viola"));
        if (res.violadas.length > 12) c.append(el("p", "dica", "e mais " + (res.violadas.length - 12) + "."));
        const bot = el("div", "linha-botoes");
        const ver = botao("Ver no mapa", "btn", () => verNoMapa(r, "restricoes")); ver.id = "dados-restr-ver";
        const ok = botao("Mesmo assim", "btn", () => { mesmoAssim.add(e.chave); avisar(e, "restricoes"); }); ok.id = "dados-restr-mesmo";
        bot.append(ver, ok); c.append(bot);
        c.append(el("p", "dados-fonte", "Dado do mapa aberto, estimado: " + (res.fonte || "© OpenStreetMap contributors (ODbL)") + ". A ausência de restrição no mapa não libera a via."));
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
    };
    e.ouvintes.set(bloco, montar); montar();
    return bloco;
  }
  function linhaEstadoRestricoes(e) {
    const bloco = el("div", "dados-restr-estado"); bloco.id = "dados-restr-estado";
    const montar = () => {
      bloco.textContent = "";
      const perfil = veiculo();
      if (!caminhao(perfil)) return;
      const falta = D.dimensoesFaltando(perfil);
      if (falta.length === 2) return;
      const st = e.restricoes.estado;
      if (st === "carregando" || st === "nada") { bloco.append(el("p", "dados-restr-verificando", "Verificando pontes e restrições…")); return; }
      if (st !== "ok") { const p = el("p", "dados-restr-falha", st === "offline" ? "Sem internet para checar pontes e restrições." : "Não deu para checar pontes e restrições agora."); p.id = "dados-restr-falha"; bloco.append(p); return; }
      const res = D.resumoRestricoes(e.restricoes.dados);
      if (res.violadas.length && mesmoAssim.has(e.chave)) {
        const p = el("p", "dados-restr-resumo viola", res.violadas.length + (res.violadas.length === 1 ? " restrição que seu caminhão não passa" : " restrições que seu caminhão não passa") + " (seguindo mesmo assim)"); p.id = "dados-restr-resumo"; bloco.append(p);
      } else if (!res.violadas.length && !res.condicionais.length && !falta.length) { const p = el("p", "dados-restr-ok", "Pontes e restrições cadastradas no mapa: nenhuma que o seu caminhão não passe (estimado)."); p.id = "dados-restr-ok"; bloco.append(p); }
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
      else if (["feicoes", "trechos", "artesp"].every((n) => p[n].estado === "ok")) linha.append(el("span", "dados-contagens", "Sem curva forte, balança nem trecho perigoso cadastrado na rota."));
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
    C.on("veiculo", () => { for (const e of entradas.values()) if (e.chave === selecionada) buscarRestricoes(e, veiculo()); });
    window.addEventListener("online", tentarDeNovo);
  });

  C.dadosRota = { obter, avisosDe, snvDe, restricoesDe, verNoMapa, estado: (r) => { const e = obter(r); return e ? { feicoes: e.partes.feicoes.estado, trechos: e.partes.trechos.estado, artesp: e.partes.artesp.estado, snv: e.partes.snv.estado, restricoes: e.restricoes.estado, guardado: e.guardado } : null; },
    entradas, faixa: () => (faixa && !faixa.hidden ? { texto: faixa.querySelector(".aviso-dado-texto").textContent, dist: faixa.querySelector(".aviso-dado-dist").textContent, tipo: faixa.dataset.tipo } : null) };
})(window.Copiloto);
