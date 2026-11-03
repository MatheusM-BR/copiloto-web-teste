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
  // 2026-11-01.2 (revisão 4): item NOVO "foto" (foto de rua do Mapillary na chegada; desligada por padrão); o endereço pelo
  // Nominatim só com a localização ligada (restringe, não amplia); texto curto com detalhe por item; o texto do microfone
  // passou para o primeiro toque em "Falar". Cada item guarda a versão em que foi respondido (versaoItens) e só é
  // perguntado de novo se o SENTIDO dele mudou (ITENS[x].desde): quem aceitou a .1 mantém as quatro escolhas e responde
  // só a "foto". Mude o sentido de um item → suba VERSAO e o "desde" dele.
  const VERSAO = "2026-11-01.2";

  const ITENS = {
    localizacao: {
      desde: "2026-11-01.1",
      rotulo: "Usar a minha localização neste aparelho",
      curto: "Usar a minha localização",
      explica: "Necessária para o mapa mostrar onde você está, a sua velocidade e os alertas à frente. "
        + "Com ela ligada, a sua posição vai ao nosso servidor (Supabase) para buscar postos e relatos perto de você; não guardamos esse trajeto. "
        + "Nos postos (\"Próximo posto\" e postos no mapa) vai a posição exata (andando, também o rumo) ou o centro do mapa, "
        + "mesmo com os alertas da comunidade desligados. A posição também vai junto com um relato ou voto seu. "
        + "Rota: ao traçar uma rota, a origem (a sua posição exata) e o destino vão ao servidor público de rotas Valhalla "
        + "(mantido pela FOSSGIS e.V., com dados do OpenStreetMap); depois, a forma da rota (os pontos do desenho) vai de novo ao Valhalla "
        + "(trace_attributes) para achar limite de velocidade, tipo de pista e piso (viagem longa vai em vários pedidos) e, quando o custo da viagem usa o relevo, a altitude (height). "
        + "Busca e endereço: o que você digita vai ao Photon (Komoot, dados do OpenStreetMap) e o ponto que você toca no mapa vai ao "
        + "Nominatim (OpenStreetMap) para mostrar rua e cidade, mesmo com a localização desligada. Só com esta opção ligada a sua posição "
        + "vai também ao Photon (para mostrar primeiro o que está perto) e ao Nominatim (o endereço da Emergência); desligada, o endereço da "
        + "Emergência vem só do mapa guardado no aparelho. Cada serviço tem a sua própria política.",
    },
    alertas: {
      desde: "2026-11-01.1",
      rotulo: "Receber alertas da comunidade",
      curto: "Receber alertas da comunidade",
      explica: "Busca na nuvem os relatos de outros motoristas por perto e avisa na estrada. Com a conta aberta, a sua posição exata "
        + "vai ao servidor junto com a identificação da sua conta a cada minuto e a cada 2 km andados, enquanto o app estiver aberto. "
        + "O banco do Copiloto não grava essas posições, mas, repetidas enquanto você dirige, elas mostram por onde você passa.",
    },
    enviar: {
      desde: "2026-11-01.1",
      rotulo: "Enviar meus relatos e votos",
      curto: "Enviar meus relatos e votos",
      explica: "Seus relatos (tipo, local, horário e valor) e seus votos (\"continua lá\" / \"não está mais\") vão para outros motoristas, ligados à sua conta.",
    },
    qualidade: {
      desde: "2026-11-01.1",
      rotulo: "Enviar dados de qualidade da posição",
      curto: "Enviar precisão do GPS",
      explica: "Junto com o relato ou voto, envia a precisão do GPS, o rumo e a velocidade daquele momento. Serve para calibrar os raios e melhorar o sistema. Sem isso, tudo continua funcionando.",
    },
    foto: {
      desde: "2026-11-01.2",
      opcional: true, // só existe quando o app tem token do Mapillary (config.js); sem token não há foto nem pergunta
      rotulo: "Mostrar foto de rua do destino (Mapillary)",
      curto: "Foto de rua (Mapillary)",
      explica: "Ao chegar, o app pede ao Mapillary (Meta) as fotos de rua numa caixa de cerca de 120 m em volta do destino e baixa "
        + "uma delas; o Mapillary recebe esse ponto e o endereço de internet do aparelho. Desligada (o padrão), a chegada mostra só "
        + "o mapa em 3D, sem foto e sem enviar nada ao Mapillary.",
    },
  };
  const NOMES = Object.keys(ITENS);

  // Textos fixos da tela de consentimento (fora das escolhas). A abertura é curta (a tela cabe no iPhone sem rolar);
  // o detalhe fica em "Saiba mais". MICROFONE aparece no primeiro toque em "Falar" (e na aba de privacidade):
  // diz a verdade sobre o reconhecimento de fala (não é escolha daqui: o aparelho pede a permissão do microfone).
  const TEXTOS = {
    titulo: "Antes de começar",
    abertura: "O Copiloto usa a sua localização para o mapa, a velocidade e os alertas. Algumas coisas saem do aparelho:",
    saidas: [
      "Rota — origem e destino vão ao servidor de rotas (Valhalla).",
      "Busca e endereço — o que você digita e o ponto tocado vão ao Photon e ao Nominatim (OpenStreetMap).",
      "Postos e alertas — sua posição vai ao nosso servidor, sem guardar o trajeto.",
    ],
    saidaFoto: "Foto de rua — só se você marcar (Mapillary).",
    rodape: "Mude quando quiser em Configurações → Privacidade.",
    politica: "Política completa",
    novidade: "Uma novidade para você escolher:",
    microfone: "Comando de voz (botão \"Falar\"): o microfone só é usado depois do seu toque, uma frase por toque. Quem transforma "
      + "a fala em texto é o reconhecimento de fala do aparelho: no iPhone, o áudio vai ao serviço de reconhecimento de fala "
      + "da Apple (em outros celulares, ao serviço de fala do navegador, como o do Google). O Copiloto não grava o áudio "
      + "nem o manda aos servidores dele; o texto que volta é interpretado no aparelho. "
      + "Modo mãos-livres (opcional, você liga com um toque): enquanto o app está aberto e na tela, o microfone fica ouvindo e "
      + "tudo o que for dito perto do celular vai a esse reconhecimento de fala; só frases que começam com \"Copiloto\" viram "
      + "comando. Ele desliga ao sair do app e depois de 10 minutos sem navegação. "
      + "Destino por voz (\"me leva para…\"): o nome do lugar vai ao serviço de busca de lugares (Photon, "
      + "do OpenStreetMap) e, com a localização ligada, a sua posição vai junto, para achar o lugar mais perto.",
  };

  // Compara versões "AAAA-MM-DD.n" (n numérico); sem versão válida vale como a mais antiga.
  function cmpVersao(a, b) {
    const pa = String(a || "").split("."), pb = String(b || "").split(".");
    if ((pa[0] || "") !== (pb[0] || "")) return (pa[0] || "") < (pb[0] || "") ? -1 : 1;
    return (parseInt(pa[1], 10) || 0) - (parseInt(pb[1], 10) || 0);
  }
  // Versão em que o item foi respondido: a do item (versaoItens) ou, em registro antigo, a do registro todo.
  // versão em que o item foi respondido; nunca mais nova que a do registro (o registro inteiro é regravado a cada resposta, então um
  // `versao` antigo com `versaoItens` novos é registro adulterado ou mexido à mão: vale o mais antigo)
  function versaoDoItem(reg, item) {
    const geral = (reg && reg.versao) || "";
    const v = reg && reg.versaoItens && reg.versaoItens[item];
    if (!v) return geral;
    return cmpVersao(v, geral) <= 0 ? v : geral;
  }
  // A resposta guardada ainda vale para o texto de agora? (o sentido do item não mudou desde que foi respondido)
  function aceita(reg, item) { return !!reg && !!ITENS[item] && cmpVersao(versaoDoItem(reg, item), ITENS[item].desde) >= 0; }

  function ler(storage) {
    let o = null;
    try { o = JSON.parse((storage && storage.getItem(CHAVE)) || "null"); } catch (e) { o = null; }
    if (!o || typeof o !== "object") return null;
    const r = { versao: String(o.versao || ""), respondidoEm: Number(o.respondidoEm) || null, alterado: o.alterado && typeof o.alterado === "object" ? o.alterado : {},
      versaoItens: o.versaoItens && typeof o.versaoItens === "object" ? o.versaoItens : {} };
    for (const n of NOMES) r[n] = o[n] === true;
    return r;
  }

  // Itens sem resposta válida para o texto de agora (sem registro: todos). opcoes.foto: o app tem token do Mapillary
  // (sem ele a "foto" não existe e não é perguntada).
  function pendentes(reg, opcoes) {
    const o = opcoes || {};
    return NOMES.filter((n) => !(ITENS[n].opcional && !o[n]) && !aceita(reg, n));
  }
  // Precisa mostrar a tela de consentimento? (algum item sem resposta válida: nunca respondeu ou o sentido dele mudou)
  function precisaPerguntar(reg, opcoes) { return pendentes(reg, opcoes).length > 0; }

  // Permite o item? Sem resposta válida para o texto de agora, nada é permitido.
  function permite(reg, item) { return !!reg && reg[item] === true && aceita(reg, item); }

  // Grava as escolhas (objeto com os itens; faltando = false). respondidos: os itens que o motorista respondeu AGORA
  // (padrão: todos); os outros mantêm o valor e a versão que já tinham (a pergunta de uma versão nova é só do item novo).
  // Devolve o registro gravado.
  function gravar(storage, escolhas, agoraMs, anterior, respondidos) {
    const t = Number(agoraMs) || Date.now();
    const ant = anterior !== undefined ? anterior : ler(storage);
    const resp = Array.isArray(respondidos) ? respondidos : NOMES;
    const reg = { versao: VERSAO, respondidoEm: t, alterado: Object.assign({}, ant && ant.alterado), versaoItens: {} };
    for (const n of NOMES) {
      if (resp.indexOf(n) >= 0) {
        reg[n] = !!(escolhas && escolhas[n] === true);
        reg.versaoItens[n] = VERSAO;
        if (!ant || ant[n] !== reg[n] || !aceita(ant, n)) reg.alterado[n] = t;
      } else { // não respondido agora: fica como estava (sem resposta válida continua sem)
        reg[n] = !!(ant && ant[n] === true);
        reg.versaoItens[n] = ant ? versaoDoItem(ant, n) : "";
      }
    }
    try { storage && storage.setItem(CHAVE, JSON.stringify(reg)); } catch (e) { /* sem armazenamento: vale só nesta sessão */ }
    return reg;
  }

  // Muda uma escolha só, mantendo as outras (inclusive as que ainda esperam resposta).
  function alterar(storage, item, valor, agoraMs) {
    if (!ITENS[item]) throw new Error("Escolha desconhecida: " + item);
    const ant = ler(storage);
    const esc = {};
    for (const n of NOMES) esc[n] = !!(ant && ant[n] === true);
    esc[item] = !!valor;
    return gravar(storage, esc, agoraMs, ant, [item]);
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

  const api = { CHAVE, VERSAO, ITENS, NOMES, TEXTOS, ler, gravar, alterar, permite, precisaPerguntar, pendentes, aceita, versaoDoItem, cmpVersao, paramsQualidade };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoConsentimento = api;
})(typeof window !== "undefined" ? window : globalThis);
