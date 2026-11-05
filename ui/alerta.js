// Alerta de relato à frente (estilo Waze): pop-up com distância ao vivo, voto, voz e bipe de aproximação.
// Lógica de quando abrir/fechar em proximidade.js. Emite "alerta" ({ relato, distanciaM, abriu }) a cada atualização
// do pop-up aberto e "alerta-fechado" ({ id }) quando some.
// E5:
//  - ALT-03: tipos que dependem do sentido só alertam se o rumo do relato e o do motorista forem compatíveis (≤ 90°);
//    altura/peso cruzam com o veículo ativo (excede → alerta crítico; dado faltando → avisa; cabe → normal).
//  - ALT-02: bipe progressivo nos últimos 200 m para risco alto; para ao passar o ponto, ao votar ou com o som desligado.
//  - COM-05: o nível vira indicador discreto ("Contestado" continua escrito).
//  - PRI-01: sem permissão de alertas da comunidade, não alerta; sem permissão de envio, não mostra botões de voto.
// B2: GPS sem leitura nova há mais de 10 s (Copiloto.gps.velho()) ou localização desligada: alerta e bipe fecham
// (a distância estaria errada); voltam com a próxima leitura.
// Com a navegação ativa, o pop-up vira faixa compacta abaixo do painel de manobra (estilos/alerta.css).
(function (C) {
  "use strict";
  const { $, el } = C.util;
  const Relatos = window.CopilotoRelatos, NuvemLib = window.CopilotoNuvem, Prox = window.CopilotoProximidade, Voz = window.CopilotoVoz;
  const Consent = window.CopilotoConsentimento;
  const CHAVE_VEICULOS = "copiloto.perfis.v1";

  const tipoApp = (r) => NuvemLib.tipoParaApp(r.report_type);
  const cfgTipo = (r) => Relatos.TIPOS[tipoApp(r)] || {};
  // ALT-03: decide ao entrar no raio de 500 m
  const alertador = Prox.criarAlertador({
    filtro: (pos, r) => !cfgTipo(r).sentido || Prox.sentidoCompativel(r.heading_deg, pos.rumo),
  });
  let alertaAtual = null, cruzAtual = null, dispensadoId = null;

  function consent() { return Consent.ler(C.util.storage()); }
  function posAtual() { const g = C.estado.gps; return { lat: g.lat, lon: g.lon, rumo: g.rumo }; }

  // Veículo ativo: pelo módulo de veículos; sem ele, lê o cadastro salvo (copiloto.perfis.v1), como o app faz.
  function veiculoAtivo() {
    try { if (C.veiculos && typeof C.veiculos.ativo === "function") return C.veiculos.ativo(); } catch (e) { /* segue */ }
    const o = C.util.lerJSON(CHAVE_VEICULOS, null);
    return o && Array.isArray(o.perfis) ? o.perfis.find((p) => p.id === o.ativoId) || null : null;
  }
  function somLigado() { try { return !!C.voz.preferencias().ligada; } catch (e) { return false; } }
  // E4: enquanto a voz está ocupada (Copiloto.voz.emAlerta(), quando existir), o bipe não toca por cima
  function vozOcupada() { try { return typeof C.voz.emAlerta === "function" && !!C.voz.emAlerta(); } catch (e) { return false; } }

  // ---------------------------------------------------------- bipe (WebAudio, sem tocar no módulo de voz)
  const bipe = (function () {
    let ctx = null, timer = null, intervalo = null, ultimo = 0, contagem = 0;
    function audio() {
      if (ctx) return ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { ctx = null; }
      return ctx;
    }
    function tocarUm() {
      contagem++; ultimo = Date.now();
      const a = audio(); if (!a) return;
      try {
        if (a.state === "suspended" && a.resume) a.resume();
        const t = a.currentTime || 0, o = a.createOscillator(), g = a.createGain();
        o.type = "sine"; o.frequency.value = 1150;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
        o.connect(g); g.connect(a.destination);
        o.start(t); o.stop(t + 0.1);
      } catch (e) { /* sem áudio: o alerta visual continua */ }
    }
    function ciclo() { timer = null; if (intervalo == null) return; if (!vozOcupada()) tocarUm(); timer = setTimeout(ciclo, intervalo); }
    function ajustar(ms) {
      if (ms == null) { parar(); return; }
      intervalo = ms;
      if (timer == null) { ciclo(); return; }
      // ficou mais rápido: antecipa o próximo bipe
      const falta = ultimo + ms - Date.now();
      clearTimeout(timer); timer = setTimeout(ciclo, Math.max(0, falta));
    }
    function parar() { intervalo = null; if (timer != null) { clearTimeout(timer); timer = null; } }
    // iPhone: o áudio só toca depois de um toque na tela
    function destravar() { const a = audio(); try { if (a && a.state === "suspended" && a.resume) a.resume(); } catch (e) { /* ignora */ } }
    return { ajustar, parar, destravar, estado: () => ({ tocando: intervalo != null, intervaloMs: intervalo, bipes: contagem }) };
  })();

  function riscoAlto(r, cruz) {
    if (cruz) return cruz.estado === "excede";
    return !!cfgTipo(r).risco;
  }

  function gpsVelho() { try { return !!(C.gps && C.gps.velho()); } catch (e) { return false; } }

  function atualizar(listaNova) {
    const gps = C.estado.gps;
    if (!gps || gpsVelho() || !Consent.permite(consent(), "alertas")) { fechar(); return; }
    const res = alertador.atualizar(posAtual(), (Array.isArray(listaNova) ? listaNova : C.comunidade.relatosParaAlerta()).filter((r) => r.level !== "hidden"));
    if (!res.atual) { fechar(); return; }
    mostrar(res.atual.relato, res.atual.distanciaM, res.abriu, res.atual.fase);
  }

  function linhaVeiculo() {
    let e = $("alerta-veiculo");
    if (!e) {
      e = el("div", "alerta-veiculo"); e.id = "alerta-veiculo"; e.hidden = true;
      $("alerta").insertBefore(e, $("alerta-nivel"));
    }
    return e;
  }

  function mostrar(r, dist, abriu, fase) {
    alertaAtual = r;
    if (abriu) dispensadoId = null;
    const tipo = tipoApp(r);
    const valor = r.value_numeric == null ? null : Number(r.value_numeric);
    if (abriu || !cruzAtual || cruzAtual.id !== r.id) cruzAtual = { id: r.id, c: Prox.cruzarVeiculo(tipo, valor, veiculoAtivo()) };
    const cruz = cruzAtual.c;
    const caixa = $("alerta");
    caixa.className = "alerta nivel-" + r.level + (cruz && cruz.estado === "excede" ? " critico" : "");
    $("alerta-sigla").textContent = (Relatos.TIPOS[tipo] || {}).sigla || "!";
    $("alerta-titulo").textContent = C.comunidade.titulo(r);
    $("alerta-dist").textContent = "a " + (dist < 10 ? "menos de 10" : Math.round(dist / 10) * 10) + " m" + (NuvemLib.textoRodovia(r) ? " · " + NuvemLib.textoRodovia(r) : "");
    // COM-05: indicador discreto; "Contestado" continua escrito
    const ind = NuvemLib.indicadorNivel(r.level);
    const nv = $("alerta-nivel");
    nv.textContent = ind; nv.hidden = !ind;
    nv.setAttribute("aria-label", NuvemLib.textoNivel(r.level));
    nv.title = NuvemLib.textoNivel(r.level);
    const lv = linhaVeiculo();
    lv.textContent = cruz && cruz.texto ? cruz.texto : "";
    lv.hidden = !(cruz && cruz.texto);
    lv.className = "alerta-veiculo" + (cruz ? " " + cruz.estado : "");
    const podeEnviar = Consent.permite(consent(), "enviar");
    const podeVotar = !r.mine && !r.my_vote && podeEnviar;
    $("alerta-botoes").hidden = !podeVotar;
    const nota = r.mine ? "Relato seu." : r.my_vote ? "Você já votou: " + (r.my_vote === "confirm" ? "continua lá." : "não está mais.")
      : !podeEnviar ? "Votos desligados nas suas escolhas de privacidade (Configurações → Privacidade)." : "";
    $("alerta-nota").textContent = nota; $("alerta-nota").hidden = !nota;
    caixa.hidden = false;
    if (abriu) {
      if (cruz && cruz.estado === "excede") C.voz.falar(cruz.fala);
      else C.voz.falar(Voz.textoAlerta(tipo, valor, dist));
    }
    // ALT-02
    bipe.ajustar(Prox.bipeAgora({ riscoAlto: riscoAlto(r, cruz), somLigado: somLigado(), dispensado: dispensadoId === r.id, fase, distanciaM: dist }));
    C.emit("alerta", { relato: r, distanciaM: dist, abriu: !!abriu });
  }

  function fechar() {
    bipe.parar();
    const id = alertaAtual ? alertaAtual.id : null;
    alertaAtual = null; cruzAtual = null; $("alerta").hidden = true;
    if (id != null) C.emit("alerta-fechado", { id });
  }

  function responder(voto) {
    const r = alertaAtual;
    if (!r) return;
    dispensadoId = r.id;
    alertador.dispensar(r.id);
    fechar();
    C.comunidade.votar(r, voto);
  }

  C.alerta = { atual: () => alertaAtual, fechar, bipe: () => bipe.estado() };

  C.aoIniciar(() => {
    $("btn-a-sim").addEventListener("click", () => responder("confirm"));
    $("btn-a-nao").addEventListener("click", () => responder("deny"));
    document.addEventListener("pointerdown", bipe.destravar, { capture: true });
    C.on("posicao", atualizar);
    // lista da nuvem mudou; fora da conta a lista vem vazia: zera o estado do alertador e fecha
    // (a lista nova vale já: o E3 só marca "relatos frescos" no ouvinte dele, que roda depois deste)
    C.on("relatos", (lista) => {
      if (!C.nuvem.logado()) { if (C.estado.gps) alertador.atualizar(posAtual(), []); fechar(); return; }
      atualizar(Array.isArray(lista) ? lista : undefined);
    });
    // voto pelo popup do mapa (ou por voz) também tira o relato do alerta nesta passagem e para o bipe
    C.on("votando", ({ relato }) => {
      alertador.dispensar(relato.id);
      if (alertaAtual && alertaAtual.id === relato.id) { dispensadoId = relato.id; fechar(); }
    });
    C.on("consentimento", (reg) => {
      if (!Consent.permite(reg, "alertas") || !Consent.permite(reg, "localizacao")) fechar();
      else if (C.estado.gps) atualizar();
    });
    // B2: sem sinal de GPS (leitura velha) ou localização desligada: fecha o alerta e o bipe
    C.on("gps-sinal", (d) => { if (d && d.ok === false) fechar(); });
    C.on("veiculo", () => { cruzAtual = null; });
  });
})(window.Copiloto);
