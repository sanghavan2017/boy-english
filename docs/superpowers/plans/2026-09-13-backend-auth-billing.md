# Backend Auth + Usage Limits + Billing Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the client-entered Claude API key from Boy English, replacing it with Supabase email-magic-link login + a server-side Edge Function that proxies Claude calls, enforces an 18-turn/day free limit, and unlocks unlimited use for manually-granted premium accounts.

**Architecture:** Reactivate the existing (paused) Supabase project `boyengish`, add two Postgres tables (`profiles`, `usage_daily`) with RLS, deploy one Edge Function (`ai-proxy`) that authenticates the caller, enforces the daily cap, and forwards the request to Anthropic using a server-held secret. The static frontend (`free/index.html`, reused from the abandoned Gemini experiment) gets a login screen and a changed API endpoint; gamification stays in `localStorage` unchanged.

**Tech Stack:** Supabase (Postgres, Auth, Edge Functions / Deno), supabase-js v2 (browser, via CDN), vanilla JS/HTML (no build step), Anthropic Messages API (`claude-haiku-4-5-20251001`, unchanged model).

**Spec:** `docs/superpowers/specs/2026-09-13-backend-auth-billing-design.md`

## Global Constraints

- Free tier daily limit: **18** AI turns/day (from spec §5)
- Premium: unlimited, with a hidden safety cap of **500**/day (not shown to users) (spec §5)
- Auth: **email magic link only** for this phase — no Google Sign-In (spec §3)
- CORS/origin allowed for the Edge Function: `https://sanghavan2017.github.io` (spec §5)
- RLS enabled on both new tables; clients get `SELECT` only on their own row, no client-side writes — all writes go through the Edge Function using the service role (spec §4)
- Do **not** touch the live `index.html` at repo root in this plan — all work targets `free/index.html`. Cutting the root file over is a separate, explicitly-approved step after this plan's work is verified (spec §10)
- ElevenLabs/Whisper optional key fields, gamification (`sess`/`global`/localStorage `be_*` keys), curriculum content, and UI are unchanged (spec §1, §7)
- Claude model stays `claude-haiku-4-5-20251001`, called server-side only, without the `anthropic-dangerous-direct-browser-access` header (spec §5)
- Supabase project: `boyengish`, project_id `tgnkznmnlavhnbrdggzi`, project URL `https://tgnkznmnlavhnbrdggzi.supabase.co`
- Repo: `C:\Users\HP\dev\boy-english` (cloned from `sanghavan2017/boy-english`, push access already authenticated via `gh`)

---

## Task 1: Reactivate the Supabase project and capture connection info

**Files:** none (infra-only task)

**Interfaces:**
- Produces: `SUPABASE_ANON_KEY` (publishable key string) — consumed by Task 7 (frontend)

- [ ] **Step 1: Restore the paused project**

Call the Supabase MCP tool:
```
mcp__28d09c77-a55f-411f-9be3-12ecd0fb3e05__restore_project
  project_id: tgnkznmnlavhnbrdggzi
```

- [ ] **Step 2: Confirm it's active**

Call:
```
mcp__28d09c77-a55f-411f-9be3-12ecd0fb3e05__get_project
  id: tgnkznmnlavhnbrdggzi
```
Expected: `"status":"ACTIVE_HEALTHY"`. If still `"COMING_UP"` or similar, wait ~30s and re-check (restoring a paused free-tier project takes a short while).

- [ ] **Step 3: Fetch the publishable (anon) key**

Call:
```
mcp__28d09c77-a55f-411f-9be3-12ecd0fb3e05__get_publishable_keys
  project_id: tgnkznmnlavhnbrdggzi
```
Record the non-disabled key (starts with `sb_publishable_` or is a legacy `anon` JWT). This value is `SUPABASE_ANON_KEY`, needed in Task 7.

- [ ] **Step 4: Verify the database is reachable**

