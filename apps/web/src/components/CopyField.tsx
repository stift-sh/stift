import { useState } from "react";
import s from "./CopyField.module.css";

/** A command or secret on a dark plate with a copy button. `prompt` is
 *  shown but not copied. */
export function CopyField({ value, prompt, label }: { value: string; prompt?: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable (insecure context); the text is still selectable.
    }
  }

  return (
    <div className={s.field}>
      {label && <span className={s.label}>{label}</span>}
      <div className={s.row}>
        <code className={s.code}>
          {prompt && <span className={s.prompt}>{prompt} </span>}
          {value}
        </code>
        <button type="button" className={s.btn} onClick={copy} aria-label={`Copy ${label ?? "to clipboard"}`}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
