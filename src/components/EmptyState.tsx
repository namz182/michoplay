import type { ReactNode } from "react";

export function Empty({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty-library"><h2>{title}</h2><p>{description}</p>{action}</div>;
}
