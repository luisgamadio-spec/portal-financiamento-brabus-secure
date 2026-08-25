// Fonte: mitweek.xlsx (aba rebates), campanha MITWEEK, valida ate 31/08/2026.
// Atualizado em 2026-08-25 (MITWEEK-1.2) a partir da planilha revisada pelo usuario.
window.MITWEEK_DATA = {
  "_source_file": "mitweek.xlsx (sheet: rebates)",
  "_campaign": "MITWEEK",
  "_valid_until": "2026-08-31",
  "_source_updated_note": "Planilha atualizada pelo usuario em 2026-08-25 (MITWEEK-1.2) -- schema mudou: Trade-in agora na coluna H (era N), sem prazo 60x, taxas uniformes por modelo (0,89% em todos os prazos oferecidos), 2 modelos removidos (OUTLANDER HPE-S e OUTLANDER SIGNATURE).",
  "_note_tradein_column": "Coluna H (header Trade-in) na planilha atualizada -- confirmado estruturalmente, NAO reaproveitada posicao antiga (coluna N).",
  "_note_missing_coef": "Taxa 0,89% nao possui coeficiente cadastrado na tabela TX_COEF compartilhada para o prazo de 12 meses (TX_COEF[12] so tem 0%/0,19%/0,49%) -- por isso TODOS os 14 modelos mostram 'indisponivel' em 12 meses. Nao inventado/aproximado. Prazo de 60 meses nao existe mais na planilha atualizada -- exibido como indisponivel (mesmo padrao fail-closed), nao removido do layout.",
  "models": [
    {
      "name": "TRITON GLS AT",
      "entry": 0.6,
      "rebate": 0.1000040001600064,
      "hpe": 0.5,
      "brabus": 0.5,
      "tradein": 0,
      "rates": {
        "12": 0.0089,
        "18": 0.0089,
        "24": 0.0089,
        "36": 0.0089,
        "48": 0.0089
      }
    },
    {
      "name": "TRITON TARMAC",
      "entry": 0.6,
      "rebate": 0.12000480019200768,
      "hpe": 0.5,
      "brabus": 0.5,
      "tradein": 0,
      "rates": {
        "12": 0.0089,
        "18": 0.0089,
        "24": 0.0089,
        "36": 0.0089,
        "48": 0.0089
      }
    },
    {
      "name": "TRITON HPE",
      "entry": 0.6,
      "rebate": 0.20834088191601144,
      "hpe": 0.6521739130434783,
      "brabus": 0.34782608695652173,
      "tradein": 10000,
      "rates": {
        "12": 0.0089,
        "18": 0.0089,
        "24": 0.0089,
        "36": 0.0089,
        "48": 0.0089
      }
    },
    {
      "name": "TRITON HPE-S",
      "entry": 0.6,
      "rebate": 0.20834027800926697,
      "hpe": 0.68,
      "brabus": 0.32,
      "tradein": 11000,
      "rates": {
        "12": 0.0089,
        "18": 0.0089,
        "24": 0.0089,
        "36": 0.0089,
        "48": 0.0089
      }
    },
    {
      "name": "TRITON KATANA",
      "entry": 0.6,
      "rebate": 0.2230837871934521,
      "hpe": 0.5862068965517241,
      "brabus": 0.41379310344827586,
      "tradein": 14000,
      "rates": {
        "12": 0.0089,
        "18": 0.0089,
        "24": 0.0089,
        "36": 0.0089,
        "48": 0.0089
      }
    },
    {
      "name": "TRITON SAVANA",
      "entry": 0.6,
      "rebate": 0.2164243708767426,
      "hpe": 0.5862068965517241,
      "brabus": 0.41379310344827586,
      "tradein": 14000,
      "rates": {
        "12": 0.0089,
        "18": 0.0089,
        "24": 0.0089,
        "36": 0.0089,
        "48": 0.0089
      }
    },
    {
      "name": "TRITON SERTOES",
      "entry": 0.6,
      "rebate": 0.21324156592840965,
      "hpe": 0.5862068965517241,
      "brabus": 0.41379310344827586,
      "tradein": 14000,
      "rates": {
        "12": 0.0089,
        "18": 0.0089,
        "24": 0.0089,
        "36": 0.0089,
        "48": 0.0089
      }
    },
    {
      "name": "TRITON TERRA",
      "entry": 0.6,
      "rebate": 0.21015101887011217,
      "hpe": 0.5862068965517241,
      "brabus": 0.41379310344827586,
      "tradein": 14000,
      "rates": {
        "12": 0.0089,
        "18": 0.0089,
        "24": 0.0089,
        "36": 0.0089,
        "48": 0.0089
      }
    },
    {
      "name": "ECLIPSE CROSS RUSH",
      "entry": 0.6,
      "rebate": 0.0801333418808898,
      "hpe": 0.3,
      "brabus": 0.7,
      "tradein": 0,
      "rates": {
        "12": 0.0089,
        "18": 0.0089,
        "24": 0.0089,
        "36": 0.0089,
        "48": 0.0089
      }
    },
    {
      "name": "ECLIPSE CROSS HPE",
      "entry": 0.6,
      "rebate": 0.15278626590366132,
      "hpe": 0.6363636363636364,
      "brabus": 0.36363636363636365,
      "tradein": 3000,
      "rates": {
        "12": 0.0089,
        "18": 0.0089,
        "24": 0.0089,
        "36": 0.0089,
        "48": 0.0089
      }
    },
    {
      "name": "ECLIPSE CROSS TARMAC",
      "entry": 0.6,
      "rebate": 0.14865668414508892,
      "hpe": 0.6363636363636364,
      "brabus": 0.36363636363636365,
      "tradein": 3000,
      "rates": {
        "12": 0.0089,
        "18": 0.0089,
        "24": 0.0089,
        "36": 0.0089,
        "48": 0.0089
      }
    },
    {
      "name": "ECLIPSE CROSS HPE-S",
      "entry": 0.6,
      "rebate": 0.13095861707700368,
      "hpe": 0.6363636363636364,
      "brabus": 0.36363636363636365,
      "tradein": 0,
      "rates": {
        "12": 0.0089,
        "18": 0.0089,
        "24": 0.0089,
        "36": 0.0089,
        "48": 0.0089
      }
    },
    {
      "name": "ECLIPSE CROSS HPE-S S-AWC",
      "entry": 0.6,
      "rebate": 0.17046229374062458,
      "hpe": 0.6333333333333333,
      "brabus": 0.36666666666666664,
      "tradein": 5000,
      "rates": {
        "12": 0.0089,
        "18": 0.0089,
        "24": 0.0089,
        "36": 0.0089,
        "48": 0.0089
      }
    },
    {
      "name": "ECLIPSE CROSS HPE-S S-AWC BLACK",
      "entry": 0.6,
      "rebate": 0.1666740744033068,
      "hpe": 0.6333333333333333,
      "brabus": 0.36666666666666664,
      "tradein": 5000,
      "rates": {
        "12": 0.0089,
        "18": 0.0089,
        "24": 0.0089,
        "36": 0.0089,
        "48": 0.0089
      }
    }
  ]
};
