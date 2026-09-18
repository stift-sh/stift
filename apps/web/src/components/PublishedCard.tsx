import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import type { Bundle, PublishedSkillDetail } from "@stift/shared";
import { useIdentity } from "../api/auth";
import { useOrg } from "../api/org";
import { installCommand, publishedFor, usePublished, usePublishSkill, useRestore, useUnpublish } from "../api/published";
import type { SkillKey } from "../api/skills";
import { unitLabel } from "../api/skills";
import { useServerVersion } from "../api/version";
import { ago, fmtTime } from "../lib/format";
import { CopyField } from "./CopyField";
import s from "./PublishedCard.module.css";

const NAME_PATTERN = "[a-z0-9][a-z0-9-]{1,38}";
const LICENSE_PATTERN = "[A-Za-z0-9.+\\-]{1,64}";

/** An org skill's public side: whether it is shared as `@org/name`, the
 *  install command, every published version, and (admins) publish,
 *  unpublish and restore. Only on servers that declare the `registry`
 *  feature. */
export function PublishedCard({ skillKey, head, versions }: { skillKey: SkillKey; head: Bundle; versions?: number[] }) {
  const registry = useServerVersion().data?.features.includes("registry") ?? false;
  const me = useIdentity();
  const org = useOrg();
  const published = usePublished(registry);
  const [publishing, setPublishing] = useState(false);
  if (!registry || !published.data || !org.data) return null;
  const admin = me.data?.role === "admin";
  const p = publishedFor(published.data, { agent: skillKey.agent, name: skillKey.name });
  const slug = org.data.slug;

  return (
    <div className={`card ${s.card}`} role="region" aria-label="Published">
      <span className="card-eyebrow">Published</span>
      {p ? <PublishedBody p={p} head={head} admin={admin} onPublish={() => setPublishing(true)} publishing={publishing} /> : null}
      {!p && !publishing && (
        admin ? (
          slug === "default" ? (
            <p className={s.note}>
              Not published. <Link to="/members">Set an org slug</Link> to publish it as <code>@&lt;slug&gt;/{unitLabel(skillKey.name)}</code>.
            </p>
          ) : (
            <>
              <p className={s.note}>Not published. Anyone can install a published skill without a login.</p>
              <div className={s.actions}>
                <button type="button" className="btn btn--sm btn--primary" onClick={() => setPublishing(true)}>
                  Publish
                </button>
              </div>
            </>
          )
        ) : (
          <p className={s.note}>Not published.</p>
        )
      )}
      {publishing && <PublishForm skillKey={skillKey} head={head} versions={versions ?? [head.version]} slug={slug} existing={p} onDone={() => setPublishing(false)} />}
    </div>
  );
}

