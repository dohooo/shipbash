/**
 * The GitHub account a captured browser is signed in to: the login in its
 * HttpOnly `.github.com` `dotcom_user` cookie, counted only while its HttpOnly
 * `logged_in` cookie says yes. Page script cannot write an HttpOnly cookie and
 * the person driving the streamed browser has no DevTools, so the login is
 * never typed in. A cookie the browser was seeded with from the Project's
 * saved profile is read as it is: this names what the jar holds, not what
 * GitHub answered just now.
 *
 * @param {Array<{ name: string, value: string, domain: string, httpOnly: boolean }>} cookies
 * @returns {string | null}
 */
export function githubAccountLogin(cookies) {
  const github = (name) => cookies.find((cookie) => cookie.name === name && cookie.httpOnly
    && cookie.domain.replace(/^\./u, "") === "github.com");
  const login = github("dotcom_user")?.value;
  if (github("logged_in")?.value !== "yes" || !login) return null;
  return /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/u.test(login) ? login.toLowerCase() : null;
}
