// Lugares salvos (lógica pura, sem DOM; testada em tests/lugares.test.js).
// Uma lista com Casa, Base e até 5 favoritos nomeados. Guardada em copiloto.lugares.v1 = { versao: 1, lugares: [...] }.
// Migração do formato antigo (copiloto.base.v1 = { lat, lon, rotulo }, "Casa / base"): vira a Casa, sem apagar a chave antiga
// (a rodada anterior e o botão "Salvar como casa/base" seguem lendo/escrevendo ela). Nada se perde.
(function (raiz) {
  "use strict";

  const CHAVE = "copiloto.lugares.v1", CHAVE_ANTIGA = "copiloto.base.v1";
  const MAX_FAVORITOS = 5, MAX_NOME = 40;
  const TIPOS = {
    casa: { nome: "Casa", icone: "casa", unico: true },
    base: { nome: "Base", icone: "base", unico: true },
    fav: { nome: "Favorito", icone: "estrela", unico: false },
  };

  const valido = (v) => v != null && v !== "" && isFinite(v);
  function limparNome(t) { return String(t == null ? "" : t).replace(/\s+/g, " ").trim().slice(0, MAX_NOME); }
  function semAcento(t) { return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(); }

  function normalizar(l) {
    if (!l || !valido(l.lat) || !valido(l.lon) || !TIPOS[l.tipo]) return null;
    const lat = Number(l.lat), lon = Number(l.lon);
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    const nome = limparNome(l.nome) || TIPOS[l.tipo].nome;
    return { id: String(l.id || l.tipo + "-" + Math.round(lat * 1e5) + "-" + Math.round(lon * 1e5)), tipo: l.tipo, nome, lat, lon,
      rotulo: l.rotulo ? String(l.rotulo) : null };
  }

  // Estado completo a partir do que está guardado: { lugares } novo, e/ou { lat, lon, rotulo } antigo. Devolve a lista válida
  // (no máximo 1 Casa, 1 Base, 5 favoritos). O antigo só entra se a lista nova não tem Casa (não sobrescreve escolha nova).
  function ler(novo, antigo) {
    const lista = [];
    const vistos = { casa: 0, base: 0, fav: 0 };
    for (const x of novo && Array.isArray(novo.lugares) ? novo.lugares : []) {
      const l = normalizar(x); if (!l) continue;
      if (TIPOS[l.tipo].unico && vistos[l.tipo]) continue;
      if (l.tipo === "fav" && vistos.fav >= MAX_FAVORITOS) continue;
      vistos[l.tipo]++; lista.push(l);
    }
    if (!vistos.casa && antigo && valido(antigo.lat) && valido(antigo.lon)) {
      const l = normalizar({ id: "casa-migrada", tipo: "casa", nome: "Casa", lat: antigo.lat, lon: antigo.lon, rotulo: antigo.rotulo || null });
      if (l) lista.unshift(l);
    }
    return lista;
  }
  function paraGuardar(lista) { return { versao: 1, lugares: lista.map((l) => ({ id: l.id, tipo: l.tipo, nome: l.nome, lat: l.lat, lon: l.lon, rotulo: l.rotulo })) }; }

  // Salva um lugar: Casa e Base substituem a que existe; favorito novo entra (nome igual substitui o antigo). Devolve
  // { lista, erro? } — erro: "cheio" (já são 5 favoritos), "invalido".
  function salvar(lista, entrada) {
    const l = normalizar(Object.assign({}, entrada, { id: entrada && entrada.id }));
    if (!l) return { lista: lista.slice(), erro: "invalido" };
    let out = lista.slice();
    if (TIPOS[l.tipo].unico) {
      out = out.filter((x) => x.tipo !== l.tipo);
      out.push(l);
    } else {
      const igual = out.findIndex((x) => x.tipo === "fav" && semAcento(x.nome) === semAcento(l.nome));
      if (igual >= 0) { l.id = out[igual].id; out[igual] = l; }
      else if (out.filter((x) => x.tipo === "fav").length >= MAX_FAVORITOS) return { lista: lista.slice(), erro: "cheio" };
      else { l.id = "fav-" + Date.now().toString(36) + "-" + out.length; out.push(l); }
    }
    return { lista: ordenar(out) };
  }
  function remover(lista, id) { return lista.filter((x) => x.id !== id); }
  function ordenar(lista) {
    const peso = { casa: 0, base: 1, fav: 2 };
    return lista.slice().sort((a, b) => peso[a.tipo] - peso[b.tipo]);
  }

  // Fala/escrita de um lugar: "casa", "minha casa", "base", "a base", "o garagem" (nome do favorito). Devolve o lugar ou null.
  const ARTIGOS = /^(?:(?:para|pra|pro|ate|na|no|a|o|minha|meu|de|da|do)\s+)+/;
  function acharPorFala(lista, texto) {
    const t = semAcento(texto).replace(ARTIGOS, "").replace(/\s+(?:por favor|ai)$/, "").trim();
    if (!t) return null;
    const casa = ["casa", "lar"], base = ["base"];
    const porTipo = (tipo) => lista.find((l) => l.tipo === tipo) || null;
    // o nome de um favorito vale antes do apelido de Casa/Base ("empresa" pode ser um favorito)
    const fav = lista.find((l) => l.tipo === "fav" && semAcento(l.nome) === t);
    if (fav) return fav;
    if (casa.includes(t)) return porTipo("casa");
    if (base.includes(t)) return porTipo("base");
    const nomeado = lista.find((l) => semAcento(l.nome) === t);
    if (nomeado) return nomeado;
    return null;
  }
  // A fala é pedido de lugar salvo (mesmo sem o lugar existir)? "casa", "minha casa", "base"… → tipo; senão null.
  function tipoFalado(texto) {
    const t = semAcento(texto).replace(ARTIGOS, "").trim();
    if (t === "casa" || t === "lar") return "casa";
    if (t === "base") return "base";
    return null;
  }

  const api = { CHAVE, CHAVE_ANTIGA, MAX_FAVORITOS, MAX_NOME, TIPOS, limparNome, semAcento, normalizar, ler, paraGuardar, salvar, remover, ordenar, acharPorFala, tipoFalado };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.CopilotoLugares = api;
})(typeof window !== "undefined" ? window : globalThis);
