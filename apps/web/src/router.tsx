import { createBrowserRouter, Navigate, Outlet, type RouteObject, useLocation } from "react-router";
import { useIdentity, useToken } from "./api/auth";
import { Shell } from "./components/Shell";
import { NotFound, PageHeader } from "./components/States";
import { Login } from "./screens/Login";
import { Sessions } from "./screens/Sessions";
import { SessionDetail } from "./screens/SessionDetail";
import { Skills } from "./screens/Skills";
import { SkillDetail } from "./screens/SkillDetail";

function RequireAuth() {
  const token = useToken();
  const location = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

function RequireAdmin() {
  const me = useIdentity();
  if (me.isPending) return null;
  return me.data?.admin ? <Outlet /> : <NotFound />;
}

// Placeholders until each screen's own work item lands (web-app.md).
const placeholder = (title: string) => () => <PageHeader title={title} subtitle="Coming soon." />;
const Tokens = placeholder("Tokens");
const Billing = placeholder("Billing");
const GettingStarted = placeholder("Get started");

export const routes: RouteObject[] = [
  { path: "/login", element: <Login /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Shell />,
        children: [
          { index: true, element: <Navigate to="/sessions" replace /> },
          { path: "sessions", Component: Sessions },
          { path: "sessions/:id", Component: SessionDetail },
          { path: "skills", Component: Skills },
          { path: "skills/:scope/:agent/*", Component: SkillDetail },
          { element: <RequireAdmin />, children: [{ path: "tokens", Component: Tokens }] },
          { path: "billing", Component: Billing },
          { path: "start", Component: GettingStarted },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
