#!/usr/bin/env node
// A stdio MCP server for connector tests (test/connectorFixtures.ts): it starts only when FAKE_SECRET's sha256 is
// EXPECT_SHA256 (a connector's secret env var, checked against its plain one), and env_keys shows which env vars it
// was given, so a test can check Box Yard's own never reach a connector command.
import { createHash } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

const want = process.env.EXPECT_SHA256
const got = createHash("sha256").update(process.env.FAKE_SECRET ?? "").digest("hex")
if (want && got !== want) {
  process.stderr.write("fake-mcp-stdio: FAKE_SECRET is wrong or missing\n")
  process.exit(3)
}

const server = new McpServer({ name: "fake-stdio", version: "1" })
server.registerTool("ping", { description: "Answer pong" }, async () => ({ content: [{ type: "text", text: "pong" }] }))
server.registerTool("env_keys", { description: "The names of the env vars this command got" }, async () => ({ content: [{ type: "text", text: JSON.stringify(Object.keys(process.env).sort()) }] }))
await server.connect(new StdioServerTransport())
