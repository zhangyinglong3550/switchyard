#!/usr/bin/env node
import { initConfig, loadConfig, configLocation, publicModel } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";
import { providerReady } from "../src/upstream.mjs";

const command = process.argv[2] || "help";

if (command === "init") {
  console.log(JSON.stringify(initConfig({ force: process.argv.includes("--force") }), null, 2));
} else if (command === "start") {
  const { host, port } = await startServer({ onLog: (entry) => console.error(JSON.stringify(entry)) });
  console.error(JSON.stringify({ level: "info", msg: "ready", host, port }));
} else if (command === "models") {
  const config = loadConfig();
  console.log(JSON.stringify({ object: "list", data: config.models.map(publicModel) }, null, 2));
} else if (command === "doctor") {
  const config = loadConfig();
  const providers = config.providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    ready: providerReady(provider),
    apiKeySource: provider.apiKey ? "inline" : (provider.apiKeyEnv ? `env:${provider.apiKeyEnv}` : "none")
  }));
  console.log(JSON.stringify({ ok: true, configPath: configLocation(), providers, models: config.models.length }, null, 2));
} else {
  console.log(`switchyard gateway

Usage:
  lls-gateway init
  lls-gateway start
  lls-gateway models
  lls-gateway doctor

Config:
  ${configLocation()}
  or set SWITCHYARD_CONFIG=/path/to/config.json
`);
}
