import "server-only";

import {
  apiContractPath,
  type AnyApiContract,
  type ApiContractResponse,
} from "@shipbash/contracts/api/core";
import { configuration } from "@shipbash/control-plane/configuration";
import type { FetchQueryOptions, QueryClient, QueryKey } from "@tanstack/react-query";
import { connection } from "next/server";
import { cache } from "react";

import { readApiResponse, type ApiRead } from "./api-client";
import { type ApiReads, apiReads } from "./api-reads";
import { handlePublicVerificationWebRequest } from "./public-verification-handler";
import { readQueries } from "./queries";
import { proxyRunnerRequest } from "./runner-proxy";

/**
 * A GET answered in process by what answers its path over HTTP: a shared run's
 * public handler, or the API on the reader's behalf. The same read in one
 * render is answered and parsed once — the API fetch carries the request's
 * signal, which opts it out of Next's own fetch memoization — and every caller
 * gets the same answer. Boundaries that hand the browser the same read — the
 * frame's parts and the page each carry the session — then carry one object,
 * and React writes an object it has already written into the payload as a
 * reference to it, so it is sent once.
 * React.cache does not reach inside a "use cache" scope.
 *
 * Only for a request: a link's prefetch renders the route too, with the
 * reader's cookies but for no one in particular, and a read started there is
 * thrown away when the prefetch ends. `connection()` stops such a render
 * here, so its boundary stays on its placeholder, as it would anyway.
 */
const answer = cache(async <Contract extends AnyApiContract>(
  contract: Contract,
  path: string,
): Promise<ApiContractResponse<Contract>> => {
  await connection();
  const url = new URL(path, configuration().publicUrl);
  const request = new Request(url, { headers: { accept: "application/json" } });
  const response = url.pathname.startsWith("/api/public/verifications/")
    ? await handlePublicVerificationWebRequest(request)
    : await proxyRunnerRequest(request, url.pathname);
  return readApiResponse(contract, response);
});

/**
 * The server's transport: `callApi`'s answer, and its `ApiError`, without
 * leaving the process. Async, so an input the contract refuses (a malformed
 * token, an overlong slug) rejects as a read does rather than throwing.
 */
export const serverLoad: ApiRead = async (contract, input) => answer(contract, apiContractPath(contract, input));

/** Every read, fetched in process: for query options the table does not build, such as `publicEventLog`. */
export const serverReads = apiReads(serverLoad);

/**
 * Query options for a read, fetched in process: the same keys the browser's
 * `readQuery` uses, over `apiReads` alone — a browser-only read is not one a
 * server render can ask for.
 */
export const serverReadQuery = readQueries<keyof ApiReads>(serverReads);

/**
 * Prefetch a read the page is still worth drawing without — attention it
 * could not check, a banner it leaves out — so its failure stays with the
 * page, which reads it again in the browser, and is not the route's error.
 * A page's main read is never one of these.
 */
export function prefetchTolerated<Data, Failure, Selected, Key extends QueryKey>(
  client: QueryClient,
  options: FetchQueryOptions<Data, Failure, Selected, Key>,
): Promise<void> {
  return client.prefetchQuery({ ...options, meta: { ...options.meta, tolerated: true } });
}

/**
 * The first read of this request the server could not answer, other than one
 * the page tolerates: the page's error (WorkspacePage). A suspense query would
 * read it again during the render through the browser's transport, and a page
 * drawn around its missing main read is only that error. When the session is
 * the read that failed, nothing else was read.
 */
export function serverFailure(client: QueryClient) {
  return client.getQueryCache().getAll().find((query) => query.state.status === "error" && !query.meta?.tolerated);
}
