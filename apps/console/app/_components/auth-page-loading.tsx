/** What a door without a workspace shows while its page is read. */
export function AuthPageLoading({ label = "Loading" }: { label?: string }) {
  return (
    <main className="auth-page">
      <div className="section-loading" role="status" aria-label={label} />
    </main>
  );
}
