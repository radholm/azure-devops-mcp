#!/usr/bin/env node

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getBearerHandler, getPersonalAccessTokenHandler, WebApi } from "azure-devops-node-api";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { createAuthenticator } from "./auth.js";
import { logger } from "./logger.js";
import { getOrgTenant } from "./org-tenants.js";
//import { configurePrompts } from "./prompts.js";
import { configureAllTools } from "./tools.js";
import { UserAgentComposer } from "./useragent.js";
import { packageVersion } from "./version.js";
import { DomainsManager } from "./shared/domains.js";

function isGitHubCodespaceEnv(): boolean {
  return process.env.CODESPACES === "true" && !!process.env.CODESPACE_NAME;
}

const defaultAuthenticationType = isGitHubCodespaceEnv() ? "azcli" : "interactive";

/**
 * Extract the organization/collection name from a base URL.
 * E.g. "https://azuredo.lfnet.se/tfs/Lansforsakringar" -> "Lansforsakringar"
 *      "https://dev.azure.com/MyOrg" -> "MyOrg"
 */
function extractOrgFromUrl(url: string): string {
  const pathname = new URL(url).pathname.replace(/\/+$/, "");
  const lastSegment = pathname.split("/").pop();
  if (!lastSegment) {
    throw new Error(`Cannot derive organization name from base URL '${url}'. Please provide the organization positional argument.`);
  }
  return lastSegment;
}

// Parse command line arguments using yargs
const argv = yargs(hideBin(process.argv))
  .scriptName("azure-devops-mcp")
  .usage("Usage: $0 [organization] [options]")
  .version(packageVersion)
  .command("$0 [organization] [options]", "Azure DevOps MCP Server", (yargs) => {
    yargs.positional("organization", {
      describe: "Azure DevOps organization name (optional if --base-url is provided)",
      type: "string",
    });
  })
  .option("domains", {
    alias: "d",
    describe: "Domain(s) to enable: 'all' for everything, or specific domains like 'repositories builds work'. Defaults to 'all'.",
    type: "string",
    array: true,
    default: "all",
  })
  .option("authentication", {
    alias: "a",
    describe: "Type of authentication to use",
    type: "string",
    choices: ["interactive", "azcli", "env", "envvar", "pat"],
    default: defaultAuthenticationType,
  })
  .option("tenant", {
    alias: "t",
    describe: "Azure tenant ID (optional, applied when using 'interactive' and 'azcli' type of authentication)",
    type: "string",
  })
  .option("base-url", {
    alias: "b",
    describe: "Base URL for Azure DevOps Server (on-prem). E.g. 'https://azuredo.example.com/tfs/MyCollection'. Defaults to 'https://dev.azure.com/{organization}'.",
    type: "string",
  })
  .check((argv) => {
    if (!argv.organization && !argv.baseUrl && !process.env.AZURE_DEVOPS_BASE_URL) {
      throw new Error("Either <organization> or --base-url (or AZURE_DEVOPS_BASE_URL env var) must be provided.");
    }
    return true;
  })
  .help()
  .parseSync();

export const orgUrl = (argv.baseUrl as string | undefined) ?? process.env.AZURE_DEVOPS_BASE_URL ?? "https://dev.azure.com/" + (argv.organization as string);
export const orgName = (argv.organization as string | undefined) ?? extractOrgFromUrl(orgUrl);

/**
 * Whether the server is connecting to an on-premises Azure DevOps Server instance
 * (i.e., not the cloud-hosted dev.azure.com service).
 */
export const isOnPrem = !orgUrl.startsWith("https://dev.azure.com/");

const domainsManager = new DomainsManager(argv.domains);
export const enabledDomains = domainsManager.getEnabledDomains();

function getAzureDevOpsClient(getAzureDevOpsToken: () => Promise<string>, userAgentComposer: UserAgentComposer, authType: string): () => Promise<WebApi> {
  return async () => {
    const accessToken = await getAzureDevOpsToken();
    // For pat, accessToken is the raw PAT token
    const authHandler = authType === "pat" ? getPersonalAccessTokenHandler(accessToken) : getBearerHandler(accessToken);
    const connection = new WebApi(orgUrl, authHandler, undefined, {
      productName: "AzureDevOps.MCP",
      productVersion: packageVersion,
      userAgent: userAgentComposer.userAgent,
    });
    return connection;
  };
}

async function main() {
  logger.info("Starting Azure DevOps MCP Server", {
    organization: orgName,
    organizationUrl: orgUrl,
    authentication: argv.authentication,
    tenant: argv.tenant,
    domains: argv.domains,
    enabledDomains: Array.from(enabledDomains),
    version: packageVersion,
    isCodespace: isGitHubCodespaceEnv(),
    isOnPrem,
  });

  // Validate authentication type for on-prem servers
  if (isOnPrem && argv.authentication !== "pat" && argv.authentication !== "envvar") {
    logger.error("On-premises Azure DevOps Server only supports 'pat' or 'envvar' authentication.");
    throw new Error("On-premises Azure DevOps Server only supports 'pat' or 'envvar' authentication. " + "Please use '--authentication pat' or '--authentication envvar'.");
  }

  const server = new McpServer({
    name: "Azure DevOps MCP Server",
    version: packageVersion,
    icons: [
      {
        src: "https://cdn.vsassets.io/content/icons/favicon.ico",
      },
    ],
  });

  const userAgentComposer = new UserAgentComposer(packageVersion);
  server.server.oninitialized = () => {
    userAgentComposer.appendMcpClientInfo(server.server.getClientVersion());
  };
  const tenantId = isOnPrem ? argv.tenant : ((await getOrgTenant(orgName)) ?? argv.tenant);
  const authenticator = createAuthenticator(argv.authentication, tenantId);

  if (argv.authentication === "pat") {
    const rawPat = await authenticator();
    // Build the Basic auth value from the raw PAT: base64(":token")
    const basicValue = Buffer.from(`:${rawPat}`).toString("base64");
    const _originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.headers) {
        const headers = new Headers(init.headers as HeadersInit);
        if (headers.get("Authorization")?.startsWith("Bearer ")) {
          headers.set("Authorization", `Basic ${basicValue}`);
          init = { ...init, headers };
        }
      }
      return _originalFetch(input, init);
    };
    logger.debug("PAT mode: global fetch interceptor installed to rewrite Bearer -> Basic auth headers");
  }

  // removing prompts untill further notice
  // configurePrompts(server);

  configureAllTools(server, authenticator, getAzureDevOpsClient(authenticator, userAgentComposer, argv.authentication), () => userAgentComposer.userAgent, enabledDomains);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  logger.error("Fatal error in main():", error);
  process.exit(1);
});
