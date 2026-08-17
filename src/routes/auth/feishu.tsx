import { useAuthActions } from "@convex-dev/auth/react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { normalizeIdentityRedirect } from "../../lib/identityLink";

export const Route = createFileRoute("/auth/feishu")({ component: FeishuAuthCallback });

function FeishuAuthCallback() {
  const { signIn } = useAuthActions();
  const navigate = Route.useNavigate();
  const [message, setMessage] = useState("Completing sign-in…");

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const ticket = fragment.get("ticket")?.trim();
    const traceId = fragment.get("trace")?.trim();
    const redirectTo = normalizeIdentityRedirect(fragment.get("next"));

    // Clear the address bar immediately, then tell TanStack Router about the
    // same location. Native history alone lets the router restore its stale
    // fragment when auth state changes.
    window.history.replaceState(null, "", window.location.pathname);
    void navigate({ to: "/auth/feishu", search: {}, hash: "", replace: true })
      .then(async () => {
        if (!ticket) {
          setMessage(withTrace("Sign-in could not be completed. Please try again.", traceId));
          return;
        }

        const result = await signIn("feishu", { ticket });
        if (!result.signingIn) {
          setMessage(withTrace("Sign-in could not be completed. Please try again.", traceId));
          return;
        }

        window.location.replace(redirectTo);
      })
      .catch(() => {
        setMessage(withTrace("Sign-in could not be completed. Please try again.", traceId));
      });
  }, [navigate, signIn]);

  return (
    <main className="section">
      <p role="status">{message}</p>
    </main>
  );
}

function withTrace(message: string, traceId: string | undefined) {
  return traceId ? `${message} Reference: ${traceId}` : message;
}
