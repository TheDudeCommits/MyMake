import { AuthForm } from "@/components/auth-form";

export default function AuthPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const redirectParam = searchParams?.redirect;
  const redirect = Array.isArray(redirectParam) ? redirectParam[0] : redirectParam;

  return <AuthForm redirectTo={redirect || "/"} />;
}
