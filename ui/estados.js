// Lote 4 (Stitch P6.6 / P6.10): cartão de estado para offline, erro, limite e permissão negada, em texto curto.
// Um título, uma frase (o que acontece e o que continua funcionando) e, se houver, uma ação. Sem dado inventado:
// o que o app não sabe não aparece. Expõe Copiloto.estados: montar({ tipo, icone, titulo, texto, acao: { rotulo, id, aoTocar } }) → elemento.
// tipo: "atencao" (âmbar: sem internet, sem sinal), "perigo" (vermelho: bloqueado/negado) ou "info" (azul).
(function (C) {
  "use strict";
  const { el, botao } = C.util;
  function montar(o) {
    const op = o || {};
    const c = el("section", "estado-cartao estado-" + (op.tipo || "info"));
    if (op.id) c.id = op.id;
    const ic = el("span", "estado-ico"); ic.setAttribute("aria-hidden", "true");
    const I = window.CopilotoIcones; if (I && op.icone) ic.append(I.no(op.icone));
    const tx = el("div", "estado-txt");
    tx.append(el("h2", null, op.titulo || ""));
    if (op.texto) tx.append(el("p", null, op.texto));
    c.append(ic, tx);
    if (op.acao) { const b = botao(op.acao.rotulo, "btn estado-acao", op.acao.aoTocar); if (op.acao.id) b.id = op.acao.id; c.append(b); }
    return c;
  }
  C.estados = { montar };
  C.aoIniciar(() => { C.carregarEstilo("estilos/estados.css"); });
})(window.Copiloto);
