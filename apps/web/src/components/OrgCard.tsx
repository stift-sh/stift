import { type FormEvent, useState } from "react";
import type { Org } from "@stift/shared";
import { useIdentity } from "../api/auth";
import { useOrg, useUpdateOrg } from "../api/org";
import { fmtBytes } from "../lib/format";
import s from "./OrgCard.module.css";

const count = (n: number) => n.toLocaleString("en-US");

/** The caller's org: what it uses of its limits (null = unlimited).
 *  Admins rename it and set the slug skills are published under. */
export function OrgCard() {
  const org = useOrg();
  const me = useIdentity();
  const [editing, setEditing] = useState(false);
  // Servers older than GET /v1/org: the card is an extra, not worth an error.
  if (!org.data) return null;
  const admin = me.data?.role === "admin";
  const { limits, usage } = org.data;
  const lines: [string, number, number | null, (n: number) => string][] = [
    ["Skills", usage.skills, limits.skills, count],
    ["Storage", usage.storage_bytes, limits.storage_bytes, fmtBytes],
    ["Seats", usage.seats, limits.seats, count],
  ];
  return (
    <div className={`card ${s.card}`} role="region" aria-label="Organization">
      <div className={s.head}>
        <span className="card-eyebrow">Organization</span>
        {admin && !editing && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <EditForm org={org.data} onDone={() => setEditing(false)} />
      ) : (
        <>
          <p className={s.name}>{org.data.name}</p>
          <p className={s.slug}>
            <span className="dim">@{org.data.slug}</span>
            {org.data.slug === "default" && admin && <span className="dim"> · set a slug before publishing skills</span>}
          </p>
        </>
      )}
      <dl className={s.usage}>
        {lines.map(([label, used, limit, fmt]) => (
          <div key={label} className={s.line}>
            <dt>{label}</dt>
            <dd className={limit !== null && used >= limit ? s.full : undefined}>
              {fmt(used)} {limit === null ? <span className="dim">· unlimited</span> : <>/ {fmt(limit)}</>}
            </dd>
            {limit !== null && <meter className={s.meter} min={0} max={Math.max(limit, 1)} value={Math.min(used, limit)} aria-label={`${label} used`} />}
          </div>
        ))}
      </dl>
    </div>
  );
}

function EditForm({ org, onDone }: { org: Org; onDone: () => void }) {
  const update = useUpdateOrg();
  const [name, setName] = useState(org.name);
  const [slug, setSlug] = useState(org.slug);
  const changed = name.trim() !== org.name || slug !== org.slug;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!changed) return onDone();
    update.mutate({ name: name.trim() !== org.name ? name.trim() : undefined, slug: slug !== org.slug ? slug : undefined }, { onSuccess: onDone });
  }

  return (
    <form className={s.form} onSubmit={submit} aria-label="Edit organization">
      <label className="field">
        <span className="field-label">Name</span>
        <input className="input" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={update.isPending} />
      </label>
      <label className="field">
        <span className="field-label">Slug</span>
        <input
          className="input"
          value={slug}
          maxLength={39}
          pattern="[a-z0-9][a-z0-9-]{1,38}"
          title="2-39 lowercase letters, digits or hyphens"
          onChange={(e) => setSlug(e.target.value)}
          disabled={update.isPending || org.slug_locked}
        />
      </label>
      <p className={`dim ${s.hint}`}>
        {org.slug_locked ? "Locked: published skills are addressed as @" + org.slug + "/…" : "Public skills are addressed as @" + (slug || "slug") + "/<name>."}
      </p>
      {update.isError && (
        <p className={s.error} role="alert">
          {update.error.message}
        </p>
      )}
      <div className={s.actions}>
        <button type="submit" className="btn btn--sm btn--primary" disabled={!name.trim() || !slug || update.isPending}>
          {update.isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onDone} disabled={update.isPending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
