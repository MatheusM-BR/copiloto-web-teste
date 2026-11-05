// Lugares salvos (lógica em lugares.js): Casa, Base e até 5 favoritos nomeados, com ícones. Aparecem na tela de busca (atalhos de
// 64 px), saem do toque no mapa ("Salvar lugar") e atendem a voz ("ir para casa", "me leva para a base", "ir para <favorito>").
// Guardados em copiloto.lugares.v1; o formato antigo (copiloto.base.v1 = Casa/base) é lido como Casa e a chave antiga continua
// escrita quando a Casa muda (nada se perde, e o botão "Salvar como casa/base" segue funcionando).
// Expõe Copiloto.lugares: lista(), salvar(entrada), remover(id), irPara(lugar|"casa"|"base"), irCasaOuBase(), porVoz(r) (true se
// tratou o pedido), escolherParaSalvar(ponto, nome?), gerenciar(). Emite "lugares" (lista) quando muda.
(function (C) {
  "use strict";
  const { $, el, botao, lerJSON, gravarJSON } = C.util;
  const L = window.CopilotoLugares;
  const IC = window.CopilotoIcones;
  let lista = [];

  const ic = (nome) => (IC ? IC.no(nome) : document.createTextNode(""));

  function carregar() {
    const novo = lerJSON(L.CHAVE, null), antigo = lerJSON(L.CHAVE_ANTIGA, null);
    lista = L.ordenar(L.ler(novo, antigo));
    // primeira leitura com o formato antigo: grava o novo (a chave antiga fica como está)
    if (lista.length && !(novo && Array.isArray(novo.lugares) && novo.lugares.length)) gravarJSON(L.CHAVE, L.paraGuardar(lista));
  }
  function guardar(nova) {
    lista = nova;
    gravarJSON(L.CHAVE, L.paraGuardar(lista));
    const casa = lista.find((x) => x.tipo === "casa");
    if (casa) gravarJSON(L.CHAVE_ANTIGA, { lat: casa.lat, lon: casa.lon, rotulo: casa.rotulo || casa.nome });
    else { try { localStorage.removeItem(L.CHAVE_ANTIGA); } catch (e) { /* sem armazenamento */ } } // senão a migração traria a Casa de volta
    C.emit("lugares", lista.slice());
    desenharBusca();
  }
  function salvar(entrada) {
    const r = L.salvar(lista, entrada);
    if (r.erro) return r;
    guardar(r.lista);
    return { lista: lista.slice() };
  }
  function remover(id) { guardar(L.remover(lista, id)); }

  // ------------------------------------------------------------ ir
  function irPara(x) {
    const l = typeof x === "string" ? lista.find((y) => y.tipo === x) : x;
    if (!l || !C.busca || !C.busca.irPara) return false;
    C.busca.irPara({ lat: l.lat, lon: l.lon, rotulo: l.rotulo || l.nome });
    return true;
  }
  function irCasaOuBase() {
    const l = lista.find((x) => x.tipo === "casa") || lista.find((x) => x.tipo === "base");
    if (l) return irPara(l);
    if (lista.length) { gerenciar(); return true; }
    C.abas.irPara("mapa");
    C.folha.abrir([el("h2", null, "Lugares"), el("p", null, "Toque no mapa no lugar da casa, da base ou de um favorito e escolha \"Salvar lugar\"."),
      botao("Entendi", "btn btn-grande", C.folha.fechar)]);
    return true;
  }

  // ------------------------------------------------------------ voz
  // r: { lugar } do "ir_para". Devolve true quando tratou (era um lugar salvo ou "casa"/"base" sem estar salvo).
  function porVoz(r) {
    if (!r || !r.lugar) return false;
    const l = L.acharPorFala(lista, r.lugar);
    if (l) {
      C.mensagem("Indo para " + l.nome.toLowerCase() + ".", 4000);
      irPara(l);
      return true;
    }
    const tipo = L.tipoFalado(r.lugar);
    if (tipo) {
      const nome = L.TIPOS[tipo].nome.toLowerCase();
      const fala = tipo === "casa" ? "Você ainda não salvou a casa." : "Você ainda não salvou a base.";
      C.abas.irPara("mapa");
      C.folha.abrir([el("h2", null, "Falta salvar a " + nome), el("p", null, "Toque no mapa no lugar da " + nome + " e escolha \"Salvar lugar\"."), botao("Entendi", "btn btn-grande", C.folha.fechar)]);
      try { if (C.voz && C.voz.falar && !(C.voz.emAlerta && C.voz.emAlerta())) C.voz.falar(fala, { naoInterromper: true }); } catch (e) { /* a voz nunca derruba */ }
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ salvar (a partir do toque no mapa)
  // ponto: { lat, lon }; nome: o endereço/nome já conhecido do ponto (vira o rótulo)
  function escolherParaSalvar(ponto, nome) {
    const rotulo = nome || null;
    const caixa = el("div", "lugares-escolha"); caixa.id = "lugares-escolha";
    const salvarTipo = (tipo, nomeLugar) => {
      const r = salvar({ tipo, nome: nomeLugar, lat: ponto.lat, lon: ponto.lon, rotulo });
      if (r.erro === "cheio") { C.mensagem("Você já tem " + L.MAX_FAVORITOS + " favoritos. Apague um para salvar outro.", 6000); gerenciar(); return; }
      if (r.erro) { C.mensagem("Não deu para salvar este lugar.", 5000); return; }
      C.mensagem((tipo === "fav" ? "Favorito" : L.TIPOS[tipo].nome) + " salvo.", 4000);
      C.folha.fechar();
    };
    for (const tipo of ["casa", "base"]) {
      const existe = lista.find((x) => x.tipo === tipo);
      const b = botao("", "btn btn-grande", () => salvarTipo(tipo));
      b.id = "lugares-salvar-" + tipo;
      b.append(ic(L.TIPOS[tipo].icone), el("span", null, "Salvar como " + L.TIPOS[tipo].nome.toLowerCase() + (existe ? " (troca a atual)" : "")));
      caixa.appendChild(b);
    }
    const campo = document.createElement("input"); campo.id = "lugares-nome"; campo.className = "lugares-nome"; campo.type = "text";
    campo.maxLength = L.MAX_NOME; campo.placeholder = "Nome do favorito (ex.: Frigorífico)"; campo.autocomplete = "off";
    campo.setAttribute("aria-label", "Nome do favorito");
    const fav = botao("", "btn btn-grande", () => {
      const n = L.limparNome(campo.value);
      if (!n) { C.mensagem("Dê um nome ao favorito.", 4000); campo.focus(); return; }
      salvarTipo("fav", n);
    });
    fav.id = "lugares-salvar-fav";
    fav.append(ic("estrela"), el("span", null, "Salvar como favorito"));
    caixa.append(campo, fav);
    C.folha.abrir([el("h2", null, "Salvar lugar"), rotulo ? el("p", null, rotulo) : el("p", null, ponto.lat.toFixed(5).replace(".", ",") + ", " + ponto.lon.toFixed(5).replace(".", ",")), caixa,
      botao("Cancelar", "btn btn-grande", C.folha.fechar)]);
  }

  // ------------------------------------------------------------ lista para apagar
  function gerenciar() {
    const ul = el("ul", "lugares-lista"); ul.id = "lugares-lista";
    if (!lista.length) ul.appendChild(el("li", "dica", "Nenhum lugar salvo ainda."));
    for (const l of lista) {
      const li = el("li", "lugares-item");
      const ir = botao("", "btn", () => { C.folha.fechar(); irPara(l); });
      ir.append(ic(L.TIPOS[l.tipo].icone), el("span", "busca-lugar-nome", l.nome));
      const x = botao("", "btn btn-perigo btn-x", () => { remover(l.id); gerenciar(); });
      x.setAttribute("aria-label", "Apagar " + l.nome); x.append(ic("fechar"));
      li.append(ir, x); ul.appendChild(li);
    }
    C.abas.irPara("mapa");
    C.folha.abrir([el("h2", null, "Lugares"), ul, botao("Fechar", "btn btn-grande", C.folha.fechar)]);
  }

  // ------------------------------------------------------------ tela de busca
  function desenharBusca() {
    const ul = $("busca-lugares"); if (!ul) return;
    ul.textContent = "";
    for (const l of lista) {
      const li = el("li");
      const b = el("button", "busca-lugar busca-lugar-" + l.tipo); b.type = "button"; b.dataset.id = l.id;
      b.append(ic(L.TIPOS[l.tipo].icone), el("span", "busca-lugar-nome", l.nome));
      b.setAttribute("aria-label", "Ir para " + l.nome);
      b.addEventListener("click", () => irPara(l));
      li.appendChild(b); ul.appendChild(li);
    }
    if (lista.length) {
      const li = el("li"); const b = el("button", "busca-lugar busca-lugar-gerir"); b.type = "button"; b.id = "busca-lugares-gerir";
      b.append(ic("ajuda"), el("span", "busca-lugar-nome", "Editar"));
      b.setAttribute("aria-label", "Editar lugares salvos");
      b.addEventListener("click", gerenciar);
      li.appendChild(b); ul.appendChild(li);
    }
  }

  C.lugares = { lista: () => lista.slice(), salvar, remover, irPara, irCasaOuBase, porVoz, escolherParaSalvar, gerenciar };

  C.aoIniciar(() => {
    carregar();
    const alvo = $("busca-resultados");
    if (alvo && !$("busca-lugares")) {
      const ul = el("ul", "busca-lugares"); ul.id = "busca-lugares"; ul.setAttribute("aria-label", "Lugares salvos");
      alvo.parentNode.insertBefore(ul, alvo);
    }
    desenharBusca();
    C.emit("lugares", lista.slice());
  });
})(window.Copiloto);
