-- Fase 4 — Primeiro Acesso / Ativação por CPF — schema baseline.
-- Versionamento retroativo (Fase 4.5): estes objetos já existem em produção
-- desde as Fases 4.1–4.3, aplicados via SQL ad-hoc (Management API). Este
-- arquivo é a representação em git do que já está implantado, não uma nova
-- aplicação. Idempotente via IF NOT EXISTS / ON CONFLICT onde aplicável.

-- ==========================================================
-- Colunas novas em usuarios
-- ==========================================================
alter table public.usuarios add column if not exists celular text;
alter table public.usuarios add column if not exists login_nbs text;

-- ==========================================================
-- ativacoes_acesso_usuario
-- ==========================================================
create table if not exists public.ativacoes_acesso_usuario (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.usuarios(id),
  email_novo text not null,
  celular_novo text,
  loja_informada text,
  nbs_informado text,
  status text not null default 'PENDENTE_EMAIL',
  token_hash text,
  expira_em timestamptz,
  tentativas_envio integer not null default 0,
  ultimo_envio_em timestamptz,
  verificado_em timestamptz,
  concluido_em timestamptz,
  cancelado_em timestamptz,
  erro_codigo text,
  erro_mensagem text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  -- Fase 4.2: mecanismo de continuação (EMAIL_VERIFICADO -> senha)
  continuacao_token_hash text,
  continuacao_expira_em timestamptz,
  continuacao_consumida_em timestamptz,
  constraint ativacoes_acesso_usuario_status_check check (status = any (array[
    'PENDENTE_EMAIL','EMAIL_ENVIADO','EMAIL_VERIFICADO','PENDENTE_SENHA',
    'ATIVANDO','AUTH_OK_USUARIOS_PENDENTE','CONCLUIDO','ERRO','CANCELADO'
  ]))
);

create unique index if not exists ativacoes_acesso_usuario_token_hash_uk
  on public.ativacoes_acesso_usuario (token_hash) where token_hash is not null;
create unique index if not exists ativacoes_acesso_usuario_continuacao_token_hash_uk
  on public.ativacoes_acesso_usuario (continuacao_token_hash) where continuacao_token_hash is not null;
create index if not exists ativacoes_acesso_usuario_usuario_id_idx
  on public.ativacoes_acesso_usuario (usuario_id);
-- Um usuario_id só pode ter uma ativação "em voo" por vez (estados ativos).
create unique index if not exists ativacoes_acesso_usuario_usuario_ativo_uk
  on public.ativacoes_acesso_usuario (usuario_id)
  where status = any (array['PENDENTE_EMAIL','EMAIL_ENVIADO','EMAIL_VERIFICADO','PENDENTE_SENHA','ATIVANDO']);
create unique index if not exists ativacoes_acesso_usuario_email_novo_ativo_uk
  on public.ativacoes_acesso_usuario (lower(email_novo))
  where status = any (array['PENDENTE_EMAIL','EMAIL_ENVIADO','EMAIL_VERIFICADO','PENDENTE_SENHA','ATIVANDO']);

alter table public.ativacoes_acesso_usuario enable row level security;
-- Zero policies deliberado: acesso só via RPC SECURITY DEFINER / service_role.

-- ==========================================================
-- revisoes_cadastrais
-- ==========================================================
create table if not exists public.revisoes_cadastrais (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.usuarios(id),
  campo text not null,
  valor_anterior text,
  valor_novo text,
  origem text not null default 'PRIMEIRO_ACESSO',
  status text not null default 'PENDENTE',
  revisado_por uuid references public.usuarios(id),
  revisado_em timestamptz,
  observacao text,
  criado_em timestamptz not null default now(),
  constraint revisoes_cadastrais_status_check check (status = any (array['PENDENTE','APROVADO','CORRIGIDO']))
);

create index if not exists revisoes_cadastrais_usuario_id_idx on public.revisoes_cadastrais (usuario_id);
create index if not exists revisoes_cadastrais_status_idx on public.revisoes_cadastrais (status);

alter table public.revisoes_cadastrais enable row level security;
-- Zero policies deliberado: acesso só via RPC SECURITY DEFINER (Master).

-- ==========================================================
-- contas_sinteticas_excluidas
-- ==========================================================
create table if not exists public.contas_sinteticas_excluidas (
  usuario_id uuid primary key references public.usuarios(id),
  motivo text not null,
  criado_em timestamptz not null default now()
);

alter table public.contas_sinteticas_excluidas enable row level security;
-- Zero policies deliberado: leitura só via RPC SECURITY DEFINER.

-- ==========================================================
-- ativacao_rate_limit
-- ==========================================================
create table if not exists public.ativacao_rate_limit (
  ip text not null,
  endpoint text not null,
  janela_inicio timestamptz not null default now(),
  tentativas integer not null default 0,
  primary key (ip, endpoint)
);

alter table public.ativacao_rate_limit enable row level security;
-- Zero policies deliberado: acesso só via RPC SECURITY DEFINER (service_role).
