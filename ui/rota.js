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
  const COR_ROTA = "#2f80ed", COR_ALTERNATIVA = "#aab4c3";
  let marcadorDestino = null, destino = null, rotaAtual = null, geracao = 0;
  let rotuloDestino = null; // nome do lugar (destino por voz/busca), vai na rota e nos destinos recentes
  // opções mostradas ao traçar: { rotas, escolhida, infos: [{ rotulo, comparacao, etiquetas, relatos, caract }] } ou null
  let opcoes = null;
  // alternativa escolhida (não a principal): { destino, coords, pontos } para o recálculo de carregado/vazio passar por ela
  let passagem = null;
  let toqueLigado = false, rotaToqueLigado = false;

  // Redesenho: escolher destino é pela busca ("Para onde?": recentes, coordenada, postos) ou pelo toque no mapa
  // ("Ir para cá", ui/busca.js). O toque no mapa nunca vira destino sozinho. pedirDestino(true) abre a busca;
  // pedirDestino(false) fecha a busca, se estiver aberta.
  function pedirDestino(v) {
    if (v) { C.abas.irPara("busca"); return; }
    if (C.abas.atual() === "busca") C.abas.irPara("mapa");
  }

  // extra.rotulo: nome do lugar (busca, voz); aparece na folha e vai na rota (rota.rotulo → destinos recentes)
  function definirDestino(lngLat, extra) {
    destino = { lat: lngLat.lat, lon: lngLat.lng };
    rotuloDestino = (extra && extra.rotulo) || null;
    if (marcadorDestino) marcadorDestino.remove();
    marcadorDestino = new maplibregl.Marker({ element: pinoDestino() }).setLngLat([destino.lon, destino.lat]).addTo(C.mapa);
    if (C.abas.atual() === "busca") C.abas.irPara("mapa");
    esconderAlternativas(); passagem = null;
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
    esconderAlternativas(); passagem = null;
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
    let { pedido, faltando } = Rota.criarPedido(perfil, o.origem, dest);
    let extras = [];
    if (o.ajustar) { const a = o.ajustar(pedido, faltando); pedido = a.pedido; faltando = a.faltando; extras = a.avisos || []; }
    const minha = geracao;
    const sinal = o.sinal || null;
    const pedidoBase = pedido;
    let pontos = null;
    if (o.alternativas) pedido = Alt.pedirAlternativas(pedido);
    else if (!o.consultar && o.passarPor !== false) {
      pontos = passagemAutomatica(o.origem, dest);
      if (pontos) pedido = Alt.aplicarPassagem(pedido, pontos);
    }
    let json = await pedirComDivisao(pedido, o, sinal, minha);
    let r;
    try { r = Rota.resumirResposta(json); } catch (e) {
      if (!pontos) { e.motivo = e.message; throw e; }
      // a alternativa escolhida não serve com esta carga (ex.: peso): a melhor rota para ela, e o aviso diz isso
      pontos = null; pedido = pedidoBase;
      extras = extras.concat(["A rota escolhida não deu com esta carga: o servidor traçou a melhor rota para ela."]);
      json = await pedirAoServidor(pedido, o, sinal, minha);
      try { r = Rota.resumirResposta(json); } catch (e2) { e2.motivo = e2.message; throw e2; }
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
    const rot = Alt.rotular(base);
    opcoes.infos = base.map((b, i) => ({ rotulo: rot[i].rotulo, comparacao: rot[i].comparacao, relatos: b.relatos,
      etiquetas: Alt.etiquetas(b.caract, b.relatos).filter((t) => t !== rot[i].rotulo) }));
  }

  function escolher(i) {
    if (!opcoes || !(i >= 0 && i < opcoes.rotas.length) || i === opcoes.escolhida || navAtiva()) return false;
    opcoes.escolhida = i;
    const r = opcoes.rotas[i];
    passagem = i === 0 ? null : { destino: r.destino, coords: r.coords,
      pontos: Alt.pontosDePassagem(r.coords, opcoes.rotas.filter((_, j) => j !== i).map((x) => x.coords)) };
    if (passagem && !passagem.pontos.length) passagem = null;
    rotaAtual = r;
    desenharRota(r.coords, false);
    desenharAlternativas();
    atualizarCartoes();
    C.emit("rota", rotaAtual);
    return true;
  }

  function cartao(i) {
    const r = opcoes.rotas[i], info = opcoes.infos[i];
    const b = botao("", "rota-opcao", () => escolher(i));
    b.dataset.i = String(i); b.id = "rota-opcao-" + i;
    // 2 linhas: rótulo | tempo · distância; chegada, diferença para a mais rápida e etiquetas
    const topo = el("span", "rota-opcao-topo");
    const dados = Rota.formatarTempo(r.minutos) + " · " + Rota.formatarKm(r.km);
    topo.append(el("span", "rota-opcao-rotulo", info.rotulo), el("span", "rota-opcao-dados", dados));
    const linha = el("span", "rota-opcao-linha");
    const chega = Alt.chegada(Date.now(), r.minutos);
    linha.append(el("span", "rota-opcao-chegada", chega));
    if (info.comparacao) linha.append(el("span", "rota-opcao-comp", info.comparacao));
    for (const t of info.etiquetas) linha.appendChild(el("span", "rota-etiqueta" + (/^Sem /.test(t) ? " boa" : ""), t));
    b.append(topo, linha);
    for (const x of extras("cartao", r, i)) b.append(x);
    b.setAttribute("aria-label", info.rotulo + ": " + dados + ", " + chega + (info.comparacao ? ", " + info.comparacao : "") +
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

  function rotuloVeiculo(perfil) { return perfil && Rota.ehCaminhao(perfil) ? perfil.nome : "carro"; }
  function botaoIniciar() {
    // ao iniciar, as alternativas somem (a escolhida fica)
    return botao("Iniciar navegação", "btn btn-principal btn-iniciar-nav", () => { esconderAlternativas(); C.navegacao.iniciar(); });
  }

  // Custos da rota (ui/custos.js): lugar reservado logo depois de "Iniciar navegação" (modo Padrão/Avançado, pedágio,
  // combustível e total); ui/custos.js preenche ao ouvir "rota:folha" e põe a diferença de custo em cada cartão.
  function lugarCustos() { const d = el("div", "rota-custos"); d.id = "rota-custos"; return d; }

  function folhaRota(r, perfil) {
    const botoes = el("div", "linha-botoes");
    botoes.append(botao("Limpar rota", "btn", limparRota));
    const itens = [el("h2", null, "Rota para " + rotuloVeiculo(perfil))];
    const temNav = C.navegacao && C.navegacao.iniciar;
    if (opcoes) {
      prepararInfos();
      const lista = el("div", "rota-opcoes");
      lista.setAttribute("role", "group"); lista.setAttribute("aria-label", "Opções de rota");
      for (let i = 0; i < opcoes.rotas.length; i++) lista.appendChild(cartao(i));
      itens.push(lista);
      itens.push(...extras("antesIniciar", r, opcoes)); // restrições do caminhão (ui/avisos.js), antes de "Iniciar navegação"
      if (temNav) itens.push(botaoIniciar());
      itens.push(lugarCustos());
      itens.push(el("p", "rota-dica", "Toque num cartão ou numa linha cinza do mapa para escolher outra rota."));
      for (const a of r.avisos) itens.push(el("p", "aviso-rota", a));
      itens.push(...extras("folha", r, opcoes));
    } else {
      const c = Alt.caracteristicas(r.resposta);
      // a mesma ordem de antes das alternativas (resumo, avisos, "Iniciar navegação"): um toque que quica em
      // "Traçar rota" cai no mesmo lugar de sempre (num aviso), não em "Iniciar navegação"; o detalhe vem depois
      itens.push(el("div", "grande", Rota.formatarKm(r.km) + " · " + Rota.formatarTempo(r.minutos)));
      for (const a of r.avisos) itens.push(el("p", "aviso-rota", a));
      itens.push(...extras("antesIniciar", r, null));
      if (temNav) itens.push(botaoIniciar());
      itens.push(lugarCustos());
      const extra = [Alt.chegada(Date.now(), r.minutos)].concat(Alt.etiquetas(c, Alt.relatosNaRota(r.coords, relatosConhecidos(), Date.now())));
      itens.push(el("p", "rota-detalhe", extra.join(" · ")));
      itens.push(el("p", "rota-dica", r.resposta && r.resposta.longa ? "Rota longa: só a principal, sem alternativas." : "O servidor de rotas não sugeriu outro caminho."));
      itens.push(...extras("folha", r, null));
    }
    itens.push(botoes);
    C.folha.abrir(itens);
    atualizarCartoes();
    C.emit("rota:folha", { rota: r, perfil });
    marcarDecisao();
    C.mapaPronto(() => enquadrarRota());
  }

  async function tracarRota() {
    if (!destino) return;
    const pos = C.estado.ultimaPos;
    if (!pos) { C.mensagem("Ative o GPS para saber de onde você sai.", 6000); return; }
    const origem = { lat: pos[1], lon: pos[0] };
    const perfil = C.veiculos.ativo();
    esconderAlternativas(); passagem = null;
    C.folha.abrir([el("h2", null, "Traçando a rota…"), el("p", null, "Calculando para " + (perfil ? perfil.nome : "carro") + ".")]);
    try {
      const r = await calcular({ origem, perfil, alternativas: true });
      folhaRota(r, perfil);
    } catch (e) {
      if (e.cancelada) return;
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
    escolher };

  C.aoIniciar(() => {
    // navegação começou (por qualquer caminho: folha da rota, rota guardada, voz): as alternativas somem
    C.on("navegacao", (d) => { if (d && d.ativa && opcoes) esconderAlternativas(); });
  });
})(window.Copiloto);
