import { Link } from "react-router";
import { ApiError } from "../api/auth";
import { useServerVersion } from "../api/version";
import s from "./LimitNotice.module.css";

export const isLimit = (error: unknown): error is ApiError => error instanceof ApiError && error.status === 402;

/** A 402 from the server: the org is at one of its quotas. */
export function LimitNotice({ error }: { error: unknown }) {
  const cloud = useServerVersion().data?.features.includes("cloud");
  if (!isLimit(error)) return null;
  return (
    <div className={s.notice} role="alert">
      <strong>This org is at its limit.</strong> <span className="mono">{error.message}</span>
      <p>
        {cloud ? (
          <>
            Raise it on the <Link to="/billing">Billing</Link> page.
          </>
        ) : (
          <>
            An admin of this server can raise it with <code className="inline-code">STIFT_MAX_*</code>.
          </>
        )}
      </p>
    </div>
  );
}
