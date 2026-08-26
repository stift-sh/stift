import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Bundle } from "@stift/shared";
import { cleanFilter, keyHref, keyOf, type SkillFilter, unitLabel, useBundles } from "../api/skills";
import { EmptyState, ErrorState, PageHeader, Spinner } from "../components/States";
import { ago, fmtTime } from "../lib/format";
import s from "./Skills.module.css";

const SCOPES = [
  ["All", ""],
  ["Org", "org"],
  ["User", "user"],
  ["Project", "project"],
] as const;

function readFilter(params: URLSearchParams): SkillFilter {
  const f: SkillFilter = {};
  for (const k of ["scope", "agent", "q"] as const) {
    const v = params.get(k);
    if (v) f[k] = v;
  }
  return f;
}

function matches(b: Bundle, q: string): boolean {
  const hay = [b.name, b.agent, b.project ?? "", b.author, ...b.skills.map((k) => `${k.name} ${k.description}`)];
  return hay.some((h) => h.toLowerCase().includes(q));
}

export function Skills() {
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => readFilter(params), [params]);
  const bundles = useBundles(filter);
  const filtered = Object.keys(cleanFilter(filter)).length > 0;

  function update(patch: SkillFilter) {
    setParams(cleanFilter({ ...filter, ...patch }) as Record<string, string>, { replace: true });
  }
  const clear = () => setParams({}, { replace: true });

  const [q, setQ] = useState(filter.q ?? "");
  useEffect(() => setQ(filter.q ?? ""), [filter.q]);
  useEffect(() => {
    if (q === (filter.q ?? "")) return;
    const t = setTimeout(() => update({ q }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const all = bundles.data ?? [];
  const needle = (filter.q ?? "").trim().toLowerCase();
  const items = needle ? all.filter((b) => matches(b, needle)) : all;
  // Scope counts come from an unscoped view of the current agent filter;
  // with a scope selected the other counts are unknown, so show only the active one.
  const agents = useMemo(() => {
    const set = new Set(all.map((b) => b.agent));
    if (filter.agent) set.add(filter.agent);
    return [...set].sort();
  }, [all, filter.agent]);

  return (
    <section>
      <PageHeader
        title="Skills"
        subtitle="Skills, agents, commands and instruction files synced to this server, by scope."
        actions={
          <Link to="/skills/new" className="btn btn--sm btn--primary">
            New skill
          </Link>
        }
      />
      <div className={s.filters} role="search">
        <div className={s.rail} role="tablist" aria-label="Scope">
          {SCOPES.map(([label, key]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={(filter.scope ?? "") === key}
              className={s.tab}
              onClick={() => update({ scope: key })}
            >
              {label}
              {(filter.scope ?? "") === key && bundles.data && <span className={s.count}>{items.length}</span>}
            </button>
          ))}
        </div>
        <select className={`input ${s.select}`} aria-label="Agent" value={filter.agent ?? ""} onChange={(e) => update({ agent: e.target.value })}>
          <option value="">Any agent</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input
          className="input input--search"
          type="search"
          aria-label="Search"
          placeholder="Filter by name, agent, project, author…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {filtered && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={clear}>
            Clear filters
          </button>
        )}
      </div>

      {bundles.isPending && <Spinner />}
      {bundles.isError && <ErrorState error={bundles.error} onRetry={() => bundles.refetch()} />}
      {bundles.data && items.length === 0 && (filtered ? <NothingMatches onClear={clear} /> : <NoSkills />)}
      {bundles.data && items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Scope</th>
                <th>Agent</th>
                <th>Project</th>
                <th className="num">Version</th>
                <th>Author</th>
                <th className="num">Updated</th>
              </tr>
            </thead>
            <tbody>
              {items.map((b) => {
                const desc = b.skills[0]?.description;
                return (
                  <tr key={`${b.scope}|${b.agent}|${b.project ?? ""}|${b.name}`}>
                    <td>
                      <Link to={keyHref(keyOf(b))} title={b.name}>
                        {unitLabel(b.name)}
                      </Link>
                      {desc && <div className={s.desc}>{desc}</div>}
                    </td>
                    <td>
                      <span className={b.scope === "org" ? "badge badge--admin" : "badge"}>{b.scope}</span>
                    </td>
                    <td>
                      <span className="badge badge--agent">{b.agent}</span>
                    </td>
                    <td className="mono dim ellipsis" title={b.project}>
                      {b.project || "–"}
                    </td>
                    <td className="num mono">v{b.version}</td>
                    <td className="dim">{b.author}</td>
                    <td className="num dim" title={fmtTime(b.created)}>
                      {ago(b.created)}
                    </td>
                  </tr>
                );
              })}
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
      <p>No skills match the current filters.</p>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onClear}>
        Clear filters
      </button>
    </EmptyState>
  );
}

function NoSkills() {
  return (
    <EmptyState title="No skills yet">
      <p>
        <Link to="/skills/new">Create one in the browser</Link>, or push your agent configuration from the CLI and it shows up here, versioned:
      </p>
      <pre className={s.snippet}>
        <code>stift push --skills --scope user</code>
      </pre>
      <p className="dim">
        Org skills are pushed by admins with <code className="inline-code">--scope org</code> and pulled by every member with{" "}
        <code className="inline-code">stift pull --skills</code>. See <Link to="/start">Get started</Link>.
      </p>
    </EmptyState>
  );
}
