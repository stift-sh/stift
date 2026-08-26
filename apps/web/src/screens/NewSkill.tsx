// Create a unit from the browser: scope, agent, name and a first SKILL.md.
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useIdentity } from "../api/auth";
import { keyHref, usePublish } from "../api/skills";
import { PageHeader } from "../components/States";
import s from "./SkillDetail.module.css";

const AGENTS = ["claude", "cursor", "codex", "gemini", "copilot"];
const slug = /^[a-z0-9][a-z0-9._-]*$/i;

export function NewSkill() {
  const navigate = useNavigate();
  const me = useIdentity();
  const [scope, setScope] = useState<"user" | "org">("user");
  const [agent, setAgent] = useState("claude");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);
  const save = usePublish();

  const unit = `skills/${name.trim()}`;
  const validName = slug.test(name.trim());
  const body = text || `---\nname: ${name.trim() || "my-skill"}\ndescription: \n---\n# ${name.trim() || "My skill"}\n`;
  const canSave = validName && slug.test(agent) && !save.isPending;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!canSave) return;
    const key = { scope, agent, name: unit };
    save.mutate({ key, parent: 0, keep: [], write: [{ path: "SKILL.md", text: body }] }, { onSuccess: () => navigate(keyHref(key)) });
  }

  return (
    <section>
      <p className={s.crumb}>
        <Link to="/skills">← Skills</Link>
      </p>
      <PageHeader title="New skill" subtitle="Publishes v1 with a SKILL.md; add more files from the skill page." />
      <form className={s.editor} onSubmit={submit}>
        <div className={s.fields}>
          <label className="field">
            <span className="field-label">Scope</span>
            <select className="input" value={scope} onChange={(e) => setScope(e.target.value as "user" | "org")}>
              <option value="user">user</option>
              {me.data?.admin && <option value="org">org</option>}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Agent</span>
            <input className="input mono" list="agents" value={agent} onChange={(e) => setAgent(e.target.value)} />
            <datalist id="agents">
              {AGENTS.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span className="field-label">Name</span>
            <span className={s.prefixed}>
              <span className="mono dim">skills/</span>
              <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="deploy-checklist" autoFocus />
            </span>
            {touched && !validName && <span className={s.error}>Letters, digits, dots, dashes and underscores.</span>}
          </label>
        </div>
        <p className={s.plateHead}>
          <span>SKILL.md</span>
          <span>v1</span>
        </p>
        <textarea className={s.textarea} aria-label="SKILL.md source" spellCheck={false} value={text || body} onChange={(e) => setText(e.target.value)} rows={16} />
        {save.isError && <p className={s.error}>{save.error.message}</p>}
        <div className={s.editorBar}>
          <span className={s.editorNote}>Same as <code>stift push --skills</code> from a machine; syncing machines pull it next.</span>
          <span className="page-actions">
            <Link to="/skills" className="btn btn--sm btn--ghost">
              Cancel
            </Link>
            <button type="submit" className="btn btn--sm btn--primary" disabled={!canSave}>
              {save.isPending ? "Publishing…" : "Publish v1"}
            </button>
          </span>
        </div>
      </form>
    </section>
  );
}