Call:
```
mcp__28d09c77-a55f-411f-9be3-12ecd0fb3e05__list_tables
  project_id: tgnkznmnlavhnbrdggzi
  schemas: ["public"]
  verbose: false
```
Expected: returns an empty (or near-empty) list without error — confirms the Postgres instance is up.

---

## Task 2: Database schema — `profiles`, `usage_daily`, auto-provision trigger

**Files:**
- Create (for the repo's own record, not required by Supabase to apply it): `supabase/migrations/20260913000000_profiles_and_usage.sql`

**Interfaces:**
- Produces: tables `public.profiles(id, plan, premium_until, created_at)` and `public.usage_daily(user_id, usage_date, count)` — consumed by Task 3 (Edge Function) and Task 8 (manual premium grant test)

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/20260913000000_profiles_and_usage.sql`:

```sql
-- One row per user, auto-created on signup.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','premium')),
  premium_until timestamptz,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

-- One row per user per calendar day (day boundary computed in the
-- Edge Function using Asia/Ho_Chi_Minh, not stored here as a timezone).
create table if not exists public.usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  count int not null default 0,
  primary key (user_id, usage_date)
);

alter table public.usage_daily enable row level security;

create policy "usage_select_own"
  on public.usage_daily for select
  using (auth.uid() = user_id);

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

- [ ] **Step 2: Apply the migration**

Call:
```
mcp__28d09c77-a55f-411f-9be3-12ecd0fb3e05__apply_migration
  project_id: tgnkznmnlavhnbrdggzi
  name: profiles_and_usage
  query: <the SQL from Step 1>
```

- [ ] **Step 3: Verify tables and RLS**

Call:
```
mcp__28d09c77-a55f-411f-9be3-12ecd0fb3e05__list_tables
  project_id: tgnkznmnlavhnbrdggzi
  schemas: ["public"]
  verbose: true
```
Expected: both `profiles` and `usage_daily` present, each showing `rls_enabled: true` (field name may vary slightly — confirm RLS is on, not just that the table exists).

- [ ] **Step 4: Verify no client-write policies exist**

Call:
```
mcp__28d09c77-a55f-411f-9be3-12ecd0fb3e05__execute_sql
  project_id: tgnkznmnlavhnbrdggzi
  query: select schemaname, tablename, policyname, cmd from pg_policies where tablename in ('profiles','usage_daily');
```
Expected: exactly 2 rows, both `cmd = 'SELECT'` (`profiles_select_own`, `usage_select_own`). No `INSERT`/`UPDATE`/`DELETE` policies — confirms only the service role (used by the Edge Function, which bypasses RLS) can write.

- [ ] **Step 5: Commit the migration file to the repo**

```bash
cd /c/Users/HP/dev/boy-english
git add supabase/migrations/20260913000000_profiles_and_usage.sql
git commit -m "Add profiles/usage_daily schema for backend auth (Giai đoạn A)"
```

---

## Task 3: Edge Function `ai-proxy` — implement and deploy

