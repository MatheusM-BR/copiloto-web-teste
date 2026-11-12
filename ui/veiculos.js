// Veículos: cadastro local (copiloto.perfis.v1), veículo ativo e chip no mapa.
// Expõe Copiloto.veiculos.ativo() / lista(). Emite "veiculo" (perfil ativo ou null) quando muda ou é editado.
// Tanque (L) e consumo (km/L) — pacote E2 (autonomia): campos criados aqui, sem mexer no index.html.
(function (C) {
  "use strict";
  const { $, botao, novoId, lerJSON, gravarJSON } = C.util;
  const V = window.CopilotoValidacao;
  const CHAVE = "copiloto.perfis.v1";
  let estado = { perfis: [], ativoId: null };
  let editandoId = null;

  function carregar() {
    const o = lerJSON(CHAVE, null);
    if (o && Array.isArray(o.perfis)) estado = { perfis: o.perfis, ativoId: o.ativoId || null };
  }
  function gravar() { gravarJSON(CHAVE, estado); }
  function ativo() { return estado.perfis.find((p) => p.id === estado.ativoId) || null; }

  function fmt(v, un) { return v == null ? null : String(v).replace(".", ",") + (un ? " " + un : ""); }
  function dado(rotulo, v, un) {
    const s = document.createElement("span");
    const t = fmt(v, un);
    if (t == null) { s.className = "nao-informado"; s.textContent = rotulo + ": não informado"; }
    else s.textContent = rotulo + ": " + t;
    return s;
  }

  function desenharLista() {
    const ul = $("lista-perfis"); ul.textContent = "";
    if (!estado.perfis.length) {
      const li = document.createElement("li"); li.className = "dica";
      li.textContent = "Nenhum veículo cadastrado ainda. Cadastre o primeiro abaixo.";
      ul.appendChild(li);
    }
    for (const p of estado.perfis) {
      const li = document.createElement("li"); li.className = "perfil" + (p.id === estado.ativoId ? " ativo" : "");
      const h = document.createElement("h3"); h.textContent = p.nome + " · " + p.tipo;
      if (p.id === estado.ativoId) { const s = document.createElement("span"); s.className = "selo"; s.textContent = "ATIVO"; h.appendChild(s); }
      const d = document.createElement("div"); d.className = "dados";
      d.append(dado("Altura", p.altura, "m"), dado("Largura", p.largura, "m"), dado("Comprimento", p.comprimento, "m"),
               dado("PBTC", p.pbtc, "t"), dado("Peso vazio", p.tara, "t"), dado("Eixos", p.eixos, ""),
               dado("Tanque", p.tanque, "L"), dado("Consumo", p.consumo, "km/L"));
      const c = document.createElement("span"); c.className = "dado-carga"; c.textContent = "Carga: " + p.carga; d.appendChild(c);
      if (p.cargaPerigosa === true) { const g = document.createElement("span"); g.className = "dado-perigosa"; g.textContent = "Carga perigosa: sim"; d.appendChild(g); }
      const b = document.createElement("div"); b.className = "linha-botoes";
      if (p.id !== estado.ativoId) b.appendChild(botao("Usar este", "btn btn-pequeno btn-principal", () => { estado.ativoId = p.id; gravar(); atualizarTudo(); }));
      b.appendChild(botao("Editar", "btn btn-pequeno", () => editar(p.id)));
      b.appendChild(botao("Excluir", "btn btn-pequeno btn-perigo", () => excluir(p.id)));
      li.append(h, d, b); ul.appendChild(li);
    }
  }

  function excluir(id) {
    estado.perfis = estado.perfis.filter((p) => p.id !== id);
    if (estado.ativoId === id) estado.ativoId = estado.perfis.length ? estado.perfis[0].id : null;
    if (editandoId === id) limparForm();
    gravar(); atualizarTudo();
  }

  const CAMPOS_NUM = ["altura", "largura", "comprimento", "pbtc", "eixos", "tara", "tanque", "consumo"];
  function lerForm() {
    const o = { nome: $("f-nome").value, tipo: $("f-tipo").value, carga: $("f-carga").value, cargaPerigosa: $("f-perigosa").checked };
    for (const c of CAMPOS_NUM) o[c] = $("f-" + c).value;
    return o;
  }
  function mostrarErros(erros) {
    for (const c of ["nome", "tipo"].concat(CAMPOS_NUM)) {
      const e = $("e-" + c); if (e) e.textContent = erros[c] || "";
      const i = $("f-" + c); if (i) i.setAttribute("aria-invalid", erros[c] ? "true" : "false");
    }
  }
  function limparForm() {
    editandoId = null; $("form-perfil").reset(); $("f-tipo").value = "Carreta"; mostrarErros({}); marcarCarga();
    $("titulo-form").textContent = "Novo veículo"; $("btn-cancelar").hidden = true; $("btn-salvar").textContent = "Salvar veículo";
  }
  function editar(id) {
    const p = estado.perfis.find((x) => x.id === id); if (!p) return;
    editandoId = id; mostrarErros({});
    $("f-nome").value = p.nome; $("f-tipo").value = p.tipo; $("f-carga").value = p.carga; $("f-perigosa").checked = p.cargaPerigosa === true; marcarCarga();
    for (const c of CAMPOS_NUM) $("f-" + c).value = p[c] == null ? "" : String(p[c]).replace(".", ",");
    $("titulo-form").textContent = "Editar veículo"; $("btn-cancelar").hidden = false; $("btn-salvar").textContent = "Salvar alterações";
    $("f-nome").focus();
  }

  function aoSalvar(ev) {
    ev.preventDefault();
    const r = V.validarPerfil(lerForm());
    mostrarErros(r.erros);
    if (!r.ok) { const primeiro = Object.keys(r.erros)[0]; const el = $("f-" + primeiro); if (el) el.focus(); return; }
    if (editandoId) {
      const i = estado.perfis.findIndex((p) => p.id === editandoId);
      if (i >= 0) estado.perfis[i] = Object.assign({ id: editandoId }, r.perfil);
    } else {
      const novo = Object.assign({ id: novoId() }, r.perfil);
      estado.perfis.push(novo);
      if (!estado.ativoId) estado.ativoId = novo.id; // o primeiro vira o ativo
    }
    gravar(); limparForm(); atualizarTudo();
  }

  // Carregado / Vazio em destaque (botões grandes); o <select id="f-carga"> continua sendo a fonte do valor. Tocar no marcado volta a "Não informado".
  function marcarCarga() {
    const v = $("f-carga").value;
    for (const b of document.querySelectorAll(".v-carga-op")) b.setAttribute("aria-checked", String(b.dataset.carga === v));
  }
  function ligarCarga() {
    for (const b of document.querySelectorAll(".v-carga-op")) b.addEventListener("click", () => {
      $("f-carga").value = $("f-carga").value === b.dataset.carga ? "Não informado" : b.dataset.carga; marcarCarga();
    });
  }

  function atualizarTudo() {
    desenharLista();
    const a = ativo();
    $("chip-veiculo").textContent = a ? a.nome + " · " + a.tipo : "Nenhum veículo ativo";
    C.emit("veiculo", a);
  }

  // Campos de autonomia (E2) na mesma grade das medidas.
  function criarCamposAutonomia() {
    if ($("f-tanque")) return;
    const grade = $("grade-combustivel") || $("f-eixos").closest(".grade");
    const campo = (id, rotulo, modo, exemplo, ajuda) => {
      const l = document.createElement("label"); l.htmlFor = "f-" + id; l.append(rotulo);
      const i = document.createElement("input"); i.id = "f-" + id; i.inputMode = modo; i.autocomplete = "off"; i.placeholder = exemplo; i.setAttribute("aria-describedby", "d-" + id);
      const d = document.createElement("span"); d.className = "campo-dica"; d.id = "d-" + id; d.textContent = ajuda;
      const e = document.createElement("span"); e.className = "erro"; e.id = "e-" + id;
      l.append(i, d, e); return l;
    };
    grade.append(campo("tanque", "Tanque (L)", "decimal", "600", "Capacidade do tanque de diesel. Entra no alcance estimado."),
      campo("consumo", "Consumo (km/L)", "decimal", "2,5", "Média real do conjunto. Entra no alcance estimado."));
  }

  // Pacote F (item 18): formulário mais curto. "Carregado/Vazio" sobe para o topo (logo abaixo do título, antes do nome); a explicação de
  // cada campo vai para um "?" (e para o title do campo) em vez de ocupar 2 linhas por campo; o texto de rodapé encolhe; "Salvar" fica
  // fixo no pé da tela (estilos/veiculos.css). Os ids, a validação e a gravação continuam os mesmos.
  const AJUDA_CURTA = {
    "d-carga": "Carregado usa o PBTC; Vazio, o peso vazio. Tocar de novo limpa.",
    "d-perigosa": "Só fica no perfil; ainda não muda a rota nem os túneis.",
  };
  function condensarForm() {
    const form = $("form-perfil"); if (!form || form.dataset.condensado) return;
    form.dataset.condensado = "1";
    const grupo = $("v-carga-grupo"), titulo = $("titulo-form");
    if (grupo && titulo) titulo.after(grupo);
    for (const [id, txt] of Object.entries(AJUDA_CURTA)) { const e = $(id); if (e) e.textContent = txt; }
    for (const dica of form.querySelectorAll("label .campo-dica")) {
      const rotulo = dica.closest("label");
      if (!rotulo || rotulo.classList.contains("v-perigosa")) continue;
      const campo = rotulo.querySelector("input, select");
      const no = Array.from(rotulo.childNodes).find((n) => n.nodeType === 3 && n.textContent.trim());
      if (!campo || !no) continue;
      const nome = no.textContent.trim();
      const linha = document.createElement("span"); linha.className = "v-rot-linha";
      const txt = document.createElement("span"); txt.className = "v-rot"; txt.textContent = nome;
      const b = document.createElement("button"); b.type = "button"; b.className = "v-ajuda"; b.textContent = "?";
      b.setAttribute("aria-label", "O que é " + nome.replace(/\s*\(.*$/, "")); b.setAttribute("aria-expanded", "false"); b.setAttribute("aria-controls", dica.id);
      b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); dica.hidden = !dica.hidden; b.setAttribute("aria-expanded", String(!dica.hidden)); });
      linha.append(txt, b);
      rotulo.insertBefore(linha, no); no.remove();
      campo.title = dica.textContent.trim();
      dica.hidden = true;
    }
    const nota = Array.from(form.querySelectorAll("p.dica")).find((p) => /Deixe em branco/.test(p.textContent));
    if (nota) nota.textContent = "Em branco = não informado. O Copiloto não inventa medida.";
  }

  C.veiculos = { ativo, lista: () => estado.perfis.slice() };

  C.aoIniciar(() => {
    carregar();
    criarCamposAutonomia();
    condensarForm();
    for (const t of V.TIPOS) $("f-tipo").add(new Option(t, t));
    for (const c of V.CARGAS) $("f-carga").add(new Option(c, c));
    $("f-tipo").value = "Carreta"; ligarCarga(); marcarCarga();
    $("form-perfil").addEventListener("submit", aoSalvar);
    $("btn-cancelar").addEventListener("click", limparForm);
    C.abas.registrar({ id: "veiculo", rotulo: "Veículo", tela: $("tela-veiculo") });
    atualizarTudo();
  });
})(window.Copiloto);
