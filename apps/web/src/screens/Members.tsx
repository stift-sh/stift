import { type FormEvent, useState } from "react";
import type { Member, MemberCreated, Role } from "@stift/shared";
import { useIdentity } from "../api/auth";
import { useAddMember, useMembers, useRemoveMember, useSetRole } from "../api/members";
import { isLimit, LimitNotice } from "../components/LimitNotice";
import { OrgCard } from "../components/OrgCard";
import { ErrorState, PageHeader, Spinner } from "../components/States";
import { TokenCreated } from "../components/TokenCreated";
import { ago, fmtTime } from "../lib/format";
import s from "./Tokens.module.css";

export function Members() {
  const members = useMembers();
  const me = useIdentity();
  const admin = me.data?.role === "admin";
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<MemberCreated | null>(null);

  return (
    <section>
      <PageHeader
        title="Members"
        subtitle={
          admin
            ? "Everyone in this org. Members read every skill and publish their own; admins also publish org skills and manage members and tokens."
            : "Everyone in this org. Admins manage members and roles."
        }
        actions={
          admin &&
          !adding &&
          !added?.token && (
            <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>
              Add member
            </button>
          )
        }
      />
      <OrgCard />
      {adding && (
        <AddForm
          onCancel={() => setAdding(false)}
          onAdded={(m) => {
            setAdding(false);
            setAdded(m);
          }}
        />
      )}
      {added?.token && (
        <TokenCreated title={`First token for ${added.name}`} name={added.name} token={added.token} onDone={() => setAdded(null)} />
      )}

      {members.isPending && <Spinner />}
      {members.isError && <ErrorState error={members.error} onRetry={() => members.refetch()} />}
      {members.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th className="num">Tokens</th>
                <th className="num">Joined</th>
                {admin && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {members.data.map((m) => (
                <Row key={m.id} member={m} admin={admin} self={m.id === me.data?.user?.id} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AddForm({ onCancel, onAdded }: { onCancel: () => void; onAdded: (m: MemberCreated) => void }) {
  const add = useAddMember();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [admin, setAdmin] = useState(false);
  const [withToken, setWithToken] = useState(true);
  const [tokenName, setTokenName] = useState("first");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    add.mutate(
      {
        name: name.trim(),
        email: email.trim() || undefined,
        role: admin ? "admin" : "member",
        token: withToken ? tokenName.trim() || "first" : undefined,
      },
      { onSuccess: onAdded },
    );
  }

  return (
    <form className={`card ${s.form}`} onSubmit={submit} aria-label="Add member">
      <span className="card-eyebrow">New member</span>
      <label className="field">
        <span className="field-label">Name</span>
        <input className="input" autoFocus value={name} placeholder="ada" maxLength={64} onChange={(e) => setName(e.target.value)} disabled={add.isPending} />
      </label>
      <label className="field">
        <span className="field-label">Email (optional)</span>
        <input className="input" type="email" value={email} placeholder="ada@example.com" onChange={(e) => setEmail(e.target.value)} disabled={add.isPending} />
      </label>
      <label className={s.check}>
        <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} disabled={add.isPending} />
        Admin (may publish org skills and manage members and tokens)
      </label>
      <label className={s.check}>
        <input type="checkbox" checked={withToken} onChange={(e) => setWithToken(e.target.checked)} disabled={add.isPending} />
        Create a first token to hand over
      </label>
      {withToken && (
        <label className="field">
          <span className="field-label">Token name</span>
          <input className="input" value={tokenName} maxLength={64} onChange={(e) => setTokenName(e.target.value)} disabled={add.isPending} />
        </label>
      )}
      <LimitNotice error={add.error} />
      {add.isError && !isLimit(add.error) && (
        <p className={s.error} role="alert">
          {add.error.message}
        </p>
      )}
      <div className={s.actions}>
        <button type="submit" className="btn btn--primary" disabled={!name.trim() || add.isPending}>
          {add.isPending ? "Adding…" : "Add"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={add.isPending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Row({ member: m, admin, self }: { member: Member; admin: boolean; self: boolean }) {
  const setRole = useSetRole();
  const remove = useRemoveMember();
  const [confirm, setConfirm] = useState(false);
  const error = setRole.error ?? remove.error;
  return (
    <tr>
      <td>
        {m.name}
        {self && <span className="dim"> (you)</span>}
      </td>
      <td className="dim">{m.email ?? "—"}</td>
      <td>
        {admin ? (
          <select
            className={`input ${s.role}`}
            aria-label={`Role of ${m.name}`}
            value={m.role}
            disabled={setRole.isPending}
            onChange={(e) => setRole.mutate({ id: m.id, role: e.target.value as Role })}
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        ) : (
          <span className={m.role === "admin" ? "badge badge--admin" : "badge"}>{m.role}</span>
        )}
      </td>
      <td className="num dim">{m.tokens}</td>
      <td className="num dim" title={fmtTime(m.created_at)}>
        {ago(m.created_at)}
      </td>
      {admin && (
        <td className="num">
          {error && (
            <span className={s.error} role="alert">
              {error.message}{" "}
            </span>
          )}
          {confirm ? (
            <span className={s.confirm}>
              Remove {m.name} and their {m.tokens} token{m.tokens === 1 ? "" : "s"}?
              <button
                type="button"
                className="btn btn--sm btn--danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(m.id, { onSettled: () => setConfirm(false) })}
              >
                {remove.isPending ? "Removing…" : "Confirm"}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </span>
          ) : (
            !self && (
              <button type="button" className="btn btn--sm btn--danger" onClick={() => setConfirm(true)}>
                Remove
              </button>
            )
          )}
        </td>
      )}
    </tr>
  );
}
