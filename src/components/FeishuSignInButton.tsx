import { useMutation } from "convex/react";
import type { ComponentProps } from "react";
import { api } from "../../convex/_generated/api";
import { clearAuthError, setAuthError } from "../lib/useAuthError";
import { Button } from "./ui/button";

type ButtonProps = ComponentProps<typeof Button>;

type FeishuSignInButtonProps = Omit<ButtonProps, "onClick" | "type"> & {
  intent?: "sign_in" | "link_existing_user";
  redirectTo?: string;
};

export function FeishuSignInButton({
  intent = "sign_in",
  redirectTo,
  children = "Sign in with Feishu",
  ...props
}: FeishuSignInButtonProps) {
  const beginFeishuAuthorization = useMutation(api.identityAuth.beginFeishuAuthorization);

  return (
    <Button
      {...props}
      type="button"
      onClick={() => {
        clearAuthError();
        const next = redirectTo ?? getCurrentRelativeUrl();
        void beginFeishuAuthorization({ intent, ...(next ? { redirectTo: next } : {}) })
          .then(({ authorizationUrl }) => {
            window.location.assign(authorizationUrl);
          })
          .catch(() => {
            setAuthError("Sign in failed. Please try again.");
          });
      }}
    >
      {children}
    </Button>
  );
}

function getCurrentRelativeUrl() {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}
