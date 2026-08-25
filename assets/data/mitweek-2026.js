// Fonte: mitweek.xlsx (aba rebates), campanha MITWEEK, valida ate 31/08/2026.
// Gerado a partir da planilha fornecida -- ver comentarios internos para ressalvas de dados.
window.MITWEEK_DATA = {
  "_source_file": "mitweek.xlsx (sheet: rebates)",
  "_campaign": "MITWEEK",
  "_valid_until": "2026-08-31",
  "_note_tradein_column": "Coluna N (header Trade-in), NAO coluna Q (header Rebate Parte HPE) -- confirmado estruturalmente antes da implementacao.",
  "_note_missing_coef": "TRITON TARMAC 18x (0.29%), ECLIPSE CROSS RUSH 12x (0.39%) e 18x (0.79%) nao possuem coeficiente correspondente na tabela TX_COEF compartilhada do Coparticipado -- essas 3 combinacoes mostram 'indisponivel' no simulador. Nao inventado/interpolado. Ver RELATORIO FINAL MITWEEK-1.",
  "_note_tradein_null": "OUTLANDER HPE-S e OUTLANDER SIGNATURE nao possuem valor de Trade-in na planilha (null, nao zero) -- tratado como Nao disponivel para esta condicao.",
  "models": [
    {
      "name": "TRITON GLS AT",
      "entry": 0.6,
      "rebate": 0.1000040001600064,
      "hpe": 0.5,
      "brabus": 0.5,
      "tradein": 0,
      "rates": {
        "12": 0.0019,
        "18": 0.0059,
        "24": 0.0069,
        "36": 0.0099,
        "48": 0.0099,
        "60": 0.0109
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
        "12": 0,
        "18": 0.0029,
        "24": 0.0049,
        "36": 0.0089,
        "48": 0.0089,
        "60": 0.0099
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
        "12": 0,
        "18": 0,
        "24": 0,
        "36": 0.0029,
        "48": 0.0049,
        "60": 0.0059
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
        "12": 0,
        "18": 0,
        "24": 0,
        "36": 0.0029,
        "48": 0.0049,
        "60": 0.0059
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
        "12": 0,
        "18": 0,
        "24": 0,
        "36": 0.0019,
        "48": 0.0039,
        "60": 0.0059
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
        "12": 0,
        "18": 0,
        "24": 0,
        "36": 0.0019,
        "48": 0.0039,
        "60": 0.0059
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
        "12": 0,
        "18": 0,
        "24": 0,
        "36": 0.0019,
        "48": 0.0039,
        "60": 0.0059
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
        "12": 0,
        "18": 0,
        "24": 0,
        "36": 0.0029,
        "48": 0.0039,
        "60": 0.0059
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
        "12": 0.0039,
        "18": 0.0079,
        "24": 0.0089,
        "36": 0.0109,
        "48": 0.0109,
        "60": 0.0119
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
        "12": 0,
        "18": 0,
        "24": 0.0019,
        "36": 0.0059,
        "48": 0.0069,
        "60": 0.0089
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
        "12": 0,
        "18": 0,
        "24": 0.0019,
        "36": 0.0069,
        "48": 0.0079,
        "60": 0.0089
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
        "12": 0,
        "18": 0.0019,
        "24": 0.0039,
        "36": 0.0079,
        "48": 0.0089,
        "60": 0.0099
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
        "12": 0,
        "18": 0,
        "24": 0,
        "36": 0.0049,
        "48": 0.0069,
        "60": 0.0079
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
        "12": 0,
        "18": 0,
        "24": 0.0019,
        "36": 0.0059,
        "48": 0.0069,
        "60": 0.0079
      }
    },
    {
      "name": "OUTLANDER HPE-S",
      "entry": 0.6,
      "rebate": 0.19231360964952768,
      "hpe": 0.52,
      "brabus": 0.48,
      "tradein": null,
      "rates": {
        "12": 0,
        "18": 0,
        "24": 0,
        "36": 0.0039,
        "48": 0.0049,
        "60": 0.0069
      }
    },
    {
      "name": "OUTLANDER SIGNATURE",
      "entry": 0.6,
      "rebate": 0.17123756815255212,
      "hpe": 0.52,
      "brabus": 0.48,
      "tradein": null,
      "rates": {
        "12": 0,
        "18": 0,
        "24": 0,
        "36": 0.0049,
        "48": 0.0059,
        "60": 0.0079
      }
    }
  ]
};
