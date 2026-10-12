"use client";

/**
 * Products → one product: where ShipBash walks, and when it walks on its own.
 *
 * The product is the one the workspace is scoped to — the same one the rail's
 * switcher names — so the cards read it from there rather than from a slug of
 * their own.
 */
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { productionUrlError } from "@shipbash/contracts/api/production-url";

import { type Project, readQuery, webClient } from "../../lib/web-client";
import { apiMessage } from "../_lib/request-errors";
import { duplicateProductionProject } from "../../lib/production-url";
import { readKey } from "../../lib/queries";
import { DeleteProject } from "./project-delete";
import { TrustedAccessSection } from "./project-trusted-access";
import { SettingsCardBoundary } from "./settings-card-boundary";
import { ScheduleSection } from "./settings-schedule";
import { Empty, useWorkspace } from "./shell";
import { teamProjects } from "./workspace-address";

/** The live URL every run walks, and the sibling product that would collide with it. */
function TargetProductCard({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const { session, team } = useWorkspace();
  const [productionUrl, setProductionUrl] = useState(project.productionUrl ?? "");
  const save = useMutation({
    mutationFn: () => webClient.updateProject(project.id, { productionUrl }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: readKey("session") });
      toast.success("Target product saved");
    },
  });
  const readOnly = team.role !== "admin";
  const duplicate = duplicateProductionProject(
    teamProjects(session, team.id),
    productionUrl,
    project.id,
  );
  const urlError = productionUrl.trim() ? productionUrlError(productionUrl) : null;
  const blocked = Boolean(duplicate) || Boolean(urlError);
  return (
    <section className="settings-card" aria-labelledby="target-product-title">
      <h2 id="target-product-title">Target product</h2>
      <p>The live URL ShipBash walks on every run.</p>
      <form onSubmit={(event) => { event.preventDefault(); if (blocked) return; save.mutate(); }}>
        <label className="form-field">
          <span>Production URL</span>
          <input
            type="url"
            value={productionUrl}
            readOnly={readOnly}
            required
            aria-invalid={blocked ? true : undefined}
            onChange={(event) => setProductionUrl(event.target.value)}
          />
        </label>
        {duplicate ? (
          <p className="inline-error" role="alert">Another project ({duplicate.name}) already verifies this domain.</p>
        ) : urlError ? <p className="inline-error" role="alert">{urlError}</p> : null}
        {save.isError ? <p className="inline-error" role="alert">{apiMessage(save.error, "ShipBash could not save this change.")}</p> : null}
        {readOnly ? null : (
          <button
            className="button primary"
            type="submit"
            disabled={save.isPending || !productionUrl.trim() || productionUrl === project.productionUrl || blocked}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        )}
      </form>
    </section>
  );
}

/**
 * The recovery a Cloudflare-guarded product is sent here for, and nothing more
 * until it is. Only an admin manages it, so only an admin's page reads it — and
 * reads it before drawing, so a stored key is never shown as missing.
 */
function TrustedAccessCard({ project }: { project: Project }) {
  const searchParams = useSearchParams();
  const { data } = useSuspenseQuery(readQuery("trustedAccess", project.id));
  const access = data.trustedAccess;
  if (searchParams.get("trustedAccess") !== "cloudflare" && !access) return null;
  return <TrustedAccessSection access={access} activityId={searchParams.get("activity")} project={project} />;
}

export function ProductPane() {
  const { project, team } = useWorkspace();
  if (!project) {
    return <Empty title="No product yet" body={`${team.name} has nothing to configure until it verifies a product.`} />;
  }
  return (
    <>
      <TargetProductCard project={project} />
      <SettingsCardBoundary><ScheduleSection project={project} /></SettingsCardBoundary>
      {team.role === "admin" ? <SettingsCardBoundary><TrustedAccessCard project={project} /></SettingsCardBoundary> : null}
      {team.role === "admin" ? <DeleteProject project={project} /> : null}
    </>
  );
}
