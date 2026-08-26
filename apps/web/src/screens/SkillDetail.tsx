import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { Bundle } from "@stift/shared";
import { ApiError } from "../api/auth";
import { fetchBlobText, keyHref, type SkillKey, unitLabel, useBlobText, useBundle, useBundleHistory, useDeleteBundle, useRollback } from "../api/skills";
import { ErrorState, NotFound, PageHeader, Spinner } from "../components/States";
import { diffLines, diffManifests, type FileChange, isBinary, MAX_TEXT_DIFF } from "../lib/diff";
import { ago, fmtBytes, fmtTime } from "../lib/format";
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
  const navigate = useNavigate();

  const head = useBundle(key, 0);
  const shown = useBundle(key, wanted);
  const history = useBundleHistory(key);
  const rollback = useRollback();
  const del = useDeleteBundle();
  const [confirm, setConfirm] = useState<"delete" | "rollback" | null>(null);
  useEffect(() => setConfirm(null), [wanted, diffTo]);

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
  const busy = rollback.isPending || del.isPending;
  const actionError = rollback.error?.message ?? del.error?.message;

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
          ) : (
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
          )
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
          {diffTo ? (
            <DiffView key={diffTo} skillKey={key} to={diffTo} />
          ) : (
            <>
              {md && (
                <>
                  <p className={s.plateHead}>
                    <span>
                      {md.path} · {fmtBytes(md.size)}
                    </span>
                    <span>v{it.version}</span>
                  </p>
                  <Plate sha={md.sha256} />
                </>
              )}
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th className="num">Size</th>
                      <th className="num">Mode</th>
                    </tr>
                  </thead>
                  <tbody>
                    {it.files.map((f) => (
                      <tr key={f.path}>
                        <td className="mono">{f.path}</td>
                        <td className="num mono dim">{fmtBytes(f.size)}</td>
                        <td className="num mono dim">{modeString(f.mode)}</td>
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
          <div className="card">
            <span className="card-eyebrow">History</span>
            {history.isPending && <Spinner label="Loading history…" />}
            {history.isError && <p className={s.error}>{history.error.message}</p>}
            {history.data && (
              <ol className={s.history} aria-label="Versions">
                {history.data.map((v: Bundle) => (
                  <li key={v.version} className={s.version}>
                    <Link to={keyHref(key, { v: v.version === current.version ? undefined : v.version })} className={`mono ${v.version === it.version && !diffTo ? s.current : ""}`}>
                      v{v.version}
                    </Link>
                    <span className="meta" title={fmtTime(v.created)}>
                      {v.author} · {ago(v.created)}
                    </span>
                    <span className="links">
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

function Plate({ sha }: { sha: string }) {
  const text = useBlobText(sha);
  if (text.isPending) return <Spinner label="Loading file…" />;
  if (text.isError) return <p className={s.error}>{text.error.message}</p>;
  return <pre className={s.plate}>{isBinary(text.data) ? "(binary file)" : text.data}</pre>;
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
