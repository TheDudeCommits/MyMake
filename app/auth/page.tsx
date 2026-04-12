import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { getCurrentAppSession } from "@/lib/server/auth-next";

export default function AuthPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const redirectParam = searchParams?.redirect;
  const redirectPath = Array.isArray(redirectParam) ? redirectParam[0] : redirectParam;
  const session = getCurrentAppSession();

  if (session) {
    redirect(redirectPath || "/");
  }

  return <AuthForm redirectTo={redirectPath || "/"} />;
}
