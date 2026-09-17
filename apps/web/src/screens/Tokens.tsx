import { type FormEvent, useState } from "react";
import type { TokenCreated, TokenInfo } from "@stift/shared";
import { useIdentity } from "../api/auth";
import { useMembers } from "../api/members";
import { useCreateToken, useRevokeToken, useTokens } from "../api/tokens";
import { EmptyState, ErrorState, PageHeader, Spinner } from "../components/States";
import { TokenCreated as CreatedCard } from "../components/TokenCreated";
import { ago, fmtTime } from "../lib/format";
import s from "./Tokens.module.css";

export function Tokens() {
  const tokens = useTokens();
  const me = useIdentity();
  const admin = me.data?.role === "admin";
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<TokenCreated | null>(null);
  const [user, setUser] = useState("");
  const all = tokens.data ?? [];
  // Admins see the whole org; the filter appears once two users hold tokens.
  const users = [...new Map(all.flatMap((t) => (t.user ? [[t.user.id, t.user.name] as const] : []))).entries()];
  const items = user ? all.filter((t) => t.user?.id === user) : all;

  return (
    <section>
      <PageHeader
        title="Tokens"
        subtitle={
          admin
            ? "API tokens authenticate the CLI against this server. Admins see every token in the org."
            : "Your API tokens; they authenticate the CLI against this server as you."
        }
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
          admin={admin}
          self={me.data?.user?.id}
          onCancel={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            setCreated(t);
          }}
        />
      )}
      {created && <CreatedCard token={created.token} name={created.name} onDone={() => setCreated(null)} />}

      {tokens.isPending && <Spinner />}
      {tokens.isError && <ErrorState error={tokens.error} onRetry={() => tokens.refetch()} />}
      {tokens.data && all.length === 0 && (
        <EmptyState title="No tokens yet">
          <p>Create a token to connect the CLI. The secret is shown once, right after creating it.</p>
        </EmptyState>
      )}
      {admin && users.length > 1 && (
        <div className={s.filters}>
          <select className={`input ${s.select}`} aria-label="User" value={user} onChange={(e) => setUser(e.target.value)}>
            <option value="">All users</option>
            {users.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}
      {tokens.data && all.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                {admin && <th>User</th>}
                <th>Role</th>
                <th>Id</th>
                <th className="num">Created</th>
                <th className="num">Last used</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <Row key={t.id} token={t} showUser={admin} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CreateForm({ admin: isAdmin, self, onCancel, onCreated }: { admin: boolean; self?: string; onCancel: () => void; onCreated: (t: TokenCreated) => void }) {
  const create = useCreateToken();
  const members = useMembers(isAdmin);
  const [name, setName] = useState("");
  const [forUser, setForUser] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate({ name: name.trim(), user: forUser || undefined }, { onSuccess: onCreated });
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
      {isAdmin && (members.data?.length ?? 0) > 1 && (
        <label className="field">
          <span className="field-label">For</span>
          <select className="input" value={forUser} onChange={(e) => setForUser(e.target.value)} disabled={create.isPending}>
            <option value="">Yourself</option>
            {members.data!
              .filter((m) => m.id !== self)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </label>
      )}
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

function Row({ token, showUser }: { token: TokenInfo; showUser: boolean }) {
  const revoke = useRevokeToken();
  const [confirm, setConfirm] = useState(false);
  return (
    <tr>
      <td className="mono">{token.name}</td>
      {showUser && <td>{token.user?.name ?? <span className="dim">—</span>}</td>}
      <td>{token.role === "admin" ? <span className="badge badge--admin">admin</span> : <span className="badge">member</span>}</td>
      <td className="mono dim">{token.id}</td>
      <td className="num dim" title={fmtTime(token.created_at)}>
        {ago(token.created_at)}
      </td>
      <td className="num dim" title={token.last_used_at ? fmtTime(token.last_used_at) : undefined}>
        {token.last_used_at ? ago(token.last_used_at) : "never"}
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
