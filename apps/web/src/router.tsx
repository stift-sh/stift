import { createBrowserRouter, Navigate, Outlet, type RouteObject, useLocation } from "react-router";
import { useAuth } from "./api/auth";
import { Shell } from "./components/Shell";
import { NotFound, Spinner } from "./components/States";
import { Login } from "./screens/Login";
import { Sessions } from "./screens/Sessions";
import { SessionDetail } from "./screens/SessionDetail";
import { Skills } from "./screens/Skills";
import { SkillDetail } from "./screens/SkillDetail";
import { NewSkill } from "./screens/NewSkill";
import { Members } from "./screens/Members";
import { Tokens } from "./screens/Tokens";
import { GettingStarted } from "./screens/GettingStarted";
import { Billing } from "./screens/Billing";

function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") return <Spinner />;
  if (status === "out") return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}


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
          { path: "skills/new", Component: NewSkill },
          { path: "skills/:scope/:agent/*", Component: SkillDetail },
          { path: "tokens", Component: Tokens },
          { path: "members", Component: Members },
          { path: "billing", Component: Billing },
          { path: "start", Component: GettingStarted },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