**Files:**
- Create (for the repo's own record): `supabase/functions/ai-proxy/index.ts`

**Interfaces:**
- Consumes: tables from Task 2; secret `ANTHROPIC_API_KEY` from Task 4 (function will deploy fine without it, but calls will fail with a clear upstream error until Task 4 is done — that's expected and fine to test in the next step)
- Produces: HTTPS endpoint `https://tgnkznmnlavhnbrdggzi.supabase.co/functions/v1/ai-proxy`, consumed by Task 7 (frontend) and Task 6/8 (tests). On success, response body is Anthropic's raw `{content:[{text}], ...}` JSON (unchanged shape from what the client used to get calling Anthropic directly). On the free-tier limit being hit, responds `429` with body `{"error":{"message":"...","code":"LIMIT_REACHED"}}`.

- [ ] **Step 1: Write the function code**

Create `supabase/functions/ai-proxy/index.ts`:

```typescript
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

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
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

  const claudeData = await claudeRes.json();

  if (claudeRes.ok) {
    await supabase.from("usage_daily").upsert(
      { user_id: userId, usage_date: today, count: currentCount + 1 },
      { onConflict: "user_id,usage_date" },
    );
  }

  return jsonResponse(claudeData, claudeRes.status, origin);
});
```

- [ ] **Step 2: Deploy it**

Call:
```
mcp__28d09c77-a55f-411f-9be3-12ecd0fb3e05__deploy_edge_function
  project_id: tgnkznmnlavhnbrdggzi
  name: ai-proxy
  entrypoint_path: index.ts
  verify_jwt: true
  files: [{ name: "index.ts", content: <the code from Step 1> }]
```

- [ ] **Step 3: Verify it rejects unauthenticated calls and wrong-origin calls**

```bash
curl -s -i -X POST "https://tgnkznmnlavhnbrdggzi.supabase.co/functions/v1/ai-proxy" \
  -H "Content-Type: application/json" \
  -d '{"system":"test","messages":[{"role":"user","content":"hi"}]}'
```
Expected: HTTP `401` (either from `verify_jwt` at the platform gateway, or from the function's own check) — either way, **not** a call that reaches Anthropic.

```bash
curl -s -i -X POST "https://tgnkznmnlavhnbrdggzi.supabase.co/functions/v1/ai-proxy" \
  -H "Content-Type: application/json" \
  -H "Origin: https://evil-example.com" \
  -H "Authorization: Bearer fake" \
  -d '{"system":"test","messages":[{"role":"user","content":"hi"}]}'
```
Expected: HTTP `403` with `{"error":{"message":"Origin not allowed"}}` — confirms the origin check runs before any auth/Anthropic work.

- [ ] **Step 4: Commit the function source to the repo**

```bash
cd /c/Users/HP/dev/boy-english
mkdir -p supabase/functions/ai-proxy
# save the Step 1 content into supabase/functions/ai-proxy/index.ts
git add supabase/functions/ai-proxy/index.ts
git commit -m "Add ai-proxy Edge Function (auth + daily limit + Claude proxy)"
```

---

## Task 4: Rotate the Anthropic key and set it as a Supabase secret

This is a dashboard/manual task — no MCP tool exposes secret management. Do it via the Supabase dashboard (either the user directly, or via browser automation if already logged in).

**Files:** none

**Interfaces:**
- Produces: Edge Function secret `ANTHROPIC_API_KEY`, consumed by Task 3's deployed function

- [ ] **Step 1: Create a new Anthropic API key**

Go to `https://console.anthropic.com/settings/keys` → Create Key. Name it something identifying its purpose, e.g. `boy-english-supabase`. **Do not reuse** any of the keys currently sitting in plaintext in `API console.txt` — this is the moment to stop relying on those.

- [ ] **Step 2: Set it as a secret in Supabase**

Go to `https://supabase.com/dashboard/project/tgnkznmnlavhnbrdggzi/settings/functions` → Edge Function Secrets → Add secret:
- Name: `ANTHROPIC_API_KEY`
- Value: the new key from Step 1

- [ ] **Step 3: Revoke the old exposed keys**

Back in `console.anthropic.com/settings/keys`, revoke the keys listed in `API console.txt` (the ones marked "đang dùng") once the new key is confirmed working (after Task 8's test passes) — don't revoke before that, to avoid breaking the live `index.html` app which still uses one of them directly.

- [ ] **Step 4: Verify the secret is visible (masked) in the dashboard**

The Edge Function Secrets page should list `ANTHROPIC_API_KEY` with a masked value. (Full end-to-end verification that the value is *correct* happens in Task 6/8 when a real Claude call succeeds.)

---

## Task 5: Configure Supabase Auth for email magic link

Dashboard/manual task, same reasoning as Task 4.

**Files:** none

**Interfaces:**
- Produces: working magic-link auth redirecting back to the app, consumed by Task 6

- [ ] **Step 1: Set Site URL and Redirect URLs**

Go to `https://supabase.com/dashboard/project/tgnkznmnlavhnbrdggzi/auth/url-configuration`:
- Site URL: `https://sanghavan2017.github.io/boy-english/free/`
- Redirect URLs: add `https://sanghavan2017.github.io/boy-english/free/*` (and `https://sanghavan2017.github.io/boy-english/*` too, so it keeps working after the eventual root cutover)

- [ ] **Step 2 (optional, recommended before wider rollout — not required to pass this plan's tests): custom SMTP**

Supabase's default email sender has a very low shared rate limit (a handful of emails/hour). For testing with 1-2 accounts this is fine; skip this step for now and revisit if magic links stop arriving once more people try it. If/when needed: create a free Resend account (resend.com, 3,000 emails/month free), get an API key, then in `Authentication → Settings → SMTP Settings` in the Supabase dashboard, enable custom SMTP with Resend's SMTP credentials.

- [ ] **Step 3: Confirm email provider is enabled**

`Authentication → Providers` → Email should be enabled with "Confirm email" / magic link sign-in available (this is Supabase's default — just confirm it hasn't been disabled).

---

## Task 6: End-to-end auth smoke test

**Files:** none (verification only)

**Interfaces:**
- Consumes: Tasks 1, 2, 5
- Produces: a real test user row in `auth.users` + `public.profiles`, consumed by Task 8 (premium grant test)

- [ ] **Step 1: Trigger a magic link for a real test address**

Using `claude-in-chrome` (the user's real, logged-in browser) or asking the user to do it: open a blank page and run, in the browser console (or via a tiny local test HTML — simplest is the browser devtools console against `https://tgnkznmnlavhnbrdggzi.supabase.co`):

```js
const sb = supabase.createClient('https://tgnkznmnlavhnbrdggzi.supabase.co', '<SUPABASE_ANON_KEY from Task 1>');
await sb.auth.signInWithOtp({ email: 'sang.havan2017@gmail.com', options: { emailRedirectTo: 'https://sanghavan2017.github.io/boy-english/free/' } });
```
(This requires the supabase-js UMD script loaded on the page first — or just wait for Task 7 and test through the real login screen instead, which is simpler. Prefer testing through Task 7's UI once that task is done; only use this raw-console approach if you want to verify Auth is wired up before writing the frontend.)

- [ ] **Step 2: Click the link in the email, confirm redirect lands back on the app origin**

- [ ] **Step 3: Verify a profile row was auto-created**

```
mcp__28d09c77-a55f-411f-9be3-12ecd0fb3e05__execute_sql
  project_id: tgnkznmnlavhnbrdggzi
  query: select p.id, p.plan, u.email from public.profiles p join auth.users u on u.id = p.id where u.email = 'sang.havan2017@gmail.com';
```
Expected: one row, `plan = 'free'`. This confirms the Task 2 trigger works against a real signup, not just the migration applying cleanly.

---

## Task 7: Frontend — login screen + proxy call in `free/index.html`

**Files:**
- Modify: `free/index.html` (reset from `index.html` first — the current `free/index.html` holds the abandoned Gemini experiment)

**Interfaces:**
- Consumes: `SUPABASE_ANON_KEY` (Task 1), Edge Function URL (Task 3)

- [ ] **Step 1: Reset `free/index.html` to the current live Claude version**

```bash
cd /c/Users/HP/dev/boy-english
cp index.html free/index.html
```

- [ ] **Step 2: Add the Supabase JS SDK and client init**

In `free/index.html`, right after the Google Fonts `<link>` tag, add:
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

Near the top of the main `<script>` block (right after the `let KEY=...` state-vars line), add:
```javascript
const sb = supabase.createClient('https://tgnkznmnlavhnbrdggzi.supabase.co', '<SUPABASE_ANON_KEY>');
let accessToken='';
```
(Replace `<SUPABASE_ANON_KEY>` with the real value from Task 1, Step 3.)

- [ ] **Step 3: Replace the Claude API key field with a login screen**

Remove this block from `#setupScreen` (the Claude key form-group):
```html
  <div class="form-group">
    <label>🔑 Claude API Key</label>
    <input type="password" id="apiKey" placeholder="sk-ant-api03-..." autocomplete="off"/>
    <div class="key-note">🔒 Chỉ lưu trên thiết bị này, không gửi đi đâu ngoài Anthropic</div>
  </div>
```

Add a new screen, as a sibling of `#setupScreen`, placed right before it in the HTML:
```html
<div class="setup" id="loginScreen">
  <div class="logo">
    <span class="pika">🐸</span>
    <h1>Boy English</h1>
    <p>Luyện tiếng Anh cùng Ninja Ếch</p>
  </div>
  <div class="form-group">
    <label>📧 Email của phụ huynh</label>
    <input type="email" id="loginEmail" placeholder="ban@email.com" autocomplete="email"/>
    <div class="key-note">🔒 Chỉ dùng để đăng nhập, không gửi email quảng cáo</div>
  </div>
  <button class="btn-start" id="loginBtn" onclick="sendMagicLink()">✉️ Gửi link đăng nhập</button>
  <div id="loginMsg" style="text-align:center;font-size:13px;color:#64748B;margin-top:8px"></div>
</div>
```
(Keep the existing SVG ninja logo markup instead of the placeholder `🐸` span shown above — copy it from the current `.logo` block rather than retyping it.)

- [ ] **Step 4: Add auth JS functions and wire up screen switching**

Add these functions near `load()`/`save()`:
```javascript
async function sendMagicLink(){
  const email=document.getElementById('loginEmail').value.trim();
  if(!email){alert('Vui lòng nhập email!');return;}
  const btn=document.getElementById('loginBtn');
  btn.disabled=true;btn.textContent='⏳ Đang gửi...';
  const redirectTo=window.location.href.split('#')[0].split('?')[0];
  const {error}=await sb.auth.signInWithOtp({email,options:{emailRedirectTo:redirectTo}});
  btn.disabled=false;btn.textContent='✉️ Gửi link đăng nhập';
  document.getElementById('loginMsg').textContent=error?('Lỗi: '+error.message):'Đã gửi! Kiểm tra email và bấm vào link để vào app.';
}

function logout(){sb.auth.signOut();location.reload();}

async function initAuth(){
  const {data:{session}}=await sb.auth.getSession();
  applySession(session);
  sb.auth.onAuthStateChange((event,session)=>applySession(session));
}

function applySession(session){
  if(session){
    accessToken=session.access_token;
    document.getElementById('loginScreen').style.display='none';
    document.getElementById('setupScreen').style.display='flex';
  } else {
    accessToken='';
    document.getElementById('loginScreen').style.display='flex';
    document.getElementById('setupScreen').style.display='none';
  }
}
```

At the very bottom of the script, replace the line `load();` (and the `if(KEY)...` line right after it, which referenced the now-removed `apiKey` field) with:
```javascript
load();
initAuth();
```

Also set `#setupScreen`'s default inline state to `style="display:none"` in the HTML (it should only appear after `applySession` shows it), and make sure `#loginScreen` starts visible by default (no inline `display:none`).

- [ ] **Step 5: Remove the now-dead `KEY` variable and its startApp() validation**

In `startApp()`, remove:
```javascript
  const k=document.getElementById('apiKey').value.trim();
```
and:
```javascript
  if(!k){alert('Vui lòng nhập Claude API Key!');return;}
  KEY=k;NAME=n||'bạn';GRADE=g;
```
replacing the second block with just:
```javascript
  NAME=n||'bạn';GRADE=g;
```

In `save()`/`load()`, remove `localStorage.setItem('be_key',KEY)` / the matching `be_key` read — Claude auth no longer goes through localStorage at all, it's the Supabase session. Keep `be_elkey`/`be_oaikey` persistence unchanged (ElevenLabs/OpenAI stay as-is per spec).

Remove the global `let KEY='',` from the state-vars line (keep `ELKEY`, `OAIKEY`, and the rest unchanged), since `accessToken` (added in Step 2) replaces its role.

In `goSettings()`, remove the line `document.getElementById('apiKey').value=KEY;` and add a logout link — add this at the bottom of `#setupScreen`, after the existing start button:
```html
<div class="footer-lnk" onclick="logout()">Đăng xuất</div>
```

- [ ] **Step 6: Point `askPika()` at the Edge Function instead of Anthropic directly**

Replace:
```javascript
    const r=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':KEY,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
      body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:maxTok,system:sys,messages:msgs})
    });
    const d=await r.json();
    try{chat.removeChild(typing)}catch(x){}
    if(d.error)throw new Error(d.error.message);
    const reply=d.content[0].text.trim();
    lastAI=reply;
```
with:
```javascript
    const r=await fetch('https://tgnkznmnlavhnbrdggzi.supabase.co/functions/v1/ai-proxy',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+accessToken},
      body:JSON.stringify({system:sys,messages:msgs,max_tokens:maxTok})
    });
    const d=await r.json();
    try{chat.removeChild(typing)}catch(x){}
    if(d.error){
      if(d.error.code==='LIMIT_REACHED'){addBubble('hint','🎉 '+d.error.message);return;}
      throw new Error(d.error.message);
    }
    const reply=d.content[0].text.trim();
    lastAI=reply;
```

- [ ] **Step 7: Syntax-check the file**

```bash
cd /c/Users/HP/dev/boy-english
awk '/<script>/{flag=1;next}/<\/script>/{flag=0}flag' free/index.html > /tmp/_check.js
node --check /tmp/_check.js && echo "SYNTAX OK"
rm /tmp/_check.js
```
Expected: `SYNTAX OK`.

- [ ] **Step 8: Commit**

```bash
cd /c/Users/HP/dev/boy-english
git add free/index.html
git commit -m "Replace client API key with Supabase magic-link login + ai-proxy call"
```

---

## Task 8: End-to-end product test (before pushing live)

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything from Tasks 1–7

- [ ] **Step 1: Serve `free/index.html` locally and log in for real**

```bash
cd "/c/Users/HP/dev/boy-english"
python -m http.server 8791
```
Open `http://localhost:8791/free/` in the Claude Browser tool (or `claude-in-chrome`), request a magic link with `sang.havan2017@gmail.com`, click the emailed link. Note: Supabase's redirect URL is set to the GitHub Pages origin (Task 5), so the email link will redirect to the live `/free/` URL, not localhost — for this local test, either temporarily add `http://localhost:8791/free/*` to the Redirect URLs list (Task 5's dashboard page), or skip local serving and test directly against the already-pushed live `/free/` (Task 9) instead. Prefer the latter if it's simpler — this step is only useful for catching syntax/UI issues before pushing.

- [ ] **Step 2: Confirm the setup screen appears after login, with no Claude key field**

Screenshot or `read_page` the app — expect: no "Claude API Key" input anywhere, `#loginScreen` hidden, `#setupScreen` visible with only ElevenLabs/OpenAI (optional) + name + grade fields.

- [ ] **Step 3: Start a session and send one real message**

Enter name/grade, click start, use "Gõ tay" to type a short answer. Confirm a real Claude reply comes back (not an error) — this is the first true test that `ANTHROPIC_API_KEY` (Task 4) was set correctly.

- [ ] **Step 4: Verify usage was recorded**

```
mcp__28d09c77-a55f-411f-9be3-12ecd0fb3e05__execute_sql
  project_id: tgnkznmnlavhnbrdggzi
  query: select count from public.usage_daily where user_id = (select id from auth.users where email='sang.havan2017@gmail.com') and usage_date = (now() at time zone 'Asia/Ho_Chi_Minh')::date;
```
Expected: `count = 1` after the one message sent in Step 3 (increments by 1 per successful AI turn — each topic switch also calls `askPika()` once for the opener, so the exact number will track total AI calls made during the test, not just explicit replies typed).

- [ ] **Step 5: Force-hit the free limit and confirm the upgrade message**

```
mcp__28d09c77-a55f-411f-9be3-12ecd0fb3e05__execute_sql
  project_id: tgnkznmnlavhnbrdggzi
  query: update public.usage_daily set count = 18 where user_id = (select id from auth.users where email='sang.havan2017@gmail.com') and usage_date = (now() at time zone 'Asia/Ho_Chi_Minh')::date;
```
Send one more message in the app. Expected: the chat shows the "Hết lượt miễn phí hôm nay rồi!..." bubble, not a red error bubble, and no Claude call happens (verify the `usage_daily.count` did not increment past 18 by re-running the Step 4 query).

- [ ] **Step 6: Grant premium and confirm the limit lifts**

```
mcp__28d09c77-a55f-411f-9be3-12ecd0fb3e05__execute_sql
  project_id: tgnkznmnlavhnbrdggzi
  query: update public.profiles set plan='premium', premium_until = now() + interval '30 days' where id = (select id from auth.users where email='sang.havan2017@gmail.com');
```
Send another message in the app. Expected: a normal AI reply, no limit message — confirms the premium gate check works.

- [ ] **Step 7: Revert the test account back to free**

```
mcp__28d09c77-a55f-411f-9be3-12ecd0fb3e05__execute_sql
  project_id: tgnkznmnlavhnbrdggzi
  query: update public.profiles set plan='free', premium_until=null where id = (select id from auth.users where email='sang.havan2017@gmail.com'); delete from public.usage_daily where user_id = (select id from auth.users where email='sang.havan2017@gmail.com');
```
(Cleans up the test account so it doesn't carry artificial state into real use.)

---

## Task 9: Push to GitHub and verify live at `/free/`

**Files:** none (deploy only)

- [ ] **Step 1: Push**

```bash
cd /c/Users/HP/dev/boy-english
git push origin main
```

- [ ] **Step 2: Wait for GitHub Pages to rebuild and verify**

```bash
for i in 1 2 3 4 5 6; do
  code=$(curl -s -o /dev/null -w "%{http_code}" https://sanghavan2017.github.io/boy-english/free/)
  echo "Attempt $i: HTTP $code"
  if [ "$code" = "200" ]; then break; fi
  sleep 10
done
curl -s https://sanghavan2017.github.io/boy-english/free/ | grep -c "loginScreen"
```
Expected: HTTP 200, and the grep finds the new `loginScreen` id — confirms the live page is the new version, not a cached old one.

- [ ] **Step 3: Repeat Task 8's login + chat + limit test against the live URL**

Same steps as Task 8, but against `https://sanghavan2017.github.io/boy-english/free/` instead of localhost — this is the real acceptance test since it exercises the actual CORS origin restriction (Task 3's `ALLOWED_ORIGIN` check) which localhost testing can't validate. Also worth a manual check on a real Android/iPhone browser (spec §10 test case 5) — magic-link emails opening in a different app (e.g. Gmail app's in-app browser) than the one used to request the link is a known real-world snag worth catching here rather than after rollout.

- [ ] **Step 4: STOP — do not touch root `index.html`**

This plan's scope ends here. Cutting the live `index.html` (the one the currently-testing kids use) over to this new login flow is a separate decision requiring explicit user approval, per the spec's rollout section — report results and wait.
