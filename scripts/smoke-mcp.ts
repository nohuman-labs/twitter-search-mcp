import { pathToFileURL } from "node:url";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

type SmokeOptions = {
  readonly url: URL;
  readonly bearer?: string;
  readonly tool?: string;
  readonly input?: Record<string, unknown>;
};

async function run(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const client = new Client({
    name: "twitter-search-mcp-smoke",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(options.url, {
    ...(options.bearer === undefined
      ? {}
      : { authProvider: { token: async () => options.bearer } }),
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    console.log(`Tools: ${tools.map((tool) => tool.name).join(", ")}`);

    if (options.tool !== undefined && options.input !== undefined) {
      const result = await client.callTool({
        name: options.tool,
        arguments: options.input,
      });
      if (result.isError === true) {
        throw new Error("The MCP server reported a tool error");
      }
      console.log(`Called tool: ${options.tool}`);
    }
  } finally {
    await client.close();
  }
}

function parseArguments(arguments_: readonly string[]): SmokeOptions {
  let url: URL | undefined;
  let bearer: string | undefined;
  let tool: string | undefined;
  let input: Record<string, unknown> | undefined;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw new Error(
        "Usage: smoke-mcp --url URL [--bearer token] [--tool name --input json]",
      );
    }
    if (argument === "--url") {
      url = parseUrl(value);
    } else if (argument === "--bearer") {
      bearer = value;
    } else if (argument === "--tool") {
      tool = value;
    } else if (argument === "--input") {
      input = parseInput(value);
    } else {
      throw new Error(
        "Usage: smoke-mcp --url URL [--bearer token] [--tool name --input json]",
      );
    }
    index += 1;
  }

  if (url === undefined || (tool === undefined) !== (input === undefined)) {
    throw new Error(
      "Usage: smoke-mcp --url URL [--bearer token] [--tool name --input json]",
    );
  }
  return { url, bearer, tool, input };
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error("The MCP URL is invalid");
  }
}

function parseInput(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Tool input must be a JSON object");
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await run().catch(() => {
    console.error("MCP smoke failed");
    process.exitCode = 1;
  });
}
