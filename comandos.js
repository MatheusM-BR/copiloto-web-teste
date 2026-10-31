// Comandos de voz do Copiloto (pacote E4): interpretador determinístico, sem IA e sem rede.
// Entrada: o texto que o reconhecimento de fala do aparelho devolveu (uma ou mais alternativas).
// Saída: { intencao, ... } com uma destas intenções:
//   relatar        { tipo, valor, valorFaltando?, valorFora? }   tipo = nome do APP (obra, animal, fila, balanca…)
//   ambiguo        { candidatos: [tipo, …] }                      mais de um tipo possível: o motorista escolhe na tela
//   votar          { voto: "confirm" | "deny", tipo? }            "continua lá", "não está mais"…
//   proximo_posto, repetir, cancelar_rota
//   mapa_modo      { modo: "simples" | "completo" }
//   desconhecido
// Também: simOuNao() para a pergunta "É o mesmo?", lerValor() para números falados em pt-BR e
// criarEscuta() que envolve SpeechRecognition (injetável nos testes).
(function (raiz) {
  "use strict";

  // ------------------------------------------------------------ tipos
  // Nome do app → como falar. Os sete primeiros já existem; os outros vêm do pacote E5 (mesmos nomes).
  const TIPOS_VOZ = {
    altura_maxima:      { falado: "altura máxima",       unidade: "m" },
    limite_peso:        { falado: "limite de peso",      unidade: "t" },
    obra:               { falado: "obra" },
    buraco:             { falado: "buraco na pista" },
    acidente:           { falado: "acidente" },
    radar_movel:        { falado: "radar móvel" },
    animal:             { falado: "animal na pista" },
    fila:               { falado: "trânsito parado" },
    objeto:             { falado: "objeto na pista" },
    veiculo_parado:     { falado: "veículo parado" },
    alagamento:         { falado: "alagamento" },
    neblina:            { falado: "neblina" },
    pista_escorregadia: { falado: "pista escorregadia" },
    balanca:            { falado: "balança" },
  };

  // Faixas padrão (as mesmas de relatos.js); a interface passa as do app em opcoes.faixas.
  const FAIXAS_PADRAO = { altura_maxima: { min: 1.5, max: 6 }, limite_peso: { min: 1, max: 100 } };

  const MSG = {
    naoEntendi: "Não entendi. Diga, por exemplo: tem animal na pista.",
    indisponivel: "Comando de voz indisponível neste aparelho",
    tipoIndisponivel: "Esse tipo de relato ainda não está disponível",
    aindaNao: "Ainda não disponível",
    semAlerta: "Nenhum alerta aberto agora.",
  };

  // ------------------------------------------------------------ normalização
  // minúsculas, sem acento, sem pontuação. Mantém o decimal entre dígitos ("4,3" e "4.3" → "4.3"; "4:30" → "4.30")
  // e separa número de unidade grudada ("4,30m" → "4.30 m").
  function normalizar(texto) {
    let t = String(texto == null ? "" : texto).toLowerCase();
    t = t.normalize("NFD").replace(/[̀-ͯ]/g, "");
    t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, "$1.$2");
    t = t.replace(/(\d)\s?[,.]\s?(\d)/g, "$1\u0001$2");
    t = t.replace(/[^a-z0-9\u0001]+/g, " ");
    t = t.replace(/\u0001/g, ".");
    t = t.replace(/(\d)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2");
    return t.replace(/\s+/g, " ").trim();
  }

  // ------------------------------------------------------------ números falados (pt-BR)
  const UNIDADES = { zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9,
    dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezasseis: 16,
    dezessete: 17, dezassete: 17, dezoito: 18, dezenove: 19, dezanove: 19 };
  const DEZENAS = { vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, cincoenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90 };
  const CENTENAS = { cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300 };
  const UNID_M = new Set(["m", "metro", "metros", "mts", "mt"]);
  const UNID_T = new Set(["t", "ton", "tons", "tonelada", "toneladas"]);
  const UNID_CM = new Set(["cm", "centimetro", "centimetros"]);
  // número logo depois destas palavras é rodovia, quilômetro ou saída, não a medida
  const ANTES_NAO_MEDIDA = new Set(["br", "km", "quilometro", "rodovia", "saida", "sp", "mg", "go", "pr", "rs", "sc", "ba", "mt", "ms", "rj", "es", "to", "pa", "pe", "ce", "pi", "ma", "al", "se", "pb", "rn", "ro", "ac", "am", "rr", "ap", "df"]);

  function palavraNumero(p) {
    if (p in UNIDADES) return UNIDADES[p];
    if (p in DEZENAS) return DEZENAS[p];
    if (p in CENTENAS) return CENTENAS[p];
    return null;
  }
  // Lê um inteiro a partir de tk[i] ("45", "quarenta e cinco", "cento e vinte"). Compõe com "e" só quando a gramática
  // permite (centena + dezena/unidade, dezena + unidade). Devolve { n, j, digitos, decimal } ou null.
  function lerInteiro(tk, i) {
    const p = tk[i];
    if (p == null) return null;
    if (/^\d+(\.\d+)?$/.test(p)) return { n: Number(p), j: i + 1, digitos: p, decimal: p.includes(".") };
    let n = palavraNumero(p);
    if (n == null) return null;
    let j = i + 1;
    for (;;) {
      if (tk[j] !== "e") break;
      const prox = palavraNumero(tk[j + 1] || "");
      if (prox == null) break;
      const podeCentena = n >= 100 && n % 100 === 0 && prox < 100;
      const podeDezena = n >= 20 && n < 100 && n % 10 === 0 && prox >= 1 && prox <= 9;
      const podeCentDez = n > 100 && n % 10 === 0 && n % 100 !== 0 && prox >= 1 && prox <= 9;
      if (!(podeCentena || podeDezena || podeCentDez)) break;
      n += prox; j += 2;
    }
    return { n, j, digitos: String(n), decimal: false };
  }
  // Dígitos depois de "vírgula"/"ponto": "tres" → "3", "trinta" → "30", "zero cinco" → "05", "30" → "30"
  function lerDigitos(tk, i) {
    let s = "", j = i;
    while (j < tk.length) {
      const p = tk[j];
      if (/^\d+$/.test(p)) { s += p; j++; break; }
      const n = palavraNumero(p);
      if (n == null) break;
      if (n < 10) { s += String(n); j++; continue; }
      const r = lerInteiro(tk, j); s += String(r.n); j = r.j; break;
    }
    return s ? { s, j } : null;
  }
  function unidadeDe(p) { return UNID_M.has(p) ? "m" : UNID_T.has(p) ? "t" : null; }

  // Uma expressão numérica a partir de tk[i]. unidade = "m" | "t" | null (do tipo do relato).
  // Devolve { valor, j, unidade (dita), ambiguo } ou null.
  function lerExpressao(tk, i, unidade) {
    const a = lerInteiro(tk, i);
    if (!a) return null;
    let j = a.j, dita = null;
    if (unidadeDe(tk[j])) { dita = unidadeDe(tk[j]); j++; }
    const res = (valor, fim, amb) => ({ valor, j: fim, unidade: dita, ambiguo: !!amb });
    if (a.decimal) return res(a.n, j);
    const p = tk[j];
    if (p === "e" && (tk[j + 1] === "meio" || tk[j + 1] === "meia")) {
      let f = j + 2; if (!dita && unidadeDe(tk[f])) { dita = unidadeDe(tk[f]); f++; }
      return res(a.n + 0.5, f);
    }
    if (p === "virgula" || p === "ponto") {
      const d = lerDigitos(tk, j + 1);
      if (d) { let f = d.j; if (!dita && unidadeDe(tk[f])) { dita = unidadeDe(tk[f]); f++; } return res(Number(a.n + "." + d.s), f); }
      return res(a.n, j);
    }
    const ehMetro = (dita || unidade) === "m";
    // "4 e 30", "quatro metros e trinta", "quatro e trinta centímetros"
    if (p === "e") {
      const b = lerInteiro(tk, j + 1);
      if (b && !b.decimal) {
        let f = b.j;
        const cm = UNID_CM.has(tk[f]); if (cm) f++;
        if (!dita && unidadeDe(tk[f])) { dita = unidadeDe(tk[f]); f++; }
        if (ehMetro && (cm || (b.n >= 10 && b.n <= 99)) && b.n <= 99) return res(a.n + b.n / 100, f);
        return res(null, f, true); // "quatro e cinco": 4,5 ou 4,05? não adivinha
      }
      return res(a.n, j);
    }
    // "4 30", "quatro trinta", "4 metros 30", "4 m 30 cm"
    const b = lerInteiro(tk, j);
    if (b && !b.decimal && ehMetro && a.n < 10) {
      let f = b.j; const cm = UNID_CM.has(tk[f]); if (cm) f++;
      if ((b.n >= 10 && b.n <= 99) || (cm && b.n <= 99)) return res(a.n + b.n / 100, f);
    }
    return res(a.n, j);
  }

  // Lê a medida de um texto JÁ normalizado. unidade = "m" (altura) ou "t" (peso).
  // Devolve { valor } (número), { valor: null, ambiguo: true } ou null (nenhum número).
  // Prefere a expressão seguida da unidade; ignora "BR 153", "km 40". Mais de um número sem unidade: ambíguo.
  function lerValor(normalizado, unidade) {
    const tk = String(normalizado || "").split(" ").filter(Boolean);
    const exprs = [];
    for (let i = 0; i < tk.length;) {
      if (ANTES_NAO_MEDIDA.has(tk[i - 1]) && lerInteiro(tk, i)) { i = lerInteiro(tk, i).j; continue; }
      const e = lerExpressao(tk, i, unidade);
      // "um"/"uma" soltos são artigo ("tem um viaduto"), não medida
      const artigo = e && (tk[i] === "um" || tk[i] === "uma") && !e.unidade && e.j === i + 1;
      if (e && !artigo) { exprs.push(e); i = Math.max(e.j, i + 1); } else i++;
    }
    if (!exprs.length) return null;
    // dois números diferentes ("quatro ou cinco metros"): não escolhe
    if (new Set(exprs.map((e) => e.valor)).size > 1) return { valor: null, ambiguo: true };
    const e = exprs[0];
    return e.ambiguo ? { valor: null, ambiguo: true } : { valor: e.valor };
  }

  // ------------------------------------------------------------ padrões de tipo (texto normalizado)
  const ANIMAIS = "animal|animais|bicho|bichos|boi|bois|vaca|vacas|gado|cavalo|cavalos|egua|potro|cachorro|cachorros|cao|caes|jumento|jegue|burro|mula|porco|porcos|capivara|anta|bode|cabra|cabrito|carneiro|ovelha|veado|tamandua|lobo guara|onca|raposa|tatu|galinha";
  const PADROES = {
    animal: [new RegExp("\\b(" + ANIMAIS + ")\\b")],
    acidente: [/\b(acidente|acidentes|batida|bateram|bateu|bater|colisao|engavetamento|engavetou|tombou|tombar|tombando|capotar|capotando|tombad[oa]|capotou|capotad[oa]|capotamento|atropelamento|atropelou|atropelad[oa]|saiu da pista|sinistro)\b/],
    obra: [/\b(obra|obras|em obra|homens trabalhando|pare e siga|maquinas? na pista|recapeamento|pista em reforma|reforma da pista|desvio por obra)\b/],
    buraco: [/\b(buraco|buracos|buracao|buracoes|buraqueira|cratera|esburacad[oa]|pista (ruim|danificada|quebrada|estragada|detonada)|asfalto (ruim|quebrado|danificado|cedeu)|pista cedeu|desnivel|costela de vaca)\b/],
    radar_movel: [/\b(radar|radares|pardal|fiscalizacao eletronica|lombada eletronica|camera de velocidade|pistola de velocidade|controle de velocidade)\b/],
    altura_maxima: [/\b(altura|alto|gabarito|viaduto|viadutos|passagem (baixa|inferior)|ponte baixa|tunel baixo|teto baixo|passarela baixa)\b/],
    limite_peso: [/\b(limite de peso|peso maximo|peso limite|carga maxima|ponte fraca|ponte (de|com|aguenta) .*tonelada)/],
    fila: [/\b(fila|filas|congestionamento|congestionad[oa]|engarrafamento|engarrafad[oa]|lentidao|transito (parado|lento|travado|pesado|ruim|congestionado|carregado)|tudo parado|ta tudo parado|esta tudo parado|parado tudo|transito)\b/],
    objeto: [/\b(objeto|objetos|pneu na pista|pneu no meio|pedaco de pneu|galho|galhos|arvore caida|arvore na pista|pedra|pedras|entulho|carga caida|carga na pista|carga espalhada|madeira na pista|tora|toras|coisa na pista|lixo na pista|ferro na pista|cano na pista|colchao)\b/],
    veiculo_parado: [/\b(carro|caminhao|carreta|veiculo|onibus|moto|truck|van|bitrem|rodotrem|cegonha|bitruck|toco)\b.*\b(parad[oa]|quebrad[oa]|estragad[oa]|enguicad[oa]|pifad[oa]|sem farol|no acostamento|pegando fogo)\b/,
      /\b(parado no acostamento|parada no acostamento|parado na pista|parado na faixa|quebrado no acostamento|quebrado na pista|veiculo quebrado|pane)\b/],
    alagamento: [/\b(alagad[oa]|alagamento|alagou|enchente|inundad[oa]|inundacao|agua na pista|agua em cima da pista|pista com agua|transbordou|transbordando)\b/],
    neblina: [/\b(neblina|nevoeiro|cerracao|serracao|nevoa|cerrado de neblina|visibilidade (baixa|ruim|zero)|nao (da|esta dando) pra ver nada|fumaca na pista|fumaceira)\b/],
    pista_escorregadia: [/\b(escorregadi[ao]|escorregando|escorrega|derrapando|pista (molhada|lisa|ensaboada)|oleo|graxa|lama na pista|barro na pista|pista com lama|pista com barro|lisa)\b/],
    balanca: [/\b(balanca|balancas|pesagem|posto de pesagem|posto fiscal de peso)\b/],
  };
  // a ponte sozinha pode ser altura ou peso: a unidade decide
  const PONTE = /\b(ponte|pontes)\b/;

  function tiposNoTexto(n) {
    const achados = [];
    for (const [tipo, lista] of Object.entries(PADROES)) if (lista.some((re) => re.test(n))) achados.push(tipo);
    let s = new Set(achados);
    // conflitos conhecidos: o termo mais específico vence
    if (s.has("veiculo_parado") && s.has("fila") && !/\b(fila|congestionamento|engarrafamento|transito|tudo parado)\b/.test(n)) s.delete("fila");
    if (s.has("veiculo_parado") && s.has("acidente") && /\b(tombad[oa]|tombou|capotad[oa]|capotou|batid[oa]|bateu)\b/.test(n) && !/\b(quebrad[oa]|enguicad[oa]|pane)\b/.test(n)) s.delete("veiculo_parado");
    if (s.has("fila") && s.has("obra") && /\bpare e siga\b/.test(n) && !/\b(fila|congestionamento|engarrafamento)\b/.test(n)) s.delete("fila");
    if (s.has("alagamento") && s.has("pista_escorregadia") && !/\b(oleo|graxa|lama|barro|escorreg|lisa)\b/.test(n)) s.delete("pista_escorregadia");
    // "costela de vaca" é pista ondulada, não animal
    if (s.has("animal") && /\bcostela de vaca\b/.test(n) && !PADROES.animal[0].test(n.replace(/costela de vaca/g, ""))) s.delete("animal");
    if (s.has("balanca") && s.has("limite_peso")) s.delete("limite_peso");
    // viaduto/ponte também é só o lugar ("acidente no viaduto"): sem palavra de altura, fica o outro tipo
    if (s.has("altura_maxima") && s.size > 1 && !/\b(altura|gabarito|baix[oa]|metro|metros|m)\b/.test(n)) s.delete("altura_maxima");
    // "alto" só vale como altura em frase de ponte/viaduto/passagem
    if (s.has("altura_maxima") && !/\b(altura|gabarito|viaduto|viadutos|passagem|ponte|tunel|teto|passarela)\b/.test(n)) s.delete("altura_maxima");
    // ponte: decide pela unidade dita
    const ponte = PONTE.test(n);
    const disseMetro = /\b(m|metro|metros|altura|baixa?)\b/.test(n);
    const disseTon = /\b(t|ton|tonelada|toneladas|peso)\b/.test(n);
    if (ponte || (s.has("altura_maxima") && s.has("limite_peso"))) {
      if (disseTon && !disseMetro) { s.delete("altura_maxima"); s.add("limite_peso"); }
      else if (disseMetro && !disseTon) { s.delete("limite_peso"); s.add("altura_maxima"); }
      else if (ponte && !s.has("altura_maxima") && !s.has("limite_peso") && !s.size) { s.add("altura_maxima"); s.add("limite_peso"); }
    }
    return [...s];
  }

  // ------------------------------------------------------------ outras intenções
  // A3 (QA2): o pedido de cancelar vem no COMEÇO da frase ("cancela a rota", "para a navegação", "encerra o trajeto",
  // "por favor, cancela a rota"); entre o verbo e o nome só artigos/possessivos; nome seguido de lugar ("o caminho de
  // Goiânia", "a rota pro porto") é descrição, não pedido. "… para quem vai pro caminho de Goiânia",
  // "obra na pista sai da rota" NÃO são cancelamento. Frase com tipo de relato também não (o relato vale primeiro).
  // M2 (QA3): "sai/sair/saia" não cancelam ("saí da rota" é o motorista avisando que saiu; a navegação recalcula). "para"
  // só cancela com artigo e rota/navegação/trajeto ("para a rota", "para a navegação"); "para, caminho errado" não.
  const RE_CANCELAR_ROTA = /^(?:(?:por favor|ei|oi|ok|copiloto|pode|voce pode|quero|eu quero)\s+)*(?:(?:cancela|cancelar|cancele|encerra|encerrar|encerre|termina|terminar|termine|desliga|desligar|desligue|apaga|apagar|apague|limpa|limpar|limpe|tira|tirar|tire)\s+(?:(?:a|o|da|do|de|essa|esse|esta|este|dessa|desse|desta|deste|minha|meu|com a|com o)\s+)?(?:rota|navegacao|trajeto|percurso|caminho)|(?:para|parar|pare)\s+(?:a|o|essa|esse|esta|este|minha|meu)\s+(?:rota|navegacao|trajeto|percurso))\b(?!\s+(?:de|do|da|pra|pro|para|sentido|ate|ao|a)\b)/;
  const RE_MAPA_SIMPLES = /\b(mapa (simples|limpo|basico|simplificado)|modo simples|simplifica o mapa|simplificar o mapa|deixa o mapa simples)\b/;
  const RE_MAPA_COMPLETO = /\b(mapa (completo|detalhado|normal|cheio|inteiro)|modo completo|modo detalhado|mapa com tudo|mostra tudo no mapa)\b/;
  const RE_REPETIR = /\b(repete|repetir|repita|repeti|fala de novo|falar de novo|fala outra vez|diz de novo|de novo|outra vez|nao entendi|nao ouvi|o que (voce )?(disse|falou)|como e que e|hein|ahn)\b/;
  const RE_POSTO = /\b(proximo posto|posto mais (perto|proximo)|posto (proximo|perto|a frente|na frente)|onde (tem|e o|fica o) posto|quero abastecer|preciso abastecer|vou abastecer|preciso de diesel|precisando de diesel|abastecer|posto de (combustivel|gasolina|diesel)|algum posto|tem posto|um posto|(acabou|acabando|sem|pouco) (o |meu )?(diesel|combustivel)|(diesel|combustivel) (acabando|no fim|na reserva))\b/;
  // ---------- voto (A2, QA3). Negar o alerta ("deny") é o erro mais caro: derruba um relato real para os outros
  // motoristas. Então só vale negação EXPLÍCITA; na dúvida, a frase com tipo é relato (o servidor junta com o que já existe).
  // Forte: "não (tem|está|tá|há|existe|vi…) mais", "não tem nada/nenhum", "não está lá", "não procede", e o resto da frase
  // é só lugar/enchimento ou o próprio tipo ("não tem mais buraco aí"); outro assunto depois ("não tem nenhuma sinalização,
  // buraco enorme") não é negação. "não tem buraco (nenhum)": nega o tipo citado, só com alerta aberto.
  // Fraca: verbos de "já foi" (sumiu, tiraram, liberado, acabou…); com tipo citado e sinal de que o motorista está vendo o
  // problema ("tem um", "acabou de", "cuidado"), não vale. "acabou/acabaram de + verbo" é o contrário ("acabou de acontecer
  // um acidente", "o trânsito acabou de parar"): só nega em "acabou de ser liberado/tirado".
  const V_NAO = "(?:tem|esta|ta|estao|tao|ha|existe|vi|tinha|estava|tava|ta tendo|esta tendo)";
  // "não vejo/tô vendo nada" fica de fora: é falta de visibilidade ("não tô vendo nada, neblina forte"), não negação
  const ENCHIMENTO = /^(?:(?:la|ai|aqui|ali|nao|mais|nada|nenhum|nenhuma|mesmo|ja|na|no|nessa|nesse|neste|nesta|pista|estrada|rodovia|lugar|local|pode|tirar|apagar|remover|excluir|retirar|senhor|viu|cara|mano|chefe|amigo|isso|ok|beleza|tranquilo|liberado|liberada|limpo|limpa|livre|normal|agora|de|do|da|o|a|os|as)(?:\s+|$))*$/;
  const RE_NEGA_FORTE = new RegExp("\\bnao " + V_NAO + "(?: (?:mais|nada|nenhum|nenhuma))+\\b|" +
    "\\bnao (?:esta|ta|estao|tao) (?:mais )?(?:la|ai)\\b|\\bnao (?:procede|confirma|confirmo)\\b");
  const RE_NAO_TIPO = /\bnao (?:tem|esta|ta|ha|existe|vi|ta tendo|esta tendo)\b/;
  // negação no fim (fala do interior): "tem mais não", "tem nada não", "tem mais buraco não"
  const RE_NEGA_FIM = /^(?:(?:o|a|os|as|aqui|ali|la|ai)\s+)*(?:\w+\s+){0,2}(?:tem|ta|esta|existe|ha) (?:mais|nada|nenhum|nenhuma)\b(?:\s+\w+){0,4} nao$/;
  const RE_NEGA_FRACA = /\b(sumiu|sumiram|tiraram|retiraram|tamparam|taparam|consertaram|arrumaram|guincharam|removeram|recolheram|liberad[oa]|liberaram|desobstruid[oa]|acabou(?! de\b)|acabaram(?! de\b)|terminou(?! de\b)|terminaram(?! de\b)|ja (?:saiu|sairam|sumiu|tiraram|retiraram|limparam|liberou|liberaram|acabou|terminou|foi embora|foram embora|resolveram|era|foi)|falso|mentira|nego|normalizou|normalizad[oa]|(?:transito|fila) (?:(?:ja|ta|esta) )?(?:andou|andando|fluindo|liberou|desafogou)|ja (?:andou|normalizou|desafogou))\b|\b(?:acabou|acabaram|acabei) de (?:ser )?(?:liberar|liberad[oa]|tirar|tirad[oa]|retirar|retirad[oa]|remover|removid[oa]|limpar|desobstruir|desobstruid[oa])\b/;
  const RE_PRESENCA = /\b(tem (?:um|uma|uns|umas)|ta tendo|esta tendo|acontecendo|cuidado|enorme|pra todo lado|devagar|lent[oa]|lentidao|parando|(?:acabou|acabaram|acabei) de (?!(?:ser )?(?:liberar|liberad|tirar|tirad|retirar|retirad|remover|removid|limpar|desobstru)))/;
  const RE_CONFIRMA = /\b(continua|continuam|continuo|ainda (esta|ta|tem|existe|estao|tao|ha)|(esta|ta|estao|tao) la|ta ai|esta ai|confirmo|confirmado|confirma|confirmar|segue la|permanece|verdade|procede|ainda sim)\b/;

  function comecaComTipo(r, tipo) { return PADROES[tipo].some((re) => { const m = re.exec(r); return !!m && m.index === 0; }); }
  // o resto da frase depois da negação é só enchimento/lugar, ou começa pelo tipo e não fala de outro tipo
  function restoNegavel(resto) {
    const r = resto.replace(/^(?:(?:mais|nada|nenhum|nenhuma|de|do|da|o|a|os|as|um|uma|esse|essa|este|esta|aquele|aquela)\s+)*/, "").trim();
    if (!r || ENCHIMENTO.test(r)) return true;
    const ts = tiposNoTexto(r);
    return ts.length === 1 && comecaComTipo(r, ts[0]);
  }

  // { voto: "deny" | "confirm", soAlerta? } ou null
  function intencaoVoto(n, tipos) {
    if (RE_NEGA_FIM.test(n) && tipos.length <= 1) return { voto: "deny" };
    const forte = RE_NEGA_FORTE.exec(n);
    if (forte && restoNegavel(n.slice(forte.index + forte[0].length))) return { voto: "deny" };
    // "não tem buraco (nenhum)", "aqui não tem radar": o tipo vem logo depois da negação
    const nt = RE_NAO_TIPO.exec(n);
    if (nt && tipos.length === 1) {
      const resto = n.slice(nt.index + nt[0].length).replace(/^(?:(?:o|a|os|as|um|uma|nenhum|nenhuma|esse|essa|este|esta)\s+)*/, "").trim();
      if (comecaComTipo(resto, tipos[0]) && !/\b(tem|mas|porem|so que|e sim|cuidado)\b/.test(resto)) return { voto: "deny", soAlerta: true };
    }
    if (RE_NEGA_FRACA.test(n) && !(tipos.length && RE_PRESENCA.test(n))) return { voto: "deny" };
    if (RE_CONFIRMA.test(n)) return { voto: "confirm" };
    return null;
  }
  // "sim"/"não" soltos (respostas curtas) só valem como voto com alerta aberto
  const RE_SO_SIM = /^(sim|isso|positivo|confirmo|exato|claro|e sim|isso mesmo|sim senhor|sim sim)$/;
  const RE_SO_NAO = /^(nao|negativo)( (nao|senhor|mais|nada|esta|ta|tem|existe|ha))*$/;

  // Interpreta UMA transcrição. opcoes: { alertaAberto: bool, faixas: { tipo: { min, max } } }
  function interpretar(texto, opcoes) {
    const o = opcoes || {};
    // "num tem", "num tá" (fala do dia a dia) = "não tem", "não tá"
    const n = normalizar(texto).replace(/\bnum (tem|ta|esta|vi|ha|existe)\b/g, "nao $1");
    const base = { texto: n };
    const res = (x) => Object.assign(base, x);
    if (!n) return res({ intencao: "desconhecido", motivo: "vazio" });

    // A3 (QA2): o relato é testado antes; frase com tipo de relato nunca cancela a rota
    const tipos = tiposNoTexto(n);
    if (!tipos.length && RE_CANCELAR_ROTA.test(n)) return res({ intencao: "cancelar_rota" });
    if (RE_MAPA_SIMPLES.test(n)) return res({ intencao: "mapa_modo", modo: "simples" });
    if (RE_MAPA_COMPLETO.test(n)) return res({ intencao: "mapa_modo", modo: "completo" });

    // "não sei se é acidente": dúvida não vira relato nem voto
    if (/^(nao sei|sei la)\b/.test(n)) return res({ intencao: "desconhecido", motivo: "duvida" });
    const v = intencaoVoto(n, tipos);
    if (v && v.voto === "deny") {
      // A2 (QA3): negação com dois tipos ("não tem mais buraco, tem um acidente agora") não derruba nada: vira escolha
      if (tipos.length > 1) { /* segue para "ambiguo" */ }
      else if (v.soAlerta && !o.alertaAberto) return res({ intencao: "desconhecido", motivo: "negacao" });
      // "acabou o diesel, preciso de posto": é pedido de posto, não negação
      else if (!tipos.length && RE_POSTO.test(n)) return res({ intencao: "proximo_posto" });
      else return res({ intencao: "votar", voto: "deny", tipo: tipos.length === 1 ? tipos[0] : null });
    } else if (v) return res({ intencao: "votar", voto: v.voto, tipo: tipos.length === 1 ? tipos[0] : null });
    // A2 (QA3): frase que começa com "não" e cita um tipo, sem ser negação explícita ("não dá pra ver nada de tanta
    // neblina", "não para não, tem um buraco enorme aqui", "não acredito, tem um boi na pista") é RELATO

    if (tipos.length > 1) return res({ intencao: "ambiguo", candidatos: tipos });
    if (tipos.length === 1) {
      const tipo = tipos[0];
      const cfg = TIPOS_VOZ[tipo];
      if (!cfg.unidade) return res({ intencao: "relatar", tipo, valor: null });
      const lido = lerValor(n, cfg.unidade);
      if (!lido) return res({ intencao: "relatar", tipo, valor: null, valorFaltando: true });
      if (lido.valor == null) return res({ intencao: "relatar", tipo, valor: null, valorFaltando: true, valorAmbiguo: true });
      const faixa = (o.faixas && o.faixas[tipo]) || FAIXAS_PADRAO[tipo];
      if (faixa && (lido.valor < faixa.min || lido.valor > faixa.max)) return res({ intencao: "relatar", tipo, valor: null, valorFaltando: true, valorFora: lido.valor });
      return res({ intencao: "relatar", tipo, valor: Math.round(lido.valor * 100) / 100 });
    }

    if (RE_REPETIR.test(n)) return res({ intencao: "repetir" });
    if (RE_POSTO.test(n)) return res({ intencao: "proximo_posto" });
    // "sim"/"não" soltos só valem como voto com alerta aberto (e só respostas curtas: "não para não" não é voto)
    if (o.alertaAberto && RE_SO_SIM.test(n)) return res({ intencao: "votar", voto: "confirm", tipo: null });
    if (o.alertaAberto && RE_SO_NAO.test(n)) return res({ intencao: "votar", voto: "deny", tipo: null });
    return res({ intencao: "desconhecido", motivo: "sem_padrao" });
  }

  // Várias alternativas do reconhecedor: fica com a primeira que fez sentido (senão, a primeira).
  function interpretarAlternativas(lista, opcoes) {
    const textos = (Array.isArray(lista) ? lista : [lista]).filter((t) => t != null && String(t).trim());
    if (!textos.length) return interpretar("", opcoes);
    let primeira = null;
    for (const t of textos) {
      const r = interpretar(t, opcoes);
      if (!primeira) primeira = r;
      if (r.intencao !== "desconhecido") return r;
    }
    return primeira;
  }

  // Resposta à pergunta "É o mesmo?": "sim" | "nao" | "cancelar" | null (sem resposta clara: a decisão fica na tela).
  const RE_SIM = /\b(sim|isso|mesmo|esse|este|positivo|exato|exatamente|certo|correto|confirmo|confirma|aham|uhum|claro|pode ser)\b/;
  const RE_NAO = /\b(nao|outro|outra|diferente|negativo|nada a ver)\b/;
  function simOuNao(texto) {
    const lista = Array.isArray(texto) ? texto : [texto];
    for (const t of lista) {
      const n = normalizar(t);
      if (!n || /\b(nao sei|talvez|sei la)\b/.test(n)) continue;
      if (/^(nao|negativo)\b/.test(n) || /\bnao e (o mesmo|esse|este|ele|isso)\b/.test(n)) return "nao";
      const sim = /^e( sim| ele| esse| este| o mesmo)?$/.test(n) || RE_SIM.test(n);
      const nao = RE_NAO.test(n);
      if (/\b(cancela|cancelar|esquece|deixa pra la)\b/.test(n) && !sim && !nao) return "cancelar";
      if (sim && !nao) return "sim";
      if (nao && !sim) return "nao";
    }
    return null;
  }

  // ------------------------------------------------------------ frases
  function nomeFalado(tipo) { return (TIPOS_VOZ[tipo] && TIPOS_VOZ[tipo].falado) || "relato"; }
  // "Já tem animal na pista a 150 metros. É o mesmo?" distanciaFalada = CopilotoVoz.distanciaFalada (opcional)
  function textoPergunta(tipo, distanciaM, distanciaFalada) {
    const d = distanciaM == null ? NaN : Number(distanciaM);
    const onde = isFinite(d) && d >= 0 ? " a " + (distanciaFalada ? distanciaFalada(d) : Math.round(d) + " metros") : " aqui perto";
    return "Já tem " + nomeFalado(tipo) + onde + ". É o mesmo?";
  }
  // Frase final opcional depois de um relato por voz (COM-02: confirmação silenciosa; o bipe já confirma).
  const FRASE_FINAL = { profissional: null, equilibrado: null, amigavel: "Valeu, anotado.", bem_humorado: "Anotado!" };
  function fraseFinal(perfil) { return Object.prototype.hasOwnProperty.call(FRASE_FINAL, perfil) ? FRASE_FINAL[perfil] : null; }
  // Pedido do valor na tela
  function textoPedirValor(tipo) { return tipo === "limite_peso" ? "Digite o peso na tela." : "Digite a altura na tela."; }

  // ------------------------------------------------------------ escuta (SpeechRecognition)
  // Uma frase por vez, sem escuta contínua. Reconhecedor injetável (testes).
  // escutar({ maxMs, aoComecar, aoTerminar({ textos, motivo }) }) → { parar(motivo) }
  // motivo: ok | silencio | permissao | tempo | erro | rede | indisponivel | <o motivo passado em parar()>
  function criarEscuta(opcoes) {
    const o = opcoes || {};
    const g = typeof window !== "undefined" ? window : {};
    const Rec = o.Reconhecedor !== undefined ? o.Reconhecedor : (g.SpeechRecognition || g.webkitSpeechRecognition || null);
    function disponivel() { return typeof Rec === "function"; }
    function escutar(p) {
      const q = p || {};
      let terminou = false, textos = [], erro = null, rec = null, timer = null, timerFim = null;
      function fim(motivo) {
        if (terminou) return;
        terminou = true; clearTimeout(timer); clearTimeout(timerFim);
        if (rec) { rec.onresult = rec.onerror = rec.onend = rec.onstart = null; }
        const m = motivo || (textos.length ? "ok" : erro || "silencio");
        if (q.aoTerminar) q.aoTerminar({ textos: textos.slice(), motivo: m });
      }
      if (!disponivel()) { setTimeout(() => fim("indisponivel"), 0); return { parar() {} }; }
      try {
        rec = new Rec();
        rec.lang = "pt-BR"; rec.continuous = false; rec.interimResults = false; rec.maxAlternatives = 3;
        rec.onstart = () => { if (q.aoComecar) q.aoComecar(); };
        rec.onresult = (e) => {
          const lista = e && e.results ? e.results : [];
          const ult = lista[lista.length - 1];
          if (!ult) return;
          const alt = [];
          for (let k = 0; k < (ult.length || 0); k++) if (ult[k] && ult[k].transcript) alt.push(String(ult[k].transcript));
          if (alt.length) textos = alt;
        };
        rec.onerror = (e) => {
          const c = e && e.error;
          erro = c === "not-allowed" || c === "service-not-allowed" ? "permissao" : c === "no-speech" ? "silencio" : c === "network" ? "rede" : c === "aborted" ? "silencio" : "erro";
          if (erro === "permissao") fim("permissao");
        };
        rec.onend = () => fim();
        rec.start();
      } catch (e) { setTimeout(() => fim("erro"), 0); return { parar() {} }; }
      timer = setTimeout(() => {
        // pede para fechar com o que ouviu; se não fechar, encerra assim mesmo
        try { rec.stop(); } catch (e) { /* ignora */ }
        timerFim = setTimeout(() => fim(textos.length ? "ok" : "tempo"), 800);
      }, q.maxMs || 8000);
      return {
        parar(motivo) {
          if (terminou) return;
          try { rec.abort(); } catch (e) { /* ignora */ }
          fim(motivo || "cancelado");
        },
      };
    }
    return { disponivel, escutar };
  }

  const api = { TIPOS_VOZ, FAIXAS_PADRAO, MSG, normalizar, lerValor, tiposNoTexto, interpretar, interpretarAlternativas, simOuNao,
    nomeFalado, textoPergunta, fraseFinal, textoPedirValor, criarEscuta };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoComandos = api;
})(typeof window !== "undefined" ? window : globalThis);
