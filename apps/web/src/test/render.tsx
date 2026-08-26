import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { createQueryClient } from "../api/auth";
import { routes } from "../router";

/** Mounts the real route tree at `path` under a fresh query client. */
export function renderApp({ path = "/" } = {}) {
  const qc = createQueryClient();
  qc.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, qc };
}
