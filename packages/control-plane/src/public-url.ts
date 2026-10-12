/**
 * The origin the console is reached on. Production and local development
 * name it with SHIPBASH_PUBLIC_URL. A Vercel preview has no fixed name, so
 * it takes the branch alias Vercel gives every preview deployment, or the
 * deployment's own host when there is no branch.
 */
export function configuredPublicUrl(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	const configured = environment.SHIPBASH_PUBLIC_URL?.trim();
	if (configured) return configured;
	const host =
		environment.VERCEL_BRANCH_URL?.trim() || environment.VERCEL_URL?.trim();
	return host ? `https://${host}` : undefined;
}
