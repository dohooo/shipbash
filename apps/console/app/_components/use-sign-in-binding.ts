"use client";

import type { SignInTakeoverGrant } from "@shipbash/contracts/api/sign-in-takeover";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";

import type { Project, TeamSignIn, TeamSignInMethod } from "../../lib/web-client";
import { ApiError, webClient } from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import type { SignInFailureReason } from "./sign-in-card";
import { PASSWORD_METHOD } from "./sign-in-methods";
import { emptyPasswordDraft, type PasswordDraft } from "./sign-in-password-form";
import type { TakeoverPhase } from "./use-activity-takeover-transition";
import { useSignInPresentation } from "./use-sign-in-presentation";

/** One sign-in session at a time; only verification marks it done. */

export type BindPhase = "opening" | "signing_in" | "form" | "verifying" | "done" | "failed";

/** Nobody signs in by hand for a password, so that lane is finished elsewhere. */
export type SessionSignInMethod = Exclude<TeamSignInMethod, typeof PASSWORD_METHOD>;

/** Fields returned by either sign-in save path. */
type SettledSignIn = Pick<TeamSignIn, "id" | "label" | "status" | "failureReason">;

export interface Binding {
  method: TeamSignInMethod;
  phase: BindPhase;
  signInId: string | null;
  failureReason: SignInFailureReason | null;
  /** True once the reader has actually driven the browser — before that, nothing is losable. */
  touched: boolean;
  confirming: boolean;
  label: string | null;
  draft: PasswordDraft | null;
  /** The form's second line, opened by a failure that names what is behind it. */
  disclosed: boolean;
  /** A saved row still awaiting a verification verdict. */
  unchecked: boolean;
}

/** One press of the credential door: a draft, and the row a press before it saved. */
interface SaveAttempt {
  draft: PasswordDraft;
  signInId: string | null;
}

function opened(method: TeamSignInMethod, draft: PasswordDraft | null): Binding {
  return {
    method,
    phase: draft ? "form" : "opening",
    signInId: null,
    failureReason: null,
    touched: false,
    confirming: false,
    label: null,
    draft,
    disclosed: false,
    unchecked: false,
  };
}

/** Preserve a saved row for retry after an unjudged failure. */
function saveStopped(current: Binding | null): Binding | null {
  if (!current) return current;
  return { ...current, phase: "failed", failureReason: "unknown", unchecked: current.signInId !== null };
}

/** The reader is driving, so the canvas asks for the lease. The runner answers. */
function bindingWantsControl(binding: Binding | null): boolean {
  return binding?.phase === "opening" || binding?.phase === "signing_in";
}

interface Writes {
  projectId: string;
  teamId: string;
  patch: (change: Partial<Binding>) => void;
  onGranted: (grant: SignInTakeoverGrant) => void;
  /** The browser never opened, so nobody is signing in and the card says so. */
  onTakeoverFailed: () => void;
  /** The save stopped short of a verdict; whether a row survives it decides the way out. */
  onSaveFailed: () => void;
  onReleased: () => void;
  onFinishFailed: () => void;
}

/**
 * Everything this step writes: opening the browser, handing it back, and
 * saving a credential ShipBash will type in itself. Each of them ends in the
 * same place — a row whose status says what the lane has actually proved.
 */
