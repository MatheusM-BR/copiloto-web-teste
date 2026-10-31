// Pacote E5: privacidade e emergência.
//  - PRI-01 / COM-03: tela de consentimento no primeiro uso (e quando a versão do texto muda) e cartão
//    "Privacidade" na aba Conta, com 4 escolhas separadas e revogáveis (lógica em consentimento.js).
//    Localização desligada: o GPS não é ligado (e para, se já estava ligado). Emite "consentimento" (registro).
//  - PRI-02: cartão "Meus dados" (logado): retirar todos os meus relatos ativos e pedir a exclusão da conta.
//  - PRI-05: aba "Emergência" sempre na barra: 191, 192, 193, 190 com tel:, posição em texto para ditar e aviso sem rede.
// Expõe Copiloto.privacidade: consentimento(), abrirConsentimento(), abrirEmergencia().
(function (C) {
  "use strict";
  const { $, el, botao, plural } = C.util;
  const Consent = window.CopilotoConsentimento, Prox = window.CopilotoProximidade;
  const ler = () => Consent.ler(C.util.storage());

  // ---------------------------------------------------------- guarda da localização (antes do GPS ligar)
  // O GPS é ligado por ui/gps.js. Aqui só passa adiante se o motorista permitiu "usar a localização":
  //  - ainda sem resposta: o pedido espera a tela de consentimento;
  //  - negado: não liga e explica; revogado depois: desliga o que estava ligado.
  const geo = (typeof navigator !== "undefined" && navigator.geolocation) || null;
  const relogios = new Set();
  let pendentes = [];
  let origWatch = null, origClear = null;
  if (geo && typeof geo.watchPosition === "function") {
    origWatch = geo.watchPosition.bind(geo);
    origClear = typeof geo.clearWatch === "function" ? geo.clearWatch.bind(geo) : null;
    try {
      geo.watchPosition = function (ok, erro, op) {
        const reg = ler();
        if (Consent.precisaPerguntar(reg)) { pendentes.push([ok, erro, op]); return -1; }
        if (!Consent.permite(reg, "localizacao")) { localizacaoNegada(); return -1; }
        const id = origWatch(ok, erro, op); relogios.add(id); return id;
      };
    } catch (e) { origWatch = null; /* objeto travado: segue sem a guarda (o motorista ainda pode negar no aparelho) */ }
  }
  function aplicarLocalizacao(reg) {
    if (Consent.permite(reg, "localizacao")) {
      const fila = pendentes; pendentes = [];
      for (const [ok, erro, op] of fila) { const id = origWatch(ok, erro, op); relogios.add(id); }
    } else {
      const tinha = pendentes.length; pendentes = [];
      if (origClear) for (const id of relogios) { try { origClear(id); } catch (e) { /* ignora */ } }
      if (relogios.size || tinha) { relogios.clear(); localizacaoNegada(); }
    }
  }
  function localizacaoNegada() {
    const c = $("cartao-gps");
    if (c) c.hidden = false; // o botão "Ativar GPS" volta a aparecer
    C.mensagem("A localização está desligada nas suas escolhas de privacidade (aba Conta). O mapa funciona, mas sem a sua posição e sem alertas.", 9000);
  }

  // ---------------------------------------------------------- escolhas
  function salvar(escolhas) {
    const reg = Consent.gravar(C.util.storage(), escolhas, Date.now());
    aplicarLocalizacao(reg);
    desenharCartao();
    C.emit("consentimento", reg);
    return reg;
  }
  function alterar(item, valor) {
    const reg = Consent.alterar(C.util.storage(), item, valor, Date.now());
    aplicarLocalizacao(reg);
    desenharCartao();
    C.emit("consentimento", reg);
  }

  function linhaEscolha(nome, marcado, aoMudar, prefixo) {
    const it = Consent.ITENS[nome];
    const id = prefixo + nome;
    const box = el("div", "e5-escolha");
    const lab = el("label", "linha-check"); lab.htmlFor = id;
    const inp = el("input"); inp.type = "checkbox"; inp.id = id; inp.checked = !!marcado; inp.dataset.item = nome;
    if (aoMudar) inp.addEventListener("change", () => aoMudar(nome, inp.checked));
    lab.append(inp, document.createTextNode(" " + it.rotulo));
    box.append(lab, el("p", "dica", it.explica));
    return box;
  }

  // Tela do primeiro uso: bloqueia o app até responder. Nada vem marcado.
  function abrirConsentimento() {
    let tela = $("e5-consentimento");
    if (tela) tela.remove();
    tela = el("div", "e5-consentimento"); tela.id = "e5-consentimento";
    tela.setAttribute("role", "dialog"); tela.setAttribute("aria-modal", "true"); tela.setAttribute("aria-labelledby", "e5-cons-titulo");
    const caixa = el("div", "e5-cons-caixa");
    const h = el("h1", null, "Antes de começar: suas escolhas"); h.id = "e5-cons-titulo";
    const reg = ler();
    const valido = reg && !Consent.precisaPerguntar(reg);
    const lista = el("div", "e5-escolhas");
    for (const n of Consent.NOMES) lista.append(linhaEscolha(n, valido ? reg[n] : false, null, "e5-c-"));
    const link = el("a", null, "Ler a política de privacidade"); link.href = "privacidade.html"; link.target = "_blank"; link.rel = "noopener";
    const marcadas = () => { const o = {}; for (const n of Consent.NOMES) o[n] = $("e5-c-" + n).checked; return o; };
    const fechar = () => tela.remove();
    const tudo = botao("Permitir tudo", "btn btn-principal btn-grande", () => {
      const o = {}; for (const n of Consent.NOMES) o[n] = true; salvar(o); fechar();
    }); tudo.id = "e5-cons-tudo";
    const escolhas = botao("Salvar minhas escolhas", "btn btn-grande", () => { salvar(marcadas()); fechar(); }); escolhas.id = "e5-cons-salvar";
    caixa.append(h,
      el("p", null, Consent.TEXTOS.abertura),
      lista);
    const mic = el("p", "dica e5-cons-microfone", Consent.TEXTOS.microfone); mic.id = "e5-cons-microfone";
    caixa.append(mic, link, el("div", "coluna-botoes"));
    caixa.lastChild.append(tudo, escolhas);
    caixa.append(el("p", "dica", "Versão do texto: " + Consent.VERSAO));
    tela.append(caixa);
    document.getElementById("app").appendChild(tela);
  }

  // ---------------------------------------------------------- aba Conta: Privacidade e Meus dados
  function dataCurta(ms) {
    const d = new Date(ms);
    return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
  }
  function cartao(id, titulo) {
    let c = $(id);
    if (!c) { c = el("div", "cartao"); c.id = id; $("tela-conta").appendChild(c); }
    c.textContent = ""; c.append(el("h2", null, titulo));
    return c;
  }
  function desenharCartao() {
    if (!$("tela-conta")) return;
    const reg = ler();
    const c = cartao("e5-privacidade", "Privacidade");
    const valido = reg && !Consent.precisaPerguntar(reg);
    for (const n of Consent.NOMES) c.append(linhaEscolha(n, valido ? reg[n] : false, alterar, "e5-p-"));
    c.append(el("p", "dica", Consent.TEXTOS.microfone));
    const link = el("a", null, "Política de privacidade"); link.href = "privacidade.html"; link.target = "_blank"; link.rel = "noopener";
    c.append(link, el("p", "dica", valido ? "Escolhas de " + dataCurta(reg.respondidoEm) + " · versão " + reg.versao : "Você ainda não respondeu."));
    desenharMeusDados();
  }

  function msgDados(texto, erro) {
    const m = $("e5-dados-msg"); if (!m) return;
    m.textContent = texto || ""; m.hidden = !texto; m.classList.toggle("erro-msg", !!erro);
  }
  function confirmar(area, pergunta, rotuloSim, acao) {
    area.textContent = "";
    const linha = el("div", "linha-botoes");
    const sim = botao(rotuloSim, "btn btn-perigo", async () => { area.textContent = ""; await acao(); }); sim.id = "e5-confirmar";
    linha.append(sim, botao("Cancelar", "btn", () => { area.textContent = ""; }));
    area.append(el("p", "dica", pergunta), linha);
  }
  function desenharMeusDados() {
    if (!$("tela-conta")) return;
    if (!C.nuvem.logado()) { const v = $("e5-dados"); if (v) v.remove(); return; }
    const c = cartao("e5-dados", "Meus dados");
    const m = el("p", "msg-conta", ""); m.id = "e5-dados-msg"; m.hidden = true; m.setAttribute("role", "status");
    const area = el("div", "e5-confirmacao");
    const retirar = botao("Retirar todos os meus relatos", "btn", () => confirmar(area,
      "Seus relatos ativos somem do mapa para todos. O histórico fica guardado e é apagado 30 dias depois de vencer. Relatos já contestados por outros motoristas não podem ser retirados.",
      "Sim, retirar todos", retirarTodos)); retirar.id = "e5-retirar-todos";
    const excluir = botao("Pedir exclusão da conta", "btn btn-perigo", () => confirmar(area,
      "O pedido fica registrado. A exclusão é feita à mão pelo responsável pelo Copiloto e o prazo ainda vai ser definido antes da publicação. Até lá a conta continua funcionando. Para seus relatos sumirem já, use \"Retirar todos os meus relatos\".",
      "Sim, pedir exclusão", pedirExclusao)); excluir.id = "e5-pedir-exclusao";
    const status = el("p", "dica", ""); status.id = "e5-exclusao-status";
    const col = el("div", "coluna-botoes"); col.append(retirar, excluir);
    c.append(el("p", "dica", "O que fica guardado e por quanto tempo está na política de privacidade."), col, area, status, m);
    carregarPedido();
  }
  async function carregarPedido() {
    try {
      const p = await C.nuvem.rpc("copiloto_my_account_deletion_request", {});
      mostrarPedido(p);
    } catch (e) { /* sem internet: não mostra status */ }
  }
  function mostrarPedido(p) {
    const s = $("e5-exclusao-status"); if (!s) return;
    if (p && p.status === "pending") s.textContent = "Pedido de exclusão registrado em " + dataCurta(Date.parse(p.requested_at)) + ". Aguardando o responsável (prazo a definir).";
    else if (p && p.status === "done") s.textContent = "Pedido de exclusão concluído.";
    else s.textContent = "";
  }
  async function retirarTodos() {
    msgDados("Retirando…");
    try {
      const r = (await C.nuvem.rpc("copiloto_withdraw_all_my_reports", {})) || {};
      const n = Number(r.withdrawn) || 0, k = Number(r.kept) || 0;
      let t = n ? plural(n, "relato retirado do mapa.", "relatos retirados do mapa.") : "Nenhum relato ativo para retirar.";
      if (k) t += " " + plural(k, "relato continua", "relatos continuam") + " porque já foi contestado por outros motoristas.";
      msgDados(t);
      if (C.comunidade && C.comunidade.buscar) C.comunidade.buscar();
    } catch (e) { msgDados(e.message, true); }
  }
  async function pedirExclusao() {
    msgDados("Registrando o pedido…");
    try {
      const r = (await C.nuvem.rpc("copiloto_request_account_deletion", {})) || {};
      msgDados(r.already_pending ? "Você já tinha um pedido registrado. Ele continua valendo." : "Pedido de exclusão registrado.");
      mostrarPedido({ status: "pending", requested_at: r.requested_at });
    } catch (e) { msgDados(e.message, true); }
  }

  // ---------------------------------------------------------- emergência (PRI-05)
  const NUMEROS = [
    { tel: "191", nome: "PRF", quando: "Polícia Rodoviária Federal — rodovias federais (BR)" },
    { tel: "192", nome: "SAMU", quando: "Socorro médico" },
    { tel: "193", nome: "Bombeiros", quando: "Resgate, incêndio, acidente com vítima presa" },
    { tel: "190", nome: "Polícia Militar", quando: "Polícia — e rodovias estaduais" },
  ];
  const coord = (n) => (Math.round(n * 100000) / 100000).toFixed(5).replace(".", ",");
  // B2: leitura velha (sem sinal há mais de 10 s) vira "Última posição conhecida, há X min" e não afirma trecho.
  // M4: só diz "Na rota, trecho: X" a até max(50 m, 2 × precisão) da linha da rota; mais longe, "Fora da rota traçada".
  let geoCache = null;
  function trechoNaRota(rota, g) {
    const Nav = window.CopilotoNavegacao;
    if (!Nav || !Array.isArray(rota.coords) || rota.coords.length < 2) return { naRota: false, via: null };
    if (!geoCache || geoCache.rota !== rota) {
      const geo = Nav.prepararGeometria(rota.coords);
      geoCache = { rota, geo, manobras: Nav.extrairManobras(rota.resposta, geo) };
    }
    const proj = Nav.projetar(geoCache.geo, { lat: g.lat, lon: g.lon }, {});
    const limite = Math.max(50, 2 * (g.precisao != null && isFinite(g.precisao) ? g.precisao : 0));
    if (!(proj.distancia_m <= limite)) return { naRota: false, via: null };
    let via = null;
    for (const m of geoCache.manobras) if (m.inicio_m <= proj.ao_longo_m + 1 && !m.destino && m.ruas && m.ruas.length) via = m.ruas.join(" / ");
    return { naRota: true, via: via || Prox.trechoDaRota(rota, g) };
  }
  function textoPosicao() {
    const g = C.estado.gps;
    if (!g) {
      const desligada = !Consent.permite(ler(), "localizacao");
      return { pos: desligada ? "Posição desconhecida: a localização está desligada nas suas escolhas de privacidade (aba Conta)."
        : "Posição desconhecida: o GPS ainda não deu sinal.", trecho: null, velha: false };
    }
    const prec = g.precisao != null && isFinite(g.precisao) ? " (precisão de ±" + Math.round(g.precisao) + " m)" : "";
    const coords = "Latitude " + coord(g.lat) + ", longitude " + coord(g.lon) + prec;
    const velha = !!(C.gps && C.gps.velho());
    if (velha) {
      const idade = C.gps.idadeMs(g);
      const min = Math.floor(idade / 60000);
      const ha = min < 1 ? "há menos de 1 min" : min < 60 ? "há " + min + " min" : "há " + Math.floor(min / 60) + " h " + String(min % 60).padStart(2, "0") + " min";
      return { pos: "Última posição conhecida, " + ha + ": " + coords, trecho: null, velha: true };
    }
    const rota = C.rota && typeof C.rota.atual === "function" ? C.rota.atual() : null;
    if (!rota) return { pos: coords, trecho: null, velha: false };
    const t = trechoNaRota(rota, g);
    return { pos: coords, velha: false,
      trecho: !t.naRota ? "Fora da rota traçada." : t.via ? "Na rota, trecho: " + t.via : "Na rota; o trecho não foi identificado." };
  }
  let telaEmerg = null;
  // B2 (QA2): a tela (links tel:) é montada uma vez; cada leitura do GPS, sinal ou rede só troca os textos da posição e
  // do aviso. Recriar os <a> a cada segundo fazia o toque que começa num link terminar num elemento novo (no iPhone a
  // ligação podia não abrir) e voltava a rolagem.
  function montarEmergencia() {
    telaEmerg.textContent = "";
    telaEmerg.append(el("h1", null, "Emergência"));
    const lista = el("div", "e5-numeros");
    for (const n of NUMEROS) {
      const a = el("a", "e5-ligar"); a.href = "tel:" + n.tel; a.id = "e5-tel-" + n.tel;
      a.append(el("b", null, n.tel), el("span", null, n.nome), el("small", null, n.quando));
      lista.append(a);
    }
    const pos = el("div", "cartao e5-posicao"); pos.id = "e5-posicao"; pos.setAttribute("aria-live", "polite");
    const coordEl = el("div", "e5-coord"); coordEl.id = "e5-coord";
    pos.append(el("h2", null, "Sua posição para dizer ao atendente"), coordEl);
    const aviso = el("p", "e5-aviso"); aviso.id = "e5-aviso-rede";
    telaEmerg.append(lista, pos, aviso);
  }
  function atualizarEmergencia() {
    if (!telaEmerg) return;
    if (!$("e5-coord") || !telaEmerg.contains($("e5-coord"))) montarEmergencia();
    const p = textoPosicao();
    const coordEl = $("e5-coord"), aviso = $("e5-aviso-rede");
    let trechoEl = $("e5-trecho");
    if (coordEl.textContent !== p.pos) coordEl.textContent = p.pos;
    coordEl.classList.toggle("e5-velha", !!p.velha);
    // trecho da rota: só existe quando há o que dizer
    if (!p.trecho && trechoEl) trechoEl.remove();
    else if (p.trecho) {
      if (!trechoEl) { trechoEl = el("div", "e5-trecho"); trechoEl.id = "e5-trecho"; $("e5-posicao").appendChild(trechoEl); }
      if (trechoEl.textContent !== p.trecho) trechoEl.textContent = p.trecho;
    }
    const semRede = typeof navigator !== "undefined" && navigator.onLine === false;
    const txt = semRede
      ? "Sem internet agora. A ligação de emergência usa a rede de celular e pode funcionar mesmo assim, mas o Copiloto não garante que a chamada complete. Se não completar, tente de outro ponto ou peça ajuda."
      : "O toque abre a ligação no telefone. O Copiloto não faz a chamada por você e não garante que ela complete.";
    if (aviso.textContent !== txt) aviso.textContent = txt;
    aviso.classList.toggle("sem-rede", semRede);
  }
  const desenharEmergencia = atualizarEmergencia;
  function abrirEmergencia() { C.abas.irPara("emergencia"); }

  C.privacidade = { consentimento: ler, abrirConsentimento, abrirEmergencia };

  C.aoIniciar(() => {
    C.carregarEstilo("estilos/privacidade.css");
    // emergência: aba fixa na barra (acessível de qualquer tela), sempre a última: entra no "pronto", depois dos pacotes
    C.on("pronto", () => {
      const nav = el("button", "e5-nav-sos"); nav.id = "nav-emergencia"; nav.setAttribute("aria-label", "Emergência");
      nav.append(el("b", null, "SOS"), el("small", null, "Emergência"));
      document.querySelector("nav").appendChild(nav);
      telaEmerg = C.abas.registrar({ id: "emergencia", rotulo: "Emergência", botao: nav, aoAbrir: desenharEmergencia });
    });
    C.on("posicao", () => { if (C.abas.atual() === "emergencia") desenharEmergencia(); });
    C.on("gps-sinal", () => { if (C.abas.atual() === "emergencia") desenharEmergencia(); });
    window.addEventListener("online", () => { if (C.abas.atual() === "emergencia") desenharEmergencia(); });
    window.addEventListener("offline", () => { if (C.abas.atual() === "emergencia") desenharEmergencia(); });

    desenharCartao();
    C.on("aba", (id) => { if (id === "conta") desenharCartao(); });
    C.on("sessao", desenharMeusDados);
    if (Consent.precisaPerguntar(ler())) abrirConsentimento();
  });
})(window.Copiloto);
