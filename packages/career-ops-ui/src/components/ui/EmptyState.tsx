import type { ReactNode } from "react";

type Props = {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
};

export function EmptyState({ icon, title, description, action }: Props) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-6 py-12 flex flex-col items-center text-center gap-3">
      {icon && (
        <div className="text-zinc-600 text-3xl" aria-hidden="true">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
      {description && (
        <p className="text-xs text-zinc-500 max-w-xs">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
