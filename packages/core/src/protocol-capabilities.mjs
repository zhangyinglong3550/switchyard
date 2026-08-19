// Stable protocol capability metadata used by routing diagnostics.  It makes
// every native pass-through and conversion hop explicit without inventing
// unsupported provider endpoints.

const PROTOCOLS = new Set([
  "openai_chat",
  "openai_responses",
  "anthropic_messages",
  "antigravity"
]);

const PROFILES = {
  openai_chat: {
    canonicalProtocol: "openai_chat",
    features: { streaming: true, toolCalls: true, reasoning: true, nativeResponses: false, nativeAnthropic: false }
  },
  openai_responses: {
    canonicalProtocol: "openai_responses",
    features: { streaming: true, toolCalls: true, reasoning: true, nativeResponses: true, nativeAnthropic: false }
  },
  anthropic_messages: {
    canonicalProtocol: "anthropic_messages",
    features: { streaming: true, toolCalls: true, reasoning: true, nativeResponses: false, nativeAnthropic: true }
  },
  antigravity: {
    canonicalProtocol: "openai_chat",
    features: { streaming: true, toolCalls: true, reasoning: true, nativeResponses: false, nativeAnthropic: false }
  }
};

function protocolName(value, fallback = "openai_chat") {
  const protocol = String(value || "").trim();
  return PROTOCOLS.has(protocol) ? protocol : fallback;
}

export function providerProtocolCapabilities(provider = {}) {
  const upstreamProtocol = protocolName(provider?.apiFormat);
  const profile = PROFILES[upstreamProtocol] || PROFILES.openai_chat;
  return {
    upstreamProtocol,
    canonicalProtocol: profile.canonicalProtocol,
    features: { ...profile.features }
  };
}

export function describeProtocolRoute({ clientProtocol, provider = {} } = {}) {
  const client = protocolName(clientProtocol);
  const upstream = providerProtocolCapabilities(provider);
  if (client === upstream.upstreamProtocol) {
    return {
      clientProtocol: client,
      upstreamProtocol: upstream.upstreamProtocol,
      mode: "native",
      lossless: true,
      steps: [client],
      features: upstream.features
    };
  }

  const steps = [client];
  // Chat is the only internal bridge used for cross-family conversions.
  // Do not add a duplicate hop when the client already speaks Chat.
  if (client !== "openai_chat") steps.push("openai_chat");
  if (steps.at(-1) !== upstream.upstreamProtocol) steps.push(upstream.upstreamProtocol);

  return {
    clientProtocol: client,
    upstreamProtocol: upstream.upstreamProtocol,
    mode: "convert",
    lossless: false,
    steps,
    features: upstream.features
  };
}
