import { auth } from "@/lib/auth";
import { getCampaignTemplate } from "@/lib/templates/campaign-templates";
import { OfficeLoginForm } from "@/components/office-login-form";
import { redirect } from "next/navigation";

export async function generateMetadata() {
  return {
    title: "Login - Rahbin Group",
    description: "Sign in to Rahbin Reply",
  };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    callbackUrl?: string;
    template?: string;
  }>;
}) {
  const params = await searchParams;
  const selectedTemplate = getCampaignTemplate(params.template);
  const templateCallbackUrl = selectedTemplate
    ? `/campaigns/new?template=${selectedTemplate.slug}`
    : null;
  const requested = params.callbackUrl ?? templateCallbackUrl ?? "/dashboard";
  const callbackUrl =
    requested.startsWith("/") && !requested.startsWith("//")
      ? requested
      : "/dashboard";

  const session = await auth();
  if (session?.user?.id) {
    redirect(callbackUrl);
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-foreground">
            Rahbin Group
          </h1>
          <p className="text-muted text-sm leading-relaxed mt-2">
            Sign in to Rahbin Reply
          </p>
        </div>

        <div className="panel rounded p-8 shadow-black/40">
          {process.env.OFFICE_ACCESS_CODE ? (
            <OfficeLoginForm redirectTo={callbackUrl} />
          ) : (
            <p className="text-sm text-red-400 text-center">
              Sign-in is disabled (OFFICE_ACCESS_CODE is not set).
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
