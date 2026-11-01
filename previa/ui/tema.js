// Tema (claro / escuro / automático pelo horário), tipo de mapa (Ruas / Ruas + prédios) e a opção "Fachada na chegada".
// Roda antes de ui/mapa.js: o mapa já nasce com o estilo do tema. Quem troca o estilo do mapa é ui/mapa.js (evento "tema"
// e "mapa-tipo"); a tela de Configurações (ui/configuracoes.js) só chama as funções daqui.
// Chaves: copiloto.tema.v1 = { tema: "claro" | "escuro" | "auto" } (padrão "auto"),
//         copiloto.mapa.tipo.v1 = { tipo: "ruas" | "predios" } (padrão "ruas"),
//         copiloto.fachada.v1 = { ligada: bool } (padrão ligada; quem usa é ui/fachada.js, equipe C).
// Estilos OpenFreeMap (gratuitos, sem chave): claro = "liberty" (vias com hierarquia de cor, boa leitura de dia; tem a
// camada building-3d), escuro = "dark" (fundo escuro, vias claras, não ofusca à noite). "Ruas" esconde os prédios;
// "Ruas + prédios" mostra os prédios do estilo e, no escuro (sem extrusão no estilo), uma camada de prédios 3D própria.
// Sem satélite (não serve para navegar e não há fonte gratuita adequada).
// Expõe Copiloto.tema: escolha(novo?), efetivo(), tipoMapa(novo?), fachada(novo?), estiloMapa(tema?), temaPorHorario(h),
// ESTILOS. Emite "tema" ({ escolha, efetivo }) e "mapa-tipo" ({ tipo }).
(function (C) {
  "use strict";
  const { lerJSON, gravarJSON } = C.util;
  const CHAVE_TEMA = "copiloto.tema.v1", CHAVE_TIPO = "copiloto.mapa.tipo.v1", CHAVE_FACHADA = "copiloto.fachada.v1";
  const ESTILOS = {
    claro: "https://tiles.openfreemap.org/styles/liberty",
    escuro: "https://tiles.openfreemap.org/styles/dark",
  };
  const COR_BARRA = { claro: "#eef1f5", escuro: "#14181f" };
  // Automático: claro das 6 h às 17:59, escuro das 18 h às 5:59 (hora do aparelho)
  const temaPorHorario = window.CopilotoInterface.temaPorHorario;

  let escolhaAtual = valido((lerJSON(CHAVE_TEMA, null) || {}).tema, ["claro", "escuro", "auto"], "auto");
  let tipoAtual = valido((lerJSON(CHAVE_TIPO, null) || {}).tipo, ["ruas", "predios"], "ruas");
  let efetivoAtual = null;
  function valido(v, lista, padrao) { return lista.indexOf(v) >= 0 ? v : padrao; }

  function efetivo(agora) {
    if (escolhaAtual !== "auto") return escolhaAtual;
    return temaPorHorario((agora instanceof Date ? agora : new Date()).getHours());
  }
  function aplicar(forcarEvento) {
    const ef = efetivo();
    const raiz = document.documentElement;
    if (raiz.dataset.tema !== ef) raiz.dataset.tema = ef;
    raiz.dataset.temaEscolha = escolhaAtual;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", COR_BARRA[ef]);
    const mudou = ef !== efetivoAtual;
    efetivoAtual = ef;
    if (mudou || forcarEvento) C.emit("tema", { escolha: escolhaAtual, efetivo: ef });
  }

  function escolha(novo) {
    if (novo === "claro" || novo === "escuro" || novo === "auto") {
      escolhaAtual = novo;
      gravarJSON(CHAVE_TEMA, { tema: novo });
      aplicar(true);
    }
    return escolhaAtual;
  }
  function tipoMapa(novo) {
    if ((novo === "ruas" || novo === "predios") && novo !== tipoAtual) {
      tipoAtual = novo;
      gravarJSON(CHAVE_TIPO, { tipo: novo });
      C.emit("mapa-tipo", { tipo: novo });
    }
    return tipoAtual;
  }
  // Fachada na chegada: quem usa é ui/fachada.js (equipe C), que define o padrão (ligada). Com o pacote carregado, o
  // interruptor passa por Copiloto.fachada.definir (fecha o cartão aberto ao desligar e emite "fachada:preferencia").
  function fachada(ligar) {
    if (typeof ligar === "boolean") {
      if (C.fachada && typeof C.fachada.definir === "function") C.fachada.definir(ligar);
      else gravarJSON(CHAVE_FACHADA, { ligada: ligar });
      C.emit("fachada", { ligada: ligar });
    }
    if (C.fachada && typeof C.fachada.ligada === "function") return !!C.fachada.ligada();
    const o = lerJSON(CHAVE_FACHADA, null);
    return !(o && o.ligada === false);
  }
  function estiloMapa(tema) { return ESTILOS[tema || efetivo()] || ESTILOS.claro; }

  C.tema = { escolha, efetivo: () => efetivo(), tipoMapa, fachada, estiloMapa, temaPorHorario, ESTILOS,
    CHAVES: { tema: CHAVE_TEMA, tipo: CHAVE_TIPO, fachada: CHAVE_FACHADA } };

  // o tema entra antes de qualquer desenho (sem piscar o escuro no claro)
  aplicar(false);
  C.aoIniciar(() => {
    aplicar(false);
    // automático: confere a hora a cada minuto (troca às 6 h e às 18 h)
    setInterval(() => { if (escolhaAtual === "auto") aplicar(false); }, 60000);
  });
})(window.Copiloto);
