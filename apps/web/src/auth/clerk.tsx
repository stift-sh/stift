// Clerk adapter, loaded only when the server says provider "clerk". It
// takes no dependency: like Clerk's own React SDK it loads clerk-js from the
// instance's Frontend API (the host is encoded in the publishable key), and
// the sign-in and organization switcher mount into plain elements, so
// nothing Clerk-specific wraps the React tree.
import { useEffect, useRef } from "react";
import type { AuthProvider, Login } from "./provider";

/** The part of clerk-js this adapter uses. */
type Clerk = {
  load(): Promise<void>;
  session?: { getToken(opts?: { template?: string }): Promise<string | null> } | null;
  user?: { id: string } | null;
  organization?: { id: string } | null;
  signOut(): Promise<void>;
  addListener(cb: () => void): () => void;
  mountSignIn(el: HTMLDivElement, props?: object): void;
  unmountSignIn(el: HTMLDivElement): void;
  mountOrganizationSwitcher(el: HTMLDivElement, props?: object): void;
  unmountOrganizationSwitcher(el: HTMLDivElement): void;
};
declare global {
  interface Window {
    Clerk?: Clerk;
  }
}

/** `pk_live_<base64 of "clerk.example.com$">` -> `clerk.example.com`. */
export function frontendApi(publishableKey: string): string {
  const encoded = /^pk_(?:test|live)_(.+)$/.exec(publishableKey)?.[1];
  const host = encoded ? atob(encoded).replace(/\$$/, "") : "";
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error("malformed Clerk publishable key");
  return host;
}

function loadScript(publishableKey: string): Promise<Clerk> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = `https://${frontendApi(publishableKey)}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`;
    el.async = true;
    el.crossOrigin = "anonymous";
    el.dataset.clerkPublishableKey = publishableKey;
    el.onload = () => (window.Clerk ? resolve(window.Clerk) : reject(new Error("clerk-js did not initialize")));
    el.onerror = () => reject(new Error("could not load clerk-js"));
    document.head.append(el);
  });
}

function mounted(mount: (el: HTMLDivElement) => void, unmount: (el: HTMLDivElement) => void) {
  return function ClerkMount() {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const el = ref.current!;
      mount(el);
      return () => unmount(el);
    }, []);
    return <div ref={ref} />;
  };
}

export async function create(login: Login): Promise<AuthProvider> {
  if (!login.publishable_key) throw new Error("the server did not send a Clerk publishable key");
  const clerk = await loadScript(login.publishable_key);
  await clerk.load();
  const template = login.jwt_template;

  return {
    session: () => (clerk.session ? `${clerk.user?.id ?? ""}:${clerk.organization?.id ?? ""}` : null),
    getToken: async () => (await clerk.session?.getToken(template ? { template } : undefined)) ?? null,
    signOut: () => clerk.signOut(),
    subscribe: (cb) => clerk.addListener(cb),
    SignIn: mounted(
      (el) => clerk.mountSignIn(el, { forceRedirectUrl: window.location.origin + "/" }),
      (el) => clerk.unmountSignIn(el),
    ),
    // The cloud has no personal tenant: a token without an org is refused.
    OrgSwitcher: mounted(
      (el) => clerk.mountOrganizationSwitcher(el, { hidePersonal: true }),
      (el) => clerk.unmountOrganizationSwitcher(el),
    ),
  };
}
