# Baseline — snapshot de leitura do backend LIVE (Fase IA-1)

Este diretório **não é uma migration** e **não é aplicado automaticamente** por
`supabase db push` nem por qualquer pipeline de deploy — não está em
`supabase/migrations/`. É um snapshot de leitura, capturado via Management API
(consultas `SELECT` / `pg_get_functiondef()` / `information_schema` apenas),
do estado real hoje em produção.

## Por que existe

A Fase IA-1 (recuperação e certificação do backend para a futura IA) encontrou
**74 das 135 funções do schema `public`** sem nenhum `CREATE FUNCTION`/`CREATE
OR REPLACE FUNCTION` correspondente em `supabase/migrations/` — aplicadas
diretamente em produção ao longo do histórico do projeto, nunca versionadas
(o mesmo padrão que o `supabase/README.md` já documentava para a Fase 4).

Este diretório fecha esse gap **apenas para as funções na rota crítica da
IA-MVP** identificadas nesta fase: `operational_current_scope` (resolvedor de
escopo/perfil, chamado por toda função analítica) e
`operational_commission_periods`. As demais 72 funções não representadas
seguem catalogadas em `MANIFEST.md`, mas sem snapshot de corpo — ficam como
backlog de uma eventual Fase IA-1.1 de recuperação completa.

## Regra de uso

- **Produção → Git, nunca Git → Produção.** Estes arquivos documentam o que já
  roda em produção; nenhum deles deve ser copiado para `supabase/migrations/`
  e reaplicado sem uma avaliação de risco própria (mesmo sendo
  `CREATE OR REPLACE FUNCTION` idempotente sobre o corpo já vigente).
- Se a função mudar em produção, este snapshot fica desatualizado até ser
  recapturado — não há sincronização automática.
- Cada arquivo traz um cabeçalho com `oid`, timestamp de captura (UTC) e o
  commit HEAD do repositório no momento da captura, para rastreabilidade.
