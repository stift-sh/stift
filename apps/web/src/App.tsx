import { useServerVersion } from "./api/version";

export function App() {
  const version = useServerVersion();
  return (
    <main className="shell">
      <h1>stift</h1>
      {version.isPending && <p className="muted">Connecting…</p>}
      {version.isError && <p className="error">{version.error.message}</p>}
      {version.data && (
        <p className="muted">
          server {version.data.version} · api v{version.data.api}
          {version.data.features.length > 0 && <> · {version.data.features.join(", ")}</>}
        </p>
      )}
    </main>
  );
}
