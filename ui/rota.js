// Destino e rota (Valhalla). Expõe Copiloto.rota: destino(), atual(), pedirDestino(v), definirDestino(lngLat),
// tracar(), limpar(), calcular(opcoes) (sem folha: usado pela navegação para recalcular; com consultar: true só calcula)
// e usar(rota) (passa a usar uma rota calculada com consultar: a conferência da rota offline pela navegação).
// Emite "destino" ({lat, lon} | null), "rota" (rota traçada, com a resposta bruta do servidor),
// "rota-erro" ({ motivo }) e "rota-limpa".
(function (C) {
  "use strict";
  const { $, el, botao } = C.util;
  const Rota = window.CopilotoRota;
  let modoDestino = false, marcadorDestino = null, destino = null, rotaAtual = null, geracao = 0;

  function pedirDestino(v) {
    modoDestino = v;
    $("btn-destino").setAttribute("aria-pressed", String(v));
    if (v) {
      C.folha.fechar(); C.mensagem("Toque no mapa para escolher o destino.", 6000);
      // destinos recentes (pacote de navegação, se existir) para escolher sem tocar no mapa
      const recentes = C.navegacao && C.navegacao.recentes ? C.navegacao.recentes() : [];
      if (recentes.length) {
        const lista = el("div", "lista-recentes");
        for (const d of recentes) lista.appendChild(botao(d.rotulo, "btn btn-recente", () => definirDestino({ lat: d.lat, lng: d.lon })));
        const botoes = el("div", "linha-botoes");
        botoes.append(botao("Cancelar", "btn", () => { pedirDestino(false); C.folha.fechar(); }));
        if (C.navegacao.mostrarViagens) botoes.append(botao("Viagens anteriores", "btn", C.navegacao.mostrarViagens));
        C.folha.abrir([el("h2", null, "Destinos recentes"), lista, el("p", null, "Ou toque no mapa para escolher outro."), botoes]);
      }
    }
  }

  function definirDestino(lngLat) {
    destino = { lat: lngLat.lat, lon: lngLat.lng };
    if (marcadorDestino) marcadorDestino.remove();
    const pino = el("div", "pino-destino");
    marcadorDestino = new maplibregl.Marker({ element: pino }).setLngLat([destino.lon, destino.lat]).addTo(C.mapa);
    pedirDestino(false);
    C.emit("destino", destino);
    const botoes = el("div", "linha-botoes");
    botoes.append(
      botao("Traçar rota", "btn btn-principal", tracarRota),
      botao("Cancelar", "btn", limparRota));
    C.folha.abrir([el("h2", null, "Destino escolhido"), el("p", null, destino.lat.toFixed(5).replace(".", ",") + ", " + destino.lon.toFixed(5).replace(".", ",")), botoes]);
  }

  function limparRota() {
    const tinha = !!destino || !!rotaAtual;
    destino = null; rotaAtual = null; geracao++; pedirDestino(false);
    if (marcadorDestino) { marcadorDestino.remove(); marcadorDestino = null; }
    const mapa = C.mapa;
    if (mapa.getLayer("rota")) mapa.removeLayer("rota");
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
          paint: { "line-color": "#f2a43a", "line-width": 6, "line-opacity": 0.92 } });
      }
      if (enquadrar === false) return;
      const b = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      mapa.fitBounds(b, { padding: { top: 60, bottom: 260, left: 40, right: 40 }, duration: 700 });
    });
  }

  // Calcula a rota sem mexer na folha. opcoes: { origem, destino?, perfil?, ajustar?(pedido, faltando) → { pedido, faltando,
  // avisos? }, enquadrar? (padrão true), sinal? (AbortSignal: quem pediu desiste, nada é desenhado), tempoLimiteMs?
  // (padrão 25 s; o recálculo da navegação usa menos) }. Desenha, guarda como rota atual, emite "rota" e devolve a rota.
  // Erro: Error com .motivo (português) e .rede = true quando o servidor não respondeu (sem internet ou demora; na
  // demora também .demorou = true); .cancelada = true quando a rota foi limpa ou o sinal desistiu.
  async function calcular(o) {
    const dest = o.destino || destino;
    const perfil = o.perfil !== undefined ? o.perfil : C.veiculos.ativo();
    let { pedido, faltando } = Rota.criarPedido(perfil, o.origem, dest);
    let extras = [];
    if (o.ajustar) { const a = o.ajustar(pedido, faltando); pedido = a.pedido; faltando = a.faltando; extras = a.avisos || []; }
    const minha = geracao;
    const cancelada = () => { const e = new Error("Rota cancelada."); e.motivo = e.message; e.cancelada = true; return e; };
    const sinal = o.sinal || null;
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
    let r;
    try { r = Rota.resumirResposta(json); } catch (e) { e.motivo = e.message; throw e; }
    const avisos = extras.concat(Rota.avisos(perfil, faltando));
    const nova = { origem: o.origem, destino: dest, perfil, pedido, faltando, avisos, km: r.km, minutos: r.minutos, coords: r.coords, resposta: json,
      calculadaEm: Date.now() };
    // consultar: só calcula (conferência da rota offline pela navegação); quem pediu decide se usa (usar(rota))
    if (o.consultar) return nova;
    desenharRota(nova.coords, o.enquadrar);
    rotaAtual = nova;
    C.emit("rota", rotaAtual);
    return rotaAtual;
  }

  // Passa a usar uma rota já calculada: desenha, guarda como atual, põe o pino no destino (sem folha) e emite "rota".
  function usar(nova) {
    if (nova.destino && (!destino || destino.lat !== nova.destino.lat || destino.lon !== nova.destino.lon)) {
      destino = { lat: nova.destino.lat, lon: nova.destino.lon };
      if (marcadorDestino) marcadorDestino.remove();
      marcadorDestino = new maplibregl.Marker({ element: el("div", "pino-destino") }).setLngLat([destino.lon, destino.lat]).addTo(C.mapa);
    }
    desenharRota(nova.coords, false);
    rotaAtual = nova;
    C.emit("rota", rotaAtual);
    return rotaAtual;
  }

  async function tracarRota() {
    if (!destino) return;
    const pos = C.estado.ultimaPos;
    if (!pos) { C.mensagem("Ative o GPS para saber de onde você sai.", 6000); return; }
    const origem = { lat: pos[1], lon: pos[0] };
    const perfil = C.veiculos.ativo();
    C.folha.abrir([el("h2", null, "Traçando a rota…"), el("p", null, "Calculando para " + (perfil ? perfil.nome : "carro") + ".")]);
    try {
      const r = await calcular({ origem, perfil });
      const botoes = el("div", "linha-botoes");
      botoes.append(botao("Limpar rota", "btn", limparRota));
      const itens = [el("h2", null, "Rota para " + (perfil && Rota.ehCaminhao(perfil) ? perfil.nome : "carro")),
        el("div", "grande", Rota.formatarKm(r.km) + " · " + Rota.formatarTempo(r.minutos))];
      for (const a of r.avisos) itens.push(el("p", "aviso-rota", a));
      // navegação guiada (pacote E1), quando estiver carregada
      if (C.navegacao && C.navegacao.iniciar) itens.push(botao("Iniciar navegação", "btn btn-principal btn-iniciar-nav", () => C.navegacao.iniciar()));
      itens.push(botoes);
      C.folha.abrir(itens);
    } catch (e) {
      if (e.cancelada) return;
      const motivo = e.motivo || e.message;
      const botoes = el("div", "linha-botoes");
      botoes.append(botao("Tentar de novo", "btn btn-principal", tracarRota), botao("Cancelar", "btn", limparRota));
      C.folha.abrir([el("h2", null, "Não foi possível traçar"), el("p", null, motivo), botoes]);
      C.emit("rota-erro", { motivo });
    }
  }

  C.rota = { destino: () => destino, atual: () => rotaAtual, pedirDestino, definirDestino, tracar: tracarRota, limpar: limparRota, calcular, usar };

  C.aoIniciar(() => {
    $("btn-destino").addEventListener("click", () => pedirDestino(!modoDestino));
    C.on("mapa-clique", (e) => { if (modoDestino) definirDestino(e.lngLat); });
  });
})(window.Copiloto);
