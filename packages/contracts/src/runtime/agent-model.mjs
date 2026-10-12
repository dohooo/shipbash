// One model for every agent role; the reasoning effort follows the role
// (model-contract.ts). Jev is TypeSafe's own
// model and is chosen where it is called (jev-target.mjs). Shared by the
// host's contracts and the container's runtime.
export const AGENT_MODEL = "gpt-6.1-sol";

// How every agent reaches its services: the deployment names them in its
// environment. The model gateway, under OpenAI's own variable names, is an
// OpenAI Responses API endpoint serving AGENT_MODEL, asked for the tier the
// deployment chose (none when unset); Jev
// is TypeSafe's endpoint. Each is authenticated by the key in its own
// variable. They are read through the functions below: a host's
// configuration reads them once and hands them down (control-plane
// configuration.ts), and a runner refuses to start without them and reads
// them from its own environment where it uses them — pi (pi-sdk.mjs), the
// Codex CLI a journey's shell runs (codex-config.mjs), Jev (jev-actions.mjs)
// and the tier recorded with usage.
export const AGENT_SERVICE_VARIABLES = Object.freeze({
  modelBaseUrl: "OPENAI_BASE_URL",
  modelApiKey: "OPENAI_API_KEY",
  modelServiceTier: "OPENAI_SERVICE_TIER",
  jevUrl: "TYPESAFE_API_URL",
  jevApiKey: "TYPESAFE_API_KEY",
});

// The tiers a deployment may ask its gateway for.
const SERVICE_TIERS = Object.freeze(["priority"]);

function serviceUrl(environment, name, report) {
  const value = environment[name]?.trim();
  if (!value) {
    report.missing.push(name);
    return "";
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
    report.invalid.push(`${name} must be an HTTP(S) URL without credentials, query or fragment.`);
    return "";
  }
  return url.href.replace(/\/+$/u, "");
}

function serviceTier(environment, report) {
  const name = AGENT_SERVICE_VARIABLES.modelServiceTier;
  const value = environment[name]?.trim();
  if (!value) return null;
  if (SERVICE_TIERS.includes(value)) return value;
  report.invalid.push(`${name} must be one of ${SERVICE_TIERS.join(", ")}, or unset.`);
  return null;
}

function requiredKey(environment, name, report) {
  const value = environment[name]?.trim();
  if (!value) report.missing.push(name);
  return value ?? "";
}

/**
 * The agent services the environment names, with every variable it lacks
 * and every value it gets wrong, so a host can report them all at once.
 */
export function readAgentServices(environment) {
  const report = { missing: [], invalid: [] };
  const services = {
    model: {
      baseUrl: serviceUrl(environment, AGENT_SERVICE_VARIABLES.modelBaseUrl, report),
      apiKey: requiredKey(environment, AGENT_SERVICE_VARIABLES.modelApiKey, report),
      serviceTier: serviceTier(environment, report),
    },
    jev: {
      url: serviceUrl(environment, AGENT_SERVICE_VARIABLES.jevUrl, report),
      apiKey: requiredKey(environment, AGENT_SERVICE_VARIABLES.jevApiKey, report),
    },
  };
  return { ...report, services };
}

/** The agent services the environment names, or one error naming every variable it lacks or gets wrong. */
export function agentServices(environment) {
  const { missing, invalid, services } = readAgentServices(environment);
  const sentences = [...(missing.length > 0 ? [`${missing.join(", ")} must be configured.`] : []), ...invalid];
  if (sentences.length > 0) throw new Error(sentences.join(" "));
  return services;
}

// The reasoning efforts an agent accepts, lowest first.
export const AGENT_REASONING_EFFORTS = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"]);

// Evidence review and code evidence: the passes that judge a run from its
// record, at high like the roles that plan.
export const REVIEW_MODEL_CONTRACT = Object.freeze({
  provider: "openai", model: AGENT_MODEL, reasoningEffort: "high",
});
