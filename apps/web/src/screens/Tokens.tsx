import { type FormEvent, useState } from "react";
import type { TokenCreated, TokenInfo } from "@stift/shared";
import { useCreateToken, useRevokeToken, useTokens } from "../api/tokens";
import { CopyField } from "../components/CopyField";
import { EmptyState, ErrorState, PageHeader, Spinner } from "../components/States";
import { ago, fmtTime } from "../lib/format";
import s from "./Tokens.module.css";

export function Tokens() {
  const tokens = useTokens();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<TokenCreated | null>(null);
  const items = tokens.data ?? [];

  return (
    <section>
      <PageHeader
        title="Tokens"
        subtitle="API tokens authenticate the CLI against this server."
        actions={
          !creating &&
          !created && (
            <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
              Create token
            </button>
          )
        }
      />
      {creating && (
        <CreateForm
          onCancel={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            setCreated(t);
          }}
        />
      )}
      {created && <Created token={created} onDone={() => setCreated(null)} />}

      {tokens.isPending && <Spinner />}
      {tokens.isError && <ErrorState error={tokens.error} onRetry={() => tokens.refetch()} />}
      {tokens.data && items.length === 0 && (
        <EmptyState title="No tokens yet">
          <p>Create a token to connect the CLI. The secret is shown once, right after creating it.</p>
        </EmptyState>
      )}
      {tokens.data && items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Id</th>
                <th className="num">Created</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <Row key={t.id} token={t} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CreateForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (t: TokenCreated) => void }) {
  const create = useCreateToken();
  const [name, setName] = useState("");
  const [admin, setAdmin] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate({ name: name.trim(), admin }, { onSuccess: onCreated });
  }

  return (
    <form className={`card ${s.form}`} onSubmit={submit} aria-label="Create token">
      <span className="card-eyebrow">New token</span>
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="input"
          autoFocus
          value={name}
          placeholder="laptop, ci…"
          maxLength={64}
          onChange={(e) => setName(e.target.value)}
          disabled={create.isPending}
        />
      </label>
      <label className={s.check}>
        <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} disabled={create.isPending} />
        Admin (may manage tokens and org-scope skills)
      </label>
      {create.isError && (
        <p className={s.error} role="alert">
          {create.error.message}
        </p>
      )}
      <div className={s.actions}>
        <button type="submit" className="btn btn--primary" disabled={!name.trim() || create.isPending}>
          {create.isPending ? "Creating…" : "Create"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={create.isPending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Created({ token, onDone }: { token: TokenCreated; onDone: () => void }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-server";
  return (
    <div className={`card ${s.form}`} role="region" aria-label="Token created">
      <span className="card-eyebrow">Token created</span>
      <p className={s.warn}>
        <strong>Copy it now.</strong> This is the only time the secret is shown.
      </p>
      <CopyField value={token.token} label={token.name} />
      <p className="dim">Use it with the CLI:</p>
      <CopyField value={`stift login ${origin} --token ${token.token}`} prompt="$" label="login command" />
      <div className={s.actions}>
        <button type="button" className="btn btn--primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function Row({ token }: { token: TokenInfo }) {
  const revoke = useRevokeToken();
  const [confirm, setConfirm] = useState(false);
  return (
    <tr>
      <td className="mono">{token.name}</td>
      <td>{token.admin ? <span className="badge badge--admin">admin</span> : <span className="badge">member</span>}</td>
      <td className="mono dim">{token.id}</td>
      <td className="num dim" title={fmtTime(token.created_at)}>
        {ago(token.created_at)}
      </td>
      <td className="num">
        {revoke.isError && (
          <span className={s.error} role="alert">
            {revoke.error.message}{" "}
          </span>
        )}
        {confirm ? (
          <span className={s.confirm}>
            Revoke?
            <button
              type="button"
              className="btn btn--sm btn--danger"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(token.id, { onSettled: () => setConfirm(false) })}
            >
              {revoke.isPending ? "Revoking…" : "Confirm"}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="btn btn--sm btn--danger" onClick={() => setConfirm(true)}>
            Revoke
          </button>
        )}
      </td>
    </tr>
  );
}
