// GPS, velocidade filtrada e tela ligada.
// Escreve Copiloto.estado.gps / ultimaPos e emite "posicao" a cada leitura e "gps-erro" ({ code }).
// Leitura velha (B2): sem leitura nova há mais de IDADE_MAX_MS, a velocidade vira "--" e sai "gps-sinal" ({ ok: false,
// idadeMs, motivo: "sem-sinal" }); a próxima leitura emite "gps-sinal" ({ ok: true }). A última posição continua em
// estado.gps (o SOS mostra "Última posição conhecida, há X min"). Localização revogada nas escolhas de privacidade
// (evento "consentimento"): limpa estado.gps/ultimaPos e emite "gps-sinal" ({ ok: false, motivo: "desligado" }).
// Um vigia só (B3 do QA2): "Ativar GPS" com o GPS já ligado não chama watchPosition de novo; revogar limpa o vigia.
// Marca da posição (mapa iOS): seta de direção (rumo.js: GPS → entre leituras → parado apagada → bolinha), girada com o
// mapa (rotationAlignment/pitchAlignment "map"). A COORDENADA é animada em JS (setLngLat por quadro, ~intervalo entre
// leituras): nada de transição CSS no elemento que o MapLibre posiciona por transform (a marca "escorregava" no arrasto).
// A câmera (seguir, rumo para cima) fica em ui/mapa.js, no evento "posicao".
// Bússola (webkitCompassHeading): opcional e DESLIGADA por padrão (chave copiloto.rumo.bussola.v1 = { ligada: true }):
// a permissão do iOS é pedida dentro do toque em "Ativar GPS"/"Iniciar navegação"; só vale parado e sem rumo anterior.
// Expõe Copiloto.gps: idadeMs(gps?), velho(), IDADE_MAX_MS, ligado(), rumo(), duracaoAnimMs(), posicaoExibida().
(function (C) {
  "use strict";
  const { $ } = C.util;
  const Prox = window.CopilotoProximidade;
  const Consent = window.CopilotoConsentimento;
  const filtroVel = window.CopilotoVelocidade.criarFiltro();
  const Rumo = window.CopilotoRumo;
  const rumo = Rumo.criarRumo();
  const IDADE_MAX_MS = 10000;
  const CHAVE_BUSSOLA = "copiloto.rumo.bussola.v1";
  let marcador = null, semSinal = false;
  // B3 (QA2): um watchPosition só. Guarda o id; "Ativar GPS" de novo (ou o religar automático do "pronto") não abre
  // outro vigia (seriam leituras e eventos "posicao" em dobro). Limpa ao revogar a localização e quando o aparelho nega.
  let vigiaId = null;

  // Idade da leitura: desde que chegou ao app; se a hora do aparelho diz que ela já chegou velha (até 24 h antes),
  // conta desde a hora dela. Hora absurda (relógio errado, testes com hora inventada) não conta.
  function idadeMs(g, agora) {
    g = g === undefined ? C.estado.gps : g;
    if (!g) return Infinity;
    const t0 = agora == null ? Date.now() : agora;
    let base = typeof g.recebidoEm === "number" ? g.recebidoEm : g.t;
    if (typeof g.t === "number" && typeof g.recebidoEm === "number") {
      const atraso = g.recebidoEm - g.t;
      if (atraso > 0 && atraso < 864e5) base = g.t;
    }
    return Math.max(0, t0 - base);
  }
  function velho() { return !C.estado.gps || idadeMs() > IDADE_MAX_MS; }
  function localizacaoPermitida() {
    try { return !Consent || Consent.permite(Consent.ler(C.util.storage()), "localizacao"); } catch (e) { return true; }
  }

  function vigiar() {
    if (!C.estado.gps || semSinal) return;
    const idade = idadeMs();
    if (idade <= IDADE_MAX_MS) return;
    semSinal = true;
    $("vel").textContent = "--";
    $("app").classList.add("gps-sem-sinal");
    C.emit("gps-sinal", { ok: false, idadeMs: idade, motivo: "sem-sinal" });
  }

  function pararVigia() {
    const id = vigiaId; vigiaId = null;
    if (id != null && id !== -1 && navigator.geolocation && navigator.geolocation.clearWatch) {
      try { navigator.geolocation.clearWatch(id); } catch (e) { /* ignora */ }
    }
  }

  function desligar() {
    pararVigia();
    const tinha = !!C.estado.gps;
    C.estado.gps = null; C.estado.ultimaPos = null;
    pararAnimacao(); rumo.reiniciar(); ultimoRecebido = null;
    if (marcador) { marcador.remove(); marcador = null; }
    $("vel").textContent = "--";
    $("app").classList.remove("gps-sem-sinal");
    semSinal = false;
    if (tinha) C.emit("gps-sinal", { ok: false, idadeMs: Infinity, motivo: "desligado" });
  }

  function iniciarGps() {
    if (!("geolocation" in navigator)) { C.mensagem("Este navegador não tem GPS.", 8000); return; }
    $("cartao-gps").hidden = true;
    if (vigiaId == null) {
      // -1: a guarda do consentimento (ui/privacidade.js) segurou o pedido até a resposta; conta como ligado
      const id = navigator.geolocation.watchPosition(aoReceberPosicao, aoErroGps, {
        enableHighAccuracy: true, maximumAge: 1000, timeout: 20000,
      });
      vigiaId = id == null ? -1 : id;
      // localização negada nas escolhas: a guarda não ligou nada; o próximo "Ativar GPS" (depois de permitir) tenta de novo
      if (vigiaId === -1 && !localizacaoPermitida() && Consent && !Consent.precisaPerguntar(Consent.ler(C.util.storage()))) vigiaId = null;
    }
    pedirTelaLigada();
  }

  function aoReceberPosicao(p) {
    if (!localizacaoPermitida()) return; // revogada: leitura atrasada do aparelho não volta a mostrar posição
    const c = p.coords;
    const recebidoEm = Date.now();
    // já chegou velha (cache do aparelho): não vale como posição atual
    if (idadeMs({ t: p.timestamp, recebidoEm }, recebidoEm) > IDADE_MAX_MS) return;
    const lngLat = [c.longitude, c.latitude];
    C.estado.ultimaPos = lngLat;
    const vMs = typeof c.speed === "number" && isFinite(c.speed) && c.speed >= 0 ? c.speed : null;
    const r = rumo.atualizar({ lat: c.latitude, lon: c.longitude, precisao: c.accuracy, heading: c.heading, velMs: vMs, t: recebidoEm });
    const dur = estimarDuracao(recebidoEm);
    const gps = {
      lat: c.latitude, lon: c.longitude,
      precisao: typeof c.accuracy === "number" && isFinite(c.accuracy) ? c.accuracy : null,
      rumo: Prox.rumoDoGps(c.heading, vMs),
      velKmh: vMs == null ? null : Math.round(vMs * 3.6 * 10) / 10,
      kmh: null, t: p.timestamp, recebidoEm,
    };
    C.estado.gps = gps;
    if (!marcador) {
      marcador = new maplibregl.Marker({ element: criarMarca(), rotationAlignment: "map", pitchAlignment: "map" }).setLngLat(lngLat).addTo(C.mapa);
      mostrarRumo(r, 0);
      C.seguir(true);
    } else {
      animarPara(lngLat, dur);
      mostrarRumo(r, dur);
    }
    // Velocidade filtrada: zona morta contra a oscilação do GPS parado; "--" só quando não dá para saber.
    const kmh = filtroVel.atualizar({
      lat: c.latitude, lon: c.longitude, precisao: c.accuracy,
      velocidade: typeof c.speed === "number" ? c.speed : null, t: p.timestamp,
    });
    gps.kmh = kmh;
    $("vel").textContent = kmh === null ? "--" : String(kmh);
    if (semSinal) { semSinal = false; $("app").classList.remove("gps-sem-sinal"); C.emit("gps-sinal", { ok: true, idadeMs: 0 }); }
    C.emit("posicao", gps);
  }

  function aoErroGps(e) {
    $("vel").textContent = "--";
    if (e.code === 1) {
      pararVigia(); // negado no aparelho: o próximo "Ativar GPS" pede de novo
      $("cartao-gps").hidden = false;
      $("cartao-gps").querySelector("p").textContent =
        "A localização está bloqueada. No iPhone: Ajustes > Privacidade > Serviços de Localização > Safari, e permita. Depois toque em Ativar GPS.";
    } else if (e.code === 2) C.mensagem("Sem sinal de GPS agora.", 6000);
    else if (e.code === 3) C.mensagem("O GPS demorou para responder.", 6000);
    C.emit("gps-erro", { code: e.code });
  }

  // ---------- marca da posição: seta, animação da coordenada e da rotação
  function criarMarca() {
    const el = document.createElement("div"); el.className = "ponto-gps sem-rumo";
    el.innerHTML = '<svg class="ponto-gps-seta" viewBox="0 0 44 44" aria-hidden="true" focusable="false"><path d="M22 3 L37 39 L22 31 L7 39 Z"/></svg><span class="ponto-gps-ponto"></span>';
    return el;
  }
  // duração da animação ≈ intervalo entre leituras (iPhone: ~1 s), entre 300 ms e 1 s
  let ultimoRecebido = null, intervaloMedio = 900;
  function estimarDuracao(agora) {
    if (ultimoRecebido != null) {
      const dt = Math.min(1000, Math.max(300, agora - ultimoRecebido));
      intervaloMedio = intervaloMedio * 0.6 + dt * 0.4;
    }
    ultimoRecebido = agora;
    return Math.round(intervaloMedio * 0.95);
  }
  let anim = null, quadro = null, rotacao = 0;
  function pararAnimacao() { if (quadro) cancelAnimationFrame(quadro); quadro = null; anim = null; }
  function animarPara(lngLat, dur) {
    const atual = marcador.getLngLat();
    const de = [atual.lng, atual.lat];
    const longe = Rumo.distanciaM({ lat: de[1], lon: de[0] }, { lat: lngLat[1], lon: lngLat[0] }) > 2000; // salto (túnel, 1ª leitura boa)
    if (!(dur > 0) || longe || document.visibilityState === "hidden") { pararAnimacao(); marcador.setLngLat(lngLat); return; }
    anim = Object.assign(anim || {}, { de, para: lngLat, t0: performance.now(), dur });
    if (!quadro) quadro = requestAnimationFrame(passo);
  }
  function animarRotacao(graus, dur) {
    const de = rotacao, d = Rumo.difCircular(de, graus);
    if (!(dur > 0) || Math.abs(d) < 0.5) { rotacao = graus; marcador.setRotation(graus); if (anim) anim.rot = null; return; }
    anim = Object.assign(anim || { de: null }, { rot: { de, d, t0: performance.now(), dur } });
    if (!quadro) quadro = requestAnimationFrame(passo);
  }
  function passo(agora) {
    quadro = null;
    if (!anim || !marcador) return;
    let falta = false;
    if (anim.de) {
      const k = Math.min(1, Math.max(0, (agora - anim.t0) / anim.dur));
      marcador.setLngLat([anim.de[0] + (anim.para[0] - anim.de[0]) * k, anim.de[1] + (anim.para[1] - anim.de[1]) * k]);
      if (k < 1) falta = true; else anim.de = null;
    }
    if (anim.rot) {
      const k = Math.min(1, Math.max(0, (agora - anim.rot.t0) / anim.rot.dur));
      rotacao = ((anim.rot.de + anim.rot.d * k) % 360 + 360) % 360;
      marcador.setRotation(rotacao);
      if (k < 1) falta = true; else anim.rot = null;
    }
    if (falta) quadro = requestAnimationFrame(passo); else anim = null;
  }
  function mostrarRumo(r, dur) {
    const el = marcador.getElement();
    const tem = r.graus != null;
    el.classList.toggle("sem-rumo", !tem);
    el.classList.toggle("com-rumo", tem);
    el.classList.toggle("seta-apagada", tem && !r.confiavel);
    el.dataset.rumo = tem ? String(Math.round(r.graus)) : "";
    if (tem) animarRotacao(r.graus, dur);
  }

  // ---------- bússola (opcional, desligada por padrão)
  let ouvindoBussola = false;
  function bussolaLigada() { return !!(C.util.lerJSON(CHAVE_BUSSOLA, null) || {}).ligada; }
  function aoOrientar(e) {
    if (typeof e.webkitCompassHeading !== "number" || !isFinite(e.webkitCompassHeading)) return;
    rumo.bussola({ graus: e.webkitCompassHeading, precisao: e.webkitCompassAccuracy, t: Date.now() });
  }
  // o iOS só deixa pedir a permissão dentro de um toque
  function pedirBussola() {
    if (ouvindoBussola || !bussolaLigada()) return;
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return;
    const ligar = () => { if (ouvindoBussola) return; ouvindoBussola = true; window.addEventListener("deviceorientation", aoOrientar, true); };
    try {
      if (typeof DOE.requestPermission === "function") DOE.requestPermission().then((s) => { if (s === "granted") ligar(); }, () => {});
      else ligar();
    } catch (e) { /* sem suporte */ }
  }

  // ---------- tela ligada (iPhone só dá GPS com a tela ligada)
  let travaTela = null;
  async function pedirTelaLigada() {
    if (!("wakeLock" in navigator)) return;
    try {
      travaTela = await navigator.wakeLock.request("screen");
      $("btn-tela").setAttribute("aria-pressed", "true");
      travaTela.addEventListener("release", () => $("btn-tela").setAttribute("aria-pressed", "false"));
    } catch (e) { /* recusado: tudo bem */ }
  }

  C.gps = {
    idadeMs, velho, IDADE_MAX_MS, ligado: () => vigiaId != null,
    rumo: () => rumo.estado(),                 // { graus, confiavel, fonte, movendo }
    duracaoAnimMs: () => Math.round(intervaloMedio * 0.95), // a câmera (ui/mapa.js) anda junto com a marca
    posicaoExibida: () => { if (!marcador) return null; const p = marcador.getLngLat(); return [p.lng, p.lat]; },
  };

  C.aoIniciar(() => {
    setInterval(vigiar, 1000);
    C.on("consentimento", (reg) => { if (Consent && !Consent.permite(reg, "localizacao")) desligar(); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && $("btn-tela").getAttribute("aria-pressed") === "true" && !travaTela) pedirTelaLigada();
      if (document.visibilityState === "visible" && travaTela && travaTela.released) { travaTela = null; pedirTelaLigada(); }
    });
    $("btn-gps").addEventListener("click", iniciarGps);
    document.addEventListener("click", (e) => {
      if (e.target && e.target.closest && e.target.closest("#btn-gps, .btn-iniciar-nav")) pedirBussola();
    }, true);
    $("btn-tela").addEventListener("click", async () => {
      if ($("btn-tela").getAttribute("aria-pressed") === "true" && travaTela) { await travaTela.release(); travaTela = null; }
      else pedirTelaLigada();
    });
  });

  // Depois de todos os módulos: se a permissão já foi dada, liga o GPS sozinho (senão o cartão tapa o mapa a cada abertura).
  C.on("pronto", () => {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: "geolocation" }).then((r) => { if (r.state === "granted") iniciarGps(); }, () => {});
      }
    } catch (e) { /* sem suporte: o botão Ativar GPS continua valendo */ }
  });
})(window.Copiloto);
