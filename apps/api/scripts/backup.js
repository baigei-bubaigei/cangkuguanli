import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required.");
}

const [outputOption, requestedOutputPath, ...extraArguments] = process.argv.slice(2);
if (outputOption !== "--output" || !requestedOutputPath || extraArguments.length > 0) {
  throw new Error("Usage: npm run db:backup -- --output <path>");
}

const outputPath = resolve(requestedOutputPath);
const pgParameters = {
  host: "PGHOST",
  port: "PGPORT",
  user: "PGUSER",
  password: "PGPASSWORD",
  dbname: "PGDATABASE",
  sslmode: "PGSSLMODE",
  sslcert: "PGSSLCERT",
  sslkey: "PGSSLKEY",
  sslrootcert: "PGSSLROOTCERT",
  application_name: "PGAPPNAME",
  connect_timeout: "PGCONNECT_TIMEOUT",
  options: "PGOPTIONS",
  passfile: "PGPASSFILE",
  service: "PGSERVICE",
};

function pgEnvironment(urlText) {
  const url = new URL(urlText);
  if (!(["postgres:", "postgresql:"].includes(url.protocol))) {
    throw new Error("DATABASE_URL must use PostgreSQL.");
  }

  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  const host = url.searchParams.get("host") ?? url.hostname.replace(/^\[|\]$/g, "");
  const port = url.searchParams.get("port") ?? url.port;
  const user = url.searchParams.has("user") ? url.searchParams.get("user") : decodeURIComponent(url.username);
  const password = url.searchParams.has("password") ? url.searchParams.get("password") : decodeURIComponent(url.password);
  const database = url.searchParams.has("dbname") ? url.searchParams.get("dbname") : decodeURIComponent(url.pathname.slice(1));
  if (host) environment.PGHOST = host;
  if (port) environment.PGPORT = port;
  if (user) environment.PGUSER = user;
  if (password) environment.PGPASSWORD = password;
  if (database) environment.PGDATABASE = database;

  for (const [parameter, variable] of Object.entries(pgParameters)) {
    if (["host", "port", "user", "password", "dbname"].includes(parameter)) continue;
    const value = url.searchParams.get(parameter);
    if (value) {
      environment[variable] = value;
    }
  }
  if (environment.PGSSLMODE === "") delete environment.PGSSLMODE;
  return environment;
}

function safePgDumpMessage() {
  const url = new URL(connectionString);
  const sensitiveValues = [
    connectionString,
    url.username,
    decodeURIComponent(url.username),
    url.password,
    decodeURIComponent(url.password),
    url.searchParams.get("user"),
    url.searchParams.get("password"),
    process.env.PGUSER,
    process.env.PGPASSWORD,
  ].filter((value) => value && value.length > 0).sort((left, right) => right.length - left.length);
  let message = Buffer.concat(dumpMessages).toString("utf8").replace(/\0/g, "");
  for (const value of sensitiveValues) {
    message = message.split(value).join("[redacted]");
  }
  return message.replace(/\s+/g, " ").trim().slice(-400);
}

const environment = pgEnvironment(connectionString);
const output = createWriteStream(outputPath, { flags: "wx" });
let outputCreated = false;
let succeeded = false;
output.once("open", () => {
  outputCreated = true;
});

const dumpCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pg_dump";
const dumpArguments = process.platform === "win32"
  ? ["/d", "/c", "pg_dump --format=custom --no-owner --no-privileges"]
  : ["--format=custom", "--no-owner", "--no-privileges"];
const dump = spawn(
  dumpCommand,
  dumpArguments,
  {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  },
);
const dumpMessages = [];
dump.stderr.on("data", (chunk) => dumpMessages.push(chunk));
const dumpClosed = new Promise((resolveClose, rejectClose) => {
  dump.once("error", rejectClose);
  dump.once("close", (code, signal) => resolveClose({ code, signal }));
});

try {
  const [status] = await Promise.all([dumpClosed, pipeline(dump.stdout, output)]);
  if (status.code !== 0) {
    const message = safePgDumpMessage().toLowerCase();
    let reason = "pg_dump reported an error";
    if (message.includes("not recognized") || message.includes("command not found")) {
      reason = "pg_dump executable was not found";
    } else if (message.includes("authentication failed") || message.includes("no password supplied")) {
      reason = "PostgreSQL authentication failed";
    } else if (message.includes("could not translate host name")) {
      reason = "PostgreSQL host could not be resolved";
    } else if (message.includes("connection to server") || message.includes("could not connect to server")) {
      reason = "could not connect to PostgreSQL";
    } else if (message.includes("permission denied")) {
      reason = "PostgreSQL denied backup access";
    }
    const details = safePgDumpMessage();
    throw new Error(`${reason} (exit code ${status.code ?? status.signal})${details ? `: ${details}` : "."}`);
  }
  succeeded = true;
  process.stdout.write(`PostgreSQL backup written to ${outputPath}\n`);
} finally {
  if (!succeeded) {
    dump.kill();
    if (!output.closed) await once(output, "close").catch(() => {});
    if (outputCreated) await rm(outputPath, { force: true });
  }
}
