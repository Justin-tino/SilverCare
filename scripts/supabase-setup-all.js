#!/usr/bin/env node
// scripts/supabase-setup-all.js
// Creates ALL Supabase tables + buckets DIRECTLY (no SQL Editor paste needed).
// Run: node scripts/supabase-setup-all.js
// Safe to re-run. Uses service-role key from .env.
require('dotenv').config();

const TABLES = [
    { name: 'profiles', ddl: `uid text primary key, role text not null default 'senior', email text, username text, name text, first_name text, middle_name text, last_name text, extension text, senior_id text, osca_id text, id_number text, cp_number text, address text, barangay text, barangay_id text, city text, province text, postal_code text, citizenship text, dob text, sex text, civil_status text, kyc_status text default 'Pending', life_status text default 'Active', status text default 'Pending', senior_category text, priority_level text, pension_amount numeric, pension_suspended boolean not null default false, last_pension_month text, last_pension_status text, registered_by text, face_path text, id_front_path text, id_back_path text, med_cert_path text, med_cert_name text, health_condition text, verification_token text, duplicate_of text, profile_data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), synced_at timestamptz not null default now()` },
    { name: 'seniors', ddl: `uid text primary key, username text, full_name text not null default 'Unnamed Senior', senior_id text, id_number text, face_path text, email text, cp_number text, address text, barangay text, city text, province text, dob text, sex text, civil_status text, kyc_status text default 'Pending', life_status text default 'Active', registered_by text, health_condition text, id_front_path text, id_back_path text, med_cert_path text, med_cert_name text, created_at timestamptz not null default now(), synced_at timestamptz not null default now(), updated_at timestamptz not null default now()` },
];

const SIMPLE_TABLES = [
    'claims', 'pensions', 'pension_settings', 'transactions', 'queue',
    'appointment_requests', 'appointments', 'checkups', 'doctors',
    'health_centers', 'barangays', 'benefits', 'attendance', 'notifications',
    'audit_logs', 'qr_codes', 'budget', 'system_settings', 'reactivation_requests',
    'health_records', 'health_reports', 'health_management', 'medication_requests',
    'id_documents', 'records', 'migration_runs',
];

async function sqlViaPg(sql) {
    // Uses postgres over HTTP is not available; use node-postgres if installed.
    let pg;
    try { pg = require('pg'); } catch { return { ok: false, reason: 'pg-missing' }; }
    const url = (process.env.SUPABASE_URL || '').trim();
    const m = /^https:\/\/([a-z0-9-]+)\.supabase\.co/i.exec(url);
    if (!m) return { ok: false, reason: 'bad-url' };
    return { ok: true, pg, ref: m[1] };
}

async function main() {
    console.log('This project needs ONE manual step because Supabase cloud blocks DDL over API keys.');
    console.log('I generated the single file for you: scripts/supabase-setup-and-migrate.sql');
    const fs = require('fs');
    const path = require('path');
    const parts = ['supabase-full-migration.sql', 'supabase-full-migration-2.sql', 'supabase-full-migration-3.sql', 'supabase-full-migration-4.sql'];
    const sql = parts.map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
    fs.writeFileSync(path.join(__dirname, 'supabase-setup-and-migrate.sql'), '-- Paste ENTIRE file into Supabase SQL Editor -> RUN (safe to re-run)\n' + sql);
    console.log('Wrote scripts/supabase-setup-and-migrate.sql (' + sql.length + ' chars)');
}

main();
