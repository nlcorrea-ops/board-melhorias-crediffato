// Proxy do "Agora Eu Sei" pra IA — tenta a Groq primeiro (quando configurada) e cai pro
// Cloudflare Workers AI se a Groq estiver lenta, sobrecarregada, inacessível ou não configurada.
//
// Por que isso existe: o board é um site estático (GitHub Pages), sem servidor próprio. Se o
// navegador chamasse a IA direto, a chave da API ficaria visível pra qualquer um que abrisse
// o código-fonte da página — e essa chave é o que controla o uso gratuito (e o custo, se um dia
// passar a pagar). Este Worker fica no meio: guarda as chaves como segredo do lado do Cloudflare
// (nunca chegam ao navegador) e só repassa o pedido depois de confirmar que quem está chamando
// tem uma sessão válida no Firebase Auth do board — assim só gente logada na plataforma consegue
// usar, não qualquer visitante da internet.
//
// Troca de dados: navegador -> este Worker -> Groq ou Cloudflare -> este Worker -> navegador.
// Nenhum dos dois provedores treina modelo com o conteúdo, e este Worker não grava nada em lugar
// nenhum (sem log de conteúdo, sem banco de dados).
//
// GROQ_API_KEY é opcional: se não tiver esse segredo configurado, o Worker nem tenta a Groq e
// já chama o Cloudflare Workers AI direto como principal — dá pra publicar isso funcionando
// só com os segredos do Cloudflare, sem precisar ter conta na Groq. Os dois provedores rodam
// exatamente os mesmos modelos (gpt-oss-20b e gpt-oss-120b da OpenAI, em versão aberta), então
// trocar de um pro outro não muda o jeito que o assistente responde — só de onde a resposta
// vem. Com a Groq configurada, só cai pro backup quando ela nem responde a tempo (timeout),
// não responde (fora do ar/inacessível) ou responde com erro de sobrecarga (429 ou 5xx); um
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

    // Tudo dentro de um try/catch geral: se QUALQUER coisa aqui dentro quebrar de um jeito
    // inesperado (rede, variável de ambiente faltando etc.), ainda assim devolve uma resposta
    // com os cabeçalhos de CORS certos. Sem isso, uma exceção não tratada vira uma página de
    // erro genérica do Cloudflare sem CORS, e o navegador esconde o erro de verdade atrás de um
    // "Failed to fetch" que não ajuda em nada a diagnosticar.
    try{
      let body;
      try{
        body = await request.json();
      }catch(e){
        return new Response("Invalid JSON", { status: 400, headers: corsHeaders() });
      }

      const { idToken, messages, model, stream, temperature, max_tokens, reasoning_effort } = body || {};
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
        // Pede pouco raciocínio interno ao gpt-oss (modelo "raciocinador") -- sem isso ele gasta
        // parte da resposta "pensando" antes de escrever a resposta final, o que come tempo e
        // parte do teto de tokens à toa numa pergunta direta de procedimento.
        reasoning_effort: typeof reasoning_effort === "string" ? reasoning_effort : "low",
      };

      let upstream;
      let provider;
      if(!env.GROQ_API_KEY){
        // Sem chave da Groq configurada — nem tenta, vai direto pro Cloudflare.
        upstream = await callCloudflareBackup(env, payload);
        provider = "cloudflare";
      }else{
        provider = "groq";
        try{
          upstream = await callGroq(env, payload);
          if(!upstream.ok && (upstream.status === 429 || upstream.status >= 500)){
            upstream = await callCloudflareBackup(env, payload);
            provider = "cloudflare";
          }
        }catch(err){
          // Timeout (AbortError) ou a Groq caiu de vez / não deu pra alcançar — tenta o backup.
          upstream = await callCloudflareBackup(env, payload);
          provider = "cloudflare";
        }
      }

      const headers = new Headers(corsHeaders());
      headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
      headers.set("X-Agorasei-Provider", provider);
      return new Response(upstream.body, { status: upstream.status, headers });
    }catch(err){
      const detail = (err && (err.message || String(err))) || "erro desconhecido";
      return new Response(`Proxy error: ${detail}`, { status: 500, headers: corsHeaders() });
    }
  },
};
