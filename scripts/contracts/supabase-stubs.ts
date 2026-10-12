import type postgres from "postgres";

/**
 * The Supabase-platform objects `supabase/migrations` replays against but never
 * creates: the `auth` and `storage` schemas, the two GoTrue tables the tenant
 * bootstrap reads, the Storage bucket catalogue the bucket-policy migration
 * upserts into, and `auth.uid()`.
 *
 * Three call sites hand-built this and drifted apart — one had no
 * `auth.users.email`, one no `storage.buckets.created_at`, and
 * `raw_app_meta_data` had to be added to all three by hand. One definition now,
 * and it keeps mirroring GoTrue's real column shape wherever the schema or a
 * store depends on it.
 */
export async function installSupabaseStubs(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    create schema auth;
    create schema storage;
    create table auth.users (
      id uuid primary key,
      -- Read through the team-access-request store, the only door onto it.
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb,
      -- Nullable, as GoTrue leaves it: the membership claim has to survive
      -- being merged into a row that has no app metadata yet.
      raw_app_meta_data jsonb
    );
    create table auth.identities (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references auth.users(id) on delete cascade,
      provider text not null,
      identity_data jsonb not null default '{}'::jsonb,
      unique (user_id, provider)
    );
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[],
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create function auth.uid()
    returns uuid
    language sql
    stable
    as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
  `);
}
