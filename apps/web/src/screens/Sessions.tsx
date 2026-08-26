import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Session } from "@stift/shared";
import { cleanFilter, type SessionFilter, useSessions } from "../api/sessions";
import { EmptyState, ErrorState, PageHeader, Spinner } from "../components/States";
import { ago, fmtBytes, fmtTime } from "../lib/format";
import s from "./Sessions.module.css";

const KEYS = ["agent", "project", "host", "q"] as const;

function readFilter(params: URLSearchParams): SessionFilter {
  const f: SessionFilter = {};
  for (const k of KEYS) {
    const v = params.get(k);
    if (v) f[k] = v;
  }
  return f;
}

function distinct(items: Session[], key: "agent" | "project" | "host", current?: string): string[] {
  const set = new Set(items.map((i) => i[key]).filter((v): v is string => !!v));
  if (current) set.add(current);
  return [...set].sort();
}

export function Sessions() {
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => readFilter(params), [params]);
  const sessions = useSessions(filter);
  const filtered = Object.keys(cleanFilter(filter)).length > 0;

  function update(patch: SessionFilter) {
    const next = cleanFilter({ ...filter, ...patch });
    setParams(next as Record<string, string>, { replace: true });
  }

  // Debounced free-text search; selects apply immediately.
  const [q, setQ] = useState(filter.q ?? "");
  useEffect(() => setQ(filter.q ?? ""), [filter.q]);
  useEffect(() => {
    if (q === (filter.q ?? "")) return;
    const t = setTimeout(() => update({ q }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const items = sessions.data ?? [];

  return (
    <section>
      <PageHeader title="Sessions" subtitle="Coding-agent sessions synced to this server." />
      <div className={s.filters} role="search">
        <input
          className="input input--search"
          type="search"
          aria-label="Search"
          placeholder="Search title, project, session id…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {(["agent", "project", "host"] as const).map((k) => (
          <select
            key={k}
            className={`input ${s.select}`}
            aria-label={k[0].toUpperCase() + k.slice(1)}
            value={filter[k] ?? ""}
            onChange={(e) => update({ [k]: e.target.value })}
          >
            <option value="">Any {k}</option>
            {distinct(items, k, filter[k]).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        ))}
        {filtered && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setParams({}, { replace: true })}>
            Clear filters
          </button>
        )}
      </div>

      {sessions.isPending && <Spinner />}
      {sessions.isError && <ErrorState error={sessions.error} onRetry={() => sessions.refetch()} />}
      {sessions.data && items.length === 0 && (filtered ? <NothingMatches onClear={() => setParams({}, { replace: true })} /> : <NoSessions />)}
      {sessions.data && items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Host</th>
                <th>Project</th>
                <th>Title</th>
                <th className="num">Size</th>
                <th className="num">Updated</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td>
                    <span className="badge badge--agent">{it.agent}</span>
                  </td>
                  <td className="mono dim">{it.host}</td>
                  <td className="mono">{it.project}</td>
                  <td className="ellipsis" title={it.title || it.key}>
                    <Link to={`/sessions/${it.id}`}>{it.title || it.key}</Link>
                  </td>
                  <td className="num mono dim">{fmtBytes(it.size)}</td>
                  <td className="num dim" title={fmtTime(it.updated_at)}>
                    {ago(it.updated_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function NothingMatches({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState title="Nothing matches">
      <p>No sessions match the current filters.</p>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onClear}>
        Clear filters
      </button>
    </EmptyState>
  );
}

function NoSessions() {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-server";
  return (
    <EmptyState title="No sessions yet">
      <p>Once you push from a coding agent, sessions show up here. Connect the CLI to this server:</p>
      <pre className={s.snippet}>
        <code>
          stift login {origin} --token &lt;token&gt;{"\n"}stift push
        </code>
      </pre>
      <p className="dim">
        Need a token? Create one on the <Link to="/tokens">Tokens</Link> page, or see{" "}
        <Link to="/start">Get started</Link>.
      </p>
    </EmptyState>
  );
}
