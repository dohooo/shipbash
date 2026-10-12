/** Project creation, configuration, and Console resource aggregates. */
import { firstHandled } from "./route-handler.ts";
import { handleProjectConfiguration } from "./routes-project-config.ts";
import { handleProjectCreate } from "./routes-project-create.ts";
import { handleProjectResources } from "./routes-project-resources.ts";
import { handleTrustedAccess } from "./routes-trusted-access.ts";

export const handleProjects = firstHandled(
	handleTrustedAccess,
	handleProjectCreate,
	handleProjectConfiguration,
	handleProjectResources,
);
