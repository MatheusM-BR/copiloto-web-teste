// Pacote E5: privacidade e emergência.
//  - PRI-01 / COM-03: tela de consentimento no primeiro uso e cartão "Privacidade" (Configurações → Privacidade, na tela
//    Conta), com escolhas separadas e revogáveis (lógica em consentimento.js): localização, alertas, enviar, qualidade e,
//    só quando o app tem token do Mapillary, a foto de rua. Texto curto com "Saiba mais" por item. Versão nova do texto:
//    só o item que mudou é perguntado (as outras escolhas ficam), e nunca navegando nem acima de ~5 km/h (espera parar).
//    Localização desligada: o GPS não é ligado (e para, se já estava ligado); "Ativar GPS" oferece "Ligar localização".
//    Emite "consentimento" (registro). Aviso do microfone no 1º toque em "Falar" (avisarMicrofone).
//  - PRI-02: cartão "Meus dados" (logado): retirar todos os meus relatos ativos e pedir a exclusão da conta.
//  - PRI-05: Emergência (último item do menu de Configurações e "SOS · Emergência" no "!"): 191, 192, 193, 190 com tel:,
//    rodovia/km, rua e cidade (Copiloto.endereco.perto, se existir), posição e precisão, frase pronta e aviso sem rede.
// Expõe Copiloto.privacidade: consentimento(), abrirConsentimento(), abrirEmergencia(), oferecerLocalizacao(), avisarMicrofone(continuar),
// microfoneAvisado(), fotoPermitida(), localizacaoPermitida(), enviarLocalizacao().
(function (C) {
  "use strict";
  const { $, el, botao, plural } = C.util;
  const Consent = window.CopilotoConsentimento, Prox = window.CopilotoProximidade;
  const ler = () => Consent.ler(C.util.storage());
  // "foto" só existe quando o app tem token do Mapillary (config.js); sem token nem é perguntada
  const temToken = () => !!(window.CopilotoConfig && window.CopilotoConfig.MAPILLARY_TOKEN);
  const opc = () => ({ foto: temToken() });
  const pendentesAgora = (reg) => Consent.pendentes(reg === undefined ? ler() : reg, opc());
  const CHAVE_MIC = "copiloto.microfone.aviso.v1";

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
        // só segura o GPS se o item "localização" está sem resposta (versão nova que só mexe em outro item não trava o GPS)
        if (pendentesAgora(reg).indexOf("localizacao") >= 0) { pendentes.push([ok, erro, op]); return -1; }
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
    C.mensagem("A localização está desligada nas suas escolhas de privacidade (Configurações → Privacidade). O mapa funciona, mas sem a sua posição e sem alertas.", 9000);
  }

  // ---------------------------------------------------------- escolhas
  // respondidos: os itens que o motorista respondeu AGORA (padrão: todos os que têm pergunta); os outros ficam como estavam.
  function salvar(escolhas, respondidos) {
    const reg = Consent.gravar(C.util.storage(), escolhas, Date.now(), undefined, respondidos || perguntaveis());
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
  // itens que existem neste app (a foto só com token)
  function perguntaveis() { return Consent.NOMES.filter((n) => !(Consent.ITENS[n].opcional && !opc()[n])); }

  // Uma escolha: caixa + rótulo (alvo de 64 px) e "Saiba mais" (<details>) com o texto completo. Fechado, o "Saiba mais" fica
  // na mesma linha da escolha; aberto, o texto desce para a linha de baixo.
  function linhaEscolha(nome, marcado, aoMudar, prefixo) {
    const it = Consent.ITENS[nome];
    const id = prefixo + nome;
    const box = el("div", "e5-escolha"); box.dataset.item = nome;
    const lab = el("label", "linha-check"); lab.htmlFor = id;
    const inp = el("input"); inp.type = "checkbox"; inp.id = id; inp.checked = !!marcado; inp.dataset.item = nome;
    if (aoMudar) inp.addEventListener("change", () => aoMudar(nome, inp.checked));
    lab.append(inp, document.createTextNode(" " + it.curto));
    box.append(lab, saibaMais(it.rotulo, it.explica));
    return box;
  }
  function saibaMais(sobre, texto) {
    const d = el("details", "e5-mais"), r = el("summary", null, "Saiba mais");
    r.setAttribute("aria-label", "Saiba mais: " + sobre);
    d.append(r, el("p", "dica", texto));
    return d;
  }

  // Tela do primeiro uso (ou da novidade): bloqueia o app até responder. Nada vem marcado. No primeiro uso lista todas as
  // escolhas; numa versão nova, só as que ainda não têm resposta ("Uma novidade para você escolher"), sem mexer nas outras.
  function abrirConsentimento() {
    let tela = $("e5-consentimento");
    if (tela) tela.remove();
    const reg = ler();
    const pend = pendentesAgora(reg);
    if (!pend.length) return;
    const novidade = !!reg && pend.length < perguntaveis().length;
    tela = el("div", "e5-consentimento"); tela.id = "e5-consentimento";
    tela.setAttribute("role", "dialog"); tela.setAttribute("aria-modal", "true"); tela.setAttribute("aria-labelledby", "e5-cons-titulo");
    const caixa = el("div", "e5-cons-caixa");
    const h = el("h1", null, novidade ? "Antes de continuar" : Consent.TEXTOS.titulo); h.id = "e5-cons-titulo";
    caixa.append(h);
    if (!novidade) {
      caixa.append(el("p", "e5-cons-abertura", Consent.TEXTOS.abertura));
      const ul = el("ul", "e5-cons-saidas");
      const linhas = Consent.TEXTOS.saidas.slice();
      if (pend.indexOf("foto") >= 0) linhas.push(Consent.TEXTOS.saidaFoto);
      for (const t of linhas) ul.append(el("li", null, t));
      caixa.append(ul);
    } else caixa.append(el("p", "e5-cons-abertura", Consent.TEXTOS.novidade));
    const lista = el("div", "e5-escolhas");
    for (const n of pend) lista.append(linhaEscolha(n, false, null, "e5-c-"));
    caixa.append(lista);
    const marcadas = () => { const o = {}; for (const n of pend) o[n] = $("e5-c-" + n).checked; return o; };
    const fechar = () => { tela.remove(); window.dispatchEvent(new Event("resize")); };
    const tudo = botao(novidade ? "Permitir" : "Permitir tudo", "btn btn-principal btn-grande", () => {
      const o = {}; for (const n of pend) o[n] = true; salvar(o, pend); fechar();
    }); tudo.id = "e5-cons-tudo";
    const escolhas = botao(novidade ? "Não permitir" : "Salvar escolhas", "btn btn-grande", () => {
      salvar(novidade ? {} : marcadas(), pend); fechar();
    }); escolhas.id = "e5-cons-salvar";
    const acoes = el("div", "e5-cons-acoes"); acoes.append(tudo, escolhas);
    const pe = el("p", "e5-cons-pe", Consent.TEXTOS.rodape + " ");
    const link = el("a", null, Consent.TEXTOS.politica); link.href = "privacidade.html"; link.target = "_blank"; link.rel = "noopener";
    pe.append(link, document.createTextNode("."));
    caixa.append(acoes, pe);
    tela.dataset.versao = Consent.VERSAO;
    tela.append(caixa);
    document.getElementById("app").appendChild(tela);
  }

  // Versão nova do texto (ou primeiro uso): pergunta só o que falta e nunca com o caminhão andando. Navegando ou acima de
  // ~5 km/h, espera: reavalia a cada leitura do GPS e a cada passo da navegação, e pergunta quando parar. Enquanto não
  // responde, o item novo vale como "não" (as respostas antigas continuam valendo, o GPS não é desligado).
  const VEL_PARADO_KMH = 5, ESPERA_1A_LEITURA_MS = 6000;
  let esperandoParar = false, primeiraEspera = true;
  function emMovimento() {
    if (C.navegacao && typeof C.navegacao.ativa === "function" && C.navegacao.ativa()) return true;
    const g = C.estado.gps;
    const v = g ? (g.kmh != null ? g.kmh : g.velKmh) : null;
    return typeof v === "number" && v >= VEL_PARADO_KMH;
  }
  function perguntarSePrecisa() {
    if (!pendentesAgora().length || $("e5-consentimento")) return;
    if (ler() && emMovimento()) { esperandoParar = true; return; } // já respondeu antes: só pergunta o novo, parado
    if (primeiraEspera && ler() && localizacaoPermitida() && !C.estado.gps) { esperandoParar = true; return; } // 1ª leitura ainda não chegou
    esperandoParar = false;
    abrirConsentimento();
  }

  // ---------------------------------------------------------- localização desligada: "Ligar localização"
  // "Ativar GPS" com a localização desligada nas escolhas não fica mudo: oferece ligar (um toque, sem ir à tela Conta).
  function oferecerLocalizacao() {
    const reg = ler();
    if (Consent.permite(reg, "localizacao")) return false;
    if (pendentesAgora(reg).indexOf("localizacao") >= 0) { abrirConsentimento(); return true; }
    const ligar = botao("Ligar localização", "btn btn-principal btn-grande", () => {
      alterar("localizacao", true);
      C.folha.fechar();
      if (C.gps && C.gps.ativar) C.gps.ativar();
    }); ligar.id = "e5-ligar-localizacao";
    const nao = botao("Agora não", "btn btn-grande", C.folha.fechar); nao.id = "e5-localizacao-nao";
    const linha = el("div", "linha-botoes"); linha.append(ligar, nao);
    C.folha.abrir([el("h2", null, "A localização está desligada"),
      el("p", null, "Você desligou a localização nas suas escolhas de privacidade. Sem ela o mapa não mostra onde você está, nem a velocidade e os alertas. Dá para mudar quando quiser em Configurações → Privacidade."),
      linha]);
    return true;
  }

  // ---------------------------------------------------------- microfone: aviso no 1º toque em "Falar"
  function microfoneAvisado() { const o = C.util.lerJSON(CHAVE_MIC, null); return !!(o && o.visto); }
  function avisarMicrofone(continuar) {
    const ok = botao("Entendi, falar", "btn btn-principal btn-grande", () => {
      C.util.gravarJSON(CHAVE_MIC, { visto: true, em: Date.now(), versao: Consent.VERSAO });
      C.folha.fechar();
      if (typeof continuar === "function") continuar(); // dentro do mesmo toque: o iPhone só abre o microfone num toque
    }); ok.id = "e5-mic-ok";
    const nao = botao("Agora não", "btn btn-grande", C.folha.fechar); nao.id = "e5-mic-nao";
    const linha = el("div", "linha-botoes"); linha.append(ok, nao);
    C.folha.abrir([el("h2", null, "Comando de voz"), el("p", "e5-mic-texto", Consent.TEXTOS.microfone), linha]);
  }

  // ---------------------------------------------------------- Configurações → Privacidade (tela Conta): Privacidade e Meus dados
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
    for (const n of perguntaveis()) c.append(linhaEscolha(n, Consent.permite(reg, n), alterar, "e5-p-"));
    c.append(el("p", "dica", Consent.TEXTOS.microfone));
    const link = el("a", "e5-link-politica", "Política de privacidade"); link.href = "privacidade.html"; link.target = "_blank"; link.rel = "noopener";
    const pend = pendentesAgora(reg);
    c.append(link, el("p", "dica", !reg ? "Você ainda não respondeu." : pend.length ? "Falta responder: " + pend.map((n) => Consent.ITENS[n].curto).join(", ") + "." : "Escolhas de " + dataCurta(reg.respondidoEm) + " · versão " + reg.versao));
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
      return { pos: desligada ? "Posição desconhecida: a localização está desligada nas suas escolhas de privacidade (Configurações → Privacidade)."
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
  // Redesenho: "Você está em" (rodovia/km ou rua, endereço próximo — Copiloto.endereco.perto, do pacote de endereço, se
  // existir —, latitude/longitude e precisão), a frase pronta para dizer ao telefone e os números (tel:). Sem o pacote de
  // endereço, só a coordenada. O endereço é pedido de novo só depois de andar 50 m ou passar 1 min (não a cada leitura).
  const I = window.CopilotoInterface;
  let endereco = null; // { lat, lon, t, r (resposta de endereco.perto ou null), pedindo }
  function pedirEndereco(g) {
    if (!g || !(C.endereco && typeof C.endereco.perto === "function")) return;
    const Nav = window.CopilotoNavegacao;
    if (endereco && (endereco.pedindo || (Date.now() - endereco.t < 60000 && Nav && Nav.distanciaM(endereco, g) < 50))) return;
    const pedido = { lat: g.lat, lon: g.lon, t: Date.now(), r: endereco ? endereco.r : null, pedindo: true };
    endereco = pedido;
    Promise.resolve().then(() => C.endereco.perto({ lat: g.lat, lon: g.lon, propria: true })).then((r) => {
      if (endereco !== pedido) return;
      pedido.r = r || null; pedido.pedindo = false; pedido.t = Date.now();
      if (C.abas.atual() === "emergencia") atualizarEmergencia();
    }, () => { if (endereco === pedido) { pedido.pedindo = false; pedido.t = Date.now(); } });
  }
  function montarEmergencia() {
    telaEmerg.textContent = "";
    telaEmerg.append(el("h1", null, "Emergência"));
    const pos = el("div", "cartao e5-posicao"); pos.id = "e5-posicao"; pos.setAttribute("aria-live", "polite");
    const end = el("div", "e5-endereco"); end.id = "e5-endereco"; end.hidden = true;
    const endLinha = el("div", "e5-endereco-linha"); endLinha.id = "e5-endereco-linha"; endLinha.hidden = true;
    const coordEl = el("div", "e5-coord"); coordEl.id = "e5-coord";
    pos.append(el("h2", null, "Você está em"), end, endLinha, coordEl);
    const frase = el("p", "e5-frase"); frase.id = "e5-frase"; frase.hidden = true;
    const lista = el("div", "e5-numeros");
    for (const n of NUMEROS) {
      const a = el("a", "e5-ligar"); a.href = "tel:" + n.tel; a.id = "e5-tel-" + n.tel;
      a.append(el("b", null, n.tel), el("span", null, n.nome), el("small", null, n.quando));
      lista.append(a);
    }
    // Enviar minha localização (SOS): menu de compartilhar do aparelho (navigator.share) com o endereço e os links do
    // OpenStreetMap e do Google Maps; sem compartilhar, copia o texto.
    const env = botao("Enviar minha localização", "btn btn-principal btn-grande e5-enviar", () => { enviarLocalizacao(); });
    env.id = "e5-enviar-local"; env.setAttribute("aria-label", "Enviar minha localização por mensagem, com endereço e links do mapa");
    const aviso = el("p", "e5-aviso"); aviso.id = "e5-aviso-rede";
    const fonte = el("p", "e5-aviso e5-fonte-endereco"); fonte.id = "e5-fonte-endereco"; fonte.hidden = true;
    telaEmerg.append(pos, frase, lista, env, aviso, fonte);
  }
  // Texto para compartilhar: endereço (se já se sabe), coordenada com precisão e os dois links de mapa (coordenada com ponto)
  function textoCompartilhar() {
    const g = C.estado.gps;
    if (!g || !isFinite(g.lat) || !isFinite(g.lon)) return null;
    const lat = g.lat.toFixed(6), lon = g.lon.toFixed(6);
    const linhas = [];
    const velha = !!(C.gps && C.gps.velho());
    if (velha) {
      const min = Math.floor(C.gps.idadeMs(g) / 60000);
      linhas.push("Última posição conhecida, " + (min < 1 ? "há menos de 1 min" : "há " + min + " min") + ".");
    } else linhas.push("Esta é a minha localização agora.");
    const t = I && endereco && endereco.r ? I.textoEndereco(endereco.r) : null;
    if (t) linhas.push(t.titulo + (t.linha ? " · " + t.linha : ""));
    const prec = g.precisao != null && isFinite(g.precisao) ? " (precisão de ±" + Math.round(g.precisao) + " m)" : "";
    linhas.push("Latitude " + lat + ", longitude " + lon + prec);
    linhas.push("OpenStreetMap: https://www.openstreetmap.org/?mlat=" + lat + "&mlon=" + lon + "#map=17/" + lat + "/" + lon);
    linhas.push("Google Maps: https://maps.google.com/?q=" + lat + "," + lon);
    return linhas.join("\n");
  }
  async function copiarTexto(texto) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(texto); return true; } } catch (e) { /* tenta o antigo */ }
    try {
      const ta = document.createElement("textarea"); ta.value = texto; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand && document.execCommand("copy"); ta.remove(); return !!ok;
    } catch (e) { return false; }
  }
  async function enviarLocalizacao() {
    const texto = textoCompartilhar();
    if (!texto) { C.mensagem("Ainda sem posição: o GPS não deu sinal. Ligue a localização e espere o sinal.", 6000); return false; }
    if (typeof navigator.share === "function") {
      try { await navigator.share({ title: "Minha localização", text: texto }); return true; }
      catch (e) { if (e && e.name === "AbortError") return false; /* recusou/sem suporte: copia */ }
    }
    const ok = await copiarTexto(texto);
    C.mensagem(ok ? "Localização copiada. Cole numa mensagem." : "Não foi possível compartilhar nem copiar. Leia a posição na tela.", 7000);
    return ok;
  }
  function trocarTexto(e, t) { if (!e) return; const v = t || ""; if (e.textContent !== v) e.textContent = v; e.hidden = !v; }
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
    // endereço (rodovia/km, rua, bairro/cidade) e a frase pronta para o telefone
    const g = C.estado.gps;
    pedirEndereco(g);
    const r = endereco && g ? endereco.r : null;
    const t = I ? I.textoEndereco(r) : null;
    trocarTexto($("e5-endereco"), t ? t.titulo : "");
    trocarTexto($("e5-endereco-linha"), t ? t.linha : "");
    trocarTexto($("e5-frase"), g && I ? "“" + I.fraseEmergencia(r, g) + "”" : "");
    trocarTexto($("e5-fonte-endereco"), C.endereco && typeof C.endereco.perto === "function"
      ? (localizacaoPermitida() ? "Endereço: do mapa guardado no aparelho e, com internet, do Nominatim (OpenStreetMap), que recebe a sua posição exata."
        : "Endereço: só do mapa guardado no aparelho (a localização está desligada: a sua posição não vai ao Nominatim).") : "");
    const semRede = typeof navigator !== "undefined" && navigator.onLine === false;
    const txt = semRede
      ? "Sem internet agora. A ligação de emergência usa a rede de celular e pode funcionar mesmo assim, mas o Copiloto não garante que a chamada complete. Se não completar, tente de outro ponto ou peça ajuda."
      : "O toque abre a ligação no telefone. O Copiloto não faz a chamada por você e não garante que ela complete.";
    if (aviso.textContent !== txt) aviso.textContent = txt;
    aviso.classList.toggle("sem-rede", semRede);
  }
  const desenharEmergencia = atualizarEmergencia;
  function abrirEmergencia() { C.abas.irPara("emergencia"); }

  const localizacaoPermitida = () => Consent.permite(ler(), "localizacao");
  // foto de rua (Mapillary): só com token no app E escolha explícita (desligada por padrão)
  const fotoPermitida = () => temToken() && Consent.permite(ler(), "foto");
  C.privacidade = { consentimento: ler, abrirConsentimento, abrirEmergencia, oferecerLocalizacao, avisarMicrofone, microfoneAvisado,
    fotoPermitida, localizacaoPermitida, enviarLocalizacao: () => enviarLocalizacao(), pendentes: () => pendentesAgora() };

  C.aoIniciar(() => {
    C.carregarEstilo("estilos/privacidade.css");
    // emergência: item do menu de Configurações (e "SOS · Emergência" no formulário do "!"), sempre o último do menu:
    // entra no "pronto", depois dos pacotes
    C.on("pronto", () => {
      const nav = el("button", "e5-nav-sos"); nav.id = "nav-emergencia"; nav.setAttribute("aria-label", "Emergência (SOS)");
      nav.append(el("b", "cfg-item", "SOS · Emergência"), el("small", "cfg-valor", "191 · 192 · 193 e sua posição"));
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
    // versão nova do texto: pergunta só o que falta e só com o caminhão parado (a cada leitura/passo, reavalia)
    // Quem já respondeu antes e tem o GPS liberado pode estar dirigindo ao abrir o app: espera a 1ª leitura (velocidade) por até
    // 6 s antes de decidir; sem leitura nesse tempo, pergunta (não há como saber). No primeiro uso (nada respondido), pergunta já.
    if (ler() && pendentesAgora().length && localizacaoPermitida()) {
      esperandoParar = true;
      setTimeout(() => { primeiraEspera = false; if (esperandoParar) perguntarSePrecisa(); }, ESPERA_1A_LEITURA_MS);
    } else perguntarSePrecisa();
    C.on("posicao", () => { if (esperandoParar) perguntarSePrecisa(); });
    C.on("navegacao", () => { if (esperandoParar) perguntarSePrecisa(); });
  });
})(window.Copiloto);
