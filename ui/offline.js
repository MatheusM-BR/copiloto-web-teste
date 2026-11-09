// Offline e dados (pacote E3): service worker, faixa de estado (online/sem internet e idade dos dados),
// rota e relatos guardados para abrir sem internet, mapa da rota em cache automático (corredor baixado sozinho ao traçar,
// sem botão) e avisos do que depende de internet (PER-02). Lógica pura em offline.js (window.CopilotoOffline).
// Expõe Copiloto.offline: online(), rotaGuardada(), relatosGuardados(), mapaBaixado(), baixando(), corredores(), esquecerRota(),
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
  const CHAVE_MAPA = "copiloto.e3.mapa.v1";     // formato antigo (um corredor só): ainda lido
  const CHAVE_MAPAS = "copiloto.e3.mapas.v2";   // corredores baixados sozinhos (um por rota)
  const CHAVE_PERSIST = "copiloto.e3.persist.v1"; // navigator.storage.persist() já pedido
  const CACHE_ESTILO = "copiloto-mapa-estilo";
  const FALHAS_SEGUIDAS_PARA_PARAR = 8;

  let swRegistro = null, swErro = null, pediuAtualizar = false;
  let rotaGuardada = null;        // { salvoEm, destino, origem, km, minutos, coords, avisos, perfilNome, resposta }
  let rotaDestaSessao = false;    // rota traçada agora (ui/rota.js) e não restaurada
  let relatosGuardados = null;    // { salvoEm, usuario, lista }
  let relatosFrescos = false;     // já chegou lista nova da nuvem nesta sessão
  const marcasGuardadas = new Map();
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
    setTimeout(() => { guardarEstilosDosTemas().catch(() => {}); }, 2500);
    C.mapaPronto(() => {
      const urls = new Set([C.mapaEstiloUrl]);
      const fontes = (C.mapa.getStyle() || {}).sources || {};
      for (const id of Object.keys(fontes)) if (typeof fontes[id].url === "string") urls.add(fontes[id].url);
      for (const u of urls) if (u && O.classificarUrl(u)) fetch(u, { mode: "cors" }).catch(() => {});
    });
  }
  // Os DOIS estilos do mapa (claro e escuro: JSON, TileJSON, sprite e glifos) ficam guardados no cache do mapa quando há internet,
  // para trocar o tema sem internet (ui/mapa.js busca o JSON do estilo novo antes de trocar). Só o estilo em uso passava pelo
  // service worker; o do outro tema nunca era pedido. Roda ao abrir (uma vez por dia, ou se faltar algum) e junto do download do
  // corredor da rota. Devolve true se os dois ficaram guardados.
  const CHAVE_ESTILOS = "copiloto.e3.estilos.v1";
  const ESTILOS_RENOVAR_MS = 24 * 3600e3;
  let guardandoEstilos = null;
  async function estilosPrecisamDeGuarda(est) {
    const o = ler(CHAVE_ESTILOS);
    if (!o || !(Date.now() - o.em < ESTILOS_RENOVAR_MS)) return true;
    for (const url of Object.values(C.tema.ESTILOS)) if (!(await est.match(url))) return true;
    return false;
  }
  function guardarEstilosDosTemas(deveParar, forcar) {
    if (guardandoEstilos) return guardandoEstilos;
    guardandoEstilos = (async () => {
      if (!online() || !("caches" in window) || !C.tema || !C.tema.ESTILOS) return false;
      let est;
      try { est = await caches.open(CACHE_ESTILO); } catch (e) { return false; }
      if (!forcar && !(await estilosPrecisamDeGuarda(est))) return true;
      let tudo = true;
      for (const url of Object.values(C.tema.ESTILOS)) {
        if (deveParar && deveParar()) return false;
        try {
          const resp = await fetch(url, { cache: "no-store", mode: "cors" });
          if (!resp.ok) { tudo = false; continue; }
          const json = await resp.clone().json();
          await est.put(url, await carimbar(resp));
          const extras = Object.values((json && json.sources) || {}).map((f) => f && f.url).filter((u) => typeof u === "string");
          for (const u of extras.concat(O.recursosDoEstilo(json, url))) {
            if (deveParar && deveParar()) return false;
            if (!O.classificarUrl(u)) continue;
            if (await est.match(u)) continue;
            try { const r = await fetch(u, { cache: "no-store", mode: "cors" }); if (r.ok) await est.put(u, await carimbar(r)); else tudo = false; } catch (e) { tudo = false; }
          }
        } catch (e) { tudo = false; }
      }
      if (tudo) gravar(CHAVE_ESTILOS, { em: Date.now() });
      return tudo;
    })().finally(() => { guardandoEstilos = null; });
    return guardandoEstilos;
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
  function mapaDaRotaAtual() { return corredorDaRota(rotaGuardada); }
  function estadoAtual() {
    const m = mapaDaRotaAtual();
    return {
      online: online(), agora: Date.now(), logado: C.nuvem.logado(),
      relatosEm: relatosGuardados && C.nuvem.logado() ? relatosGuardados.salvoEm : null,
      rota: !!rotaGuardada,
      mapa: m ? { em: m.em, completo: m.completo, pct: m.total ? (100 * m.baixados) / m.total : 0 } : null,
      baixando: download ? Math.max(0, Math.min(99, download.pct || 0)) : null, // download automático do mapa da rota (em segundo plano)
    };
  }
  let ultimoTexto = null;
  // A faixa só aparece quando há o que dizer: sem internet, falha ao guardar (pouco espaço) ou baixando o mapa da rota.
  // Online e tudo em dia ("Online · mapa da rota baixado às 14:10"), nada na tela.
  function atualizarFaixa() {
    const f = $("e3-estado"); if (!f) return;
    const e = estadoAtual();
    const texto = O.textoEstado(e);
    const mostrar = !e.online || !!falhaGravar || e.baixando != null;
    if (f.hidden === mostrar) f.hidden = !mostrar;
    if (f.textContent !== texto) f.textContent = texto;
    f.classList.toggle("sem-internet", !e.online);
    f.classList.toggle("com-falha", e.online && !!falhaGravar);
    f.setAttribute("aria-label", texto + ". Toque para detalhes.");
    $("e3-aviso-conta").hidden = e.online;
    if (texto !== ultimoTexto) { ultimoTexto = texto; C.emit("offline:estado", { online: e.online, texto }); }
  }

  function abrirDetalhes() {
    const e = estadoAtual();
    // Lote 4: cartão de estado (texto curto: o que acontece e o que continua funcionando)
    const itens = [];
    if (C.estados) itens.push(C.estados.montar(e.online
      ? { id: "e3-cartao-estado", tipo: "info", icone: "wifi", titulo: "Com internet", texto: "Relatos, rotas e endereços funcionam." }
      : { id: "e3-cartao-estado", tipo: "atencao", icone: "wifi", titulo: "Sem internet", texto: "O mapa e a rota guardados continuam. Relato novo espera a internet." }));
    else itens.push(el("h2", null, e.online ? "Com internet" : "Sem internet"));
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
    atualizarFaixa();
    // mapa do corredor: baixa sozinho em segundo plano (mesma rota pronta não baixa de novo; rota nova cancela a anterior)
    if (download && download.rotaId !== rotaGuardada.salvoEm) pararDownload("trocou");
    agendarCorredor();
  }
  function esquecerRota() {
    rotaGuardada = null; rotaDestaSessao = false;
    gravar(CHAVE_ROTA, null);
    pararDownload("limpa"); // o que já baixou fica (mapa guardado, sai pela validade ou com pouco espaço)
    apagarDesenhoRota(); atualizarFaixa();
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
    desenharRotaGuardada(); atualizarFaixa();
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
    b.append(botao("Esquecer rota", "btn", () => { esquecerRota(); C.folha.fechar(); }), botao("Fechar", "btn", C.folha.fechar));
    const m = mapaDaRotaAtual();
    const itens = [
      el("h2", "e3-titulo-rota", "Rota guardada" + (r.perfilNome ? " · " + r.perfilNome : "")),
      el("div", "grande", resumo),
      el("p", null, "Traçada " + O.formatarIdade(Date.now() - r.salvoEm) + " (" + O.formatarHora(r.salvoEm) + "). " +
        (online() ? "Para atualizar, trace de novo." : "Sem internet: dá para seguir esta rota; rota nova só com internet.")),
    ];
    if (m && m.completo) itens.push(el("p", null, "Mapa do caminho guardado às " + O.formatarHora(m.em) + "."));
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

  // ------------------------------------------------------------ mapa da rota em cache automático (corredor)
  // Sem botão: ao traçar uma rota (evento "rota"), o corredor dela é baixado sozinho, em segundo plano, para um cache
  // próprio (O.nomeCacheCorredor(id), id = salvoEm da rota guardada). Não baixa de novo o que está pronto e valendo
  // (30 dias, O.CORREDOR_VALIDADE_MS); rota trocada cancela o download em andamento; sem internet não tenta (volta a
  // tentar no evento "online"); com dados móveis segue normal. Antes de baixar, limpa os corredores vencidos e, com
  // pouco espaço (O.LIMIAR_ESPACO: livre < 15 % da cota ou < 200 MB), os mais antigos, nunca o da rota ativa.
  // Pede navigator.storage.persist() uma vez, no primeiro download. Aviso só em erro relevante (sem espaço).
  const PARALELO = 4; // 4 pedidos de cada vez: não disputa com o mapa nem trava a tela
  const ESPERA_REDE_MS = 2 * 60e3, TENTATIVAS_REDE = 3;
  let download = null;            // { id, rotaId, parar, motivo, feitos, total, pct, bytes, fim (Promise) }
  let timerAgenda = null, timerRede = null, tentativasRede = 0, avisouEspacoDe = null, esperandoMapa = false;

  // Registro dos corredores (localStorage). Lê também o formato antigo (um corredor só, cache "copiloto-mapa-rota").
  function corredores() {
    const lista = (Array.isArray(ler(CHAVE_MAPAS)) ? ler(CHAVE_MAPAS) : []).filter((c) => c && c.id != null);
    const antigo = ler(CHAVE_MAPA);
    if (antigo && antigo.rotaId != null && !lista.some((c) => c.cache === O.CACHE_CORREDOR)) {
      const em = antigo.em || antigo.iniciado || Date.now();
      lista.push({ id: "antigo-" + antigo.rotaId, cache: O.CACHE_CORREDOR, rotaId: antigo.rotaId, destino: null, iniciado: antigo.iniciado || em,
        em: antigo.em || null, validoAte: em + O.CORREDOR_VALIDADE_MS, completo: !!antigo.completo, total: antigo.total || 0,
        baixados: antigo.baixados || 0, bytes: antigo.bytes || 0 });
    }
    return lista;
  }
  function gravarCorredores(lista) {
    const novos = lista.filter((c) => c.cache !== O.CACHE_CORREDOR);
    const antigo = lista.find((c) => c.cache === O.CACHE_CORREDOR);
    if (!antigo) gravar(CHAVE_MAPA, null);
    else gravar(CHAVE_MAPA, { rotaId: antigo.rotaId, total: antigo.total, baixados: antigo.baixados, bytes: antigo.bytes, em: antigo.em, completo: antigo.completo, iniciado: antigo.iniciado });
    gravar(CHAVE_MAPAS, novos);
  }
  function salvarCorredor(c) {
    const lista = corredores().filter((x) => String(x.id) !== String(c.id));
    lista.push(c); gravarCorredores(lista);
  }
  function corredorDaRota(r) {
    if (!r) return null;
    return corredores().find((c) => c.rotaId === r.salvoEm && c.cache !== O.CACHE_CORREDOR) ||
      corredores().find((c) => c.rotaId === r.salvoEm) || null;
  }
  async function removerCorredor(id) {
    const c = corredores().find((x) => String(x.id) === String(id)); if (!c) return;
    try { await caches.delete(c.cache); } catch (e) { /* segue */ }
    gravarCorredores(corredores().filter((x) => String(x.id) !== String(id)));
  }

  // Modelo do endereço dos blocos ({z}/{x}/{y}) e zoom máximo da fonte vetorial do estilo carregado.
  function fonteDeBlocos() {
    const m = C.mapa; if (!m) return null;
    let estilo;
    try { estilo = m.getStyle(); } catch (e) { return null; }
    if (!estilo) return null;
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
  // Pede uma vez só (o iPhone instalado na tela de início costuma aceitar sem perguntar)
  async function pedirPersistenciaUmaVez() {
    if (ler(CHAVE_PERSIST)) return;
    gravar(CHAVE_PERSIST, { pedidoEm: Date.now() });
    try {
      if (!navigator.storage || !navigator.storage.persist) return;
      if (navigator.storage.persisted && await navigator.storage.persisted()) return;
      await navigator.storage.persist();
    } catch (e) { /* o aparelho decide */ }
  }

  // Espera curta: vários "rota" seguidos (recálculo) viram um download só
  function agendarCorredor(ms) {
    clearTimeout(timerAgenda);
    timerAgenda = setTimeout(() => { garantirCorredor().catch(() => {}); }, ms == null ? 400 : ms);
  }
  function pararDownload(motivo) { if (download) { download.parar = true; download.motivo = download.motivo || motivo; } }

  // Uma conferência por vez (início, "rota", "online" podem chegar juntos); a que chegar no meio roda depois.
  let garantindo = false, deNovo = false;
  async function garantirCorredor() {
    if (garantindo) { deNovo = true; return; }
    garantindo = true;
    try { await garantirAgora(); } finally {
      garantindo = false;
      if (deNovo) { deNovo = false; agendarCorredor(0); }
    }
  }
  async function garantirAgora() {
    const r = rotaGuardada;
    if (!r || !Array.isArray(r.coords) || r.coords.length < 2) return;
    if (!online() || !("caches" in window)) return;
    const reg = corredorDaRota(r);
    const id = reg ? String(reg.id) : String(r.salvoEm);
    if (download) {
      if (download.rotaId === r.salvoEm) return; // já baixando esta rota
      pararDownload("trocou");
      await download.fim; // (o download em andamento não segura a trava: ele roda fora do garantir)
      if (!rotaGuardada || rotaGuardada.salvoEm !== r.salvoEm) return; // outra rota chegou enquanto esperava: ela agenda o próprio download
    }
    if (reg && O.corredorPronto(reg, Date.now())) return; // pronto e valendo: não baixa de novo
    const fonte = fonteDeBlocos();
    if (!fonte) {
      // estilo ainda carregando: tenta quando o mapa ficar pronto (sem fonte vetorial no estilo, não há o que baixar)
      if (!esperandoMapa) { esperandoMapa = true; C.mapaPronto(() => { esperandoMapa = false; if (fonteDeBlocos()) agendarCorredor(0); }); }
      return;
    }
    const plano = O.planejarCorredor(r.coords, { zMax: Math.min(14, fonte.maxzoom) });
    // corredor vencido da rota ativa: começa do zero (blocos velhos saem)
    let atual = reg;
    if (atual && O.corredorVencido(atual, Date.now()) && atual.completo) { await removerCorredor(atual.id); atual = null; }
    const falta = atual ? Math.max(0, plano.bytes * (1 - (atual.baixados || 0) / Math.max(1, plano.total))) : plano.bytes;
    const limpeza = O.planejarLimpeza(corredores(), { agora: Date.now(), ativo: atual ? atual.id : id, estimativa: await espacoLivre(), bytesNovo: falta });
    for (const x of limpeza.remover) await removerCorredor(x);
    if (!rotaGuardada || rotaGuardada.salvoEm !== r.salvoEm || download) return;
    if (!limpeza.cabe) { avisarEspaco(r); return; }
    pedirPersistenciaUmaVez();
    baixarCorredor(r, atual, plano, fonte).catch(() => {}); // em segundo plano: a trava sai já, a troca de rota pode cancelar
  }

  // Corredores vencidos (30 dias) saem ao abrir o app, menos o da rota ativa (esse é renovado com internet)
  async function limparVencidos() {
    if (!("caches" in window)) return;
    const ativo = corredorDaRota(rotaGuardada);
    for (const c of corredores()) if (O.corredorVencido(c, Date.now()) && (!ativo || String(c.id) !== String(ativo.id))) await removerCorredor(c.id);
  }

  function avisarEspaco(r) {
    if (avisouEspacoDe === r.salvoEm) return;
    avisouEspacoDe = r.salvoEm;
    falhaGravar = "Pouco espaço no aparelho: o mapa desta rota não foi guardado para usar sem internet.";
    C.mensagem(falhaGravar, 7000);
    atualizarFaixa();
  }

  async function baixarCorredor(r, reg, plano, fonte) {
    const agora = Date.now();
    const meta = reg ? Object.assign({}, reg, { total: plano.total }) : {
      id: String(r.salvoEm), cache: O.nomeCacheCorredor(r.salvoEm), rotaId: r.salvoEm, destino: O.chaveDestino(r),
      iniciado: agora, em: null, validoAte: agora + O.CORREDOR_VALIDADE_MS, completo: false, total: plano.total, baixados: 0, bytes: 0,
    };
    salvarCorredor(meta);
    let soltar;
    // marcado já (antes de qualquer espera): outra conferência vê que esta rota está baixando
    const d = download = { id: meta.id, rotaId: r.salvoEm, parar: false, motivo: null, feitos: 0, total: plano.total, pct: 0, bytes: 0,
      fim: new Promise((ok) => { soltar = ok; }) };
    atualizarFaixa();
    try {
      const cacheRota = await caches.open(meta.cache);
      // fontes e sprites do estilo (para os nomes das ruas aparecerem sem internet)
      try {
        const est = await caches.open(CACHE_ESTILO);
        const extras = [C.mapaEstiloUrl].concat(Object.values(fonte.estilo.sources || {}).map((f) => f.url))
          .filter((u) => typeof u === "string" && O.classificarUrl(u));
        for (const u of extras.concat(O.recursosDoEstilo(fonte.estilo, fonte.modelo))) {
          if (d.parar) break;
          if (await est.match(u)) continue;
          try { const resp = await fetch(u, { cache: "no-store", mode: "cors" }); if (resp.ok) await est.put(u, await carimbar(resp)); } catch (e) { /* segue */ }
        }
      } catch (e) { /* sem Cache Storage para o estilo: segue com os blocos */ }
      // os dois temas ficam guardados junto do corredor (trocar claro × escuro no meio da rota, sem internet)
      try { await guardarEstilosDosTemas(() => d.parar); } catch (e) { /* segue com os blocos */ }

      let seguidas = 0, ultimaGravacao = 0;
      const fila = plano.blocos.slice();
      const trabalhador = async () => {
        while (!d.parar && fila.length) {
          if (!online()) { d.parar = true; d.motivo = d.motivo || "rede"; break; }
          const b = fila.shift();
          const url = O.urlBloco(fonte.modelo, b);
          const chave = O.chaveBloco(url) || url;
          try {
            if (!(await cacheRota.match(chave))) {
              // já guardado em outro cache (mapa visto ou corredor anterior) e recente: copia, sem ir à rede
              const outro = await caches.match(chave);
              if (outro && idadeMs(outro) < 7 * 24 * 3600e3) {
                d.bytes += Number(outro.headers.get("x-copiloto-bytes")) || 0;
                await cacheRota.put(chave, outro);
              } else {
                const resp = await fetch(url, { cache: "no-store", mode: "cors" });
                if (resp.ok) {
                  const c = await carimbar(resp);
                  d.bytes += Number(c.headers.get("x-copiloto-bytes")) || 0;
                  await cacheRota.put(chave, c);
                } else if (resp.status !== 404 && resp.status !== 204) { // 404/204: mar ou área sem dado
                  if (++seguidas >= FALHAS_SEGUIDAS_PARA_PARAR) { d.parar = true; d.motivo = d.motivo || "rede"; break; }
                  fila.push(b); continue;
                }
              }
            }
            seguidas = 0;
          } catch (e) {
            if (e && e.name === "QuotaExceededError") { d.parar = true; d.motivo = "espaco"; break; }
            if (++seguidas >= FALHAS_SEGUIDAS_PARA_PARAR || !online()) { d.parar = true; d.motivo = d.motivo || "rede"; break; }
            fila.push(b); // tenta este bloco de novo mais tarde
            continue;
          }
          d.feitos++;
          d.pct = (100 * d.feitos) / d.total;
          if (Date.now() - ultimaGravacao > 1000) {
            ultimaGravacao = Date.now();
            meta.baixados = Math.max(meta.baixados || 0, d.feitos); meta.bytes = (reg ? reg.bytes || 0 : 0) + d.bytes;
            salvarCorredor(meta);
            atualizarFaixa();
          }
        }
      };
      await Promise.all(Array.from({ length: PARALELO }, trabalhador));
      meta.baixados = d.feitos; meta.bytes = (reg ? reg.bytes || 0 : 0) + d.bytes;
      meta.completo = d.feitos >= d.total;
      if (meta.completo) { meta.em = Date.now(); meta.validoAte = meta.em + O.CORREDOR_VALIDADE_MS; }
      // rota limpa no meio do download: o pedaço baixado fica (vale como mapa guardado), mas não é mais o ativo
      if (corredores().some((c) => String(c.id) === String(meta.id))) salvarCorredor(meta);
      if (meta.completo) {
        tentativasRede = 0;
        // recálculo da mesma viagem: os corredores anteriores com o mesmo destino saem (não duplica o mapa)
        const ativo = corredorDaRota(rotaGuardada);
        for (const x of O.corredoresSubstituidos(corredores(), meta)) if (!ativo || String(x) !== String(ativo.id)) await removerCorredor(x);
      } else if (d.motivo === "espaco") avisarEspaco(r);
      else if (d.motivo === "rede" && online() && tentativasRede < TENTATIVAS_REDE) {
        // servidor do mapa falhando com internet: tenta de novo daqui a pouco (sem internet, espera o "online")
        tentativasRede++;
        clearTimeout(timerRede); timerRede = setTimeout(() => agendarCorredor(0), ESPERA_REDE_MS);
      }
    } finally {
      if (download === d) download = null;
      soltar();
      atualizarFaixa();
    }
  }
  function idadeMs(resp) { const t = Number(resp.headers.get("x-copiloto-em")); return isFinite(t) && t > 0 ? Date.now() - t : Infinity; }
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
    guardarEstilosDosTemas,
    mapaBaixado: () => mapaDaRotaAtual(), baixando: () => (download ? { feitos: download.feitos, total: download.total, rotaId: download.rotaId } : null),
    // corredores guardados (mapa das rotas em cache automático; o da rota ativa nunca é apagado)
    corredores: () => corredores(),
    // "Limpar rota" da última rota e do resumo de chegada
    esquecerRota,
    // chegada: a rota vira "última rota" (30 dias) em vez de ser esquecida; a navegação confere a rota com a internet
    marcarUltima, ultimaRota, marcarConferida, abrirRotaGuardada: folhaRotaGuardada,
  };

  C.aoIniciar(() => {
    C.carregarEstilo("estilos/offline.css");
    const faixa = el("button", "e3-estado"); faixa.type = "button"; faixa.id = "e3-estado"; faixa.hidden = true;
    faixa.addEventListener("click", abrirDetalhes);
    document.querySelector(".aviso").after(faixa);
    const avisoConta = el("p", "e3-aviso-conta", "Sem internet: entrar na conta ou criar conta precisa de internet.");
    avisoConta.id = "e3-aviso-conta"; avisoConta.hidden = true;
    const tc = $("tela-conta"); if (tc) tc.insertBefore(avisoConta, tc.querySelector("h1").nextSibling);

    // dados guardados
    // M5: a gravada vem sem as coordenadas (só a polyline): decodifica aqui (aceita também o formato antigo, com coords)
    rotaGuardada = O.rotaDeGuardada(ler(CHAVE_ROTA), window.CopilotoRota && window.CopilotoRota.decodificarPolyline6);
    gravadaSemManobras = !!(rotaGuardada && rotaGuardada.semManobras);
    // última rota vencida (mais de 30 dias da chegada): esquecida
    if (rotaGuardada && rotaGuardada.ultima && !O.ultimaValida(rotaGuardada, Date.now())) { rotaGuardada = null; gravar(CHAVE_ROTA, null); }
    relatosGuardados = ler(CHAVE_RELATOS);
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
    // mapa da rota guardada: completa ou renova o corredor sozinho (com internet), e tira os corredores vencidos
    C.mapaPronto(() => setTimeout(() => {
      limparVencidos().catch(() => {});
      if (rotaGuardada) agendarCorredor(0);
    }, 1500));

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
    const btnDestino = $("btn-destino");
    if (btnDestino) btnDestino.addEventListener("click", () => {
      if (!online() && btnDestino.getAttribute("aria-pressed") === "true")
        C.mensagem("Sem internet: rota nova precisa de internet. Você ainda pode marcar o destino no mapa.", 7000);
    });

    window.addEventListener("online", () => { atualizarFaixa(); C.mensagem("Internet de volta.", 4000); tentativasRede = 0; agendarCorredor(1000); setTimeout(() => { guardarEstilosDosTemas().catch(() => {}); }, 3000); });
    window.addEventListener("offline", () => {
      pararDownload("rede");
      atualizarFaixa();
      C.mensagem("Sem internet. A rota e os relatos guardados continuam; rota nova e relatos novos esperam a conexão.", 8000);
    });
    setInterval(() => { atualizarFaixa(); if (!relatosFrescos) desenharRelatosGuardados(); }, 30000);
    atualizarFaixa();
    registrarSW();
  });
})(window.Copiloto);
