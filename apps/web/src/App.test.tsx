import { screen } from "@testing-library/react";
import { App } from "./App";
import { renderApp } from "./test/render";
import { http, HttpResponse, server } from "./test/msw";

test("shows the server version and feature flags", async () => {
  server.use(http.get("*/api/version", () => HttpResponse.json({ version: "9.9.9", api: 1, features: ["cloud"] })));
  renderApp(<App />);
  expect(await screen.findByText(/server 9\.9\.9/)).toHaveTextContent("cloud");
});

test("shows an error when the server is unreachable", async () => {
  server.use(http.get("*/api/version", () => HttpResponse.error()));
  renderApp(<App />);
  expect(await screen.findByText(/could not reach the server/)).toBeInTheDocument();
});
