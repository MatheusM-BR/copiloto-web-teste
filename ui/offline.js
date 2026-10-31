// Offline e dados (pacote E3): service worker, faixa de estado (online/sem internet e idade dos dados),
// rota e relatos guardados para abrir sem internet, "Baixar mapa da rota" (corredor) e avisos do que
// depende de internet (PER-02). Lógica pura em offline.js (window.CopilotoOffline).
// Expõe Copiloto.offline: online(), rotaGuardada(), relatosGuardados(), mapaBaixado(), baixando(), esquecerRota(),
// marcarUltima(info), ultimaRota(), marcarConferida(ts), abrirRotaGuardada().
// Chegada (pedido do dono do produto): a rota guardada e o mapa do corredor NÃO são apagados; a rota vira "última rota"
// por 30 dias (O.ULTIMA_VALIDADE_MS), com a linha tracejada marcada "Última rota" no mapa, "Voltar pela mesma rota" e
// "Limpar rota" na folha da tela inicial.
// Emite "offline:estado" ({ online, texto }) quando a faixa muda.
(function (C) {
  "use strict";
  const { $, el, botao, plural } = C.util;
  const O = window.CopilotoOffline;
  const CHAVE_ROTA = "copiloto.e3.rota.v1";
  const CHAVE_RELATOS = "copiloto.e3.relatos.v1";
  const CHAVE_MAPA = "copiloto.e3.mapa.v1";
  const CACHE_ROTA = "copiloto-mapa-rota";
  const CACHE_ESTILO = "copiloto-mapa-estilo";
  const PARALELO = 6, FALHAS_SEGUIDAS_PARA_PARAR = 8;

  let swRegistro = null, swErro = null, pediuAtualizar = false;
  let rotaGuardada = null;        // { salvoEm, destino, origem, km, minutos, coords, avisos, perfilNome, resposta }
  let rotaDestaSessao = false;    // rota traçada agora (ui/rota.js) e não restaurada
  let relatosGuardados = null;    // { salvoEm, usuario, lista }
  let relatosFrescos = false;     // já chegou lista nova da nuvem nesta sessão
  const marcasGuardadas = new Map();
  let download = null;            // { parar, feitos, total, pct }
  let falhaGravar = null;         // texto se não conseguiu guardar rota/relatos (PER-02)

  // ------------------------------------------------------------ armazenamento (sem silêncio: falha vira aviso)
  function ler(chave) { try { const b = localStorage.getItem(chave); return b ? JSON.parse(b) : null; } catch (e) { return null; } }
  function gravar(chave, valor) {
    try { if (valor == null) localStorage.removeItem(chave); else localStorage.setItem(chave, JSON.stringify(valor)); return true; } catch (e) { return false; }
  }
  const online = () => navigator.onLine !== false;

  // ------------------------------------------------------------ service worker
  function registrarSW() {
    if (!("serviceWorker" in navigator)) { swErro = "Este navegador não guarda o app para abrir sem internet."; return; }
    navigator.serviceWorker.register("sw.js").then((reg) => {
      swRegistro = reg;
      if (reg.waiting && navigator.serviceWorker.controller) mostrarAtualizar();
      reg.addEventListener("updatefound", () => {
        const novo = reg.installing; if (!novo) return;
        novo.addEventListener("statechange", () => {
          if (novo.state === "installed" && navigator.serviceWorker.controller) mostrarAtualizar();
        });
      });
      // confere versão nova de tempos em tempos (só com internet)
      setInterval(() => { if (online()) reg.update().catch(() => {}); }, 30 * 60e3);
    }).catch((e) => { swErro = "O app pode não abrir sem internet neste aparelho (" + ((e && e.message) || "service worker recusado") + ")."; });
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (pediuAtualizar) location.reload(); else aquecerEstilo(); });
    if (navigator.serviceWorker.controller) aquecerEstilo();
  }
  // Pede o estilo do mapa e o TileJSON de novo, agora passando pelo service worker, que os guarda.
  // (Na primeira visita o mapa carrega antes de o service worker assumir a página.)
  let aqueceu = false;
  function aquecerEstilo() {
    if (aqueceu || !online() || !navigator.serviceWorker.controller) return;
    aqueceu = true;
    C.mapaPronto(() => {
      const urls = new Set([C.mapaEstiloUrl]);
      const fontes = (C.mapa.getStyle() || {}).sources || {};
      for (const id of Object.keys(fontes)) if (typeof fontes[id].url === "string") urls.add(fontes[id].url);
      for (const u of urls) if (u && O.classificarUrl(u)) fetch(u, { mode: "cors" }).catch(() => {});
    });
  }
  function mostrarAtualizar() {
    let b = $("e3-atualizar");
    if (!b) {
      b = botao("Nova versão disponível — tocar para atualizar", "e3-atualizar", atualizarAgora);
      b.id = "e3-atualizar";
      $("e3-estado").after(b);
    }
    b.hidden = false;
  }
  function atualizarAgora() {
    const w = swRegistro && swRegistro.waiting;
    if (!w) { location.reload(); return; }
    pediuAtualizar = true;
    $("e3-atualizar").textContent = "Atualizando…";
    w.postMessage({ tipo: "atualizar" });
  }

  // ------------------------------------------------------------ faixa de estado
  function mapaMeta() { return ler(CHAVE_MAPA); }
  function mapaDaRotaAtual() {
    const m = mapaMeta(), r = rotaGuardada;
    return m && r && m.rotaId === r.salvoEm ? m : null;
  }
  function estadoAtual() {
    const m = mapaDaRotaAtual();
    return {
      online: online(), agora: Date.now(), logado: C.nuvem.logado(),
      relatosEm: relatosGuardados && C.nuvem.logado() ? relatosGuardados.salvoEm : null,
      rota: !!rotaGuardada,
      mapa: m ? { em: m.em, completo: m.completo, pct: m.total ? (100 * m.baixados) / m.total : 0 } : null,
      baixando: download ? download.pct : null,
    };
  }
  let ultimoTexto = null;
  function atualizarFaixa() {
    const f = $("e3-estado"); if (!f) return;
    const e = estadoAtual();
    const texto = O.textoEstado(e);
    f.textContent = texto;
    f.classList.toggle("sem-internet", !e.online);
    f.setAttribute("aria-label", texto + ". Toque para detalhes.");
    $("e3-aviso-conta").hidden = e.online;
    if (texto !== ultimoTexto) { ultimoTexto = texto; C.emit("offline:estado", { online: e.online, texto }); }
  }

  function abrirDetalhes() {
    const e = estadoAtual();
    const itens = [el("h2", null, e.online ? "Com internet" : "Sem internet")];
    itens.push(el("p", null, O.textoEstado(e)));
    if (!e.online) {
      const ul = el("ul", "e3-lista");
      for (const t of O.SEM_INTERNET) ul.appendChild(el("li", null, t));
      itens.push(ul);
    }
    if (rotaGuardada) itens.push(el("p", null, (ultimaRota() ? "Última rota (chegada " + O.formatarHora(rotaGuardada.ultima.chegouEm) + "): traçada " : "Rota guardada: traçada ") +
      O.formatarIdade(Date.now() - rotaGuardada.salvoEm) + " (" + O.formatarHora(rotaGuardada.salvoEm) + ")."));
    if (swErro) itens.push(el("p", "e3-alerta", swErro));
    if (falhaGravar) itens.push(el("p", "e3-alerta", falhaGravar));
    const b = el("div", "linha-botoes");
    if (rotaGuardada) b.append(botao("Baixar mapa da rota", "btn", abrirBaixar));
    if (ultimaRota()) b.append(botao("Última rota", "btn", folhaRotaGuardada));
    b.append(botao("Fechar", "btn", C.folha.fechar));
    itens.push(b);
    C.folha.abrir(itens);
  }

  // ------------------------------------------------------------ rota guardada
  // M5: grava só quando a rota muda (o recálculo que devolve o mesmo desenho não regrava) e grava compacta
  // (a polyline do Valhalla, sem as coordenadas decodificadas: O.rotaParaGuardar). Sem espaço: tenta sem as manobras e avisa.
  let gravadaSemManobras = false;
  function guardarRota(r) {
    const nova = {
      salvoEm: Date.now(), origem: r.origem, destino: r.destino, km: r.km, minutos: r.minutos, coords: r.coords,
      avisos: r.avisos || [], perfilNome: r.perfil ? r.perfil.nome : null, resposta: r.resposta,
    };
    const igual = O.mesmaRota(rotaGuardada, nova) && !gravadaSemManobras;
    const eraUltima = !!(rotaGuardada && rotaGuardada.ultima);
    rotaDestaSessao = true;
    if (igual) {
      // mesmo desenho: mantém a gravada (e o salvoEm, que liga o mapa baixado a esta rota); só atualiza a memória.
      // Rota em uso de novo deixa de ser "última rota" (regrava sem a marca).
      rotaGuardada = Object.assign({}, nova, { salvoEm: rotaGuardada.salvoEm });
      if (eraUltima) gravar(CHAVE_ROTA, O.rotaParaGuardar(rotaGuardada));
    } else {
      rotaGuardada = nova;
      falhaGravar = null; gravadaSemManobras = false;
      if (!gravar(CHAVE_ROTA, O.rotaParaGuardar(rotaGuardada))) {
        // aparelho sem espaço: guarda pelo menos o desenho e o resumo, sem as manobras
        gravar(CHAVE_ROTA, null); // tira a rota anterior para liberar espaço
        if (!gravar(CHAVE_ROTA, O.rotaParaGuardar(rotaGuardada, "leve"))) {
          falhaGravar = "Não deu para guardar a rota no aparelho (sem espaço). Sem internet, ela não vai aparecer. Libere espaço no iPhone ou apague dados do navegador.";
        } else { falhaGravar = "A rota foi guardada sem as manobras (aparelho sem espaço). Sem internet, dá para ver o caminho, mas sem a voz das manobras."; gravadaSemManobras = true; }
        C.mensagem(falhaGravar, 8000);
      }
    }
    apagarDesenhoRota();
    atualizarBotao(); atualizarFaixa();
    // a folha da rota (ui/rota.js) cobre a coluna de botões: oferece o download nela também.
    // ui/rota.js emite "rota" antes de abrir a folha com o resultado: espera ela abrir (e só mexe nessa folha,
    // não numa folha de outro módulo aberta durante um recálculo da navegação).
    setTimeout(() => {
      const f = $("folha"), h = f.querySelector("h2");
      const linha = f.querySelector(".linha-botoes");
      if (f.hidden || !linha || !h || !/^Rota para /.test(h.textContent) || $("e3-baixar-folha")) return;
      const b = botao("Baixar mapa da rota", "btn", abrirBaixar); b.id = "e3-baixar-folha";
      linha.insertBefore(b, linha.firstChild);
    }, 0);
  }
  function esquecerRota() {
    rotaGuardada = null; rotaDestaSessao = false;
    gravar(CHAVE_ROTA, null);
    apagarDesenhoRota(); atualizarBotao(); atualizarFaixa();
  }
  // Grava a rota guardada como está (com a marca de última rota / conferência). Sem espaço: sem as manobras.
  function regravar() {
    if (!rotaGuardada) return false;
    if (gravar(CHAVE_ROTA, O.rotaParaGuardar(rotaGuardada, gravadaSemManobras ? "leve" : undefined))) return true;
    return gravar(CHAVE_ROTA, O.rotaParaGuardar(rotaGuardada, "leve"));
  }
  // Chegada (ui/navegacao.js): a rota guardada vira "última rota" (não é apagada, nem o mapa do corredor).
  // info: { chegouEm, sentido: "ida" | "volta" (sentido percorrido em relação ao desenho guardado), voltarPara: { lat, lon },
  //   rotulo, perfilId, carga, peso }. Depois disso a rota não é mais "desta sessão": limpar a rota do mapa não a apaga.
  function marcarUltima(info) {
    if (!rotaGuardada || !info) return false;
    rotaGuardada = Object.assign({}, rotaGuardada, { ultima: Object.assign({ chegouEm: Date.now(), sentido: "ida" }, info) });
    rotaDestaSessao = false;
    regravar();
    desenharRotaGuardada(); atualizarBotao(); atualizarFaixa();
    return true;
  }
  function ultimaRota() { return rotaGuardada && O.ultimaValida(rotaGuardada, Date.now()) ? rotaGuardada.ultima : null; }
  // A navegação conferiu a rota guardada com a internet e ela continua a mesma
  function marcarConferida(ts) {
    if (!rotaGuardada) return;
    rotaGuardada = Object.assign({}, rotaGuardada, { conferidaEm: ts || Date.now() });
    regravar();
  }
  let rotuloUltima = null;
  function apagarDesenhoRota() {
    if (rotuloUltima) { rotuloUltima.remove(); rotuloUltima = null; }
    // mapaPronto, não isStyleLoaded(): este fica false enquanto uma fonte carrega blocos (câmera andando/inclinada na
    // navegação) e a linha ficava no mapa depois da chegada
    const m = C.mapa; if (!m) return;
    C.mapaPronto(() => {
      if (m.getLayer("e3-rota-guardada")) m.removeLayer("e3-rota-guardada");
      if (m.getSource("e3-rota-guardada")) m.removeSource("e3-rota-guardada");
    });
  }
  // "Última rota" escrito no meio da linha tracejada (marcador de HTML: não depende das fontes do mapa, sem internet)
  function marcarRotuloUltima(r) {
    if (rotuloUltima) { rotuloUltima.remove(); rotuloUltima = null; }
    if (!r || !r.ultima || !O.ultimaValida(r, Date.now())) return;
    const meio = r.coords[Math.floor(r.coords.length / 2)];
    const e = botao("Última rota", "e3-rotulo-ultima", folhaRotaGuardada);
    e.id = "e3-rotulo-ultima"; e.setAttribute("aria-label", "Última rota: voltar pela mesma rota ou limpar");
    rotuloUltima = new maplibregl.Marker({ element: e }).setLngLat(meio).addTo(C.mapa);
  }
  function desenharRotaGuardada() {
    const r = rotaGuardada; if (!r || !Array.isArray(r.coords) || r.coords.length < 2) return;
    C.mapaPronto(() => {
      const m = C.mapa;
      if (!rotaGuardada || rotaDestaSessao) return;
      const dados = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: r.coords } };
      if (m.getSource("e3-rota-guardada")) m.getSource("e3-rota-guardada").setData(dados);
      else {
        m.addSource("e3-rota-guardada", { type: "geojson", data: dados });
        m.addLayer({ id: "e3-rota-guardada", type: "line", source: "e3-rota-guardada", layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#f2a43a", "line-width": 6, "line-opacity": 0.75, "line-dasharray": [2, 1.2] } });
      }
      marcarRotuloUltima(rotaGuardada);
      if (!C.seguindo()) {
        const b = r.coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(r.coords[0], r.coords[0]));
        m.fitBounds(b, { padding: { top: 60, bottom: 260, left: 40, right: 40 }, duration: 0 });
      }
    });
  }
  function folhaRotaGuardada() {
    const r = rotaGuardada; if (!r) return;
    if (ultimaRota()) { folhaUltima(r); return; }
    const resumo = (isFinite(r.km) ? window.CopilotoRota.formatarKm(r.km) : "distância desconhecida") + " · " +
      (isFinite(r.minutos) ? window.CopilotoRota.formatarTempo(r.minutos) : "tempo desconhecido");
    const b = el("div", "linha-botoes");
    const baixar = botao("Baixar mapa da rota", "btn btn-principal", abrirBaixar);
    b.append(baixar, botao("Esquecer rota", "btn", () => { esquecerRota(); C.folha.fechar(); }), botao("Fechar", "btn", C.folha.fechar));
    const m = mapaDaRotaAtual();
    const itens = [
      el("h2", "e3-titulo-rota", "Rota guardada" + (r.perfilNome ? " · " + r.perfilNome : "")),
      el("div", "grande", resumo),
      el("p", null, "Traçada " + O.formatarIdade(Date.now() - r.salvoEm) + " (" + O.formatarHora(r.salvoEm) + "). " +
        (online() ? "Para atualizar, trace de novo." : "Sem internet: dá para seguir esta rota; rota nova só com internet.")),
    ];
    if (m && m.completo) { itens.push(el("p", null, "Mapa do caminho baixado às " + O.formatarHora(m.em) + ".")); baixar.remove(); }
    for (const a of r.avisos || []) itens.push(el("p", "aviso-rota", a));
    // navegação guiada (E1) a partir da rota guardada: sem internet ela segue esta rota sem recalcular
    if (C.navegacao && C.navegacao.iniciar && !C.navegacao.ativa()) {
      const nav = botao("Iniciar navegação", "btn btn-principal btn-iniciar-nav", () => C.navegacao.iniciar());
      nav.id = "e3-iniciar-nav";
      itens.push(nav);
    }
    itens.push(b);
    C.folha.abrir(itens);
  }

  // Última rota (chegou): "Voltar pela mesma rota" (≥ 64 px) e "Limpar rota", enquanto valer (30 dias)
  function folhaUltima(r) {
    const u = r.ultima;
    const ate = O.ultimaValidaAte(r);
    const itens = [el("h2", "e3-titulo-rota", "Última rota" + (r.perfilNome ? " · " + r.perfilNome : "")),
      el("p", null, "Chegou " + (u.rotulo ? "em " + u.rotulo + " " : "") + O.formatarIdade(Date.now() - u.chegouEm) + " (" + O.formatarHora(u.chegouEm) + "). " +
        "Fica guardada até " + O.formatarHora(ate) + " para voltar pelo mesmo caminho, mesmo sem internet."),
    ];
    const m = mapaDaRotaAtual();
    if (m && m.completo) itens.push(el("p", null, "Mapa do caminho baixado às " + O.formatarHora(m.em) + "."));
    if (C.navegacao && C.navegacao.voltar && !C.navegacao.ativa()) {
      const v = botao("Voltar pela mesma rota", "btn btn-principal btn-iniciar-nav e3-voltar", () => C.navegacao.voltar());
      v.id = "e3-voltar";
      itens.push(v);
      itens.push(el("p", "e3-estimativa", online() ? "Com internet, a rota de volta é calculada de verdade a partir de onde você estiver."
        : "Sem internet: segue a linha destacada no sentido contrário, sem as curvas faladas; quando a internet voltar, ela é conferida."));
    }
    const b = el("div", "linha-botoes");
    const limpar = botao("Limpar rota", "btn", () => { esquecerRota(); C.folha.fechar(); C.mensagem("Rota limpa.", 4000); });
    limpar.id = "e3-limpar-ultima";
    b.append(limpar, botao("Fechar", "btn", C.folha.fechar));
    itens.push(b);
    C.folha.abrir(itens);
  }

  // ------------------------------------------------------------ relatos guardados
  function guardarRelatos(lista) {
    const u = C.nuvem.usuario();
    if (!u) { relatosGuardados = null; gravar(CHAVE_RELATOS, null); return; }
    // heading_deg: o alerta (E5, ALT-03) confere o sentido também nos relatos guardados
    const campos = ["id", "report_type", "value_numeric", "lat", "lon", "heading_deg", "level", "confirm_count", "deny_count", "expires_at", "mine", "my_vote"];
    relatosGuardados = { salvoEm: Date.now(), usuario: u.id, lista: lista.map((r) => { const x = {}; for (const c of campos) x[c] = r[c]; return x; }) };
    if (!gravar(CHAVE_RELATOS, relatosGuardados)) falhaGravar = "Não deu para guardar os relatos no aparelho (sem espaço).";
    relatosFrescos = true;
    apagarRelatosGuardados();
    atualizarFaixa();
  }
  function apagarRelatosGuardados() { for (const [, m] of marcasGuardadas) m.remove(); marcasGuardadas.clear(); }
  function relatosParaMostrar() {
    const g = relatosGuardados, u = C.nuvem.usuario();
    if (!g || !u || g.usuario !== u.id || !Array.isArray(g.lista)) return [];
    const agora = Date.now();
    return g.lista.filter((r) => !(Date.parse(r.expires_at) <= agora) && window.CopilotoNuvem.tipoParaApp(r.report_type));
  }
  function desenharRelatosGuardados() {
    apagarRelatosGuardados();
    if (relatosFrescos || !relatosGuardados) return;
    const idade = O.formatarIdade(Date.now() - relatosGuardados.salvoEm);
    for (const r of relatosParaMostrar()) {
      const marca = el("div", "relato-marca e3-guardado nivel-" + r.level, C.comunidade.sigla(r) + " · " + idade);
      marca.dataset.id = r.id;
      marca.title = C.comunidade.titulo(r) + " · relato de " + idade;
      const pop = el("div", "popup-relato");
      pop.append(el("b", null, C.comunidade.titulo(r)), el("small", null, window.CopilotoNuvem.textoNivel(r.level)),
        el("small", null, "Relato guardado: " + idade + ". Sem internet para saber se ainda está lá."));
      // opacidade como opção do marcador: o MapLibre regrava style.opacity a cada movimento e apagaria a do CSS
      marcasGuardadas.set(r.id, new maplibregl.Marker({ element: marca, opacity: "0.8" }).setLngLat([r.lon, r.lat])
        .setPopup(new maplibregl.Popup({ offset: 14 }).setDOMContent(pop)).addTo(C.mapa));
    }
  }

  // ------------------------------------------------------------ baixar mapa da rota (corredor)
  let botaoBaixar = null;
  function atualizarBotao() { if (botaoBaixar) botaoBaixar.hidden = !rotaGuardada; }

  // Modelo do endereço dos blocos ({z}/{x}/{y}) e zoom máximo da fonte vetorial do estilo carregado.
  function fonteDeBlocos() {
    const m = C.mapa; if (!m || !m.isStyleLoaded()) return null;
    const estilo = m.getStyle();
    for (const id of Object.keys(estilo.sources || {})) {
      const def = estilo.sources[id];
      if (def.type !== "vector") continue;
      const fonte = m.getSource(id);
      const tiles = (fonte && fonte.tiles) || def.tiles;
      if (Array.isArray(tiles) && tiles.length) return { modelo: tiles[0], maxzoom: (fonte && fonte.maxzoom) || def.maxzoom || 14, estilo };
    }
    return null;
  }

  async function espacoLivre() {
    try { if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate(); } catch (e) { /* sem estimativa */ }
    return null;
  }
  async function persistente() {
    try { if (navigator.storage && navigator.storage.persisted) return await navigator.storage.persisted(); } catch (e) { /* sem suporte */ }
    return null;
  }

  async function abrirBaixar() {
    const r = rotaGuardada;
    if (!r) return;
    if (download) { folhaProgresso(); return; }
    if (!online()) { folhaSimples("Precisa de internet", "Baixar o mapa da rota precisa de internet. O que já está guardado continua funcionando."); return; }
    const fonte = fonteDeBlocos();
    if (!fonte) { folhaSimples("O mapa ainda não carregou", "Espere o mapa aparecer (precisa de internet) e tente de novo."); return; }
    const plano = O.planejarCorredor(r.coords, { zMax: Math.min(14, fonte.maxzoom) });
    const [est, persist] = await Promise.all([espacoLivre(), persistente()]);
    const espaco = O.cabeNoAparelho(est, plano.bytes);
    const itens = [el("h2", null, "Baixar mapa da rota"),
      el("div", "grande", "~" + O.formatarBytes(plano.bytes)),
      el("p", "e3-estimativa", "Cerca de " + O.formatarNumero(plano.total) + " pedaços de mapa, faixa de " +
        O.formatarNumero(plano.larguraM / 1000) + " km em volta da rota. O tamanho é estimado."),
    ];
    if (plano.reduzido) itens.push(el("p", null, "Rota longa: o mapa baixado vai até o zoom " + plano.zMax + " (menos detalhe de perto) para não ficar grande demais."));
    if (espaco.sabe) itens.push(el("p", null, "Espaço que o app ainda pode usar: ~" + O.formatarBytes(espaco.livre) + "."));
    else itens.push(el("p", null, "Este aparelho não informa o espaço livre."));
    const m = mapaMeta();
    if (m && m.rotaId !== r.salvoEm) itens.push(el("p", null, "O mapa baixado da rota anterior vai ser trocado por este."));
    const b = el("div", "linha-botoes");
    if (!espaco.cabe) {
      itens.push(el("p", "e3-alerta", "Não cabe: o aparelho não tem espaço suficiente para este mapa. Libere espaço no iPhone ou trace uma rota menor."));
    } else {
      if (persist === false) itens.push(el("p", null, "Vamos pedir ao aparelho para não apagar o mapa baixado quando faltar espaço. Se ele pedir permissão, toque em Permitir."));
      const sim = botao("Baixar agora", "btn btn-principal", () => iniciarDownload(plano, fonte, persist === false));
      sim.id = "e3-confirmar-baixar";
      b.append(sim);
    }
    b.append(botao("Cancelar", "btn", C.folha.fechar));
    itens.push(b);
    C.folha.abrir(itens);
  }

  function folhaSimples(titulo, texto) {
    const b = el("div", "linha-botoes"); b.append(botao("Fechar", "btn", C.folha.fechar));
    C.folha.abrir([el("h2", null, titulo), el("p", null, texto), b]);
  }

  let progressoEl = null;
  function folhaProgresso() {
    const d = download; if (!d) return;
    progressoEl = el("p", "e3-progresso-texto");
    const barra = el("div", "e3-barra"); const cheio = el("div", "e3-barra-cheia"); barra.append(cheio);
    progressoEl._barra = cheio;
    const parar = botao("Parar", "btn btn-grande", () => { d.parar = true; d.motivo = "motorista"; });
    parar.id = "e3-parar";
    const b = el("div", "coluna-botoes"); b.append(parar, botao("Continuar usando o app", "btn", C.folha.fechar));
    C.folha.abrir([el("h2", null, "Baixando mapa da rota…"), barra, progressoEl,
      el("p", null, "Pode parar quando quiser: o que já baixou fica guardado."), b]);
    desenharProgresso();
  }
  function desenharProgresso() {
    const d = download;
    if (!d || !progressoEl || !progressoEl.isConnected) return;
    progressoEl.textContent = O.formatarNumero(d.feitos) + " de " + O.formatarNumero(d.total) + " (" + Math.floor(d.pct) + "%)";
    progressoEl._barra.style.width = d.pct + "%";
  }

  async function iniciarDownload(plano, fonte, pedirPersistencia) {
    const r = rotaGuardada; if (!r || download) return;
    if (pedirPersistencia) { try { await navigator.storage.persist(); } catch (e) { /* o aparelho decide */ } }
    if (!("caches" in window)) { folhaSimples("Não foi possível baixar", "Este navegador não deixa guardar o mapa."); return; }
    const anterior = mapaMeta();
    if (anterior && anterior.rotaId !== r.salvoEm) await caches.delete(CACHE_ROTA); // um corredor por vez: o da rota guardada
    const cacheRota = await caches.open(CACHE_ROTA);
    const meta = { rotaId: r.salvoEm, total: plano.total, baixados: 0, bytes: 0, em: null, completo: false, zMax: plano.zMax, iniciado: Date.now() };
    gravar(CHAVE_MAPA, meta);
    const d = download = { parar: false, motivo: null, feitos: 0, total: plano.total, pct: 0, bytes: 0, semBloco: 0, erros: 0 };
    folhaProgresso(); atualizarFaixa();

    // fontes e sprites do estilo (para os nomes das ruas aparecerem sem internet)
    try {
      const est = await caches.open(CACHE_ESTILO);
      const extras = [C.mapaEstiloUrl].concat(Object.values(fonte.estilo.sources || {}).map((f) => f.url))
        .filter((u) => typeof u === "string" && O.classificarUrl(u));
      for (const u of extras.concat(O.recursosDoEstilo(fonte.estilo, fonte.modelo))) {
        if (d.parar) break;
        try { const resp = await fetch(u, { cache: "no-store", mode: "cors" }); if (resp.ok) await est.put(u, await carimbar(resp)); } catch (e) { /* segue */ }
      }
    } catch (e) { /* sem Cache Storage para o estilo: segue com os blocos */ }

    let seguidas = 0, ultimoDesenho = 0;
    const fila = plano.blocos.slice();
    async function trabalhador() {
      while (!d.parar && fila.length) {
        const b = fila.shift();
        const url = O.urlBloco(fonte.modelo, b);
        const chave = O.chaveBloco(url) || url;
        try {
          if (!(await cacheRota.match(chave))) {
            const resp = await fetch(url, { cache: "no-store", mode: "cors" });
            if (resp.ok) {
              const c = await carimbar(resp);
              d.bytes += Number(c.headers.get("x-copiloto-bytes")) || 0;
              await cacheRota.put(chave, c);
            } else if (resp.status === 404 || resp.status === 204) d.semBloco++; // mar ou área sem dado
            else d.erros++;
          }
          seguidas = 0;
        } catch (e) {
          if (e && e.name === "QuotaExceededError") { d.parar = true; d.motivo = "espaco"; break; }
          d.erros++;
          if (++seguidas >= FALHAS_SEGUIDAS_PARA_PARAR || !online()) { d.parar = true; d.motivo = d.motivo || "rede"; break; }
          fila.push(b); // tenta este bloco de novo mais tarde
          continue;
        }
        d.feitos++;
        d.pct = (100 * d.feitos) / d.total;
        const agora = Date.now();
        if (agora - ultimoDesenho > 250) { ultimoDesenho = agora; desenharProgresso(); atualizarFaixa(); meta.baixados = d.feitos; gravar(CHAVE_MAPA, meta); }
      }
    }
    await Promise.all(Array.from({ length: PARALELO }, trabalhador));
    meta.baixados = d.feitos; meta.bytes = (anterior && anterior.rotaId === r.salvoEm ? anterior.bytes || 0 : 0) + d.bytes;
    meta.completo = d.feitos >= d.total;
    meta.em = Date.now();
    gravar(CHAVE_MAPA, meta);
    download = null;
    atualizarFaixa();
    const b = el("div", "linha-botoes");
    if (meta.completo) {
      b.append(botao("Fechar", "btn btn-principal", C.folha.fechar));
      const persist = await persistente();
      const itens = [el("h2", null, "Mapa da rota baixado"),
        el("p", null, O.formatarNumero(meta.total) + " pedaços de mapa (" + O.formatarBytes(meta.bytes) + " baixados agora). O mapa do caminho aparece mesmo sem internet."),
      ];
      if (persist === false) itens.push(el("p", "e3-alerta", "O aparelho não garantiu guardar para sempre: se faltar espaço, ele pode apagar o mapa. Instalar o app na tela de início ajuda."));
      itens.push(b);
      C.folha.abrir(itens);
    } else {
      const motivo = d.motivo === "motorista" ? "Download parado." :
        d.motivo === "espaco" ? "O espaço do aparelho acabou." : "A internet caiu.";
      b.append(botao("Continuar baixando", "btn btn-principal", abrirBaixar), botao("Fechar", "btn", C.folha.fechar));
      C.folha.abrir([el("h2", null, motivo),
        el("p", null, "Já baixou " + O.formatarNumero(d.feitos) + " de " + O.formatarNumero(d.total) + " (" + Math.floor(d.pct) + "%). O que baixou fica guardado; continue quando quiser."), b]);
    }
  }
  async function carimbar(resp) {
    const corpo = await resp.arrayBuffer();
    const cab = new Headers(resp.headers);
    cab.set("x-copiloto-em", String(Date.now()));
    cab.set("x-copiloto-bytes", String(corpo.byteLength));
    return new Response(corpo, { status: resp.status, statusText: resp.statusText, headers: cab });
  }

  // ------------------------------------------------------------ PER-02: o que precisa de internet, dito na hora
  function avisoDestinoSemInternet() {
    if (online()) return;
    setTimeout(() => {
      const f = $("folha");
      if (f.hidden || f.querySelector(".e3-aviso-folha")) return;
      const p = el("p", "e3-aviso-folha", "Sem internet: a rota nova só pode ser traçada quando a internet voltar.");
      const botoes = f.querySelector(".linha-botoes");
      if (botoes) f.insertBefore(p, botoes); else f.appendChild(p);
    }, 0);
  }

  C.offline = {
    online, rotaGuardada: () => rotaGuardada, relatosGuardados: () => relatosParaMostrar(),
    // true enquanto não chegou lista nova da nuvem nesta sessão (ex.: app aberto sem internet): o alerta à frente
    // usa os relatos guardados; quando a nuvem responde, passa a usar só a lista nova (mesmos ids, sem alerta repetido)
    usandoGuardados: () => !relatosFrescos && !!relatosGuardados,
    mapaBaixado: () => mapaDaRotaAtual(), baixando: () => (download ? { feitos: download.feitos, total: download.total } : null),
    abrirBaixar,
    // "Limpar rota" da última rota e do resumo de chegada
    esquecerRota,
    // chegada: a rota vira "última rota" (30 dias) em vez de ser esquecida; a navegação confere a rota com a internet
    marcarUltima, ultimaRota, marcarConferida, abrirRotaGuardada: folhaRotaGuardada,
  };

  C.aoIniciar(() => {
    C.carregarEstilo("estilos/offline.css");
    const faixa = el("button", "e3-estado"); faixa.type = "button"; faixa.id = "e3-estado";
    faixa.addEventListener("click", abrirDetalhes);
    document.querySelector(".aviso").after(faixa);
    const avisoConta = el("p", "e3-aviso-conta", "Sem internet: entrar na conta ou criar conta precisa de internet.");
    avisoConta.id = "e3-aviso-conta"; avisoConta.hidden = true;
    const tc = $("tela-conta"); if (tc) tc.insertBefore(avisoConta, tc.querySelector("h1").nextSibling);

    botaoBaixar = C.botoesMapa.adicionar({ id: "e3-btn-baixar", icone: "⤓", rotulo: "Baixar mapa da rota", aoTocar: abrirBaixar, noFim: true });

    // dados guardados
    // M5: a gravada vem sem as coordenadas (só a polyline): decodifica aqui (aceita também o formato antigo, com coords)
    rotaGuardada = O.rotaDeGuardada(ler(CHAVE_ROTA), window.CopilotoRota && window.CopilotoRota.decodificarPolyline6);
    gravadaSemManobras = !!(rotaGuardada && rotaGuardada.semManobras);
    // última rota vencida (mais de 30 dias da chegada): esquecida
    if (rotaGuardada && rotaGuardada.ultima && !O.ultimaValida(rotaGuardada, Date.now())) { rotaGuardada = null; gravar(CHAVE_ROTA, null); }
    relatosGuardados = ler(CHAVE_RELATOS);
    atualizarBotao();
    if (rotaGuardada) {
      desenharRotaGuardada();
      // o cartão "Ativar o GPS" fica no meio da tela: a folha da rota guardada espera ele sair
      const cartao = $("cartao-gps");
      if (!cartao || cartao.hidden) folhaRotaGuardada();
      else {
        const desligar = [];
        const abrir = () => { desligar.forEach((f) => f()); if (rotaGuardada && !rotaDestaSessao && !C.folha.aberta()) folhaRotaGuardada(); };
        desligar.push(C.on("posicao", abrir), C.on("gps-erro", abrir));
      }
    }
    C.mapaPronto(desenharRelatosGuardados);

    C.on("rota", guardarRota);
    C.on("rota-limpa", () => { if (rotaDestaSessao) esquecerRota(); });
    C.on("relatos", (lista) => {
      if (!C.nuvem.logado()) { relatosGuardados = null; gravar(CHAVE_RELATOS, null); apagarRelatosGuardados(); atualizarFaixa(); return; }
      guardarRelatos(Array.isArray(lista) ? lista : []);
    });
    C.on("sessao", (s) => {
      if (!s) { relatosGuardados = null; gravar(CHAVE_RELATOS, null); apagarRelatosGuardados(); }
      atualizarFaixa();
    });
    C.on("destino", (d) => { if (d) avisoDestinoSemInternet(); });
    $("btn-destino").addEventListener("click", () => {
      if (!online() && $("btn-destino").getAttribute("aria-pressed") === "true")
        C.mensagem("Sem internet: rota nova precisa de internet. Você ainda pode marcar o destino no mapa.", 7000);
    });

    window.addEventListener("online", () => { atualizarFaixa(); C.mensagem("Internet de volta.", 4000); });
    window.addEventListener("offline", () => {
      atualizarFaixa();
      C.mensagem("Sem internet. A rota e os relatos guardados continuam; rota nova e relatos novos esperam a conexão.", 8000);
    });
    setInterval(() => { atualizarFaixa(); if (!relatosFrescos) desenharRelatosGuardados(); }, 30000);
    atualizarFaixa();
    registrarSW();
  });
})(window.Copiloto);
