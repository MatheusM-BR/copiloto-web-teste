// GPS, velocidade filtrada e tela ligada.
// Escreve Copiloto.estado.gps / ultimaPos e emite "posicao" a cada leitura e "gps-erro" ({ code }).
// Leitura velha (B2): sem leitura nova há mais de IDADE_MAX_MS, a velocidade vira "--" e sai "gps-sinal" ({ ok: false,
// idadeMs, motivo: "sem-sinal" }); a próxima leitura emite "gps-sinal" ({ ok: true }). A última posição continua em
// estado.gps (o SOS mostra "Última posição conhecida, há X min"). Localização revogada nas escolhas de privacidade
// (evento "consentimento"): limpa estado.gps/ultimaPos e emite "gps-sinal" ({ ok: false, motivo: "desligado" }).
// Um vigia só (B3 do QA2): "Ativar GPS" com o GPS já ligado não chama watchPosition de novo; revogar limpa o vigia.
// Expõe Copiloto.gps: idadeMs(gps?), velho(), IDADE_MAX_MS, ligado().
(function (C) {
  "use strict";
  const { $ } = C.util;
  const Prox = window.CopilotoProximidade;
  const Consent = window.CopilotoConsentimento;
  const filtroVel = window.CopilotoVelocidade.criarFiltro();
  const IDADE_MAX_MS = 10000;
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
    const gps = {
      lat: c.latitude, lon: c.longitude,
      precisao: typeof c.accuracy === "number" && isFinite(c.accuracy) ? c.accuracy : null,
      rumo: Prox.rumoDoGps(c.heading, vMs),
      velKmh: vMs == null ? null : Math.round(vMs * 3.6 * 10) / 10,
      kmh: null, t: p.timestamp, recebidoEm,
    };
    C.estado.gps = gps;
    if (!marcador) {
      const el = document.createElement("div"); el.className = "ponto-gps";
      marcador = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(C.mapa);
      C.seguir(true);
    } else {
      marcador.setLngLat(lngLat);
      if (C.seguindo()) C.mapa.easeTo({ center: lngLat, duration: 800 });
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

  C.gps = { idadeMs, velho, IDADE_MAX_MS, ligado: () => vigiaId != null };

  C.aoIniciar(() => {
    setInterval(vigiar, 1000);
    C.on("consentimento", (reg) => { if (Consent && !Consent.permite(reg, "localizacao")) desligar(); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && $("btn-tela").getAttribute("aria-pressed") === "true" && !travaTela) pedirTelaLigada();
      if (document.visibilityState === "visible" && travaTela && travaTela.released) { travaTela = null; pedirTelaLigada(); }
    });
    $("btn-gps").addEventListener("click", iniciarGps);
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
