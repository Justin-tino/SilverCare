-- PART 4/4: health detail + fallback + RLS (run LAST)
create table if not exists public.reactivation_requests (
    uid text primary key, email text, name text, senior_id text,
    barangay text, status text not null default 'Pending',
    requested_at bigint, reviewed_by text, reviewed_at bigint,
    review_note text, confidence numeric, distance numeric,
    live_image_path text, reference_image_path text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
drop trigger if exists trg_reactivation_requests_touch on public.reactivation_requests;
create trigger trg_reactivation_requests_touch before update on public.reactivation_requests
    for each row execute function public.sc_touch_updated_at();
create table if not exists public.health_records (
    id text primary key, uid text, title text, record_type text,
    description text, recorded_at_ms bigint,
    created_at timestamptz not null default now(),
    data jsonb not null default '{}'::jsonb
);
create index if not exists health_records_uid_idx on public.health_records (uid);
create table if not exists public.health_reports (
    id text primary key, uid text, title text, report_type text,
    status text, file_path text, file_name text, mime_type text,
    created_at_ms bigint, created_at timestamptz not null default now(),
    data jsonb not null default '{}'::jsonb
);
create index if not exists health_reports_uid_idx on public.health_reports (uid);
create table if not exists public.health_management (
    uid text primary key, payload jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);
create table if not exists public.medication_requests (
    id text primary key, uid text, medication text, quantity text,
    status text not null default 'Pending', notes text,
    created_at_ms bigint, created_at timestamptz not null default now(),
    data jsonb not null default '{}'::jsonb
);
create index if not exists medication_requests_uid_idx on public.medication_requests (uid);
create table if not exists public.id_documents (
    doc_id text primary key, uid text, senior_id text,
    status text not null default 'Pending', storage_path text,
    original_name text, mime_type text, size_bytes bigint, doc_type text,
    submitted_at_ms bigint, reviewed_at_ms bigint, reviewed_by text,
    review_note text, created_at timestamptz not null default now()
);
create index if not exists id_documents_uid_idx on public.id_documents (uid);
create index if not exists id_documents_status_idx on public.id_documents (status);

-- Generic fallback for ANY unmodeled Firebase node (lean JSON only).
create table if not exists public.records (
    node text not null, key text not null,
    data jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),
    primary key (node, key)
);
create index if not exists records_node_idx on public.records (node);
create table if not exists public.migration_runs (
    id bigserial primary key, started_at timestamptz not null default now(),
    finished_at timestamptz, dry_run boolean not null default false,
    stats jsonb not null default '{}'::jsonb
);

-- RLS: backend service-role key ONLY --------------------------
do $$
declare t text;
begin
    foreach t in array array[
        'profiles','seniors','claims','pensions','pension_settings',
        'transactions','queue','appointment_requests','appointments',
        'checkups','doctors','health_centers','barangays','benefits',
        'attendance','notifications','audit_logs','qr_codes','budget',
        'system_settings','reactivation_requests','health_records',
        'health_reports','health_management','medication_requests',
        'id_documents','records','migration_runs'
    ] loop
        execute format('alter table public.%I enable row level security', t);
        if not exists (select 1 from pg_policies where schemaname='public'
            and tablename=t and policyname='service role full access') then
            execute format('create policy "service role full access" on public.%I for all to service_role using (true) with check (true)', t);
        end if;
    end loop;
end $$;