function PublishedBody({ p, head, admin, onPublish, publishing }: { p: PublishedSkillDetail; head: Bundle; admin: boolean; onPublish: () => void; publishing: boolean }) {
  const unpublish = useUnpublish();
  const restore = useRestore();
  const ref = `@${p.org}/${p.name}`;
  const latest = p.versions.find((v) => v.version === p.latest);
  const newest = p.versions[0];
  const hidden = p.unpublished_at !== null;
  const behind = !!newest && head.version > newest.source_version;
  const busy = unpublish.isPending || restore.isPending;
  const error = unpublish.error?.message ?? restore.error?.message;

  return (
    <>
      <p className={s.ref}>
        {ref} {latest ? <span className="dim">v{latest.version}</span> : <span className={s.hidden}>hidden</span>}
      </p>
      <p className={s.meta}>
        {latest
          ? <>from v{latest.source_version} · {p.license} · {ago(latest.created_at)}</>
          : hidden
            ? "The whole skill is hidden from search and installs; versions still resolve by number."
            : "Every version is hidden; latest resolves to nothing."}
      </p>
      {latest && <CopyField value={installCommand(ref)} prompt="$" label="Install" />}
      {admin && !publishing && (
        <div className={s.actions}>
          {behind && !hidden && (
            <button type="button" className="btn btn--sm btn--primary" onClick={onPublish} disabled={busy}>
              Publish v{head.version}
            </button>
          )}
          {hidden ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => restore.mutate({ name: p.name })} disabled={busy}>
              {restore.isPending ? "Restoring…" : "Restore"}
            </button>
          ) : (
            <button type="button" className="btn btn--sm btn--danger" onClick={() => unpublish.mutate({ name: p.name })} disabled={busy}>
              {unpublish.isPending ? "Unpublishing…" : "Unpublish"}
            </button>
          )}
        </div>
      )}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      <ol className={s.versions} aria-label="Published versions">
        {p.versions.map((v) => {
          const off = v.unpublished_at !== null;
          return (
            <li key={v.version}>
              <span className={`mono ${off ? s.hidden : ""}`}>v{v.version}</span>
              <span className="dim">
                from v{v.source_version}
                {v.published_by && <> by {v.published_by.name}</>}
                {off && " · hidden"}
              </span>
              <time className={s.when} dateTime={v.created_at} title={fmtTime(v.created_at)}>
                {ago(v.created_at)}
              </time>
              {admin && !hidden && (
                <span className={s.rowActions}>
                  {off ? (
                    <button type="button" onClick={() => restore.mutate({ name: p.name, version: v.version })} disabled={busy}>
                      restore v{v.version}
                    </button>
                  ) : (
                    <button type="button" onClick={() => unpublish.mutate({ name: p.name, version: v.version })} disabled={busy}>
                      unpublish v{v.version}
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

function PublishForm({ skillKey, head, versions, slug, existing, onDone }: { skillKey: SkillKey; head: Bundle; versions: number[]; slug: string; existing?: PublishedSkillDetail; onDone: () => void }) {
  const publish = usePublishSkill();
  const [name, setName] = useState(existing?.name ?? unitLabel(skillKey.name).toLowerCase());
  const [license, setLicense] = useState(existing?.license ?? "");
  const [version, setVersion] = useState(head.version);
  const next = (existing?.versions[0]?.version ?? 0) + 1;

  function submit(e: FormEvent) {
    e.preventDefault();
    publish.mutate(
      {
        agent: skillKey.agent,
        unit: skillKey.name,
        ...(existing ? {} : { name }),
        ...(license && license !== existing?.license ? { license } : {}),
        ...(version !== head.version ? { version } : {}),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form onSubmit={submit} aria-label={existing ? `Publish v${version}` : "Publish"}>
      <label className="field">
        <span className="field-label">Public name</span>
        <input className="input" autoFocus={!existing} value={name} pattern={NAME_PATTERN} maxLength={39} title="2-39 lowercase letters, digits or hyphens" required onChange={(e) => setName(e.target.value)} disabled={!!existing || publish.isPending} />
      </label>
      <label className="field">
        <span className="field-label">License</span>
        <input className="input" value={license} placeholder="MIT" pattern={LICENSE_PATTERN} maxLength={64} title="an SPDX identifier such as MIT or Apache-2.0, or LicenseRef-<name>" required={!existing} onChange={(e) => setLicense(e.target.value)} disabled={publish.isPending} />
      </label>
      <label className="field">
        <span className="field-label">Version to publish</span>
        <select className="input" value={version} onChange={(e) => setVersion(Number(e.target.value))} disabled={publish.isPending}>
          {versions.map((v) => (
            <option key={v} value={v}>
              v{v}
              {v === head.version ? " (current)" : ""}
            </option>
          ))}
        </select>
      </label>
      <p className={s.preview}>
        → @{slug}/{name || "<name>"} v{next}
      </p>
      {publish.isError && (
        <p className={s.error} role="alert">
          {publish.error.message}
        </p>
      )}
      <div className={s.actions}>
        <button type="submit" className="btn btn--sm btn--primary" disabled={publish.isPending || !name || (!existing && !license)}>
          {publish.isPending ? "Publishing…" : `Publish v${version}`}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onDone} disabled={publish.isPending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
