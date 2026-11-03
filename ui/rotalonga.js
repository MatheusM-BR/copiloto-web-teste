// Rota longa (interface). Lógica pura em rotalonga.js. Expõe Copiloto.rotaLonga:
//   pedir(pedido, o, sinal, minha, unico) → resposta do servidor (a de um pedido só, ou a emendada de vários trechos);
//   falha(e, { tentar, limpar }) → true quando mostrou a folha de falha de trecho; estado() para testes.
// Chamado por ui/rota.js (calcular e "Traçar rota"). O servidor público recusa pedidos com mais de 1.500 km EM LINHA RETA
// (auto e truck): acima de ~1.400 km o app divide a viagem em trechos de ~800 km de reta, pede até 3 por vez, desenha cada um
// assim que chega (progressivo), emenda tudo numa rota só e enquadra a viagem inteira no fim. Se um trecho falha, o que
// chegou continua no mapa (cinza tracejado), o ponto da falha é marcado e "Tentar de novo este trecho" pede só ele (os
// outros saem do cache). Navegação, recálculo, rota guardada e custos recebem a rota emendada, como qualquer outra.
// Recálculo no meio da viagem: reaproveita os pontos intermediários que ainda estão à frente, então só o trecho da posição
// atual até o próximo ponto é pedido de novo (os seguintes saem do cache).
// Camadas do mapa: fonte "rota-longa" (linhas dos trechos) com as camadas "rota-longa-ok" e "rota-longa-falha".
(function (C) {
  "use strict";
  const { $, el, botao } = C.util;
  const RL = window.CopilotoRotaLonga;
  const Rota = window.CopilotoRota;
  const COR_OK = "#2f80ed", COR_PARADO = "#8893a4", COR_FALHA = "#e5484d";

  const cache = new Map();          // trechos já traçados (chave = pedido), válidos por 6 h; tentar de novo só pede o que falhou
  let plano = null;                 // { destino, costing, pontos } da última viagem dividida (recálculo reaproveita os pontos)
  let ativo = null;                 // traçado interativo em andamento ou com falha: { estados, pontos, origem, destino, perfil, pedido, falha }
  let marcadorFalha = null;

  // ------------------------------------------------------------ rede
  function urlLocate() {
    if (window.COPILOTO_URL_LOCATE) return window.COPILOTO_URL_LOCATE;
    const r = window.COPILOTO_URL_ROTA;
    return r && /\/route$/.test(r) ? r.replace(/\/route$/, "/locate") : "https://valhalla1.openstreetmap.de/locate";
  }
  async function postar(url, corpo, sinal) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    const desistir = () => ctl.abort();
    if (sinal) sinal.addEventListener("abort", desistir);
    try {
      const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo), signal: ctl.signal });
      return await resp.json().catch(() => null);
    } catch (e) {
      if (sinal && sinal.aborted) { const c = new Error("Rota cancelada."); c.cancelada = true; c.motivo = c.message; throw c; }
      const erro = new Error("Sem conexão com o servidor de rotas."); erro.motivo = erro.message; erro.rede = true; throw erro;
    } finally { clearTimeout(t); if (sinal) sinal.removeEventListener("abort", desistir); }
  }

  // ------------------------------------------------------------ pedido
  const mesmoDestino = (a, b) => !!a && !!b && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;
  async function pedir(pedido, o, sinal, minha, unico) {
    const locs = pedido.locations || [];
    if (locs.length < 2) return unico(pedido, o, sinal, minha);
    const origem = { lat: locs[0].lat, lon: locs[0].lon }, destino = { lat: locs[locs.length - 1].lat, lon: locs[locs.length - 1].lon };
    if (!RL.deveDividir(origem, destino)) {
      const json = await unico(pedido, o, sinal, minha);
      if (!(json && !json.trip && RL.ehErroDistancia(json.error))) return json; // só o erro de distância vira divisão
    }
    const interativo = !!o.alternativas && !o.consultar;
    const base = Object.assign({}, pedido); delete base.alternates;
    base.locations = [locs[0], locs[locs.length - 1]];
    const anteriores = plano && mesmoDestino(plano.destino, destino) && plano.costing === pedido.costing ? plano.pontos : null;
    const ctx = { origem, destino, perfil: o.perfil !== undefined ? o.perfil : (C.veiculos ? C.veiculos.ativo() : null), pedido: base, estados: [], pontos: [], falha: null };
    if (interativo) { ativo = ctx; apagarMarcadorFalha(); }
    const deps = {
      cache, concorrencia: RL.CONCORRENCIA,
      localizar: (body) => postar(urlLocate(), body, sinal),
      rota: (p) => unico(p, o, sinal, minha),
      aoTrecho: interativo ? (e, todos) => { ctx.estados = todos; progresso(ctx); } : null,
    };
    try {
      const r = await RL.tracarEmTrechos({ origem, destino, pedidoBase: base, anteriores }, deps);
      plano = { destino, costing: pedido.costing, pontos: r.pontos };
      if (interativo) { ctx.pontos = r.pontos; ctx.estados = ctx.estados.length ? ctx.estados : []; }
      return r.json;
    } catch (e) {
      if (e && e.longa) { plano = { destino, costing: pedido.costing, pontos: e.longa.pontos }; ctx.pontos = e.longa.pontos; ctx.estados = e.estados; ctx.falha = e; }
      if (e && !e.motivo) e.motivo = RL.mensagemHumana(e.message);
      throw e;
    }
  }

  // ------------------------------------------------------------ progresso na folha e no mapa
  function progresso(ctx) {
    if (ativo !== ctx) return;
    const texto = RL.textoProgresso(ctx.estados);
    const f = $("folha");
    if (f && !f.hidden) {
      let barra = f.querySelector(".rl-barra");
      const p = f.querySelector("p");
      if (p && /^(Traçando trecho|Trechos prontos|Calculando)/.test(p.textContent)) p.textContent = texto;
      if (!barra && p && f.querySelector("h2") && /Traçando a rota/.test(f.querySelector("h2").textContent)) {
        barra = el("div", "rl-barra"); barra.setAttribute("role", "progressbar"); barra.setAttribute("aria-valuemin", "0");
        barra.append(el("span", "rl-barra-cheia"));
        p.after(barra);
      }
      if (barra) {
        const feitos = ctx.estados.filter((e) => e.situacao === "ok").length;
        barra.setAttribute("aria-valuemax", String(ctx.estados.length)); barra.setAttribute("aria-valuenow", String(feitos));
        barra.firstChild.style.width = Math.round(100 * feitos / Math.max(1, ctx.estados.length)) + "%";
      }
    }
    desenharParcial(ctx, false);
  }
  function geojsonParcial(ctx) {
    return { type: "FeatureCollection", features: RL.desenhosParciais(ctx.estados).map((d) => ({ type: "Feature", properties: { ok: d.ok ? 1 : 0, i: d.i },
      geometry: { type: "LineString", coordinates: d.coords } })).filter((f) => f.properties.ok || ctx.falha) };
  }
  // falhou: true → trechos que chegaram em cinza tracejado, o que falhou em vermelho tracejado (reta entre os pontos)
  function desenharParcial(ctx, falhou) {
    C.mapaPronto(() => {
      const mapa = C.mapa;
      if (ativo !== ctx) return;
      const dados = geojsonParcial(ctx);
      if (mapa.getSource("rota-longa")) mapa.getSource("rota-longa").setData(dados);
      else mapa.addSource("rota-longa", { type: "geojson", data: dados });
      if (!mapa.getLayer("rota-longa-ok")) {
        mapa.addLayer({ id: "rota-longa-ok", type: "line", source: "rota-longa", filter: ["==", ["get", "ok"], 1],
          layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": COR_OK, "line-width": 7, "line-opacity": 0.95 } });
        mapa.addLayer({ id: "rota-longa-falha", type: "line", source: "rota-longa", filter: ["==", ["get", "ok"], 0],
          layout: { "line-cap": "butt", "line-join": "round" }, paint: { "line-color": COR_FALHA, "line-width": 5, "line-dasharray": [1.5, 1.5] } });
      }
      if (falhou) {
        mapa.setPaintProperty("rota-longa-ok", "line-color", COR_PARADO);
        mapa.setPaintProperty("rota-longa-ok", "line-dasharray", [2, 1.5]);
      } else {
        mapa.setPaintProperty("rota-longa-ok", "line-color", COR_OK);
        mapa.setPaintProperty("rota-longa-ok", "line-dasharray", [1, 0]);
      }
    });
  }
  function apagarParcial() {
    apagarMarcadorFalha();
    const mapa = C.mapa; if (!mapa) return;
    C.mapaPronto(() => {
      if (ativo && ativo.falha) return;
      for (const id of ["rota-longa-ok", "rota-longa-falha"]) if (mapa.getLayer(id)) mapa.removeLayer(id);
      if (mapa.getSource("rota-longa")) mapa.removeSource("rota-longa");
    });
  }
  function apagarMarcadorFalha() { if (marcadorFalha) { marcadorFalha.remove(); marcadorFalha = null; } }

  // Enquadra uma lista de coordenadas na parte do mapa que a folha e a barra do topo não cobrem
  function enquadrar(coords) {
    C.mapaPronto(() => {
      const mapa = C.mapa, f = $("folha");
      if (!mapa || !coords || coords.length < 2) return;
      const caixa = mapa.getContainer().getBoundingClientRect();
      // altura final da folha (ela pode estar subindo, animada): o conteúdo, no máximo 70 % do mapa
      const topoFolha = f && !f.hidden ? caixa.bottom - Math.min(f.scrollHeight + 1, caixa.height * 0.7) : caixa.bottom;
      const barra = $("barra-topo");
      const baseBarra = barra && barra.getBoundingClientRect().height ? barra.getBoundingClientRect().bottom - caixa.top : 0;
      const cima = Math.max(24, Math.round(baseBarra + 12));
      const baixo = Math.max(24, Math.round(caixa.bottom - topoFolha + 16));
      const livre = caixa.height - cima - baixo;
      const b = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      const pad = livre >= 80 ? { top: cima, bottom: baixo, left: 24, right: 24 } : { top: 20, bottom: Math.min(baixo, Math.max(20, caixa.height - 120)), left: 20, right: 20 };
      try { mapa.fitBounds(b, { padding: pad, duration: 600 }); } catch (e) { /* tela pequena demais */ }
    });
  }

  // ------------------------------------------------------------ folha de falha
  function km1(v) { return Rota.formatarKm(v); }
  function falha(e, acoes) {
    if (!e || !e.longa || !ativo || ativo.falha !== e) return false;
    const ctx = ativo, n = e.longa.n;
    const falhou = e.longa.falhou;
    const parcial = RL.rotaParcial(ctx.estados, ctx.pontos);
    desenharParcial(ctx, true);
    // marca o ponto onde o 1º trecho com falha começa (ou o trecho todo, em reta vermelha)
    C.mapaPronto(() => {
      apagarMarcadorFalha();
      const est = ctx.estados[falhou[0]];
      if (!est) return;
      const pino = el("div", "pino-falha", "!"); pino.setAttribute("aria-label", "Ponto da falha: trecho " + (falhou[0] + 1));
      marcadorFalha = new maplibregl.Marker({ element: pino }).setLngLat([est.de.lon, est.de.lat]).addTo(C.mapa);
    });
    const feitos = ctx.estados.filter((x) => x.situacao === "ok");
    const kmFeitos = feitos.reduce((s, x) => s + (x.km || 0), 0);
    const botoes = el("div", "linha-botoes");
    botoes.append(botao(falhou.length > 1 ? "Tentar de novo estes trechos" : "Tentar de novo este trecho", "btn btn-principal", () => acoes.tentar()));
    if (parcial) botoes.append(botao("Iniciar até onde há rota", "btn", () => perguntarParcial(ctx, parcial, acoes)));
    botoes.append(botao("Cancelar", "btn", () => { ativo = null; acoes.limpar(); }));
    C.folha.abrir([
      el("h2", null, "Falhou o trecho " + (falhou[0] + 1) + " de " + n),
      el("p", "rl-motivo", ctx.estados[falhou[0]] && ctx.estados[falhou[0]].motivo ? ctx.estados[falhou[0]].motivo : e.motivo),
      el("p", "rota-detalhe", feitos.length + " de " + n + " trechos traçados (" + km1(kmFeitos) + "). O que já chegou fica no mapa em cinza tracejado; o trecho que falhou, em vermelho."),
      botoes,
    ]);
    const todos = RL.desenhosParciais(ctx.estados).reduce((a, d) => a.concat(d.coords), []);
    enquadrar(todos);
    return true;
  }
  function perguntarParcial(ctx, parcial, acoes) {
    const r = Rota.resumirResposta(parcial.json);
    const botoes = el("div", "linha-botoes");
    botoes.append(
      botao("Sim, iniciar até lá", "btn btn-principal", () => {
        const nova = { origem: ctx.origem, destino: { lat: parcial.ate.lat, lon: parcial.ate.lon }, rotulo: null, perfil: ctx.perfil, pedido: ctx.pedido, faltando: [],
          avisos: ["Rota incompleta: vai só até onde foi traçada (" + km1(r.km) + "). Depois disso, trace o restante."], km: r.km, minutos: r.minutos,
          coords: r.coords, resposta: parcial.json, calculadaEm: Date.now() };
        ativo = null; apagarParcial();
        C.rota.usar(nova);
        if (C.navegacao && C.navegacao.iniciar) C.navegacao.iniciar();
      }),
      botao("Não", "btn", () => falha(ctx.falha, acoes)));
    C.folha.abrir([el("h2", null, "Iniciar com a rota incompleta?"),
      el("p", null, "Há rota por " + km1(r.km) + " (" + parcial.trechos + " de " + ctx.estados.length + " trechos). Depois desse ponto a navegação não tem caminho: você precisa traçar o resto."), botoes]);
  }

  // ------------------------------------------------------------ gancho da folha da rota
  C.rotaExtras = C.rotaExtras || { folha: [], cartao: [] };
  C.rotaExtras.folha.push(function (r) {
    const l = r && r.resposta && r.resposta.longa;
    if (!l) return null;
    // a viagem inteira pronta: enquadra com a folha de verdade (depois que ela for desenhada)
    // folha mais baixa (a lista rola): uma viagem do tamanho do país só cabe no mapa se sobrar chão livre acima da folha
    setTimeout(() => { const f = $("folha"); if (f && !f.hidden) f.classList.add("rl-longa"); enquadrar(r.coords); }, 60);
    return el("p", "rota-detalhe rl-trechos", "Rota em " + l.trechos + " trechos · totais da viagem inteira");
  });

  C.aoIniciar(() => {
    C.on("folha", (d) => { const f = $("folha"); if (f && d && !d.aberta) f.classList.remove("rl-longa"); });
    C.on("rota", (r) => { if (ativo && !ativo.falha) { ativo = null; } if (!ativo || !ativo.falha) apagarParcial(); });
    C.on("rota-limpa", () => { ativo = null; plano = null; cache.clear(); apagarParcial(); });
  });

  C.rotaLonga = { pedir, falha, estado: () => (ativo ? { trechos: ativo.estados.map((e) => ({ i: e.i, situacao: e.situacao })), falhou: !!ativo.falha } : null),
    enquadrar, cache };
})(window.Copiloto);
