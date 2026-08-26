import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError } from "../api/auth";
import { downloadArchive, useDeleteSession, useSession } from "../api/sessions";
import { ErrorState, NotFound, PageHeader, Spinner } from "../components/States";
import { fmtBytes, fmtTime } from "../lib/format";
import s from "./SessionDetail.module.css";

export function SessionDetail() {
  const { id = "" } = useParams();
  const session = useSession(id);
  const del = useDeleteSession();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  if (session.isPending) return <Spinner />;
  if (session.isError) {
    if (session.error instanceof ApiError && session.error.status === 404) return <NotFound />;
    return <ErrorState error={session.error} onRetry={() => session.refetch()} />;
  }
  const it = session.data;

  async function download() {
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadArchive(it.id);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : "download failed");
    } finally {
      setDownloading(false);
    }
  }

  function remove() {
    del.mutate(it.id, { onSuccess: () => navigate("/sessions") });
  }

  const rows: [string, React.ReactNode][] = [
    ["Agent", <span className="badge badge--agent">{it.agent}</span>],
    ["Host", <span className="mono">{it.host}</span>],
    ["Project", <span className="mono">{it.project || "–"}</span>],
    ["Repo", <span className="mono">{it.repo || "–"}</span>],
    ["Session id", <span className="mono">{it.session_id}</span>],
    ["Key", <span className="mono">{it.key}</span>],
    ["Base", it.base],
    ["Files", it.files],
    ["Size", fmtBytes(it.size)],
    ["SHA-256", <span className={`mono ${s.hash}`}>{it.sha256}</span>],
    ["Modified", fmtTime(it.mod_time)],
    ["Created", fmtTime(it.created_at)],
    ["Updated", fmtTime(it.updated_at)],
  ];

  return (
    <section>
      <p className={s.crumb}>
        <Link to="/sessions">← Sessions</Link>
      </p>
      <PageHeader
        title={it.title || it.key}
        subtitle={it.title ? it.key : undefined}
        actions={
          <>
            <button type="button" className="btn btn--sm btn--ghost" onClick={download} disabled={downloading}>
              {downloading ? "Downloading…" : "Download"}
            </button>
            {confirm ? (
              <span className={s.confirm}>
                Delete?
                <button type="button" className="btn btn--sm btn--danger" onClick={remove} disabled={del.isPending}>
                  {del.isPending ? "Deleting…" : "Confirm"}
                </button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="btn btn--sm btn--danger" onClick={() => setConfirm(true)}>
                Delete
              </button>
            )}
          </>
        }
      />
      {(downloadError || del.isError) && (
        <p className={s.error} role="alert">
          {downloadError ?? del.error?.message}
        </p>
      )}
      <div className="card">
        <dl className={s.kv}>
          {rows.map(([k, v]) => (
            <div key={k} className={s.row}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
