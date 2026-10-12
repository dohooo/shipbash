/**
 * The local lane's task API: a run-scoped HTTP endpoint the runner reaches
 * with a bearer, serving `POST /<method>` for the task API methods its source
 * has, in the job API's envelope — the arguments as a (gzipped) JSON array
 * in, `{"result": …}` or `{"ok": false, "error", "message"}` out — so the
 * runner asks it with the one job API client (contracts job-api.mjs). Its
 * source is a job port, whose method names are the wire paths, or a sign-in
 * check's own source. A Sandbox runs no broker: its runner calls the job API
 * itself.
 *
 * It lives in whichever process holds what it serves — the local service
 * beside a Docker container, the root side of a hosted sign-in check — and
 * hands its runner a random token for the run's lifetime.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { credentialError, validCredentialRequest } from "@shipbash/contracts/runtime/credential-contract.mjs";
import {
  jobApiAnswer,
  jobApiFailure,
  readJobApiArguments,
  TASK_API_METHODS,
  unknownJobMethod,
} from "@shipbash/contracts/runtime/job-api.mjs";

import { credentialValues } from "./credential-values.mjs";

/**
 * Where the broker listens for the runner it serves. A Docker container
 * reaches the host through its gateway, so that broker listens on every
 * interface; a process beside it reaches it on loopback only.
 */
const LISTEN_ADDRESS = Object.freeze({
  "host.docker.internal": "0.0.0.0",
  "127.0.0.1": "127.0.0.1",
});

const IDENTITY_REFUSED = Object.freeze({ status: 401, error: "JOB_IDENTITY_INVALID", message: "The caller is not this run's runner." });

function authorized(request, token) {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** The source's answer, or its refusal in the job API's envelope: the job API's own words for the same failure. */
async function outcomeOf(context, method, request) {
  const run = TASK_API_METHODS.includes(method) ? context.source[method] : undefined;
  if (typeof run !== "function") return unknownJobMethod(method);
  const body = await readJobApiArguments(request, request.headers["content-encoding"]);
  if (!("args" in body)) return body;
  try {
    return { result: await run.apply(context.source, body.args) };
  } catch (error) {
    return jobApiFailure(error);
  }
}

async function serve(context, token, request, response) {
  const outcome = request.method === "POST" && authorized(request, token)
    ? await outcomeOf(context, (request.url ?? "").slice(1), request)
    : IDENTITY_REFUSED;
  const { status, headers, body } = await jobApiAnswer(request.headers["accept-encoding"], outcome);
  response.writeHead(status, headers).end(body);
}

/** A running broker. Its token dies with it: closed by the run's dispose, or by the run's abort. */
export async function createTaskBroker(context) {
  const token = randomBytes(32).toString("base64url");
  const server = createServer((request, response) => {
    serve(context, token, request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
    });
  });
  server.requestTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LISTEN_ADDRESS[context.host], resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The task API did not start.");
  const close = () => { server.close(); server.closeAllConnections(); };
  context.signal.addEventListener("abort", close, { once: true });
  return {
    config: { endpoint: `http://${context.host}:${address.port}`, token },
    close() { context.signal.removeEventListener("abort", close); close(); },
  };
}

/**
 * A sign-in check's source: the one saved sign-in the leg is proving, on the
 * page it was saved for, and the account the leg is told about. The host
 * opened it for this check; the leg reads it field by field, like any run.
 * A check records no outcome.
 * @param {{ signInId: string, signInPageUrl: string, credential: { email: string, password: string, totpSecret: string | null } }} check
 */
export function signInCheckSource(check) {
  const { signInId, credential } = check;
  const account = {
    id: signInId, account: credential.email, allowedOrigins: [new URL(check.signInPageUrl).origin],
    availableFields: ["username", "password", ...(credential.totpSecret ? ["totp"] : [])],
  };
  return {
    signIns: [account],
    credentialsRead: async (input) => {
      if (!validCredentialRequest(input)) return credentialError("invalid_request");
      if (input.signInId !== signInId) return credentialError("access_denied");
      return credentialValues(input.fields, { username: credential.email, password: credential.password, totpSecret: credential.totpSecret });
    },
  };
}
