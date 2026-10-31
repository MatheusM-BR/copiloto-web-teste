// Comunidade (nuvem): relatos dos motoristas no mapa, envio com "É este?", votos, retirar e fila offline.
// Expõe Copiloto.comunidade: relatos(), buscar(), enviar(relato), votar(r, voto), paramsGps().
// Emite: "sessao" (sessão ou null, só quando entra/sai), "relatos" (lista da nuvem visível), "votando" ({ relato, voto }),
//        "voto" ({ relato, voto, resposta }), "relato-enviado" ({ relato, resposta }), "fila" (itens pendentes do usuário).
// E5 (PRI-01/COM-03): respeita o consentimento (consentimento.js). Sem "alertas" não busca relatos da nuvem;
// sem "enviar" não manda relato, voto nem a fila; sem "qualidade" precisão/rumo/velocidade vão como null.
// COM-05: sem o rótulo "Não confirmado"; detalhe "Relato de motorista · N confirmações"; "Contestado" continua visível.
(function (C) {
  "use strict";
  const { $, el, botao, plural } = C.util;
  const Relatos = window.CopilotoRelatos, NuvemLib = window.CopilotoNuvem, Prox = window.CopilotoProximidade;
  const Consent = window.CopilotoConsentimento;
  const MSG_SEM_ENVIO = "O envio de relatos e votos está desligado nas suas escolhas de privacidade (aba Conta). Nada foi enviado.";
  const nuvem = C.nuvem;
  const BUSCA_RAIO_M = 20000, REBUSCA_DIST_M = 2000;
  let relatosNuvem = [];          // linhas de copiloto_reports_near
  const marcasNuvem = new Map();  // id → { m, chave }
  const marcasPendentes = new Map();
  let ultimaBusca = null, buscando = false, buscarDeNovo = false;
  // M1: depois de uma falha, só tenta de novo após a espera (15 s, 30 s, 60 s, máx. 2 min); sem internet não tenta
  let falhasBusca = 0, proximaBusca = 0, tentativaEm = 0;
  let estavaLogado = nuvem.logado();

  function tituloServidor(r) {
    const tipo = NuvemLib.tipoParaApp(r.report_type);
    return Relatos.titulo({ tipo, valor: r.value_numeric == null ? null : Number(r.value_numeric) });
  }
  function siglaServidor(r) {
    const cfg = Relatos.TIPOS[NuvemLib.tipoParaApp(r.report_type)];
    return cfg.sigla + (r.value_numeric == null ? "" : " " + String(Number(r.value_numeric)).replace(".", ","));
  }
  function consent() { return Consent.ler(C.util.storage()); }
  function pode(item) { return Consent.permite(consent(), item); }
  // PRI-01 (d): sem permissão de qualidade, precisão/rumo/velocidade vão como null
  function paramsGps() { return Consent.paramsQualidade(consent(), C.estado.gps); }
  function definirRelatos(lista) { relatosNuvem = lista; desenharNuvem(); C.emit("relatos", relatosNuvem.slice()); }

  // ---------- relatos da nuvem no mapa
  function limparNuvem() {
    for (const [, x] of marcasNuvem) x.m.remove();
    marcasNuvem.clear();
    ultimaBusca = null;
    relatosNuvem = [];
    C.emit("relatos", []);
  }

  function popupNuvem(r) {
    const pop = el("div", "popup-relato");
    const detalhe = el("small", "detalhe-nivel", NuvemLib.detalheNivel(r) + (r.mine ? " · relato seu" : ""));
    const exp = Date.parse(r.expires_at);
    pop.append(el("b", null, tituloServidor(r)), detalhe);
    if (r.level === "disputed") pop.append(el("small", "nivel-disputed", "? Contestado por outros motoristas"));
    if (isFinite(exp)) pop.append(el("small", null, Relatos.validade(exp, Date.now()).replace(/^v/, "V")));
    if (r.mine) {
      // copiloto_report_delete RETIRA o relato do mapa (o histórico fica no servidor): pede confirmação antes
      const area = el("div", "confirmar-retirar");
      const excluir = botao("Excluir", "", () => {
        area.textContent = "";
        const linha = el("div", "botoes-voto");
        const sim = botao("Sim, retirar", "voto-nao", () => excluirNuvem(r)); sim.className = "btn-retirar";
        linha.append(sim, botao("Cancelar", "", () => { area.textContent = ""; area.appendChild(excluir); }));
        area.append(el("small", null, "Retirar este relato do mapa?"), linha);
      });
      area.appendChild(excluir);
      pop.append(area);
    } else {
      if (r.my_vote) pop.append(el("small", null, "Seu voto: " + (r.my_vote === "confirm" ? "ainda está aí" : "não está mais")));
      if (pode("enviar")) {
        const linha = el("div", "botoes-voto");
        linha.append(botao("Ainda está aí", "voto-sim", () => votar(r, "confirm")), botao("Não está mais", "voto-nao", () => votar(r, "deny")));
        pop.append(linha);
      } else pop.append(el("small", null, "Votos desligados nas suas escolhas de privacidade (Conta)."));
    }
    return pop;
  }

  function desenharNuvem() {
    const vivos = new Set(relatosNuvem.map((r) => r.id));
    for (const [id, x] of marcasNuvem) if (!vivos.has(id)) { x.m.remove(); marcasNuvem.delete(id); }
    for (const r of relatosNuvem) {
      const chave = [r.level, r.confirm_count, r.deny_count, r.my_vote, r.mine, r.expires_at, r.value_numeric, pode("enviar")].join("|");
      const antes = marcasNuvem.get(r.id);
      if (antes && antes.chave === chave) continue;
      if (antes) antes.m.remove();
      const prefixo = r.level === "disputed" ? "? " : r.level === "confirmed" ? "✓ " : "";
      const marca = el("div", "relato-marca nuvem nivel-" + r.level + (r.mine ? " meu" : ""), prefixo + siglaServidor(r));
      marca.dataset.id = r.id;
      marca.title = tituloServidor(r) + (r.level === "disputed" ? " · Contestado" : "");
      // COM-05: o nível "reported" é discreto pela opacidade. O MapLibre grava style.opacity no marcador a cada movimento
      // do mapa (opção `opacity`, padrão "1"), o que apagava a opacidade do CSS: ela vai como opção do marcador.
      const opacidade = r.level === "reported" ? "0.8" : r.level === "hidden" ? "0.75" : "1";
      const m = new maplibregl.Marker({ element: marca, opacity: opacidade }).setLngLat([r.lon, r.lat])
        .setPopup(new maplibregl.Popup({ offset: 14 }).setDOMContent(popupNuvem(r))).addTo(C.mapa);
      marcasNuvem.set(r.id, { m, chave });
    }
  }

  const online = () => navigator.onLine !== false;
  function zerarEspera() { falhasBusca = 0; proximaBusca = 0; }
  // opcoes.forcar: pedido do motorista (entrou na conta, ligou os alertas, internet voltou) passa por cima da espera
  async function buscarNuvem(opcoes) {
    const forcar = !!(opcoes && opcoes.forcar === true);
    const gps = C.estado.gps;
    if (!nuvem.logado() || !gps) return;
    if (!pode("alertas")) { if (relatosNuvem.length || marcasNuvem.size) limparNuvem(); return; } // PRI-01 (b): não busca
    if (!online()) return;                                   // M1: sem internet não tenta (volta no evento "online")
    if (!forcar && Date.now() < proximaBusca) return;        // M1: esperando depois de uma falha
    if (buscando) { buscarDeNovo = true; return; }
    buscando = true;
    tentativaEm = Date.now();
    const pos = { lat: gps.lat, lon: gps.lon };
    try {
      const lista = await nuvem.rpc("copiloto_reports_near", { p_lat: pos.lat, p_lon: pos.lon, p_radius_m: BUSCA_RAIO_M });
      zerarEspera();
      if (!nuvem.logado() || !pode("alertas")) return;
      ultimaBusca = pos;
      definirRelatos((Array.isArray(lista) ? lista : []).filter((r) => NuvemLib.visivel(r) && NuvemLib.tipoParaApp(r.report_type) && isFinite(r.lat) && isFinite(r.lon)));
    } catch (e) {
      if (e.codigo === "sessao_expirada") C.mensagem(e.message, 7000);
      // sem internet ou servidor com problema: mantém o que já está no mapa e espera antes de tentar de novo
      falhasBusca++;
      proximaBusca = tentativaEm + NuvemLib.esperaAposFalha(falhasBusca);
    } finally {
      buscando = false;
      if (buscarDeNovo) { buscarDeNovo = false; buscarNuvem(); }
    }
  }

  async function votar(r, voto) {
    const gps = C.estado.gps;
    if (!gps) { C.mensagem("Ative o GPS para votar.", 6000); return; }
    if (!pode("enviar")) { C.mensagem(MSG_SEM_ENVIO, 8000); return; } // PRI-01 (c)
    C.emit("votando", { relato: r, voto });
    try {
      const pg = paramsGps();
      const resp = await nuvem.rpc("copiloto_report_vote", { p_report_id: r.id, p_vote: voto, p_lat: gps.lat, p_lon: gps.lon, p_accuracy_m: pg.p_accuracy_m, p_heading_deg: pg.p_heading_deg });
      r.my_vote = voto;
      if (resp && resp.level) r.level = resp.level;
      if (r.level === "hidden" && !r.mine) relatosNuvem = relatosNuvem.filter((x) => x.id !== r.id);
      desenharNuvem();
      C.mensagem(voto === "confirm" ? "Obrigado! Você confirmou que ainda está lá." : "Obrigado! Você avisou que não está mais lá.", 4000);
      C.emit("voto", { relato: r, voto, resposta: resp });
      buscarNuvem();
    } catch (e) { C.mensagem(e.message, 7000); }
  }

  async function excluirNuvem(r) {
    try {
      const resp = await nuvem.rpc("copiloto_report_delete", { p_report_id: r.id });
      if (resp && resp.deleted) {
        definirRelatos(relatosNuvem.filter((x) => x.id !== r.id)); C.mensagem("Relato retirado do mapa.", 4000);
      } else C.mensagem("Não dá para retirar este relato: ele já foi contestado por outros motoristas.", 7000);
    } catch (e) { C.mensagem(e.message, 7000); }
  }

  // ---------- fila offline (relatos que não saíram por falta de internet)
  function desenharPendentes() {
    const fila = nuvem.filaDoUsuario();
    const vivos = new Set(fila.map((x) => x.id));
    for (const [id, m] of marcasPendentes) if (!vivos.has(id)) { m.remove(); marcasPendentes.delete(id); }
    for (const x of fila) {
      if (marcasPendentes.has(x.id) || !Relatos.TIPOS[x.tipo]) continue;
      const cfg = Relatos.TIPOS[x.tipo];
      const marca = el("div", "relato-marca pendente", cfg.sigla + (x.valor == null ? "" : " " + String(x.valor).replace(".", ",")) + " · pendente");
      const pop = el("div", "popup-relato");
      pop.append(el("b", null, Relatos.titulo(x)), el("small", null, "Pendente: vai ser enviado quando a internet voltar."));
      const m = new maplibregl.Marker({ element: marca }).setLngLat([x.lon, x.lat]).setPopup(new maplibregl.Popup({ offset: 14 }).setDOMContent(pop)).addTo(C.mapa);
      marcasPendentes.set(x.id, m);
    }
    C.emit("fila", fila);
  }
  async function reenviarFila() {
    if (!nuvem.filaDoUsuario().length || !pode("enviar")) return; // PRI-01 (c): a fila espera a permissão voltar
    const r = await nuvem.processarFila();
    if (r.enviados) { C.mensagem(plural(r.enviados, "relato guardado foi enviado", "relatos guardados foram enviados") + ".", 5000); buscarNuvem(); }
  }
  // M7: hora em que o motorista viu o problema = toque do "!" (gpsToque.t); sem ela, a criação do relato.
  function horaDoToque(relato) {
    const t = relato && relato.gpsToque ? Number(relato.gpsToque.t) : NaN;
    if (isFinite(t) && t > 0) return t;
    return relato && isFinite(relato.criadoEm) ? Number(relato.criadoEm) : Date.now();
  }
  // A fila manda a hora da observação (p_observed_at): o servidor conta a validade a partir dela, não do reenvio.
  // O envio direto não manda (sai em segundos; assim um relógio do aparelho adiantado não faz o servidor recusar).
  // A fila descarta o que venceu contando a validade também a partir da observação.
  // opcoes.seguraAte: B3 (QA3), cancelado durante o envio direto (o servidor ainda pode receber); opcoes.mensagem: outro aviso
  function guardarNaFila(relato, params, opcoes) {
    const o = opcoes || {};
    const obs = horaDoToque(relato);
    const validade = Number(relato.expiraEm) - Number(relato.criadoEm);
    const expiraEm = isFinite(validade) && validade > 0 ? Math.min(Number(relato.expiraEm), obs + validade) : relato.expiraEm;
    const item = { id: relato.id, tipo: relato.tipo, valor: relato.valor, lat: relato.lat, lon: relato.lon, expiraEm, observadoEm: obs, params };
    if (o.seguraAte) item.seguraAte = o.seguraAte;
    nuvem.enfileirar(item);
    C.folha.fechar();
    C.mensagem(o.mensagem || "Sem internet. O relato ficou guardado e vai ser enviado quando a conexão voltar.", 7000);
  }

  // ---------- B3 (QA3): "Enviando relato…" com Cancelar (≥ 64 px). Em rede ruim cada chamada espera até 20 s com a folha
  // tapando o mapa. Cancelar fecha a folha e guarda o relato na fila offline (com a hora da observação). Se a resposta
  // chegar depois: na conferência de candidatos, é ignorada; no envio, o item da fila fica SEGURADO até ela chegar
  // (o servidor pode ter recebido): deu certo → sai da fila (sem duplicar); sem rede → liberado para o reenvio;
  // recusado → sai da fila com o aviso.
  const SEGURAR_MS = 25000; // tempo-limite da chamada (20 s) + folga
  const MSG_ADIADO = "Envio cancelado. O relato ficou guardado e vai ser enviado em seguida.";
  function folhaEnviando(env, texto) {
    const canc = botao("Cancelar", "btn btn-grande", () => cancelarEnvio(env)); canc.id = "btn-enviando-cancelar";
    const col = el("div", "coluna-botoes"); col.append(canc);
    C.folha.abrir([el("h2", null, "Enviando relato…")].concat(texto ? [el("p", null, texto)] : [], [col]));
  }
  function cancelarEnvio(env) {
    if (env.cancelado || env.fim) return;
    env.cancelado = true;
    guardarNaFila(env.relato, env.params, { seguraAte: env.fase === "envio" ? Date.now() + SEGURAR_MS : 0, mensagem: MSG_ADIADO });
    desenharPendentes();
  }

  // ---------- envio de relato logado
  function folhaErro(titulo, texto) {
    const b = el("div", "linha-botoes"); b.append(botao("Fechar", "btn", C.folha.fechar));
    C.folha.abrir([el("h2", null, titulo), el("p", null, texto), b]);
  }
  // relato.gpsToque (opcional, M2): leitura do GPS no toque do "!" (precisão, rumo e velocidade daquele ponto, não do "Salvar")
  async function enviar(relato) {
    if (!pode("enviar")) { folhaErro("Envio desligado", MSG_SEM_ENVIO); return; } // PRI-01 (c)
    const qualidade = relato.gpsToque ? Consent.paramsQualidade(consent(), relato.gpsToque) : paramsGps();
    const params = Object.assign({ p_type: NuvemLib.tipoParaServidor(relato.tipo), p_lat: relato.lat, p_lon: relato.lon, p_value: relato.valor }, qualidade);
    const env = { relato, params, fase: "candidatos", cancelado: false, fim: false };
    folhaEnviando(env, "Conferindo se alguém já relatou isso aqui.");
    let cands;
    try {
      cands = await nuvem.rpc("copiloto_report_candidates", { p_type: params.p_type, p_lat: params.p_lat, p_lon: params.p_lon, p_heading_deg: params.p_heading_deg });
    } catch (e) {
      env.fim = true;
      if (env.cancelado) return; // B3: já está na fila
      if (e.rede) { guardarNaFila(relato, params); desenharPendentes(); return; }
      folhaErro("Não foi possível enviar", e.message); return;
    }
    env.fim = true;
    if (env.cancelado) return; // B3: já está na fila (sem "É este?"; vai como relato novo)
    cands = Array.isArray(cands) ? cands : [];
    if (cands.some((c) => c.mine)) { folhaErro("Você já relatou isso aqui.", "O seu relato anterior continua valendo."); return; }
    const c = cands[0];
    if (!c) { submeter(relato, params, null); return; }
    const sim = botao("Sim, é este", "btn btn-principal btn-grande", () => submeter(relato, params, c.id)); sim.id = "btn-e-este";
    const nao = botao("Não, é outro", "btn btn-grande", () => submeter(relato, params, null)); nao.id = "btn-e-outro";
    const canc = botao("Cancelar", "btn btn-grande", C.folha.fechar); canc.id = "btn-e-cancelar";
    const col = el("div", "coluna-botoes"); col.append(sim, nao, canc);
    C.folha.abrir([el("h2", null, "Já existe " + tituloServidor(c) + " a " + Math.round(Number(c.distance_m) || 0) + " m. É este?"),
      el("p", null, (c.level === "disputed" ? "Contestado por outros motoristas. " : "") + "Se for o mesmo, o seu relato vira uma confirmação."), col]);
  }
  async function submeter(relato, params, mesmoQue) {
    if (!pode("enviar")) { folhaErro("Envio desligado", MSG_SEM_ENVIO); return; }
    const corpo = Object.assign({}, params);
    if (mesmoQue) corpo.p_same_as = mesmoQue;
    const env = { relato, params: corpo, fase: "envio", cancelado: false, fim: false };
    folhaEnviando(env, null);
    try {
      const r = await nuvem.rpc("copiloto_report_submit", corpo);
      env.fim = true;
      if (env.cancelado) {
        // B3: chegou ao servidor depois do Cancelar: tira da fila (não manda duas vezes) e não mexe na folha atual
        nuvem.retirar(relato.id); desenharPendentes();
        C.mensagem("Relato enviado. Outros motoristas vão ver.", 5000);
        C.emit("relato-enviado", { relato, resposta: r });
        buscarNuvem();
        return;
      }
      C.folha.fechar();
      C.mensagem(r && r.action === "confirmed_existing" ? "Obrigado! Você confirmou o relato que já existia." : "Relato enviado. Outros motoristas vão ver.", 5000);
      C.emit("relato-enviado", { relato, resposta: r });
      buscarNuvem();
    } catch (e) {
      env.fim = true;
      if (env.cancelado) {
        if (e.rede) nuvem.liberar(relato.id); // não chegou: a fila manda na próxima rodada
        else { nuvem.retirar(relato.id); desenharPendentes(); C.mensagem("O relato não foi aceito: " + e.message, 7000); }
        return;
      }
      if (e.rede) { guardarNaFila(relato, corpo); desenharPendentes(); return; }
      folhaErro("Não foi possível enviar", e.message);
    }
  }

  // M3: lista única para o alerta à frente (ui/alerta.js), no formato das linhas da nuvem.
  //  - fora da conta: os relatos LOCAIS deste aparelho (Copiloto.relatos.locais(), com mine: true e id "local:<id>");
  //  - na conta: sem lista nova da nuvem nesta sessão, os guardados do E3; senão a lista da nuvem (uma fonte por vez).
  function relatosParaAlerta() {
    if (!nuvem.logado()) {
      const locais = C.relatos && typeof C.relatos.locais === "function" ? C.relatos.locais() : [];
      return Relatos.ativos(locais, Date.now()).map((r) => Relatos.comoLinhaDaNuvem(r, NuvemLib.tipoParaServidor)).filter(Boolean);
    }
    try { if (C.offline && C.offline.usandoGuardados()) return C.offline.relatosGuardados(); } catch (e) { /* sem E3 */ }
    return relatosNuvem.slice();
  }

  C.comunidade = { relatos: () => relatosNuvem.slice(), relatosParaAlerta, buscar: buscarNuvem, enviar, votar, paramsGps, titulo: tituloServidor, sigla: siglaServidor,
    podeEnviar: () => pode("enviar"), podeReceber: () => pode("alertas"), remover: (ids) => definirRelatos(relatosNuvem.filter((x) => !ids.includes(x.id))),
    // M1: estado da espera da busca (para testes e diagnóstico)
    esperaBusca: () => ({ falhas: falhasBusca, proximaEm: proximaBusca, tentativaEm }) };

  C.aoIniciar(() => {
    nuvem.on("sessao", (s) => {
      const logado = !!s;
      if (logado !== estavaLogado) {
        estavaLogado = logado;
        zerarEspera();
        if (logado) { buscarNuvem({ forcar: true }); reenviarFila(); } else limparNuvem();
        desenharPendentes();
        C.emit("sessao", s);
      }
    });
    nuvem.on("fila", desenharPendentes);
    nuvem.on("descartado", (d) => C.mensagem("Um relato guardado não foi enviado: " + d.erro.message, 7000));
    // internet de volta: reenvia a fila e busca já (sem esperar o fim da espera da última falha)
    window.addEventListener("online", () => { reenviarFila(); zerarEspera(); buscarNuvem(); });
    // escolhas de privacidade mudaram: aplica na hora
    C.on("consentimento", () => {
      if (!pode("alertas")) limparNuvem(); else if (nuvem.logado()) { ultimaBusca = null; buscarNuvem({ forcar: true }); }
      desenharNuvem();
      if (pode("enviar")) reenviarFila();
    });
    // a cada leitura do GPS: busca de novo se andou mais de 2 km desde a última busca
    C.on("posicao", (gps) => {
      if (!nuvem.logado()) return;
      if (!ultimaBusca || Prox.distanciaM(ultimaBusca, gps) > REBUSCA_DIST_M) buscarNuvem();
    });
    setInterval(() => { buscarNuvem(); reenviarFila(); }, 60000);
    desenharPendentes();
    if (nuvem.logado()) reenviarFila();
  });
})(window.Copiloto);
