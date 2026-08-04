// Configuração versionada da publicação.
// A ativação de "secure" deve ocorrer somente na janela coordenada com o banco.
// O arquivo portal-runtime-config.local.js, ignorado pelo Git, substitui esta
// configuração durante testes locais.
window.PORTAL_RUNTIME_CONFIG = {
  supabaseUrl: "https://yacqlelpzchcotgngwbh.supabase.co",
  supabasePublishableKey: "sb_publishable__J96gDH1kOqlc4iFW24Z2Q_u_lWAg5_",
  authMode: "secure",
  passwordRecoveryMode: "admin",
  turnstileSiteKey: "0x4AAAAAAEFmBWKvC-l1_CEs"
};
