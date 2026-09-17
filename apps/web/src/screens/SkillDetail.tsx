import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ApiError, roleOf, useIdentity } from "../api/auth";
import { useMembers } from "../api/members";
import { useInstalls } from "../api/org";
import { fetchBlobText, isEditable, keyHref, type SkillKey, unitLabel, useBlobText, useBundle, useBundleHistory, useDeleteBundle, usePublish, useRollback } from "../api/skills";
import { SkillEditor } from "./SkillEditor";
import { ErrorState, NotFound, PageHeader, Spinner } from "../components/States";
import { diffLines, diffManifests, type FileChange, isBinary, MAX_TEXT_DIFF } from "../lib/diff";
import { ago, fmtBytes, fmtTime } from "../lib/format";
import { auditTimeline } from "../lib/audit";
import { renderMarkdown, splitFrontMatter } from "../lib/markdown";
import s from "./SkillDetail.module.css";

const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : 0);
const modeString = (mode: number) => (mode & 0o111 ? "exec" : "file");

function useSkillKey(): SkillKey {
  const params = useParams();
  const [search] = useSearchParams();
  return { scope: params.scope ?? "", agent: params.agent ?? "", name: params["*"] ?? "", project: search.get("project") ?? undefined };
}

export function SkillDetail() {
  const key = useSkillKey();
  const [search] = useSearchParams();
  const wanted = num(search.get("v"));
  const diffTo = num(search.get("diff"));
  const editPath = search.get("edit") ?? undefined;
  const adding = search.get("add") === "1";
  const navigate = useNavigate();

  const head = useBundle(key, 0);
  const shown = useBundle(key, wanted);
  const history = useBundleHistory(key);
  const rollback = useRollback();
  const del = useDeleteBundle();
  const removeFile = usePublish();
  // Org units are published by admins; other members read them.
  const canWrite = roleOf(useIdentity().data) === "admin" || key.scope !== "org";
  const [confirm, setConfirm] = useState<"delete" | "rollback" | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  useEffect(() => {
    setConfirm(null);
    setRemoving(null);
  }, [wanted, diffTo, editPath, adding]);

  if (head.isPending || shown.isPending) return <Spinner />;
  if (head.isError || shown.isError) {
    const err = head.error ?? shown.error!;
    if (err instanceof ApiError && err.status === 404) return <NotFound />;
    return <ErrorState error={err} onRetry={() => void Promise.all([head.refetch(), shown.refetch()])} />;
  }
  const it = shown.data;
  const current = head.data;
  const isHead = it.version === current.version;
  const description = it.skills[0]?.description;
  const md = it.files.find((f) => f.path === it.skills[0]?.path) ?? it.files.find((f) => f.path.endsWith(".md"));
  const total = it.files.reduce((n, f) => n + f.size, 0);
  const dir = key.name.includes("/") ? key.name.split("/").slice(0, -1).join("/") : "";

  function doRollback() {
    rollback.mutate({ key, old: it, head: current }, { onSuccess: () => navigate(keyHref(key), { replace: true }) });
  }
  function doDelete() {
    del.mutate(key, { onSuccess: () => navigate("/skills") });
  }
  function doRemove(path: string) {
    removeFile.mutate({ key, parent: current.version, keep: it.files.filter((f) => f.path !== path), write: [] }, { onSuccess: () => setRemoving(null) });
  }
  const busy = rollback.isPending || del.isPending || removeFile.isPending;
  const actionError = rollback.error?.message ?? del.error?.message ?? removeFile.error?.message;
  const editing = editPath !== undefined || adding;

  const rows: [string, React.ReactNode][] = [
    ["Scope", <span className={it.scope === "org" ? "badge badge--admin" : "badge"}>{it.scope}</span>],
    ["Agent", <span className="badge badge--agent">{it.agent}</span>],
    ...(it.project ? ([["Project", <span className="mono">{it.project}</span>]] as [string, React.ReactNode][]) : []),
    ["Name", <span className="mono">{it.name}</span>],
    ["Version", <span className="mono">v{it.version}{it.parent ? ` (from v${it.parent})` : ""}</span>],
    ["Author", it.author],
    ["Host", <span className="mono">{it.host}</span>],
    ["Files", `${it.files.length} · ${fmtBytes(total)}`],
    ["Published", fmtTime(it.created)],
  ];

  return (
    <section>
      <p className={s.crumb}>
        <Link to="/skills">← Skills</Link> <span>/ {key.scope} / {key.agent}{dir && ` / ${dir}`}</span>
      </p>
      <PageHeader
        title={unitLabel(key.name)}
        subtitle={description}
        actions={
          confirm === "delete" ? (
            <span className={s.confirm}>
              Delete all {current.version} version{current.version === 1 ? "" : "s"}?
              <button type="button" className="btn btn--sm btn--danger" onClick={doDelete} disabled={busy}>
                {del.isPending ? "Deleting…" : "Confirm"}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </span>
          ) : confirm === "rollback" ? (
            <span className={s.confirm}>
              Republish v{it.version} as v{current.version + 1}?
              <button type="button" className="btn btn--sm btn--primary" onClick={doRollback} disabled={busy}>
                {rollback.isPending ? "Publishing…" : "Confirm"}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </span>
          ) : canWrite ? (
            <>
              {!isHead && (
                <button type="button" className="btn btn--sm btn--primary" onClick={() => setConfirm("rollback")} disabled={busy}>
                  Roll back to v{it.version}
                </button>
              )}
              <button type="button" className="btn btn--sm btn--danger" onClick={() => setConfirm("delete")} disabled={busy}>
                Delete
              </button>
            </>
          ) : undefined
        }
      />
      {actionError && (
        <p className={s.error} role="alert">
          {actionError}
        </p>
      )}
      {!isHead && !diffTo && (
        <p className={s.notice}>
          Viewing v{it.version}; the current version is <Link to={keyHref(key)}>v{current.version}</Link>.
        </p>
      )}

      <div className={s.grid}>
        <div>
          {editing && !canWrite ? (
            <p className={s.notice} role="alert">
              Org skills are published by admins. <Link to={keyHref(key)}>Back to the skill</Link>, or run{" "}
              <code>stift skills install {key.name}</code> for a copy of your own to edit.
            </p>
          ) : editing ? (
            <SkillEditor key={editPath ?? "+"} skillKey={key} from={it} head={current} path={adding ? undefined : editPath} />
          ) : diffTo ? (
            <DiffView key={diffTo} skillKey={key} to={diffTo} />
          ) : (
            <>
              {md && (
                <>
                  <p className={s.plateHead}>
                    <span>
                      {md.path} · {fmtBytes(md.size)}
                    </span>
                    <span className={s.toggle} role="group" aria-label="View">
                      {canWrite && <Link to={keyHref(key, { v: wanted || undefined, edit: md.path })}>edit</Link>}
                      <button type="button" className={raw ? "" : s.on} aria-pressed={!raw} onClick={() => setRaw(false)}>rendered</button>
                      <button type="button" className={raw ? s.on : ""} aria-pressed={raw} onClick={() => setRaw(true)}>raw</button>
                    </span>
                  </p>
                  <Plate sha={md.sha256} raw={raw} />
                </>
              )}
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th className="num">Size</th>
                      <th className="num">Mode</th>
                      <th className="num">
                        {canWrite && <Link to={keyHref(key, { v: wanted || undefined, add: true })}>+ add file</Link>}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {it.files.map((f) => (
                      <tr key={f.path}>
                        <td className="mono">{f.path}</td>
                        <td className="num mono dim">{fmtBytes(f.size)}</td>
                        <td className="num mono dim">{modeString(f.mode)}</td>
                        <td className="num">
                          {!canWrite ? null : removing === f.path ? (
                            <span className={s.rowActions}>
                              remove in v{current.version + 1}?
                              <button type="button" onClick={() => doRemove(f.path)} disabled={busy}>
                                {removeFile.isPending ? "saving…" : "confirm"}
                              </button>
                              <button type="button" onClick={() => setRemoving(null)}>cancel</button>
                            </span>
                          ) : (
                            <span className={s.rowActions}>
                              {isEditable(f.path) && <Link to={keyHref(key, { v: wanted || undefined, edit: f.path })}>edit</Link>}
                              {it.files.length > 1 && (
                                <button type="button" onClick={() => setRemoving(f.path)} disabled={busy}>
                                  remove
                                </button>
                              )}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <aside className={s.side}>
          <div className="card">
            <span className="card-eyebrow">Bundle</span>
            <dl className={s.kv}>
              {rows.map(([k, v]) => (
                <div key={k} className={s.row}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          {key.scope === "org" && <Pulls skillKey={key} head={current.version} />}
          <div className="card">
            <span className="card-eyebrow">History</span>
            {history.isPending && <Spinner label="Loading history…" />}
            {history.isError && <p className={s.error}>{history.error.message}</p>}
            {history.data && (
              <ol className={s.history} aria-label="Versions">
                {auditTimeline(history.data).map(({ version: v, added, changed, removed, paths }) => (
                  <li key={v.version} className={s.version}>
                    <Link to={keyHref(key, { v: v.version === current.version ? undefined : v.version })} className={`mono ${v.version === it.version && !diffTo ? s.current : ""}`}>
                      v{v.version}
                    </Link>
                    <span className={s.who}>
                      {v.author} <span className="dim">from</span> <span className="mono">{v.host}</span>
                    </span>
                    <time className={s.when} dateTime={v.created} title={fmtTime(v.created)}>
                      {ago(v.created)}
                    </time>
                    <span className={s.delta} title={paths.join("\n")} aria-label={`${added} added, ${changed} changed, ${removed} removed`}>
                      {added > 0 && <span className={s.add}>+{added}</span>}
                      {changed > 0 && <span className={s.mod}>~{changed}</span>}
                      {removed > 0 && <span className={s.del}>−{removed}</span>}
                      {added + changed + removed === 0 && <span className="dim">no file changes</span>}
                      {v.version > 1 && <Link to={keyHref(key, { v: wanted || undefined, diff: v.version })}>diff</Link>}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

/** Who has this org unit on a machine, from what the CLI reported on
 *  install and on org-scope pulls. A user on several hosts counts at their
 *  newest version. Reporting only: no report means unknown. */
function Pulls({ skillKey, head }: { skillKey: SkillKey; head: number }) {
  const installs = useInstalls({ agent: skillKey.agent, name: skillKey.name });
  const members = useMembers();
  if (!installs.data) return null;
  const byUser = new Map<string, { name: string; version: number; host: string; from: string }>();
  for (const i of installs.data) {
    const seen = byUser.get(i.user.id);
    if (!seen || i.version > seen.version) byUser.set(i.user.id, { name: i.user.name, version: i.version, host: i.host, from: i.from });
  }
  const users = [...byUser.values()].sort((a, b) => b.version - a.version || a.name.localeCompare(b.name));
  const current = users.filter((u) => u.version >= head).length;
  const behind = users.length - current;
  return (
    <div className="card" role="region" aria-label="Pulls">
      <span className="card-eyebrow">Pulls</span>
      {users.length === 0 ? (
        <p className={s.pullsNote}>
          No pulls reported yet. Members get it with <code>stift pull --skills --scope org</code> or <code>stift skills install {skillKey.name}</code>.
        </p>
      ) : (
        <>
          <p className={s.pullsHead}>
            {current} of {members.data?.length ?? users.length} member{(members.data?.length ?? users.length) === 1 ? "" : "s"} on v{head}
            {behind > 0 && <span className={s.mod}> · {behind} behind</span>}
          </p>
          <ul className={s.pulls}>
            {users.map((u) => (
              <li key={u.name}>
                <span>{u.name}</span>
                <span className={`mono ${u.version >= head ? "" : s.mod}`}>v{u.version}</span>
                <span className="dim">
                  on <span className="mono">{u.host}</span> ({u.from})
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Plate({ sha, raw }: { sha: string; raw: boolean }) {
  const text = useBlobText(sha);
  if (text.isPending) return <Spinner label="Loading file…" />;
  if (text.isError) return <p className={s.error}>{text.error.message}</p>;
  if (raw || isBinary(text.data)) return <pre className={s.plate}>{isBinary(text.data) ? "(binary file)" : text.data}</pre>;
  const { frontMatter, body } = splitFrontMatter(text.data);
  const fm = frontMatter
    ? frontMatter
        .split("\n")
        .map((l) => /^([\w-]+):\s*(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
    : [];
  return (
    <div className={s.rendered} data-testid="rendered">
      {fm.length > 0 && (
        <dl className={s.fm}>
          {fm.map(([, k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className={s.prose}>{renderMarkdown(body)}</div>
    </div>
  );
}

/** Changes from v(to-1) to v(to): manifest diff, plus line diffs for text files. */
function DiffView({ skillKey, to }: { skillKey: SkillKey; to: number }) {
  const before = useBundle(skillKey, to - 1);
  const after = useBundle(skillKey, to);
  if (before.isPending || after.isPending) return <Spinner label="Loading versions…" />;
  if (before.isError || after.isError) return <ErrorState error={before.error ?? after.error!} />;
  const changes = diffManifests(before.data, after.data);
  return (
    <div>
      <p className={s.plateHead}>
        <span>
          v{to - 1} → v{to} · {changes.length} file{changes.length === 1 ? "" : "s"} changed
        </span>
        <Link to={keyHref(skillKey, { v: to })}>view v{to}</Link>
      </p>
      {changes.length === 0 && <p className={s.notice}>Identical file contents.</p>}
      {changes.map((c) => (
        <FileDiff key={c.path} change={c} />
      ))}
    </div>
  );
}

function FileDiff({ change: c }: { change: FileChange }) {
  const textual = (c.before?.size ?? 0) <= MAX_TEXT_DIFF && (c.after?.size ?? 0) <= MAX_TEXT_DIFF;
  const shas = textual ? [c.before?.sha256, c.after?.sha256].filter((x): x is string => !!x) : [];
  const blobs = useQueries({
    queries: shas.map((sha) => ({ queryKey: ["blobs", sha], queryFn: () => fetchBlobText(sha), staleTime: Infinity })),
  });
  const bySha = new Map(shas.map((sha, i) => [sha, blobs[i]]));
  const b = c.before ? bySha.get(c.before.sha256) : undefined;
  const a = c.after ? bySha.get(c.after.sha256) : undefined;
  const loading = blobs.some((q) => q.isPending);
  const failed = blobs.find((q) => q.isError)?.error;

  let body: React.ReactNode;
  if (c.kind === "mode") body = <p className={s.notice}>Mode changed: {modeString(c.before!.mode)} → {modeString(c.after!.mode)}.</p>;
  else if (!textual) body = <p className={s.notice}>Too large to diff ({fmtBytes(c.before?.size ?? 0)} → {fmtBytes(c.after?.size ?? 0)}).</p>;
  else if (loading) body = <Spinner label="Loading file…" />;
  else if (failed) body = <p className={s.error}>{(failed as Error).message}</p>;
  else if ((b?.data && isBinary(b.data)) || (a?.data && isBinary(a.data))) body = <p className={s.notice}>Binary file.</p>;
  else {
    const lines = diffLines(b?.data ?? "", a?.data ?? "");
    body = (
      <pre className={s.diff} data-testid={`diff:${c.path}`}>
        {lines.map((l, i) => (
          <div key={i} className={s[l.kind]}>
            {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}
            {l.text}
          </div>
        ))}
      </pre>
    );
  }
  return (
    <div className={s.diffFile}>
      <p className={s.diffHead}>
        <span className="kind">{c.kind}</span>
        <span>{c.path}</span>
      </p>
      {body}
    </div>
  );
}
