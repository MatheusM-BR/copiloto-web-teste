// Destino e rota (Valhalla). Expõe Copiloto.rota: destino(), atual(), pedirDestino(v), definirDestino(lngLat, { rotulo? }),
// tracar(), limpar(), calcular(opcoes) (sem folha: usado pela navegação para recalcular; com consultar: true só calcula),
// usar(rota) (passa a usar uma rota calculada com consultar: a conferência da rota offline pela navegação),
// alternativas() e escolher(i) (as opções de rota mostradas ao traçar).
// Emite "destino" ({lat, lon} | null), "rota" (rota traçada ou a alternativa escolhida, com a resposta bruta do servidor),
// "rota-erro" ({ motivo }) e "rota-limpa".
//
// Alternativas (alternativas.js): "Traçar rota" pede até 3 rotas ao servidor ("alternates"). A principal vem
// pré-escolhida; as outras ficam cinza no mapa e em cartões na folha (tocar na linha ou no cartão escolhe). Escolher
// emite "rota" com a escolhida (a rota guardada do E3 e a navegação usam ela). Ao tocar em "Iniciar navegação" as
// alternativas somem. O recálculo de carregado/vazio no início da navegação segue a escolhida (pontos de passagem);
// o recálculo durante a navegação pede uma rota só, sem alternativas e sem passagem.
(function (C) {
  "use strict";
  const { $, el, botao } = C.util;
  const Rota = window.CopilotoRota;
  const Alt = window.CopilotoAlternativas;
  const RP = window.CopilotoRotaPref;
  const COR_ROTA = "#2f80ed", COR_ALTERNATIVA = "#aab4c3";
  let marcadorDestino = null, destino = null, rotaAtual = null, geracao = 0;
  let rotuloDestino = null; // nome do lugar (destino por voz/busca), vai na rota e nos destinos recentes
  // opções mostradas ao traçar: { rotas, escolhida, infos: [{ rotulo, comparacao, etiquetas, relatos, caract }] } ou null
  let opcoes = null;
  // alternativa escolhida (não a principal): { destino, coords, pontos } para o recálculo de carregado/vazio passar por ela
  let passagem = null;
  let toqueLigado = false, rotaToqueLigado = false;
  // Desvio ativo (ui/desvio.js): { destino, alvos } — os quadrados a evitar valem para TODO cálculo ao mesmo destino (inclusive
  // os recálculos da navegação, que não sabem do desvio) até o motorista escolher outra rota, limpar ou trocar o destino.
  let desvioAtivo = null;

  // ------------------------------------------------------------ rodada 6: preferências, paradas, selo de compatibilidade
  // Preferências de rota ("Sem pedágio", "Sem balsa", "Sem estrada de terra"): lembradas (localStorage, com try/catch), valem
  // para TODO cálculo (inclusive o recálculo da navegação) e só entram o que o servidor suporta (/status).
  let prefs = RP.normalizarPrefs(lerPrefs());
  let suporte = null;           // resposta de RP.suporteDoStatus (null = ainda não consultei)
  let baseInfo = null;          // { chave, minutos, km, custo, comparado } da rota SEM as preferências (para mostrar o "a mais")
  let paradas = [];             // paradas intermediárias da viagem atual: [{ lat, lon, rotulo, alongM? }], só para o destino atual
  let paradasDestino = null;    // destino a que as paradas pertencem
  let marcadoresParada = [];
  function lerPrefs() { try { return JSON.parse(localStorage.getItem(RP.CHAVE_PREFS) || "null"); } catch (e) { return null; } }
  function gravarPrefs() { try { localStorage.setItem(RP.CHAVE_PREFS, JSON.stringify(prefs)); } catch (e) { /* sem armazenamento: vale só nesta sessão */ } }
  const prefsEfetivas = () => RP.efetivas(prefs, suporte);
  async function consultarSuporte() {
    if (suporte && suporte.conhecido) return suporte;
    if (navigator.onLine === false) { suporte = suporte || RP.suporteDoStatus(null); return suporte; }
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(RP.urlStatus(window.COPILOTO_URL_ROTA || Rota.URL_PADRAO), { signal: ctl.signal });
      suporte = RP.suporteDoStatus(r.ok ? await r.json().catch(() => null) : null);
    } catch (e) { suporte = suporte || RP.suporteDoStatus(null); }
    finally { clearTimeout(t); }
    return suporte;
  }
  function paradasDoDestino(dest) { return paradasDestino && mesmoPonto(paradasDestino, dest) ? paradas : []; }

  // Redesenho: escolher destino é pela busca ("Para onde?": recentes, coordenada, postos) ou pelo toque no mapa
  // ("Ir para cá", ui/busca.js). O toque no mapa nunca vira destino sozinho. pedirDestino(true) abre a busca;
  // pedirDestino(false) fecha a busca, se estiver aberta.
  function pedirDestino(v) {
    if (v) { C.abas.irPara("busca"); return; }
    if (C.abas.atual() === "busca") C.abas.irPara("mapa");
  }

  // extra.rotulo: nome do lugar (busca, voz); aparece na folha e vai na rota (rota.rotulo → destinos recentes)
  function definirDestino(lngLat, extra) {
    if (desvioAtivo && !mesmoPonto(desvioAtivo.destino, { lat: lngLat.lat, lon: lngLat.lng })) desvioAtivo = null;
    destino = { lat: lngLat.lat, lon: lngLat.lng };
    rotuloDestino = (extra && extra.rotulo) || null;
    if (marcadorDestino) marcadorDestino.remove();
    marcadorDestino = new maplibregl.Marker({ element: pinoDestino() }).setLngLat([destino.lon, destino.lat]).addTo(C.mapa);
    if (C.abas.atual() === "busca") C.abas.irPara("mapa");
    esconderAlternativas(); passagem = null;
    if (!(paradasDestino && mesmoPonto(paradasDestino, destino))) limparParadas();
    C.emit("destino", destino);
    folhaDestino();
  }

  // Folha de decisão (destino escolhido, rota traçada): marcada para a busca empilhar o "ponto no mapa" por cima
  // e devolvê-la depois (ui/busca.js); o pino do destino e a linha da rota a reabrem (reabrirFolha).
  function marcarDecisao() { const f = $("folha"); if (f) f.dataset.decisao = "1"; }
  function folhaDestino() {
    const botoes = el("div", "linha-botoes");
    botoes.append(
      botao("Traçar rota", "btn btn-principal", tracarRota),
      botao("Cancelar", "btn", limparRota));
    C.folha.abrir([el("h2", null, "Destino escolhido")].concat(rotuloDestino ? [el("p", "rota-rotulo", rotuloDestino)] : []).concat([el("p", null, destino.lat.toFixed(5).replace(".", ",") + ", " + destino.lon.toFixed(5).replace(".", ",")), botoes]));
    marcarDecisao();
  }
  function pinoDestino() {
    const pino = el("div", "pino-destino");
    pino.addEventListener("click", (e) => { e.stopPropagation(); reabrirFolha(); });
    return pino;
  }
  // Reabre a folha do destino/rota (toque no pino ou na linha da rota). Navegando não faz nada: a folha é da navegação.
  function reabrirFolha() {
    if (!destino || navAtiva()) return false;
    const f = $("folha");
    if (f && !f.hidden && f.dataset.decisao === "1") return true; // já está aberta
    if (rotaAtual && rotaAtual.perfil !== undefined) folhaRota(rotaAtual, rotaAtual.perfil);
    else folhaDestino();
    return true;
  }

  function limparRota() {
    const tinha = !!destino || !!rotaAtual;
    destino = null; rotuloDestino = null; rotaAtual = null; geracao++;
    esconderAlternativas(); passagem = null; desvioAtivo = null; baseInfo = null; limparParadas();
    if (marcadorDestino) { marcadorDestino.remove(); marcadorDestino = null; }
    const mapa = C.mapa;
    for (const id of ["rota-toque", "rota"]) if (mapa.getLayer(id)) mapa.removeLayer(id);
    if (mapa.getSource("rota")) mapa.removeSource("rota");
    C.folha.fechar();
    if (tinha) { C.emit("destino", null); C.emit("rota-limpa"); }
  }

  function desenharRota(coords, enquadrar) {
    C.mapaPronto(() => {
      const mapa = C.mapa;
      const dados = { type: "Feature", geometry: { type: "LineString", coordinates: coords } };
      if (mapa.getSource("rota")) mapa.getSource("rota").setData(dados);
      else {
        mapa.addSource("rota", { type: "geojson", data: dados });
        mapa.addLayer({ id: "rota", type: "line", source: "rota", layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": COR_ROTA, "line-width": 7, "line-opacity": 0.95 } });
      }
      // faixa larga e invisível por cima: tocar na rota reabre a folha dela (as cinzas escolhem outra opção)
      if (!mapa.getLayer("rota-toque")) {
        mapa.addLayer({ id: "rota-toque", type: "line", source: "rota", layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#000", "line-width": 30, "line-opacity": 0.01 } });
      }
      if (!rotaToqueLigado) {
        rotaToqueLigado = true;
        // o mapa mudou de tamanho (a faixa de status entrou ou saiu, o celular girou) com a folha da rota aberta: enquadra de novo
        let tr = null;
        mapa.on("resize", () => {
          clearTimeout(tr);
          tr = setTimeout(() => { const f = $("folha"); if (rotaAtual && !navAtiva() && f && !f.hidden && f.dataset.decisao === "1") enquadrarRota(); }, 150);
        });
        // a folha cresce quando o bloco de custos (pedágio e combustível) chega: enquadra de novo pela altura nova
        const fo = $("folha");
        if (fo && typeof ResizeObserver === "function") {
          let tf = null, ultima = 0;
          new ResizeObserver(() => {
            const h = fo.getBoundingClientRect().height;
            if (Math.abs(h - ultima) < 4) return;
            ultima = h;
            clearTimeout(tf);
            tf = setTimeout(() => { if (rotaAtual && !navAtiva() && !fo.hidden && fo.dataset.decisao === "1") enquadrarRota(); }, 200);
          }).observe(fo);
        }
        mapa.on("click", "rota-toque", (e) => {
          const alt = mapa.getLayer("rota-alt-toque") && mapa.queryRenderedFeatures(e.point, { layers: ["rota-alt-toque"] }).length;
          if (!alt) reabrirFolha();
        });
      }
      if (enquadrar === false) return;
      enquadrarRota(coords);
    });
  }

  // Enquadra a rota (e as outras opções) na parte do mapa que sobra entre a barra do topo e a folha, medidas de verdade
  // (a folha tem alturas diferentes em cada tela; o pino do destino não pode ficar sob a barra nem sob a folha).
  function enquadrarRota(coordsUnica) {
    const mapa = C.mapa; if (!mapa) return;
    const caixa = mapa.getContainer().getBoundingClientRect();
    const f = $("folha"), t = $("barra-topo");
    const topoFolha = f && !f.hidden ? f.getBoundingClientRect().top : caixa.bottom - 24;
    const fundoBarra = t && t.getBoundingClientRect().height ? t.getBoundingClientRect().bottom : caixa.top;
    // com várias opções a folha é alta e sobra pouco mapa: a margem sob a barra é mínima; com uma rota só, folga para o pino inteiro
    let cima = Math.max(24, fundoBarra - caixa.top + (opcoes ? 8 : 28));
    let baixo = Math.max(24, caixa.bottom - topoFolha + 24);
    const sobra = caixa.height - cima - baixo;
    if (sobra < 80) {
      // falta mapa: a folga de baixo cede primeiro (até encostar na folha); o pino precisa do espaço de cima inteiro
      let falta = 80 - sobra;
      const minBaixo = Math.max(8, caixa.bottom - topoFolha + 8);
      const tira = Math.min(falta, Math.max(0, baixo - minBaixo)); baixo -= tira; falta -= tira;
      if (falta > 0) cima = Math.max(fundoBarra - caixa.top + 26, cima - falta);
    }
    let b = null;
    const juntar = (cs) => { for (const c of cs) b = b ? b.extend(c) : new maplibregl.LngLatBounds(c, c); };
    if (opcoes) for (const r of opcoes.rotas) juntar(r.coords);
    else if (coordsUnica) juntar(coordsUnica);
    else if (rotaAtual) juntar(rotaAtual.coords);
    if (destino) juntar([[destino.lon, destino.lat]]);
    if (!b) return;
    try { mapa.fitBounds(b, { padding: { top: cima, bottom: baixo, left: 36, right: 36 }, duration: 500 }); } catch (e) { /* tela pequena demais */ }
  }

  // ------------------------------------------------------------ alternativas no mapa
  function desenharAlternativas() {
    if (!opcoes) return;
    const outras = opcoes.rotas.map((r, i) => ({ r, i })).filter((x) => x.i !== opcoes.escolhida);
    C.mapaPronto(() => {
      const mapa = C.mapa;
      if (!opcoes) return;
      const dados = { type: "FeatureCollection", features: outras.map((x) => ({ type: "Feature", properties: { i: x.i },
        geometry: { type: "LineString", coordinates: x.r.coords } })) };
      if (mapa.getSource("rota-alt")) mapa.getSource("rota-alt").setData(dados);
      else {
        mapa.addSource("rota-alt", { type: "geojson", data: dados });
        const antes = mapa.getLayer("rota") ? "rota" : undefined;
        mapa.addLayer({ id: "rota-alt", type: "line", source: "rota-alt", layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": COR_ALTERNATIVA, "line-width": 6, "line-opacity": 0.8 } }, antes);
        // faixa larga e invisível por cima: o dedo acerta a linha cinza sem precisar de pontaria
        mapa.addLayer({ id: "rota-alt-toque", type: "line", source: "rota-alt", layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#000", "line-width": 34, "line-opacity": 0.01 } });
      }
      if (!toqueLigado) {
        toqueLigado = true;
        mapa.on("click", "rota-alt-toque", (e) => {
          const f = e.features && e.features[0];
          if (f && f.properties && f.properties.i != null) escolher(Number(f.properties.i));
        });
      }
    });
  }
  function esconderAlternativas() {
    opcoes = null;
    const mapa = C.mapa; if (!mapa) return;
    C.mapaPronto(() => {
      if (opcoes) return; // outras opções chegaram antes deste gancho
      for (const id of ["rota-alt-toque", "rota-alt"]) if (mapa.getLayer(id)) mapa.removeLayer(id);
      if (mapa.getSource("rota-alt")) mapa.removeSource("rota-alt");
    });
  }
  // ------------------------------------------------------------ paradas intermediárias (postos no trajeto)
  function limparParadas() {
    paradas = []; paradasDestino = null;
    for (const m of marcadoresParada) m.remove();
    marcadoresParada = [];
  }
  function desenharParadas() {
    for (const m of marcadoresParada) m.remove();
    marcadoresParada = [];
    if (!C.mapa || typeof maplibregl === "undefined") return;
    paradas.forEach((p, i) => {
      const e = el("div", "pino-parada", String(i + 1));
      e.title = "Parada: " + (p.rotulo || "posto");
      marcadoresParada.push(new maplibregl.Marker({ element: e }).setLngLat([p.lon, p.lat]).addTo(C.mapa));
    });
  }
  // Navegando: a parada que o caminhão já alcançou sai da lista (senão o recálculo seguinte mandaria voltar a ela).
  function conferirParadasFeitas(d) {
    if (!d || !d.ativa || !paradas.length || !rotaAtual || !rotaAtual.paradasM || !isFinite(d.progresso_m)) return;
    const faltam = RP.aindaFaltam(paradas, rotaAtual.paradasM, d.progresso_m);
    if (faltam.length === paradas.length) return;
    paradas = faltam; rotaAtual.paradasM = rotaAtual.paradasM.slice(rotaAtual.paradasM.length - faltam.length);
    desenharParadas();
    C.emit("paradas", { paradas: paradas.map((x) => Object.assign({}, x)) });
  }
  // Põe um posto como parada da viagem atual, SEM perder a rota nem o destino. Sem rota/destino: devolve false (quem chama
  // faz o "Ir até lá" de sempre). Fora da navegação recalcula daqui e reabre a folha; navegando, quem recalcula é a navegação
  // (C.navegacao.adicionarParada). Rota longa (dividida em trechos) não aceita parada: devolve "longa".
  async function adicionarParada(parada) {
    if (!destino || !parada) return false;
    if (rotaAtual && rotaAtual.resposta && rotaAtual.resposta.longa) return "longa";
    const lista = RP.adicionarParada(paradasDoDestino(destino), parada);
    if (lista.length === paradasDoDestino(destino).length) return "repetida";
    const antes = paradas, antesDestino = paradasDestino;
    paradas = lista; paradasDestino = { lat: destino.lat, lon: destino.lon };
    if (navAtiva()) {
      const ok = C.navegacao.adicionarParada ? await C.navegacao.adicionarParada() : false;
      if (!ok) { paradas = antes; paradasDestino = antesDestino; desenharParadas(); return false; }
      desenharParadas();
      C.emit("paradas", { paradas: paradas.map((x) => Object.assign({}, x)) });
      return true;
    }
    const pos = C.estado.ultimaPos;
    if (!pos) { paradas = antes; paradasDestino = antesDestino; C.mensagem("Ative o GPS para saber de onde você sai.", 6000); return false; }
    const ctl = new AbortController();
    C.folha.abrir([el("h2", null, "Acrescentando a parada…"), el("p", null, (parada.rotulo || "Posto") + " entra no caminho, o destino continua o mesmo."),
      botao("Cancelar", "btn btn-grande", () => { ctl.abort(); paradas = antes; paradasDestino = antesDestino; desenharParadas(); if (rotaAtual) folhaRota(rotaAtual, rotaAtual.perfil); else folhaDestino(); })]);
    try {
      const r = await calcular({ origem: { lat: pos[1], lon: pos[0] }, perfil: C.veiculos.ativo(), sinal: ctl.signal, enquadrar: false });
      desenharParadas();
      folhaRota(r, r.perfil);
      C.emit("paradas", { paradas: paradas.map((x) => Object.assign({}, x)) });
      try { if (C.voz && C.voz.falar) C.voz.falar("Parada acrescentada: " + (parada.rotulo || "posto") + ".", { naoInterromper: true }); } catch (e) { /* a voz nunca derruba */ }
      return true;
    } catch (e) {
      if (e.cancelada || ctl.signal.aborted) return false;
      paradas = antes; paradasDestino = antesDestino; desenharParadas();
      const b = el("div", "linha-botoes");
      b.append(botao("Voltar à rota", "btn btn-principal btn-grande", () => { if (rotaAtual) folhaRota(rotaAtual, rotaAtual.perfil); else folhaDestino(); }));
      C.folha.abrir([el("h2", null, "Não deu para acrescentar a parada"), el("p", null, (e.motivo || e.message) + " A rota anterior continua valendo."), b]);
      return false;
    }
  }
  function removerParada(i) {
    if (!(i >= 0 && i < paradas.length) || navAtiva()) return false;
    paradas = paradas.filter((_, j) => j !== i);
    if (!paradas.length) paradasDestino = null;
    desenharParadas();
    tracarRota();
    return true;
  }

  // ------------------------------------------------------------ cálculo
  function navAtiva() { return !!(C.navegacao && typeof C.navegacao.ativa === "function" && C.navegacao.ativa()); }
  const mesmoPonto = (a, b) => !!a && !!b && Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
  // Pontos de passagem da alternativa escolhida que ainda estão à frente de quem sai de "origem" (fora da navegação,
  // mesmo destino). A origem longe da escolhida (> 1 km): nada (o motorista já está em outro caminho).
  function passagemAutomatica(origem, dest) {
    if (!passagem || navAtiva() || !mesmoPonto(dest, passagem.destino)) return null;
    let iOrigem = -1, dMin = Infinity;
    passagem.coords.forEach((c, i) => { const d = Math.hypot((c[0] - origem.lon) * Math.cos(origem.lat * Math.PI / 180), c[1] - origem.lat); if (d < dMin) { dMin = d; iOrigem = i; } });
    if (dMin * 111320 > 1000) return null;
    const pts = passagem.pontos.filter((p) => p.indice > iOrigem);
    return pts.length ? pts : null;
  }

  async function pedirAoServidor(pedido, o, sinal, minha) {
    const cancelada = () => { const e = new Error("Rota cancelada."); e.motivo = e.message; e.cancelada = true; return e; };
    if (sinal && sinal.aborted) throw cancelada();
    const ctl = new AbortController(); let demorou = false;
    const t = setTimeout(() => { demorou = true; ctl.abort(); }, o.tempoLimiteMs || 25000);
    const desistir = () => ctl.abort();
    if (sinal) sinal.addEventListener("abort", desistir);
    let json;
    try {
      const resp = await fetch(window.COPILOTO_URL_ROTA || Rota.URL_PADRAO, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pedido), signal: ctl.signal,
      });
      json = await resp.json().catch(() => null);
    } catch (e) {
      if (sinal && sinal.aborted) throw cancelada();
      const erro = new Error(demorou ? "O servidor de rotas demorou demais." : "Sem conexão com o servidor de rotas.");
      erro.motivo = erro.message; erro.rede = true; erro.demorou = demorou; throw erro;
    } finally { clearTimeout(t); if (sinal) sinal.removeEventListener("abort", desistir); }
    if (minha !== geracao || (sinal && sinal.aborted)) throw cancelada();
    return json;
  }

  // Rota longa (ui/rotalonga.js): acima do limite do servidor (reta > ~1.400 km) divide em trechos, pede cada um e emenda
  // numa resposta só; abaixo disso é o pedido de sempre. Sem o módulo, nada muda.
  function pedirComDivisao(pedido, o, sinal, minha) {
    return C.rotaLonga ? C.rotaLonga.pedir(pedido, o, sinal, minha, pedirAoServidor) : pedirAoServidor(pedido, o, sinal, minha);
  }
  // Ganchos de outros módulos para a folha da rota (ui/rotalonga.js: "Rota em N trechos"; ui/via.js: "Via do trajeto", terra e
  // piso ruim): C.rotaExtras.folha(rota, opcoes) → nó(s) e C.rotaExtras.cartao(rota, i) → nó (linha dentro do cartão da alternativa).
  C.rotaExtras = C.rotaExtras || { folha: [], cartao: [] };
  C.rotaExtras.antesIniciar = C.rotaExtras.antesIniciar || []; // ui/avisos.js: cartão de restrições ANTES de "Iniciar navegação"
  // Extras que dependem da rota escolhida (restrições, estado, via): com várias opções, trocam de lugar quando a escolha muda.
  // Cada grupo tem uma âncora escondida; os nós ficam logo depois dela.
  const grupos = {};
  function trocaveis(tipo, r, op) {
    const ancora = el("div"); ancora.hidden = true; ancora.dataset.extras = tipo;
    const nos = extras(tipo, r, op);
    grupos[tipo] = { ancora, nos };
    return [ancora].concat(nos);
  }
  function trocarExtras(r) {
    for (const tipo of Object.keys(grupos)) {
      const g = grupos[tipo];
      if (!g.ancora.isConnected) continue;
      for (const n of g.nos) if (n.parentNode) n.remove();
      g.nos = extras(tipo, r, opcoes);
      let ref = g.ancora;
      for (const n of g.nos) { ref.after(n); ref = n; }
    }
  }
  function extras(tipo, a, b) {
    const out = [];
    for (const f of C.rotaExtras[tipo] || []) { try { const x = f(a, b); if (x) out.push(...[].concat(x)); } catch (e) { /* o extra não derruba a folha */ } }
    return out;
  }

  // Calcula a rota sem mexer na folha. opcoes: { origem, destino?, perfil?, ajustar?(pedido, faltando) → { pedido, faltando,
  // avisos? }, enquadrar? (padrão true), sinal? (AbortSignal: quem pediu desiste, nada é desenhado), tempoLimiteMs?
  // (padrão 25 s; o recálculo da navegação usa menos), alternativas? (true: pede até 3 rotas; só "Traçar rota"),
  // passarPor? (false: nunca usa os pontos de passagem da alternativa escolhida) }. Desenha, guarda como rota atual,
  // emite "rota" e devolve a rota.
  // Erro: Error com .motivo (português) e .rede = true quando o servidor não respondeu (sem internet ou demora; na
  // demora também .demorou = true); .cancelada = true quando a rota foi limpa ou o sinal desistiu.
  async function calcular(o) {
    const dest = o.destino || destino;
    const perfil = o.perfil !== undefined ? o.perfil : C.veiculos.ativo();
    // preferências (o.prefs: {} para a rota normal; padrão = as ligadas e suportadas) e paradas (o.paradas; padrão = as da viagem)
    const pr = o.prefs !== undefined ? RP.efetivas(o.prefs, { semPedagio: true, semBalsa: true, semTerra: true }) : prefsEfetivas();
    if (o.semPedagio) pr.semPedagio = true;
    const ps = o.paradas !== undefined ? o.paradas : paradasDoDestino(dest);
    let { pedido, faltando } = Rota.criarPedido(perfil, o.origem, dest, { semPedagio: pr.semPedagio, semBalsa: pr.semBalsa, semTerra: pr.semTerra, paradas: ps });
    let extras = [];
    if (o.ajustar) { const a = o.ajustar(pedido, faltando); pedido = a.pedido; faltando = a.faltando; extras = a.avisos || []; }
    const minha = geracao;
    const sinal = o.sinal || null;
    // Desvio: o.poligonos (quadrados { anel, … } pedidos agora) ou o desvio ativo ao mesmo destino (o.desviar === false não usa)
    const alvos = o.poligonos !== undefined ? o.poligonos : (o.desviar !== false && desvioAtivo && mesmoPonto(dest, desvioAtivo.destino) ? desvioAtivo.alvos : null);
    const pedidoBase = pedido;
    if (alvos && alvos.length && window.CopilotoDesvio) pedido = window.CopilotoDesvio.aplicar(pedido, alvos);
    const comDesvio = pedido !== pedidoBase;
    let pontos = null;
    if (o.alternativas) pedido = Alt.pedirAlternativas(pedido);
    else if (!o.consultar && o.passarPor !== false && !(ps && ps.length)) {
      pontos = passagemAutomatica(o.origem, dest);
      if (pontos) pedido = Alt.aplicarPassagem(pedido, pontos);
    }
    let json = await pedirComDivisao(pedido, o, sinal, minha);
    let r;
    try { r = Rota.resumirResposta(json); } catch (e) {
      if (comDesvio && o.poligonos === undefined) {
        // Desvio ativo de antes (recálculo da navegação) sem caminho que o respeite: traça a melhor rota e AVISA que ela pode
        // passar pela restrição. Desvio pedido agora (o.poligonos): quem pediu decide o que dizer ("sem caminho").
        pontos = null; pedido = pedidoBase; desvioAtivo = null;
        extras = extras.concat(["Sem caminho que evite a restrição do mapa (OSM): esta rota pode passar por ela. Confirme a medida no local."]);
        json = await pedirAoServidor(pedido, o, sinal, minha);
        try { r = Rota.resumirResposta(json); } catch (e2) { e2.motivo = e2.message; throw e2; }
      } else {
        if (!pontos) { e.motivo = e.message; throw e; }
        // a alternativa escolhida não serve com esta carga (ex.: peso): a melhor rota para ela, e o aviso diz isso
        pontos = null; pedido = pedidoBase;
        extras = extras.concat(["A rota escolhida não deu com esta carga: o servidor traçou a melhor rota para ela."]);
        json = await pedirAoServidor(pedido, o, sinal, minha);
        try { r = Rota.resumirResposta(json); } catch (e2) { e2.motivo = e2.message; throw e2; }
      }
    }
    const avisos = extras.concat(Rota.avisos(perfil, faltando));
    const rotulo = o.rotulo !== undefined ? o.rotulo : (dest === destino ? rotuloDestino : null);
    const pedidoGuardado = Object.assign({}, pedido); delete pedidoGuardado.alternates;
    const montar = (resposta, resumo) => ({ origem: o.origem, destino: dest, rotulo, perfil, pedido: pedidoGuardado, faltando, avisos,
      km: resumo.km, minutos: resumo.minutos, coords: resumo.coords, resposta, calculadaEm: Date.now() });
    let nova, rotas = null;
    if (o.alternativas) {
      const resps = Alt.separarRotas(json, Rota.resumirResposta);
      rotas = resps.map((x, i) => Object.assign(montar(x, i === 0 ? r : Rota.resumirResposta(x)), { opcao: i }));
      nova = rotas[0];
    } else nova = montar(json, r);
    if (pontos) nova.passagem = pontos.length;
    nova.prefs = pr;
    if (ps && ps.length) {
      nova.paradas = ps.map((x) => Object.assign({}, x));
      const legs = (nova.resposta && nova.resposta.trip && nova.resposta.trip.legs) || [];
      nova.paradasM = RP.marcosDasParadas(nova.coords, legs.map((l) => (typeof l.shape === "string" ? Rota.decodificarPolyline6(l.shape).length : 0)));
    }
    // recálculo com o desvio ativo (navegação): a rota nova leva a lista de desvios aplicados (resumo da viagem)
    if (pedido !== pedidoBase && o.poligonos === undefined && desvioAtivo && desvioAtivo.registro && desvioAtivo.registro.length) nova.desvios = desvioAtivo.registro;
    // consultar: só calcula (conferência da rota offline pela navegação); quem pediu decide se usa (usar(rota))
    if (o.consultar) return nova;
    if (!pontos) passagem = null; // rota nova que não segue a escolhida: a escolha deixa de valer
    desenharRota(nova.coords, o.enquadrar);
    rotaAtual = nova;
    if (rotas && rotas.length > 1) { opcoes = { rotas, escolhida: 0, infos: null }; desenharAlternativas(); }
    else esconderAlternativas();
    C.emit("rota", rotaAtual);
    return rotaAtual;
  }

  // Passa a usar uma rota já calculada: desenha, guarda como atual, põe o pino no destino (sem folha) e emite "rota".
  function usar(nova) {
    if (nova.destino && (!destino || destino.lat !== nova.destino.lat || destino.lon !== nova.destino.lon)) {
      destino = { lat: nova.destino.lat, lon: nova.destino.lon };
      if (marcadorDestino) marcadorDestino.remove();
      marcadorDestino = new maplibregl.Marker({ element: pinoDestino() }).setLngLat([destino.lon, destino.lat]).addTo(C.mapa);
    }
    esconderAlternativas(); passagem = null;
    desenharRota(nova.coords, false);
    rotaAtual = nova;
    C.emit("rota", rotaAtual);
    return rotaAtual;
  }

  // ------------------------------------------------------------ escolha entre as opções
  function relatosConhecidos() {
    try { return C.comunidade && typeof C.comunidade.relatosParaAlerta === "function" ? C.comunidade.relatosParaAlerta() || [] : []; }
    catch (e) { return []; }
  }
  function prepararInfos() {
    const agora = Date.now(), relatos = relatosConhecidos();
    const base = opcoes.rotas.map((r) => {
      const caract = Alt.caracteristicas(r.resposta);
      const n = Alt.relatosNaRota(r.coords, relatos, agora);
      return { km: r.km, minutos: r.minutos, pedagio: caract.pedagio, balsa: caract.balsa, terra: caract.terra, relatos: n, caract };
    });
    // o desvio (ui/desvio.js) não entra na comparação "Mais rápida/Mais curta": ele tem a etiqueta própria de diferença
    const normais = base.map((b, i) => i).filter((i) => !opcoes.rotas[i].desvio);
    const rotN = Alt.rotular(normais.map((i) => base[i]));
    opcoes.infos = base.map((b, i) => {
      const r = opcoes.rotas[i];
      if (r.desvio) return { rotulo: "Desvio", comparacao: null, relatos: b.relatos, etiquetas: Alt.etiquetas(b.caract, b.relatos) };
      const rot = rotN[normais.indexOf(i)];
      return { rotulo: rot.rotulo, comparacao: rot.comparacao, relatos: b.relatos, etiquetas: Alt.etiquetas(b.caract, b.relatos).filter((t) => t !== rot.rotulo) };
    });
    // a rota que o desvio evita avisa no cartão: "Passa por 2 restrições" (vermelho)
    const dv = opcoes.rotas.find((r) => r.desvio);
    if (dv && dv.desvio.baseIndex != null && opcoes.infos[dv.desvio.baseIndex] && dv.desvio.total) {
      const n = dv.desvio.total;
      opcoes.infos[dv.desvio.baseIndex].etiquetas.unshift("Passa por " + n + (n === 1 ? " restrição" : " restrições"));
    }
  }

  function escolher(i) {
    if (!opcoes || !(i >= 0 && i < opcoes.rotas.length) || i === opcoes.escolhida || navAtiva()) return false;
    opcoes.escolhida = i;
    const r = opcoes.rotas[i];
    // desvio: os quadrados a evitar valem para os recálculos seguintes; as outras rotas soltam o desvio
    desvioAtivo = r.desvio ? { destino: r.destino, alvos: r.desvio.alvos, registro: r.desvios || [] } : null;
    passagem = i === 0 || r.desvio ? null : { destino: r.destino, coords: r.coords,
      pontos: Alt.pontosDePassagem(r.coords, opcoes.rotas.filter((_, j) => j !== i && !opcoes.rotas[j].desvio).map((x) => x.coords)) };
    if (passagem && !passagem.pontos.length) passagem = null;
    rotaAtual = r;
    desenharRota(r.coords, false);
    desenharAlternativas();
    atualizarResumo();
    atualizarCartoes();
    C.emit("rota", rotaAtual);
    trocarExtras(r);
    atualizarInfoPref();
    return true;
  }

  function cartao(i) {
    const r = opcoes.rotas[i], info = opcoes.infos[i];
    const b = botao("", "rota-opcao", () => escolher(i));
    b.dataset.i = String(i); b.id = "rota-opcao-" + i;
    // 2 linhas: rótulo | tempo · distância; chegada, diferença para a mais rápida e etiquetas
    const topo = el("span", "rota-opcao-topo");
    const dados = Rota.formatarTempo(r.minutos) + " · " + Rota.formatarKm(r.km);
    // R5: ícones de tempo e distância ao lado dos números (o texto continua o mesmo; o aria-label do cartão diz tudo)
    const dadosEl = el("span", "rota-opcao-dados");
    if (window.CopilotoIcones) dadosEl.append(window.CopilotoIcones.no("relogio"), Rota.formatarTempo(r.minutos), " · ", window.CopilotoIcones.no("distancia"), Rota.formatarKm(r.km));
    else dadosEl.textContent = dados;
    topo.append(el("span", "rota-opcao-rotulo", info.rotulo), dadosEl);
    const linha = el("span", "rota-opcao-linha");
    const chega = Alt.chegada(Date.now(), r.minutos);
    linha.append(el("span", "rota-opcao-chegada", chega));
    if (info.comparacao) linha.append(el("span", "rota-opcao-comp", info.comparacao));
    if (r.desvio) { const d = el("span", "rota-etiqueta rota-desvio-etiqueta" + (r.desvio.restantes ? "" : " boa"), r.desvio.etiqueta); linha.appendChild(d); }
    for (const t of info.etiquetas) {
      const et = el("span", "rota-etiqueta" + (/^Sem /.test(t) ? " boa" : /^Passa por /.test(t) ? " viola" : ""), t);
      const ico = /edágio/.test(t) ? "pedagio" : /^(Terra|Porteira|\d+ relato)/.test(t) ? "aviso" : /Horário/.test(t) ? "relogio" : null; // R5: símbolo antes do texto
      if (ico && window.CopilotoIcones) et.prepend(window.CopilotoIcones.no(ico));
      linha.appendChild(et);
    }
    const selo = el("span", "rota-selo pendente"); selo.hidden = true; linha.appendChild(selo);
    b.append(topo, linha);
    for (const x of extras("cartao", r, i)) b.append(x);
    b.setAttribute("aria-label", info.rotulo + ": " + dados + ", " + chega + (info.comparacao ? ", " + info.comparacao : "") + (r.desvio ? ", " + r.desvio.etiqueta : "") +
      (info.etiquetas.length ? ", " + info.etiquetas.join(", ") : ""));
    return b;
  }
  function atualizarCartoes() {
    if (!opcoes) return;
    for (const b of document.querySelectorAll("#folha .rota-opcao")) {
      const sel = Number(b.dataset.i) === opcoes.escolhida;
      b.setAttribute("aria-pressed", String(sel)); b.classList.toggle("escolhida", sel);
    }
  }

  // Desvio calculado por ui/desvio.js: entra como mais um cartão, já ESCOLHIDO (a original segue na lista, com o aviso).
  // meta: { alvos, etiqueta, evitadas, total, restantes (n de restrições que ainda restam), baseIndex? }. Devolve true se entrou.
  function adicionarDesvio(rota, meta) {
    if (navAtiva() || !rota || !rotaAtual) return false;
    if (!opcoes) opcoes = { rotas: [rotaAtual], escolhida: 0, infos: null };
    const velho = opcoes.rotas.findIndex((x) => x.desvio);
    const base = opcoes.escolhida !== velho && opcoes.escolhida >= 0 ? opcoes.escolhida : 0;
    if (velho >= 0) { opcoes.rotas.splice(velho, 1); if (opcoes.escolhida > velho) opcoes.escolhida--; }
    rota.desvio = Object.assign({ baseIndex: Math.min(base, opcoes.rotas.length - 1) }, meta);
    opcoes.rotas.push(rota);
    rota.desvios = meta.registro || [];
    if (meta.preEscolher !== false) { // desvio parcial (ainda viola algo) entra na lista, mas quem escolhe é o motorista
      opcoes.escolhida = opcoes.rotas.length - 1;
      desvioAtivo = { destino: rota.destino, alvos: meta.alvos, registro: meta.registro || [] }; passagem = null;
      rotaAtual = rota;
      desenharRota(rota.coords, false);
    }
    desenharAlternativas();
    if (meta.preEscolher !== false) C.emit("rota", rotaAtual);
    const f = $("folha");
    if (f && !f.hidden && f.dataset.decisao === "1") folhaRota(rotaAtual, rotaAtual.perfil);
    return true;
  }
  function botaoIniciar() {
    // ao iniciar, as alternativas somem (a escolhida fica)
    const b = botao("Iniciar navegação", "btn btn-principal btn-iniciar-nav", () => { esconderAlternativas(); C.navegacao.iniciar(); });
    if (window.CopilotoIcones) window.CopilotoIcones.prefixar(b, "ir"); // lote 2: botão azul grande com o símbolo de navegar
    return b;
  }

  // Custos da rota (ui/custos.js): lugar reservado logo depois de "Iniciar navegação" (modo Padrão/Avançado, pedágio,
  // combustível e total); ui/custos.js preenche ao ouvir "rota:folha" e põe a diferença de custo em cada cartão.
  function lugarCustos() { const d = el("div", "rota-custos"); d.id = "rota-custos"; return d; }

  // ---------- preferências na folha da rota (chips com símbolo; ≥ 56 px; escondem o que o servidor não suporta)
  function chipsPrefs() {
    const sup = suporte || RP.suporteDoStatus(null);
    const caixa = el("div", "rota-prefs"); caixa.id = "rota-prefs";
    caixa.setAttribute("role", "group"); caixa.setAttribute("aria-label", "Preferências de rota");
    const CURTO = { semPedagio: "Sem pedágio", semBalsa: "Sem balsa", semTerra: "Sem terra" };
    for (const d of RP.PREFS) {
      if (sup[d.id] !== true) continue;
      const b = el("button", "rota-pref" + (prefs[d.id] ? " ligada" : "")); b.type = "button"; b.id = "rota-pref-" + d.id;
      if (window.CopilotoIcones) b.append(window.CopilotoIcones.no(d.icone)); else b.append(el("span", null, CURTO[d.id]));
      b.setAttribute("aria-pressed", String(!!prefs[d.id])); b.setAttribute("aria-label", d.longo + (prefs[d.id] ? ": ligado" : ": desligado")); b.title = d.rotulo;
      b.addEventListener("click", () => { prefs[d.id] = !prefs[d.id]; gravarPrefs(); C.emit("rota:prefs", Object.assign({}, prefs)); tracarRota(); });
      caixa.appendChild(b);
    }
    return caixa.children.length ? caixa : null;
  }
  // "Evitando pedágio: +18 min · +12,3 km" (e o que o servidor não conseguiu evitar), da rota escolhida contra a rota normal
  function atualizarInfoPref() {
    const alvo = document.querySelector("#folha .rota-pref-info"); if (!alvo) return;
    alvo.textContent = "";
    const ef = prefsEfetivas();
    if (!RP.algumaAtiva(ef) || !rotaAtual) return;
    const nomes = RP.rotulosAtivos(ef).join(" e ");
    if (baseInfo) {
      const dif = RP.diferenca(baseInfo, rotaAtual);
      const p = el("p", "rota-comp", ""); p.id = "rota-comparacao";
      p.append(el("strong", null, "Evitando " + nomes + ": "), document.createTextNode(RP.textoDiferenca(dif)));
      alvo.appendChild(p);
      const chave = baseInfo.chave, atual = rotaAtual;
      if (C.custos && C.custos.modo && C.custos.modo() === "avancado" && C.custos.da) {
        Promise.all([C.custos.da(baseInfo.rota), C.custos.da(atual)]).then(([cb, cn]) => {
          if (!p.isConnected || !baseInfo || baseInfo.chave !== chave || rotaAtual !== atual) return;
          const tb = cb && cb.total && cb.total.ok ? cb.total.total : null, tn = cn && cn.total && cn.total.ok ? cn.total.total : null;
          const d2 = RP.diferenca(baseInfo, atual, tb, tn);
          p.lastChild.textContent = RP.textoDiferenca(d2);
        }, () => { /* sem custo: fica tempo e distância */ });
      }
    } else {
      alvo.appendChild(el("p", "dica", "Comparação com a rota normal indisponível agora."));
    }
    for (const a of RP.avisosNaoEvitou(ef, Alt.caracteristicas(rotaAtual.resposta))) alvo.appendChild(el("p", "aviso-rota", a));
  }
  function listaParadas() {
    if (!paradas.length || navAtiva()) return null;
    const caixa = el("div", "rota-paradas"); caixa.id = "rota-paradas";
    paradas.forEach((p, i) => {
      const linha = el("div", "rota-parada");
      const pino = el("span", "pino-parada pino-parada-lista", String(i + 1)); pino.setAttribute("aria-hidden", "true");
      linha.append(pino, el("span", "rota-parada-nome", "Parada: " + (p.rotulo || "posto")));
      const x = botao("", "rota-parada-x", () => removerParada(i)); x.setAttribute("aria-label", "Tirar a parada " + (p.rotulo || "posto"));
      if (window.CopilotoIcones) x.appendChild(window.CopilotoIcones.no("fechar")); else x.textContent = "×";
      linha.appendChild(x);
      caixa.appendChild(linha);
    });
    return caixa;
  }

  // ---------- selo "compatível com o caminhão" nos cartões de alternativa (restrições do banco, ui/avisos.js)
  function atualizarSelo(i) {
    const b = document.getElementById("rota-opcao-" + i); if (!b || !opcoes) return;
    const alvo = b.querySelector(".rota-selo"); if (!alvo) return;
    const c = opcoes.compat && opcoes.compat[i];
    const sel = RP.seloCompat(c ? c.resumo : null, { erro: c && c.erro, veiculoCaminhao: Rota.ehCaminhao(opcoes.rotas[i].perfil) });
    alvo.className = "rota-selo " + sel.estado; alvo.textContent = "";
    alvo.hidden = sel.estado === "carro";
    if (sel.estado === "ok" || sel.estado === "condicional") alvo.append(window.CopilotoIcones ? window.CopilotoIcones.no("caminhao") : "", el("span", null, sel.texto));
    else if (sel.estado === "viola") alvo.append(window.CopilotoIcones ? window.CopilotoIcones.no("aviso") : "", el("span", null, sel.texto));
    else alvo.append(el("span", null, sel.texto));
    alvo.dataset.estado = sel.estado;
    alvo.title = sel.aria;
    const base = (b.dataset.ariaBase || (b.dataset.ariaBase = b.getAttribute("aria-label") || ""));
    b.setAttribute("aria-label", base + (sel.aria ? ". " + sel.aria : ""));
  }
  function conferirCompatibilidade() {
    if (!opcoes || !C.dadosRota || !C.dadosRota.restricoesDeRota) return;
    const minhas = opcoes;
    minhas.compat = minhas.compat || {};
    opcoes.rotas.forEach((r, i) => {
      if (!Rota.ehCaminhao(r.perfil)) { atualizarSelo(i); return; }
      atualizarSelo(i);
      Promise.resolve().then(() => C.dadosRota.restricoesDeRota(r)).then((resumo) => {
        if (opcoes !== minhas) return;
        minhas.compat[i] = { resumo }; atualizarSelo(i);
      }, () => { if (opcoes !== minhas) return; minhas.compat[i] = { erro: true }; atualizarSelo(i); });
    });
  }

  // Cabeçalho da folha de planejamento (lote 2, P1.4): origem → destino, distância · tempo e chegada da rota ESCOLHIDA, e a carga.
  // Só dado que existe: a origem é a posição do motorista; carregado/vazio vêm do cadastro do veículo (a escolha é feita ao iniciar).
  function textoT(v) { return String(v).replace(".", ","); }
  function resumoRota(r, perfil) {
    const caixa = el("section", "rota-resumo"); caixa.id = "rota-resumo"; caixa.setAttribute("aria-label", "Resumo da rota");
    const trecho = el("p", "rota-resumo-trecho");
    trecho.append(el("span", "rota-resumo-de", "Sua posição"), el("span", "rota-resumo-seta", "→"), el("span", "rota-resumo-para", rotuloDestino || "Destino escolhido"));
    const nums = el("div", "rota-resumo-nums");
    nums.append(el("b", "rota-resumo-dados", ""), el("span", "rota-resumo-chegada", ""));
    caixa.append(trecho, nums);
    return caixa;
  }
  function atualizarResumo() {
    const caixa = document.getElementById("rota-resumo"); const r = rotaAtual; if (!caixa || !r) return;
    caixa.querySelector(".rota-resumo-dados").textContent = Rota.formatarKm(r.km) + " · " + Rota.formatarTempo(r.minutos);
    caixa.querySelector(".rota-resumo-chegada").textContent = Alt.chegada(Date.now(), r.minutos);
  }

  function folhaRota(r, perfil) {
    const limpar = botao("Limpar rota", "btn rota-limpar", limparRota); limpar.id = "rota-limpar";
    // Cabeçalho e "Iniciar navegação" FIXOS (estilos/toque.css): o título no alto e o botão no pé da folha (.folha-topo e
    // .folha-rodape, sticky); os cartões e avisos rolam no meio. No iPhone SE o botão nunca sai da tela. O botão é o ÚLTIMO
    // filho (o sticky do pé só segura o que está no fim do fluxo); as restrições do caminhão continuam ANTES dele no texto.
    const topo = el("div", "folha-topo rota-topo");
    topo.append(el("h2", "so-leitor", "Rota para o destino")); // título só para o leitor de tela (o resumo já diz tudo); o veículo fica só na aba Veículo
    const chips = chipsPrefs();
    const cab = el("div", "rota-cabecalho" + (chips ? " com-prefs" : "")); cab.append(resumoRota(r, perfil)); if (chips) cab.append(chips);
    const itens = [topo, cab];
    if (chips) itens.push(el("div", "rota-pref-info", ""));
    const lp = listaParadas();
    if (lp) itens.push(lp);
    const temNav = C.navegacao && C.navegacao.iniciar;
    if (opcoes) {
      prepararInfos();
      const lista = el("div", "rota-opcoes");
      lista.setAttribute("role", "group"); lista.setAttribute("aria-label", "Opções de rota");
      for (let i = 0; i < opcoes.rotas.length; i++) lista.appendChild(cartao(i));
      itens.push(lista);
      // restrições do caminhão (ui/avisos.js) antes de "Iniciar navegação" (que fica no pé fixo da folha); seguem a rota ESCOLHIDA
      itens.push(...trocaveis("antesIniciar", r, opcoes));
      itens.push(lugarCustos());
      for (const a of r.avisos) itens.push(el("p", "aviso-rota", a));
      itens.push(...trocaveis("folha", r, opcoes));
    } else {
      const c = Alt.caracteristicas(r.resposta);
      for (const a of r.avisos) itens.push(el("p", "aviso-rota", a));
      itens.push(...extras("antesIniciar", r, null));
      itens.push(lugarCustos());
      const extra = Alt.etiquetas(c, Alt.relatosNaRota(r.coords, relatosConhecidos(), Date.now()));
      itens.push(el("p", "rota-detalhe", extra.join(" · ")));
      itens.push(el("p", "rota-dica", r.resposta && r.resposta.longa ? "Rota longa: só a principal, sem alternativas." : "O servidor de rotas não sugeriu outro caminho."));
      itens.push(...extras("folha", r, null));
    }
    // rodapé fixo: "Iniciar navegação" e "Limpar rota" sempre à vista (nada de rolar para achar o botão)
    { const pe = el("div", "folha-rodape rota-rodape" + (temNav ? "" : " so-limpar")); if (temNav) pe.append(botaoIniciar()); pe.append(limpar); itens.push(pe); }
    C.folha.abrir(itens);
    atualizarResumo();
    atualizarCartoes();
    atualizarInfoPref();
    conferirCompatibilidade();
    C.emit("rota:folha", { rota: r, perfil });
    marcarDecisao();
    C.mapaPronto(() => enquadrarRota());
  }

  // Voz (rodada 2): ao traçar, o Copiloto diz "Rota de 312 quilômetros, 4 horas e 20 minutos, chegada às 15:40, com pedágio e
  // 2 restrições." As restrições do caminhão chegam do servidor depois: se chegarem com a folha ainda aberta, uma frase a mais.
  let falouRota = null; // { rota, restricoes }
  // soJa: só lê o que já está na memória (dentro de "dados:rota" pedir de novo emitiria o evento outra vez: laço infinito)
  function restricoesNaRota(r, soJa) {
    try { const x = C.dadosRota ? (soJa && C.dadosRota.restricoesJa ? C.dadosRota.restricoesJa(r) : C.dadosRota.restricoesDe ? C.dadosRota.restricoesDe(r) : null) : null; return x && Array.isArray(x.violadas) ? x.violadas.length : 0; } catch (e) { return 0; }
  }
  function falarRota(r) {
    try {
      const NavLib = window.CopilotoNavegacao;
      if (!C.voz || !C.voz.falar || !NavLib || !NavLib.textoRotaTracada || !r) return;
      const c = Alt.caracteristicas(r.resposta);
      const nr = restricoesNaRota(r);
      falouRota = { rota: r, restricoes: nr };
      C.voz.falar(NavLib.textoRotaTracada({ km: r.km, minutos: r.minutos, agoraMs: Date.now(), pedagio: c.pedagio === true, restricoes: nr }), { naoInterromper: true });
    } catch (e) { /* a voz nunca derruba o traçado */ }
  }
  function falarRestricoesTardias() {
    const f = falouRota;
    if (!f || f.rota !== rotaAtual || navAtiva() || !C.voz || !C.voz.falar) return;
    const nr = restricoesNaRota(f.rota, true);
    if (nr <= f.restricoes || nr < 1) return;
    f.restricoes = nr;
    C.voz.falar("A rota tem " + nr + (nr === 1 ? " restrição" : " restrições") + " para o seu caminhão.", { naoInterromper: true });
  }

  async function tracarRota() {
    if (!destino) return;
    const pos = C.estado.ultimaPos;
    if (!pos) { C.mensagem("Ative o GPS para saber de onde você sai.", 6000); return; }
    const origem = { lat: pos[1], lon: pos[0] };
    const perfil = C.veiculos.ativo();
    esconderAlternativas(); passagem = null; desvioAtivo = null;
    // "Cancelar" aborta o pedido ao servidor (AbortController) e volta para a folha do destino
    const ctl = new AbortController();
    const cancelarPedido = botao("Cancelar", "btn btn-grande", () => { ctl.abort(); folhaDestino(); });
    cancelarPedido.id = "rota-cancelar";
    C.folha.abrir([el("h2", null, "Traçando a rota…"), el("p", null, "Calculando para " + (perfil ? perfil.nome : "carro") + "."), cancelarPedido]);
    try {
      // preferências ligadas: a rota NORMAL (sem elas) é pedida junto, só para mostrar quanto a mais custa evitar
      if (RP.algumaAtiva(prefs)) await consultarSuporte();
      const comparar = RP.algumaAtiva(prefsEfetivas());
      const chaveBase = Math.round(origem.lat * 1e4) + "," + Math.round(origem.lon * 1e4) + ">" + destino.lat + "," + destino.lon + "|" + paradasDoDestino(destino).length;
      let promessaBase = null;
      if (comparar) {
        const antiga = baseInfo && baseInfo.chave === chaveBase ? baseInfo : null;
        promessaBase = antiga ? Promise.resolve(antiga.rota) : calcular({ origem, perfil, prefs: {}, consultar: true, enquadrar: false, sinal: ctl.signal }).catch(() => null);
      }
      baseInfo = null;
      const r = await calcular({ origem, perfil, alternativas: true, sinal: ctl.signal });
      if (promessaBase) { const b = await promessaBase; if (b) baseInfo = { chave: chaveBase, minutos: b.minutos, km: b.km, rota: b }; }
      folhaRota(r, perfil);
      falarRota(r);
    } catch (e) {
      if (e.cancelada || ctl.signal.aborted) return;
      const motivo = e.motivo || e.message;
      if (C.rotaLonga && C.rotaLonga.falha(e, { tentar: tracarRota, limpar: limparRota })) { C.emit("rota-erro", { motivo }); return; }
      const botoes = el("div", "linha-botoes");
      botoes.append(botao("Tentar de novo", "btn btn-principal", tracarRota), botao("Cancelar", "btn", limparRota));
      C.folha.abrir([el("h2", null, "Não foi possível traçar"), el("p", null, motivo), botoes]);
      C.emit("rota-erro", { motivo });
    }
  }

  C.rota = { destino: () => destino, atual: () => rotaAtual, pedirDestino, definirDestino, tracar: tracarRota, limpar: limparRota, calcular, usar, reabrirFolha, enquadrar: () => C.mapaPronto(() => enquadrarRota()),
    // opções de rota mostradas agora (null fora da escolha): { rotas, escolhida, infos }
    alternativas: () => (opcoes ? { rotas: opcoes.rotas.slice(), escolhida: opcoes.escolhida, infos: opcoes.infos ? opcoes.infos.slice() : null } : null),
    escolher, adicionarDesvio, desvioAtivo: () => (desvioAtivo ? { destino: desvioAtivo.destino, alvos: desvioAtivo.alvos.slice(), registro: desvioAtivo.registro || [] } : null),
    adicionarParada, removerParada, paradas: () => paradasDoDestino(destino).map((p) => Object.assign({}, p)),
    prefs: () => Object.assign({}, prefs), prefsEfetivas, suporte: () => (suporte ? Object.assign({}, suporte) : null), consultarSuporte,
    definirDesvio: (d) => { desvioAtivo = d && d.alvos && d.alvos.length ? { destino: d.destino, alvos: d.alvos.slice(), registro: d.registro || [] } : null; } };

  C.aoIniciar(() => {
    // navegação começou (por qualquer caminho: folha da rota, rota guardada, voz): as alternativas somem
    C.on("navegacao", (d) => { if (d && d.ativa && opcoes) esconderAlternativas(); });
    C.on("dados:rota", (d) => { if (d && d.parte === "restricoes") falarRestricoesTardias(); });
    C.on("navegacao", conferirParadasFeitas);
    C.carregarEstilo("estilos/rota6.css");
    // o servidor de rotas diz a versão em /status: os chips só aparecem para o que ele suporta (consulta única, sem travar nada)
    consultarSuporte();
    window.addEventListener("online", () => { if (!suporte || !suporte.conhecido) consultarSuporte(); });
  });
})(window.Copiloto);
