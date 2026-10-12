"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { productionUrlError } from "@shipbash/contracts/api/production-url";

import { type Session, useIntentKey, webClient } from "../../lib/web-client";
import { duplicateProductionProject } from "../../lib/production-url";
import { readKey } from "../../lib/queries";
import { apiMessage } from "../_lib/request-errors";
import { Empty, PageTitle, useWorkspace } from "./shell";
import { teamProjects } from "./workspace-address";

/**
 * The field holds a host: the scheme is a fixed https:// affix on the control.
 * A pasted URL that carries its own scheme (http://, https://, //) has it
 * stripped, along with a trailing slash, so the prefix is never doubled and
 * an http:// product silently becomes https:// — the intent of fixing it.
 */
function normalizeHostInput(value: string): string {
  return /^(?:https?:)?\/\//iu.test(value)
    ? value.replace(/^(?:https?:)?\/\//iu, "").replace(/\/+$/u, "")
    : value;
}

/**
 * Creating the project. Every press sends the create with the key of its
 * Production URL, spent once the create succeeds: pressed again after a lost
 * answer, the service answers with the project it already made, and a
 * different URL is a new project.
 *
 * Discovery is not started here. The project exists the moment this settles,
 * and the step that follows — saving the ways ShipBash signs in — is where the
 * reader presses `Discover journeys`, or skips it by pressing it with nothing
 * saved.
 */
function useCreateProject(teamId: string, onCreated: (() => void) | undefined) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { teamHref } = useWorkspace();
  const urlKeys = useIntentKey();
  return useMutation({
    mutationFn: (productionUrl: string) => webClient.createProject(teamId, {
      productionUrl,
      agentRuntime: "pi",
      clientIdempotencyKey: urlKeys.key(productionUrl),
    }),
    onSuccess: ({ project }, productionUrl) => {
      urlKeys.spend(productionUrl);
      // The page that holds this flow hears first, so it keeps the flow on
      // screen through the navigation; then the session learns the product,
      // synchronously, so the sign-in route resolves it on arrival; the
      // refetch that reconciles the rest follows the navigation.
      onCreated?.();
      queryClient.setQueriesData<Session>({ queryKey: readKey("session") }, (current) => (
        current ? { ...current, projects: [...current.projects, project] } : current
      ));
      toast.success("Project created", { description: `ShipBash will verify ${project.name}.` });
      router.push(teamHref("/sign-ins/setup", { project: project.slug }));
      void queryClient.invalidateQueries({ queryKey: readKey("session") });
    },
  });
}

/** What the form says under its field, and whether that marks the field itself invalid. */
interface UrlProblem {
  message: string;
  invalid: boolean;
}

/**
 * A sibling project already verifying the domain, or a host that is not a
 * domain, is the field's own fault and marks it invalid. A failed create is
 * not: it says what the service answered, until the next press.
 */
function urlProblem(duplicate: { name: string } | null, invalid: boolean, createError: unknown): UrlProblem | null {
  if (duplicate) return { message: `Another project (${duplicate.name}) already verifies this domain.`, invalid: true };
  if (invalid) return { message: "Enter a valid domain, like app.example.com", invalid: true };
  return createError ? { message: apiMessage(createError, "ShipBash could not create the project."), invalid: false } : null;
}

/**
 * The Production URL form: the field holds a host, not a URL — the scheme is a
 * fixed affix on the control — and a sibling project already verifying the
 * domain blocks it rather than being discovered after the project exists.
 * Continue creates the project.
 */
function ProductionUrlForm({ creating, disabled, hostInput, problem, onConfirm, onHostInput }: {
  /** The create runs, or has made the project and the navigation is on its way. */
  creating: boolean;
  disabled: boolean;
  hostInput: string;
  problem: UrlProblem | null;
  onConfirm: () => void;
  onHostInput: (value: string) => void;
}) {
  return (
    <section className="onboarding-panel">
      <div className="onboarding-panel-copy">
        <h2>Production URL</h2>
        <p>The live product ShipBash explores and verifies.</p>
      </div>
      <form
        className="project-form onboarding-form"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <div className="onboarding-panel-body">
          <div className="form-field url-field">
            <div className="url-input">
              <span className="url-scheme" aria-hidden="true">https://</span>
              <input
                type="text"
                value={hostInput}
                onChange={(event) => onHostInput(event.target.value)}
                placeholder="app.example.com"
                aria-label="Production URL"
                inputMode="url"
                autoCapitalize="off"
                spellCheck={false}
                required
                // biome-ignore lint/a11y/noAutofocus: this input is the only thing on its step of Setup, reached by a deliberate click.
                autoFocus
                aria-invalid={problem?.invalid ? true : undefined}
              />
            </div>
          </div>
          {problem ? <p className="inline-error" role="alert">{problem.message}</p> : null}
        </div>
        <footer className="onboarding-panel-footer">
          <button className="button primary" type="submit" disabled={disabled}>
            {creating ? "Creating…" : "Continue"}
          </button>
        </footer>
      </form>
    </section>
  );
}

export function ProductionOnboarding({ onCreated }: {
  /** Told the moment the project exists, before the navigation to its next step. */
  onCreated?: () => void;
}) {
  const { session, team } = useWorkspace();
  const [hostInput, setHostInput] = useState("");
  const host = hostInput.trim();
  const productionUrl = host ? `https://${host}` : "";
  const invalid = Boolean(host) && productionUrlError(productionUrl) !== null;
  const create = useCreateProject(team.id, onCreated);
  // The form stays on screen through the navigation, by which time the session
  // carries the project this flow created: that project is not another one
  // verifying the domain.
  const duplicate = duplicateProductionProject(teamProjects(session, team.id), productionUrl, create.data?.project.id);
  const blocked = !host || invalid || Boolean(duplicate);
  const creating = create.isPending || create.isSuccess;

  if (team.role !== "admin") {
    return <Empty title="Admin access required" body="Only a Team Admin can create a Production project." />;
  }

  return (
    <div className="page">
      <PageTitle
        eyebrow="Get started"
        title="Verify your Production product"
        body="Enter one URL. ShipBash will explore the live product and propose the user journeys every release should preserve."
      />
      <ProductionUrlForm
        creating={creating}
        disabled={blocked || creating}
        hostInput={hostInput}
        problem={urlProblem(duplicate, invalid, create.error)}
        onConfirm={() => {
          if (blocked) return;
          setHostInput(host);
          create.mutate(productionUrl);
        }}
        onHostInput={(value) => setHostInput(normalizeHostInput(value))}
      />
    </div>
  );
}
