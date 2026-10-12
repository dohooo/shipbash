import { RootScopeRedirect } from "./_components/root-scope-redirect";

/**
 * The root names no scope, so it cannot show anything: it resolves the reader's
 * default team and product and hands over to that address. Every workspace URL
 * says which workspace it means, and this is where that starts.
 */
export default function RootPage() {
  return <RootScopeRedirect />;
}
