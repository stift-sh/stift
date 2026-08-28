import { Link } from "react-router";
import { useIdentity } from "../api/auth";
import { CopyField } from "../components/CopyField";
import { PageHeader } from "../components/States";
import s from "./GettingStarted.module.css";

const AGENTS: [string, string, string][] = [
  ["Claude Code", "claude", "~/.claude/projects/<project>/<session>.jsonl + todo state"],
  ["OpenAI Codex CLI", "codex", "~/.codex/sessions/…/rollout-*.jsonl"],
  ["Gemini CLI", "gemini", "~/.gemini/tmp/<project>/ (logs, saved chats, checkpoints)"],
  ["Cursor CLI", "cursor", "~/.cursor/chats/<project>/<session>/"],
  ["opencode", "opencode", "session + messages + parts from ~/.local/share/opencode/storage"],
  ["aider", "aider", ".aider.chat.history.md, .aider.input.history (in-project)"],
];

const UNITS: [string, string][] = [
  ["skills/<name>", "~/.claude/skills/<name>/ (SKILL.md and everything beside it)"],
  ["agents/<name>", "~/.claude/agents/<name>.md"],
  ["commands/<name>", "~/.claude/commands/<name>.md"],
  ["CLAUDE.md", "~/.claude/CLAUDE.md"],
];

export function GettingStarted() {
  const me = useIdentity();
  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-server";

  return (
    <section>
      <PageHeader title="Get started" subtitle="Install the CLI, point it at this server, and push." />
      <ol className={s.steps}>
        <Step n={1} title="Install the CLI">
          <p>Stift is one static binary. Install it with the one-liner or grab a release from GitHub:</p>
          <CopyField value="curl -fsSL https://stift.sh/install.sh | sh" prompt="$" />
        </Step>
        <Step n={2} title="Get a token">
          <p>
            Create one on the <Link to="/tokens">Tokens</Link> page. The secret is shown once, so copy it right away.
          </p>
        </Step>
        <Step n={3} title="Log in">
          <p>Point the CLI at this server with your token:</p>
          <CopyField value={`stift login ${origin} --token <token>`} prompt="$" />
        </Step>
        <Step n={4} title="Push">
          <p>
            Push the current project's sessions, or its skills. They show up on the <Link to="/sessions">Sessions</Link> and{" "}
            <Link to="/skills">Skills</Link> pages; <code className="inline-code">stift pull</code> restores them on another
            machine.
          </p>
          <CopyField value="stift push" prompt="$" />
          <CopyField value="stift push --skills" prompt="$" />
        </Step>
      </ol>

      <h2 className={s.h2}>What syncs</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Name</th>
              <th>Sessions</th>
            </tr>
          </thead>
          <tbody>
            {AGENTS.map(([agent, name, what]) => (
              <tr key={name}>
                <td>{agent}</td>
                <td>
                  <span className="badge badge--agent">{name}</span>
                </td>
                <td className="mono dim">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={s.note}>
        Skills are the files that configure an agent, synced as versioned units (Claude Code, user scope shown; project
        scope is the same under <code className="inline-code">.claude/</code>):
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Unit</th>
              <th>What it is</th>
            </tr>
          </thead>
          <tbody>
            {UNITS.map(([unit, what]) => (
              <tr key={unit}>
                <td className="mono">{unit}</td>
                <td className="mono dim">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className={`card ${s.step}`}>
      <div className={s.num}>{n}</div>
      <div className={s.body}>
        <h3 className={s.h3}>{title}</h3>
        {children}
      </div>
    </li>
  );
}
