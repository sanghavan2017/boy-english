import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://sanghavan2017.github.io";
const FREE_DAILY_LIMIT = 18;
const PREMIUM_SAFETY_CAP = 500;
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "3600",
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
  const limit = isPremium ? PREMIUM_SAFETY_CAP : FREE_DAILY_LIMIT;

  const { data: usageResult, error: usageErr } = await supabase.rpc("bump_usage", {
    p_user: userId,
    p_date: today,
    p_limit: limit,
  });

  if (usageErr) {
    return jsonResponse({ error: { message: "Lỗi hệ thống. Thử lại sau nhé!" } }, 500, origin);
  }

  const usageRow = Array.isArray(usageResult) ? usageResult[0] : usageResult;

  if (!usageRow?.allowed) {
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

  const tooLong = { error: { message: "Tin nhắn quá dài. Vui lòng gửi ngắn gọn hơn." } };

  if (typeof body.system === "string" && body.system.length > 3000) {
    return jsonResponse(tooLong, 400, origin);
  }
  if (!Array.isArray(body.messages) || body.messages.length > 30) {
    return jsonResponse({ error: { message: "Yêu cầu không hợp lệ." } }, 400, origin);
  }
  for (const m of body.messages) {
    if (
      typeof m !== "object" || m === null ||
      typeof (m as { content?: unknown }).content !== "string" ||
      (m as { content: string }).content.length > 4000
    ) {
      return jsonResponse(tooLong, 400, origin);
    }
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

  let claudeData: unknown;
  try {
    claudeData = await claudeRes.json();
  } catch {
    return jsonResponse({ error: { message: "Máy chủ AI đang bận. Thử lại sau nhé!" } }, 502, origin);
  }

  return jsonResponse(claudeData, claudeRes.status, origin);
});
