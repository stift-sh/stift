import { useIdentity } from "../api/auth";
import { useBillingRedirect, useBillingStatus } from "../api/billing";
import { useServerVersion } from "../api/version";
import { OrgCard } from "../components/OrgCard";
import { ErrorState, NotFound, PageHeader, Spinner } from "../components/States";
import { fmtDate } from "../lib/format";
import s from "./Billing.module.css";

const PLAN = { free: "Free", pro: "Pro" } as const;

/** Cloud only: the org's plan and seats from the billing service, usage
 *  from the server itself. Admins go to Stripe to change either. */
export function Billing() {
  const version = useServerVersion();
  const me = useIdentity();
  const status = useBillingStatus();
  const checkout = useBillingRedirect("checkout");
  const portal = useBillingRedirect("portal");

  if (version.isPending) return <Spinner />;
  if (!version.data?.features.includes("cloud") || !version.data.cloud_api_url) return <NotFound />;
  const admin = me.data?.role === "admin";
  const go = status.data?.plan === "pro" ? portal : checkout;

  return (
    <>
      <PageHeader title="Billing" subtitle="Your organization's plan, seats and usage." />
      {status.isPending ? (
        <Spinner />
      ) : status.isError ? (
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <div className={`card ${s.card}`} role="region" aria-label="Plan">
          <span className="card-eyebrow">Plan</span>
          <p className={s.plan}>{PLAN[status.data.plan]}</p>
          <p className="dim">
            {status.data.seats.toLocaleString("en-US")} {status.data.seats === 1 ? "seat" : "seats"}
            {status.data.status && <> · {status.data.status.replace(/_/g, " ")}</>}
            {status.data.current_period_end && <> · renews {fmtDate(status.data.current_period_end)}</>}
          </p>
          {admin ? (
            <button type="button" className="btn btn--primary" onClick={() => go.mutate()} disabled={go.isPending}>
              {status.data.plan === "pro" ? "Manage subscription" : "Upgrade to Pro"}
            </button>
          ) : (
            <p className="dim">Ask an admin to change the plan.</p>
          )}
          {go.isError && (
            <p className={s.error} role="alert">
              {go.error.message}
            </p>
          )}
        </div>
      )}
      <OrgCard />
    </>
  );
}
