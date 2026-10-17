import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

const [inputOption, requestedInputPath, ...extraArguments] = process.argv.slice(2);
if (inputOption !== "--input" || !requestedInputPath || extraArguments.length > 0) {
  throw new Error("Usage: npm run db:restore -- --input <path>");
}

const inputPath = resolve(requestedInputPath);
const url = new URL(databaseUrl);
if (!["postgres:", "postgresql:"].includes(url.protocol)) {
  throw new Error("DATABASE_URL must use PostgreSQL.");
}

const environment = { ...process.env };
delete environment.DATABASE_URL;
for (const variable of [
  "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSSLMODE", "PGSSLCERT", "PGSSLKEY",
  "PGSSLROOTCERT", "PGAPPNAME", "PGCONNECT_TIMEOUT", "PGOPTIONS", "PGPASSFILE", "PGSERVICE",
]) {
  delete environment[variable];
}

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
  if (value) environment[variable] = value;
}

const restoreCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "pg_restore";
const restoreArguments = process.platform === "win32"
  ? ["/d", "/c", `pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --dbname=${environment.PGDATABASE}`]
  : ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", "--dbname", environment.PGDATABASE];
const restore = spawn(restoreCommand, restoreArguments, {
  env: environment,
  stdio: ["pipe", "ignore", "pipe"],
  windowsHide: true,
});
const restoreMessages = [];
restore.stderr.on("data", (chunk) => restoreMessages.push(chunk));
const restoreClosed = new Promise((resolveClose, rejectClose) => {
  restore.once("error", rejectClose);
  restore.once("close", (code, signal) => resolveClose({ code, signal }));
});
let succeeded = false;

try {
  const [closed, input] = await Promise.all([
    restoreClosed.then((status) => ({ status }), (error) => ({ error })),
    pipeline(createReadStream(inputPath), restore.stdin).then(() => ({}), (error) => ({ error })),
  ]);
  if (closed.error) throw closed.error;
  const { status } = closed;
  if (status.code !== 0) {
    let details = Buffer.concat(restoreMessages).toString("utf8").replace(/\0/g, "");
    for (const value of [databaseUrl, url.password, decodeURIComponent(url.password), environment.PGPASSWORD]
      .filter((item) => item && item.length > 0)
      .sort((left, right) => right.length - left.length)) {
      details = details.split(value).join("[redacted]");
    }
    details = details.replace(/\s+/g, " ").trim().slice(-400);
    throw new Error(`PostgreSQL restore failed (exit code ${status.code ?? status.signal})${details ? `: ${details}` : "."}`);
  }
  if (input.error) throw input.error;
  succeeded = true;
  process.stdout.write(`PostgreSQL database restored from ${inputPath}\n`);
} finally {
  if (!succeeded) {
    restore.kill();
    await restoreClosed.catch(() => {});
  }
}
