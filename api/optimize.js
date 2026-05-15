import OpenAI from "openai";

/* ---------------------------------- */
/*  OpenAI config */
/* ---------------------------------- */

function getClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  return new OpenAI({
    apiKey: key,
    timeout: 12000
  });
}

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/* ---------------------------------- */
/*  Constants */
/* ---------------------------------- */

const ALLOWED_TONES = new Set([
  "neutral",
  "professional",
  "conversion"
]);

/* ---------------------------------- */
/*  Utilities */
/* ---------------------------------- */

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sanitizeTone(tone) {
  const value = String(tone || "").toLowerCase().trim();

  // Compat légère avec l'ancien nom
  if (value === "persuasive") return "conversion";

  return ALLOWED_TONES.has(value) ? value : "neutral";
}

function sanitizeLang(lang) {
  const value = String(lang || "auto").trim();
  return value || "auto";
}

function extractNumbers(text = "") {
  return (String(text).match(/\b\d+[a-zA-Z]*\b/g) || []).sort();
}

function numbersChanged(a, b) {
  const na = extractNumbers(a);
  const nb = extractNumbers(b);

  if (na.length !== nb.length) return true;

  for (let i = 0; i < na.length; i++) {
    if (na[i] !== nb[i]) return true;
  }

  return false;
}

function looksSuspicious(input = "", output = "") {
  const a = String(input || "").trim();
  const b = String(output || "").trim();

  if (!a || !b) return true;

  const la = a.length;
  const lb = b.length;

  // Sortie ridiculement courte
  if (lb < Math.max(8, la * 0.25)) return true;

  // Sortie délirante trop longue
  if (lb > la * 2.4 + 120) return true;

  // Texte court : éviter les transformations absurdes
  if (la < 20 && lb > la * 3) return true;

  return false;
}

function cleanModelOutput(text = "") {
  return String(text || "")
    .trim()
    .replace(/^```[\s\S]*?\n?/, "")
    .replace(/```$/g, "")
    .replace(/^["“”]+|["“”]+$/g, "")
    .trim();
}

/* ---------------------------------- */
/*  Token protection */
/* ---------------------------------- */

function protectTokens(text = "") {
  const map = {};
  let i = 0;

  const protectedText = String(text).replace(
    /\b([A-Z]{2,}|\d+[a-zA-Z]*|[A-Za-z]*\d+[A-Za-z0-9-]*|https?:\/\/\S+|\S+@\S+\.\S+)\b/g,
    (match) => {
      const key = `__FLEXOTOK${i++}__`;
      map[key] = match;
      return key;
    }
  );

  return { protectedText, map };
}

function restoreTokens(text = "", map = {}) {
  let out = String(text || "");

  for (const key in map) {
    out = out.replaceAll(key, map[key]);
  }

  return out;
}

/* ---------------------------------- */
/*  Prompt */
/* ---------------------------------- */

function buildToneInstruction(tone = "neutral") {
  switch (tone) {
    case "professional":
      return [
        "Make the text more professional, clear, credible, and polished.",
        "Keep it natural and human.",
        "Do not make it pompous, legalistic, robotic, or overly corporate."
      ].join(" ");

    case "conversion":
      return [
        "Make the text clearer, more convincing, and more action-oriented.",
        "Improve the perceived value and clarity of the request or offer.",
        "Do not invent facts, benefits, guarantees, urgency, discounts, or promises.",
        "Do not manipulate dishonestly."
      ].join(" ");

    case "neutral":
    default:
      return [
        "Make the text natural, fluid, clean, and easy to read.",
        "Do not make it notably more formal.",
        "Do not over-polish it."
      ].join(" ");
  }
}

function buildSystemPrompt(tone = "neutral", lang = "auto") {
  return [
    "You are Flexo, a fast and conservative text optimization engine.",
    "",
    "Your job:",
    "- Correct spelling, grammar, punctuation, accents, apostrophes, spacing, and typography.",
    "- Lightly improve clarity, flow, and readability.",
    "- Apply the selected tone conservatively.",
    "- If a target language is provided, rewrite the text in that language.",
    "",
    "Critical rules:",
    "- Preserve the original meaning exactly.",
    "- Preserve the original intent exactly.",
    "- Preserve all facts, numbers, names, product names, model names, prices, technical identifiers, URLs, emails, commands, and code-like tokens.",
    "- Do not add new information.",
    "- Do not remove important information.",
    "- Do not answer the message.",
    "- Do not continue the conversation.",
    "- Do not explain your changes.",
    "- Do not moralize.",
    "- Do not invent context.",
    "- If something is unclear, keep it close to the original.",
    "- Keep the user's natural style when possible.",
    "- Keep roughness, directness, humor, urgency, or informality when present, unless the selected tone clearly requires softening.",
    "",
    `Selected tone: ${tone}`,
    `Target language: ${lang || "auto"}`,
    "",
    "Tone instruction:",
    buildToneInstruction(tone),
    "",
    "Output rule:",
    "Return ONLY the final optimized text. No quotes. No markdown. No explanation."
  ].join("\n");
}

function buildUserPrompt({ text, tone, lang }) {
  return [
    `Tone: ${tone}`,
    `Target language: ${lang || "auto"}`,
    "",
    "Optimize this text according to the rules.",
    "",
    "Text:",
    String(text || "")
  ].join("\n");
}

/* ---------------------------------- */
/*  Handler */
/* ---------------------------------- */

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const { text, tone, lang } = req.body || {};

  const input = String(text ?? "");
  const currentTone = sanitizeTone(tone);
  const currentLang = sanitizeLang(lang);

  console.log("FLEXO OPTIMIZE REQ", {
    tone: currentTone,
    lang: currentLang,
    textLength: input.length
  });

  if (!input.trim()) {
    res.status(200).json({
      text: input,
      blocked: false
    });
    return;
  }

  const client = getClient();

  if (!client) {
    res.status(200).json({
      text: input,
      blocked: true,
      reason: "missing_api_key"
    });
    return;
  }

  try {
    const { protectedText, map } = protectTokens(input);

    const system = buildSystemPrompt(currentTone, currentLang);
    const user = buildUserPrompt({
      text: protectedText,
      tone: currentTone,
      lang: currentLang
    });

    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      top_p: 0.7,
      max_tokens: 700,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    let output = cleanModelOutput(
      completion.choices?.[0]?.message?.content || ""
    );

    if (!output) {
      res.status(200).json({
        text: input,
        blocked: true,
        reason: "empty_output"
      });
      return;
    }

    output = restoreTokens(output, map).trim();

    if (numbersChanged(input, output)) {
      res.status(200).json({
        text: input,
        blocked: true,
        reason: "numbers_modified"
      });
      return;
    }

    if (looksSuspicious(input, output)) {
      res.status(200).json({
        text: input,
        blocked: true,
        reason: "suspicious_output"
      });
      return;
    }

    console.log("FLEXO OPTIMIZE OK", {
      model: OPENAI_MODEL,
      tone: currentTone,
      lang: currentLang,
      inputLength: input.length,
      outputLength: output.length
    });

    res.status(200).json({
      text: output,
      blocked: false
    });
  } catch (e) {
    console.error("FLEXO OPTIMIZE ERROR", {
      name: e?.name,
      message: e?.message,
      status: e?.status
    });

    res.status(200).json({
      text: input,
      blocked: true,
      reason: "exception",
      detail: e?.message || "unknown_error"
    });
  }
}