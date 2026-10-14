export interface RouteAction {
  path: string;
  verb: "click" | "fill" | "select" | "check" | "uncheck" | "open";
  role: string;
  name: string;
  value: string | null;
  /** The page the action led to, when it left the one it was taken on (an open names its page in `value`). */
  to: { path: string; title: string } | null;
}
export declare function routePath(url: string): string | null;
export declare function walkRoute(record: { steps?: unknown }): RouteAction[];
