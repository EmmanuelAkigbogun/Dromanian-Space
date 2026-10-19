import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { url } = await req.json();

    if (!url || typeof url !== "string") {
      return new Response(JSON.stringify({ error: "url is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return new Response(JSON.stringify({ error: "Invalid URL" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return new Response(JSON.stringify({ error: "Only HTTP(S) URLs supported" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LinkPreviewBot/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return new Response(JSON.stringify({ error: `HTTP ${response.status}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return new Response(JSON.stringify({ error: "Not an HTML page" }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const html = await response.text();
    const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    const head = headMatch ? headMatch[1] : html.slice(0, 5000);

    const getMeta = (prop: string): string | null => {
      let m = head.match(new RegExp(`<meta[^>]*property="${prop}"[^>]*content="([^"]*)"`, "i"));
      if (m) return m[1];
      m = head.match(new RegExp(`<meta[^>]*content="([^"]*)"[^>]*property="${prop}"`, "i"));
      if (m) return m[1];
      m = head.match(new RegExp(`<meta[^>]*name="${prop}"[^>]*content="([^"]*)"`, "i"));
      if (m) return m[1];
      m = head.match(new RegExp(`<meta[^>]*content="([^"]*)"[^>]*name="${prop}"`, "i"));
      if (m) return m[1];
      return null;
    };

    const titleMatch = head.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = getMeta("og:title") ?? getMeta("twitter:title") ?? (titleMatch ? titleMatch[1].trim() : null);
    const description = getMeta("og:description") ?? getMeta("twitter:description") ?? getMeta("description");
    let image = getMeta("og:image") ?? getMeta("twitter:image");
    const siteName = getMeta("og:site_name");

    if (image && !image.startsWith("http")) {
      try {
        image = new URL(image, url).href;
      } catch {
        image = null;
      }
    }

    const result = {
      url,
      title: title?.slice(0, 200) ?? null,
      description: description?.slice(0, 300) ?? null,
      image: image ?? null,
      siteName: siteName?.slice(0, 100) ?? parsed.hostname,
    };

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
