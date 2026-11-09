// Navegação guiada (pacote E1): "Iniciar navegação", carregado ou vazio, painel de condução, voz das manobras,
// recálculo ao sair da rota, chegada, resumo pós-viagem e destinos recentes.
// Lógica pura em navegacao.js. Dados locais em copiloto.nav.v1 (pesos vazios por veículo, viagens, destinos recentes).
// Expõe Copiloto.navegacao: textoViagem(tipo) ("chegada" | "restante", frase para falar), iniciar(), encerrar(), ativa(), recentes(), viagens(), mostrarViagens(),
// trocarDestino({ lat, lon, rotulo }) (recalcula a navegação em andamento para outro destino).
// Emite "navegacao" ({ ativa, progresso_m, restante_m, coords }) a cada atualização.
// Ouve "comando:repetir" e "comando:cancelar-rota" (pacote de voz, chama dado.atender()), "alerta"/"alerta-fechado".
// Sem internet, inicia a partir da rota guardada pelo pacote offline (C.offline.rotaGuardada()).
// Voz (B1): a orientação só espera enquanto a FRASE do alerta toca (Copiloto.voz.emAlerta()); logo depois fala a etapa
// vencida ("perto"/"agora"). Falas não críticas ("Recalculando.", "Rota cancelada."…) nunca cortam um alerta (B7).
// GPS (B2): sem leitura nova há mais de 10 s, o painel diz "Sem sinal de GPS" e os anúncios param até voltar;
// localização desligada nas escolhas de privacidade encerra a navegação.
// QA rodada 2: progresso pelo rastreador de navegacao.js (A1: leitura imprecisa ou salto impossível não mexe no
// progresso); chegada exige o progresso perto do fim (A2); "Encerrar" pede confirmação e não apaga a rota do mapa nem a
// guardada (A4: só "cancela a rota", "Limpar rota"/"Esquecer rota" ou a chegada apagam); durante o recálculo as manobras
// continuam pela rota antiga e, de volta a ≤ 40 m dela, o recálculo é cancelado (A6; tempo-limite de 10 s); fala de
// manobra com { manobra: true } (M1: as não críticas esperam); estado guardado em copiloto.nav.v1 (andamento) e
// "Continuar navegação" depois de recarregar a página (M4).
// QA rodada 3: chegada nunca na leitura em que o progresso acabou de saltar (A1); "cancela a rota" pela voz pede
// confirmação na tela e não apaga a rota (M2); com o microfone ouvindo (C.comandos.ouvindo()) a manobra espera, e a
// manobra cortada (pela escuta ou por outra fala) é repetida (M3); trocar o destino tem tempo-limite de 10 s e as
// manobras da rota antiga continuam enquanto isso (B1).
// Rota offline (pedido do dono do produto: fazenda sem sinal): na chegada a rota guardada (E3) NÃO é apagada, vira
// "última rota" (7 dias) com "Voltar pela mesma rota" (desenho invertido, sem inventar curvas; com internet, a rota de
// volta de verdade). Sem internet e fora da linha: nada de laço de "Recalculando" — "Rota offline — sem internet para
// recalcular. Volte para a linha destacada" com distância e seta até o ponto da linha à frente (voz no máximo a cada
// ~60 s). Usando rota guardada/offline, a faixa "Rota offline · conferida …" fica no painel; com a internet de volta, a
// rota é conferida uma vez (Nav.criarConferidor) e trocada se a nova diferir (Nav.compararRotas).
(function (C) {
  "use strict";
  const { $, el, botao } = C.util;
  const Nav = window.CopilotoNavegacao, Rota = window.CopilotoRota;

  let nav = null;           // navegação em andamento
  let alertaAberto = false; // alerta de segurança na tela ("repete" fica com o alerta)
  let geracao = 0;
  let timerRetomada = null; // fala de manobra esperando a frase do alerta acabar
  let timerAviso = null;    // aviso de carga some do painel depois de AVISO_MS
  const AVISO_MS = 8000;
  const RECALCULO_LIMITE_MS = 10000; // A6: tempo-limite do servidor de rotas no recálculo
  const VOLTOU_M = 40;               // A6: de volta à rota antiga (cancela o recálculo)
  const ANUNCIA_RECALCULANDO_M = 150; // A6: perto da rota antiga, as manobras dela continuam durante o recálculo
  // Conversa pelo caminho: sem marco nem "Continue por…" até 15 s depois de uma manobra falada (window.COPILOTO_FOLGA_MANOBRA_MS
  // encurta nos testes de navegador)
  const folgaManobraMs = () => { const v = Number(window.COPILOTO_FOLGA_MANOBRA_MS); return v >= 0 && isFinite(v) && window.COPILOTO_FOLGA_MANOBRA_MS != null ? v : 15000; };
  const GRAVAR_MS = 3000;            // M4: gravação do andamento no máximo a cada 3 s
  const LONGE_DA_LINHA_M = 200;      // sem internet: tão longe da linha (saindo de fazenda) já orienta a reentrada
  const online = () => navigator.onLine !== false;

  function dados() { return Nav.lerDados(C.util.storage()); }
  function gravar(d) { Nav.gravarDados(C.util.storage(), d); }

  // ------------------------------------------------------------ início: carregado ou vazio?
  function iniciar() {
    if (nav) return;
    const atual = C.rota.atual();
    const rota = atual || rotaGuardada();
    if (!rota) { C.mensagem("Trace uma rota antes de iniciar a navegação.", 6000); return; }
    const perfil = rota.perfil;
    // sem internet com a rota guardada (E3): não dá para recalcular com a carga; segue a rota como foi traçada
    if (!atual && navigator.onLine === false) {
      if (!C.estado.ultimaPos) { C.mensagem("Ative o GPS para começar a navegação.", 6000); return; }
      ativar(rota, perfil, { carga: null, peso: null, aviso: avisoGuardada(rota) });
      return;
    }
    if (perfil && Rota.ehCaminhao(perfil)) perguntarCarga(perfil);
    else comecar(perfil, null, null);
  }

  // Rota guardada pelo pacote offline (E3), no formato de C.rota.atual(). O perfil é o veículo ativo
  // (a rota guardada só tem o nome); é ele que vale no recálculo quando a internet voltar.
  function rotaGuardada() {
    const g = C.offline && typeof C.offline.rotaGuardada === "function" ? C.offline.rotaGuardada() : null;
    if (!g || !g.destino || !Array.isArray(g.coords) || g.coords.length < 2) return null;
    const ativo = C.veiculos && C.veiculos.ativo ? C.veiculos.ativo() : null;
    return { origem: g.origem, destino: g.destino, perfil: ativo, avisos: g.avisos || [], km: g.km, minutos: g.minutos,
      coords: g.coords, resposta: g.resposta || null, guardada: true, salvoEm: g.salvoEm, conferidaEm: g.conferidaEm || null,
      perfilNome: g.perfilNome || null };
  }
  function avisoGuardada(rota) {
    const quando = rota.salvoEm ? " (traçada às " + new Date(rota.salvoEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) + ")" : "";
    return "Sem internet: seguindo a rota guardada" + quando + (rota.perfilNome ? " para " + rota.perfilNome : "") +
      ", sem a escolha de carga." + (rota.resposta ? "" : " Sem as manobras: siga a linha da rota.");
  }

  // Redesenho: uma folha só. "Carregado" usa o peso total do campo (começa com o último peso carregado deste veículo ou o
  // PBTC do cadastro); "Vazio" NÃO pergunta nada: usa o peso vazio (tara) do cadastro do veículo (ou, de versões antigas,
  // o peso vazio guardado neste aparelho); sem ele, a rota vai sem peso e o aviso diz isso.
  function taraDe(perfil) {
    if (typeof perfil.tara === "number" && isFinite(perfil.tara)) return perfil.tara;
    const salvo = dados().taras[perfil.id];
    return typeof salvo === "number" && isFinite(salvo) ? salvo : null;
  }
  function perguntarCarga(perfil) {
    const d = dados();
    const ultimo = d.pesos && typeof d.pesos[perfil.id] === "number" ? d.pesos[perfil.id] : null;
    const inicial = ultimo != null ? ultimo : typeof perfil.pbtc === "number" ? perfil.pbtc : null;
    const campo = el("input"); campo.id = "nav-peso"; campo.inputMode = "decimal"; campo.autocomplete = "off"; campo.placeholder = "Ex.: 45";
    if (inicial != null) campo.value = String(inicial).replace(".", ",");
    const rotulo = el("label", "nav-peso-rotulo", "Peso total carregado (t)"); rotulo.htmlFor = "nav-peso"; rotulo.appendChild(campo);
    const erro = el("span", "erro"); erro.id = "nav-peso-erro";
    const escolha = el("div", "nav-escolha");
    const carregado = botao("Carregado", "btn btn-principal nav-grande", () => {
      const r = Nav.lerToneladas(campo.value);
      if (!r.ok) { erro.textContent = r.erro; campo.setAttribute("aria-invalid", "true"); return; }
      const dd = dados(); dd.pesos = dd.pesos && typeof dd.pesos === "object" ? dd.pesos : {};
      if (r.valor == null) delete dd.pesos[perfil.id]; else dd.pesos[perfil.id] = r.valor;
      gravar(dd);
      comecar(perfil, "carregado", r.valor);
    });
    const vazio = botao("Vazio", "btn nav-grande", () => comecar(perfil, "vazio", taraDe(perfil)));
    carregado.id = "nav-carregado"; vazio.id = "nav-vazio";
    escolha.append(carregado, vazio);
    const tara = taraDe(perfil);
    const dica = el("p", "nav-carga-dica", tara != null
      ? "Vazio usa o peso vazio do cadastro (" + String(tara).replace(".", ",") + " t)."
      : "Vazio: sem peso vazio no cadastro do veículo, a rota vai sem peso.");
    C.folha.abrir([el("h2", null, "Carregado ou vazio?"), escolha, rotulo, erro, dica, botao("Cancelar", "btn", C.folha.fechar)]);
  }

  function ajustador(escolha) {
    if (!escolha.carga) return undefined;
    return (pedido, faltando) => Object.assign(Nav.aplicarPeso(pedido, faltando, escolha.peso), { avisos: [escolha.aviso] });
  }

  async function comecar(perfil, carga, tara) {
    const pos = C.estado.ultimaPos;
    if (!pos) { C.folha.fechar(); C.mensagem("Ative o GPS para começar a navegação.", 6000); return; }
    const p = Nav.pesoParaRota(perfil, carga, tara);
    const escolha = { carga, peso: p.peso, aviso: p.aviso };
    const anterior = C.rota.atual() || rotaGuardada();
    if (!anterior) { C.folha.fechar(); return; }
    C.folha.abrir([el("h2", null, "Preparando a navegação…"), el("p", null, carga ? "Recalculando a rota " + (carga === "carregado" ? "carregado." : "vazio.") : "Calculando a rota.")]);
    let rota;
    try {
      rota = await C.rota.calcular({ origem: { lat: pos[1], lon: pos[0] }, destino: anterior.destino, perfil, ajustar: ajustador(escolha), enquadrar: false });
    } catch (e) {
      if (e.cancelada) return;
      if (e.rede && anterior) {
        rota = anterior;
        escolha.aviso = anterior.guardada ? avisoGuardada(anterior)
          : "Sem internet: seguindo a rota já traçada, calculada com o cadastro do veículo (sem a escolha de carga).";
        ativar(rota, perfil, escolha, { semRede: e.demorou ? "servidor" : "internet" });
        return;
      } else {
        const botoes = el("div", "linha-botoes");
        botoes.append(botao("Tentar de novo", "btn btn-principal", () => comecar(perfil, carga, tara)), botao("Cancelar", "btn", C.folha.fechar));
        C.folha.abrir([el("h2", null, "Não foi possível iniciar"), el("p", null, e.motivo || e.message), botoes]);
        return;
      }
    }
    ativar(rota, perfil, escolha);
  }

  // ------------------------------------------------------------ navegação ativa
  const aceitasPendentes = []; // restrições aceitas em "Mesmo assim" antes de a navegação começar
  function carregarRota(n, rota) {
    n.rota = rota;
    n.desviosViagem = Nav.mesclarDesvios(n.desviosViagem, rota.desvios); // resumo da viagem: desvios de restrição (r6)
    n.geo = Nav.prepararGeometria(rota.coords);
    // volta pela mesma rota (desenho invertido): as manobras da ida não valem; orientação mínima, sem curvas inventadas
    n.semCurvas = !!rota.invertida;
    n.manobras = n.semCurvas ? Nav.manobrasSemCurvas(n.geo, "ponto de origem", "Voltando pela mesma rota, sem as curvas. Siga pela rota destacada.")
      : Nav.extrairManobras(rota.resposta, n.geo);
    // quando esta rota foi conferida com o servidor de rotas (a invertida nunca foi)
    n.rotaEm = rota.invertida ? null : rota.conferidaEm || rota.calculadaEm || rota.salvoEm || null;
    n.marcoAntes = null; n.marcoInicio = null; n.fora = false;
    n.tempoTotalS = rota.minutos * 60;
    n.progresso = null;
    n.rastreador = Nav.criarRastreador(n.geo);
    n.anunciador = Nav.criarAnunciador();
    n.postDitos = new Set(); // "Continue por 40 quilômetros" já falados (por índice de manobra)
    if (n.marcos) n.marcos.novaRota(); else n.marcos = Nav.criarMarcosViagem();
    n.detector.zerar();
    n.ultimo = null;
  }

  function ativar(rota, perfil, escolha, extra) {
    geracao++;
    const g0 = C.estado.gps || null, p0 = C.estado.ultimaPos;
    nav = { id: geracao, perfil, escolha, destino: (extra && extra.destino) || rota.destino, detector: Nav.criarDetectorDesvio(), registro: Nav.criarRegistro(),
      ultimoRecalculo: null, recalculando: false, recalculo: null, ultimaFala: null, falouInicio: false,
      inicio: Date.now(), rotulo: (extra && extra.rotulo) || rota.rotulo || null, gravadoEm: 0, volta: !!(extra && extra.volta),
      inicioPos: g0 ? { lat: g0.lat, lon: g0.lon } : p0 ? { lat: p0[1], lon: p0[0] } : null,
      // rota offline: faixa, falta de rede, conferência com a internet e reentrada na linha
      conferidor: Nav.criarConferidor(), rotaOffline: false, conferidaEm: null, semRede: false, motivoSemRede: null,
      conferencia: null, fora: false, ultimaFalaReentrada: null, aceitas: aceitasPendentes.splice(0) };
    carregarRota(nav, rota);
    if (rota.guardada || rota.invertida) { nav.rotaOffline = true; nav.conferidaEm = nav.rotaEm; nav.conferidor.pedir(); }
    if (extra && extra.semRede) { marcarSemRede(nav, extra.semRede); nav.conferidor.falhou(Date.now()); }
    if (!online()) marcarSemRede(nav, "internet");
    // destino recente
    const d = dados();
    d.recentes = Nav.adicionarRecente(d.recentes, { lat: rota.destino.lat, lon: rota.destino.lon, rotulo: rotuloDestino(nav), t: Date.now() });
    gravar(d);
    gravarAndamento(nav, true);
    C.folha.fechar();
    $("app").classList.add("nav-ativa");
    $("nav-painel").hidden = false;
    nav.aviso = escolha.aviso || "";
    // lote 2: a nota de carga confirmatória ("Carregado: rota calculada com 45 t (PBTC do cadastro).") sai do topo: fica no ⓘ (e na folha
    // de planejamento); só o que é ALERTA (peso não informado, rota guardada/offline) aparece sozinho por ~8 s como antes
    mostrarAviso(/não foi informad|sem peso|guardada|offline|sem internet/i.test(nav.aviso));
    status("");
    $("nav-reentrada").hidden = true;
    faixa(nav);
    C.seguir(true);
    if (C.estado.gps && !gpsVelho()) aoPosicao(C.estado.gps);
    else { desenharPainel(null); if (C.estado.gps) semSinal(nav); }
    conferirSePreciso(nav);
  }

  // B6: o aviso de carga fica ~8 s no painel e depois só aparece ao tocar em "Aviso da rota" (ocupa espaço da manobra).
  // porToque: o motorista pediu (mostra mesmo com a faixa do alerta aberta).
  function mostrarAviso(ver, porToque) {
    const n = nav; clearTimeout(timerAviso); timerAviso = null;
    const tem = !!(n && n.aviso);
    $("nav-aviso").textContent = tem ? n.aviso : "";
    $("nav-aviso").classList.toggle("pedido", !!porToque);
    $("nav-aviso").hidden = !(tem && ver);
    $("nav-ver-aviso").hidden = !tem || ver;
    $("nav-ver-aviso").setAttribute("aria-expanded", String(tem && ver));
    if (tem && ver) timerAviso = setTimeout(() => { if (nav === n) mostrarAviso(false); }, AVISO_MS);
  }

  function gpsVelho() { try { return !!(C.gps && C.gps.velho()); } catch (e) { return false; } }

  function rotuloDestino(n) {
    if (n.rotulo) return n.rotulo;
    const m = n.manobras;
    for (let i = m.length - 1; i >= 0; i--) if (m[i].ruas && m[i].ruas.length) return m[i].ruas[0];
    const d = n.destino;
    return d.lat.toFixed(4).replace(".", ",") + ", " + d.lon.toFixed(4).replace(".", ",");
  }

  function velMsDe(gps) {
    if (typeof gps.velKmh === "number") return gps.velKmh / 3.6;
    if (typeof gps.kmh === "number") return gps.kmh / 3.6;
    return null;
  }

  function aoPosicao(gps) {
    if (!nav || !gps) return;
    const n = nav;
    if (n.semSinal) { // GPS voltou: retoma (sem contar a volta como saída da rota)
      n.semSinal = false; n.detector.zerar();
      status("");
    }
    if (!online() && !n.semRede) marcarSemRede(n, "internet");
    const velMs = velMsDe(gps);
    const pos = { lat: gps.lat, lon: gps.lon };
    n.registro.adicionar({ lat: gps.lat, lon: gps.lon, t: gps.t, velMs, precisao: gps.precisao });
    // A1: o rastreador decide se a leitura mexe no progresso (precisão, salto impossível, recuo confirmado);
    // M6: tempo longo desde a última leitura aceita (túnel) libera a busca na linha toda
    const proj = n.rastreador.atualizar({ lat: gps.lat, lon: gps.lon, precisao: gps.precisao, rumo: gps.rumo, velMs, t: gps.t });
    n.progresso = proj.progresso_m;
    // QA 3 (A1): não chega na leitura em que o progresso acabou de saltar; só numa leitura aceita sem salto
    if (proj.considerada && !proj.saltou && Nav.chegou(n.geo, pos, n.progresso)) { finalizar(true, { limpar: true }); return; }
    if (proj.considerada) {
      const naRota = proj.distancia_m <= VOLTOU_M;
      // A6: de volta à rota antiga durante o recálculo: desiste dele e segue a antiga
      if (n.recalculo && naRota) cancelarRecalculo(n);
      if (n.falhaRecalculo && naRota) { n.falhaRecalculo = false; status(""); }
      const fora = n.detector.atualizar({ distancia_m: proj.distancia_m, precisao: gps.precisao, velMs });
      if (n.semRede) {
        // sem internet: não tenta recalcular em laço; orienta a volta para a linha (a conferência tenta sozinha, com espera)
        if (fora || proj.distancia_m > LONGE_DA_LINHA_M) n.fora = true;
        else if (proj.distancia_m <= Math.max(VOLTOU_M, 2 * (gps.precisao || 0))) n.fora = false;
      } else {
        n.fora = false;
        if (fora && !n.recalculando && !n.conferencia) recalcular(n, gps);
      }
    }
    const sit = Nav.situacaoManobras(n.manobras, proj.indice, n.progresso);
    n.ultimo = { sit, velMs, proj, t: gps.t };
    desenharPainel(n.ultimo);
    orientarReentrada(n, gps);
    // A6: durante o recálculo da saída da rota, as manobras da rota antiga continuam enquanto a posição está perto dela
    if (ouvindo()) cortadaPelaEscuta(n);
    // B1 (QA 3): trocando o destino, as manobras da rota antiga continuam até a nova chegar.
    // Sem internet e longe da linha, as manobras dela não são faladas (a orientação é voltar para a linha).
    const longeOffline = n.fora && proj.distancia_m > ANUNCIA_RECALCULANDO_M;
    if (!longeOffline && (!n.recalculando || n.troca || (n.recalculo && proj.distancia_m <= ANUNCIA_RECALCULANDO_M))) anunciar(n, sit, velMs);
    if (proj.considerada) conversar(n, sit);
    // rota sem manobras (volta pela mesma rota): avisos de distância restante (… 20, 10, 5 km)
    if (n.semCurvas && proj.considerada && !n.fora) {
      const r = restanteM(n);
      if (n.marcoInicio == null) n.marcoInicio = r;
      const m = Nav.marcoRestante(n.marcoAntes, r, n.marcoInicio);
      n.marcoAntes = r;
      if (m) falarConversa(Nav.textoMarco(m));
    }
    gravarAndamento(n, false);
    emitir(n);
    conferirSePreciso(n);
  }

  function restanteM(n) { return Math.max(0, n.geo.total - (n.progresso || 0)); }
  // manobra_m: distância até a próxima manobra (null sem manobra à frente); ui/mapa.js recentraliza o mapa a ≤ 300 m
  function emitir(n) { C.emit("navegacao", { ativa: true, progresso_m: n.progresso || 0, restante_m: restanteM(n), coords: n.geo.coords,
    manobra_m: n.ultimo && n.ultimo.sit.proxima >= 0 && n.ultimo.sit.distancia_m != null ? n.ultimo.sit.distancia_m : null }); }

  // ------------------------------------------------------------ painel
  function desenharPainel(u) {
    const n = nav; if (!n) return;
    faixa(n);
    const m = u && u.sit.proxima >= 0 ? n.manobras[u.sit.proxima] : (n.manobras[1] || n.manobras[0] || null);
    $("nav-icone").textContent = m && !m.semCurvas ? Nav.icone(m.tipo) : "↑";
    $("nav-dist").textContent = u && u.sit.distancia_m != null ? Nav.formatarDistancia(u.sit.distancia_m) : "--";
    $("nav-instrucao").textContent = m ? m.instrucao : "Siga a rota destacada.";
    const ruas = m && m.ruas && m.ruas.length ? m.ruas.join(" / ") : "";
    $("nav-rua").textContent = ruas; $("nav-rua").hidden = !ruas;
    // lote 2: a instrução já traz o nome da via ("Vire à direita na SP-330."): a linha da via não repete (fica no DOM, fora da vista e
    // do leitor de tela; aparece sozinha quando a instrução não cita a via ou cita só parte dela)
    { const ins = ($("nav-instrucao").textContent || "").toLowerCase(); const nomes = m && m.ruas ? m.ruas : [];
      const redundante = nomes.length > 0 && nomes.every((r) => ins.indexOf(String(r).toLowerCase()) >= 0);
      $("nav-rua").classList.toggle("redundante", redundante); $("nav-rua").setAttribute("aria-hidden", String(redundante)); }
    if (C.faixas && C.faixas.desenhar) C.faixas.desenhar(m, n.rota); // faixas e "Saída km N" (ui/faixas.js); sem dado, nada aparece
    const s = u && u.sit.seguinte >= 0 ? n.manobras[u.sit.seguinte] : null;
    $("nav-seguinte").textContent = s ? "Depois: " + s.instrucao : ""; $("nav-seguinte").hidden = !s;
    const prog = n.progresso || 0;
    const restS = Nav.tempoRestanteS(n.manobras, prog, n.geo.total, n.tempoTotalS);
    $("nav-restante").textContent = Nav.formatarDistancia(restanteM(n)) + " · " + Nav.formatarDuracao(restS);
    $("nav-chegada").textContent = Nav.textoChegada(Date.now(), restS);
  }

  function status(texto) { const e = $("nav-status"); e.textContent = texto; e.hidden = !texto; }

  // ------------------------------------------------------------ rota offline: faixa, reentrada e conferência
  // Faixa "Rota offline · conferida …" enquanto a navegação usa a rota guardada (ou a da sessão, sem internet)
  function faixa(n) {
    const f = $("nav-offline");
    if (!n || nav !== n || !n.rotaOffline) { f.hidden = true; return; }
    f.textContent = Nav.textoFaixaOffline({ conferidaEm: n.conferidaEm, conferindo: !!n.conferencia, agora: Date.now() }) +
      (n.rota && n.rota.invertida ? " · volta pela mesma rota" : "");
    f.hidden = false;
  }
  // Sem rede (navigator offline, ou o servidor de rotas não respondeu): a rota em uso passa a ser offline e a conferência
  // fica pendente (tenta quando a internet voltar, ou depois da espera).
  function marcarSemRede(n, motivo) {
    if (!n) return;
    n.semRede = true;
    n.motivoSemRede = !online() ? "internet" : motivo || n.motivoSemRede || "internet";
    if (!n.rotaOffline) { n.rotaOffline = true; n.conferidaEm = n.rotaEm; }
    n.conferidor.pedir();
    faixa(n);
  }
  // Fora da linha sem internet: estado claro, distância e seta até o ponto da linha à frente; voz no máximo a cada ~60 s
  function orientarReentrada(n, gps) {
    const caixa = $("nav-reentrada");
    if (!n || nav !== n || !n.fora || !n.semRede || !gps || n.semSinal) {
      if (!caixa.hidden) { caixa.hidden = true; if (n && !n.semSinal && !n.recalculando && !n.falhaRecalculo) status(""); }
      return;
    }
    const r = Nav.pontoReentrada(n.geo, { lat: gps.lat, lon: gps.lon }, n.progresso);
    const v = velMsDe(gps);
    const rumoV = typeof gps.rumo === "number" && isFinite(gps.rumo) && v != null && v > 1 ? gps.rumo : null;
    const t = Nav.textoReentrada(r, rumoV, n.motivoSemRede);
    status(t.status);
    $("nav-reentrada-texto").textContent = t.detalhe;
    $("nav-seta").style.transform = r ? "rotate(" + Math.round(r.rumo) + "deg)" : "";
    $("nav-seta").setAttribute("aria-label", r ? "Linha ao " + Nav.textoRumo(r.rumo) : "Linha");
    caixa.hidden = false;
    n.reentrada = r;
    const tf = typeof gps.t === "number" && isFinite(gps.t) ? gps.t : Date.now();
    if (Nav.podeFalarReentrada(tf, n.ultimaFalaReentrada)) { n.ultimaFalaReentrada = tf; falarConversa(t.fala); }
  }
  function conferirSePreciso(n) {
    if (!n || nav !== n || !(n.rotaOffline || n.semRede) || n.recalculando || n.conferencia) return;
    if (!n.conferidor.deveConferir(Date.now(), online())) return;
    const gps = C.estado.gps;
    if (!gps) return;
    conferir(n, gps);
  }
  // Pede a rota da posição atual ao destino (mesmo veículo e carga). Volta sem curvas, fora da linha ou rota sem
  // manobras: troca sempre (é a rota de verdade). Senão, troca só se diferir (Nav.compararRotas); igual: "conferida agora".
  async function conferir(n, gps) {
    const ctl = new AbortController();
    n.conferencia = ctl; n.conferidor.iniciou();
    faixa(n);
    const meu = () => nav === n && n.conferencia === ctl;
    let ok = false;
    try {
      const nova = await C.rota.calcular({ origem: { lat: gps.lat, lon: gps.lon }, destino: n.destino, perfil: n.perfil, ajustar: ajustador(n.escolha),
        enquadrar: false, sinal: ctl.signal, tempoLimiteMs: RECALCULO_LIMITE_MS, consultar: true });
      if (!meu()) return;
      ok = true;
      n.semRede = false; n.motivoSemRede = null; n.falhaRecalculo = false;
      const trocar = n.semCurvas || !n.manobras.length || n.fora || Nav.compararRotas(n.geo, n.progresso, nova.coords).difere;
      n.conferencia = null;
      if (trocar) {
        C.rota.usar(nova);
        carregarRota(n, nova);
        n.falouInicio = true; n.rotaOffline = false; n.ultimoRecalculo = gps.t;
        status(""); $("nav-reentrada").hidden = true;
        gravarAndamento(n, true);
        C.mensagem("Rota atualizada com a internet.", 6000);
        falarConversa("Rota atualizada com a internet.");
      } else {
        n.conferidaEm = Date.now();
        // a da sessão, conferida, deixa de ser "offline"; a guardada continua sendo, agora "conferida agora"
        if (!n.rota.guardada) n.rotaOffline = false;
        else if (C.offline && C.offline.marcarConferida) C.offline.marcarConferida(n.conferidaEm);
        C.mensagem("Rota conferida com a internet: continua a mesma.", 6000);
      }
      faixa(n);
      if (C.estado.gps && !gpsVelho()) aoPosicao(C.estado.gps);
    } catch (e) {
      if (!meu() || e.cancelada) return;
      if (e.rede) marcarSemRede(n, e.demorou ? "servidor" : "internet");
    } finally {
      if (n.conferencia === ctl) n.conferencia = null;
      n.conferidor.terminou(ok, Date.now());
      if (nav === n) faixa(n);
    }
  }
  function pararConferencia(n) {
    const ctl = n && n.conferencia; if (!ctl) return;
    n.conferencia = null;
    try { ctl.abort(); } catch (e) { /* ignora */ }
  }

  // B2: leitura velha. O painel avisa e nada é anunciado com posição errada; a próxima leitura retoma.
  function semSinal(n) {
    if (!n || n.semSinal) return;
    n.semSinal = true;
    clearTimeout(timerRetomada); timerRetomada = null;
    status("Sem sinal de GPS. A orientação volta quando o sinal voltar.");
    $("nav-dist").textContent = "--";
  }

  // ------------------------------------------------------------ voz
  function vozEmAlerta() { try { return !!C.voz.emAlerta(); } catch (e) { return false; } }
  // M3 (QA 3): microfone do "Falar" ouvindo (pacote de comandos; pode não existir)
  function ouvindo() { try { return !!(C.comandos && C.comandos.ouvindo && C.comandos.ouvindo()); } catch (e) { return false; } }
  // depois de uma manobra cortada, a repetição espera a fala que a cortou acabar (resposta do comando, por exemplo)
  function outraFalando() { try { return !!(C.voz.falando && C.voz.falando()); } catch (e) { return false; } }
  function vozOcupada(n) { return vozEmAlerta() || ouvindo() || !!(n && n.esperarFala && outraFalando()); }

  // Fala de manobra: enquanto a frase do alerta toca ou o microfone ouve, não fala (nem corta o alerta, nem entra na
  // escuta) e tenta de novo logo depois. forcar: pedido do motorista ("repete"), só o alerta segura.
  // critica ("agora", a manobra de agora): o microfone aberto ou surdo não a emudece. Só o alerta de segurança a segura;
  // ui/voz.js aborta a escuta e fala.
  function falar(texto, manobra, forcar, critica) {
    if (!texto) return false;
    if (forcar || critica ? vozEmAlerta() : vozOcupada(nav)) { agendarRetomada(); return false; }
    if (nav) nav.esperarFala = false;
    const fala = { texto, inicio: Date.now(), fimEm: null, manobra: manobra || null };
    C.voz.falar(texto, { manobra: true, critica: !!critica, aoTerminar: () => { fala.fimEm = Date.now(); } });
    if (nav) { nav.ultimaFala = texto; nav.falaAtual = fala; }
    return true;
  }
  // Falas que não são orientação (B7): esperam o alerta acabar, nunca o interrompem.
  function falarNaoCritico(texto) { C.voz.falar(texto, { naoInterromper: true }); }
  // Conversa pelo caminho (marcos, "Continue por…", reentrada, rota atualizada): no modo "Só alertas" não sai.
  function falarConversa(texto) { C.voz.falar(texto, { naoInterromper: true, conversa: true }); }
  // Chegada: segurança. Não é descartada por tempo na fila e aborta o microfone aberto.
  function falarCritico(texto) { C.voz.falar(texto, { naoInterromper: true, critica: true }); }
  function ehCaminhao(n) { return !!(n && n.perfil && Rota.ehCaminhao(n.perfil)); }

  function agendarRetomada() {
    if (timerRetomada) return;
    timerRetomada = setTimeout(() => {
      timerRetomada = null;
      const n = nav;
      if (!n || !n.ultimo || n.semSinal || gpsVelho()) return;
      if (n.recalculando && !n.troca && !(n.recalculo && n.ultimo.proj.distancia_m <= ANUNCIA_RECALCULANDO_M)) return;
      if (ouvindo()) cortadaPelaEscuta(n);
      if (vozOcupada(n)) { agendarRetomada(); return; }
      anunciar(n, n.ultimo.sit, n.ultimo.velMs);
    }, 150);
  }

  // O alerta abriu e cortou uma orientação que estava sendo falada: ela volta depois da frase do alerta.
  function alertaCortou(n) {
    const f = n && n.falaAtual;
    if (!f || !f.manobra) return;
    const agora = Date.now(), previsto = 1000 + 70 * f.texto.length;
    const cortada = f.fimEm == null ? agora - f.inicio < previsto : agora - f.fimEm < 150 && f.fimEm - f.inicio < 55 * f.texto.length;
    if (!cortada) return;
    desfazerFala(n, f);
  }
  function desfazerFala(n, f) {
    n.falaAtual = null;
    n.anunciador.desfazer(f.manobra.indice, f.manobra.antes);
    if (f.manobra.inicio) n.falouInicio = false;
    agendarRetomada();
  }
  // M3 (QA 3): outra fala (resposta de um comando de voz) cortou a orientação: repete a etapa quando ela acabar.
  // Quem decide que ela ainda tocava é o ui/voz.js (antes de começar a outra); o fim dela chega junto com o corte.
  function manobraCortada(n, d) {
    const f = n && n.falaAtual;
    if (!f || !f.manobra || (d && d.texto && d.texto !== f.texto)) return;
    n.esperarFala = true;
    desfazerFala(n, f);
  }
  // M3: o microfone abriu com a orientação ainda tocando (o aparelho corta o som ao ouvir): ela é repetida depois
  function cortadaPelaEscuta(n) {
    const f = n && n.falaAtual;
    if (!f || !f.manobra) return;
    const previsto = 1000 + 70 * f.texto.length;
    const tocando = f.fimEm == null ? Date.now() - f.inicio < previsto : f.fimEm - f.inicio < 55 * f.texto.length && Date.now() - f.fimEm < 1500;
    if (tocando) desfazerFala(n, f);
  }

  function anunciar(n, sit, velMs) {
    if (n.semSinal) return;
    const cam = ehCaminhao(n);
    if (!n.falouInicio) {
      // início: fala só a primeira instrução e dá por dita a etapa em que a próxima manobra já está (menos o "agora")
      if (vozOcupada(n)) { agendarRetomada(); return; }
      n.falouInicio = true;
      let marcada = null;
      if (sit.proxima >= 0) {
        const e = n.anunciador.avaliar(sit.proxima, sit.distancia_m, velMs, n.manobras[sit.proxima].destino, cam);
        if (e && e !== "agora") { marcada = { indice: sit.proxima, antes: n.anunciador.dito(sit.proxima), inicio: true }; n.anunciador.marcar(sit.proxima, e); }
      }
      // "Navegação iniciada. Siga pela <via> por N quilômetros." (volta sem curvas: a frase própria dela)
      const inicio = n.semCurvas && n.manobras[0] ? n.manobras[0].pre : Nav.textoInicio(n.manobras);
      falar(inicio, marcada || { indice: -1, antes: null, inicio: true });
      return;
    }
    if (sit.proxima < 0) return;
    const m = n.manobras[sit.proxima];
    // destino com lado: a 2 km avisa "Em 2 quilômetros, destino à direita" (em qualquer velocidade, uma vez)
    if (m.destino && m.lado && sit.distancia_m <= 2000 && n.anunciador.dito(sit.proxima) == null) {
      if (falar(Nav.textoAnuncio(m, sit.distancia_m, "longe", 2000), { indice: sit.proxima, antes: null })) n.anunciador.marcar(sit.proxima, "longe");
      return;
    }
    const etapa = n.anunciador.avaliar(sit.proxima, sit.distancia_m, velMs, m.destino, cam);
    if (!etapa) return;
    const antes = n.anunciador.dito(sit.proxima);
    // "agora" é crítica: o microfone aberto (ou surdo) não a emudece
    if (falar(Nav.textoAnuncio(m, sit.distancia_m, etapa, Nav.limiarEtapa(velMs, etapa, cam)), { indice: sit.proxima, antes }, false, etapa === "agora")) n.anunciador.marcar(sit.proxima, etapa);
  }

  // Conversa pelo caminho (rodada 2 de voz): "Continue por 40 quilômetros" depois da manobra num trecho longo e o marco
  // "Faltam N quilômetros, chegada às HH:MM" a cada 30 min ou 50 km. Só com a voz livre (sem alerta, manobra, resposta
  // de comando ou microfone) e sem manobra falada há menos de 15 s; o que não coube fica para a próxima leitura.
  function conversar(n, sit) {
    if (!n.falouInicio || n.recalculando || n.semSinal || n.semCurvas || n.fora) return;
    const agora = Date.now();
    const livre = !alertaAberto && !vozOcupada(n) && !outraFalando() && !(n.falaAtual && agora - n.falaAtual.inicio < folgaManobraMs());
    const prog = n.progresso || 0;
    if (livre) {
      const p = Nav.posTransicao(n.manobras, sit, prog, n.postDitos);
      if (p) { n.postDitos.add(p.indice); falarConversa(p.texto); return; }
    }
    const restS = Nav.tempoRestanteS(n.manobras, prog, n.geo.total, n.tempoTotalS);
    const txt = n.marcos.avaliar({ agoraMs: agora, progressoM: prog, restanteM: restanteM(n), restanteS: restS,
      proximaManobraM: sit.proxima >= 0 ? sit.distancia_m : null, ocupado: !livre });
    if (txt) falarConversa(txt);
  }

  // "Quando eu chego" / "quanto falta": navegando, pelo que falta; com a rota só traçada, pela rota; senão null.
  function textoViagem(tipo) {
    const n = nav;
    if (n && n.geo) {
      const restS = Nav.tempoRestanteS(n.manobras, n.progresso || 0, n.geo.total, n.tempoTotalS);
      return Nav.textoViagem(tipo, restanteM(n), restS, Date.now());
    }
    const r = C.rota && C.rota.atual ? C.rota.atual() : null;
    if (r && isFinite(r.km) && isFinite(r.minutos)) return "Pela rota traçada: " + Nav.textoViagem(tipo, r.km * 1000, r.minutos * 60, Date.now()).replace(/^./, (c) => c.toLowerCase());
    return null;
  }

  // Devolve true se repetiu a orientação. Com alerta aberto, não atende: o pacote de voz repete o alerta.
  function repetir() {
    if (!nav || alertaAberto) return false;
    const u = nav.ultimo;
    if (u && u.sit.proxima >= 0) {
      const m = nav.manobras[u.sit.proxima];
      const agora = Nav.etapasAnuncio(u.velMs).find((e) => e.id === "agora").m;
      return falar(Nav.textoAnuncio(m, u.sit.distancia_m, u.sit.distancia_m <= agora && !m.destino ? "agora" : "perto"), null, true);
    }
    return nav.ultimaFala ? falar(nav.ultimaFala, null, true) : false;
  }
  function atender(d) { if (d && typeof d.atender === "function") d.atender(); }

  // ------------------------------------------------------------ recálculo
  // Sem rede (antes de pedir ou porque o pedido caiu): entra no modo offline — reentrada na linha e conferência com espera
  function semInternet(n, motivo) {
    marcarSemRede(n, motivo || "internet");
    n.fora = true;
    orientarReentrada(n, C.estado.gps);
  }

  // A6: o recálculo tem tempo-limite de 10 s e pode ser cancelado (motorista voltou para a rota antiga). Enquanto
  // ele não chega, a rota antiga continua valendo (painel e manobras).
  async function recalcular(n, gps) {
    if (!Nav.podeRecalcular(gps.t, n.ultimoRecalculo)) return;
    n.ultimoRecalculo = gps.t;
    n.detector.zerar();
    if (navigator.onLine === false) { semInternet(n); return; }
    const ctl = new AbortController();
    n.recalculando = true; n.recalculo = ctl;
    status("Recalculando…");
    falarNaoCritico("Recalculando.");
    const meu = () => nav === n && n.recalculo === ctl;
    try {
      const rota = await C.rota.calcular({ origem: { lat: gps.lat, lon: gps.lon }, destino: n.destino, perfil: n.perfil,
        ajustar: ajustador(n.escolha), enquadrar: false, sinal: ctl.signal, tempoLimiteMs: RECALCULO_LIMITE_MS });
      if (!meu()) return;
      carregarRota(n, rota);
      n.falouInicio = true;
      n.semRede = false; n.rotaOffline = false;
      status(""); $("nav-reentrada").hidden = true; faixa(n);
      n.recalculando = false; n.recalculo = null;
      gravarAndamento(n, true);
      if (C.estado.gps && !gpsVelho()) aoPosicao(C.estado.gps);
    } catch (e) {
      if (!meu() || e.cancelada) return;
      // sem rede ou servidor calado: modo offline (sem novo "Recalculando" em laço; a conferência tenta com espera)
      if (e.rede) { n.recalculando = false; n.recalculo = null; n.conferidor.falhou(Date.now()); semInternet(n, e.demorou ? "servidor" : "internet"); }
      else { n.falhaRecalculo = true; status("Não foi possível recalcular. Siga a rota destacada."); C.mensagem(e.motivo || e.message, 8000); }
    } finally { if (n.recalculo === ctl) { n.recalculando = false; n.recalculo = null; } }
  }
  function cancelarRecalculo(n) {
    const ctl = n.recalculo; if (!ctl) return;
    n.recalculo = null; n.recalculando = false;
    try { ctl.abort(); } catch (e) { /* ignora */ }
    status("");
  }

  // Adota uma rota já calculada para o MESMO destino (desvio por restrição, ui/desvio.js): sem mensagem de "destino trocado".
  function adotarRota(rota) {
    const n = nav;
    if (!n || !rota || !rota.coords) return false;
    cancelarRecalculo(n); pararConferencia(n);
    if (n.troca) { try { n.troca.abort(); } catch (e) { /* ignora */ } n.troca = null; }
    n.recalculando = false;
    const gps = C.estado.gps;
    if (C.rota && C.rota.usar) C.rota.usar(rota); // o mapa passa a mostrar (e C.rota.atual() a ser) a rota nova
    carregarRota(n, rota);
    n.fora = false; n.semRede = false; n.rotaOffline = false; n.volta = false;
    if (gps) n.ultimoRecalculo = gps.t;
    $("nav-reentrada").hidden = true; faixa(n);
    gravarAndamento(n, true);
    status("");
    if (C.estado.gps && !gpsVelho()) aoPosicao(C.estado.gps);
    return true;
  }

  // ------------------------------------------------------------ trocar o destino com a navegação andando (A2)
  // destino: { lat, lon, rotulo? }. Recalcula da posição atual com o mesmo veículo e carga; sem internet ou com erro,
  // avisa e continua para o destino anterior.
  async function trocarDestino(destino) {
    const n = nav;
    if (!n || !destino) return false;
    const gps = C.estado.gps;
    if (!gps || gpsVelho()) { C.mensagem("Sem sinal de GPS: não dá para trocar o destino agora.", 6000); return false; }
    const nome = destino.rotulo || "o novo destino";
    cancelarRecalculo(n); pararConferencia(n);
    if (n.troca) { try { n.troca.abort(); } catch (e) { /* ignora */ } n.troca = null; }
    if (navigator.onLine === false) { C.mensagem("Sem internet: o destino continua o mesmo.", 6000); falarNaoCritico("Sem internet. O destino continua o mesmo."); return false; }
    // B1 (QA 3): mesmo tempo-limite do recálculo (10 s) e, até a rota nova chegar, as manobras da antiga continuam
    // (n.troca); a saída da rota não dispara outro recálculo para o destino antigo (n.recalculando)
    const ctl = new AbortController();
    n.recalculando = true; n.troca = ctl;
    const meu = () => nav === n && n.troca === ctl;
    status("Recalculando para " + nome + "…");
    try {
      const rota = await C.rota.calcular({ origem: { lat: gps.lat, lon: gps.lon }, destino: { lat: destino.lat, lon: destino.lon },
        perfil: n.perfil, ajustar: ajustador(n.escolha), enquadrar: false, sinal: ctl.signal, tempoLimiteMs: RECALCULO_LIMITE_MS });
      if (!meu()) return false;
      n.troca = null;
      // o pino do destino no mapa vai junto (sem a folha "Destino escolhido": a navegação continua)
      C.rota.definirDestino({ lat: destino.lat, lng: destino.lon }, { rotulo: destino.rotulo || null });
      C.folha.fechar();
      n.destino = rota.destino;
      n.rotulo = destino.rotulo || null;
      carregarRota(n, rota);
      n.falouInicio = true; n.semRede = false; n.rotaOffline = false; n.volta = false; n.ultimoRecalculo = gps.t;
      $("nav-reentrada").hidden = true; faixa(n);
      const d = dados();
      d.recentes = Nav.adicionarRecente(d.recentes, { lat: destino.lat, lon: destino.lon, rotulo: rotuloDestino(n), t: Date.now() });
      gravar(d);
      gravarAndamento(n, true);
      status("");
      C.mensagem("Destino trocado: " + nome + ".", 6000);
      falarNaoCritico("Destino trocado para " + nome + ".");
      n.recalculando = false;
      if (C.estado.gps && !gpsVelho()) aoPosicao(C.estado.gps);
      return true;
    } catch (e) {
      if (!meu() || e.cancelada) return false;
      status("");
      C.mensagem((e.demorou ? "O servidor de rotas não respondeu" : e.rede ? "Sem internet" : (e.motivo || e.message)) + ": o destino continua o mesmo.", 8000);
      return false;
    } finally {
      if (n.troca === ctl) n.troca = null;
      if (!n.troca && !n.recalculo) n.recalculando = false;
    }
  }

  // ------------------------------------------------------------ parada intermediária com a navegação andando (rodada 6)
  // Chamada por Copiloto.rota.adicionarParada (que já guardou a parada na viagem): recalcula daqui, passando pelo posto até o
  // MESMO destino, com o mesmo veículo e carga. Sem internet ou erro: avisa e a rota anterior continua. Devolve true se trocou.
  async function adicionarParada() {
    const n = nav;
    if (!n) return false;
    const gps = C.estado.gps;
    if (!gps || gpsVelho()) { C.mensagem("Sem sinal de GPS: não dá para acrescentar a parada agora.", 6000); return false; }
    cancelarRecalculo(n); pararConferencia(n);
    if (n.troca) { try { n.troca.abort(); } catch (e) { /* ignora */ } n.troca = null; }
    if (navigator.onLine === false) { C.mensagem("Sem internet: a rota continua a mesma, sem a parada.", 6000); falarNaoCritico("Sem internet. A rota continua a mesma."); return false; }
    const ctl = new AbortController();
    n.recalculando = true; n.troca = ctl;
    const meu = () => nav === n && n.troca === ctl;
    status("Acrescentando a parada…");
    try {
      const rota = await C.rota.calcular({ origem: { lat: gps.lat, lon: gps.lon }, destino: n.destino, perfil: n.perfil, ajustar: ajustador(n.escolha),
        enquadrar: false, sinal: ctl.signal, tempoLimiteMs: RECALCULO_LIMITE_MS });
      if (!meu()) return false;
      n.troca = null;
      carregarRota(n, rota);
      n.falouInicio = true; n.semRede = false; n.rotaOffline = false; n.volta = false; n.ultimoRecalculo = gps.t;
      $("nav-reentrada").hidden = true; faixa(n);
      gravarAndamento(n, true);
      status("");
      C.mensagem("Parada acrescentada. O destino continua o mesmo.", 6000);
      falarNaoCritico("Parada acrescentada.");
      n.recalculando = false;
      if (C.estado.gps && !gpsVelho()) aoPosicao(C.estado.gps);
      return true;
    } catch (e) {
      if (!meu() || e.cancelada) return false;
      status("");
      C.mensagem((e.demorou ? "O servidor de rotas não respondeu" : e.rede ? "Sem internet" : (e.motivo || e.message)) + ": a rota continua a mesma, sem a parada.", 8000);
      return false;
    } finally {
      if (n.troca === ctl) n.troca = null;
      if (!n.troca && !n.recalculo) n.recalculando = false;
    }
  }

  // ------------------------------------------------------------ fim: chegada ou encerrar
  // opcoes.limpar: tira a rota da sessão do mapa (chegada). Na chegada a rota guardada (E3) NÃO é apagada: vira "última
  // rota" (linha tracejada marcada, "Voltar pela mesma rota" e "Limpar rota"). "Encerrar" (confirmado) mantém a rota no
  // mapa e guardada (A4), com "Retomar navegação" e "Limpar rota" no resumo.
  function finalizar(chegada, opcoes) {
    const n = nav; if (!n) return;
    const limpar = !!(opcoes && opcoes.limpar);
    nav = null;
    if (n.recalculo) { try { n.recalculo.abort(); } catch (e) { /* ignora */ } n.recalculo = null; }
    if (n.troca) { try { n.troca.abort(); } catch (e) { /* ignora */ } n.troca = null; }
    if (n.conferencia) { try { n.conferencia.abort(); } catch (e) { /* ignora */ } n.conferencia = null; }
    $("nav-offline").hidden = true; $("nav-reentrada").hidden = true;
    apagarAndamento();
    clearTimeout(timerRetomada); timerRetomada = null; clearTimeout(timerAviso); timerAviso = null;
    $("app").classList.remove("nav-ativa");
    $("nav-painel").hidden = true;
    const r = n.registro.resumo();
    const viagem = Object.assign({ id: C.util.novoId(), chegou: !!chegada, destino: rotuloDestino(n),
      veiculo: n.perfil ? n.perfil.nome : null, carga: n.escolha.carga, data: Date.now(),
      desvios: Nav.listaCompacta(n.desviosViagem), aceitas: n.aceitas || [] }, r);
    const d = dados(); d.viagens = Nav.adicionarViagem(d.viagens, viagem, 20); gravar(d);
    C.emit("navegacao", { ativa: false, progresso_m: n.progresso || 0, restante_m: restanteM(n), coords: n.geo.coords });
    if (chegada) falarCritico("Você chegou.");
    // chegada: a rota guardada vira "última rota" ANTES de limpar a da sessão (assim o "rota-limpa" não a apaga)
    if (chegada) marcarUltima(n);
    if (limpar) C.rota.limpar();
    const retomar = !limpar && C.rota.atual() ? { perfil: n.perfil, escolha: n.escolha, rotulo: n.rotulo } : null;
    const ultima = chegada && C.offline && C.offline.ultimaRota ? C.offline.ultimaRota() : null;
    mostrarResumo(viagem, chegada ? "Você chegou" : "Navegação encerrada", retomar, ultima);
  }

  // A rota guardada desta viagem vira "última rota" (7 dias). sentido: "ida" se andou no sentido do desenho guardado,
  // "volta" se andou no inverso (voltar de novo = sentido do desenho, com as manobras).
  function marcarUltima(n) {
    try {
      const g = C.offline && C.offline.rotaGuardada ? C.offline.rotaGuardada() : null;
      if (!g || !C.offline.marcarUltima) return;
      const deste = n.rota.invertida ? n.rota.salvoEm === g.salvoEm : !!(g.destino && Nav.distanciaM(g.destino, n.destino) < 100);
      if (!deste) return;
      const p = n.inicioPos || (n.rota.invertida ? null : g.origem) || null;
      C.offline.marcarUltima({ chegouEm: Date.now(), sentido: n.rota.invertida ? "volta" : "ida", voltarPara: p ? { lat: p.lat, lon: p.lon } : null,
        rotulo: rotuloDestino(n), perfilId: n.perfil ? n.perfil.id : null, carga: n.escolha.carga || null, peso: n.escolha.peso == null ? null : n.escolha.peso });
    } catch (e) { /* ignora */ }
  }

  // "Voltar pela mesma rota" (última rota): sem internet, a linha guardada no sentido inverso, sem manobras (nunca
  // inventadas); com internet, a conferência pede a rota de volta de verdade (mesmo veículo e carga) e troca na hora.
  function voltar() {
    if (nav) { C.folha.fechar(); return false; }
    const g = rotaGuardada();
    const u = C.offline && C.offline.ultimaRota ? C.offline.ultimaRota() : null;
    if (!g || !u) { C.mensagem("Não há última rota guardada para voltar.", 6000); return false; }
    if (!C.estado.ultimaPos) { C.mensagem("Ative o GPS para voltar pela mesma rota.", 6000); return false; }
    const lista = C.veiculos && C.veiculos.lista ? C.veiculos.lista() : [];
    const perfil = lista.find((v) => v.id === u.perfilId) || g.perfil;
    let rota;
    if (u.sentido === "volta") rota = Object.assign({}, g, { perfil }); // a última foi a volta: agora é o sentido do desenho
    else rota = Object.assign(Nav.inverterRota(g), { salvoEm: g.salvoEm, perfil, perfilNome: g.perfilNome });
    const aviso = rota.invertida
      ? "Voltando pela mesma rota: a linha destacada no sentido contrário. Sem internet, sem as curvas faladas; com internet, a rota de volta é calculada de verdade."
      : avisoGuardada(rota);
    const destino = u.voltarPara && isFinite(u.voltarPara.lat) ? u.voltarPara : rota.destino;
    ativar(rota, perfil, { carga: u.carga || null, peso: u.peso == null ? null : u.peso, aviso }, { rotulo: "Ponto de origem", destino, volta: true });
    return true;
  }

  // A4: "Encerrar" no painel pede confirmação (um toque sem querer, dirigindo, não acaba a navegação).
  // M2 (QA 3): "cancela a rota" pela voz faz a mesma pergunta (o reconhecimento pode ter entendido errado); "Sim"
  // encerra como o botão, sem apagar a rota do mapa nem a guardada.
  function confirmarEncerrar(porVoz) {
    if (!nav) return;
    const n = nav;
    const escolha = el("div", "nav-escolha");
    const sim = botao("Sim", "btn nav-grande nav-sim", () => { if (nav === n) finalizar(false); else C.folha.fechar(); });
    const nao = botao("Não", "btn btn-principal nav-grande", C.folha.fechar);
    sim.id = "nav-encerrar-sim"; nao.id = "nav-encerrar-nao";
    escolha.append(nao, sim);
    C.folha.abrir([el("h2", null, "Encerrar navegação?"), el("p", null, "A rota continua no mapa."), escolha]);
    if (porVoz === true) falarNaoCritico("Encerrar a navegação? Confirme na tela.");
  }

  function blocoResumo(v) {
    const caixa = el("dl", "nav-resumo");
    // Lote 4: cada medida vira um bloco (rótulo pequeno + número grande, tabular); só o que o GPS registrou, sem custo em R$
    for (const [rotulo, valor] of Nav.linhasResumo(v)) { const b = el("div", "nav-resumo-item"); b.append(el("dt", null, rotulo), el("dd", null, valor)); caixa.append(b); }
    return caixa;
  }
  // "↪ 2 desvios de restrição evitadas (7 km a mais)" + lista curta; "⚠ 1 restrição mantida por decisão sua"
  function blocoDesvios(v) {
    const r = Nav.resumoDesvios(v && v.desvios, v && v.aceitas);
    if (!r) return null;
    const caixa = el("div", "nav-desvios"); caixa.id = "nav-resumo-desvios";
    if (r.linha) {
      const bl = el("div", "nav-desvios-bloco");
      const topo = el("div", "nav-desvios-topo"); topo.append(el("h3", null, "Desvios de restrição"), el("span", "nav-desvios-km", "+" + r.extraKm + " km"));
      bl.append(topo, el("p", "nav-desvios-linha", r.linha));
      const ul = el("ul", "nav-desvios-lista"); for (const t of r.itens) ul.append(el("li", null, t)); bl.append(ul); caixa.append(bl);
    }
    if (r.linhaAceitas) {
      const bl = el("div", "nav-desvios-bloco nav-desvios-atencao");
      bl.append(el("h3", null, "Restrição mantida por decisão do motorista"), el("p", "nav-desvios-aceitas", r.linhaAceitas)); caixa.append(bl);
    }
    return caixa;
  }

  function mostrarResumo(v, titulo, retomar, ultima) {
    const itens = [el("h2", null, titulo), el("p", "nav-registrado", "Registrado pelo GPS do aparelho (não é estimativa)."), blocoResumo(v)];
    const bd = blocoDesvios(v); if (bd) itens.push(bd);
    if (v.leituras < 3) itens.push(el("p", null, "Poucas leituras do GPS: os números podem estar incompletos."));
    if (ultima) {
      // chegada: a rota fica guardada como "última rota" (sair da fazenda sem sinal pelo mesmo caminho)
      const O = window.CopilotoOffline;
      const ate = O && O.formatarHora ? O.formatarHora(ultima.chegouEm + O.ULTIMA_VALIDADE_MS) : "daqui a 7 dias";
      itens.push(el("p", "nav-ultima", "A rota ficou guardada como última rota até " + ate + " (linha tracejada no mapa) para voltar pelo mesmo caminho, mesmo sem internet."));
      const vb = botao("Voltar pela mesma rota", "btn btn-principal nav-grande", () => { C.folha.fechar(); voltar(); });
      vb.id = "nav-voltar"; itens.push(vb);
    }
    if (retomar) {
      // encerrou sem apagar a rota: dá para voltar à navegação (mesmo veículo e carga, sem perguntar) ou limpar a rota
      const r = botao("Retomar navegação", "btn btn-principal nav-grande", () => {
        const rota = C.rota.atual();
        if (!rota || nav) { C.folha.fechar(); return; }
        ativar(rota, retomar.perfil, retomar.escolha, { rotulo: retomar.rotulo });
      });
      r.id = "nav-retomar"; itens.push(r);
    }
    const botoes = el("div", "linha-botoes");
    botoes.append(botao("Fechar", "btn btn-principal", C.folha.fechar), botao("Viagens anteriores", "btn", mostrarViagens));
    if (retomar) { const l = botao("Limpar rota", "btn", () => C.rota.limpar()); l.id = "nav-limpar-rota"; botoes.append(l); }
    else if (ultima) {
      const l = botao("Limpar rota", "btn", () => { if (C.offline && C.offline.esquecerRota) C.offline.esquecerRota(); C.folha.fechar(); C.mensagem("Rota limpa.", 4000); });
      l.id = "nav-limpar-rota"; botoes.append(l);
    }
    itens.push(botoes);
    C.folha.abrir(itens);
  }

  // ------------------------------------------------------------ M4: navegação em andamento (página recarregada)
  function gravarAndamento(n, forcar) {
    if (!n || nav !== n) return;
    const agora = Date.now();
    if (!forcar && agora - n.gravadoEm < GRAVAR_MS) return;
    n.gravadoEm = agora;
    const d = dados();
    d.andamento = { destino: { lat: n.destino.lat, lon: n.destino.lon }, rotulo: rotuloDestino(n), perfilId: n.perfil ? n.perfil.id : null,
      perfilNome: n.perfil ? n.perfil.nome : null, carga: n.escolha.carga || null, peso: n.escolha.peso == null ? null : n.escolha.peso,
      aviso: n.escolha.aviso || null, inicio: n.inicio, atualizado: agora, progresso_m: n.progresso || 0, total_m: n.geo.total,
      resumo: n.registro.resumo(), volta: !!n.volta, desvios: Nav.listaCompacta(n.desviosViagem), aceitas: n.aceitas || [] };
    gravar(d);
  }
  function apagarAndamento() { const d = dados(); if (d.andamento) { d.andamento = null; gravar(d); } }

  // Na abertura: navegação que estava em andamento entra no histórico como interrompida e, se recente, oferece
  // "Continuar navegação" (1 toque, sem perguntar a carga: vale a escolha guardada).
  function verificarAndamento() {
    const d = dados(), a = d.andamento;
    if (!a) return;
    if (!a.registrada) {
      d.viagens = Nav.adicionarViagem(d.viagens, Nav.viagemInterrompida(a, C.util.novoId()), 20);
      a.registrada = true;
    }
    if (!Nav.andamentoValido(a, Date.now())) d.andamento = null;
    gravar(d);
    if (!d.andamento) return;
    // o cartão "Ativar o GPS" fica no meio da tela e a folha cobriria o botão dele: espera a primeira posição (ou erro)
    const cartao = $("cartao-gps");
    if (!cartao || cartao.hidden) { oferecerContinuar(d.andamento); return; }
    const desligar = [];
    const abrir = () => { desligar.forEach((f) => f()); const x = dados().andamento; if (x) oferecerContinuar(x); };
    desligar.push(C.on("posicao", abrir), C.on("gps-erro", abrir));
  }
  function oferecerContinuar(a) {
    if (nav) return;
    const cont = botao("Continuar navegação", "btn btn-principal nav-grande", () => continuar(a)); cont.id = "nav-continuar";
    const nao = botao("Agora não", "btn nav-grande", () => { apagarAndamento(); C.folha.fechar(); }); nao.id = "nav-continuar-nao";
    const carga = a.carga === "carregado" ? "carregado" : a.carga === "vazio" ? "vazio" : null;
    const detalhe = "Para " + (a.rotulo || "o destino") + (a.perfilNome ? " · " + a.perfilNome : "") + (carga ? " · " + carga : "") + ".";
    C.folha.abrir([el("h2", null, "Navegação interrompida"), el("p", null, detalhe),
      el("p", "nav-registrado", "O trecho já feito ficou nas viagens anteriores."), cont, nao]);
  }
  async function continuar(a) {
    if (nav) { C.folha.fechar(); return; }
    const pos = C.estado.ultimaPos;
    if (!pos) {
      // sem posição ainda (GPS religando depois de recarregar): continua sozinho na primeira leitura
      const espera = el("h2", null, "Esperando o GPS…");
      C.folha.abrir([espera, el("p", null, "Ative o GPS. A navegação continua sozinha na primeira posição."), botao("Cancelar", "btn", C.folha.fechar)]);
      const desligar = C.on("posicao", () => { desligar(); if (!nav && C.folha.aberta() && espera.isConnected) continuar(a); });
      return;
    }
    const lista = C.veiculos && C.veiculos.lista ? C.veiculos.lista() : [];
    const perfil = lista.find((v) => v.id === a.perfilId) || (C.veiculos && C.veiculos.ativo ? C.veiculos.ativo() : null);
    const escolha = { carga: a.carga || null, peso: a.peso == null ? null : a.peso, aviso: a.aviso || "" };
    const extra = { rotulo: a.rotulo || null };
    // volta pela mesma rota interrompida (ainda com a última rota): volta de novo daqui
    if (a.volta && C.offline && C.offline.ultimaRota && C.offline.ultimaRota()) { voltar(); return; }
    const guardada = () => {
      const g = rotaGuardada();
      return g && g.destino && Nav.distanciaM(g.destino, a.destino) < 100 ? g : null;
    };
    if (navigator.onLine === false) {
      const g = guardada();
      if (!g) { C.mensagem("Sem internet e sem a rota guardada: não dá para continuar agora.", 8000); return; }
      ativar(g, perfil, Object.assign({}, escolha, { aviso: avisoGuardada(g) }), extra);
      return;
    }
    C.folha.abrir([el("h2", null, "Continuando a navegação…"), el("p", null, "Calculando a rota a partir daqui.")]);
    let rota;
    try {
      rota = await C.rota.calcular({ origem: { lat: pos[1], lon: pos[0] }, destino: { lat: a.destino.lat, lon: a.destino.lon }, perfil,
        ajustar: ajustador(escolha), enquadrar: false });
    } catch (e) {
      if (e.cancelada || nav) return;
      const g = e.rede ? guardada() : null;
      if (!g) {
        const botoes = el("div", "linha-botoes");
        botoes.append(botao("Tentar de novo", "btn btn-principal", () => continuar(a)), botao("Cancelar", "btn", C.folha.fechar));
        C.folha.abrir([el("h2", null, "Não foi possível continuar"), el("p", null, e.motivo || e.message), botoes]);
        return;
      }
      ativar(g, perfil, Object.assign({}, escolha, { aviso: avisoGuardada(g) }), extra);
      return;
    }
    if (nav) return;
    C.rota.definirDestino({ lat: a.destino.lat, lng: a.destino.lon }); // o pino vai junto (a folha fecha em ativar)
    ativar(rota, perfil, escolha, extra);
  }

  function mostrarViagens() {
    const lista = dados().viagens;
    const itens = [el("h2", null, "Viagens anteriores"), el("p", "nav-registrado", "Registrado pelo GPS do aparelho. Últimas " + lista.length + " de até 20, só neste aparelho.")];
    const ul = el("ul", "nav-viagens");
    for (const v of lista) {
      const li = el("li");
      const quando = new Date(v.data);
      li.append(el("b", null, quando.toLocaleDateString("pt-BR") + " " + Nav.formatarHora(quando) + " · " + (v.destino || "destino") + (v.chegou ? "" : v.interrompida ? " (interrompida)" : " (encerrada)")),
        el("span", null, Nav.formatarDistancia(v.distancia_m) + " · " + Nav.formatarDuracao(v.total_s) + " no total · "
          + Nav.formatarDuracao(v.movimento_s) + " em movimento · " + Nav.formatarDuracao(v.parado_s) + " parado · média "
          + (v.vel_media_kmh == null ? "não medida" : v.vel_media_kmh + " km/h")));
      const rd = Nav.resumoDesvios(v.desvios, v.aceitas);
      if (rd && rd.linha) li.append(el("span", "nav-viagem-desvio", rd.linha));
      ul.appendChild(li);
    }
    if (!lista.length) itens.push(el("p", null, "Nenhuma viagem registrada ainda."));
    else itens.push(ul);
    itens.push(botao("Fechar", "btn", C.folha.fechar));
    C.folha.abrir(itens);
  }

  function criarPainel() {
    const p = el("section", "nav-painel"); p.id = "nav-painel"; p.hidden = true; p.setAttribute("aria-label", "Navegação");
    const linha = el("div", "nav-manobra");
    const ic = el("div", "nav-icone", "↑"); ic.id = "nav-icone"; ic.setAttribute("aria-hidden", "true");
    const txt = el("div", "nav-texto");
    const dist = el("div", "nav-dist"); dist.id = "nav-dist";
    const ins = el("div", "nav-instrucao"); ins.id = "nav-instrucao";
    const rua = el("div", "nav-rua"); rua.id = "nav-rua";
    txt.append(dist, ins, rua); linha.append(ic, txt);
    const seg = el("div", "nav-seguinte"); seg.id = "nav-seguinte";
    const st = el("div", "nav-status"); st.id = "nav-status"; st.setAttribute("role", "status"); st.hidden = true;
    const off = el("div", "nav-offline"); off.id = "nav-offline"; off.setAttribute("role", "status"); off.hidden = true;
    const re = el("div", "nav-reentrada"); re.id = "nav-reentrada"; re.hidden = true;
    const seta = el("div", "nav-seta", "↑"); seta.id = "nav-seta"; seta.setAttribute("role", "img");
    const reT = el("div", "nav-reentrada-texto"); reT.id = "nav-reentrada-texto";
    re.append(seta, reT);
    const rod = el("div", "nav-rodape");
    const info = el("div", "nav-info");
    const rest = el("span", "nav-restante"); rest.id = "nav-restante";
    const cheg = el("b", "nav-chegada"); cheg.id = "nav-chegada";
    info.append(cheg, rest);
    const ver = botao("ⓘ", "btn nav-ver-aviso", () => mostrarAviso($("nav-aviso").hidden, true)); ver.id = "nav-ver-aviso"; ver.hidden = true;
    ver.setAttribute("aria-label", "Aviso da rota"); ver.title = "Aviso da rota"; ver.setAttribute("aria-controls", "nav-aviso");
    const fim = el("button", "btn nav-encerrar"); fim.type = "button"; fim.id = "nav-encerrar";
    fim.append(el("span", "nav-encerrar-icone", "✕"), el("span", "nav-encerrar-texto", "Encerrar"));
    fim.setAttribute("aria-label", "Encerrar navegação"); fim.addEventListener("click", () => confirmarEncerrar());
    // lote 1: atalho dos postos à frente como ícone de 64 px (a lista é a mesma de sempre, ui/postos.js)
    const posto = el("button", "btn nav-postos"); posto.type = "button"; posto.id = "nav-atalho-postos";
    posto.setAttribute("aria-label", "Postos à frente"); posto.title = "Postos à frente";
    if (window.CopilotoIcones) posto.append(window.CopilotoIcones.no("bomba", { classe: "ico" })); else posto.textContent = "⛽";
    posto.addEventListener("click", () => { if (C.postos && C.postos.abrirProximo) C.postos.abrirProximo(); });
    rod.append(info, posto, ver, fim);
    const av = el("div", "nav-aviso"); av.id = "nav-aviso"; av.hidden = true;
    av.addEventListener("click", () => mostrarAviso(false));
    p.append(linha, seg, off, st, re, av);
    document.querySelector("main").appendChild(p);
    // Redesenho (navegando = mínimo): chegada, restante, aviso e "Encerrar" numa barra embaixo, ao lado da velocidade
    rod.id = "nav-rodape"; rod.hidden = true; rod.setAttribute("aria-label", "Chegada e restante");
    $("painel-mapa").appendChild(rod);
    new MutationObserver(() => { rod.hidden = p.hidden; }).observe(p, { attributes: true, attributeFilter: ["hidden"] });
    // fim do painel (px a partir do topo do mapa): a faixa do alerta e os botões do mapa ficam abaixo dele
    const marcarFim = () => {
      const app = $("app");
      if (p.hidden) app.style.removeProperty("--nav-fim");
      else app.style.setProperty("--nav-fim", Math.ceil(p.offsetTop + p.offsetHeight + 8) + "px");
    };
    if (typeof ResizeObserver === "function") new ResizeObserver(marcarFim).observe(p);
    new MutationObserver(marcarFim).observe(p, { attributes: true, attributeFilter: ["hidden"] });
  }

  C.navegacao = {
    iniciar, encerrar: (opcoes) => finalizar(false, opcoes), ativa: () => !!nav, trocarDestino, adicionarParada, adotarRota, voltar,
    // estado da rota offline (testes e outros pacotes) ou null sem navegação
    offline: () => (nav ? { rotaOffline: nav.rotaOffline, conferidaEm: nav.conferidaEm, semRede: nav.semRede, fora: nav.fora, volta: nav.volta,
      semCurvas: nav.semCurvas, conferindo: !!nav.conferencia } : null),
    recentes: () => dados().recentes.slice(), viagens: () => dados().viagens.slice(), mostrarViagens,
    // "quando eu chego" / "quanto falta" (ui/comandos.js): frase falada, ou null sem rota
    textoViagem,
  };

  C.aoIniciar(() => {
    C.carregarEstilo("estilos/navegacao.css");
    criarPainel();
    C.on("posicao", aoPosicao);
    // "Mesmo assim" (ui/desvio.js): restrições que o motorista decidiu enfrentar entram no resumo da viagem que vem
    C.on("desvio:aceito", (d) => { for (const r of (d && d.restricoes) || []) if (!aceitasPendentes.some((x) => String(x.id) === String(r.id))) aceitasPendentes.push({ id: r.id, descricao: r.descricao }); });
    C.on("alerta", (d) => { alertaAberto = true; if (d && d.abriu) alertaCortou(nav); });
    C.on("alerta-fechado", () => { alertaAberto = false; });
    C.on("voz-manobra-cortada", (d) => manobraCortada(nav, d));
    // B2: GPS sem leitura nova (túnel, sem sinal): pausa; localização desligada nas escolhas: encerra
    C.on("gps-sinal", (d) => {
      if (!nav || !d || d.ok !== false) return;
      if (d.motivo === "desligado") { finalizar(false); C.mensagem("Localização desligada: navegação encerrada.", 8000); }
      else semSinal(nav);
    });
    // contrato do E4: quem trata o comando chama dado.atender() em até 300 ms (senão o app diz "Ainda não disponível")
    C.on("comando:repetir", (d) => { if (repetir()) atender(d); });
    C.on("comando:cancelar-rota", (d) => {
      if (nav) { atender(d); confirmarEncerrar(true); }
      else if (C.rota.atual() || C.rota.destino()) { atender(d); C.rota.limpar(); falarNaoCritico("Rota cancelada."); }
      else { atender(d); falarNaoCritico("Nenhuma rota para cancelar."); }
    });
    // rota limpa por fora (botão Limpar rota, outro pacote): encerra a navegação
    C.on("rota-limpa", () => { if (nav) finalizar(false); });
    // M4: página recarregada no meio da navegação (o iOS descarta a aba)
    C.on("pronto", verificarAndamento);
    // rota offline: sem internet, a rota em uso fica marcada; com a internet de volta, uma conferência (não em laço)
    window.addEventListener("offline", () => { if (nav) marcarSemRede(nav, "internet"); });
    window.addEventListener("online", () => {
      // só depois de ter ficado sem rede (um "online" repetido, com a rota já conferida, não confere de novo)
      const n = nav; if (!n || !n.semRede) return;
      n.conferidor.internetVoltou();
      conferirSePreciso(n);
    });
  });
})(window.Copiloto);