function useBindingWrites(
  { projectId, teamId, patch, onGranted, onSaveFailed, onTakeoverFailed, onReleased, onFinishFailed }: Writes,
) {
  const queryClient = useQueryClient();
  const release = useCallback(() => {
    onReleased();
    void webClient.releaseSignInTakeover(projectId).catch(() => undefined);
  }, [onReleased, projectId]);

  /**
   * The two lists that carry this row: the project's, which the bottom bar and
   * the settings card count, and the team's, which owns the credential. A
   * verdict lands on the row itself, so both of them are stale until told —
   * and a bar that still says None saved over a way in that just ticked is
   * wrong in the one place the reader is looking.
   */
  const refreshLists = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: readKey("projectSignIns", projectId) });
    await queryClient.invalidateQueries({ queryKey: readKey("teamSignIns", teamId) });
  }, [projectId, queryClient, teamId]);

  const settled = useCallback(async (signIn: SettledSignIn) => {
    await refreshLists();
    if (signIn.status === "verifying") {
      patch({ phase: "verifying", signInId: signIn.id, label: signIn.label, unchecked: false });
      return;
    }
    // Only a leg that landed inside ticks. Every other answer has stopped
    // without proving anything, and a card that reads `done` over one of them
    // would be a tick the lane never gave.
    if (signIn.status === "ready") {
      patch({ phase: "done", signInId: signIn.id, label: signIn.label, unchecked: false });
      return;
    }
    patch({
      phase: "failed",
      signInId: signIn.id,
      failureReason: signIn.failureReason,
      label: signIn.label,
      unchecked: false,
    });
  }, [patch, refreshLists]);

  const takeover = useMutation({
    mutationFn: (method: TeamSignInMethod) => webClient.startSignInTakeover(projectId, method),
    onSuccess: onGranted,
    onError: onTakeoverFailed,
  });

  const finish = useMutation({
    mutationFn: async (method: SessionSignInMethod) => {
      const { signIn } = await webClient.completeSignInTakeover(projectId, method);
      return signIn;
    },
    onSuccess: async (signIn) => {
      await settled(signIn);
    },
    onError: () => { patch({ phase: "failed", failureReason: "unknown" }); onFinishFailed(); },
  });

  /** The row itself, told to the card the moment it exists rather than at the end. */
  const saveRow = useCallback(async (draft: PasswordDraft) => {
    const { signIn } = await webClient.createTeamSignIn(teamId, {
      method: PASSWORD_METHOD,
      loginUrl: draft.loginUrl.trim() || null,
      credential: {
        email: draft.email.trim(),
        password: draft.password,
        totpSecret: draft.totpSecret.trim() || null,
      },
    });
    patch({ signInId: signIn.id });
    return signIn.id;
  }, [patch, teamId]);

  const save = useMutation({
    mutationFn: async ({ draft, signInId }: SaveAttempt) => {
      const id = signInId ?? await saveRow(draft);
      // Binding the same sign-in twice is the same fact stated twice, so an
      // attempt whose binding never landed can simply state it again.
      await webClient.bindProjectSignIn(projectId, id);
      // `Save and verify` means both words: the credential goes straight to a
      // leg that types it into the product's own login page, and the answer
      // that comes back is a row that is verifying, never one that is ready.
      const checked = await webClient.verifySignIn(projectId, id);
      return checked.signIn;
    },
    onSuccess: async (signIn) => {
      await settled(signIn);
    },
    // A save that never reached the service is not the lane's verdict on the
    // credential, so it is not reported as one.
    onError: onSaveFailed,
  });

  /**
   * The same session, checked once more. A failed leg proved nothing about the
   * session it was handed, so the way out of one is to hand it over again —
   * and the verdict lands on the row already saved rather than on a new one,
   * which is what lets a way in that keeps failing be stopped for it.
   */
  const recheck = useMutation({
    mutationFn: async (signInId: string) => {
      const { signIn } = await webClient.verifySignIn(projectId, signInId);
      return signIn;
    },
    onSuccess: settled,
    onError: () => patch({ phase: "failed", failureReason: "unknown" }),
  });

  return { finish, recheck, refreshLists, release, save, takeover };
}

/** The canvas this step shows, and whether anyone is asking to drive it. */
function streamOf(grant: SignInTakeoverGrant | null, leg: string | null, binding: Binding | null) {
  return {
    url: leg ?? grant?.streamUrl ?? null,
    controlToken: grant?.controlToken ?? null,
    requested: bindingWantsControl(binding),
  };
}

type SignInVerification = Awaited<ReturnType<typeof webClient.readSignInVerification>>;

/** One verification poll; a removed row returns a failed binding. */
async function pollSignInVerification(
  projectId: string,
  binding: Binding | null,
  refreshLists: () => Promise<void>,
  patch: (change: Partial<Binding>) => void,
): Promise<SignInVerification> {
  let answer: SignInVerification;
  try {
    answer = await webClient.readSignInVerification(projectId, binding?.signInId ?? "");
  } catch (error) {
    // The row this card is watching is gone: removed from the Team, or unbound
    // from this Project. A leg that proves an account the Team already has no
    // longer takes this row away — it keeps this one and revokes the duplicate
    // — so a 404 here is the row itself being removed, and the card says that
    // rather than spinning on it or reading a verdict off some other row.
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    await refreshLists();
    patch({ phase: "failed", failureReason: "removed" });
    return { status: "failed", streamUrl: null, failureReason: null, label: null };
  }
  // Only `verifying` keeps the spinner turning. `ready` ticks; everything
  // else — failed, paused after three tries, revoked — has stopped, and a
  // card that keeps spinning over a leg that stopped is a card that lies.
  if (answer.status === "verifying") return answer;
  // The verdict landed on the row, so the lists that carry it are stale.
  await refreshLists();
  if (answer.status === "ready") patch({ phase: "done", label: answer.label });
  else patch({ phase: "failed", failureReason: answer.failureReason });
  return answer;
}

