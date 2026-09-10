// Proxy do "Agora Eu Sei" pra IA — Groq como principal (mais rápida), com troca automática pra
// Cloudflare Workers AI se a Groq estiver lenta, sobrecarregada ou fora do ar.
//
// Por que isso existe: o board é um site estático (GitHub Pages), sem servidor próprio. Se o
// navegador chamasse a Groq direto, a chave da API ficaria visível pra qualquer um que abrisse
// o código-fonte da página — e essa chave é o que controla o uso gratuito (e o custo, se um dia
// passar a pagar). Este Worker fica no meio: guarda as chaves como segredo do lado do Cloudflare
// (nunca chegam ao navegador) e só repassa o pedido depois de confirmar que quem está chamando
// tem uma sessão válida no Firebase Auth do board — assim só gente logada na plataforma consegue
// usar, não qualquer visitante da internet.
//
// Troca de dados: navegador -> este Worker -> Groq (ou Cloudflare, se a Groq falhar) -> este
// Worker -> navegador. Nenhum dos dois provedores treina modelo com o conteúdo, e este Worker
// não grava nada em lugar nenhum (sem log de conteúdo, sem banco de dados).
//
// Backup automático: os dois provedores rodam exatamente os mesmos modelos (gpt-oss-20b e
// gpt-oss-120b da OpenAI, em versão aberta), então trocar de um pro outro no meio não muda o
// jeito que o assistente responde — só de onde a resposta vem. Cai pro backup quando a Groq nem
// responde a tempo (timeout) ou responde com erro de sobrecarga/instabilidade (429 ou 5xx); um
// erro do próprio pedido (4xx que não seja 429) não cai pro backup, porque ia dar o mesmo erro
// nos dois lados.

const ALLOWED_ORIGIN = "https://nlcorrea-ops.github.io";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_TIMEOUT_MS = 8000; // acima disso, considera a Groq lenta demais e já tenta o backup

const GROQ_TO_CLOUDFLARE_MODEL = {
  "openai/gpt-oss-20b": "@cf/openai/gpt-oss-20b",
  "openai/gpt-oss-120b": "@cf/openai/gpt-oss-120b",
};

function corsHeaders(){
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-Agorasei-Provider",
  };
}

// Confirma que o idToken é de uma sessão de verdade do Firebase Auth do projeto do board —
// usa a própria API do Firebase pra validar (assinatura, expiração, projeto certo), em vez de
// reimplementar verificação de JWT aqui.
async function isValidFirebaseSession(idToken, env){
  if(!idToken) return false;
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    }
  );
  if(!resp.ok) return false;
  const data = await resp.json();
  return !!(data && Array.isArray(data.users) && data.users.length > 0);
}

async function callGroq(env, payload){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  try{
    return await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  }finally{
    clearTimeout(timer);
  }
}

// Mesmo formato de pedido/resposta da Groq (API compatível com OpenAI) — só troca o endereço,
// a autenticação e o nome do modelo (prefixo "@cf/").
async function callCloudflareBackup(env, payload){
  const cfModel = GROQ_TO_CLOUDFLARE_MODEL[payload.model] || "@cf/openai/gpt-oss-20b";
  return fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.CF_API_TOKEN}`,
    },
    body: JSON.stringify({ ...payload, model: cfModel }),
  });
}

export default {
  async fetch(request, env){
    if(request.method === "OPTIONS"){
      return new Response(null, { headers: corsHeaders() });
    }
    if(request.method !== "POST"){
      return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
    }

    let body;
    try{
      body = await request.json();
    }catch(e){
      return new Response("Invalid JSON", { status: 400, headers: corsHeaders() });
    }

    const { idToken, messages, model, stream, temperature, max_tokens } = body || {};
    if(!Array.isArray(messages) || !model){
      return new Response("Missing fields", { status: 400, headers: corsHeaders() });
    }

    const authorized = await isValidFirebaseSession(idToken, env);
    if(!authorized){
      return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
    }

    const payload = {
      model,
      messages,
      stream: !!stream,
      temperature: typeof temperature === "number" ? temperature : 0.6,
      max_tokens: typeof max_tokens === "number" ? max_tokens : 500,
    };

    let upstream;
    let provider = "groq";
    try{
      upstream = await callGroq(env, payload);
      if(!upstream.ok && (upstream.status === 429 || upstream.status >= 500)){
        upstream = await callCloudflareBackup(env, payload);
        provider = "cloudflare";
      }
    }catch(err){
      // Timeout (AbortError) ou a Groq caiu de vez antes de responder — tenta o backup.
      upstream = await callCloudflareBackup(env, payload);
      provider = "cloudflare";
    }

    const headers = new Headers(corsHeaders());
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    headers.set("X-Agorasei-Provider", provider);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
