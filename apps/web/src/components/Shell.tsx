import { NavLink, Outlet } from "react-router";
import { ApiError, useAuth, useIdentity, useLogout } from "../api/auth";
import { getToken } from "../api/client";
import { useServerVersion } from "../api/version";
import { Logo } from "./Logo";
import { EmptyState } from "./States";
import s from "./Shell.module.css";

type NavItem = { to: string; label: string; admin?: boolean; feature?: string };

const NAV: NavItem[] = [
  { to: "/sessions", label: "Sessions" },
  { to: "/skills", label: "Skills" },
  { to: "/tokens", label: "Tokens" },
  { to: "/members", label: "Members", admin: true },
  { to: "/billing", label: "Billing", feature: "cloud" },
  { to: "/start", label: "Get started" },
];

/** The frame every authenticated screen renders inside. */
export function Shell() {
  const me = useIdentity();
  const version = useServerVersion();
  const logout = useLogout();
  const { provider } = useAuth();
  // The provider's session, not a pasted token, is what it can switch.
  const OrgSwitcher = getToken() ? null : (provider?.OrgSwitcher ?? null);
  // Signed in to the provider but refused by the server: no org is active.
  const noOrg = OrgSwitcher && me.error instanceof ApiError && me.error.status === 401 ? me.error : null;
  const features = version.data?.features ?? [];
  const cloud = features.includes("cloud");
  const nav = NAV.filter((i) => (!i.admin || me.data?.role === "admin") && (!i.feature || features.includes(i.feature)));

  return (
    <div className={s.app}>
      <header className={s.topbar}>
        <NavLink to="/sessions" className={s.brand} aria-label="stift">
          <Logo />
          <span>
            stift{cloud && <span className={s.brandSuffix}>cloud</span>}
          </span>
        </NavLink>
        <nav className={s.nav} aria-label="Main">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? `${s.navLink} ${s.navLinkActive}` : s.navLink)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className={s.right}>
          {OrgSwitcher && !noOrg && <OrgSwitcher />}
          {me.data && (
            <span className={s.identity}>
              <span className={s.name}>{me.data.user?.name ?? me.data.name}</span>
              {me.data.org && <> · {me.data.org.name}</>}
              <> · {me.data?.role}</>
            </span>
          )}
          <button type="button" className="btn btn--sm btn--ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <main className={s.main}>
        {noOrg && OrgSwitcher ? (
          <EmptyState title="Pick an organization">
            <p>Sessions and skills belong to an organization ({noOrg.message}). Select or create one to continue.</p>
            <OrgSwitcher />
          </EmptyState>
        ) : (
          <Outlet />
        )}
      </main>
    </div>
  );
}
