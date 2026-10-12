/**
 * The ShipBash service entry point.
 *
 * Assembly lives in src/service/bootstrap/ (one file per construction
 * phase); behavior lives in src/service/<concern>.ts. This file keeps only
 * what the entry must own: the public createShipBashService surface, the
 * direct-invocation path the dev stack starts, and the SIGTERM/SIGINT
 * handlers that drive the lifecycle's close().
 */
import { isDirectInvocation } from "./direct-invocation.ts";
import { serviceOptions } from "./service-options.ts";
import { createShipBashService } from "./service/bootstrap/create-service.ts";
import { errorMessage, safeText } from "./service/http-input.ts";

export { createShipBashService } from "./service/bootstrap/create-service.ts";
export type { ShipBashService, ShipBashServiceOptions } from "./service/bootstrap/options.ts";

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  const service = createShipBashService(serviceOptions());
  await service.start();
  process.stdout.write(`ShipBash service listening at ${service.baseUrl} for ${service.projectRoot}\n`);
  const shutdown = (): void => {
    void service.close().then(
      () => {
        process.exitCode = 0;
      },
      (error) => {
        process.stderr.write(`${safeText(errorMessage(error), 2_000)}\n`);
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
