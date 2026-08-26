import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state state--loading" role="status">
      <div className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="state state--error" role="alert">
      <p className="state-title">Something went wrong</p>
      <p className="state-detail">{error.message}</p>
      {onRetry && (
        <button type="button" className="btn btn--ghost" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="state state--empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <p className="state-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function NotFound() {
  return (
    <EmptyState title="Page not found">
      <p>There is nothing at this address. Check the link, or pick a section from the navigation.</p>
    </EmptyState>
  );
}
