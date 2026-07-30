import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { getCurrentAppSession } from "@/lib/server/auth-next";

export default async function AuthPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const redirectParam = resolvedSearchParams?.redirect;
  const redirectPath = Array.isArray(redirectParam) ? redirectParam[0] : redirectParam;
  const session = await getCurrentAppSession();

  if (session) {
    redirect(redirectPath || "/");
  }

  return <AuthForm redirectTo={redirectPath || "/"} />;
}
