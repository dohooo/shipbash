import { handleHostedSlackWebhook } from "@/lib/hosted-slack-webhook";
import { isVercelRuntime } from "@/lib/production-resources";
import { proxyWebhook } from "@/lib/webhook-proxy";

export async function POST(request: Request): Promise<Response> {
  if (isVercelRuntime()) return handleHostedSlackWebhook(request);
  return proxyWebhook(request, {
    path: "/api/webhooks/slack",
    headers: ["content-type", "x-slack-request-timestamp", "x-slack-signature", "x-slack-retry-num"],
  });
}
