import { NavLink, Outlet } from "react-router";
import { useIdentity, useLogout } from "../api/auth";
import { useServerVersion } from "../api/version";
import { Logo } from "./Logo";
import s from "./Shell.module.css";

type NavItem = { to: string; label: string; admin?: boolean; feature?: string };

const NAV: NavItem[] = [
  { to: "/sessions", label: "Sessions" },
  { to: "/skills", label: "Skills" },
  { to: "/tokens", label: "Tokens", admin: true },
  { to: "/billing", label: "Billing", feature: "cloud" },
  { to: "/start", label: "Get started" },
];

/** The frame every authenticated screen renders inside. */
export function Shell() {
  const me = useIdentity();
  const version = useServerVersion();
  const logout = useLogout();
  const features = version.data?.features ?? [];
  const cloud = features.includes("cloud");
  const nav = NAV.filter((i) => (!i.admin || me.data?.admin) && (!i.feature || features.includes(i.feature)));

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
          {me.data && (
            <span className={s.identity}>
              <span className={s.name}>{me.data.name}</span>
              {me.data.admin && <> · admin</>}
            </span>
          )}
          <button type="button" className="btn btn--sm btn--ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <main className={s.main}>
        <Outlet />
      </main>
    </div>
  );
}
