// Placas e sinais (SVG inline, desenhos originais; nada copiado de terceiros). Estilo das placas do CTB/CONTRAN:
//   advertência  = losango amarelo, borda preta;  regulamentação = círculo branco, borda vermelha (parada: octógono vermelho);
//   indicação    = retângulo azul (serviços) ou verde (área de escape), símbolo branco.
// As cores da placa são as da placa de verdade e não mudam com o tema (claro/escuro): cada placa leva um contorno branco
// fino, que a separa do mapa escuro; no claro o app põe uma sombra (estilos/placas.css). Nenhum texto no desenho: os números
// (limite de velocidade, altura, peso, largura, rampa) são TRAÇOS desenhados aqui, sem depender de fonte do aparelho.
// A cor nunca está sozinha: cada placa tem forma e desenho próprios, nome (aria-label e <title>) e, nas listas, texto ao lado.
// Uso:
//   CopilotoPlacas.svg("subida_ingreme", { valor: 8, tamanho: 56 })  → string SVG (serve no Node, nos testes)
//   CopilotoPlacas.placa("limite_velocidade", { valor: 80, tamanho: 40 }) → elemento SVG (navegador); decorativa: true = aria-hidden
//   CopilotoPlacas.catalogo()     → [{ id, nome, categoria, significado, valor: null | { unidade, exemplo } }]
//   CopilotoPlacas.tipoParaPlaca  → { tipo (relato, aviso, via, posto): id da placa };  idDoTipo(tipo) com reserva ("atencao")
//   CopilotoPlacas.severidade(tipo) → "restricao" | "atencao" | "informativo"
// Também fica em Copiloto.placas quando o núcleo (ui/nucleo.js) já carregou.
(function (raiz) {
  "use strict";
  const AMARELO = "#ffc400", PRETO = "#111418", VERMELHO = "#d32f2f", AZUL = "#0b5fa5", VERDE = "#0b7a3e", BRANCO = "#ffffff";

  // ------------------------------------------------------------ números em traços (altura 16, largura 10)
  const DIG = {
    "0": "M5 1.2C2.6 1.2 1.4 3.4 1.4 8s1.2 6.8 3.6 6.8 3.6-2.2 3.6-6.8S7.4 1.2 5 1.2Z",
    "1": "M2.2 4.4 5.8 1.4V14.8",
    "2": "M1.6 4.2C1.9 2.2 3.2 1.2 5 1.2c2.2 0 3.5 1.3 3.5 3.3 0 1.7-1 2.9-2.6 4.4L1.5 14.8H8.8",
    "3": "M1.8 2.6C2.7 1.7 3.8 1.2 5 1.2c2 0 3.4 1.2 3.4 3 0 1.9-1.4 3-3.6 3 2.4 0 3.9 1.1 3.9 3.2 0 2.2-1.7 3.4-3.9 3.4-1.5 0-2.8-.6-3.5-1.7",
    "4": "M7 14.8V1.4L1.2 10.6H9.2",
    "5": "M8.3 1.4H2.3L1.8 7.2c.8-.7 1.9-1 3-1 2.4 0 4 1.5 4 4s-1.7 4.6-4 4.6c-1.5 0-2.6-.5-3.4-1.5",
    "6": "M8 2.6C7.1 1.7 6 1.2 4.9 1.2 2.7 1.2 1.3 3.5 1.3 8.4c0 4.4 1.4 6.4 3.7 6.4 2.2 0 3.8-1.6 3.8-4.2s-1.6-4-3.8-4C3.2 6.6 1.9 7.6 1.4 9",
    "7": "M1.2 1.4H8.8L4.2 14.8",
    "8": "M5 7.8C2.8 7.8 1.6 6.6 1.6 4.5c0-2 1.4-3.3 3.4-3.3s3.4 1.3 3.4 3.3c0 2.1-1.2 3.3-3.4 3.3Zm0 0c-2.5 0-3.8 1.5-3.8 3.7 0 2 1.5 3.3 3.8 3.3s3.8-1.3 3.8-3.3c0-2.2-1.3-3.7-3.8-3.7Z",
    "9": "M8 2.6C7.1 1.7 6 1.2 4.9 1.2 2.7 1.2 1.3 3.5 1.3 8.4c0 4.4 1.4 6.4 3.7 6.4 2.2 0 3.8-1.6 3.8-4.2s-1.6-4-3.8-4C3.2 6.6 1.9 7.6 1.4 9",
    ",": "M2 13.6V14.9L.9 16.8",
    ".": "M2 14.7V14.9",
    "%": "M10.2 1.8 2 14.2M2.8 5.6a2 2 0 100-4 2 2 0 000 4ZM9.6 14.6a2 2 0 100-4 2 2 0 000 4Z",
  };
  const LARG = { ",": 4, ".": 4, "%": 12.5 };
  const GAP = 3;
  // texto: só 0-9 , . %; (cx, cy) é o centro; h é a altura em unidades da placa (64 × 64); cor do traço
  function numero(texto, cx, cy, h, cor) {
    const cs = String(texto).split("").filter((c) => DIG[c]);
    if (!cs.length) return "";
    const s = h / 16;
    let total = 0; cs.forEach((c, i) => { total += (LARG[c] || 10) + (i ? GAP : 0); });
    let x = cx - total * s / 2, out = "";
    cs.forEach((c) => {
      const rot = c === "9" ? ' transform="rotate(180 5 8)"' : "";
      out += '<g transform="translate(' + r2(x) + " " + r2(cy - h / 2) + ") scale(" + r2(s) + ')"><path d="' + DIG[c] + '"' + rot + ' fill="none" stroke="' + cor + '" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/></g>';
      x += ((LARG[c] || 10) + GAP) * s;
    });
    return out;
  }
  function r2(n) { return Math.round(n * 100) / 100; }
  // altura do número conforme o tamanho do texto (cabe no círculo de dentro)
  const hNum = (t, a, b, c) => (t.length <= 2 ? a : t.length === 3 ? b : c);

  // ------------------------------------------------------------ molduras
  function losango(g) {
    return '<path d="M32 2.8 61.2 32 32 61.2 2.8 32Z" fill="#fff" stroke="#fff" stroke-width="5.5" stroke-linejoin="round"/>' +
      '<path d="M32 4.6 59.4 32 32 59.4 4.6 32Z" fill="' + AMARELO + '" stroke="' + PRETO + '" stroke-width="3.2" stroke-linejoin="round"/>' + g;
  }
  function circulo(g) {
    return '<circle cx="32" cy="32" r="30.4" fill="#fff"/><circle cx="32" cy="32" r="25.6" fill="#fff" stroke="' + VERMELHO + '" stroke-width="7"/>' + g;
  }
  function octogono(g) {
    const p = []; for (let i = 0; i < 8; i++) { const a = (22.5 + 45 * i) * Math.PI / 180; p.push(r2(32 + 30 * Math.cos(a)) + " " + r2(32 + 30 * Math.sin(a))); }
    const q = []; for (let i = 0; i < 8; i++) { const a = (22.5 + 45 * i) * Math.PI / 180; q.push(r2(32 + 25 * Math.cos(a)) + " " + r2(32 + 25 * Math.sin(a))); }
    return '<polygon points="' + p.join(" ") + '" fill="' + VERMELHO + '" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>' +
      '<polygon points="' + q.join(" ") + '" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>' + g;
  }
  function retangulo(cor, g) {
    return '<rect x="3" y="3" width="58" height="58" rx="9" fill="' + cor + '" stroke="#fff" stroke-width="3"/>' +
      '<rect x="7.5" y="7.5" width="49" height="49" rx="5.5" fill="none" stroke="#fff" stroke-width="1.5"/>' + g;
  }

  // ------------------------------------------------------------ peças do desenho
  const tr = (d, w, cor, extra) => '<path d="' + d + '" fill="none" stroke="' + (cor || PRETO) + '" stroke-width="' + (w || 3.6) + '" stroke-linecap="' + (extra === "reto" ? "butt" : "round") + '" stroke-linejoin="round"/>';
  const pr = (d, cor) => '<path d="' + d + '" fill="' + (cor || PRETO) + '"/>';
  const bc = (d, w) => tr(d, w || 3.8, BRANCO);
  const bp = (d) => pr(d, BRANCO);
  const circ = (x, y, r, cor, tracoCor) => '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + cor + '"' + (tracoCor ? ' stroke="' + tracoCor + '" stroke-width="1.6"' : "") + "/>";
  const espelho = (g) => '<g transform="translate(64 0) scale(-1 1)">' + g + "</g>";
  const carroLado = (x, y, k) => { // carro de lado, canto esquerdo (x, y); k = escala
    return '<g transform="translate(' + x + " " + y + ") scale(" + (k || 1) + ')">' + pr("M0 9H22V5H0Z") + pr("M4 5 7 0H15L18 5Z") + circ(5, 9.5, 2.6, PRETO, AMARELO) + circ(17, 9.5, 2.6, PRETO, AMARELO) + "</g>";
  };
  function estrela(cx, cy, re, ri, n) {
    const p = []; for (let i = 0; i < n * 2; i++) { const a = -Math.PI / 2 + i * Math.PI / n, r = i % 2 ? ri : re; p.push(r2(cx + r * Math.cos(a)) + " " + r2(cy + r * Math.sin(a))); }
    return p.join(" ");
  }
  const caminhaoLado = (x, y, cor, janela) => '<g transform="translate(' + x + " " + y + ')">' + pr("M0 0H21V14H0Z", cor) + pr("M21 4H29L34 10V14H21Z", cor) + pr("M24 6.5H28L30.5 10H24Z", janela || BRANCO) + circ(6, 16, 3.4, cor, janela || BRANCO) + circ(27, 16, 3.4, cor, janela || BRANCO) + "</g>";

  // ------------------------------------------------------------ as placas
  // Cada entrada: nome, categoria, significado, desenho(valor) → string SVG (64 × 64), valor (opcional: { unidade, exemplo }).
  const P = {};
  function def(id, nome, categoria, significado, desenho, valor) { P[id] = { id, nome, categoria, significado, desenho, valor: valor || null }; }

  // --- advertência (losango amarelo)
  def("subida_ingreme", "Subida íngreme", "advertencia", "Rampa forte para cima: marcha reduzida, sem ultrapassar.", (v) => {
    const t = v == null ? "" : fmt(v) + "%";
    return losango(t ? pr("M19 33H45V18Z") + numero(t, 32, 41.6, 9.5, PRETO) : pr("M18 41H46V23Z"));
  }, { unidade: "%", exemplo: 8 });
  def("descida_ingreme", "Descida íngreme", "advertencia", "Rampa forte para baixo: use o freio-motor, não só o freio.", (v) => {
    const t = v == null ? "" : fmt(v) + "%";
    return losango(t ? pr("M19 18V33H45Z") + numero(t, 32, 41.6, 9.5, PRETO) : pr("M18 23V41H46Z"));
  }, { unidade: "%", exemplo: 8 });
  def("curva_esquerda", "Curva acentuada à esquerda", "advertencia", "Curva fechada para a esquerda: reduza antes de entrar.", () => losango(tr("M40 46V34Q40 25 31 25H25") + tr("M31 19 25 25 31 31")));
  def("curva_direita", "Curva acentuada à direita", "advertencia", "Curva fechada para a direita: reduza antes de entrar.", () => losango(espelho(tr("M40 46V34Q40 25 31 25H25") + tr("M31 19 25 25 31 31"))));
  def("curva_forte", "Curva forte", "advertencia", "Curva forte à frente: reduza e mantenha a faixa.", () => losango(tr("M24 46V28Q24 19 32 19T40 28V37") + tr("M35 33 40 39.5 45 33")));
  def("curva_s", "Curva em S", "advertencia", "Duas curvas seguidas, uma para cada lado.", () => losango(tr("M26 47C26 38 38 40 38 31V21") + tr("M33 26.5 38 20.5 43 26.5")));
  def("sequencia_curvas", "Sequência de curvas", "advertencia", "Várias curvas seguidas: mantenha a velocidade baixa.", () => losango(tr("M25 46 38 39 26 32 38 25V21") + tr("M33 26.5 38 20.5 43 26.5")));
  def("pista_sinuosa", "Pista sinuosa", "advertencia", "Pista cheia de curvas, sem reta longa.", () => losango(tr("M23 18C31 22 20 28 27 33S30 42 27 47", 3.4) + tr("M37 18C45 22 34 28 41 33S44 42 41 47", 3.4)));
  def("pista_escorregadia", "Pista escorregadia", "advertencia", "Pista lisa por chuva, óleo ou barro: sem freada brusca.", () => losango(carroLado(21, 25, 1) + tr("M21 43q3-3.4 6 0t6 0 6 0 6 0", 3) + tr("M24 48q2.6-3 5.2 0t5.2 0", 3)));
  def("queda_pedras", "Queda de pedras", "advertencia", "Barranco com risco de pedras na pista.", () => losango(pr("M16 42V25L34 42Z") + circ(39, 26, 3.8, PRETO) + circ(46, 33, 3.3, PRETO) + circ(40, 39, 2.9, PRETO)));
  def("animais_pista", "Animais na pista", "advertencia", "Pode haver animal atravessando: atenção, principalmente à noite.", () => losango(
    pr("M23 30H41Q44 30 44 33V36Q44 38 41 38H25Q22 38 22 36Z") + pr("M22 31 19.5 25 25 25 27 30Z") + pr("M16 22H25V27H18Z") +
    tr("M25 38V46M30 38V46M37 38V46M41 38V46", 3) + tr("M20 22 18 17M23 22 24 17", 2.2) + tr("M44 31 47 28", 2.4)));
  def("estreitamento", "Estreitamento de pista", "advertencia", "A pista fica mais estreita à frente.", () => losango(tr("M22 20C22 28 28 29 28 32S22 36 22 44", 3.8) + tr("M42 20C42 28 36 29 36 32S42 36 42 44", 3.8)));
  def("obras", "Obras na pista", "advertencia", "Trecho em obra: pista reduzida, funcionários e máquinas.", () => losango(
    pr("M32 16 41.5 44H22.5Z") + tr("M27.4 31.5H36.6M24.8 39H39.2", 3, AMARELO) + tr("M18 44H46", 3.4)));
  def("semaforo", "Semáforo à frente", "advertencia", "Semáforo adiante: esteja pronto para parar.", () => losango(
    '<rect x="26" y="17.5" width="12" height="29" rx="4.5" fill="' + PRETO + '"/>' + circ(32, 24, 3.2, "#e53935", BRANCO) + circ(32, 32, 3.2, AMARELO, BRANCO) + circ(32, 40, 3.2, "#2e9e4f", BRANCO)));
  def("passagem_nivel", "Passagem de nível", "advertencia", "Cruzamento com trilho de trem: pare, olhe e só passe com a via livre.", () => losango(tr("M20 22 44 42M44 22 20 42", 6.2, PRETO, "reto")));
  def("ponte_estreita", "Ponte estreita", "advertencia", "Ponte mais estreita que a pista: reduza e dê a vez.", () => losango(tr("M17 41Q32 20 47 41", 3.6) + tr("M17 41H47", 3.6) + tr("M17 25H25M22 22 25 25 22 28", 2.8) + tr("M47 25H39M42 22 39 25 42 28", 2.8)));
  def("balsa", "Balsa", "advertencia", "Travessia de rio ou baía por balsa à frente.", () => losango(pr("M17 37H47L43 43H21Z") + tr("M24 37V30H40V37", 3.2) + tr("M32 30V25", 3.2) + tr("M21 47.5q2.8-3 5.6 0t5.6 0 5.6 0 5.6 0", 2.8)));
  def("lombada", "Lombada", "advertencia", "Elevação na pista: reduza antes, ou o caminhão sofre.", () => losango(pr("M18 41C22 41 24 29 32 29S42 41 46 41Z") + tr("M16 41.8H48", 2.6)));
  def("redutor_velocidade", "Redutor de velocidade", "advertencia", "Ondulações transversais seguidas: reduza.", () => losango(tr("M16 39q4.2-12 8.4 0t8.4 0 8.4 0 8.4 0", 4.4)));
  def("pedagio", "Pedágio", "advertencia", "Praça de pedágio à frente: tenha tag ou dinheiro à mão.", () => losango(
    pr("M20 24H25V42H20Z") + pr("M25 27.5H47V32.5H25Z") + tr("M30 27V33M36 27V33M42 27V33", 2.4, AMARELO, "reto") + tr("M19 43.5H44", 3)));
  def("neblina", "Neblina", "advertencia", "Pouca visibilidade: farol baixo, distância maior.", () => losango(tr("M18 25H40M24 31H46M18 37H40M24 43H44", 3.4)));
  def("alagamento", "Alagamento", "advertencia", "Água na pista: não entre se não souber a profundidade.", () => losango(
    pr("M21 31H43V35H21Z") + pr("M26 31 28.5 26H35.5L38 31Z") + tr("M19 39q3.3-3.6 6.6 0t6.6 0 6.6 0 6.6 0", 3) + tr("M23 45q3-3.2 6 0t6 0 6 0", 3)));
  def("trafego_pesado", "Tráfego pesado", "advertencia", "Fila ou muito caminhão na pista: velocidade baixa.", () => losango(caminhaoLado(14, 24, PRETO, AMARELO)));
  def("acidente", "Acidente", "advertencia", "Acidente na pista: reduza, pode haver gente na via.", () => losango('<polygon points="' + estrela(32, 32, 16, 7.6, 8) + '" fill="' + PRETO + '" stroke="' + PRETO + '" stroke-width="1.6" stroke-linejoin="round"/>' + circ(32, 32, 3, AMARELO)));
  def("objeto_pista", "Objeto na pista", "advertencia", "Algo caído na pista: desvie com cuidado.", () => losango(tr("M32 18 45 25V39L32 46 19 39V25Z", 3.2) + tr("M19 25 32 32 45 25M32 32V46", 3.2)));
  def("veiculo_parado", "Veículo parado", "advertencia", "Veículo parado na pista ou no acostamento.", () => losango(carroLado(16, 28, 1) + tr("M41 41 44.8 33 48.6 41Z", 2.6)));
  def("pista_irregular", "Pista irregular", "advertencia", "Buraco ou piso danificado: reduza.", () => losango(carroLado(21, 24, 1) + tr("M21 42l3.5-3 3.5 3 4-4 4 4 3.5-3 3.5 3", 3.2)));
  def("atencao", "Atenção", "advertencia", "Ponto de atenção: fique atento à pista.", () => losango(tr("M32 17V35", 5.4) + circ(32, 43.4, 3.3, PRETO)));
  def("risco_seguranca", "Risco à segurança", "advertencia", "Relatos de risco neste trecho: evite parar. Em perigo agora, ligue 190.", () => losango(
    '<g transform="translate(32 32) scale(.8) translate(-32 -31.5)">' + tr("M32 14 46 19.5V31C46 40 39.5 45.5 32 48.5 24.5 45.5 18 40 18 31V19.5Z", 3.6) + tr("M32 24V33", 4) + circ(32, 39, 2.5, PRETO) + "</g>"));

  // --- regulamentação (círculo branco, borda vermelha)
  def("limite_velocidade", "Limite de velocidade", "regulamentacao", "Velocidade máxima permitida neste trecho.", (v) => {
    const t = v == null ? "" : fmt(v);
    if (!t) return circulo(tr("M17.5 40A14.5 14.5 0 1146.5 40", 3.6) + tr("M32 38 40.5 27", 4));
    return circulo(numero(t, 32, 32, hNum(t, 21, 17, 14), PRETO));
  }, { unidade: "km/h", exemplo: 80 });
  def("altura_maxima", "Altura máxima", "regulamentacao", "Altura máxima da ponte, viaduto ou túnel. Confira a altura do seu caminhão.", (v) => {
    const t = v == null ? "" : fmt(v);
    const setas = tr("M24 13H40M26 20 32 14.4 38 20", 3.2) + tr("M24 51H40M26 44 32 49.6 38 44", 3.2);
    return circulo(t ? setas + numero(t, 32, 32, hNum(t, 14, 13, 11), PRETO) : setas + tr("M32 20V44", 3.2));
  }, { unidade: "m", exemplo: 4.2 });
  def("largura_maxima", "Largura máxima", "regulamentacao", "Largura máxima de passagem. Confira a largura do seu caminhão.", (v) => {
    const t = v == null ? "" : fmt(v);
    const y = t ? 43 : 32;
    const setas = tr("M13.5 " + (y - 7) + "V" + (y + 7), 3.2) + tr("M50.5 " + (y - 7) + "V" + (y + 7), 3.2) + tr("M14 " + y + "H50", 3.2) + tr("M20 " + (y - 5.5) + " 14 " + y + " 20 " + (y + 5.5), 3.2) + tr("M44 " + (y - 5.5) + " 50 " + y + " 44 " + (y + 5.5), 3.2);
    return circulo(setas + (t ? numero(t, 32, 27, hNum(t, 14, 13, 11), PRETO) : ""));
  }, { unidade: "m", exemplo: 2.6 });
  def("peso_maximo", "Peso máximo", "regulamentacao", "Peso máximo permitido (ponte ou trecho). Confira o peso do seu caminhão.", (v) => {
    const t = v == null ? "" : fmt(v);
    const peso = (sc) => '<g transform="translate(32 ' + (t ? 22 : 32) + ") scale(" + sc + ')">' + pr("M-12 11-8-6H8L12 11Z") + tr("M-4.4-8.6a4.4 4.4 0 018.8 0", 2.8) + "</g>";
    return circulo(peso(t ? 0.62 : 1) + (t ? numero(t, 32, 39.5, hNum(t, 12, 11, 9.5), PRETO) : ""));
  }, { unidade: "t", exemplo: 30 });
  def("proibido_ultrapassar", "Proibido ultrapassar", "regulamentacao", "Não ultrapasse neste trecho.", () => circulo(
    '<rect x="19" y="27" width="11" height="20" rx="3.4" fill="' + VERMELHO + '"/><rect x="21.2" y="31" width="6.6" height="4.6" rx="1.4" fill="#fff"/>' +
    '<rect x="34" y="17" width="11" height="20" rx="3.4" fill="' + PRETO + '"/><rect x="36.2" y="21" width="6.6" height="4.6" rx="1.4" fill="#fff"/>'));
  def("restricao_caminhao", "Caminhão não passa", "regulamentacao", "Restrição para o seu caminhão (altura, peso, largura ou proibição).", () => circulo(
    caminhaoLado(14, 25, PRETO, BRANCO) + tr("M17 15 47 49", 5.4, VERMELHO)));
  def("parada_obrigatoria", "Parada obrigatória", "regulamentacao", "Pare completamente antes de seguir.", () => octogono(
    '<g fill="#fff" stroke="none"><rect x="23.6" y="18" width="3.6" height="17" rx="1.8"/><rect x="28" y="15.5" width="3.6" height="19.5" rx="1.8"/><rect x="32.4" y="15.5" width="3.6" height="19.5" rx="1.8"/><rect x="36.8" y="18" width="3.6" height="17" rx="1.8"/>' +
    '<path d="M23.6 31H40.4V38A7.5 7.5 0 0132.9 45.5H31A7.4 7.4 0 0123.6 38Z"/></g>' + tr("M24 36 19.5 30.6", 3.6, BRANCO)));
  def("radar", "Radar", "regulamentacao", "Fiscalização eletrônica de velocidade.", () => retangulo(AZUL,
    bc("M14 25H50V46H14Z", 3.4) + bc("M24 25 27 19.5H37L40 25", 3.4) + '<circle cx="32" cy="35.5" r="6" fill="none" stroke="#fff" stroke-width="3.4"/>' + circ(44, 30, 1.8, BRANCO)));
  def("balanca", "Balança (posto de pesagem)", "indicacao", "Posto de pesagem: caminhão para na balança quando mandado.", () => retangulo(AZUL,
    bc("M32 15V47M22 47H42M15 22H49", 3.6) + bc("M15 22 10.5 34M15 22 19.5 34M10 34.5Q15 40.5 20 34.5", 3) + bc("M49 22 44.5 34M49 22 53.5 34M44 34.5Q49 40.5 54 34.5", 3)));

  // --- indicação (retângulo azul / verde)
  def("area_escape", "Área de escape", "indicacao", "Rampa de freio para caminhão sem freio, em descida longa.", () => retangulo(VERDE,
    bp("M28 45H51V26Z") + circ(41, 41, 1.4, VERDE) + circ(46, 38.4, 1.4, VERDE) + circ(36, 43, 1.2, VERDE) + bc("M12 45H24M19.5 40 24.5 45 19.5 50", 3.6)));
  def("posto_combustivel", "Posto de combustível", "indicacao", "Posto de abastecimento.", () => retangulo(AZUL,
    bc("M16 48V19a3.5 3.5 0 013.5-3.5H31A3.5 3.5 0 0134.5 19V48M13 48H37.5", 3.6) + bc("M21 23H30V30H21Z", 2.6) + bc("M34.5 24H38.5a3.2 3.2 0 013.2 3.2V38a3.2 3.2 0 006.4 0V26L43.5 20.5", 3.4)));
  def("descanso", "Local de descanso", "indicacao", "Posto de apoio ou pernoite para o motorista.", () => retangulo(AZUL,
    bc("M14 20V46M14 39H50V46M50 39V33a5 5 0 00-5-5H27V39", 3.8) + circ(21, 32.5, 3.8, BRANCO)));
  def("hospital", "Hospital", "indicacao", "Atendimento de saúde por perto.", () => retangulo(AZUL, tr("M23 17V47M41 17V47M23 32H41", 7, BRANCO, "reto")));

  // ------------------------------------------------------------ mapa tipo → placa (vocabulário do app)
  const tipoParaPlaca = {
    // avisos da rota (dados.js)
    restricao: "restricao_caminhao", restricao_possivel: "atencao", perigoso: "acidente", balanca: "balanca", balsa: "balsa", curva: "curva_forte",
    passagem_nivel: "passagem_nivel", lombada: "lombada", lombadas: "redutor_velocidade", radar: "radar", area_escape: "area_escape", perigo: "atencao",
    obra: "obras", praca_pedagio: "pedagio",
    // relatos de motoristas (relatos.js TIPOS)
    altura_maxima: "altura_maxima", limite_peso: "peso_maximo", buraco: "pista_irregular", acidente: "acidente", radar_movel: "radar", animal: "animais_pista",
    fila: "trafego_pesado", objeto: "objeto_pista", veiculo_parado: "veiculo_parado", alagamento: "alagamento", neblina: "neblina",
    pista_escorregadia: "pista_escorregadia", risco_seguranca: "risco_seguranca",
    // via do trajeto (ui/via.js), postos e telas
    subida: "subida_ingreme", descida: "descida_ingreme", terra: "pista_irregular", ruim: "pista_irregular", posto: "posto_combustivel", descanso: "descanso",
  };
  function idDoTipo(tipo) { return (tipo && tipoParaPlaca[tipo]) || "atencao"; }

  // severidade para a lista de avisos: restrição > atenção > informativo
  const SEVERIDADE = {
    restricao: "restricao", altura_maxima: "restricao", limite_peso: "restricao",
    restricao_possivel: "atencao", perigoso: "atencao", curva: "atencao", passagem_nivel: "atencao", balsa: "atencao", perigo: "atencao", obra: "atencao",
    balanca: "atencao", buraco: "atencao", acidente: "atencao", animal: "atencao", fila: "atencao", objeto: "atencao", veiculo_parado: "atencao",
    alagamento: "atencao", neblina: "atencao", pista_escorregadia: "atencao", risco_seguranca: "atencao", subida: "atencao", descida: "atencao", terra: "atencao", ruim: "atencao",
    lombada: "informativo", lombadas: "informativo", radar: "informativo", radar_movel: "informativo", area_escape: "informativo", praca_pedagio: "informativo", posto: "informativo", descanso: "informativo",
  };
  function severidade(tipo) { return SEVERIDADE[tipo] || "informativo"; }
  const ROTULO_SEVERIDADE = { restricao: "Restrição", atencao: "Atenção", informativo: "Informativo" };

  // ------------------------------------------------------------ saída
  function fmt(v) {
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
    if (!isFinite(n)) return "";
    return String(Math.round(n * 10) / 10).replace(".", ",");
  }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
  function rotuloDe(p, valor) {
    const t = valor == null ? "" : fmt(valor);
    return p.nome + (t && p.valor ? ", " + t + (p.valor.unidade === "%" ? "%" : " " + p.valor.unidade) : "");
  }
  // o = { valor, tamanho (px, padrão 48), rotulo (texto do leitor de tela), decorativa (true = aria-hidden), classe }
  function svg(id, o) {
    o = o || {};
    const p = P[id] || P.atencao;
    const tam = o.tamanho || 48;
    const rotulo = o.rotulo || rotuloDe(p, o.valor);
    const a11y = o.decorativa ? 'aria-hidden="true"' : 'role="img" aria-label="' + esc(rotulo) + '"';
    return '<svg class="placa placa-' + p.id + (o.classe ? " " + esc(o.classe) : "") + '" data-placa="' + p.id + '" data-categoria="' + p.categoria + '" width="' + tam + '" height="' + tam + '" viewBox="0 0 64 64" ' + a11y + ' focusable="false">' +
      (o.decorativa ? "" : "<title>" + esc(rotulo) + "</title>") + p.desenho(o.valor == null || o.valor === "" || (p.valor && p.valor.unidade === "%" && tam < 30) ? null : o.valor) + "</svg>"; // rampa: o número some em placa pequena (ilegível); o nome diz o percentual
  }
  function placa(id, o) {
    const s = svg(id, o);
    if (typeof document === "undefined") return s;
    const t = document.createElement("template");
    t.innerHTML = s;
    return t.content.firstChild;
  }
  function catalogo() {
    return Object.keys(P).map((id) => ({ id, nome: P[id].nome, categoria: P[id].categoria, significado: P[id].significado, valor: P[id].valor ? Object.assign({}, P[id].valor) : null }));
  }
  const CATEGORIAS = { advertencia: "Advertência", regulamentacao: "Regulamentação", indicacao: "Indicação" };
  function nome(id) { return P[id] ? P[id].nome : null; }
  function existe(id) { return !!P[id]; }

  const api = { svg, placa, catalogo, tipoParaPlaca, idDoTipo, severidade, ROTULO_SEVERIDADE, CATEGORIAS, nome, existe, rotuloDe, fmt, IDS: Object.keys(P) };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else {
    raiz.CopilotoPlacas = api;
    if (raiz.Copiloto) raiz.Copiloto.placas = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
