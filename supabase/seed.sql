-- Local-development seed: a password-based dev account so agents and humans
-- can sign in through the /login email+password form without GitHub OAuth.
-- Applied only by the LOCAL Supabase CLI stack (db reset / fresh start);
-- production sign-in remains GitHub-only.
--
-- Credentials: dev@shipbash.local / shipbash-dev

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, confirmation_token, recovery_token,
  email_change, email_change_token_new, email_change_token_current
)
values (
  '00000000-0000-0000-0000-000000000000',
  'dddddddd-1000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'dev@shipbash.local',
  crypt('shipbash-dev', gen_salt('bf')),
  now(),
  '{"provider": "email", "providers": ["email"]}',
  '{"name": "ShipBash Dev", "full_name": "ShipBash Dev"}',
  now(), now(), '', '', '', '', ''
)
on conflict (id) do nothing;

insert into auth.identities (
  id, user_id, provider_id, provider, identity_data,
  last_sign_in_at, created_at, updated_at
)
values (
  'dddddddd-2000-4000-8000-000000000001',
  'dddddddd-1000-4000-8000-000000000001',
  'dddddddd-1000-4000-8000-000000000001',
  'email',
  '{"sub": "dddddddd-1000-4000-8000-000000000001", "email": "dev@shipbash.local", "email_verified": true}',
  now(), now(), now()
)
on conflict (provider_id, provider) do nothing;

-- The workspace bootstrap requires a verified GitHub identity (numeric id +
-- login). This synthetic one satisfies it for the local dev account only.
insert into auth.identities (
  id, user_id, provider_id, provider, identity_data,
  last_sign_in_at, created_at, updated_at
)
values (
  'dddddddd-3000-4000-8000-000000000001',
  'dddddddd-1000-4000-8000-000000000001',
  '999999999',
  'github',
  '{"sub": "999999999", "provider_id": "999999999", "user_name": "shipbash-dev", "name": "ShipBash Dev", "full_name": "ShipBash Dev", "email": "dev@shipbash.local", "email_verified": true}',
  now(), now(), now()
)
on conflict (provider_id, provider) do nothing;
