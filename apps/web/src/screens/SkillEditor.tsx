// Browser editing of one bundle file (item 2 of the skills registry plan).
// Save is the same PUT the CLI does: upload the blob, write the manifest
// with `parent = head`. A 409 means someone published since the page was
// opened; the user can reload (discarding the edit) or overwrite (force).
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Bundle } from "@stift/shared";
import { ApiError } from "../api/auth";
import { isEditable, keyHref, type SkillKey, useBlobText, usePublish } from "../api/skills";
import { ErrorState, Spinner } from "../components/States";
import { ago } from "../lib/format";
import s from "./SkillDetail.module.css";

const cleanPath = (p: string) => p.trim().replace(/^\.?\/+/, "").replace(/\/+/g, "/");
const validPath = (p: string) => !!p && !p.split("/").some((seg) => !seg || seg === "." || seg === "..");

type Props = {
  skillKey: SkillKey;
  /** The version whose file is being edited (its files are kept). */
  from: Bundle;
  head: Bundle;
  /** Existing file path, or undefined to add a new file. */
  path?: string;
};

export function SkillEditor({ skillKey, from, head, path }: Props) {
  const existing = path ? from.files.find((f) => f.path === path) : undefined;
  if (path && !existing) return <ErrorState error={new Error(`no file "${path}" in v${from.version}`)} />;
  if (existing && !isEditable(existing.path)) return <ErrorState error={new Error("only *.md files can be edited here; use stift push for other files")} />;
  return <Form skillKey={skillKey} from={from} head={head} existing={existing?.path} sha={existing?.sha256} />;
}

function Form({ skillKey, from, head, existing, sha }: { skillKey: SkillKey; from: Bundle; head: Bundle; existing?: string; sha?: string }) {
  const navigate = useNavigate();
  const blob = useBlobText(sha);
  const [text, setText] = useState<string | null>(existing ? null : "");
  const [newPath, setNewPath] = useState("");
  const [parent, setParent] = useState(head.version);
  const [force, setForce] = useState(false);
  const save = usePublish();
  useEffect(() => {
    if (existing && blob.data !== undefined && text === null) setText(blob.data);
  }, [existing, blob.data, text]);

  if (existing && blob.isPending) return <Spinner label="Loading file…" />;
  if (existing && blob.isError) return <ErrorState error={blob.error} onRetry={() => void blob.refetch()} />;

  const path = existing ?? cleanPath(newPath);
  const taken = !existing && from.files.some((f) => f.path === path);
  const dirty = existing ? text !== blob.data : !!path || !!text;
  const stale = save.error instanceof ApiError && save.error.status === 409;
  const canSave = dirty && validPath(path) && !taken && (existing || isEditable(path)) && !save.isPending;
  const back = keyHref(skillKey);

  function doSave() {
    save.mutate(
      { key: skillKey, parent, keep: from.files, write: [{ path, text: text ?? "" }], force },
      { onSuccess: () => navigate(back) },
    );
  }

  return (
    <form
      className={s.editor}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) doSave();
      }}
    >
      <p className={s.plateHead}>
        <span>{existing ? `${existing} · editing from v${from.version}` : "new file"}</span>
        <span>saves as v{head.version + 1}</span>
      </p>
      {!existing && (
        <label className="field">
          <span className="field-label">Path</span>
          <input className="input mono" value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="reference/notes.md" autoFocus />
          {newPath && !validPath(path) && <span className={s.error}>Relative path without “..”.</span>}
          {newPath && validPath(path) && !isEditable(path) && <span className={s.error}>Only *.md files can be added here.</span>}
          {taken && <span className={s.error}>A file with that path already exists.</span>}
        </label>
      )}
      <textarea
        className={s.textarea}
        aria-label={existing ? `${existing} source` : "file contents"}
        spellCheck={false}
        value={text ?? ""}
        onChange={(e) => setText(e.target.value)}
        rows={Math.max(16, (text ?? "").split("\n").length + 2)}
      />
      {stale && (
        <div className={s.stale} role="alert">
          <p>
            Someone published <strong>v{head.version}</strong> since you opened this. Reload to see it (your edit is lost) or overwrite it with yours.
          </p>
          <span className={s.confirm}>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => navigate(0)}>
              Reload
            </button>
            <button
              type="button"
              className="btn btn--sm btn--danger"
              onClick={() => {
                setForce(true);
                setParent(head.version);
                save.mutate({ key: skillKey, parent: head.version, keep: from.files, write: [{ path, text: text ?? "" }], force: true }, { onSuccess: () => navigate(back) });
              }}
              disabled={save.isPending}
            >
              Overwrite
            </button>
          </span>
        </div>
      )}
      {save.isError && !stale && <p className={s.error}>{save.error.message}</p>}
      <div className={s.editorBar}>
        <span className={s.editorNote}>
          Only <code>*.md</code> files are editable here; other files change via <code>stift push --skills</code>. Machines syncing this scope pull the new version on their
          next sync. Last publish: {head.author} from <span className="mono">{head.host}</span> {ago(head.created)}.
        </span>
        <span className="page-actions">
          <Link to={back} className="btn btn--sm btn--ghost">
            Cancel
          </Link>
          <button type="submit" className="btn btn--sm btn--primary" disabled={!canSave}>
            {save.isPending ? "Saving…" : `Save as v${head.version + 1}`}
          </button>
        </span>
      </div>
    </form>
  );
}
