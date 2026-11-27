-- PROCA control plane extensions for ACCESS UG.
-- Existing ACCESS UG tables and PROCA-prefixed core tables are preserved.
alter table public.proca_schools
  add column if not exists access_school_id uuid references public.schools(id) on delete cascade;

create unique index if not exists proca_schools_access_school_id_uidx
  on public.proca_schools(access_school_id) where access_school_id is not null;

alter table public.proca_devices
  add column if not exists assigned_student_id uuid references public.students(id) on delete set null,
  add column if not exists group_id uuid;

create table if not exists public.proca_device_groups (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.proca_schools(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, school_id),
  unique (school_id, name)
);

alter table public.proca_devices
  add constraint proca_devices_group_school_fkey
  foreign key (group_id, school_id)
  references public.proca_device_groups(id, school_id)
  on delete set null (group_id);

create table if not exists public.proca_app_whitelist (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.proca_schools(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 160),
  executable_name text not null,
  executable_path text,
  publisher text,
  platform text not null default 'windows' check (platform in ('windows','android','any')),
  package_id text,
  enabled boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.proca_blocked_domains (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.proca_schools(id) on delete cascade,
  domain text not null check (length(domain) between 1 and 253),
  category text not null default 'custom' check (category in ('social_media','gaming','adult','streaming','proxy_vpn','custom')),
  action text not null default 'block' check (action in ('block','allow')),
  enabled boolean not null default true,
  reason text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (school_id, domain)
);

create table if not exists public.proca_device_branding (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null unique references public.proca_schools(id) on delete cascade,
  organization_name text,
  primary_color text not null default '#07111F' check (primary_color ~ '^#[A-Fa-f0-9]{6}$'),
  accent_color text not null default '#22D3EE' check (accent_color ~ '^#[A-Fa-f0-9]{6}$'),
  logo_url text,
  wallpaper_url text,
  login_message text,
  show_device_badge boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.proca_agent_configs (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.proca_schools(id) on delete cascade,
  platform text not null check (platform in ('windows','android')),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, platform)
);

create unique index if not exists proca_policies_school_profile_uidx
  on public.proca_policies(school_id, profile_type);

create unique index if not exists proca_devices_school_code_uidx
  on public.proca_devices(school_id, device_code);

create index if not exists proca_devices_school_status_idx
  on public.proca_devices(school_id, status);

create index if not exists proca_events_school_created_idx
  on public.proca_device_events(school_id, created_at desc);

create index if not exists proca_whitelist_school_created_idx
  on public.proca_app_whitelist(school_id, created_at desc);

create index if not exists proca_domains_school_created_idx
  on public.proca_blocked_domains(school_id, created_at desc);

-- All PROCA control-plane access is mediated by the authenticated Edge Function.
-- Browser clients cannot read or mutate these tables directly.
do $$
declare t text;
begin
  foreach t in array array[
    'proca_device_groups',
    'proca_app_whitelist',
    'proca_blocked_domains',
    'proca_device_branding',
    'proca_agent_configs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_deny_client', t);
    execute format('create policy %I on public.%I for all to anon, authenticated using (false) with check (false)', t || '_deny_client', t);
  end loop;
end $$;
