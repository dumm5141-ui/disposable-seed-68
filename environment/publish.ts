import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Configure ${name}.`);
  return value;
}
const base = new URL(required("CACHE_PUBLIC_URL").replace(/\/?$/, "/"));
const upload = new URL(required("CACHE_UPLOAD_URL").replace(/\/?$/, "/"));
const platform = new URL(required("PLATFORM_URL")).origin;
for (const url of [base, upload, new URL(platform)]) {
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error(
      "Use HTTPS storage/platform URLs without embedded credentials or query strings.",
    );
}
const revision = required("GITHUB_SHA");
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid Git revision.");
const resources = required("PLATFORM_RESOURCE_IDS")
  .split(",")
  .map((value) => value.trim());
if (
  !resources.length ||
  resources.length > 100 ||
  resources.some((id) => !/^[a-f0-9]{32}$/.test(id))
)
  throw new Error("Configure comma-separated platform resource IDs.");
async function bind(artifact?: { version: number; digest: string; manifestUrl: string }) {
  // Request a fresh short-lived GitHub token after a potentially long build/upload.
  const identityUrl = new URL(required("ACTIONS_ID_TOKEN_REQUEST_URL"));
  identityUrl.searchParams.set("audience", platform);
  const identityResponse = await fetch(identityUrl, {
    headers: { Authorization: `Bearer ${required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}` },
    redirect: "error",
  });
  if (!identityResponse.ok) throw new Error("Unable to obtain GitHub workflow identity.");
  const { value } = (await identityResponse.json()) as { value: string };
  for (const resourceId of resources) {
    const response = await fetch(`${platform}/api/environment-artifacts/ci`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${value}`, "Content-Type": "application/json" },
      body: JSON.stringify({ resourceId, revision, ...(artifact ? { artifact } : {}) }),
    });
    if (!response.ok)
      throw new Error(
        `Platform ${artifact ? "binding" : "validation"} failed (${response.status}). Sync/connect the resource and retry this revision.`,
      );
  }
}
await bind(); // Run the platform's canonical JSON/folder validator before building.
const scratch = await mkdtemp(join(tmpdir(), "creator-cache-"));
try {
  const keyPath = join(scratch, "signing-key");
  const secret = required("NIX_SIGNING_KEY").trim();
  const publicKey = required("NIX_PUBLIC_KEY").trim();
  const [keyName, keyBytes] = secret.split(":");
  const raw = Buffer.from(keyBytes ?? "", "base64");
  if (raw.length !== 64 || `${keyName}:${raw.subarray(32).toString("base64")}` !== publicKey)
    throw new Error("Nix signing key and public key do not match.");
  await writeFile(keyPath, secret, { mode: 0o600 });
  const nix = (args: string[]) =>
    execFileSync("nix", ["--extra-experimental-features", "nix-command flakes", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  const storePath = nix([
    "build",
    "path:./environment",
    "--no-update-lock-file",
    "--no-link",
    "--print-out-paths",
  ]);
  if (!/^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]+$/.test(storePath))
    throw new Error("Expected one native environment store path.");
  nix(["store", "sign", "--recursive", "--key-file", keyPath, storePath]);
  const cache = join(scratch, "cache");
  nix(["copy", "--to", `file://${cache}`, storePath]);
  const uploadToken = required("CACHE_UPLOAD_TOKEN");
  async function publish(path: string, bytes: Uint8Array) {
    const response = await fetch(new URL(path, upload), {
      method: "PUT",
      redirect: "error",
      signal: AbortSignal.timeout(120000),
      headers: {
        Authorization: `Bearer ${uploadToken}`,
        "If-None-Match": "*",
        "Content-Type": "application/octet-stream",
      },
      body: Buffer.from(bytes),
    });
    if (!response.ok && response.status !== 412)
      throw new Error(`Artifact upload failed (${response.status}).`);
    const published = await fetch(new URL(path, base), {
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    });
    if (!published.ok) throw new Error("Published artifact is not readable at its public URL.");
    const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    if (hash(new Uint8Array(await published.arrayBuffer())) !== hash(bytes))
      throw new Error("Storage overwrote or served mismatching immutable bytes.");
  }
  async function walk(prefix = "") {
    for (const entry of await readdir(join(cache, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) await publish(path, await readFile(join(cache, path)));
    }
  }
  await walk();
  const manifest = {
    version: 1,
    architecture: "x86_64",
    runtime: "trynix-qemu-wasm",
    storePaths: [storePath],
    caches: [{ url: base.href.replace(/\/$/, ""), key: publicKey }],
    environment: { PATH: `${storePath}/bin:/usr/bin:/bin` },
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const path = `manifests/${digest}.json`;
  await publish(path, bytes);
  await bind({ version: 1, digest: `sha256:${digest}`, manifestUrl: new URL(path, base).href });
  console.log("Canonical content validated; native closure published; exact revision bound.");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
