export type GitHubSecurityErrorCode =
  | "installation_forbidden"
  | "installation_unavailable"
  | "repository_unavailable"
  | "invalid_repository"
  | "invalid_token";

export class GitHubSecurityError extends Error {
  readonly code: GitHubSecurityErrorCode;

  constructor(code: GitHubSecurityErrorCode, message: string) {
    super(message);
    this.name = "GitHubSecurityError";
    this.code = code;
  }
}
