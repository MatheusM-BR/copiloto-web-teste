// Consentimento granular e revogável (PRI-01 / COM-03). Lógica pura: sem DOM, testável no Node.
//
// Quatro escolhas separadas, cada uma liga ou desliga uma coisa de verdade:
//   localizacao → o app usa o GPS no aparelho (mapa, velocidade, alertas) e manda a posição para buscar postos.
//                 Desligada: o GPS não é ligado.
//   alertas     → o app busca relatos da comunidade na nuvem e avisa na estrada (logado: posição exata a cada 60 s e a
//                 cada 2 km, com a conta). Desligada: não busca nem alerta.
//   enviar      → o app envia meus relatos e votos. Desligada: nada sai; o relato fica só no aparelho.
//   qualidade   → junto com relato/voto, envia precisão, rumo e velocidade do GPS. Desligada: vão como null.
// Antes de o motorista responder (ou quando a versão do texto muda), nada é considerado permitido.
// O registro guarda a versão do texto aceito e quando cada escolha mudou.
(function (raiz) {
  "use strict";

  const CHAVE = "copiloto.consentimento.v1";
  // muda quando o texto das escolhas muda: o app pergunta de novo.
  // 2026-10-31.2 (A5): diz que a posição vai EXATA ao servidor e que os postos ("Próximo posto" e postos no mapa) também a usam.
  // 2026-10-31.3 (M6 do QA2): servidor público de rotas (Valhalla) na tela; a busca de relatos se repete (a cada minuto e
  // a cada 2 km, ligada à conta), não é "naquele momento"; o botão Falar usa o microfone e, no iPhone, o áudio vai ao
  // reconhecimento de fala da Apple.
  // 2026-10-31.4 (redesenho): busca de destino por texto — o texto digitado e a posição vão ao serviço público de busca
  // Photon (Komoot); endereço na Emergência e no toque no mapa — a posição exata vai ao Nominatim (OpenStreetMap).
  // 2026-10-31.4 (voz): modo mãos-livres (microfone aberto enquanto o app está na tela, ligado por um toque) e destino por
  // voz (o nome do lugar e a posição vão ao serviço de busca de lugares).
  // 2026-11-01.1 (integração): as duas versões .4 (redesenho e voz) foram escritas em paralelo; o texto juntou as duas
  // (Photon na busca por texto e por voz, Nominatim, mãos-livres). Quem aceitou qualquer .4 é perguntado de novo.
  const VERSAO = "2026-11-01.1";

  const ITENS = {
    localizacao: {
      rotulo: "Usar a minha localização neste aparelho",
      explica: "Necessária para o mapa mostrar onde você está, a sua velocidade e os alertas à frente. "
        + "Para buscar postos e relatos perto de você, a posição vai ao servidor; não guardamos esse trajeto. "
        + "Nos postos (\"Próximo posto\" e postos no mapa) vai a posição exata (andando, também o rumo) ou o centro do mapa, "
        + "mesmo com os alertas da comunidade desligados. A posição também vai junto com um relato ou voto seu. "
        + "Ao traçar uma rota, a origem (a sua posição exata) e o destino vão ao servidor público de rotas Valhalla, do projeto "
        + "OpenStreetMap, que tem a sua própria política. Na busca de destino, o que você digita e a sua posição exata (para achar "
        + "primeiro o que está perto) vão ao serviço público de busca Photon (Komoot, dados do OpenStreetMap), que tem a sua própria política. Para mostrar o endereço (na Emergência e ao tocar no mapa), "
        + "a posição exata (ou o ponto tocado) vai ao serviço público Nominatim, do OpenStreetMap, quando há internet.",
    },
    alertas: {
      rotulo: "Receber alertas da comunidade",
      explica: "Busca na nuvem os relatos de outros motoristas por perto e avisa na estrada. Com a conta aberta, a sua posição exata "
        + "vai ao servidor junto com a identificação da sua conta a cada minuto e a cada 2 km andados, enquanto o app estiver aberto. "
        + "O banco do Copiloto não grava essas posições, mas, repetidas enquanto você dirige, elas mostram por onde você passa.",
    },
    enviar: {
      rotulo: "Enviar meus relatos e votos",
      explica: "Seus relatos (tipo, local, horário e valor) e seus votos (\"continua lá\" / \"não está mais\") vão para outros motoristas, ligados à sua conta.",
    },
    qualidade: {
      rotulo: "Enviar dados de qualidade da posição",
      explica: "Junto com o relato ou voto, envia a precisão do GPS, o rumo e a velocidade daquele momento. Serve para calibrar os raios e melhorar o sistema. Sem isso, tudo continua funcionando.",
    },
  };
  const NOMES = Object.keys(ITENS);

  // Textos fixos da tela de consentimento (fora das 4 escolhas). ABERTURA cita postos (sem localização não há postos
  // perto de você); MICROFONE diz a verdade sobre o reconhecimento de fala (não é escolha daqui: o aparelho pede a
  // permissão do microfone no primeiro toque em "Falar").
  const TEXTOS = {
    abertura: "Cada opção é separada e pode ser mudada a qualquer hora na aba Conta. Sem a localização o mapa abre, mas não "
      + "mostra onde você está, não avisa do que vem à frente e não acha postos perto de você.",
    microfone: "Comando de voz (botão \"Falar\"): o microfone só é usado depois do seu toque, uma frase por toque. Quem transforma "
      + "a fala em texto é o reconhecimento de fala do aparelho: no iPhone, o áudio vai ao serviço de reconhecimento de fala "
      + "da Apple (em outros celulares, ao serviço de fala do navegador, como o do Google). O Copiloto não grava o áudio "
      + "nem o manda aos servidores dele; o texto que volta é interpretado no aparelho. "
      + "Modo mãos-livres (opcional, você liga com um toque): enquanto o app está aberto e na tela, o microfone fica ouvindo e "
      + "tudo o que for dito perto do celular vai a esse reconhecimento de fala; só frases que começam com \"Copiloto\" viram "
      + "comando. Ele desliga ao sair do app e depois de 10 minutos sem navegação. "
      + "Destino por voz (\"me leva para…\"): o nome do lugar e a sua posição vão ao serviço de busca de lugares (Photon, "
      + "do OpenStreetMap), para achar o lugar mais perto.",
  };

  function ler(storage) {
    let o = null;
    try { o = JSON.parse((storage && storage.getItem(CHAVE)) || "null"); } catch (e) { o = null; }
    if (!o || typeof o !== "object") return null;
    const r = { versao: String(o.versao || ""), respondidoEm: Number(o.respondidoEm) || null, alterado: o.alterado && typeof o.alterado === "object" ? o.alterado : {} };
    for (const n of NOMES) r[n] = o[n] === true;
    return r;
  }

  // Precisa mostrar a tela de consentimento? (nunca respondeu ou a versão do texto mudou)
  function precisaPerguntar(reg) { return !reg || reg.versao !== VERSAO; }

  // Permite o item? Sem resposta válida, nada é permitido.
  function permite(reg, item) { return !!reg && reg.versao === VERSAO && reg[item] === true; }

  // Grava as escolhas (objeto com os 4 itens; faltando = false). Devolve o registro gravado.
  function gravar(storage, escolhas, agoraMs, anterior) {
    const t = Number(agoraMs) || Date.now();
    const ant = anterior !== undefined ? anterior : ler(storage);
    const reg = { versao: VERSAO, respondidoEm: t, alterado: Object.assign({}, ant && ant.alterado) };
    for (const n of NOMES) {
      reg[n] = !!(escolhas && escolhas[n] === true);
      if (!ant || ant[n] !== reg[n] || ant.versao !== VERSAO) reg.alterado[n] = t;
    }
    try { storage && storage.setItem(CHAVE, JSON.stringify(reg)); } catch (e) { /* sem armazenamento: vale só nesta sessão */ }
    return reg;
  }

  // Muda uma escolha só, mantendo as outras.
  function alterar(storage, item, valor, agoraMs) {
    if (!ITENS[item]) throw new Error("Escolha desconhecida: " + item);
    const ant = ler(storage);
    const esc = {};
    for (const n of NOMES) esc[n] = ant && ant.versao === VERSAO ? ant[n] : false;
    esc[item] = !!valor;
    return gravar(storage, esc, agoraMs, ant);
  }

  // Dados de qualidade do GPS que vão no relato/voto: null quando o motorista não permitiu (ou o aparelho não informa).
  function paramsQualidade(reg, gps) {
    const g = gps || {};
    if (!permite(reg, "qualidade")) return { p_accuracy_m: null, p_heading_deg: null, p_speed_kmh: null };
    return {
      p_accuracy_m: g.precisao != null && isFinite(g.precisao) ? Math.round(g.precisao * 10) / 10 : null,
      p_heading_deg: g.rumo != null && isFinite(g.rumo) ? g.rumo : null,
      p_speed_kmh: g.velKmh != null && isFinite(g.velKmh) ? g.velKmh : null,
    };
  }

  const api = { CHAVE, VERSAO, ITENS, NOMES, TEXTOS, ler, gravar, alterar, permite, precisaPerguntar, paramsQualidade };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoConsentimento = api;
})(typeof window !== "undefined" ? window : globalThis);
