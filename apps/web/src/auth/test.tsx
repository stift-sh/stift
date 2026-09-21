// Adapter for end-to-end and unit tests (STIFT_LOGIN_PROVIDER=test): the
// page supplies ready-made JWTs on window.__stiftTestAuth, one per org, and
// the server verifies them like any other. It holds no secret.
import type { AuthProvider } from "./provider";

export type TestAuth = { sessions: { org: string; token: string }[] };
declare global {
  interface Window {
    __stiftTestAuth?: TestAuth;
  }
}

const KEY = "stift.test_session";

export async function create(): Promise<AuthProvider> {
  const sessions = () => window.__stiftTestAuth?.sessions ?? [];
  const listeners = new Set<() => void>();
  const index = () => {
    const raw = sessionStorage.getItem(KEY);
    return raw !== null && sessions()[Number(raw)] ? Number(raw) : null;
  };
  const select = (i: number | null) => {
    if (i === null) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, String(i));
    for (const l of listeners) l();
  };

  return {
    session: () => {
      const i = index();
      return i === null ? null : `test:${sessions()[i]!.org}`;
    },
    getToken: async () => {
      const i = index();
      return i === null ? null : sessions()[i]!.token;
    },
    signOut: async () => select(null),
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    SignIn: () => (
      <button type="button" className="btn btn--primary" onClick={() => select(0)} disabled={sessions().length === 0}>
        Sign in as the test user
      </button>
    ),
    OrgSwitcher: () => (
      <select className="input" aria-label="Organization" value={index() ?? 0} onChange={(e) => select(Number(e.target.value))}>
        {sessions().map((s, i) => (
          <option key={s.org} value={i}>
            {s.org}
          </option>
        ))}
      </select>
    ),
  };
}
