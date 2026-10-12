/**
 * How a person appears wherever they are listed: their GitHub or Google
 * picture, else an initial, and the handle beside their name — the GitHub
 * login, or the email of an account signed in with Google alone.
 */
interface Identity {
  displayName: string;
  githubLogin: string | null;
  avatarUrl: string | null;
  email: string | null;
}

export function profileHandle(profile: Identity): string {
  return profile.githubLogin ? `@${profile.githubLogin}` : (profile.email ?? "");
}

export function ProfileAvatar({ profile }: { profile: Identity }) {
  return (
    <span className="avatar" aria-hidden="true">
      {profile.avatarUrl ? (
        // GitHub and Google own these profile image URLs; the CSP admits only their avatar hosts.
        // biome-ignore lint/performance/noImgElement: sized by `.avatar img`, 30px in lists and 38px on the profile, so no fixed dimension pair fits.
        <img alt="" src={profile.avatarUrl} referrerPolicy="no-referrer" />
      ) : (profile.displayName || profileHandle(profile)).slice(0, 1).toUpperCase()}
    </span>
  );
}
