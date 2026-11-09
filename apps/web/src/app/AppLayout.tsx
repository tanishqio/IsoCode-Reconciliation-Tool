import { AppShell } from "../components/layout";
import { LoadingState } from "../components/feedback";
import { useCurrentUser } from "../features/auth/use-current-user";
import { useLogout } from "../features/auth/use-logout";

// The layout every signed-in page sits in: the app shell with the signed-in user.
// The route loader has already made sure someone is signed in before this is drawn.
export function AppLayout() {
  const user = useCurrentUser();
  const logout = useLogout();

  if (!user) return <LoadingState className="m-6" label={"Loading your account\u2026"} rows={2} />;
  return <AppShell user={{ name: user.name, role: user.role }} onLogout={logout} />;
}