function useBindingSelection(options: {
  loginUrl: string;
  takeover: { mutate: (method: TeamSignInMethod) => void };
  release: () => void;
  setBinding: Dispatch<SetStateAction<Binding | null>>;
  dropPicture: () => void;
  setTakeoverPhase: Dispatch<SetStateAction<TakeoverPhase>>;
}) {
  const { loginUrl, takeover, release, setBinding, dropPicture, setTakeoverPhase } = options;
  const pick = useCallback((method: TeamSignInMethod) => {
    const draft = method === PASSWORD_METHOD ? emptyPasswordDraft(loginUrl) : null;
    setBinding(opened(method, draft));
    dropPicture();
    setTakeoverPhase(method === PASSWORD_METHOD ? "agent" : "claiming");
    takeover.mutate(method);
  }, [dropPicture, loginUrl, setBinding, setTakeoverPhase, takeover]);
  const discard = useCallback(() => {
    release();
    setBinding(null);
    setTakeoverPhase("agent");
    dropPicture();
  }, [dropPicture, release, setBinding, setTakeoverPhase]);
  const cancel = useCallback(() => {
    setBinding((current) => {
      if (!current) return null;
      if (current.touched && bindingWantsControl(current)) return { ...current, confirming: true };
      release();
      setTakeoverPhase("agent");
      dropPicture();
      return null;
    });
  }, [dropPicture, release, setBinding, setTakeoverPhase]);
  return { pick, discard, cancel };
}

export function useSignInBinding(project: Project) {
  const projectId = project.id;
  const teamId = project.teamId;
  const loginUrl = project.productionUrl ?? "";
  const [binding, setBinding] = useState<Binding | null>(null);
  const [grant, setGrant] = useState<SignInTakeoverGrant | null>(null);
  const [takeoverPhase, setTakeoverPhase] = useState<TakeoverPhase>("agent");
  const patch = useCallback((change: Partial<Binding>) => {
    setBinding((current) => (current ? { ...current, ...change } : current));
  }, []);
  const onGranted = useCallback((answer: SignInTakeoverGrant) => {
    setGrant(answer);
    setBinding((current) => (current?.phase === "opening" ? { ...current, phase: "signing_in" } : current));
  }, []);
  const onReleased = useCallback(() => setGrant(null), []);
  const onSaveFailed = useCallback(() => setBinding(saveStopped), []);
  const onTakeoverFailed = useCallback(() => {
    setTakeoverPhase("error");
    setBinding((current) => {
      // The credential lane only borrows the browser to show the reader the
      // login page it found. The form they are filling is still theirs to
      // finish, so a view that never arrived is not a verdict on it.
      if (!current || current.draft) return current;
      return { ...current, phase: "failed", failureReason: null };
    });
  }, []);
  const { finish, recheck, refreshLists, release, save, takeover } = useBindingWrites({
    onGranted,
    onReleased,
    onSaveFailed,
    onFinishFailed: () => setTakeoverPhase("error"),
    onTakeoverFailed,
    patch,
    projectId,
    teamId,
  });

  const verification = useQuery({
    queryKey: readKey("readSignInVerification", projectId, binding?.signInId),
    queryFn: () => pollSignInVerification(projectId, binding, refreshLists, patch),
    enabled: binding?.phase === "verifying" && Boolean(binding.signInId),
    refetchInterval: 2_000,
  });

  const presentation = useSignInPresentation({
    binding, phase: takeoverPhase, setPhase: setTakeoverPhase,
    submit: (method, accepted) => finish.mutate(method, { onSuccess: accepted }),
  });
  const { drop: dropPicture } = presentation;
  const { pick, discard, cancel } = useBindingSelection({
    loginUrl, takeover, release, setBinding, dropPicture, setTakeoverPhase,
  });

  // A bind that has ended, either way, holds no picture.
  useEffect(() => {
    if (binding?.phase === "done") setTakeoverPhase("agent");
    if (binding?.phase === "done" || binding?.phase === "failed") dropPicture();
  }, [binding?.phase, dropPicture]);

  return {
    binding,
    stream: streamOf(grant, verification.data?.streamUrl ?? null, binding),
    presentation,
    actions: {
      pick,
      cancel,
      discard,
      drive: () => patch({ touched: true }),
      keepGoing: () => patch({ confirming: false }),
      done: () => {
        // The credential lane has no takeover to finish; `save` is its door.
        if (binding && binding.method !== PASSWORD_METHOD && takeoverPhase === "controlling") {
          presentation.release();
        }
      },
      save: () => {
        if (!binding?.draft) return;
        // A retyped credential is a different credential, so it gets a row of
        // its own: the id a previous press saved belongs to the draft it saved.
        patch({ signInId: null, unchecked: false });
        save.mutate({ draft: binding.draft, signInId: null });
      },
      draft: (draft: PasswordDraft) => patch({ draft }),
      reopenForm: (disclosed: boolean) => patch({
        phase: "form",
        disclosed,
        draft: binding?.draft ?? emptyPasswordDraft(loginUrl),
      }),
      retry: () => {
        if (!binding?.signInId) return;
        // A credential whose row was saved and never checked is checked again
        // on that row. Every other lane hands its saved session over once more.
        if (binding.unchecked && binding.draft) {
          save.mutate({ draft: binding.draft, signInId: binding.signInId });
          return;
        }
        recheck.mutate(binding.signInId);
      },
      signInMyself: () => {
        if (!binding) return;
        dropPicture();
        setTakeoverPhase("claiming");
        patch({ phase: "opening", draft: null, failureReason: null, touched: false, unchecked: false });
        takeover.mutate(binding.method);
      },
    },
  };
}
