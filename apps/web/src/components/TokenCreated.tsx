import { CopyField } from "./CopyField";
import s from "./TokenCreated.module.css";

/** The "copy it now" card: a token secret is shown exactly once. */
export function TokenCreated({ token, name, title = "Token created", onDone }: { token: string; name: string; title?: string; onDone: () => void }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-server";
  return (
    <div className={`card ${s.card}`} role="region" aria-label={title}>
      <span className="card-eyebrow">{title}</span>
      <p className={s.warn}>
        <strong>Copy it now.</strong> This is the only time the secret is shown.
      </p>
      <CopyField value={token} label={name} />
      <p className="dim">Use it with the CLI:</p>
      <CopyField value={`stift login ${origin} --token ${token}`} prompt="$" label="login command" />
      <div className={s.actions}>
        <button type="button" className="btn btn--primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
