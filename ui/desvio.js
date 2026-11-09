// Desvio de restrições (lógica pura em desvio.js, window.CopilotoDesvio). A restrição do mapa (ponte baixa, limite de peso)
// não só avisa: o app CALCULA a alternativa. Expõe Copiloto.desvio:
//   estado(rota) → { fase: "buscando" | "ok" | "parcial" | "sem" | "falha", etiqueta?, restantes?, … } | null
//   desviar(rota)   botão "Desviar" do cartão vermelho: escolhe o desvio já calculado ou calcula agora
//   aceitar(rota)   "Mesmo assim": o motorista decidiu; navegando, o app não desvia por conta própria deste destino
//   navegando({ coords, violadas, progressoM })   (ui/avisos.js) restrição violada a ≥ 3 km à frente → recalcula e adota
// Como calcula: C.rota.calcular({ consultar: true, poligonos }) com um quadrado de ~60 m em volta de cada restrição violada
// (exclude_polygons do Valhalla); confere a rota nova com a RPC de restrições (C.dadosRota.restricoesDeRota); se ainda viola,
// repete UMA vez somando os polígonos; sem caminho: "Sem caminho que evite a restrição X; confirme a medida no local".
// Antes de navegar (automático, assim que as restrições da rota chegam) o resultado entra como cartão de alternativa já
// ESCOLHIDO, com a etiqueta "Evita N restrições · +12 km · +18 min" (C.rota.adicionarDesvio); a original fica na lista, com
// "Passa por N restrições". Navegando, os mesmos polígonos valem para os recálculos seguintes (C.rota.definirDesvio) e a voz
// avisa "Rota alterada para desviar da ponte de 4,2 metros" (C.voz.falar, fala de segurança: corta fala não crítica).
// Adoção da rota nova pela navegação: C.navegacao.adotarRota(rota), se existir; senão C.navegacao.trocarDestino (mesmo destino).
// Nunca afirma que a rota é segura: o dado é do OSM (comunitário) e quem decide é o motorista.
(function (C) {
  "use strict";
  const Dv = window.CopilotoDesvio;
  const D = window.CopilotoDados;
  if (!Dv || !D) return;
  const estados = new Map();     // chave da rota → estado do desvio
  const tentadasNav = new Set(); // ids de restrição já tentadas navegando (uma tentativa por restrição)
  let aceitoDestino = null, emNav = false, ultimaFalhaNav = 0, ultimoDestino = null;
  const NAV_REPETE_FALHA_MS = 60000, NAV_LIMITE_MS = 12000;
  let ultimoProgresso = 0, bannerTimer = null;
  const { el, botao } = C.util;
  const BANNER_MS = 15000;

  // Lote 1: banner azul no topo da navegação quando o app troca de rota por conta de uma restrição. Só informa (a troca já
  // aconteceu e foi falada); "Entendi" fecha. Sem "+N km · +N min" quando a conta não fecha: nunca inventa número.
  function textoExtra(base, nova) {
    const e = Dv.extra(base, nova);
    const parte = (v, un) => (isFinite(v) && Math.abs(v) >= 0.5 ? (v > 0 ? "+" : "\u2212") + (Math.abs(v) < 10 ? (Math.round(Math.abs(v) * 10) / 10).toString().replace(".", ",") : Math.round(Math.abs(v))) + " " + un : null);
    return [parte(e.km, "km"), parte(e.minutos, "min")].filter(Boolean).join(" · ");
  }
  function esconderBanner() { clearTimeout(bannerTimer); const b = document.getElementById("desvio-banner"); if (b) b.hidden = true; }
  function mostrarBanner(res, base) {
    const p = document.getElementById("nav-painel"); if (!p) return;
    let b = document.getElementById("desvio-banner");
    if (!b) { b = el("div", "desvio-banner"); b.id = "desvio-banner"; b.setAttribute("role", "status"); p.insertBefore(b, p.firstChild); }
    b.textContent = "";
    const n = res.restantes ? res.restantes.length : 0;
    const titulo = res.fase === "ok" ? "Rota alterada para evitar restrição" : "Rota alterada, mas ainda passa por " + n + (n === 1 ? " restrição" : " restrições");
    const texto = el("div", "desvio-texto"); texto.append(el("b", "desvio-titulo", titulo));
    const extra = textoExtra(base, res.nova);
    if (extra) texto.append(el("span", "desvio-extra", extra));
    if (window.CopilotoIcones) { const w = el("span", "desvio-ico"); w.append(window.CopilotoIcones.no("rota")); b.append(w); }
    const ok = botao("Entendi", "btn desvio-ok", esconderBanner); ok.id = "desvio-banner-ok";
    b.append(texto, ok); b.hidden = false;
    clearTimeout(bannerTimer); bannerTimer = setTimeout(esconderBanner, BANNER_MS);
  }

  const chave = (r) => D.chaveRota(r.coords);
  const chaveDestino = (d) => (d ? d.lat.toFixed(6) + "," + d.lon.toFixed(6) : null);
  const navAtiva = () => !!(C.navegacao && C.navegacao.ativa && C.navegacao.ativa());
  const estado = (rota) => (rota && Array.isArray(rota.coords) && rota.coords.length > 1 ? estados.get(chave(rota)) || null : null);

  // Procura o desvio para `base` (rota com .origem/.destino/.perfil/.km/.minutos) que evite `violadas` (itens do RPC).
  // opt: { origem?, alvos? (já valendo), sinal?, tempoLimiteMs?, ajustar? }. Resolve { fase, nova?, alvos?, evitadas?, restantes?, etiqueta?, total }.
  async function procurar(base, violadas, opt) {
    const o = opt || {};
    const perfil = base.perfil !== undefined ? base.perfil : C.veiculos.ativo();
    let alvos = Dv.acumular(o.alvos || [], violadas).alvos;
    const total = violadas.length;
    let melhor = null;
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      let nova;
      try {
        nova = await C.rota.calcular({ origem: o.origem || base.origem, destino: base.destino, perfil, consultar: true, enquadrar: false, poligonos: alvos,
          ajustar: o.ajustar, sinal: o.sinal, tempoLimiteMs: o.tempoLimiteMs, rotulo: base.rotulo });
      } catch (e) {
        if (e.cancelada) throw e;
        if (e.rede) return { fase: "falha", motivo: e.motivo || e.message, total };
        break; // o servidor não achou caminho com os quadrados: sem desvio (ou fica o da tentativa anterior)
      }
      let res = null;
      try { res = await C.dadosRota.restricoesDeRota(nova); } catch (e) { res = null; }
      // Sem conseguir conferir a rota nova: ela evita os quadrados pedidos (garantido pelo pedido); o resto fica "não verificado" na folha
      const restantes = res ? res.violadas : [];
      const evitadas = Dv.evitadasEntre(violadas, restantes);
      if (!melhor || evitadas.length > melhor.evitadas.length || (evitadas.length === melhor.evitadas.length && restantes.length < melhor.restantes.length)) melhor = { nova, alvos, evitadas, restantes };
      if (!restantes.length) break;
      const acc = Dv.acumular(alvos, restantes);
      if (acc.alvos.length === alvos.length) break; // nada novo a evitar (limite do servidor)
      alvos = acc.alvos;
    }
    if (!melhor || !melhor.evitadas.length) return { fase: "sem", total };
    const etiqueta = Dv.etiqueta(base, melhor.nova, melhor.evitadas.length, total);
    const ex = Dv.extra(base, melhor.nova);
    return Object.assign({ fase: melhor.restantes.length ? "parcial" : "ok", etiqueta, total, extraKm: Math.round(ex.km), facil: Dv.facil(base, melhor.nova),
      registro: Dv.registro(melhor.evitadas, base, melhor.nova) }, melhor);
  }

  function mudou(k) { C.emit("desvio:estado", { chave: k }); }

  // Antes de navegar: calcula e põe o cartão na lista de rotas. force: refaz mesmo com resultado de falha/sem.
  function buscar(rota, violadas, force) {
    if (!rota || !rota.coords || !violadas || !violadas.length || navAtiva()) return null;
    const k = chave(rota), ja = estados.get(k);
    if (ja && (ja.fase === "buscando" || (!force && ja.fase !== "falha"))) return ja.promessa || null;
    const est = { fase: "buscando", total: violadas.length, promessa: null };
    estados.set(k, est); mudou(k);
    est.promessa = procurar(rota, violadas, { origem: rota.origem }).then((res) => {
      if (estados.get(k) !== est) return est;
      Object.assign(est, res);
      est.promessa = null;
      // desvio FÁCIL (pequeno e sem nova violação) já sai escolhido; GRANDE ou parcial só entra na lista, o motorista decide
      if ((res.fase === "ok" || res.fase === "parcial") && !navAtiva() && C.rota.atual() && chave(C.rota.atual()) === k) {
        C.rota.adicionarDesvio(res.nova, { alvos: res.alvos, etiqueta: res.etiqueta, evitadas: res.evitadas.length, total: res.total,
          restantes: res.restantes.length, preEscolher: res.fase === "ok" && res.facil, registro: res.registro, facil: res.facil });
      }
      mudou(k);
      return est;
    }, (e) => { if (estados.get(k) === est) estados.delete(k); mudou(k); return null; });
    return est.promessa;
  }

  // Botão "Desviar": desvio pronto → escolhe; senão calcula (de novo, se falhou)
  function desviar(rota) {
    if (!rota || !C.dadosRota) return;
    const est = estado(rota);
    const alt = C.rota.alternativas && C.rota.alternativas();
    if (est && (est.fase === "ok" || est.fase === "parcial") && alt) {
      const i = alt.rotas.findIndex((x) => x.desvio);
      if (i >= 0) { C.rota.escolher(i); return; }
    }
    const res = C.dadosRota.restricoesJa(rota);
    if (res && res.violadas.length) buscar(rota, res.violadas, true);
  }
  // "Sugerir desvio" do cartão âmbar (confiança média): só quando o motorista toca; nunca automático
  function sugerir(rota) {
    if (!rota || !C.dadosRota) return;
    const res = C.dadosRota.restricoesJa(rota);
    if (res && res.possiveis && res.possiveis.length) buscar(rota, res.possiveis, true);
  }
  function aceitar(rota) {
    aceitoDestino = chaveDestino(rota && rota.destino);
    // r6: o resumo da viagem registra as restrições que o motorista decidiu enfrentar
    let lista = [];
    try { const res = C.dadosRota && C.dadosRota.restricoesJa ? C.dadosRota.restricoesJa(rota) : null; lista = ((res && res.violadas) || []).map((r) => ({ id: r.id, descricao: Dv.registro([r], { km: 0, minutos: 0 }, { km: 0, minutos: 0 })[0].descricao })); } catch (e) { lista = []; }
    C.emit("desvio:aceito", { destino: rota && rota.destino, restricoes: lista });
  }

  // Automático: as restrições da rota atual chegaram e há violação → já calcula o desvio
  let dentroAoRestricoes = false;
  function aoRestricoes(d) {
    if (!d || d.parte !== "restricoes" || navAtiva() || dentroAoRestricoes) return;
    dentroAoRestricoes = true;
    try { aoRestricoes2(); } finally { dentroAoRestricoes = false; }
  }
  function aoRestricoes2() {
    const rota = C.rota.atual();
    if (!rota || !rota.coords || rota.desvio || !C.dadosRota) return;
    const res = C.dadosRota.restricoesJa(rota);
    if (res && res.violadas.length) buscar(rota, res.violadas, false);
  }

  // ------------------------------------------------------------ navegando
  async function adotar(nova, base) {
    if (C.navegacao.adotarRota) return (await C.navegacao.adotarRota(nova)) !== false;
    const d = base.destino;
    return !!(await C.navegacao.trocarDestino({ lat: d.lat, lon: d.lon, rotulo: base.rotulo || null }));
  }
  // opt.forcar: botão "Desviar" do cartão "Você não passa" (ui/avisos.js): mesma busca de sempre, sem a regra dos 3 km, das
  // tentativas anteriores nem do "Mesmo assim"; devolve a fase ("ok", "parcial", "sem", "falha") ou null se nada foi feito.
  async function navegando(info, opt) {
    const forcar = !!(opt && opt.forcar);
    if (emNav || !navAtiva() || !info || !C.dadosRota) return null;
    const base = C.rota.atual(), gps = C.estado.gps;
    if (!base || !base.destino || !gps || navigator.onLine === false) return null;
    if (!forcar && aceitoDestino && aceitoDestino === chaveDestino(base.destino)) return null;
    if (!forcar && Date.now() - ultimaFalhaNav < NAV_REPETE_FALHA_MS) return null;
    const novas = forcar ? (info.violadas || []).filter((r) => r && typeof r.ao_longo_m === "number" && r.ao_longo_m - info.progressoM > -40)
      : Dv.paraRecalcularNavegando(info.violadas, info.progressoM, tentadasNav);
    if (!novas.length) return null;
    let fase = null;
    emNav = true;
    for (const r of novas) tentadasNav.add(r.id);
    const ativo = C.rota.desvioAtivo();
    const alvos = ativo && chaveDestino(ativo.destino) === chaveDestino(base.destino) ? ativo.alvos : [];
    try {
      const res = await procurar({ origem: base.origem, destino: base.destino, perfil: base.perfil, rotulo: base.rotulo, km: info.km || base.km, minutos: info.minutos || base.minutos },
        novas, { origem: { lat: gps.lat, lon: gps.lon }, alvos, tempoLimiteMs: NAV_LIMITE_MS });
      if (!navAtiva()) return null;
      fase = res.fase;
      if (res.fase === "ok" || res.fase === "parcial") {
        C.rota.definirDesvio({ destino: base.destino, alvos: res.alvos, registro: res.registro });
        falouInicio.add(res.registro.map((x) => x.id).join(","));
        for (const x of res.registro) falouPerto.add(x.id);
        const adotou = await adotar(res.nova, base);
        if (!adotou) { C.rota.definirDesvio(ativo); for (const r of novas) tentadasNav.delete(r.id); ultimaFalhaNav = Date.now(); return "falha"; }
        const fala = res.fase === "ok" ? Dv.falaDesvio(res.evitadas)
          : "Rota alterada, mas ainda passa por " + res.restantes.length + (res.restantes.length === 1 ? " restrição" : " restrições") + ". Confirme a medida no local.";
        falarSeguranca(fala);
        mostrarBanner(res, { km: info.km || base.km, minutos: info.minutos || base.minutos }); // lote 1: o banner azul no lugar da mensagem
        if (res.fase !== "ok") C.mensagem(fala, 9000);
      } else if (res.fase === "sem") {
        falarSeguranca(Dv.falaSemDesvio(novas));
        C.mensagem(Dv.textoSemDesvio(novas), 10000);
      } else { for (const r of novas) tentadasNav.delete(r.id); ultimaFalhaNav = Date.now(); if (forcar) C.mensagem("Não deu para calcular o desvio agora (servidor de rotas). Tente de novo.", 8000); } // sem rede: tenta de novo mais tarde
    } catch (e) {
      for (const r of novas) tentadasNav.delete(r.id);
      ultimaFalhaNav = Date.now();
      fase = "falha";
    } finally { emNav = false; }
    return fase;
  }
  // "Desviar" do cartão "Você não passa" (navegando): refaz o desvio das restrições da rota que ainda estão à frente
  async function desviarAgora() {
    const rota = C.rota.atual();
    if (!navAtiva() || !rota || !C.dadosRota) return null;
    const res = C.dadosRota.restricoesJa(rota);
    if (!res || !res.violadas.length) return null;
    aceitoDestino = null; // o motorista pediu o desvio agora: vale de novo
    return navegando({ coords: rota.coords, violadas: res.violadas, progressoM: ultimoProgresso }, { forcar: true });
  }
  // fala de segurança: sem naoInterromper, corta fala não crítica (a voz é da equipe de voz; aqui só se usa C.voz.falar)
  function falarSeguranca(texto) { try { if (C.voz && C.voz.falar) C.voz.falar(texto, { seguranca: true }); } catch (e) { /* sem voz */ } }

  // ------------------------------------------------------------ comunicar o desvio (uma vez por desvio, C.voz.falar)
  const falouInicio = new Set(), falouPerto = new Set();
  const PERTO_M = 2000;
  function aoNavegarFalar(d) {
    if (!d || d.ativa === false) return;
    const atual = C.rota.atual(); const regs = atual && atual.desvios;
    if (!regs || !regs.length) return;
    const k = regs.map((x) => x.id).join(",");
    if (!falouInicio.has(k)) {
      falouInicio.add(k);
      falarSeguranca(Dv.falaInicio(regs));
    }
    const g = C.estado.gps; if (!g) return;
    for (const x of regs) {
      if (falouPerto.has(x.id) || typeof x.lat !== "number") continue;
      if (Dv.distM({ lat: g.lat, lon: g.lon }, x) <= PERTO_M) { falouPerto.add(x.id); falarSeguranca(Dv.falaPerto(x)); }
    }
  }

  C.desvio = { estado, desviar, sugerir, aceitar, navegando, desviarAgora, procurar, buscar };
  C.aoIniciar(() => {
    C.on("dados:rota", aoRestricoes);
    C.on("rota-limpa", () => { estados.clear(); tentadasNav.clear(); aceitoDestino = null; ultimaFalhaNav = 0; ultimoDestino = null; });
    // o destino só "muda" de verdade se for outro ponto (a navegação reemite o mesmo ao recalcular: não zera as tentativas)
    C.on("destino", (d) => {
      const k = chaveDestino(d);
      if (k === ultimoDestino) return;
      ultimoDestino = k; estados.clear(); tentadasNav.clear(); if (k !== aceitoDestino) aceitoDestino = null;
    });
    C.on("veiculo", () => { estados.clear(); });
    C.on("navegacao", (d) => {
      if (d && d.ativa === false) { tentadasNav.clear(); emNav = false; falouInicio.clear(); falouPerto.clear(); esconderBanner(); ultimoProgresso = 0; }
      else { if (d && typeof d.progresso_m === "number") ultimoProgresso = d.progresso_m; aoNavegarFalar(d); }
    });
    // folha da rota: linha curta e discreta quando a rota escolhida já sai desviada (acompanha a escolha)
    C.rotaExtras.antesIniciar = C.rotaExtras.antesIniciar || [];
    C.rotaExtras.antesIniciar.push(function (r) {
      const t = r && r.desvios && r.desvios.length ? Dv.linhaFolha(r.desvios) : "";
      if (!t) return null;
      const p = C.util.el("p", "rota-desvio-linha", t); p.id = "rota-desvio-linha"; return p;
    });
  });
})(window.Copiloto);
