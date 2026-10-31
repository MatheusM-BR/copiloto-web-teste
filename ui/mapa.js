// Mapa (MapLibre): criação, modo "seguir minha posição", erro de carregamento e clique.
// Expõe Copiloto.mapa, Copiloto.mapaPronto(fn), Copiloto.seguir(v), Copiloto.seguindo(), Copiloto.mapaModo(modo?)
// ("simples" | "completo") e Copiloto.orientacao(modo?) ("norte" | "rumo").
// Emite "mapa-clique" ({ lngLat }).
// Também cuida de:
//  - A1: a coluna de botões redondos fica sempre no espaço livre do mapa, abaixo do painel de navegação e do alerta
//    (em uma, duas ou três colunas, conforme a altura), sem nada por cima e sem cobrir a atribuição nem a velocidade;
//  - A4/M5: o app é para o celular em pé (manifest "portrait", que o iOS ignora); deitado (tela baixa), uma faixa no alto
//    pede "Use o celular em pé" sem tapar SOS, alerta nem botões (estilos/base.css);
//  - B4: o mapa não gira nem inclina pelo TOQUE (sem a bússola do MapLibre); quem gira é o "rumo para cima";
//  - câmera (mapa iOS): a cada leitura, seguindo, easeTo linear com a duração da animação da marca (ui/gps.js), e:
//      "rumo para cima" (padrão ao navegar): bearing = rumo suavizado (só com rumo confiável), inclinação 45°, veículo
//      no terço inferior (câmera à frente), zoom pela velocidade navegando (a pinça soma um ajuste do motorista);
//      "norte para cima": bearing 0, sem inclinação. O botão de orientação (#btn-orientacao) alterna os dois.
//    Pinça/roda com o "seguir" ligado: zoom em volta do veículo (around: "center"); arrasto desliga o "seguir";
//  - Recentralizar (#btn-recentralizar): pílula visível só sem o "seguir" e com GPS. Volta automática só navegando,
//    15 s depois do FIM da interação (sem dedo na tela e depois da inércia), adiada por novo toque/roda; na hora, com
//    manobra a ≤ 300 m, alerta aberto ou o veículo saindo da área visível (estava na tela quando o motorista soltou);
//  - NAV-05: comando de voz "mapa simples"/"mapa completo" (comando:mapa-modo). Simples esconde postos, relatos guardados
//    e os pontos de interesse do mapa base; rota, alertas e relatos ativos continuam. Fica guardado (copiloto.mapa.modo.v1).
(function (C) {
  "use strict";
  const { $, el } = C.util;
  const ESTILO = "https://tiles.openfreemap.org/styles/liberty"; // gratuito, sem chave
  const CHAVE_MODO = "copiloto.mapa.modo.v1";
  let seguindo = false, avisouErro = false, avisouSemRede = 0;
  let modo = (C.util.lerJSON(CHAVE_MODO, null) || {}).modo === "simples" ? "simples" : "completo";

  // ------------------------------------------------------------ seguir, orientação e câmera
  const VOLTA_SEGUIR_MS = 15000, MANOBRA_PERTO_M = 300, PITCH_RUMO = 45;
  const linear = (t) => t;
  let orientacao = "norte";             // "norte" | "rumo"
  let navAntes = false, manobraM = null;
  let zoomAlvo = null, deltaZoomUsuario = 0, zoomSeguir = null;
  let dedos = 0, mouseApertado = false, gestoAtivo = false, panDesligadoPorPinca = false;
  let timerVolta = null, visivelNoFim = true;

  function navegando() { try { return !!(C.navegacao && C.navegacao.ativa && C.navegacao.ativa()); } catch (e) { return false; } }
  function usuarioMexendo() { return dedos > 0 || mouseApertado || gestoAtivo; }

  function definirSeguir(v) {
    verificarNav();
    seguindo = !!v;
    cancelarVolta();
    atualizarBotoes();
    ajustarGestos();
    const pos = C.estado.ultimaPos;
    if (seguindo && pos && C.mapa) {
      if (!navegando()) zoomSeguir = Math.max(C.mapa.getZoom(), 15);
      moverCamera(pos, 600);
    }
  }

  // pinça e roda com o "seguir": zoom em volta do veículo (o centro, com o padding, é ele)
  function ajustarGestos() {
    const m = C.mapa; if (!m) return;
    const op = seguindo ? { around: "center" } : undefined;
    try { if (m.touchZoomRotate.isEnabled()) m.touchZoomRotate.enable(op); } catch (e) { /* ignora */ }
    try { if (m.scrollZoom.isEnabled()) m.scrollZoom.enable(op); } catch (e) { /* ignora */ }
  }

  // até onde vai, de cima, o que cobre o mapa (painel de navegação, faixa do alerta)
  function topoOcupado() {
    const mr = C.mapa.getContainer().getBoundingClientRect();
    let fim = 0;
    for (const id of ["nav-painel", "alerta"]) {
      const e = $(id); if (!visivel(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.height > 0 && r.top < mr.top + mr.height / 2) fim = Math.max(fim, r.bottom - mr.top);
    }
    return Math.max(0, fim);
  }
  function zoomPorVelocidade() {
    const g = C.estado.gps;
    const v = g ? (g.kmh != null ? g.kmh : g.velKmh) : null;
    if (v == null) return zoomAlvo;
    const z = Math.round((17 - Math.min(1, Math.max(0, (v - 20) / 70)) * 2) * 4) / 4; // 17 até 20 km/h … 15 a 90 km/h
    if (zoomAlvo == null || Math.abs(z - zoomAlvo) >= 0.5) zoomAlvo = z;
    return zoomAlvo;
  }
  // Onde o veículo fica na tela no "rumo para cima" (px do mapa): ~72% da altura, no meio; se ali houver botão
  // (coluna de botões, Recentralizar, velocímetro), sobe até logo acima dele (não passa do meio da área livre) ou,
  // sem jeito, vai para a esquerda das colunas de botões.
  function lugarDoVeiculo(W, H, topo) {
    const mr = C.mapa.getContainer().getBoundingClientRect(), R = 28;
    const obst = retangulos(".acoes > *, .painel-mapa > .btn-recentralizar, .painel-mapa > .velocidade, .maplibregl-ctrl-bottom-right > *, .maplibregl-ctrl-bottom-left > *")
      .map((r) => ({ l: r.left - mr.left, r: r.right - mr.left, t: r.top - mr.top, b: r.bottom - mr.top }));
    const minY = topo + R + 4;
    const colide = (x, y) => y < minY || obst.some((o) => x + R > o.l && x - R < o.r && y + R > o.t && y - R < o.b);
    const piso = topo + (H - topo) * 0.5;
    const x = W / 2, y = Math.max(H * 0.72, Math.min(minY, H - R));
    if (!colide(x, y)) return { x, y };
    let yy = y;
    for (const o of obst) if (x + R > o.l && x - R < o.r && o.t < yy + R) yy = Math.min(yy, o.t - R - 4);
    if (yy >= piso && !colide(x, yy)) return { x, y: yy };
    const direita = obst.filter((o) => o.l > W * 0.3);
    const x2 = direita.length ? Math.min.apply(null, direita.map((o) => o.l)) / 2 : x;
    for (const y2 of [y, H * 0.62, piso]) if (x2 > R + 8 && !colide(x2, y2)) return { x: x2, y: y2 };
    // tela pequena demais (iPhone SE 320×568 navegando): o ponto mais baixo em que ao menos o meio da seta fique à vista
    for (const r of [14, 4]) for (const xx of [x, x2]) for (let y3 = H * 0.72; y3 >= topo + r + 2; y3 -= 4) {
      if (!obst.some((o) => xx + r > o.l && xx - r < o.r && y3 + r > o.t && y3 - r < o.b)) return { x: xx, y: y3 };
    }
    return { x, y: Math.min(H - R, Math.max(minY, Math.min(piso, yy))) };
  }
  function opcoesCamera(pos, dur) {
    const m = C.mapa, H = m.getContainer().clientHeight || 1;
    const o = { center: pos, duration: dur, easing: linear };
    const topo = topoOcupado();
    if (orientacao === "rumo") {
      const r = C.gps && C.gps.rumo ? C.gps.rumo() : null;
      if (r && r.confiavel && r.graus != null) o.bearing = r.graus; // sem rumo confiável, o mapa não gira
      o.pitch = PITCH_RUMO;
      // câmera à frente: o veículo fica no terço inferior, sem ficar embaixo de botão (ver lugarDoVeiculo)
      const W = m.getContainer().clientWidth || 1, a = lugarDoVeiculo(W, H, topo);
      const top = Math.max(topo + 16, 2 * a.y - H), right = Math.max(0, W - 2 * a.x);
      o.padding = { top, bottom: top + H - 2 * a.y, left: 0, right };
    } else {
      o.bearing = 0; o.pitch = 0;
      o.padding = { top: topo ? Math.min(H * 0.5, topo + 16) : 0, bottom: 0, left: 0, right: 0 };
    }
    if (navegando()) {
      const z = zoomPorVelocidade();
      if (z != null) o.zoom = Math.min(19, Math.max(11, z + deltaZoomUsuario));
    } else if (zoomSeguir != null) {
      o.zoom = zoomSeguir;
      if (Math.abs(m.getZoom() - zoomSeguir) < 0.01) zoomSeguir = null;
    }
    return o;
  }
  function moverCamera(pos, dur) {
    if (!C.mapa || !pos) return;
    try { C.mapa.easeTo(opcoesCamera(pos, dur)); } catch (e) { /* mapa ainda sem estilo */ }
  }

  function verificarNav() {
    const n = navegando();
    if (n === navAntes) return;
    navAntes = n; deltaZoomUsuario = 0; zoomAlvo = null; manobraM = null;
    orientacao = n ? "rumo" : "norte"; // rumo para cima é o padrão ao navegar
    if (!n) {
      cancelarVolta();
      if (C.mapa) C.mapa.easeTo({ bearing: 0, pitch: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
    }
    atualizarBotoes();
  }

  function alternarOrientacao() {
    orientacao = orientacao === "rumo" ? "norte" : "rumo";
    atualizarBotoes();
    if (seguindo) moverCamera(C.estado.ultimaPos, 600); else definirSeguir(true);
    C.mensagem(orientacao === "rumo" ? "Rumo para cima." : "Norte para cima.", 2500);
  }
  function orientacaoPublica(novo) {
    if ((novo === "norte" || novo === "rumo") && novo !== orientacao) {
      orientacao = novo; atualizarBotoes();
      if (seguindo) moverCamera(C.estado.ultimaPos, 600);
    }
    return orientacao;
  }

  function atualizarBotoes() {
    const bo = $("btn-orientacao");
    if (bo) {
      const rumo = orientacao === "rumo";
      bo.setAttribute("aria-pressed", String(rumo));
      bo.setAttribute("aria-label", rumo ? "Rumo para cima. Tocar para norte para cima" : "Norte para cima. Tocar para rumo para cima");
      bo.dataset.orientacao = orientacao;
      const r = bo.querySelector(".orient-rotulo"); if (r && r.textContent !== (rumo ? "Rumo" : "Norte")) r.textContent = rumo ? "Rumo" : "Norte";
    }
    const br = $("btn-recentralizar");
    if (br) {
      const ver = !seguindo && !!C.estado.gps && !!C.estado.ultimaPos;
      if (br.hidden === ver) br.hidden = !ver;
    }
  }
  function girarIcone() {
    const i = document.querySelector("#btn-orientacao .orient-icone");
    if (i && C.mapa) i.style.transform = "rotate(" + (-C.mapa.getBearing()).toFixed(1) + "deg)";
  }

  // ---------- volta automática ao "seguir" (só navegando)
  function cancelarVolta() { clearTimeout(timerVolta); timerVolta = null; }
  function veiculoVisivel() {
    const pos = (C.gps && C.gps.posicaoExibida && C.gps.posicaoExibida()) || C.estado.ultimaPos;
    if (!pos || !C.mapa) return false;
    const p = C.mapa.project(pos), c = C.mapa.getContainer();
    return p.x >= 0 && p.y >= 0 && p.x <= c.clientWidth && p.y <= c.clientHeight;
  }
  function iniciarVolta() {
    cancelarVolta();
    if (seguindo || !navegando() || usuarioMexendo()) return;
    visivelNoFim = veiculoVisivel();
    timerVolta = setTimeout(() => {
      timerVolta = null;
      if (!seguindo && navegando() && !usuarioMexendo()) definirSeguir(true);
    }, VOLTA_SEGUIR_MS);
    checarVoltaImediata();
  }
  function adiarVolta() { if (timerVolta) iniciarVolta(); }
  // fim da interação: sem dedo na tela e o mapa parado (o moveend da inércia termina o gesto)
  function fimInteracao() {
    if (dedos > 0 || mouseApertado) return;
    if (gestoAtivo && C.mapa && C.mapa.isMoving()) return;
    gestoAtivo = false;
    iniciarVolta();
  }
  function checarVoltaImediata() {
    if (seguindo || !navegando() || usuarioMexendo() || !C.estado.ultimaPos) return;
    const manobra = manobraM != null && manobraM <= MANOBRA_PERTO_M;
    const alerta = !!(C.alerta && C.alerta.atual && C.alerta.atual());
    const saiu = visivelNoFim && !veiculoVisivel();
    if (manobra || alerta || saiu) definirSeguir(true);
  }

  function aoPosicao(gps) {
    verificarNav();
    atualizarBotoes();
    if (!C.mapa || !gps) return;
    if (!seguindo) { checarVoltaImediata(); return; }
    if (usuarioMexendo()) return; // pinça em andamento: a câmera espera o dedo sair
    moverCamera([gps.lon, gps.lat], C.gps && C.gps.duracaoAnimMs ? C.gps.duracaoAnimMs() : 900);
  }

  function ligarGestos(mapa) {
    const cont = mapa.getContainer();
    const op = { capture: true, passive: true };
    cont.addEventListener("touchstart", (e) => {
      dedos = e.touches.length; cancelarVolta();
      // pinça com o "seguir": sem arrastar junto (o meio dos dois dedos andando tiraria o veículo do lugar)
      if (seguindo && dedos >= 2 && mapa.dragPan.isEnabled()) { mapa.dragPan.disable(); panDesligadoPorPinca = true; }
    }, op);
    const fimToque = (e) => {
      dedos = e.touches.length;
      if (dedos) return;
      if (panDesligadoPorPinca) { panDesligadoPorPinca = false; mapa.dragPan.enable(); }
      fimInteracao();
    };
    cont.addEventListener("touchend", fimToque, op);
    cont.addEventListener("touchcancel", fimToque, op);
    cont.addEventListener("touchmove", (e) => { dedos = e.touches.length; adiarVolta(); }, op);
    cont.addEventListener("wheel", adiarVolta, op);
    cont.addEventListener("mousedown", () => { mouseApertado = true; cancelarVolta(); }, op);
    window.addEventListener("mouseup", () => { if (mouseApertado) { mouseApertado = false; fimInteracao(); } }, true);
    mapa.on("movestart", (e) => {
      const oe = e.originalEvent;
      if (!oe) return; // câmera do app (easeTo, fitBounds)
      gestoAtivo = true;
      const soZoom = oe.type === "wheel" || (oe.touches && oe.touches.length >= 2) || dedos >= 2;
      if (seguindo && soZoom) { zoomSeguir = null; return; } // pinça/roda: zoom em volta do veículo, continua seguindo
      if (seguindo) definirSeguir(false); // arrasto
    });
    mapa.on("moveend", () => {
      if (!gestoAtivo || dedos > 0 || mouseApertado) return;
      gestoAtivo = false;
      if (seguindo && navegando() && zoomAlvo != null) deltaZoomUsuario = Math.max(-4, Math.min(4, mapa.getZoom() - zoomAlvo));
      iniciarVolta();
    });
    mapa.on("rotate", girarIcone);
  }

  // Roda fn quando o estilo do mapa estiver carregado (para addSource/addLayer).
  // Depois do primeiro "load", roda na hora. Não dá para confiar só em isStyleLoaded(): ele volta a ser false enquanto
  // uma fonte nova carrega (ex.: a camada de postos do E2), e aí once("load") nunca mais dispararia.
  let carregou = false;
  function mapaPronto(fn) { if (carregou || C.mapa.isStyleLoaded()) fn(); else C.mapa.once("load", fn); }

  // ------------------------------------------------------------ A1: botões do mapa no espaço livre
  // Coluna por coluna, da direita para a esquerda; em cada coluna, de baixo para cima (o último botão, Falar, fica
  // embaixo, à direita). Cada coluna vai do que estiver em cima dela (painel de navegação, alerta, chip do veículo) até
  // acima do que estiver embaixo dela: a atribuição do mapa (© OpenStreetMap / ANP, aberta ou fechada; a licença ODbL
  // exige que fique visível e tocável) e o velocímetro. Só a primeira coluna desce até o pé (a atribuição fica à esquerda
  // dela, estilos/comandos.css). As colunas não passam da borda esquerda da tela.
  // Sem espaço para todos (iPhone SE com navegação, alerta e instrução longa; celular deitado), esconde primeiro os não
  // essenciais, nesta ordem; o "!" (relatar) e o "Falar" nunca saem (o SOS fica na barra inferior).
  const VAO = 10, BASE = 14, MARGEM = 8;
  const DISPENSAVEIS = ["btn-tela", "e3-btn-baixar", "btn-orientacao", "btn-destino", "btn-postos"];
  function visivel(e) { return !!e && !e.hidden && e.offsetParent !== null && getComputedStyle(e).display !== "none"; }
  const SEL_PE = ".maplibregl-ctrl-bottom-right > *, .maplibregl-ctrl-bottom-left > *, .painel-mapa > .velocidade, .painel-mapa > .btn-recentralizar";
  const SEL_TOPO = "#nav-painel, #alerta, .maplibregl-ctrl-top-right > *, .maplibregl-ctrl-top-left > *, .painel-mapa > .chip-veiculo";
  function retangulos(sel) {
    const out = [];
    for (const e of document.querySelectorAll(sel)) {
      if (!visivel(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push(r);
    }
    return out;
  }
  // Reparte "ordem" (de baixo para cima, da direita para a esquerda) em colunas. Devolve null se não couber.
  function repartir(ordem, mr, direita, topos, pes) {
    const alturas = ordem.map((b) => b.offsetHeight || 64), larguras = ordem.map((b) => b.offsetWidth || 64);
    const pos = [];
    let i = 0, xDir = direita, colunas = 0;
    while (i < ordem.length) {
      const xEsq = xDir - Math.max.apply(null, larguras.slice(i));
      if (xEsq < mr.left + MARGEM) return null; // passaria da borda esquerda
      let teto = mr.top + MARGEM, chao = mr.bottom - BASE;
      for (const r of topos) if (r.left < xDir && r.right > xEsq && r.top < mr.bottom - BASE) teto = Math.max(teto, r.bottom + MARGEM);
      for (const r of pes) if (r.left < xDir && r.right > xEsq) chao = Math.min(chao, r.top - MARGEM);
      const disponivel = chao - teto;
      const coluna = []; let alto = 0, larg = 0;
      while (i < ordem.length) {
        const prox = alto + (coluna.length ? VAO : 0) + alturas[i];
        if (prox > disponivel) break;
        coluna.push(i); alto = prox; larg = Math.max(larg, larguras[i]); i++;
      }
      if (!coluna.length) return null; // nem um botão cabe nesta coluna
      let y = mr.bottom - BASE - chao;
      for (const k of coluna) {
        pos.push({ b: ordem[k], bottom: y, right: direita - xDir + (larg - larguras[k]) / 2 });
        y += alturas[k] + VAO;
      }
      xDir -= larg + VAO; colunas++;
    }
    return { pos, colunas, largura: Math.max(0, direita - xDir - VAO) };
  }
  // Recentralizar: pílula logo acima do velocímetro; a coluna de botões desvia dela (entra como "pé" em SEL_PE e nunca
  // é escondida). Sem altura livre ali (iPhone SE 320×568 navegando: o painel desce quase até o velocímetro), vira a
  // versão compacta (ícone + texto, ≥ 64 px) POR CIMA do velocímetro enquanto o mapa não segue (a atribuição continua livre).
  function posicionarRecentralizar(mr, topos) {
    const rec = $("btn-recentralizar"), vel = document.querySelector(".painel-mapa > .velocidade");
    if (!rec || !vel || !visivel(vel)) return;
    const vr = vel.getBoundingClientRect();
    const largura = rec.classList.contains("compacta") ? 210 : Math.max(rec.offsetWidth || 0, 180);
    let teto = mr.top + MARGEM;
    for (const r of topos) if (r.left < vr.left + largura && r.right > vr.left && r.top < vr.top) teto = Math.max(teto, r.bottom + MARGEM);
    const compacta = vr.top - 10 - 64 < teto;
    if (rec.classList.contains("compacta") !== compacta) rec.classList.toggle("compacta", compacta);
    const b = Math.round(compacta ? mr.bottom - vr.bottom : mr.bottom - vr.top + 10) + "px";
    if (rec.style.bottom !== b) rec.style.bottom = b;
    const w = compacta ? Math.round(vr.width) + "px" : "";
    if (rec.style.width !== w) rec.style.width = w;
    const h = compacta ? Math.max(64, Math.round(vr.height)) + "px" : "";
    if (rec.style.minHeight !== h) rec.style.minHeight = h;
  }
  function arrumarAcoes() {
    const acoes = document.querySelector(".acoes"), main = document.querySelector("main");
    if (!acoes || !main || !main.offsetHeight) return;
    // os escondidos por falta de espaço continuam candidatos (a classe só muda quando o resultado muda: sem laço com o observador)
    const botoes = Array.from(acoes.children).filter((b) => !b.hidden && (b.classList.contains("sem-espaco") || getComputedStyle(b).display !== "none"));
    if (!botoes.length) return;
    if (!acoes.classList.contains("arrumada")) acoes.classList.add("arrumada"); // sem mutação à toa (observador)
    acoes.style.top = "0px";
    const mr = main.getBoundingClientRect(), direita = acoes.getBoundingClientRect().right;
    const topos = retangulos(SEL_TOPO);
    posicionarRecentralizar(mr, topos);
    const pes = retangulos(SEL_PE);
    let ordem = botoes.slice().reverse(), arranjo = repartir(ordem, mr, direita, topos, pes);
    const escondidos = [];
    for (const id of DISPENSAVEIS) {
      if (arranjo) break;
      const b = ordem.find((x) => x.id === id);
      if (!b) continue;
      ordem = ordem.filter((x) => x !== b); escondidos.push(b);
      arranjo = repartir(ordem, mr, direita, topos, pes);
    }
    if (!arranjo) { // nem assim: põe o que der, sem sair da tela (raro: tela minúscula)
      arranjo = { pos: [], colunas: 0, largura: 0 };
      let y = 0;
      for (const b of ordem) { arranjo.pos.push({ b, bottom: y, right: 0 }); y += (b.offsetHeight || 64) + VAO; }
      arranjo.colunas = 1; arranjo.largura = Math.max.apply(null, ordem.map((b) => b.offsetWidth || 64));
    }
    for (const b of botoes) b.classList.toggle("sem-espaco", escondidos.includes(b));
    for (const p of arranjo.pos) { p.b.style.bottom = p.bottom + "px"; p.b.style.right = p.right + "px"; }
    acoes.style.width = arranjo.largura + "px";
    acoes.dataset.colunas = String(arranjo.colunas);
    acoes.dataset.escondidos = escondidos.map((b) => b.id).join(" ");
  }
  let pedidoArrumar = false;
  function agendarArrumar() {
    if (pedidoArrumar) return;
    pedidoArrumar = true;
    requestAnimationFrame(() => { pedidoArrumar = false; arrumarAcoes(); });
  }
  function vigiarLayout() {
    const acoes = document.querySelector(".acoes");
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(agendarArrumar) : null;
    const mo = new MutationObserver(agendarArrumar);
    // a atribuição muda de tamanho ao abrir/fechar (botão "i") e quando o texto das fontes chega
    for (const e of [document.querySelector("main"), $("nav-painel"), $("alerta"), document.querySelector(".velocidade"),
      document.querySelector(".chip-veiculo"), document.querySelector(".maplibregl-ctrl-attrib"), $("btn-recentralizar")]) {
      if (!e) continue;
      if (ro) ro.observe(e);
      mo.observe(e, { attributes: true, attributeFilter: ["hidden", "class"] });
    }
    for (const e of document.querySelectorAll(".maplibregl-ctrl-bottom-right, .maplibregl-ctrl-bottom-left")) mo.observe(e, { childList: true });
    // o alerta muda de lugar sem mudar de tamanho quando o painel de navegação muda (--nav-fim no #app, ui/navegacao.js)
    if ($("app")) mo.observe($("app"), { attributes: true, attributeFilter: ["style", "class"] });
    if (acoes) mo.observe(acoes, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
    window.addEventListener("resize", agendarArrumar);
    for (const ev of ["navegacao", "alerta", "alerta-fechado", "aba", "folha"]) C.on(ev, agendarArrumar);
    arrumarAcoes();
  }

  // ------------------------------------------------------------ A4: celular deitado
  function criarAvisoPaisagem() {
    if ($("aviso-paisagem")) return;
    const a = el("div", "aviso-paisagem"); a.id = "aviso-paisagem"; a.setAttribute("role", "status");
    a.append(el("div", "aviso-paisagem-icone", "📱"), el("b", null, "Use o celular em pé"),
      el("p", null, "O Copiloto foi feito para a tela na vertical, no suporte. Gire o celular para continuar."));
    document.body.appendChild(a);
  }

  // ------------------------------------------------------------ NAV-05: mapa simples / completo
  const CAMADAS_SIMPLES = ["postos-pontos"]; // camadas dos pacotes que o modo simples esconde
  function camadaNaoEssencial(camada) {
    if (CAMADAS_SIMPLES.includes(camada.id)) return true;
    // pontos de interesse do mapa base (lojas, restaurantes…): não ajudam a dirigir
    return camada.type === "symbol" && /(^|[-_])poi([-_]|$)/i.test(camada.id) && camada.id.indexOf("e3-") !== 0;
  }
  function aplicarModo() {
    const app = $("app");
    if (app) app.classList.toggle("mapa-simples", modo === "simples");
    const mapa = C.mapa;
    if (!mapa || !mapa.getStyle) return;
    let camadas = [];
    try { camadas = (mapa.getStyle() || {}).layers || []; } catch (e) { return; }
    const vis = modo === "simples" ? "none" : "visible";
    for (const c of camadas) {
      if (!camadaNaoEssencial(c)) continue;
      try { if (mapa.getLayoutProperty(c.id, "visibility") !== vis && !(vis === "visible" && mapa.getLayoutProperty(c.id, "visibility") === undefined)) mapa.setLayoutProperty(c.id, "visibility", vis); } catch (e) { /* camada sumiu */ }
    }
  }
  function mapaModo(novo) {
    if (novo === "simples" || novo === "completo") {
      modo = novo;
      C.util.gravarJSON(CHAVE_MODO, { modo });
      aplicarModo();
    }
    return modo;
  }

  C.seguir = definirSeguir;
  C.orientacao = orientacaoPublica;
  C.mapaModo = mapaModo;
  C.seguindo = () => seguindo;
  C.mapaPronto = mapaPronto;
  C.mapaEstiloUrl = ESTILO; // ui/offline.js (E3) guarda o estilo no cache para o mapa abrir sem internet

  C.aoIniciar(() => {
    const mapa = new maplibregl.Map({
      container: "mapa", style: ESTILO, center: [-49.25, -16.68], zoom: 6, attributionControl: { compact: true },
    });
    C.mapa = mapa;
    mapa.once("load", () => { carregou = true; });
    window.copiloto = { mapa: mapa, nuvem: C.nuvem }; // atalho usado pelos testes de navegador
    // B4 (QA): sem girar nem inclinar o mapa pelo toque. Sem a bússola do MapLibre (ficava embaixo do painel de
    // navegação): quem gira é o "rumo para cima", e o botão de orientação mostra o norte.
    if (mapa.dragRotate) mapa.dragRotate.disable();
    if (mapa.touchZoomRotate) mapa.touchZoomRotate.disableRotation();
    if (mapa.touchPitch) mapa.touchPitch.disable();
    if (mapa.keyboard && mapa.keyboard.disableRotation) mapa.keyboard.disableRotation();
    ligarGestos(mapa);
    ajustarGestos();
    mapa.on("error", () => {
      // sem internet, falta de pedaço do mapa é esperada (só aparece o que foi visto ou baixado: ui/offline.js, E3)
      if (navigator.onLine === false) {
        if (Date.now() - avisouSemRede > 120000) { avisouSemRede = Date.now(); C.mensagem("Sem internet: o mapa só aparece onde já foi visto ou baixado.", 6000); }
        return;
      }
      if (avisouErro) return;
      avisouErro = true;
      C.mensagem("O mapa não carregou. Confira a internet e recarregue a página.", 8000);
    });
    mapa.on("click", (e) => C.emit("mapa-clique", { lngLat: e.lngLat }));
    $("btn-orientacao").addEventListener("click", alternarOrientacao);
    $("btn-recentralizar").addEventListener("click", () => definirSeguir(true));
    C.on("posicao", aoPosicao);
    C.on("gps-sinal", atualizarBotoes);
    C.on("navegacao", (d) => {
      manobraM = d && d.ativa && typeof d.manobra_m === "number" ? d.manobra_m : null;
      verificarNav();
      checarVoltaImediata();
    });
    C.on("alerta", checarVoltaImediata);
    atualizarBotoes();
    C.on("aba", (id) => { if (id === "mapa") setTimeout(() => mapa.resize(), 50); });
    criarAvisoPaisagem();
    // camadas novas (postos, estilo recarregado) também seguem o modo
    mapa.on("styledata", () => { if (modo === "simples") aplicarModo(); });
    aplicarModo();
    C.on("comando:mapa-modo", (d) => {
      if (!d || (d.modo !== "simples" && d.modo !== "completo")) return;
      if (typeof d.atender === "function") d.atender();
      mapaModo(d.modo);
      C.mensagem(d.modo === "simples" ? "Mapa simples: só rota, alertas e relatos ativos." : "Mapa completo.", 4000);
      C.voz.falar(d.modo === "simples" ? "Mapa simples." : "Mapa completo.", { naoInterromper: true });
    });
    C.on("pronto", vigiarLayout);
  });
})(window.Copiloto);
