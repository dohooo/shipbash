// biome-ignore-all lint/a11y/noSvgWithoutTitle: the brand eye is decoration inside an aria-hidden container, so a title would announce a shape that means nothing.
"use client";

import type { RefObject } from "react";

import { initialPaths } from "./login-eye-geometry";
import styles from "./login.module.css";

/** The ref the sign-in control nudges the pupil with. */
interface EyeIntent {
  heartTargetRef: RefObject<number>;
}

function GitHubMark() {
  return (
    <svg aria-hidden="true" className={styles.ctaIcon} fill="currentColor" viewBox="0 0 16 16">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function GoogleMark() {
  // biome-ignore lint/performance/noImgElement: the brand's own multi-colour mark, sized by .ctaIcon like the GitHub one.
  return <img alt="" aria-hidden="true" className={styles.ctaIcon} src="/google-color.svg" />;
}

/** Each way to sign in, in the order the page offers them. */
const PROVIDERS = [
  { id: "github", label: "Continue with GitHub", Mark: GitHubMark },
  { id: "google", label: "Continue with Google", Mark: GoogleMark },
] as const;

type Provider = (typeof PROVIDERS)[number];

/** Which way in a sign-in click took; null while none is under way. */
export type LoginProvider = Provider["id"];

function CtaContent({ pending, provider }: { pending: boolean; provider: Provider }) {
  return (
    <>
      {pending ? <span aria-hidden="true" className={styles.ctaSpinner} /> : <provider.Mark />}
      <span>{provider.label}</span>
    </>
  );
}

export function LoginVisual({ coreGroup, dot, eye, inner, innerGroup, outer, outerGroup, pupilGroup, ring }: {
  coreGroup: RefObject<SVGGElement | null>;
  dot: RefObject<SVGPathElement | null>;
  eye: RefObject<HTMLDivElement | null>;
  inner: RefObject<SVGPathElement | null>;
  innerGroup: RefObject<SVGGElement | null>;
  outer: RefObject<SVGPathElement | null>;
  outerGroup: RefObject<SVGGElement | null>;
  pupilGroup: RefObject<SVGGElement | null>;
  ring: RefObject<SVGPathElement | null>;
}) {
  return (
    <div aria-hidden="true" className={styles.visual}>
      <div className={styles.eye} ref={eye}>
        <svg viewBox="-40 -40 480 480">
          <g ref={outerGroup}>
            <path d={initialPaths.outer} fill="none" ref={outer} stroke="currentColor" strokeLinejoin="round" strokeWidth="19" />
          </g>
          <g ref={innerGroup}>
            <path d={initialPaths.inner} fill="none" ref={inner} stroke="currentColor" strokeLinejoin="round" strokeWidth="13" />
          </g>
          <g ref={coreGroup}>
            <path d={initialPaths.ring} fill="none" ref={ring} stroke="currentColor" strokeLinejoin="round" strokeWidth="9" />
            <g ref={pupilGroup}>
              <path d={initialPaths.dot} fill="currentColor" ref={dot} />
            </g>
          </g>
        </svg>
      </div>
    </div>
  );
}

function LoginMessage({ errorMessage, providers }: {
  errorMessage?: string | undefined;
  providers: readonly LoginProvider[] | null;
}) {
  return providers === null ? (
    <div className={styles.notice} role="status">
      Sign-in is unavailable right now. Please try again in a few minutes.
    </div>
  ) : providers.length === 0 ? (
    <div className={styles.notice} role="status">
      Configure <code>NEXT_PUBLIC_SUPABASE_URL</code> and{` `}
      <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>, then enable the GitHub or Google
      provider in Supabase Auth.
    </div>
  ) : errorMessage ? (
    <p className={styles.error} role="alert">
      {errorMessage}
    </p>
  ) : null;
}

/**
 * The clicked provider keeps its strength and spins; the other fades and stops
 * taking pointer and keyboard. Neither is `disabled`, so the in-flight
 * navigation that started the wait still reaches the server.
 */
function LoginProviderCta({ heartTargetRef, loginHref, onStartLoading, pending, provider }: EyeIntent & {
  loginHref: string;
  onStartLoading: (provider: LoginProvider) => void;
  pending: LoginProvider | null;
  provider: Provider;
}) {
  const own = pending === provider.id;
  const other = pending !== null && !own;
  const state = own ? ` ${styles.ctaPending}` : other ? ` ${styles.ctaBusy}` : "";
  return (
    <a
      aria-busy={own || undefined}
      aria-describedby="login-description"
      aria-disabled={other || undefined}
      className={`${styles.cta} ${styles.ctaFull}${state}`}
      href={`${loginHref}&provider=${provider.id}`}
      onClick={() => onStartLoading(provider.id)}
      tabIndex={other ? -1 : undefined}
      onPointerEnter={() => {
        heartTargetRef.current = 1;
      }}
      onPointerLeave={() => {
        heartTargetRef.current = 0;
      }}
    >
      <CtaContent pending={own} provider={provider} />
    </a>
  );
}

export function LoginPanel({ description, errorMessage, heartTargetRef, loginHref, onStartLoading, pending, providers, title }: EyeIntent & {
  description: string;
  errorMessage?: string | undefined;
  loginHref: string;
  onStartLoading: (provider: LoginProvider) => void;
  pending: LoginProvider | null;
  providers: readonly LoginProvider[] | null;
  title: string;
}) {
  // Unconfigured or unavailable, every way in is drawn dead; otherwise only the enabled ones are drawn.
  const configured = providers !== null && providers.length > 0;
  const offered = configured ? PROVIDERS.filter((provider) => providers.includes(provider.id)) : PROVIDERS;
  return (
    <>
      <h1 className={styles.title} id="login-title">
        {title}
      </h1>
      <p className={styles.description} id="login-description">
        {description}
      </p>
      <LoginMessage errorMessage={errorMessage} providers={providers} />
      <div className={styles.ctaStack}>
        {offered.map((provider) =>
          configured ? (
            <LoginProviderCta
              heartTargetRef={heartTargetRef}
              key={provider.id}
              loginHref={loginHref}
              onStartLoading={onStartLoading}
              pending={pending}
              provider={provider}
            />
          ) : (
            <button aria-describedby="login-description" className={`${styles.cta} ${styles.ctaFull}`} disabled key={provider.id} type="button">
              <CtaContent pending={false} provider={provider} />
            </button>
          ),
        )}
      </div>
    </>
  );
}
