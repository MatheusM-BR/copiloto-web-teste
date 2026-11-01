// Configuração da nuvem (Supabase). Valores do contrato docs/API_RELATOS.md.
// A chave é a publicável (pode ir no app). Os testes sobrescrevem com
// window.COPILOTO_SUPABASE_URL / window.COPILOTO_SUPABASE_KEY antes de carregar este arquivo.
(function (raiz) {
  "use strict";
  const URL_PADRAO = "https://wircixwonazhqmprwtqv.supabase.co";
  const CHAVE_PADRAO = "sb_publishable_-Dvo4Oe6xL173G7E8eH4SA_cBhvSZpu";
  // Fachada na chegada (ui/fachada.js): token de cliente do Mapillary (https://www.mapillary.com/dashboard/developers).
  // Vazio = sem foto de rua (só o mapa 3D) e nada vai ao Mapillary. Os testes usam window.COPILOTO_MAPILLARY_TOKEN.
  const MAPILLARY_TOKEN = "";
  const cfg = {
    url: String((raiz && raiz.COPILOTO_SUPABASE_URL) || URL_PADRAO).replace(/\/+$/, ""),
    chave: (raiz && raiz.COPILOTO_SUPABASE_KEY) || CHAVE_PADRAO,
    URL_PADRAO, CHAVE_PADRAO,
    MAPILLARY_TOKEN: String((raiz && raiz.COPILOTO_MAPILLARY_TOKEN) || MAPILLARY_TOKEN),
  };
  if (typeof module !== "undefined" && module.exports) module.exports = cfg;
  else raiz.CopilotoConfig = cfg;
})(typeof window !== "undefined" ? window : globalThis);
