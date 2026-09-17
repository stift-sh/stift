import { useOrg } from "../api/org";
import { fmtBytes } from "../lib/format";
import s from "./OrgCard.module.css";

const count = (n: number) => n.toLocaleString("en-US");

/** The caller's org: what it uses of its limits (null = unlimited). */
export function OrgCard() {
  const org = useOrg();
  // Servers older than GET /v1/org: the card is an extra, not worth an error.
  if (!org.data) return null;
  const { limits, usage } = org.data;
  const lines: [string, number, number | null, (n: number) => string][] = [
    ["Skills", usage.skills, limits.skills, count],
    ["Storage", usage.storage_bytes, limits.storage_bytes, fmtBytes],
    ["Seats", usage.seats, limits.seats, count],
  ];
  return (
    <div className={`card ${s.card}`} role="region" aria-label="Organization">
      <span className="card-eyebrow">Organization</span>
      <p className={s.name}>{org.data.name}</p>
      <dl className={s.usage}>
        {lines.map(([label, used, limit, fmt]) => (
          <div key={label} className={s.line}>
            <dt>{label}</dt>
            <dd className={limit !== null && used >= limit ? s.full : undefined}>
              {fmt(used)} {limit === null ? <span className="dim">· unlimited</span> : <>/ {fmt(limit)}</>}
            </dd>
            {limit !== null && <meter className={s.meter} min={0} max={Math.max(limit, 1)} value={Math.min(used, limit)} aria-label={`${label} used`} />}
          </div>
        ))}
      </dl>
    </div>
  );
}
