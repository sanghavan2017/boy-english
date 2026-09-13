import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://sanghavan2017.github.io";
const FREE_DAILY_LIMIT = 18;
const PREMIUM_SAFETY_CAP = 500;
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
  };
  if (!origin || origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = origin ?? "*";
  }
  return headers;
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function todayInVietnam(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (origin && origin !== ALLOWED_ORIGIN) {
    return jsonResponse({ error: { message: "Origin not allowed" } }, 403, origin);
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: { message: "Method not allowed" } }, 405, origin);
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) {
    return jsonResponse({ error: { message: "Missing auth token. Please log in again." } }, 401, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return jsonResponse({ error: { message: "Invalid session. Please log in again." } }, 401, origin);
  }
  const userId = userData.user.id;

  const { data: profile } = await supabase
    .from("profiles")
    .select("plan, premium_until")
    .eq("id", userId)
    .single();

  const isPremium = !!profile && profile.plan === "premium" &&
    !!profile.premium_until && new Date(profile.premium_until).getTime() > Date.now();

  const today = todayInVietnam();

  const { data: usageRow } = await supabase
    .from("usage_daily")
    .select("count")
    .eq("user_id", userId)
    .eq("usage_date", today)
    .maybeSingle();

  const currentCount = usageRow?.count ?? 0;
  const limit = isPremium ? PREMIUM_SAFETY_CAP : FREE_DAILY_LIMIT;

  if (currentCount >= limit) {
    const message = isPremium
      ? "Đã đạt giới hạn an toàn hôm nay. Vui lòng thử lại vào ngày mai."
      : "Hết lượt miễn phí hôm nay rồi! Nâng cấp để học không giới hạn.";
    return jsonResponse({ error: { message, code: "LIMIT_REACHED" } }, 429, origin);
  }

  let body: { system?: string; messages?: unknown; max_tokens?: number };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: { message: "Invalid request body" } }, 400, origin);
  }

  const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 200, 1), 300);

  let claudeRes: Response;
  try {
    claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: maxTokens,
        system: body.system ?? "You are a friendly English teacher.",
        messages: body.messages ?? [],
      }),
    });
  } catch {
    return jsonResponse({ error: { message: "Upstream request failed. Please try again." } }, 502, origin);
  }

  const claudeData = await claudeRes.json();

  if (claudeRes.ok) {
    await supabase.from("usage_daily").upsert(
      { user_id: userId, usage_date: today, count: currentCount + 1 },
      { onConflict: "user_id,usage_date" },
    );
  }

  return jsonResponse(claudeData, claudeRes.status, origin);
});
