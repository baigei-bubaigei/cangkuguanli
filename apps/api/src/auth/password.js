import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const workFactor = 16_384;
const blockSize = 8;
const parallelism = 1;
const keyLength = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, keyLength, {
    N: workFactor,
    r: blockSize,
    p: parallelism,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${workFactor}$${blockSize}$${parallelism}$${salt.toString("base64url")}$${Buffer.from(key).toString("base64url")}`;
}

export async function verifyPassword(password, encodedHash) {
  const [algorithm, n, r, p, saltValue, keyValue] = encodedHash.split("$");
  if (
    algorithm !== "scrypt" ||
    Number(n) !== workFactor ||
    Number(r) !== blockSize ||
    Number(p) !== parallelism ||
    !saltValue ||
    !keyValue
  ) {
    return false;
  }

  const salt = Buffer.from(saltValue, "base64url");
  const expected = Buffer.from(keyValue, "base64url");
  if (salt.length !== 16 || expected.length !== keyLength) return false;

  const actual = await scryptAsync(password, salt, expected.length, {
    N: workFactor,
    r: blockSize,
    p: parallelism,
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(Buffer.from(actual), expected);
}
