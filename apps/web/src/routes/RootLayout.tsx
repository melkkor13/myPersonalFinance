import { Outlet } from '@tanstack/react-router';

/**
 * The only shared chrome: a centred page surface. Deliberately no nav shell —
 * the scaffold has exactly two screens (FR11) and nothing to navigate between.
 */
export function RootLayout() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface p-6 text-ink">
      <Outlet />
    </div>
  );
}
