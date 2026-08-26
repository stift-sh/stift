import { type FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { useLogin, useToken } from "../api/auth";
import { Logo } from "../components/Logo";
import s from "./Login.module.css";

export function Login() {
  const [token, setToken] = useState("");
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const existing = useToken();
  const from = (location.state as { from?: string } | null)?.from ?? "/sessions";

  if (existing && !login.isPending) return <Navigate to={from} replace />;

  function submit(e: FormEvent) {
    e.preventDefault();
    login.mutate(token, { onSuccess: () => navigate(from, { replace: true }) });
  }

  return (
    <div className={s.screen}>
      <div className={s.hero}>
        <Logo size={40} />
        <h1>stift</h1>
        <p>Sync, browse, and share your AI coding-agent sessions and skills.</p>
      </div>
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
        <p className={s.hint}>
          Create one with <code className="inline-code">stift token create</code>, or use the server's{" "}
          <code className="inline-code">STIFT_ADMIN_TOKEN</code>.
        </p>
      </form>
    </div>
  );
}
