// Voz do Copiloto: textos falados e chamada à fala do aparelho (Web Speech API).
// Regras (VOZ-05):
//  - o ALERTA de segurança é sempre o mesmo texto curto, em todos os perfis, sem humor e sem o nível;
//  - o perfil muda só a frase de agradecimento depois do voto;
//  - Profissional nunca faz humor; Bem-humorado é leve e curto, sem palavrão e sem estereótipo.
// speechSynthesis e SpeechSynthesisUtterance são injetáveis (testes no Node e no navegador).
(function (raiz) {
  "use strict";

  const CHAVE_PREF = "copiloto.voz.v1";

  const PERFIS = {
    profissional: { rotulo: "Profissional" },
    equilibrado:  { rotulo: "Equilibrado" },
    amigavel:     { rotulo: "Amigável" },
    bem_humorado: { rotulo: "Bem-humorado" },
  };
  const PERFIL_PADRAO = "equilibrado";

  // Modo de fala (r6): "tudo" = Completo (alertas, orientação e conversa pelo caminho); "alertas" = Só alertas (só o que é
  // segurança: restrição, balança, curva forte, trecho crítico, radar, desvio de rota, chegada, relato à frente, e o que o
  // motorista pediu por voz). Não fala conversa: marcos de 30 min/50 km, "Continue por…", resumo da rota traçada.
  const MODOS = {
    tudo:    { rotulo: "Completo",    simbolo: "voz_tudo",    dica: "Fala alertas, curvas e a conversa pelo caminho" },
    alertas: { rotulo: "Só alertas",  simbolo: "voz_alertas", dica: "Fala só avisos de segurança e a chegada" },
  };
  const MODO_PADRAO = "tudo";
  // Frases de conversa de quem não passa a marca { conversa: true } (rota.js, mapa.js): reconhecidas pelo começo do texto.
  const RE_CONVERSA = /^(?:Rota de \d[\d,. ]* (?:quil[ôo]metros?|metros?)|Continue por \d|Faltam \d|Falta(?:m)? (?:cerca de )?\d|Rota atualizada com a internet)/i;
  function ehConversa(texto, opcoes) {
    if (opcoes && opcoes.conversa === true) return true;
    if (opcoes && (opcoes.critica || opcoes.seguranca || opcoes.conversa === false)) return false;
    const t = String(texto == null ? "" : texto);
    return RE_CONVERSA.test(t) && !/restri[çc]/i.test(t); // a rota traçada com restrição no texto é segurança: sai
  }
  // O modo deixa esta fala sair? Alerta de segurança, crítica e resposta a comando de voz sempre saem.
  function permiteFala(modo, texto, opcoes) {
    if (modo !== "alertas") return true;
    return !ehConversa(texto, opcoes);
  }

  const AGRADECIMENTOS = {
    profissional: ["Registrado."],
    equilibrado:  ["Obrigado, registrado."],
    amigavel:     ["Valeu, parceiro, registrado."],
    bem_humorado: ["Anotado! A estrada agradece.", "Registrado. Mais um ponto pro time da estrada.", "Valeu! Informação boa é igual café: ajuda a viagem."],
  };

  // Como o alerta chama cada tipo (fala). Tipos com valor usam a forma "Altura máxima 4,3 metros".
  const FALA_TIPO = {
    altura_maxima: { nome: "Altura máxima", unidade: ["metro", "metros"] },
    limite_peso:   { nome: "Limite de peso", unidade: ["tonelada", "toneladas"] },
    obra:          { nome: "obra" },
    buraco:        { nome: "buraco na pista" },
    acidente:      { nome: "acidente" },
    radar_movel:   { nome: "radar móvel" },
    animal:        { nome: "animal na pista" },
    // tipos do pacote E5 (taxonomia 7.1)
    fila:               { nome: "trânsito parado" },
    objeto:             { nome: "objeto na pista" },
    veiculo_parado:     { nome: "veículo parado" },
    alagamento:         { nome: "alagamento" },
    neblina:            { nome: "neblina" },
    pista_escorregadia: { nome: "pista escorregadia" },
    balanca:            { nome: "balança" },
    // lote 1b: texto neutro e fixo, sem distância, sem "confirmado" e sem descrição de pessoa ou veículo
    risco_seguranca:    { nome: "risco à segurança", fixa: "Atenção: relatos de risco à segurança neste trecho. Fique atento." },
  };

  // 4.3 → "4,3"; 45 → "45"; 4.25 → "4,25"
  function numeroFalado(n) {
    const v = Math.round(Number(n) * 100) / 100;
    return String(v).replace(".", ",");
  }
  function comUnidade(n, formas) {
    return numeroFalado(n) + " " + (Math.abs(Number(n)) === 1 ? formas[0] : formas[1]);
  }

  // Distância falada: arredonda para não falar "487 metros" (abaixo de 100 m: de 10 em 10; até 1 km: de 50 em 50).
  function distanciaFalada(m) {
    const d = Math.max(0, Number(m) || 0);
    if (d >= 1000) return comUnidade(Math.round(d / 100) / 10, ["quilômetro", "quilômetros"]);
    const r = d < 100 ? Math.max(10, Math.round(d / 10) * 10) : Math.round(d / 50) * 50;
    return r >= 1000 ? "1 quilômetro" : r + " metros";
  }

  // Texto do alerta: igual em todos os perfis. tipo = tipo do app (altura_maxima, obra…).
  function textoAlerta(tipo, valor, distanciaM) {
    const f = FALA_TIPO[tipo];
    const onde = "a " + distanciaFalada(distanciaM);
    if (!f) return "Atenção: alerta " + onde + ".";
    if (f.fixa) return f.fixa;
    if (f.unidade && valor != null && isFinite(valor)) return f.nome + " " + comUnidade(valor, f.unidade) + " " + onde + ".";
    if (f.unidade) return "Atenção: " + f.nome.toLowerCase() + " " + onde + ".";
    return "Atenção: " + f.nome + " " + onde + ".";
  }

  // Agradecimento depois do voto. indice escolhe entre as variações (só o Bem-humorado tem mais de uma).
  function agradecimento(perfil, indice) {
    const lista = AGRADECIMENTOS[perfil] || AGRADECIMENTOS[PERFIL_PADRAO];
    const i = Math.abs(Math.floor(Number(indice) || 0)) % lista.length;
    return lista[i];
  }

  function lerPreferencias(storage) {
    let o = null;
    try { o = JSON.parse((storage && storage.getItem(CHAVE_PREF)) || "null"); } catch (e) { o = null; }
    o = o || {};
    return { ligada: o.ligada !== false, perfil: PERFIS[o.perfil] ? o.perfil : PERFIL_PADRAO, modo: MODOS[o.modo] ? o.modo : MODO_PADRAO };
  }
  function gravarPreferencias(storage, pref) {
    try { storage && storage.setItem(CHAVE_PREF, JSON.stringify({ ligada: !!pref.ligada, perfil: PERFIS[pref.perfil] ? pref.perfil : PERFIL_PADRAO, modo: MODOS[pref.modo] ? pref.modo : MODO_PADRAO })); } catch (e) { /* ignora */ }
  }

  // WAV mono 8 kHz 8 bits só de silêncio (data: URI), gerado aqui: nenhum arquivo de som no app. Tocado em laço mantém a
  // sessão de áudio do iPhone em "playback" (a fala da síntese não some no modo silencioso).
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function base64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=") + (i + 2 < bytes.length ? B64[c & 63] : "=");
    }
    return s;
  }
  function wavSilencio(segundos) {
    const taxa = 8000, n = Math.max(1, Math.round((segundos || 1) * taxa));
    const b = new Uint8Array(44 + n);
    const txt = (o, t) => { for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); };
    const u32 = (o, v) => { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; b[o + 2] = (v >> 16) & 255; b[o + 3] = (v >> 24) & 255; };
    const u16 = (o, v) => { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; };
    txt(0, "RIFF"); u32(4, 36 + n); txt(8, "WAVE"); txt(12, "fmt "); u32(16, 16); u16(20, 1); u16(22, 1); u32(24, taxa); u32(28, taxa); u16(32, 1); u16(34, 8);
    txt(36, "data"); u32(40, n);
    b.fill(128, 44); // 8 bits sem sinal: 128 = silêncio
    return b;
  }
  function wavSilencioDataUri(segundos) { return "data:audio/wav;base64," + base64(wavSilencio(segundos)); }

  function ehIOS(ua) {
    try {
      const n = typeof navigator !== "undefined" ? navigator : null;
      const u = ua != null ? String(ua) : n ? String(n.userAgent || "") : "";
      if (/iPhone|iPad|iPod/i.test(u)) return true;
      return ua == null && !!n && n.platform === "MacIntel" && n.maxTouchPoints > 1; // iPad com "site para computador"
    } catch (e) { return false; }
  }

  // Falador: envolve speechSynthesis. sintese/Enunciado injetáveis.
  // Lições do iPhone/Chrome (revisão 5, "não escuto nada"):
  //  - cancel() logo antes de speak() engole a frase no Safari/iOS: só cancela se HÁ FALA NOSSA em curso e, nesse caso,
  //    espera um instante (esperaCancelMs) antes de falar. "Em curso" é um relógio próprio (enunciado guardado, sem onend,
  //    dentro do tempo estimado): speechSynthesis.speaking fica preso em true no iOS depois de um cancel e não vale;
  //  - o enunciado precisa ficar referenciado até acabar (o coletor de lixo do Chrome/Safari o descarta e o onend nunca vem);
  //  - getVoices() é vazio até o evento "voiceschanged": a voz é escolhida na hora de falar e guardada quando aparece;
  //  - o Chrome para sozinho depois de ~15 s: pause()/resume() periódico enquanto fala. NÃO no iOS: lá o pause() mata a fala;
  //  - iPhone no modo silencioso cala a síntese: navigator.audioSession.type = "playback" (iOS 16.4+) e um <audio> em laço
  //    com 1 s de silêncio (data: URI) mantêm a sessão em playback; o app o pausa com o microfone aberto;
  //  - vozes gravadas (opcoes.clipes = tocador de vozclipes.js): frase com clipe toca o mp3 no lugar da síntese, na mesma fila e com o
  //    mesmo corte (cancelar(), prioridade, microfone aberto); sem clipe ou com qualquer falha, a voz do aparelho fala (falarSistema);
  //  - destravar() (dentro de um toque) fala um enunciado mudo; só conta como destravado quando o onstart/onend de uma fala
  //    de verdade chega (destravado()). Sem onstart em semOnstartMs a fala é dada como perdida: aoFalhar.
  function criarFalador(opcoes) {
    const o = opcoes || {};
    const sintese = o.sintese !== undefined ? o.sintese : (typeof speechSynthesis !== "undefined" ? speechSynthesis : null);
    const Enunciado = o.Enunciado !== undefined ? o.Enunciado : (typeof SpeechSynthesisUtterance !== "undefined" ? SpeechSynthesisUtterance : null);
    const esperaCancelMs = o.esperaCancelMs != null ? o.esperaCancelMs : 90;
    const semOnstartMs = o.semOnstartMs != null ? o.semOnstartMs : 3000;
    const agendar = o.setTimeout || ((typeof setTimeout !== "undefined") ? setTimeout.bind(globalThis) : null);
    const cancelarAgenda = o.clearTimeout || ((typeof clearTimeout !== "undefined") ? clearTimeout.bind(globalThis) : null);
    const agora = o.agora || (() => Date.now());
    const ios = o.ios !== undefined ? !!o.ios : ehIOS(o.userAgent);
    const segurando = new Map();       // enunciado → { t, len, fim }: referências fortes aos enunciados em andamento
    const agendados = new Map();       // timer → { fim }: falas esperando o respiro depois de um cancel
    const estado = { falas: 0, iniciadas: 0, perdidas: 0, ultimoErro: null, vozNome: null, destravado: false, destravares: 0, silencio: false, ios, clipes: 0, clipesFallback: 0 };
    // Vozes gravadas (vozclipes.js): opcoes.clipes = tocador. Frase com clipe toca o arquivo; sem clipe (ou se falhar) fala com a voz do aparelho.
    const clipes = o.clipes && typeof o.clipes.planejar === "function" ? o.clipes : null;
    const valorOpc = (v, p) => { try { return typeof v === "function" ? v() : v != null ? v : p; } catch (e) { return p; } };
    const esperaClipeMs = o.esperaClipeMs != null ? o.esperaClipeMs : 1200;
    let clipeAtual = null;             // fala em clipe em curso (para o microfone abrir calando-a)
    let vozCache = null, aoFalhar = typeof o.aoFalhar === "function" ? o.aoFalhar : null, pulso = null;
    let muda = null;                   // enunciado mudo do destravar em andamento: { u, t }
    let audio = null;

    function disponivel() { return !!(sintese && typeof sintese.speak === "function" && Enunciado); }
    function vozPtBr() {
      try {
        if (vozCache) return vozCache;
        const vozes = (sintese.getVoices && sintese.getVoices()) || [];
        const v = vozes.find((x) => /^pt[-_]BR$/i.test(x.lang)) || vozes.find((x) => /^pt/i.test(x.lang)) || null;
        if (v) { vozCache = v; estado.vozNome = v.name || v.lang; }
        return v;
      } catch (e) { return null; }
    }
    if (sintese && typeof sintese.addEventListener === "function") {
      try { sintese.addEventListener("voiceschanged", () => { vozCache = null; vozPtBr(); }); } catch (e) { /* ignora */ }
    }
    // Fala nossa em curso, pelo relógio próprio: enunciado guardado que não terminou e ainda está dentro do tempo estimado.
    function emCurso() {
      const t = agora();
      for (const [u, i] of segurando) if (t > i.t + 3000 + 110 * i.len) segurando.delete(u); // onend nunca veio: esquece
      if (!segurando.size) desligarPulso();
      return segurando.size > 0;
    }
    // Chrome: a síntese para sozinha depois de ~15 s; pause/resume mantém viva. No iOS o pause() mata a fala: nunca.
    function ligarPulso() {
      if (ios || pulso || !o.setInterval && typeof setInterval === "undefined") return;
      const si = o.setInterval || setInterval;
      try { pulso = si(() => { if (!emCurso()) { desligarPulso(); return; } try { if (sintese.speaking && !sintese.paused) { sintese.pause(); sintese.resume(); } } catch (e) { /* ignora */ } }, 10000); if (pulso && typeof pulso.unref === "function") pulso.unref(); } catch (e) { /* ignora */ }
    }
    function desligarPulso() { if (pulso) { try { (o.clearInterval || clearInterval)(pulso); } catch (e) { /* ignora */ } pulso = null; } }

    function emitirFalha(motivo, texto) {
      estado.perdidas++; estado.ultimoErro = motivo;
      try { if (aoFalhar) aoFalhar({ motivo, texto }); } catch (e) { /* ignora */ }
    }
    // Escolhe o jeito de falar: clipe gravado (se a voz escolhida tem a frase) ou a voz do aparelho.
    function criarEFalar(texto, opc) {
      let plano = null;
      if (clipes) { try { plano = clipes.planejar(String(texto)); } catch (e) { plano = null; } }
      if (plano && falarClipe(plano, texto, opc)) return;
      falarSistema(texto, opc);
    }
    // Fala em clipe: ocupa a fila como qualquer fala nossa (relógio próprio), carrega os mp3 (cache/rede, até esperaClipeMs) e toca;
    // qualquer falha cai na voz do aparelho com a frase inteira. calar()/corte por prioridade chamam fim(): para o áudio.
    function falarClipe(plano, texto, opc) {
      const chave = {};
      let feito = false, cancelado = false, tocando = null;
      const handle = { parar: () => fim() };
      const fim = () => {
        if (feito) return;
        feito = true; cancelado = true;
        if (tocando) { try { tocando.parar(); } catch (e) { /* ignora */ } tocando = null; }
        if (clipeAtual === handle) clipeAtual = null;
        segurando.delete(chave);
        if (opc && typeof opc.aoTerminar === "function") opc.aoTerminar();
      };
      const cair = (motivo) => {
        if (feito || cancelado) return;
        feito = true; cancelado = true;
        if (tocando) { try { tocando.parar(); } catch (e) { /* ignora */ } tocando = null; }
        if (clipeAtual === handle) clipeAtual = null;
        segurando.delete(chave);
        estado.clipesFallback++; estado.ultimoClipe = motivo;
        try { falarSistema(texto, opc); } catch (e) { emitirFalha("excecao", texto); }
      };
      const tocar = () => {
        if (cancelado) return;
        tocando = clipes.tocar(plano, {
          volume: () => valorOpc(o.volume, 1), taxa: () => valorOpc(o.taxa, 1),
          aoIniciar: () => { estado.iniciadas++; estado.clipes++; },
          aoFim: fim,
          aoErro: (motivo) => cair(motivo || "erro"),
        });
      };
      segurando.set(chave, { t: agora(), len: String(texto).length, fim });
      clipeAtual = handle;
      let prontos = false;
      try { prontos = !!clipes.prontos(plano); } catch (e) { prontos = false; }
      if (prontos) tocar();
      else {
        let p = null;
        try { p = clipes.carregar(plano, esperaClipeMs); } catch (e) { p = null; }
        if (!p || typeof p.then !== "function") { cair("carregamento"); return true; }
        p.then((ok) => { if (cancelado) return; if (ok) tocar(); else cair("carregamento"); }, () => cair("carregamento"));
      }
      return true;
    }
    function falarSistema(texto, opc) {
      const u = new Enunciado(String(texto));
      u.lang = "pt-BR";
      const v = vozPtBr(); if (v) u.voice = v;
      u.rate = 1; u.pitch = 1; u.volume = 1;
      let feito = false, comecou = false, vigia = null;
      const fim = () => {
        if (vigia && cancelarAgenda) { cancelarAgenda(vigia); vigia = null; }
        segurando.delete(u); if (!segurando.size) desligarPulso();
        if (!feito) { feito = true; if (opc && typeof opc.aoTerminar === "function") opc.aoTerminar(); }
      };
      u.onstart = () => { comecou = true; estado.iniciadas++; estado.destravado = true; if (vigia && cancelarAgenda) { cancelarAgenda(vigia); vigia = null; } };
      u.onend = () => { estado.destravado = true; fim(); };
      u.onerror = (ev) => {
        const motivo = (ev && ev.error) || "erro";
        // "interrupted"/"canceled": fomos nós (outra fala ou calar()); não é falha de áudio
        if (motivo !== "interrupted" && motivo !== "canceled") emitirFalha(motivo, texto);
        fim();
      };
      segurando.set(u, { t: agora(), len: String(texto).length, fim });
      sintese.speak(u);
      ligarPulso();
      // Safari sem gesto / modo silencioso / áudio bloqueado: speak() "funciona" mas nunca começa
      if (agendar && semOnstartMs > 0) {
        vigia = agendar(() => { vigia = null; if (!comecou && segurando.has(u) && !(sintese.speaking)) { emitirFalha("sem_inicio", texto); fim(); } }, semOnstartMs);
      }
    }
    // Termina (sem som) tudo o que é nosso: as falas em curso e as que esperavam o respiro.
    function encerrarNossas() {
      for (const [t, i] of [...agendados]) { agendados.delete(t); if (cancelarAgenda) { try { cancelarAgenda(t); } catch (e) { /* ignora */ } } i.fim(); }
      for (const [, i] of [...segurando]) i.fim();
      segurando.clear();
    }
    // Fala o texto, interrompendo o que estiver falando. Devolve false se não deu.
    // opcoes.aoTerminar: chamado quando a fala acaba (onend/onerror), uma vez só.
    function falar(texto, opcoes) {
      if (!disponivel() || texto == null) return false;
      estado.falas++;
      try {
        const ocupado = emCurso() || agendados.size > 0;
        if (ocupado) {
          encerrarNossas();
          if (sintese.cancel) {
            sintese.cancel();
            // speak() colado no cancel() é engolido no iOS: dá um respiro
            if (agendar && esperaCancelMs > 0) {
              let t = null;
              const item = { fim: () => { if (opcoes && typeof opcoes.aoTerminar === "function" && !item.feito) { item.feito = true; opcoes.aoTerminar(); } }, feito: false };
              t = agendar(() => { agendados.delete(t); item.feito = true; try { criarEFalar(texto, opcoes); } catch (e) { emitirFalha("excecao", texto); } }, esperaCancelMs);
              agendados.set(t, item);
              return true;
            }
          }
        }
        criarEFalar(texto, opcoes);
        return true;
      } catch (e) { return false; }
    }

    // ---- áudio mudo em laço (iPhone no modo silencioso)
    function iniciarSilencio() {
      if (o.semSilencio) return false;
      try {
        if (!audio) {
          const A = o.Audio !== undefined ? o.Audio : (typeof Audio !== "undefined" ? Audio : null);
          if (!A) return false;
          audio = new A(wavSilencioDataUri(1));
          audio.loop = true; audio.playsInline = true;
          if (typeof audio.setAttribute === "function") { audio.setAttribute("playsinline", ""); audio.setAttribute("aria-hidden", "true"); }
        }
        const p = audio.play();
        if (p && typeof p.then === "function") p.then(() => { estado.silencio = true; }, () => { estado.silencio = false; });
        else estado.silencio = true;
        return true;
      } catch (e) { estado.silencio = false; return false; }
    }
    function pararSilencio() { try { if (audio) audio.pause(); } catch (e) { /* ignora */ } estado.silencio = false; }
    // Microfone abrindo: o áudio em laço sai (o iOS não grava e toca ao mesmo tempo); ao fechar, volta.
    // (com um clipe tocando, o microfone aberto também o corta: o iOS não grava e toca ao mesmo tempo)
    function pausarSilencio() { if (audio) pararSilencio(); if (clipeAtual) { try { clipeAtual.parar(); } catch (e) { /* ignora */ } } }
    function retomarSilencio() { if (audio && estado.destravado) iniciarSilencio(); }

    // iPhone/Safari só libera a fala depois de um toque: dentro do toque põe a sessão em playback, liga o áudio mudo em laço
    // e fala um enunciado mudo (volume 0). Só vale como destravado quando o onstart/onend chegar (estado.destravado).
    // Chamar de novo a cada toque até lá.
    function destravar() {
      if (!disponivel()) return false;
      estado.destravares++;
      try { if (typeof navigator !== "undefined" && navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) { /* ignora */ }
      iniciarSilencio();
      if (clipes) { try { clipes.destravar(); } catch (e) { /* ignora */ } } // libera também o <audio> dos clipes (dentro do toque)
      try {
        if (estado.destravado) return true;
        if (muda && agora() - muda.t < 2500) return true; // o do toque anterior ainda está na fila
        const u = new Enunciado(" "); u.volume = 0; u.lang = "pt-BR";
        const m = { u, t: agora() }; muda = m;
        const ok = () => { estado.destravado = true; };
        const fora = () => { if (muda === m) muda = null; };
        u.onstart = ok; u.onend = () => { ok(); fora(); }; u.onerror = fora;
        sintese.speak(u); return true;
      } catch (e) { return false; }
    }
    // Cala o que estiver falando (antes de abrir o microfone: o reconhecimento não pode ouvir a própria fala).
    // Sem fala nossa em curso não mexe na síntese (nem no enunciado mudo do destravar).
    function cancelar() {
      if (!sintese || typeof sintese.cancel !== "function") return false;
      try {
        if (!emCurso() && !agendados.size) return true;
        encerrarNossas(); muda = null;
        sintese.cancel(); return true;
      } catch (e) { return false; }
    }
    // Fala nossa em curso (relógio próprio; 'speaking' do aparelho fica preso em true no iOS)
    function falando() { try { return emCurso() || agendados.size > 0; } catch (e) { return false; } }
    function defineAoFalhar(fn) { aoFalhar = typeof fn === "function" ? fn : null; }
    return { disponivel, falar, destravar, cancelar, falando, estado, aoFalhar: defineAoFalhar, destravado: () => estado.destravado,
      pausarSilencio, retomarSilencio, pararSilencio, iniciarSilencio, ios, clipes };
  }

  // ------------------------------------------------------------ bipe de rádio (VOZ-02)
  // Bipe curto estilo rádio PX, gerado no código (WebAudio, sem arquivo de som):
  //  inicio = dois tons subindo ("pode falar"); fim = dois tons descendo ("câmbio"); ok = dois toques curtos (relato aceito).
  // Preferência própria (liga/desliga), guardada à parte da voz.
  const CHAVE_BIPE = "copiloto.voz.bipe.v1";
  const BIPES = {
    inicio: [[1250, 0.06], [1650, 0.07]],
    fim:    [[1650, 0.06], [1150, 0.1]],
    ok:     [[1900, 0.04], [0, 0.035], [1900, 0.04]],
  };
  function lerBipe(storage) {
    try { const o = JSON.parse((storage && storage.getItem(CHAVE_BIPE)) || "null"); return !(o && o.ligado === false); } catch (e) { return true; }
  }
  function gravarBipe(storage, ligado) {
    try { storage && storage.setItem(CHAVE_BIPE, JSON.stringify({ ligado: !!ligado })); } catch (e) { /* ignora */ }
  }
  // AudioContext injetável. O primeiro tocar() deve acontecer dentro de um toque (iPhone só libera o áudio assim).
  function criarBipe(opcoes) {
    const o = opcoes || {};
    const g = typeof window !== "undefined" ? window : {};
    const AC = o.AudioContext !== undefined ? o.AudioContext : (g.AudioContext || g.webkitAudioContext || null);
    const volume = o.volume != null ? o.volume : 0.12;
    let ctx = null;
    function disponivel() { return typeof AC === "function"; }
    function contexto() {
      if (!ctx) ctx = new AC();
      if (ctx.state === "suspended" && ctx.resume) { try { ctx.resume(); } catch (e) { /* ignora */ } }
      return ctx;
    }
    function tocar(nome) {
      const notas = BIPES[nome];
      if (!notas || !disponivel()) return false;
      try {
        const c = contexto();
        let t = (c.currentTime || 0) + 0.01;
        const saida = c.createGain(); saida.gain.value = volume;
        let destino = saida;
        // passa-baixa: som "de rádio", menos estridente
        if (c.createBiquadFilter) { const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 2600; f.connect(saida); destino = f; }
        saida.connect(c.destination);
        for (const [freq, dur] of notas) {
          if (freq > 0) {
            const osc = c.createOscillator(), env = c.createGain();
            osc.type = "square"; osc.frequency.setValueAtTime(freq, t);
            env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + 0.005);
            env.gain.setValueAtTime(1, t + dur - 0.008); env.gain.linearRampToValueAtTime(0, t + dur);
            osc.connect(env); env.connect(destino);
            osc.start(t); osc.stop(t + dur + 0.01);
          }
          t += dur;
        }
        return true;
      } catch (e) { return false; }
    }
    return { disponivel, tocar, destravar: () => { if (!disponivel()) return false; try { contexto(); return true; } catch (e) { return false; } } };
  }

  const api = { MODOS, MODO_PADRAO, ehConversa, permiteFala, wavSilencio, wavSilencioDataUri, ehIOS, CHAVE_BIPE, BIPES, lerBipe, gravarBipe, criarBipe, PERFIS, PERFIL_PADRAO, AGRADECIMENTOS, CHAVE_PREF, numeroFalado, distanciaFalada, textoAlerta, agradecimento,
    lerPreferencias, gravarPreferencias, criarFalador };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoVoz = api;
})(typeof window !== "undefined" ? window : globalThis);
