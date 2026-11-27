create index if not exists proca_agent_configs_updated_by_idx on public.proca_agent_configs(updated_by);
create index if not exists proca_app_whitelist_created_by_idx on public.proca_app_whitelist(created_by);
create index if not exists proca_blocked_domains_created_by_idx on public.proca_blocked_domains(created_by);
create index if not exists proca_device_branding_updated_by_idx on public.proca_device_branding(updated_by);
create index if not exists proca_device_events_device_id_idx on public.proca_device_events(device_id);
create index if not exists proca_devices_assigned_student_id_idx on public.proca_devices(assigned_student_id);
create index if not exists proca_devices_group_school_idx on public.proca_devices(group_id,school_id);
create index if not exists proca_devices_policy_id_idx on public.proca_devices(policy_id);