import { type FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { useAuth, useLogin } from "../api/auth";
import { Logo } from "../components/Logo";
import { Spinner } from "../components/States";
import s from "./Login.module.css";

export function Login() {
  const auth = useAuth();
  const location = useLocation();
  // With a provider the token form is the side door (an admin token, a CLI one).
  const [pasteToken, setPasteToken] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? "/sessions";

  if (auth.status === "in") return <Navigate to={from} replace />;
  const SignIn = auth.provider?.SignIn;

  return (
    <div className={s.screen}>
      <div className={s.hero}>
        <Logo size={40} />
        <h1>stift</h1>
        <p>Sync, browse, and share your AI coding-agent sessions and skills.</p>
      </div>
      {auth.status === "loading" ? (
        <Spinner />
      ) : SignIn && !pasteToken ? (
        <div className={`card ${s.card}`}>
          <span className="card-eyebrow">Sign in</span>
          <div className={s.provider}>
            <SignIn />
          </div>
          {auth.tokens && (
            <p className={s.hint}>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPasteToken(true)}>
                Use an API token instead
              </button>
            </p>
          )}
        </div>
      ) : (
        <TokenForm from={from} unavailable={auth.error} />
      )}
    </div>
  );
}

function TokenForm({ from, unavailable }: { from: string; unavailable: Error | null }) {
  const [token, setToken] = useState("");
  const login = useLogin();
  const navigate = useNavigate();

  function submit(e: FormEvent) {
    e.preventDefault();
    login.mutate(token, { onSuccess: () => navigate(from, { replace: true }) });
  }

  return (
    <form className={`card ${s.card}`} onSubmit={submit}>
      <span className="card-eyebrow">Sign in</span>
      <label className="field">
        <span className="field-label">API token</span>
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          placeholder="stf_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={login.isPending}
          required
        />
      </label>
      <button type="submit" className="btn btn--primary" disabled={login.isPending || !token.trim()}>
        {login.isPending ? "Checking…" : "Sign in"}
      </button>
      {login.isError && (
        <p className={s.error} role="alert">
          {login.error.message}
        </p>
      )}
      {unavailable && (
        <p className={s.error} role="alert">
          Provider sign-in is unavailable: {unavailable.message}
        </p>
      )}
      <p className={s.hint}>
        Create one with <code className="inline-code">stift token create</code>, or use the server's{" "}
        <code className="inline-code">STIFT_ADMIN_TOKEN</code>.
      </p>
    </form>
  );
}
