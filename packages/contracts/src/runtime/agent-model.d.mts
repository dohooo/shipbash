export declare const AGENT_MODEL: "gpt-6.1-sol";
export declare const AGENT_SERVICE_VARIABLES: Readonly<{
  modelBaseUrl: "OPENAI_BASE_URL";
  modelApiKey: "OPENAI_API_KEY";
  modelServiceTier: "OPENAI_SERVICE_TIER";
  jevUrl: "TYPESAFE_API_URL";
  jevApiKey: "TYPESAFE_API_KEY";
}>;
export type ModelServiceTier = "priority";
export interface AgentServices {
  model: { baseUrl: string; apiKey: string; serviceTier: ModelServiceTier | null };
  jev: { url: string; apiKey: string };
}
type Environment = Readonly<Record<string, string | undefined>>;
export declare function readAgentServices(environment: Environment): {
  missing: string[];
  invalid: string[];
  services: AgentServices;
};
export declare function agentServices(environment: Environment): AgentServices;
export declare const AGENT_REASONING_EFFORTS: readonly ["minimal", "low", "medium", "high", "xhigh", "max"];
export declare const REVIEW_MODEL_CONTRACT: Readonly<{
  provider: "openai";
  model: "gpt-6.1-sol";
  reasoningEffort: "high";
}>;
