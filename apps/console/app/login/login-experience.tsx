"use client";

import { useEffect, useRef, useState } from "react";

import { LoginChassis } from "./login-chassis";
import { type LoginProvider, LoginPanel } from "./login-experience-view";

interface LoginExperienceProps {
  /** The ways in Supabase Auth has enabled; the page offers only these, none means it is not configured, and null that Auth could not be asked. */
  providers: readonly LoginProvider[] | null;
  /** The one sentence under the headline; a run link introduces the product here. */
  description: string;
  errorMessage?: string | undefined;
  loginHref: string;
  title: string;
}

/** The eye spins for this long after a sign-in click, then gives up waiting. */
const LOADING_MS = 3_200;

export function LoginExperience({ description, errorMessage, loginHref, providers, title }: LoginExperienceProps) {
  const [pending, setPending] = useState<LoginProvider | null>(null);
  const heartTargetRef = useRef(0);
  const resetRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetRef.current), []);

  /** A sign-in click sends the eye into its loading spin until the navigation lands. */
  const startLoading = (provider: LoginProvider) => {
    setPending(provider);
    clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => setPending(null), LOADING_MS);
  };

  return (
    <LoginChassis heartTarget={heartTargetRef} labelledBy="login-title" load={pending ? 1 : 0}>
      <LoginPanel
        description={description}
        errorMessage={errorMessage}
        heartTargetRef={heartTargetRef}
        loginHref={loginHref}
        onStartLoading={startLoading}
        pending={pending}
        providers={providers}
        title={title}
      />
    </LoginChassis>
  );
}
