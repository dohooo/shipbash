export interface ActivityKnowledgeSurface {
  interacts: boolean;
  inChat: boolean;
}

export declare function activityKnowledgeSurface(kind: unknown): ActivityKnowledgeSurface;

export declare const HOST_KINDS: readonly string[];

export declare function savedWaysInList(signIns: ReadonlyArray<{ method: string; label?: string | null }>): string;

export declare function savedWaysInRule(asks: boolean): string;

export declare function prepareDiscoveryChannels(
  controlRoot: string,
  fs: {
    mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
    rm: (path: string, options: { force: true }) => Promise<unknown>;
    join: (...paths: string[]) => string;
  },
): Promise<void>;

export declare function promptContractKindFor(kind: string): "initial_discovery" | "conversation" | "walk" | "suite_maintainer";
