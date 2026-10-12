export const DEFAULT_HOST = "127.0.0.1";
export const SUPABASE_NETWORK = "shipbash-loopback";
export const SUPABASE_DATABASE_CONTAINER = "supabase_db_shipbash";
export const SUPABASE_DATABASE_DEPENDENTS = [
  "supabase_auth_shipbash",
  "supabase_rest_shipbash",
  "supabase_storage_shipbash",
  "supabase_kong_shipbash",
] as const;
export const SUPABASE_EXCLUDED_SERVICES = [
  "edge-runtime",
  "imgproxy",
  "logflare",
  "mailpit",
  "realtime",
  "studio",
  "vector",
].join(",");
