import { useAuthActions } from "@convex-dev/auth/react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { normalizeIdentityRedirect } from "../../lib/identityLink";

export const Route = createFileRoute("/auth/feishu")({ component: FeishuAuthCallback });

function FeishuAuthCallback() {
  const { signIn } = useAuthActions();
  const [message, setMessage] = useState("Completing sign-in…");

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const ticket = fragment.get("ticket")?.trim();
    const traceId = fragment.get("trace")?.trim();
    const redirectTo = normalizeIdentityRedirect(fragment.get("next"));
    window.history.replaceState(null, "", window.location.pathname);
    if (!ticket) {
      setMessage(withTrace("Sign-in could not be completed. Please try again.", traceId));
      return;
    }

    void signIn("feishu", { ticket })
      .then(() => {
        window.location.replace(redirectTo);
      })
      .catch(() => {
        setMessage(withTrace("Sign-in could not be completed. Please try again.", traceId));
      });
  }, [signIn]);

  return (
    <main className="section">
      <p role="status">{message}</p>
    </main>
  );
}

function withTrace(message: string, traceId: string | undefined) {
  return traceId ? `${message} Reference: ${traceId}` : message;
}
